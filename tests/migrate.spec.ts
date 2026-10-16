/**
 * The migration runner.
 *
 * Split in two: the file-ordering rules run anywhere, and the behaviour that
 * only means anything against a real server runs when one is configured. CI
 * provides one, so the second half is not optional there — see
 * `.github/workflows/ci.yml`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { quoteIdentifier, getDatabase, closeAllDatabases, type DatabaseHandle } from "../src/db.js";
import { appliedMigrations, checksumOf, loadMigrations, migrate } from "../src/migrate.js";

async function migrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "inventory-migrations-"));
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(dir, name), sql, "utf8");
  }
  return dir;
}

describe("quoteIdentifier", () => {
  it("quotes a name that passed config validation", () => {
    expect(quoteIdentifier("inventory")).toBe('"inventory"');
  });

  it("refuses anything else, as the last line before SQL", () => {
    // `parseDatabaseSchema` should already have rejected these. This is the
    // second half of the same rule, next to the only interpolation.
    for (const bad of ['inv"entory', "inventory; drop schema public", "Inventory", ""]) {
      expect(() => quoteIdentifier(bad), bad).toThrow(/unsafe identifier/);
    }
  });
});

describe("loadMigrations", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns nothing for an empty directory", async () => {
    dir = await migrationsDir({});
    expect(await loadMigrations(dir)).toEqual([]);
  });

  it("orders by filename, not by directory order", async () => {
    dir = await migrationsDir({
      "0010_tenth.sql": "SELECT 10",
      "0002_second.sql": "SELECT 2",
      "0001_first.sql": "SELECT 1",
    });
    expect((await loadMigrations(dir)).map((entry) => entry.key)).toEqual([
      "0001_first",
      "0002_second",
      "0010_tenth",
    ]);
  });

  it("ignores files that are not SQL", async () => {
    dir = await migrationsDir({ "0001_a.sql": "SELECT 1", "README.md": "# notes" });
    expect((await loadMigrations(dir)).map((entry) => entry.key)).toEqual(["0001_a"]);
  });

  it("refuses two migrations with the same prefix", async () => {
    // Their relative order would depend on the filesystem's collation, and a
    // migration order that differs between machines is not an order.
    dir = await migrationsDir({ "0001_a.sql": "SELECT 1", "0001_b.sql": "SELECT 2" });
    await expect(loadMigrations(dir)).rejects.toThrow(/share the prefix/);
  });

  it("checksums contents, so an edit to an applied file is detectable", async () => {
    dir = await migrationsDir({ "0001_a.sql": "SELECT 1" });
    const [migration] = await loadMigrations(dir);
    expect(migration!.checksum).toBe(checksumOf("SELECT 1"));
  });
});

/**
 * Everything below needs a server. `INVENTORY_TEST_DATABASE_URL` points at a
 * throwaway database; CI starts one as a service container. Locally the suite
 * skips rather than failing, so `npm test` works on a laptop with no
 * PostgreSQL — but CI is where the result counts, and there it does not skip.
 */
const connectionString = process.env.INVENTORY_TEST_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;

integration("migrate (against a real PostgreSQL)", () => {
  let db: DatabaseHandle;
  let schema: string;
  let dir: string;

  beforeEach(async () => {
    // A fresh schema per test, so one test's tables cannot satisfy another's
    // assertions.
    schema = `inv_test_${Math.random().toString(36).slice(2, 10)}`;
    // The schema doubles as the pool key here; in the worker that key is the
    // company id.
    db = await getDatabase(schema, connectionString!, schema);
  });

  afterEach(async () => {
    await db.pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await closeAllDatabases();
  });

  it("creates the schema it was pointed at", async () => {
    dir = await migrationsDir({});
    await migrate(db, dir);
    const rows = await db.pool.query(
      "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
      [schema],
    );
    expect(rows.rowCount).toBe(1);
  });

  it("applies each file once, in order, and records it", async () => {
    dir = await migrationsDir({
      "0001_parts.sql": "CREATE TABLE parts (id text PRIMARY KEY)",
      "0002_ledger.sql":
        "CREATE TABLE ledger_entries (id bigserial PRIMARY KEY, part_id text NOT NULL REFERENCES parts(id))",
    });

    expect(await migrate(db, dir)).toEqual(["0001_parts", "0002_ledger"]);
    // The foreign key in 0002 only resolves if 0001 ran first, so this is
    // the ordering assertion as well as the applied-once one.
    expect((await appliedMigrations(db)).map((entry) => entry.key)).toEqual([
      "0001_parts",
      "0002_ledger",
    ]);

    // Second run has nothing to do.
    expect(await migrate(db, dir)).toEqual([]);
  });

  it("writes unqualified tables into the configured schema", async () => {
    // The migrations above name no schema. The runner's pinned search_path is
    // the only thing putting them in the right place.
    dir = await migrationsDir({ "0001_parts.sql": "CREATE TABLE parts (id text PRIMARY KEY)" });
    await migrate(db, dir);
    const rows = await db.pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'parts'",
      [schema],
    );
    expect(rows.rowCount).toBe(1);
  });

  it("leaves no trace of a migration that failed halfway", async () => {
    dir = await migrationsDir({
      "0001_broken.sql": "CREATE TABLE good (id int); CREATE TABLE bad (id nosuchtype)",
    });
    await expect(migrate(db, dir)).rejects.toThrow(/0001_broken failed/);

    // The whole file is one transaction with the row that records it, so
    // neither the first table nor a "0001 applied" row survives.
    const tables = await db.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
      [schema],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(["schema_migrations"]);
    expect(await appliedMigrations(db)).toEqual([]);
  });

  it("refuses an applied migration whose contents changed", async () => {
    dir = await migrationsDir({ "0001_parts.sql": "CREATE TABLE parts (id text PRIMARY KEY)" });
    await migrate(db, dir);

    await writeFile(
      path.join(dir, "0001_parts.sql"),
      "CREATE TABLE parts (id text PRIMARY KEY, extra text)",
      "utf8",
    );
    // Editing history silently is how two deployments end up with different
    // tables and the same migration log.
    await expect(migrate(db, dir)).rejects.toThrow(/already been applied/);
  });

  it("rolls a transaction back on failure", async () => {
    dir = await migrationsDir({ "0001_parts.sql": "CREATE TABLE parts (id text PRIMARY KEY)" });
    await migrate(db, dir);

    await expect(
      db.transaction(async (client) => {
        await client.query("INSERT INTO parts (id) VALUES ('a')");
        throw new Error("something went wrong after the insert");
      }),
    ).rejects.toThrow(/something went wrong/);

    // This is the capability the whole storage decision rests on: a
    // multi-statement write that either lands completely or not at all.
    expect(await db.query("SELECT id FROM parts")).toEqual([]);
  });

  it("commits a transaction that succeeds", async () => {
    dir = await migrationsDir({ "0001_parts.sql": "CREATE TABLE parts (id text PRIMARY KEY)" });
    await migrate(db, dir);

    await db.transaction(async (client) => {
      await client.query("INSERT INTO parts (id) VALUES ('a')");
      await client.query("INSERT INTO parts (id) VALUES ('b')");
    });

    expect(await db.query<{ id: string }>("SELECT id FROM parts ORDER BY id")).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
  });

  it("serialises two runners against the same schema", async () => {
    dir = await migrationsDir({ "0001_parts.sql": "CREATE TABLE parts (id text PRIMARY KEY)" });
    // Without the advisory lock both runners see an empty log and both try to
    // create the table; one of them fails with "relation already exists".
    const [first, second] = await Promise.all([migrate(db, dir), migrate(db, dir)]);
    expect([first, second].flat()).toEqual(["0001_parts"]);
  });
});
