/**
 * `sync_boms`: the config repository's `bom/` directory, at one commit, into
 * versioned BOM records.
 *
 * The rules that make this safe to run from a chat message:
 *
 *   - **All or nothing.** Every file is validated before anything is written,
 *     and one bad file refuses the whole run with a named reason per file. A
 *     partial import would leave some products expanding against a new version
 *     and others against an old one, with no record of which.
 *   - **Nothing is guessed.** Every part reference must already exist in
 *     `parts`, and every catalog key and option value must exist in
 *     BigCommerce. Both are the acceptance criterion for this phase, and both
 *     fail loudly: a BOM that resolves to nothing consumes nothing, and the
 *     ledger looks healthy while it happens.
 *   - **A version is content, not a file.** Reformatting a file imports
 *     nothing. Changing a quantity inserts a new version, and the sales that
 *     already expanded against the old one keep pointing at it.
 *   - **Drafts are held.** A file with unresolved lines is reported, never
 *     imported. That is what lets the documented kit lists live in `bom/`
 *     before anyone has confirmed which part each line is.
 */

import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { PoolClient } from "pg";
import { contentHash, parseBom, type BomFile } from "./bom.js";
import { readCatalog, parseCatalogSettings, type CatalogIndex } from "./catalog.js";
import { githubConfigRepo, parseConfigRepoSettings, type ConfigRepo } from "./config-repo.js";
import type { DatabaseHandle } from "./db.js";
import { InputError, OperatorFacingError } from "./errors.js";
import { parsePartRef } from "./parts.js";
import { openStore } from "./storage.js";

/** One or more BOM files the sync refused, with the reason for each. */
export class BomValidationError extends OperatorFacingError {
  constructor(public readonly problems: readonly string[]) {
    super(
      `Nothing was imported. ${problems.length} problem${problems.length === 1 ? "" : "s"} in the BOM files:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  }
}

/** The cursor name in `sync_state`, which 0007 created for exactly this. */
const SYNC_STATE_KEY = "boms";

export interface SyncedBom {
  catalogKey: string;
  version: number;
  lines: number;
  contentHash: string;
}

export interface HeldBom {
  catalogKey: string;
  pendingLines: number;
  /** A version that is still active even though the file is now a draft. */
  activeVersion: number | null;
}

export interface BomSyncReport extends Record<string, unknown> {
  dryRun: boolean;
  repo: string;
  commit: string;
  files: number;
  imported: SyncedBom[];
  unchanged: string[];
  held: HeldBom[];
  warnings: string[];
}

interface PartIndex {
  /** `vendor:part-number`, lowercased, → part id. */
  idOf(ref: string): string | undefined;
}

async function readParts(client: PoolClient): Promise<PartIndex> {
  const { rows } = await client.query("SELECT id, vendor, vendor_part_number FROM parts");
  const index = new Map<string, string>();
  for (const row of rows) {
    index.set(`${row.vendor}:${String(row.vendor_part_number).toLowerCase()}`, row.id as string);
  }
  return {
    idOf(ref) {
      // A reference the ledger's own parser refuses is a reference no part can
      // have, which is the same answer as "unknown part" and reported as one.
      let part;
      try {
        part = parsePartRef(ref);
      } catch {
        return undefined;
      }
      if (part.kind !== "vendor") return undefined;
      return index.get(`${part.vendor}:${part.vendorPartNumber.toLowerCase()}`);
    },
  };
}

/**
 * Everything checkable without the database: shape, and agreement with the
 * catalog.
 *
 * Draft files are checked for shape and for their catalog key, and no further.
 * A draft exists precisely because its parts and option values are not settled
 * yet, so validating them would refuse the file for being what it says it is —
 * but a key that names no product at all is a typo worth reporting, and a
 * warning is where it goes while the file is inert.
 */
export function validateAgainstCatalog(
  boms: readonly BomFile[],
  catalog: CatalogIndex,
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const keys = new Map<string, string>();

  for (const bom of boms) {
    const where = `bom/${bom.fileName}`;
    const duplicate = keys.get(bom.catalogKey);
    if (duplicate) {
      problems.push(`${where}: catalog key ${bom.catalogKey} is also declared by ${duplicate}`);
      continue;
    }
    keys.set(bom.catalogKey, where);

    const product = catalog.lookup(bom.catalogKey, bom.catalogKeyKind);
    if (!product) {
      const message = `${where}: BigCommerce has no ${bom.catalogKeyKind === "product_id" ? "product" : "variant SKU"} ${bom.catalogKey}, so sales of it would consume nothing`;
      if (bom.status === "draft") warnings.push(message);
      else problems.push(message);
      continue;
    }
    if (bom.status === "draft") continue;

    for (const scope of bom.optionScopes) {
      const values = product.options.get(scope.optionName);
      if (!values) {
        problems.push(
          `${where}: product ${product.productId} has no option named "${scope.optionName}". Its options are ${[...product.options.keys()].map((name) => `"${name}"`).join(", ") || "(none)"}.`,
        );
      } else if (!values.has(scope.optionValue)) {
        problems.push(
          `${where}: option "${scope.optionName}" on product ${product.productId} has no value "${scope.optionValue}". Its values are ${[...values].map((value) => `"${value}"`).join(", ") || "(none)"}.`,
        );
      }
    }
  }
  return { problems, warnings };
}

/**
 * Read, validate and import. One transaction, one advisory lock.
 *
 * The lock is held for the whole import rather than per BOM, because version
 * numbers are per catalog key and two concurrent syncs reading `max(version)`
 * at the same moment would both decide the answer was 3.
 */
export async function synchronizeBoms(
  db: DatabaseHandle,
  repo: ConfigRepo,
  catalog: CatalogIndex,
  run: ToolRunContext,
  options: { commit?: string; dryRun?: boolean } = {},
): Promise<BomSyncReport> {
  const commit = options.commit ?? (await repo.headCommit());
  const dryRun = options.dryRun === true;
  const sources = await repo.readBoms(commit);

  const problems: string[] = [];
  const boms: BomFile[] = [];
  const paths = new Map<string, string>();
  for (const source of sources) {
    const { bom, problems: fileProblems } = parseBom(source.fileName, source.text);
    for (const problem of fileProblems) problems.push(`${source.path}: ${problem}`);
    if (bom) {
      boms.push(bom);
      paths.set(bom.fileName, source.path);
    }
  }

  const catalogCheck = validateAgainstCatalog(boms, catalog);
  problems.push(...catalogCheck.problems);
  const warnings = [...catalogCheck.warnings];

  if (problems.length > 0) throw new BomValidationError(problems);

  const active = boms.filter((bom) => bom.status === "active");
  const drafts = boms.filter((bom) => bom.status === "draft");

  const result = await db.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      JSON.stringify(["inventory-boms", db.schema]),
    ]);

    const existing = await client.query<{ catalog_key: string; version: number }>(
      "SELECT DISTINCT ON (catalog_key) catalog_key, version FROM boms ORDER BY catalog_key, version DESC",
    );
    const present = new Set(boms.map((bom) => bom.catalogKey));
    for (const current of existing.rows) {
      if (!present.has(current.catalog_key)) {
        warnings.push(`No BOM file for ${current.catalog_key} exists at ${commit}, but version ${current.version} is still active and still expands on every sale. Deleting a file does not retire an immutable version.`);
      }
    }

    const parts = await readParts(client);
    const partProblems: string[] = [];
    const resolved = new Map<string, Map<string, string>>();
    for (const bom of active) {
      const byRef = new Map<string, string>();
      for (const line of bom.lines) {
        // `validateBom` has already refused an active BOM with a pending line,
        // so every line here carries a part.
        const ref = line.part!;
        const partId = parts.idOf(ref);
        if (!partId) {
          partProblems.push(
            `bom/${bom.fileName}: this inventory has no part ${ref}. Receive it or record an adjustment for it first; a BOM may not invent a part.`,
          );
          continue;
        }
        byRef.set(ref, partId);
      }
      resolved.set(bom.catalogKey, byRef);
    }
    if (partProblems.length > 0) throw new BomValidationError(partProblems);

    const imported: SyncedBom[] = [];
    const unchanged: string[] = [];
    const held: HeldBom[] = [];

    const activeVersionOf = async (catalogKey: string) =>
      (
        await client.query(
          "SELECT id, version, content_hash FROM boms WHERE catalog_key = $1 ORDER BY version DESC LIMIT 1",
          [catalogKey],
        )
      ).rows[0] as { id: string; version: number; content_hash: string } | undefined;

    for (const bom of active) {
      const hash = contentHash(bom);
      const current = await activeVersionOf(bom.catalogKey);
      if (current && current.content_hash === hash) {
        unchanged.push(bom.catalogKey);
        continue;
      }
      const version = (current?.version ?? 0) + 1;
      if (dryRun) {
        imported.push({ catalogKey: bom.catalogKey, version, lines: bom.lines.length, contentHash: hash });
        continue;
      }
      const inserted = await client.query(
        `INSERT INTO boms (catalog_key, catalog_key_kind, version, content_hash, source_commit,
                           source_path, source_revision, option_scopes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
        [
          bom.catalogKey,
          bom.catalogKeyKind,
          version,
          hash,
          commit,
          paths.get(bom.fileName) ?? `bom/${bom.fileName}`,
          bom.sourceRevision ?? null,
          JSON.stringify(
            bom.optionScopes.map((scope) => ({ option: scope.optionName, value: scope.optionValue })),
          ),
        ],
      );
      const bomId = inserted.rows[0]!.id as string;
      const byRef = resolved.get(bom.catalogKey)!;
      for (const line of bom.lines) {
        await client.query(
          `INSERT INTO bom_lines (bom_id, option_name, option_value, part_id, quantity_per_unit,
                                  customer_description, source_line_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            bomId,
            line.optionName ?? null,
            line.optionValue ?? null,
            byRef.get(line.part!),
            line.qty,
            line.customerDescription,
            line.sourceLineId ?? null,
          ],
        );
      }
      imported.push({ catalogKey: bom.catalogKey, version, lines: bom.lines.length, contentHash: hash });
    }

    for (const bom of drafts) {
      const current = await activeVersionOf(bom.catalogKey);
      held.push({
        catalogKey: bom.catalogKey,
        pendingLines: bom.lines.filter((line) => line.pending.length > 0).length,
        activeVersion: current?.version ?? null,
      });
      if (current) {
        // Demoting a file to draft cannot retract a version: a sale that
        // expanded against it still has to resolve. Saying so is the only way
        // an operator learns the product is still consuming parts.
        warnings.push(
          `bom/${bom.fileName} is a draft, but version ${current.version} of ${bom.catalogKey} is already active and still expands on every sale. Versions are immutable; sync a corrected active BOM to supersede it.`,
        );
      }
    }

    if (!dryRun) {
      await client.query(
        `INSERT INTO sync_state (key, cursor, details, updated_at)
         VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET cursor = EXCLUDED.cursor, details = EXCLUDED.details, updated_at = now()`,
        [
          SYNC_STATE_KEY,
          commit,
          JSON.stringify({
            repo: repo.repo,
            files: sources.length,
            imported: imported.length,
            unchanged: unchanged.length,
            held: held.length,
            syncedBy: run.agentId,
            runId: run.runId,
          }),
        ],
      );
    }

    return { imported, unchanged, held };
  });

  return {
    dryRun,
    repo: repo.repo,
    commit,
    files: sources.length,
    ...result,
    warnings,
  };
}

/** The last commit a successful sync read, for diagnostics and phase 6. */
export async function lastSyncedCommit(db: DatabaseHandle): Promise<string | null> {
  const rows = await db.query<{ cursor: string | null }>(
    "SELECT cursor FROM sync_state WHERE key = $1",
    [SYNC_STATE_KEY],
  );
  return rows[0]?.cursor ?? null;
}

export async function syncBoms(
  ctx: PluginContext,
  rawParams: unknown,
  run: ToolRunContext,
): Promise<ToolResult> {
  if (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    throw new InputError("sync_boms parameters must be an object.");
  }
  const params = rawParams as Record<string, unknown>;
  if (params.dryRun !== undefined && typeof params.dryRun !== "boolean") {
    throw new InputError("dryRun must be a boolean.");
  }
  if (params.commit !== undefined && typeof params.commit !== "string") {
    throw new InputError("commit must be a string.");
  }

  const config = await ctx.config.get(run.companyId);
  const repoSettings = parseConfigRepoSettings(config);
  const catalogSettings = parseCatalogSettings(config);
  const db = await openStore(ctx, run.companyId);
  const [repo, catalog] = await Promise.all([
    githubConfigRepo(ctx, run.companyId, repoSettings),
    readCatalog(ctx, run.companyId, catalogSettings),
  ]);

  const data = await synchronizeBoms(db, repo, catalog, run, {
    ...(typeof params.commit === "string" ? { commit: params.commit } : {}),
    dryRun: params.dryRun === true,
  });

  const heldNote = data.held.length
    ? ` ${data.held.length} draft${data.held.length === 1 ? "" : "s"} held (${data.held.map((bom) => `${bom.catalogKey}: ${bom.pendingLines} unresolved`).join("; ")}).`
    : "";
  return {
    content: `${data.dryRun ? "Previewed" : "Synced"} ${data.files} BOM file${data.files === 1 ? "" : "s"} at ${data.commit.slice(0, 10)}: ${data.imported.length} new version${data.imported.length === 1 ? "" : "s"}, ${data.unchanged.length} unchanged.${heldNote}${data.warnings.length ? `\nWarnings:\n${data.warnings.map((warning) => `  - ${warning}`).join("\n")}` : ""}`,
    data,
  };
}
