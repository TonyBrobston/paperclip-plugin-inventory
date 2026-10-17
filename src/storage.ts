/**
 * Getting from "a tool was called" to "a migrated database to call it
 * against".
 *
 * The host runs no migrations for this plugin — that service only covers
 * plugins using `ctx.db`, and `docs/sdk-notes.md` (c) records why this one
 * cannot. So the schema is brought up to date lazily, on the first tool call
 * that needs it, rather than by anyone remembering to run something.
 *
 * It is also where `pg`'s errors stop. A connection failure's text can carry
 * the host, the port, the database name and sometimes the user, and a tool
 * result goes to an agent; what comes out of here instead is a sentence an
 * operator can act on.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolveConnection } from "./config.js";
import { SETTINGS_PATH } from "./constants.js";
import { getDatabase, type DatabaseHandle } from "./db.js";
import { InputError, StorageError } from "./errors.js";
import { migrate } from "./migrate.js";

/**
 * Where the `.sql` files are at runtime.
 *
 * Resolved from this module's own URL rather than from `process.cwd()`,
 * because the host forks the worker with a working directory of its own
 * choosing. `src/` and `dist/` both sit one level under the package root, so
 * the same expression finds `migrations/` whether the tests import the source
 * or the host runs the bundle — and `migrations` is in package.json's `files`,
 * so it is there in an install too.
 */
export function migrationsDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
}

/**
 * Migrations already run for a given pool, keyed by the pool itself.
 *
 * Keyed by the handle rather than by company id so that a rotated secret —
 * which opens a new pool, possibly against a different database — is migrated
 * again rather than assumed current. A `WeakMap` because the entry should go
 * when the pool does.
 */
const migrated = new WeakMap<DatabaseHandle, Promise<void>>();

/**
 * Fail distinctly when the `.sql` files are not in the install.
 *
 * Without this, a package published without `migrations/` — or a bundler
 * rewriting `import.meta.url` so the path resolves somewhere else — reports
 * the same "could not be brought up to date" as a wrong password, and an
 * operator spends the afternoon on the connection string. `scripts/smoke.mjs`
 * leans on the two messages being different.
 */
async function loadMigrationFiles(dir: string): Promise<void> {
  try {
    const files = await readdir(dir);
    if (!files.some((name) => name.endsWith(".sql"))) {
      throw new Error("no .sql files");
    }
  } catch {
    throw new StorageError(
      `This installation of the inventory plugin is missing its migrations directory (expected at ${dir}). Reinstall the plugin.`,
    );
  }
}

async function ensureMigrated(db: DatabaseHandle): Promise<void> {
  const inFlight = migrated.get(db);
  if (inFlight) return inFlight;

  const run = migrate(db, migrationsDirectory()).then(() => undefined);
  migrated.set(db, run);
  try {
    await run;
  } catch (error) {
    // A failed run must not be remembered as done, or the first transient
    // failure would leave this worker refusing to migrate for its lifetime.
    migrated.delete(db);
    throw error;
  }
}

/**
 * Open this company's migrated database.
 *
 * Config errors pass through as themselves — an operator can fix those — and
 * everything else becomes a `StorageError` whose message says where to look
 * without quoting what `pg` said.
 */
export async function openStore(
  ctx: PluginContext,
  companyId: string,
): Promise<DatabaseHandle> {
  if (typeof companyId !== 'string' || !companyId.trim()) throw new InputError('Host-authorized company is required.');
  const { connectionString, settings } = await resolveConnection(ctx, companyId);

  let db: DatabaseHandle;
  try {
    db = await getDatabase(companyId, connectionString, settings.databaseSchema);
  } catch (error) {
    ctx.logger.error("Could not open the inventory database", {
      companyId,
      reason: (error as Error)?.message,
    });
    throw new StorageError(
      `The inventory database could not be opened. Check the connection secret in ${SETTINGS_PATH}.`,
    );
  }

  await loadMigrationFiles(migrationsDirectory());

  try {
    await ensureMigrated(db);
  } catch (error) {
    // Logged in full, reported in summary: the detail an operator needs is in
    // the plugin log, where it is not being handed to an agent.
    ctx.logger.error("Inventory migrations failed", {
      companyId,
      schema: settings.databaseSchema,
      reason: (error as Error)?.message,
    });
    throw new StorageError(
      `The inventory database could not be brought up to date. The plugin log has the failing migration; check that the connection in ${SETTINGS_PATH} can create tables in the "${settings.databaseSchema}" schema.`,
    );
  }

  await db.transaction(async client => {
    await client.query('INSERT INTO company_scope(singleton,company_id) VALUES(true,$1) ON CONFLICT DO NOTHING', [companyId]);
    const result = await client.query('SELECT company_id FROM company_scope WHERE singleton=true');
    if (result.rows[0]?.company_id !== companyId) throw new InputError('This inventory schema belongs to another company. Configure a dedicated schema.');
  });
  return db;
}
