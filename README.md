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

**Status: scaffolding.** The tool surface is declared and registered; the
handlers arrive over phases 2–6. Calling one today returns the phase it is
waiting on.

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
  edited next month never rewrites last month's history.

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

One build note worth keeping: `pg` is marked external in
`esbuild.config.mjs` rather than bundled. It is CommonJS, and inlining it
produces a worker that throws `Dynamic require of "events" is not supported`
during module load — before the host's first RPC, so the failure looks like a
dead plugin rather than a build problem. `npm run smoke` is the step that
catches it.

## License

MIT
