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

The ledger tables arrive in phase 2. This directory is empty until then, which
the runner handles: nothing to apply is not an error.
