/**
 * A real PostgreSQL schema, migrated, one per test.
 *
 * Shared by the ledger and handler suites. `INVENTORY_TEST_DATABASE_URL`
 * points at a throwaway database; CI starts one as a service container and
 * fails the build if any test skipped, so "it only passes locally" is not a
 * state this repository can be in.
 *
 * A fresh schema per test rather than a truncate between tests, because the
 * ledger's append-only triggers refuse TRUNCATE — correctly — and a test suite
 * that needed them disabled would be testing a different table than the one
 * that ships.
 */

import { describe } from "vitest";
import { closeAllDatabases, getDatabase, quoteIdentifier, type DatabaseHandle } from "../../src/db.js";
import { migrate } from "../../src/migrate.js";
import { migrationsDirectory } from "../../src/storage.js";

export const TEST_DATABASE_URL = process.env.INVENTORY_TEST_DATABASE_URL;

/** `describe` when a server is configured, `describe.skip` when not. */
export const integration = TEST_DATABASE_URL ? describe : describe.skip;

let counter = 0;

export interface TestSchema {
  db: DatabaseHandle;
  schema: string;
  /** The key `getDatabase` cached this pool under; the worker uses a company id. */
  poolKey: string;
}

/** Create and migrate a schema nothing else is using. */
export async function freshSchema(): Promise<TestSchema> {
  const schema = `inv_t${process.pid}_${Date.now().toString(36)}_${counter++}`;
  const db = await getDatabase(schema, TEST_DATABASE_URL!, schema);
  await migrate(db, migrationsDirectory());
  return { db, schema, poolKey: schema };
}

/**
 * Drop the schema, and close the pools that were opened against it.
 *
 * The pools have to go too. `getDatabase` caches one per key and holds its
 * connections idle for thirty seconds, and a schema per test means a key per
 * test — plus a second one in the handler suite, which opens its pool under a
 * company id rather than the schema name. Left to expire on their own, a
 * couple of hundred sockets pile up against a server whose default limit is
 * a hundred, and the suite dies with "sorry, too many clients already" in
 * whichever test happened to be running when the limit was reached, nowhere
 * near the thing that caused it.
 *
 * A schema per test is deliberate — the append-only triggers refuse TRUNCATE.
 * A *pool* per test is not.
 */
export async function dropSchema(target: TestSchema | undefined): Promise<void> {
  if (!target) return;
  try {
    await target.db.pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(target.schema)} CASCADE`);
  } finally {
    await closeAllDatabases();
  }
}

export async function closeAll(): Promise<void> {
  await closeAllDatabases();
}

/**
 * Insert a part directly, bypassing the ledger.
 *
 * Used where a test needs a part to exist without the receipt that would
 * normally create one — proving, for instance, that an entry written by hand
 * is still refused.
 */
export async function insertPart(
  target: TestSchema,
  vendor: string,
  vendorPartNumber: string,
): Promise<string> {
  const rows = await target.db.transaction(async (client) => {
    const result = await client.query(
      "INSERT INTO parts (vendor, vendor_part_number) VALUES ($1, $2) RETURNING id",
      [vendor, vendorPartNumber],
    );
    return result.rows;
  });
  return rows[0]!.id as string;
}

/** Run one statement inside the schema, returning rows. Fails loudly. */
export async function exec(
  target: TestSchema,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return target.db.transaction(async (client) => {
    const result = await client.query(sql, params);
    return result.rows as Record<string, unknown>[];
  });
}
