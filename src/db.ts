/**
 * Connection pooling and transactions for the plugin's own PostgreSQL schema.
 *
 * `docs/sdk-notes.md` records why this exists rather than `ctx.db`: the host's
 * namespace client allows exactly one statement per call, and the ledger in
 * `SPEC.md` writes an order, its lines and its ledger entries as one unit. A
 * half-written order in an append-only ledger cannot be rolled back after the
 * fact, because there is nothing to roll back to.
 */

import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { SCHEMA_NAME_PATTERN } from "./constants.js";

export interface DatabaseHandle {
  pool: Pool;
  schema: string;
  /**
   * Run `fn` inside a transaction with `search_path` pinned to the plugin's
   * schema.
   *
   * The pin is per-transaction (`SET LOCAL`), so it cannot leak onto the next
   * borrower of a pooled connection. Unqualified table names inside `fn`
   * therefore resolve to this plugin's tables and nothing else.
   */
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Run a single read with the same `search_path` guarantee. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

interface CachedPool {
  handle: DatabaseHandle;
  /**
   * Fingerprint of the credentials this pool was opened with.
   *
   * The connection string itself is never stored: the pool needs it to open
   * sockets and `pg` holds it, but nothing here keeps a second copy. The hash
   * is enough to notice a rotation in Paperclip and reopen.
   */
  fingerprint: string;
}

const pools = new Map<string, CachedPool>();

function fingerprintOf(connectionString: string, schema: string): string {
  return createHash("sha256").update(`${schema}\u0000${connectionString}`).digest("hex");
}

/**
 * Quote a schema name for interpolation.
 *
 * `parseDatabaseSchema` has already restricted the name to unquoted-safe
 * characters; this is the second half of the same rule, kept next to the only
 * place that interpolates.
 *
 * It imports the pattern rather than restating it. A copy would agree with
 * the original right up until someone widened one of them, and the symptom —
 * a settings form that saves green and a worker that throws on every query —
 * would appear nowhere near the change. Raised in phase 1 review and QA.
 */
export function quoteIdentifier(name: string): string {
  if (!new RegExp(SCHEMA_NAME_PATTERN).test(name)) {
    throw new Error(`Refusing to interpolate unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

function createHandle(connectionString: string, schema: string): DatabaseHandle {
  const pool = new Pool({
    connectionString,
    // A plugin worker is shared by every company, so one company's inventory
    // work must not be able to exhaust the database's connection slots.
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "paperclip-plugin-inventory",
  });

  // An idle client killed by the server (a NAS rebooting, a failover) emits
  // `error` on the pool. Without this listener Node treats it as unhandled and
  // takes the whole worker down, along with every other company's plugin.
  pool.on("error", () => {});

  const setSearchPath = `SET LOCAL search_path TO ${quoteIdentifier(schema)}`;

  return {
    pool,
    schema,
    async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(setSearchPath);
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        // A rollback can itself fail on a dead connection. The original error
        // is the one worth reporting, so the rollback's is swallowed here and
        // the connection is released as broken below.
        try {
          await client.query("ROLLBACK");
        } catch {
          /* the connection is already gone */
        }
        throw error;
      } finally {
        client.release();
      }
    },
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const client = await pool.connect();
      try {
        // Wrapped in a transaction only so `SET LOCAL` has a scope to be local
        // to. A read-only transaction is the cheapest way to get the pin
        // without risking it leaking to the next borrower.
        await client.query("BEGIN READ ONLY");
        await client.query(setSearchPath);
        const result = await client.query(sql, params);
        await client.query("COMMIT");
        return result.rows as T[];
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* the connection is already gone */
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Get this company's pool, opening one if needed.
 *
 * Keyed by company, and reopened when the credentials change, so rotating the
 * secret in Paperclip takes effect on the next call rather than at the next
 * worker restart.
 */
export async function getDatabase(
  companyId: string,
  connectionString: string,
  schema: string,
): Promise<DatabaseHandle> {
  const fingerprint = fingerprintOf(connectionString, schema);
  const cached = pools.get(companyId);
  if (cached) {
    if (cached.fingerprint === fingerprint) return cached.handle;
    pools.delete(companyId);
    await cached.handle.pool.end().catch(() => {});
  }
  const handle = createHandle(connectionString, schema);
  pools.set(companyId, { handle, fingerprint });
  return handle;
}

/** Close every pool. Called from the worker's shutdown hook. */
export async function closeAllDatabases(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((entry) => entry.handle.pool.end().catch(() => {})));
}
