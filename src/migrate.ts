/**
 * The migration runner.
 *
 * Because this plugin owns its database connection, it owns its migrations
 * too — the host only runs migrations for plugins that use `ctx.db`. The rules
 * are the boring ones, chosen so that two workers starting at the same moment
 * against one NAS cannot both apply `0002`:
 *
 *   - files are applied in filename order, once each
 *   - each file runs inside a transaction together with the row that records
 *     it, so a failure leaves no trace of a half-applied migration
 *   - an advisory lock serialises concurrent runners
 *   - an already-applied file whose contents changed is an error, not a
 *     silent no-op: it means someone edited history
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseHandle } from "./db.js";
import { quoteIdentifier } from "./db.js";

/**
 * Namespace for the PostgreSQL advisory lock.
 *
 * Any stable 32-bit constant works; this one is the first four bytes of
 * sha256("paperclip-plugin-inventory"), so it is unlikely to collide with
 * another application's locks on a shared instance.
 */
const ADVISORY_LOCK_KEY = BigInt(
  `0x${createHash("sha256").update("paperclip-plugin-inventory").digest("hex").slice(0, 8)}`,
).toString();

export interface Migration {
  /** Filename without the extension, e.g. `0001_ledger`. */
  key: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  key: string;
  checksum: string;
  appliedAt: Date;
}

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * Read the migration files from disk, in the order they must be applied.
 *
 * Filename order, so the numeric prefix is the contract. Two files with the
 * same prefix are rejected rather than ordered arbitrarily — on a case- or
 * locale-sensitive filesystem "arbitrarily" can differ between machines, and a
 * migration order that depends on the machine is not an order.
 */
export async function loadMigrations(dir: string): Promise<Migration[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const prefixes = new Set<string>();
  const migrations: Migration[] = [];
  for (const file of files) {
    const key = file.slice(0, -4);
    const prefix = key.split("_")[0] ?? key;
    if (prefixes.has(prefix)) {
      throw new Error(
        `Two migrations share the prefix "${prefix}". Renumber one of them; the prefix is what fixes the order.`,
      );
    }
    prefixes.add(prefix);
    const sql = await readFile(path.join(dir, file), "utf8");
    migrations.push({ key, sql, checksum: checksumOf(sql) });
  }
  return migrations;
}

/**
 * Apply every migration that has not run yet.
 *
 * Returns the keys actually applied, so a caller can log "nothing to do"
 * distinctly from "applied three".
 */
export async function migrate(
  db: DatabaseHandle,
  migrationsDir: string,
): Promise<string[]> {
  const migrations = await loadMigrations(migrationsDir);
  const schema = quoteIdentifier(db.schema);
  const client = await db.pool.connect();
  const applied: string[] = [];

  try {
    // Taken before anything else, including the bookkeeping DDL below. A
    // second worker starting at the same moment waits here instead of racing.
    // `CREATE SCHEMA IF NOT EXISTS` is not safe to run concurrently — two
    // sessions can both pass the existence check and one then fails on the
    // unique index behind `pg_namespace` — so the lock has to come first.
    await client.query("SELECT pg_advisory_lock($1::bigint)", [ADVISORY_LOCK_KEY]);

    // Creating the schema is the one statement that cannot assume the schema
    // exists, so it runs before the search_path is pinned to it.
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
        key text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ key: string; checksum: string }>(
      `SELECT key, checksum FROM ${schema}.schema_migrations`,
    );
    const seen = new Map(rows.map((row) => [row.key, row.checksum]));

    for (const migration of migrations) {
      const previous = seen.get(migration.key);
      if (previous !== undefined) {
        if (previous !== migration.checksum) {
          throw new Error(
            `Migration ${migration.key} has already been applied but its contents have changed. Applied migrations are history: add a new migration instead of editing this one.`,
          );
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL search_path TO ${schema}`);
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${schema}.schema_migrations (key, checksum) VALUES ($1, $2)`,
          [migration.key, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* the connection is already gone */
        }
        throw new Error(
          `Migration ${migration.key} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      applied.push(migration.key);
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [ADVISORY_LOCK_KEY]);
    } catch {
      /* releasing the session releases the lock anyway */
    }
    client.release();
  }

  return applied;
}

/** What has been applied, for diagnostics and tests. */
export async function appliedMigrations(db: DatabaseHandle): Promise<AppliedMigration[]> {
  const schema = quoteIdentifier(db.schema);
  const rows = await db.query<{ key: string; checksum: string; applied_at: Date }>(
    `SELECT key, checksum, applied_at FROM ${schema}.schema_migrations ORDER BY key`,
  );
  return rows.map((row) => ({
    key: row.key,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}
