# What the plugin SDK actually gives us

`SPEC.md` was written before anyone had read the SDK. This file records what
`@paperclipai/plugin-sdk` really supports, so the phases that follow build
against the runtime rather than against an assumption. Every claim below cites
a primary source: the published package, the host source that enforces the
rule, or an existing plugin that already runs under this host.

**Verified against** `@paperclipai/plugin-sdk@2026.1012.0` (the current npm
release) and the Paperclip host at `packages/plugins/sdk` and
`server/src/services`.

**Headline:** the architecture in `SPEC.md` stands. Nothing here requires it to
change. Two implementation choices were open and are decided below, in
[Decisions](#decisions).

---

## (a) How plugins expose tools to agents

A plugin declares tools in its manifest and registers a handler for each one in
`setup()`:

```ts
ctx.tools.register(
  "get_stock",
  { displayName, description, parametersSchema },
  async (params, runCtx) => ({ content: "...", data: { ... } }),
);
```

- The manifest must declare `agent.tools.register` in `capabilities` and list
  each tool under `tools` with a JSON Schema `parametersSchema`. The host
  validates the capability before it will accept a registration
  (`server/src/services/plugin-capability-validator.ts:133`).
- The host namespaces every tool as `<pluginId>:<toolName>`
  (`server/src/services/plugin-tool-registry.ts:245`, `buildName`). With our plugin id
  `tbro.inventory`, `get_stock` reaches an agent as `tbro.inventory:get_stock`,
  which the MCP gateway renders as `tbro_inventory_get_stock` — the same shape
  the BigCommerce plugin's tools already appear under.
- The handler receives a `ToolRunContext` of `{ agentId, runId, companyId,
  projectId }` (`plugin-sdk/dist/types.d.ts:266`). `companyId` is the only
  tenancy key a tool gets, and it is host-supplied rather than a parameter, so
  it is safe to key per-company config and data on.
- Whether a given agent sees a given tool is a host policy decision, not a
  plugin one: `resolveRuntimePluginToolNames`
  (`server/src/services/plugin-runtime-tools.ts`) runs every ready tool through
  the tool-access policy engine per agent and run. A tool can also come back as
  `require_approval`, in which case the agent's call raises a human approval
  card instead of executing. Phase 7's skill has to tolerate both.

### The tool-result shape is not optional

`ToolResult` is `{ content?, data?, error? }`, and the host forwards `data` as
MCP `structuredContent`. The client's schema requires an **object** there. An
array, a scalar, or an absent `data` makes the client discard the entire
result — `content` included — before the agent reads any of it.

This is not theoretical: it is the defect that made every BigCommerce tool call
fail with `structuredContent: expected record, received null`, and the fix was
an unconditional object backstop at the single point the host reads
(`paperclip-plugin-bigcommerce/src/worker.ts`, `structured()`). An error result
has to set `content` and `data` **alongside** `error` for the same reason.

This plugin's `src/worker.ts` carries the same backstop, and
`tests/worker.spec.ts` asserts it for every tool, including failures. Do not
remove it in a later phase.

## (b) How plugins get config and secrets

Two separate channels, and the split matters for a public repo.

**Config** is per-company and operator-entered. The manifest's
`instanceConfigSchema` is a JSON Schema; the host renders a settings form from
it and validates saves against it with Ajv. `ctx.config.get(companyId)` returns
the saved object.

**Secrets** are never stored in config. A config field declared as:

```ts
{ type: "object", format: "secret-ref", properties: { type: { const: "secret_ref" }, secretId: { type: "string" } }, required: ["type", "secretId"] }
```

renders a secret picker, and the picker writes a **binding object**, not a
string. `ctx.secrets.resolve(binding, { companyId, configPath })` exchanges it
for the value at call time, gated on the `secrets.read-ref` capability.

Three traps worth knowing before Phase 2 writes a settings form:

1. **Declare the field as `type: "object"`.** The host runs Ajv against
   `instanceConfigSchema` *before* it looks for secret bindings, so
   `type: "string"` rejects the only value the form can produce.
2. **Never cache a resolved secret.** One worker process serves every company,
   so a cached credential becomes the wrong credential the moment a second
   company configures the plugin, and a rotation in Paperclip would not take
   effect until a restart.
3. **`onValidateConfig` is not a save gate.** The host calls it from exactly
   one place — the settings page's Test Connection button. `POST
   /api/plugins/:id/config` validates against `instanceConfigSchema` and
   nothing else. Anything that must block a save has to be expressible in the
   schema itself.

Consequence for this repo: the connection string, the service-account key, and
the BigCommerce token are all secret refs. The Sheet ID and the enabled-vendor
list are ordinary config and live in the private config repo. Neither kind
belongs in this repository.

## (c) Whether a plugin can use its own Postgres schema

Yes — but there are two different answers, and only one of them satisfies
`SPEC.md`.

### Path 1 — the host-owned namespace (`ctx.db`)

A manifest can declare:

```ts
database: { namespaceSlug: "inventory", migrationsDir: "migrations", coreReadTables: ["issues"] }
```

The host then creates a schema **inside Paperclip's own database**, applies the
SQL files in `migrationsDir` before the worker starts, and records each one's
checksum. `plugin-llm-wiki` ships this way today. The constraints, all enforced
in `server/src/services/plugin-database.ts`:

| Constraint | Where |
|---|---|
| Schema is named `plugin_<slug>_<sha256(pluginId)[0:10]>`, not a name you choose | `derivePluginDatabaseNamespace`, line 31 |
| Runtime SQL is **exactly one statement per call** — no `BEGIN`/`COMMIT`, no transactions | `validatePluginRuntimeQuery` / `validatePluginRuntimeExecute`, lines 246 and 276 |
| `ctx.db.query` is `SELECT`/`WITH` only; `ctx.db.execute` is a single `INSERT`/`UPDATE`/`DELETE` that must *start* with that keyword, so data-modifying CTEs are refused | lines 259, 285 |
| No `CREATE FUNCTION`, `CREATE TRIGGER`, `CREATE EXTENSION`, `DO`, `GRANT` | `assertNoBannedSql`, line 170 |
| Migrations may not `DROP`, `TRUNCATE` or `DELETE` | `validatePluginMigrationStatement`, line 190 |
| Migrations must hard-code the derived schema name, hash and all | `plugin-llm-wiki/migrations/001_llm_wiki.sql` |

The blocker is the second row. `SPEC.md` requires an append-only ledger with
invariants that span tables: recording one order writes `orders`, its
`order_lines` and the matching `ledger_entries`, and either all of it lands or
none of it does. One statement per call cannot express that, and the usual
escape hatch — a data-modifying CTE — is refused by `execute` because the
statement has to begin with `INSERT`/`UPDATE`/`DELETE`. A partially written
order in an append-only ledger is unrecoverable by design: there is nothing to
roll back to.

### Path 2 — the plugin owns its connection

A plugin worker is an ordinary Node child process. The host `fork()`s it with a
deliberately minimal environment and no network sandbox
(`server/src/services/plugin-worker-manager.ts:2923`), and the SDK's own
documentation is explicit that "plugin workers and plugin UI should both be
treated as trusted code today" and that "manifest capabilities are not a
frontend sandbox". A plugin can therefore `import pg`, connect to any
PostgreSQL instance it is configured with, and own a schema named exactly
`inventory` — with transactions, check constraints, partial unique indexes and
real migrations.

This is also the only reading under which `SPEC.md` is self-consistent. It asks
for a schema literally named `inventory`, on "the existing Postgres instance on
the Synology NAS", with "DB credentials" stored in Paperclip secrets. Path 1
gives none of those three: the name is derived, the instance is Paperclip's
own, and it needs no credentials at all.

## (d) Plugin-to-plugin events and cross-plugin tool calls

**Events: yes.** `ctx.events.emit(name, companyId, payload)` requires the
`events.emit` capability; the host namespaces the result as
`plugin.<pluginId>.<name>`. Any plugin with `events.subscribe` can receive it
with `ctx.events.on("plugin.tbro.bigcommerce.order-shipped", handler)`, with an
optional server-side `{ companyId, projectId, agentId }` filter so the host
only delivers matching events. Core domain events (`issue.created`,
`agent.run.finished`, and so on) use the same subscription API.

**Direct tool calls: no.** There is no host method that lets one plugin invoke
another plugin's tool. The complete list of worker→host methods is
`server/src/services/plugin-capability-validator.ts:46-134`; it contains
`agent.tools.register` and `agent.tools.execute`, and the latter is the
host→worker direction — the host asking *this* worker to run *its own* tool.
Nothing addresses another plugin. The available substitutes are
`ctx.agents.invoke` (put an agent in the loop, which `SPEC.md` explicitly wants
to avoid for structured data) and the other plugin's manifest-declared
`apiRoutes` over HTTP.

### What this means for Phase 6, concretely

The mechanism exists, but **our BigCommerce plugin does not emit anything
today**. `paperclip-plugin-bigcommerce` declares exactly three capabilities —
`http.outbound`, `secrets.read-ref`, `agent.tools.register` — and it is
read-only, with no webhook endpoint and no scheduled job. There is no
order-placed or order-shipped signal for this plugin to subscribe to.

So Phase 6 takes the fallback branch `SPEC.md` already allows: implement
`reconcile_bigcommerce()`. Teaching the BigCommerce plugin to emit events would
mean adding `events.emit` plus a webhook receiver to a separate repository —
real work, worth doing eventually, and out of scope for this project unless
Tony asks for it.

---

## Decisions

Recorded here because `SPEC.md` left them open, and the phases that follow
depend on them. Both are minor implementation choices within the spec's
architecture, not changes to it.

### 1. Storage uses a plugin-owned `pg` connection, not `ctx.db`

**Decision.** Connect with `pg` to a PostgreSQL instance given by config, in a
schema given by config (default `inventory`), with migrations this repository
owns.

**Why.** The ledger's invariants need multi-statement transactions, and
`ctx.db` forbids them — see (c). The spec's own requirements (a schema named
`inventory`, on a nominated instance, reached with credentials from Paperclip
secrets) also only describe Path 2.

**What it costs.** We own the migration runner, the pool lifecycle and the
connection-failure surface, none of which the host does for us. `src/migrate.ts`
and `src/db.ts` are that cost, paid in this phase.

**What keeps it portable.** The connection string is a secret ref and the
schema name is config, so another Paperclip user points the same plugin at
their own database without touching code.

**Revisit if** the host relaxes `ctx.db` to allow transactions. The table
layout would port; the access layer would not.

### 2. Plugin id is `tbro.inventory`

Matching `tbro.bigcommerce`, already installed on this host. The prefix is the
author's namespace — the same role an npm scope plays — and not a
Brobston-specific setting, so it does not conflict with the spec's requirement
that deployment-specific values come from config. It also keeps a generic
`inventory` id free.

---

## Things that will bite a later phase

- **`data` must be a JSON object on every tool result, including errors.** See
  (a). `tests/worker.spec.ts` enforces it.
- **One worker serves every company.** Key all state and all pools on the
  `companyId` the host passes you. Never cache a resolved secret.
- **`onValidateConfig` runs only on Test Connection.** Put real constraints in
  `instanceConfigSchema` where a save will actually enforce them.
- **Tool availability is per-agent policy.** A tool can be withheld or gated
  behind an approval card. Phase 7's skill must handle a tool that is not
  there, and a call that returns "approval required" rather than a result.
- **A CommonJS dependency must be marked external, not bundled.** The SDK's
  esbuild preset bundles everything into an ESM worker, and esbuild rewrites a
  CommonJS `require` into a stub that throws `Dynamic require of "x" is not
  supported`. For `pg` that throw happens during module load, so the worker
  dies before answering the host's first RPC and the plugin simply looks dead.
  `esbuild.config.mjs` externalises `pg`; `npm run smoke` is what caught it,
  and the unit suite could not have, because it imports `src/`.
- **`ctx.assets` is not in the supported runtime** in this release. Do not build
  on it.
- **`dist/` is committed** so an install needs no build step, and CI fails if it
  is stale. Rebuild before committing.
