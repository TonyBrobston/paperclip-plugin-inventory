/**
 * `record_sale`: a product sold, expanded through its BOM into part
 * consumption.
 *
 * The version matters more than anything else here. A sale is expanded against
 * the BOM version active *at that moment*, the version id is written into the
 * entry's provenance, and BOM versions are immutable — so a quantity corrected
 * next year produces version 4 and changes nothing about what this sale
 * consumed. That is what `SPEC.md` means by "later BOM changes never rewrite
 * history", and it is only true because all three of those things are true
 * together.
 *
 * One transaction for the whole expansion: a sale consumes every line or none
 * of them. A half-consumed sale in an append-only ledger cannot be undone, only
 * annotated.
 *
 * No catalog call. A sale is recorded from what the order says, so an outage at
 * BigCommerce must not be able to stop the ledger from recording something that
 * physically shipped. The catalog check belongs where the BOM is accepted,
 * which is `sync_boms`.
 */

import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { PoolClient } from "pg";
import { selectLines, type BomFile, type OptionSelection } from "./bom.js";
import type { DatabaseHandle } from "./db.js";
import { InputError, LedgerError } from "./errors.js";
import { appendEntry } from "./ledger.js";
import { formatPartRef, parsePartRef } from "./parts.js";
import { parseQuantity } from "./quantity.js";
import { openStore } from "./storage.js";

const MAX_OPTIONS = 50;

export interface ActiveBom {
  bomId: string;
  version: number;
  catalogKey: string;
  sourceCommit: string | null;
  bom: BomFile;
}

/**
 * Read the active version of one BOM.
 *
 * "Active" is the highest version, because a version is only ever inserted and
 * `effective_from` is set when it lands. Reading it inside the sale's
 * transaction is what makes the expansion and the entries agree even if a sync
 * commits a new version in between.
 */
export async function readActiveBom(
  client: PoolClient,
  catalogKey: string,
): Promise<ActiveBom | undefined> {
  const { rows } = await client.query(
    `SELECT id, version, catalog_key, catalog_key_kind, content_hash, source_commit, option_scopes
       FROM boms WHERE catalog_key = $1 ORDER BY version DESC LIMIT 1`,
    [catalogKey],
  );
  const head = rows[0];
  if (!head) return undefined;

  const lines = await client.query(
    `SELECT l.option_name, l.option_value, l.quantity_per_unit, l.customer_description,
            l.source_line_id, p.vendor, p.vendor_part_number, l.part_id
       FROM bom_lines l JOIN parts p ON p.id = l.part_id
      WHERE l.bom_id = $1
      ORDER BY l.option_name NULLS FIRST, l.option_value NULLS FIRST, p.vendor, p.vendor_part_number`,
    [head.id],
  );

  return {
    bomId: head.id as string,
    version: Number(head.version),
    catalogKey: head.catalog_key as string,
    sourceCommit: (head.source_commit as string | null) ?? null,
    bom: {
      fileName: `${head.catalog_key}.yaml`,
      catalogKey: head.catalog_key as string,
      catalogKeyKind: head.catalog_key_kind as BomFile["catalogKeyKind"],
      status: "active",
      lines: lines.rows.map((row) => ({
        part: formatPartRef(row.vendor as string, row.vendor_part_number as string),
        qty: Number(row.quantity_per_unit),
        customerDescription: row.customer_description as string,
        ...(row.option_name ? { optionName: row.option_name as string } : {}),
        ...(row.option_value ? { optionValue: row.option_value as string } : {}),
        ...(row.source_line_id ? { sourceLineId: row.source_line_id as string } : {}),
        pending: [],
      })),
      optionScopes: (
        (head.option_scopes as { option?: string; value?: string }[] | null) ?? []
      )
        .filter((scope) => typeof scope.option === "string" && typeof scope.value === "string")
        .map((scope) => ({ optionName: scope.option as string, optionValue: scope.value as string })),
    },
  };
}

/**
 * How an order names the options the customer picked.
 *
 * `"Which switch?: Rocker"` and `{ option: "Which switch?", value: "Rocker" }`
 * are both accepted, because the first is what a human types into a chat
 * message and the second is what phase 6 will read off a BigCommerce order. A
 * bare option name is refused: a name without a value cannot say which of
 * three parts the customer has.
 */
export function parseSelections(raw: unknown): OptionSelection[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new InputError("options must be a list.");
  if (raw.length > MAX_OPTIONS) throw new InputError(`An order with more than ${MAX_OPTIONS} options is not a real order.`);
  return raw.map((entry, index) => {
    const at = `options[${index}]`;
    if (typeof entry === "string") {
      const separator = entry.indexOf(":");
      if (separator <= 0 || entry.slice(separator + 1).trim() === "") {
        throw new InputError(
          `${at} is "${entry}", which names an option but not the value the customer chose. Pass "option name: value", or { option, value }.`,
        );
      }
      return { option: entry.slice(0, separator).trim(), value: entry.slice(separator + 1).trim() };
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new InputError(`${at} must be "option name: value" or an object with option and value.`);
    }
    const { option, value } = entry as Record<string, unknown>;
    if (typeof option !== "string" || option.trim() === "" || typeof value !== "string" || value.trim() === "") {
      throw new InputError(`${at} must carry both an option name and the chosen value.`);
    }
    return { option: option.trim(), value: value.trim() };
  });
}

export interface SaleLine {
  partId: string;
  partRef: string;
  quantityPerUnit: number;
  quantityConsumed: number;
  optionName?: string;
  optionValue?: string;
  duplicate: boolean;
  onHand: number;
}

export interface SaleResult extends Record<string, unknown> {
  catalogKey: string;
  bomVersion: number;
  bomId: string;
  qty: number;
  reference: string;
  lines: SaleLine[];
  ignoredOptions: OptionSelection[];
  duplicate: boolean;
}

export async function expandSale(
  db: DatabaseHandle,
  input: {
    catalogKey: string;
    qty: number;
    reference: string;
    selections: readonly OptionSelection[];
    run: ToolRunContext;
  },
): Promise<SaleResult> {
  return db.transaction(async (client) => {
    const active = await readActiveBom(client, input.catalogKey);
    if (!active) {
      throw new InputError(
        `No BOM is active for ${input.catalogKey}. Add the BOM file to the config repository and run sync_boms; until then a sale of this product has nothing to consume, and recording it would understate what was used.`,
      );
    }

    const { lines, unmatched, ignored, missing, conflicting } = selectLines(active.bom, input.selections);
    if (missing.length > 0 || conflicting.length > 0) {
      throw new InputError(
        `BOM version ${active.version} of ${active.catalogKey} requires exactly one selection for each declared option. Missing: ${missing.join(", ") || "none"}; conflicting: ${conflicting.join(", ") || "none"}. Nothing was consumed.`,
      );
    }
    if (unmatched.length > 0) {
      throw new InputError(
        `BOM version ${active.version} of ${active.catalogKey} has no answer for ${unmatched.map((selection) => `"${selection.option}: ${selection.value}"`).join(", ")}. The storefront offers a value this BOM does not, which is an option renamed or added without updating the BOM. Nothing was consumed.`,
      );
    }
    if (lines.length === 0) {
      throw new LedgerError(
        `BOM version ${active.version} of ${active.catalogKey} expands to no lines for these options, so this sale would consume nothing.`,
      );
    }

    const consumed: SaleLine[] = [];
    let duplicates = 0;
    for (const line of lines) {
      // Every line of an active version carries a part and a quantity: a file
      // missing either is a draft, and a draft is never imported.
      const perUnit = line.qty!;
      const quantity = parseQuantity(Math.round(perUnit * input.qty * 10_000) / 10_000, {
        label: `Consumption of ${line.part}`,
        positive: true,
      });
      const result = await appendEntry(
        db,
        {
          part: parsePartRef(line.part!),
          entryType: "sale",
          quantity,
          reference: input.reference,
          // The reference is the BigCommerce order id and line, so repeating it
          // is the same sale. The part is added by `appendEntry` from the
          // resolved row, which is what makes a retry recognisable.
          idempotencyScope: ["sale"],
          note: line.customerDescription,
          provenance: {
            source: "record_sale",
            agentId: input.run.agentId,
            runId: input.run.runId,
            companyId: input.run.companyId,
            projectId: input.run.projectId,
            catalogKey: active.catalogKey,
            bomId: active.bomId,
            bomVersion: active.version,
            bomSourceCommit: active.sourceCommit,
            quantityPerUnit: perUnit,
            unitsSold: input.qty,
            reference: input.reference,
            ...(line.optionName ? { option: line.optionName, optionValue: line.optionValue } : {}),
            ...(line.sourceLineId ? { sourceLineId: line.sourceLineId } : {}),
          },
          createdBy: input.run.agentId,
        },
        client,
      );
      if (result.duplicate) {
        duplicates += 1;
        if (result.entry.quantityDelta !== -quantity) {
          throw new InputError(
            `Reference "${input.reference}" already consumed ${-result.entry.quantityDelta} of ${result.part.ref}, not ${quantity}. Nothing was changed. A sale that really did change quantity needs a new reference; a BOM that changed needs an adjustment.`,
          );
        }
      }
      consumed.push({
        partId: result.part.partId,
        partRef: result.part.ref,
        quantityPerUnit: perUnit,
        quantityConsumed: quantity,
        ...(line.optionName ? { optionName: line.optionName, optionValue: line.optionValue } : {}),
        duplicate: result.duplicate,
        onHand: result.stock.onHand,
      });
    }

    // All of them or none of them. A reference whose lines are partly recorded
    // was recorded against a different BOM version, and consuming the
    // difference now would mix two versions into one sale — which is exactly
    // the history the version numbers exist to keep straight.
    if (duplicates > 0 && duplicates < consumed.length) {
      throw new InputError(
        `Reference "${input.reference}" was already recorded against a different set of parts than BOM version ${active.version} expands to (${duplicates} of ${consumed.length} lines matched). Nothing was changed. Record an adjustment for the difference rather than re-recording the sale.`,
      );
    }

    return {
      catalogKey: active.catalogKey,
      bomVersion: active.version,
      bomId: active.bomId,
      qty: input.qty,
      reference: input.reference,
      lines: consumed,
      ignoredOptions: [...ignored],
      duplicate: duplicates > 0,
    };
  });
}

export async function recordSale(
  ctx: PluginContext,
  rawParams: unknown,
  run: ToolRunContext,
): Promise<ToolResult> {
  if (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    throw new InputError("record_sale parameters must be an object.");
  }
  const params = rawParams as Record<string, unknown>;
  const catalogKey = typeof params.productSku === "string" ? params.productSku.trim() : "";
  if (catalogKey === "" || catalogKey.length > 64) {
    throw new InputError(
      "A product is required: its BigCommerce variant SKU, or product-<id> for a product whose variants have no SKU.",
    );
  }
  const qty = parseQuantity(params.qty, { label: "The sold quantity", positive: true });
  const reference = typeof params.reference === "string" ? params.reference.trim() : "";
  if (reference === "") {
    throw new InputError(
      "A reference is required — the BigCommerce order id and line. It is what makes recording the same sale twice harmless.",
    );
  }
  const selections = parseSelections(params.options);

  const db = await openStore(ctx, run.companyId);
  const data = await expandSale(db, { catalogKey, qty, reference, selections, run });

  const summary = data.lines
    .map((line) => `${line.partRef}: ${line.quantityConsumed} consumed, ${line.onHand} on hand`)
    .join("\n");
  const ignored = data.ignoredOptions.length
    ? `\nOptions with no BOM lines behind them, so nothing was consumed for them: ${data.ignoredOptions.map((selection) => `"${selection.option}: ${selection.value}"`).join(", ")}.`
    : "";
  return {
    content: data.duplicate
      ? `Already recorded — reference "${data.reference}" consumed these parts before, so nothing changed.\n${summary}`
      : `Sale of ${data.qty} × ${data.catalogKey} consumed ${data.lines.length} part${data.lines.length === 1 ? "" : "s"} through BOM version ${data.bomVersion}.\n${summary}${ignored}`,
    data,
  };
}
