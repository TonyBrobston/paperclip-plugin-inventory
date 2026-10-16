/**
 * The phase 2 tools: `record_receipt`, `record_adjustment`, `get_stock`.
 *
 * Thin on purpose. Each one reads parameters, calls the ledger, and turns the
 * answer into a tool result; the rules live in `ledger.ts` and in the schema,
 * so a later phase adding a second caller cannot get a different answer than
 * the tool does.
 *
 * Every result carries the resulting stock position. An agent that has just
 * written to the ledger almost always wants to know where that left things,
 * and making it ask again is both a round trip and a chance to read a number
 * that has since changed.
 */

import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { InputError } from "./errors.js";
import {
  appendEntry,
  readStock,
  type AppendEntryResult,
  type Provenance,
  type StockRow,
} from "./ledger.js";
import { parsePartRef } from "./parts.js";
import { parseQuantity } from "./quantity.js";
import { openStore } from "./storage.js";

/** Longest free text we will store from a tool argument. */
const MAX_TEXT = 500;

/**
 * Control characters, refused in anything that reaches a text column.
 *
 * A NUL in particular is the one byte PostgreSQL `text` cannot hold at all,
 * and the error it produces names an encoding rather than the field, which
 * would reach an operator as "The inventory request failed."
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function params(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("Tool parameters must be an object.");
  }
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new InputError(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > MAX_TEXT) {
    throw new InputError(`${label} is longer than ${MAX_TEXT} characters.`);
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new InputError(`${label} contains control characters.`);
  }
  return trimmed;
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value, label);
  if (text === undefined) throw new InputError(`${label} is required.`);
  return text;
}

/**
 * What the ledger records about where an entry came from.
 *
 * The run context, not the parameters: an agent cannot claim to be a different
 * agent, so "who did this" survives being asked later. Nothing secret goes in
 * — it is read back by `list_review_queue` and by the sheet sync.
 */
function provenanceOf(
  tool: string,
  runCtx: ToolRunContext,
  extra: Record<string, unknown>,
): Provenance {
  return {
    ...extra,
    source: tool,
    agentId: runCtx.agentId,
    runId: runCtx.runId,
    companyId: runCtx.companyId,
    projectId: runCtx.projectId,
  };
}

function stockSummary(stock: StockRow): string {
  return `${stock.ref}: ${stock.onHand} on hand, ${stock.onOrder} on order, ${stock.committed} committed.`;
}

function entryResult(tool: string, result: AppendEntryResult, verb: string): ToolResult {
  const content = result.duplicate
    ? `Already recorded — this ${verb} was submitted before, so nothing changed. ${stockSummary(result.stock)}`
    : `${verb[0]!.toUpperCase()}${verb.slice(1)} recorded. ${stockSummary(result.stock)}`;
  return {
    content,
    data: {
      tool,
      recorded: !result.duplicate,
      duplicate: result.duplicate,
      entryId: result.entry.id,
      entryType: result.entry.entryType,
      quantityDelta: result.entry.quantityDelta,
      partId: result.part.partId,
      partRef: result.part.ref,
      stock: {
        onHand: result.stock.onHand,
        onOrder: result.stock.onOrder,
        committed: result.stock.committed,
        available: result.stock.available,
      },
    },
  };
}

/**
 * Record that ordered parts physically arrived.
 *
 * Idempotent on (part, reference, delivery): "reused references are treated as
 * the same receipt", as the tool's own description promises. A reused
 * reference with a *different* quantity is refused rather than merged — it is
 * either a typo or a second shipment against the same order, and both deserve
 * a human deciding which, not a silently discarded number.
 *
 * `delivery` is how the second shipment says so. One order arriving in two
 * boxes is two receipts against one reference, and keying the second on its
 * packing slip is what lets it both exist and still discharge what that order
 * left on order — see `outstandingOnOrder`. Telling the operator to invent a
 * second reference instead would clear nothing: on-order would sit at the
 * undelivered remainder of an order that is, in fact, complete.
 */
export async function recordReceipt(
  ctx: PluginContext,
  rawParams: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const input = params(rawParams);
  const part = parsePartRef(input.partId);
  const quantity = parseQuantity(input.quantity, { label: "Quantity", positive: true });
  const reference = requiredText(input.reference, "A reference");
  const delivery = optionalText(input.delivery, "The delivery");
  const note = optionalText(input.note, "The note");

  const db = await openStore(ctx, runCtx.companyId);

  const result = await appendEntry(db, {
    part,
    entryType: "receipt",
    quantity,
    reference,
    idempotencyScope: delivery ? ["receipt", delivery] : ["receipt"],
    note,
    createMissingPart: part.kind === "vendor",
    provenance: provenanceOf("record_receipt", runCtx, {
      reference,
      ...(delivery ? { delivery } : {}),
    }),
    createdBy: runCtx.agentId,
  });

  if (result.duplicate && result.entry.quantityDelta !== quantity) {
    const which = delivery
      ? `Delivery "${delivery}" against reference "${reference}"`
      : `Reference "${reference}"`;
    throw new InputError(
      `${which} was already used to receive ${result.entry.quantityDelta} of ${result.part.ref}, not ${quantity}. Nothing was changed. If this is a second shipment against the same order, pass its packing slip as "delivery"; record an adjustment if the first one was wrong.`,
    );
  }

  return entryResult("record_receipt", result, "receipt");
}

/**
 * Correct on-hand for a part.
 *
 * The only entry allowed to leave on-hand negative, because it is the only one
 * that represents somebody looking at a shelf rather than at a document: if
 * the count says the ledger is wrong, the ledger is wrong.
 *
 * Idempotent only when given a reference. Without one, two physical counts of
 * the same part on the same day are two real events, and collapsing them would
 * lose one.
 */
export async function recordAdjustment(
  ctx: PluginContext,
  rawParams: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const input = params(rawParams);
  const part = parsePartRef(input.partId);
  const quantityDelta = parseQuantity(input.quantityDelta, {
    label: "The adjustment",
    nonZero: true,
  });
  const reason = requiredText(input.reason, "A reason");
  const reference = optionalText(input.reference, "The reference");

  const db = await openStore(ctx, runCtx.companyId);

  const result = await appendEntry(db, {
    part,
    entryType: "adjustment",
    quantity: quantityDelta,
    // An adjustment with no external document still needs something
    // traceable in the column, and the reason is what there is.
    reference: reference ?? `adjustment: ${reason}`.slice(0, MAX_TEXT),
    idempotencyScope: reference ? ["adjustment"] : undefined,
    note: reason,
    createMissingPart: part.kind === "vendor",
    provenance: provenanceOf("record_adjustment", runCtx, {
      reason,
      ...(reference ? { reference } : {}),
    }),
    createdBy: runCtx.agentId,
  });

  if (result.duplicate && result.entry.quantityDelta !== quantityDelta) {
    throw new InputError(
      `Reference "${reference}" was already used to adjust ${result.part.ref} by ${result.entry.quantityDelta}, not ${quantityDelta}. Nothing was changed.`,
    );
  }

  const base = entryResult("record_adjustment", result, "adjustment");
  if (!result.duplicate && result.stock.onHand < 0) {
    // Allowed, and worth saying out loud: a negative count is almost always a
    // missing receipt rather than a real shortage.
    return {
      ...base,
      content: `${base.content} On hand is now negative, which an adjustment is allowed to do — check whether a receipt is missing.`,
    };
  }
  return base;
}

/** On hand, on order and committed — derived, never read from a stored total. */
export async function getStock(
  ctx: PluginContext,
  rawParams: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const input = params(rawParams);
  const part = input.partId === undefined || input.partId === null || input.partId === ""
    ? undefined
    : parsePartRef(input.partId);

  const db = await openStore(ctx, runCtx.companyId);
  const rows = await readStock(db, part);

  if (part && rows.length === 0) {
    // Not an error: "we have never heard of this part" is a true and useful
    // answer to "how many do we have", and an error would make an agent retry.
    const ref = part.kind === "id" ? part.id : part.ref;
    return {
      content: `No part matches ${ref}. Nothing has been received or adjusted for it.`,
      data: { parts: [], count: 0, matched: false },
    };
  }

  // `matched` answers "does the part you named exist", so it is only present
  // when a part was named. An unfiltered call returning `matched: true` with
  // nothing in it reads as if the flag were about the query, and leaves an
  // agent unable to tell an empty inventory from a part we have never heard
  // of — which are different answers.
  const matched = part ? { matched: true } : {};

  const content = part
    ? stockSummary(rows[0]!)
    : rows.length === 0
      ? "No parts yet. Nothing has been received or adjusted."
      : `${rows.length} part${rows.length === 1 ? "" : "s"}:\n${rows.map(stockSummary).join("\n")}`;

  return {
    content,
    data: {
      ...matched,
      count: rows.length,
      parts: rows.map((row) => ({
        partId: row.partId,
        partRef: row.ref,
        vendor: row.vendor,
        vendorPartNumber: row.vendorPartNumber,
        description: row.description,
        unitOfMeasure: row.unitOfMeasure,
        onHand: row.onHand,
        onOrder: row.onOrder,
        committed: row.committed,
        available: row.available,
        lastEntryAt: row.lastEntryAt ? row.lastEntryAt.toISOString() : null,
      })),
    },
  };
}
