# Migrations

SQL files applied in filename order by `src/migrate.ts`, once each, every file
inside its own transaction together with the row that records it.

- **Numeric prefix fixes the order.** `0002_reservations.sql` runs after
  `0001_ledger.sql`. Two files sharing a prefix is an error, not an arbitrary
  order.
- **An applied migration is history.** Editing one is caught by its recorded
  checksum and refused. Add a new file instead.
- **Write unqualified table names.** The runner pins `search_path` to the
  configured schema for the duration of each migration, so `CREATE TABLE
  parts (...)` lands in the right place whatever the deployment named it.

- **Keep them small and single-purpose.** One file per concern, so a failure
  names the thing that failed.

They are applied lazily, by the first tool call that needs the database —
`src/storage.ts`. The host runs migrations only for plugins that use
`ctx.db`, and this one owns its connection.

| File | What it adds |
|---|---|
| `0001_parts.sql` | `parts`, keyed by (vendor, vendor part number), matched case-insensitively |
| `0002_ledger.sql` | `ledger_entries`, its type/bucket constraint and the append-only triggers |
| `0003_orders.sql` | `orders` and `order_lines`, with the spec's (vendor, order number, line) and Gmail-message uniqueness |
| `0004_reservations.sql` | `reservations` — committed stock, which is a promise rather than a movement |
| `0005_review_queue.sql` | `review_queue`, one open item per message |
| `0006_boms.sql` | `boms` and `bom_lines`, versioned so history is never rewritten |
| `0007_sync_state.sql` | `sync_state`, one row per cursor |
| `0008_part_stock.sql` | the `part_stock` view: the single definition of on hand, on order and committed |

Phases 3 to 6 fill in the tables they own. They exist now because the
uniqueness rules in `SPEC.md` are properties of the schema, and retrofitting
one around existing rows is harder than getting it right once.
