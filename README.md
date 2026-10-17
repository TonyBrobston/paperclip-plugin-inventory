# paperclip-plugin-inventory

Small manufacturers lose track of parts. Purchases arrive as vendor order
emails nobody transcribes, sales consume parts through a bill of materials
nobody expands, and the spreadsheet that is supposed to hold it all together
drifts within a week. The result is a storefront selling a kit whose screws ran
out a month ago.

This plugin makes an append-only PostgreSQL ledger the source of truth for
parts, and gives agents the tools to keep it current: order emails in, sales
out, a Google Sheet as the human-facing view, and a review queue for anything
the plugin could not verify.

**Status:** ledger, verified email intake, review resolution, `sync_sheet`, `sync_boms` and `record_sale` are implemented. The BigCommerce bridge — `get_sellable` and `reconcile_bigcommerce` — arrives in phase 6. See [Sheet setup, column ownership and physical counts](docs/sheet-sync.md) and [BOMs: the file format, versioning, and what reaches the public docs](docs/boms.md) before configuring either sync.

## The ledger

Everything the business believes about stock is a sum over `ledger_entries`,
which is why the table's rules are in the schema rather than in TypeScript:

- **Append-only, enforced.** Triggers refuse `UPDATE`, `DELETE` and
  `TRUNCATE`. A mistake is corrected by recording an adjustment, so the
  mistake and the correction are both visible.
- **Three quantities, tracked separately.** Each entry says how much it moves
  *on order* and how much it moves *on hand*, and a `CHECK` constraint makes
  those agree with the entry's type — a "sale" cannot add stock. *Committed*
  is not a movement at all, so it lives in `reservations`. `part_stock` is the
  one view that defines all three.
- **Idempotent.** An entry may carry a key, unique in the database, so
  reprocessing an order email or re-running a sheet sync cannot double-count.
  Reusing a key with a *different* quantity is refused rather than merged.
  The key is built from the *resolved* part — never from the spelling the
  caller used — because `vendor-a:PART-001`, `vendor-a:part-001` and the
  part's internal id are one part, and a key that disagreed would let a retry
  append a second entry and double the count.
- **One order can arrive in two boxes.** A receipt is identified by its
  reference *and* its `delivery` — a packing slip, say — while the on-order
  quantity it discharges is still looked up by the reference alone. So a
  second shipment against PO-1 is a new event that draws down what PO-1 left
  outstanding. The alternative, telling the operator to invent a second
  reference, would leave a fully delivered order permanently on order.
- **Provenance is not optional.** Every entry records who wrote it, in which
  run, and from which tool, in a `NOT NULL` column with a constraint that an
  empty object does not satisfy. It comes from the host's run context, so an
  agent cannot claim to be someone else.
- **On hand never goes negative without an explicit adjustment.** Checked
  under a row lock on the part, so two writers cannot both decide that the
  last five units are theirs. Adjustments are the spec's named exception: if
  a physical count says the ledger is wrong, the ledger is wrong.

Migrations are applied lazily on the first tool call that needs them. The host
only migrates plugins that use `ctx.db`, and this one owns its connection —
see `docs/sdk-notes.md` (c).

## How it fits together

- **Connectors read email, not the plugin.** An agent uses the Gmail connector,
  extracts the line items, and calls `submit_order_email`. The judgment lives
  in the agent's skill; the rules live here.
- **Nothing reaches the ledger unverified.** A vendor parser reads the email
  independently of the agent, the two extractions must agree on part numbers
  and quantities, and line totals must reconcile against the printed subtotal.
  Anything that disagrees goes to `review_queue`.
- **On hand is derived, never stored.** It is the sum of the ledger. There is
  no editable quantity field to fall out of date.
- **Sales consume parts through the BOM version active at the time.** A BOM
  edited next month never rewrites last month's history: versions are
  immutable, and the version id is in each ledger entry's provenance.
- **A BOM is accepted only if it resolves.** Every part reference must already
  exist, and every catalog key and option value must exist in BigCommerce. A
  BOM that resolves to nothing consumes nothing, which is the one failure the
  ledger cannot show you.

`SPEC.md` is the full specification and the first thing committed here.
`docs/sdk-notes.md` records what the Paperclip SDK actually supports and the
two implementation decisions that came out of reading it.

## Configuration

Everything deployment-specific is config; nothing business-specific is in this
repository.

| Setting | Required | What it is |
|---|---|---|
| Database connection | yes | A Paperclip secret holding a PostgreSQL connection string. The plugin creates and owns one schema inside that database. |
| Schema name | no | Defaults to `inventory`. |
| Enabled vendors | no | Which order-email parsers to run. Defaults to all of them. |
| Private config repository, branch and GitHub token | for `sync_boms` | Where `bom/` lives. Only that directory is ever read. |
| BigCommerce store hash and API token | for `sync_boms` | Used to check a BOM's catalog key and option values exist before the BOM is accepted. |

Credentials are secret references resolved at call time, never stored in
plugin config and never written to logs. Business settings — BOM files, the
spreadsheet id, which vendors a particular shop buys from — belong in a
separate private configuration repository, not here.

## Development

```bash
npm ci
npm run typecheck
npm test          # the database tests skip without INVENTORY_TEST_DATABASE_URL
npm run build     # dist/ is committed, so rebuild before committing src/ changes
npm run smoke     # forks the built worker the way the host does
```

To run the full suite locally, point it at a throwaway database:

```bash
INVENTORY_TEST_DATABASE_URL=postgres://user:password@localhost:5432/scratch npm test
```

CI runs the same commands against a PostgreSQL service container and fails if
any test skipped.

One build note worth keeping: `pg` and `yaml` are marked external in
`esbuild.config.mjs` rather than bundled. Both are CommonJS, and inlining
either produces a worker that throws `Dynamic require of "events"`/`"process"
is not supported` during module load — before the host's first RPC, so the
failure looks like a dead plugin rather than a build problem. `npm run smoke`
is the step that catches it, and it caught both.

## License

MIT
