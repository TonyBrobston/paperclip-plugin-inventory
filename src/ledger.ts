/**
 * The ledger core.
 *
 * One way into the ledger — `appendEntry` — and one way out — `readStock`.
 * Every tool in every later phase goes through these, which is what makes the
 * invariants in `SPEC.md` properties of the system rather than of whichever
 * handler happened to be written most carefully:
 *
 *   - **Append-only.** Nothing here updates or deletes a ledger row, and
 *     `0002_ledger.sql` has triggers that refuse it even if something tried.
 *   - **Idempotent.** A caller that repeats an event gets the original entry
 *     back, not a second one. The guarantee is a unique index, so two callers
 *     racing cannot both win, and the key is built here from the *resolved*
 *     part, so a retry that spells the part number differently is still the
 *     same event.
 *   - **Atomic.** The part, the entry and the balance check are one
 *     transaction. There is no state in which the part exists and the receipt
 *     that created it does not.
 *   - **Provenance.** Every entry records who wrote it, in which run, and
 *     from which tool. The column is `NOT NULL`; there is no path that skips
 *     it.
 *   - **Non-negative on hand.** Checked under a row lock before the insert,
 *     and waived only for `adjustment`, which is the spec's named exception.
 */

import type { PoolClient } from "pg";
import type { DatabaseHandle } from "./db.js";
import { InputError, LedgerError } from "./errors.js";
import { formatPartRef, type PartRef } from "./parts.js";
import { toNumber } from "./quantity.js";

/** PostgreSQL's unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

/**
 * Build an idempotency key from its parts.
 *
 * JSON rather than a joined string, for two reasons. A delimiter has to be a
 * character the parts cannot contain, and both parts here are free text — a
 * reference reading `a` with a part of `b:c` must not collide with one
 * reading `c` and a part of `b`. And the obvious invisible delimiter, a NUL
 * byte, is the one character PostgreSQL `text` cannot store at all.
 */
export function idempotencyKey(...parts: string[]): string {
  return JSON.stringify(parts);
}

export type LedgerEntryType = "purchase" | "receipt" | "sale" | "adjustment";

export interface Provenance {
  /** The tool that caused this entry, or `migration`/`sync` for code paths. */
  source: string;
  agentId?: string;
  runId?: string;
  companyId?: string;
  projectId?: string;
  /** Gmail message id, BigCommerce order id, Adjustments-tab row — phases 3-6. */
  [key: string]: unknown;
}

export interface AppendEntryInput {
  part: PartRef;
  entryType: LedgerEntryType;
  /** Always positive; the entry type decides the direction. */
  quantity: number;
  reference: string;
  /**
   * The caller's half of the idempotency key — what kind of event this is,
   * plus anything that distinguishes two of them against one reference.
   * Repeating it is the same event, not a second one; omit it for "always
   * new".
   *
   * Only the caller's half, because the other half — the part and the
   * reference — is added here, from the *resolved* part. A caller cannot
   * build a key from the spelling it was given: `vendor-a:PART-001` and
   * `vendor-a:part-001` are one part, and a key that disagreed would let a
   * retry append a second entry and double the count.
   */
  idempotencyScope?: readonly string[];
  unitCost?: number;
  note?: string;
  /** Required. An entry nobody can trace is an entry nobody can check. */
  provenance: Provenance;
  createdBy: string;
  /**
   * Create the part when the reference is vendor-qualified and unknown.
   *
   * On for receipts and adjustments: both are evidence that the part is
   * physically here, and refusing them until an order email arrives would
   * mean opening balances could never be entered at all. Off wherever the
   * part is supposed to exist already.
   */
  createMissingPart?: boolean;
  /** Set when `createMissingPart` creates the row. */
  description?: string;
  unitOfMeasure?: string;
}

export interface PartRow {
  partId: string;
  vendor: string;
  vendorPartNumber: string;
  ref: string;
}

export interface LedgerEntry {
  id: string;
  partId: string;
  entryType: LedgerEntryType;
  quantityDelta: number;
  onHandDelta: number;
  onOrderDelta: number;
  reference: string;
  idempotencyKey: string | null;
  note: string | null;
  unitCost: number | null;
  createdAt: Date;
  createdBy: string;
}

export interface AppendEntryResult {
  entry: LedgerEntry;
  part: PartRow;
  /** True when the key had already been used and nothing new was written. */
  duplicate: boolean;
  stock: StockRow;
}

export interface StockRow {
  partId: string;
  ref: string;
  vendor: string;
  vendorPartNumber: string;
  description: string | null;
  unitOfMeasure: string;
  onHand: number;
  onOrder: number;
  committed: number;
  available: number;
  lastEntryAt: Date | null;
}

interface RawEntryRow {
  id: string;
  part_id: string;
  entry_type: LedgerEntryType;
  quantity_delta: string;
  on_hand_delta: string;
  on_order_delta: string;
  reference: string;
  idempotency_key: string | null;
  note: string | null;
  unit_cost: string | null;
  created_at: Date;
  created_by: string;
}

const ENTRY_COLUMNS = `id, part_id, entry_type, quantity_delta, on_hand_delta,
  on_order_delta, reference, idempotency_key, note, unit_cost, created_at, created_by`;

function toEntry(row: RawEntryRow): LedgerEntry {
  return {
    id: String(row.id),
    partId: row.part_id,
    entryType: row.entry_type,
    quantityDelta: toNumber(row.quantity_delta),
    onHandDelta: toNumber(row.on_hand_delta),
    onOrderDelta: toNumber(row.on_order_delta),
    reference: row.reference,
    idempotencyKey: row.idempotency_key,
    note: row.note,
    unitCost: row.unit_cost === null ? null : toNumber(row.unit_cost),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function toStock(row: Record<string, unknown>): StockRow {
  const vendor = row.vendor as string;
  const vendorPartNumber = row.vendor_part_number as string;
  return {
    partId: row.part_id as string,
    ref: formatPartRef(vendor, vendorPartNumber),
    vendor,
    vendorPartNumber,
    description: (row.description as string | null) ?? null,
    unitOfMeasure: row.unit_of_measure as string,
    onHand: toNumber(row.on_hand),
    onOrder: toNumber(row.on_order),
    committed: toNumber(row.committed),
    available: toNumber(row.available),
    lastEntryAt: (row.last_entry_at as Date | null) ?? null,
  };
}

/**
 * Find the part, creating it only when asked and only from a vendor-qualified
 * reference.
 *
 * `ON CONFLICT DO NOTHING` followed by a re-read, rather than a read followed
 * by an insert: two receipts for a new part arriving at once would both see
 * nothing and both insert, and one would fail on the unique index. This way
 * the loser simply reads the winner's row.
 */
async function resolvePart(
  client: PoolClient,
  part: PartRef,
  options: { create: boolean; description?: string; unitOfMeasure?: string },
): Promise<PartRow> {
  if (part.kind === "id") {
    const { rows } = await client.query(
      "SELECT id, vendor, vendor_part_number FROM parts WHERE id = $1",
      [part.id],
    );
    const row = rows[0];
    if (!row) {
      // An internal id carries nothing to create a part from, so an unknown
      // one is a mistyped id rather than a new part.
      throw new InputError(
        `No part has the id ${part.id}. Use a vendor-qualified reference such as vendor-a:part-001 if this part is new.`,
      );
    }
    return {
      partId: row.id,
      vendor: row.vendor,
      vendorPartNumber: row.vendor_part_number,
      ref: formatPartRef(row.vendor, row.vendor_part_number),
    };
  }

  const lookup = `SELECT id, vendor, vendor_part_number FROM parts
      WHERE vendor = $1 AND lower(vendor_part_number) = lower($2)`;
  const existing = await client.query(lookup, [part.vendor, part.vendorPartNumber]);
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return {
      partId: row.id,
      vendor: row.vendor,
      vendorPartNumber: row.vendor_part_number,
      ref: formatPartRef(row.vendor, row.vendor_part_number),
    };
  }

  if (!options.create) {
    throw new InputError(
      `This inventory has no part ${part.ref}. Record a receipt or an adjustment for it first, or check the part number.`,
    );
  }

  await client.query(
    `INSERT INTO parts (vendor, vendor_part_number, description, unit_of_measure)
     VALUES ($1, $2, $3, COALESCE($4, 'each'))
     ON CONFLICT DO NOTHING`,
    [part.vendor, part.vendorPartNumber, options.description ?? null, options.unitOfMeasure ?? null],
  );
  const created = await client.query(lookup, [part.vendor, part.vendorPartNumber]);
  const row = created.rows[0];
  if (!row) {
    throw new LedgerError(`The part ${part.ref} could not be created.`);
  }
  return {
    partId: row.id,
    vendor: row.vendor,
    vendorPartNumber: row.vendor_part_number,
    ref: formatPartRef(row.vendor, row.vendor_part_number),
  };
}

/**
 * How much of this part is still outstanding against this reference.
 *
 * A receipt discharges what the matching purchase put on order, and no more:
 * stock that arrives with no purchase behind it (an opening balance, a free
 * sample) has nothing to discharge, so on-order stays where it was instead of
 * going negative.
 *
 * Deliberately keyed on the reference alone, and not on whatever made this
 * particular receipt a distinct event. An order delivered in two shipments is
 * two receipts against one PO, and both of them have to draw down that PO's
 * outstanding quantity — otherwise the second shipment lands on hand while
 * on-order stays overstated forever, for an order that is fully delivered.
 * `record_receipt`'s `delivery` parameter is the other half of this decision:
 * it makes the second shipment a separate event without making it a separate
 * order.
 */
async function outstandingOnOrder(
  client: PoolClient,
  partId: string,
  reference: string,
): Promise<number> {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(on_order_delta), 0) AS outstanding
       FROM ledger_entries WHERE part_id = $1 AND reference = $2`,
    [partId, reference],
  );
  return Math.max(toNumber(rows[0]?.outstanding), 0);
}

async function currentOnHand(client: PoolClient, partId: string): Promise<number> {
  const { rows } = await client.query(
    "SELECT COALESCE(SUM(on_hand_delta), 0) AS on_hand FROM ledger_entries WHERE part_id = $1",
    [partId],
  );
  return toNumber(rows[0]?.on_hand);
}

async function readStockFor(client: PoolClient, partId: string): Promise<StockRow> {
  const { rows } = await client.query("SELECT * FROM part_stock WHERE part_id = $1", [partId]);
  if (!rows[0]) throw new LedgerError("The part disappeared while it was being written.");
  return toStock(rows[0]);
}

async function findByIdempotencyKey(
  client: PoolClient,
  key: string,
): Promise<LedgerEntry | undefined> {
  const { rows } = await client.query<RawEntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM ledger_entries WHERE idempotency_key = $1`,
    [key],
  );
  return rows[0] ? toEntry(rows[0]) : undefined;
}

/**
 * Signed deltas for one event, matching the CHECK constraint in
 * `0002_ledger.sql`.
 *
 * The constraint is the authority; this function exists so a caller never has
 * to work the signs out, and so a mismatch between the two shows up as a
 * failing test rather than as a wrong balance.
 */
function bucketsFor(
  entryType: LedgerEntryType,
  quantity: number,
  outstanding: number,
): { quantityDelta: number; onHandDelta: number; onOrderDelta: number } {
  switch (entryType) {
    case "purchase":
      return { quantityDelta: quantity, onHandDelta: 0, onOrderDelta: quantity };
    case "receipt":
      return {
        quantityDelta: quantity,
        onHandDelta: quantity,
        onOrderDelta: -Math.min(quantity, outstanding),
      };
    case "sale":
      return { quantityDelta: -quantity, onHandDelta: -quantity, onOrderDelta: 0 };
    case "adjustment":
      return { quantityDelta: quantity, onHandDelta: quantity, onOrderDelta: 0 };
  }
}

/**
 * Append one entry.
 *
 * `quantity` is the magnitude for every type except `adjustment`, where its
 * sign is the whole point: an adjustment is the caller saying which way the
 * count was wrong.
 */
export async function appendEntry(
  db: DatabaseHandle,
  input: AppendEntryInput,
): Promise<AppendEntryResult> {
  if (input.entryType !== "adjustment" && input.quantity <= 0) {
    throw new InputError(`A ${input.entryType} quantity must be greater than zero.`);
  }
  if (input.entryType === "adjustment" && input.quantity === 0) {
    throw new InputError("An adjustment of zero changes nothing.");
  }
  const reference = input.reference.trim();
  if (reference === "") {
    throw new InputError("A reference is required: it is what makes this entry traceable.");
  }

  // Set inside the transaction, read by the unique-violation recovery below,
  // which needs the key the failed attempt used and cannot rebuild it without
  // resolving the part again.
  let attemptedKey: string | undefined;

  const write = async (): Promise<AppendEntryResult> =>
    db.transaction(async (client) => {
      const part = await resolvePart(client, input.part, {
        create: input.createMissingPart === true,
        description: input.description,
        unitOfMeasure: input.unitOfMeasure,
      });

      // Built here rather than by the caller, so every spelling of one part —
      // uppercase, lowercase, or the internal id — produces the same key and
      // a retry is recognised as the retry it is.
      const key = input.idempotencyScope
        ? idempotencyKey(...input.idempotencyScope, part.partId, reference)
        : undefined;
      attemptedKey = key;

      // Serialises concurrent writers for this part, which is what makes the
      // balance check below a decision and not a guess. Two sales racing for
      // the last unit queue here; the second sees the first's entry.
      await client.query("SELECT id FROM parts WHERE id = $1 FOR UPDATE", [part.partId]);

      // Under the lock, so the answer cannot change between the look and the
      // insert: a concurrent writer with the same key is either already
      // committed and found here, or still waiting on the lock above.
      if (key) {
        const existing = await findByIdempotencyKey(client, key);
        if (existing) {
          return {
            entry: existing,
            part,
            duplicate: true,
            stock: await readStockFor(client, part.partId),
          };
        }
      }

      const outstanding =
        input.entryType === "receipt"
          ? await outstandingOnOrder(client, part.partId, reference)
          : 0;
      const deltas = bucketsFor(input.entryType, input.quantity, outstanding);

      // SPEC.md: "On-hand never goes negative without an explicit
      // adjustment." Adjustments are that exception, and only them — a sale
      // that would overdraw stock is a sale of something we do not have, and
      // the right answer is to say so rather than to invent the parts.
      if (deltas.onHandDelta < 0 && input.entryType !== "adjustment") {
        const onHand = await currentOnHand(client, part.partId);
        if (onHand + deltas.onHandDelta < 0) {
          throw new LedgerError(
            `That ${input.entryType} would leave ${part.ref} at ${onHand + deltas.onHandDelta}, and on-hand cannot go negative. On hand is ${onHand}. Record an adjustment if the count really is wrong.`,
          );
        }
      }

      const { rows } = await client.query<RawEntryRow>(
        `INSERT INTO ledger_entries
           (part_id, entry_type, quantity_delta, on_hand_delta, on_order_delta,
            unit_cost, reference, idempotency_key, note, provenance, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
         RETURNING ${ENTRY_COLUMNS}`,
        [
          part.partId,
          input.entryType,
          deltas.quantityDelta,
          deltas.onHandDelta,
          deltas.onOrderDelta,
          input.unitCost ?? null,
          reference,
          key ?? null,
          input.note ?? null,
          JSON.stringify(input.provenance),
          input.createdBy,
        ],
      );

      return {
        entry: toEntry(rows[0]!),
        part,
        duplicate: false,
        stock: await readStockFor(client, part.partId),
      };
    });

  try {
    return await write();
  } catch (error) {
    // The unique index is the real guarantee, and it fires on the one
    // interleaving the lock cannot cover: two writers whose first entry for a
    // brand-new part races before either holds the row. The loser's
    // transaction is already dead, so the answer has to come from a fresh one.
    if (attemptedKey && (error as { code?: string })?.code === UNIQUE_VIOLATION) {
      const key = attemptedKey;
      const existing = await db.transaction(async (client) => {
        const entry = await findByIdempotencyKey(client, key);
        if (!entry) return undefined;
        return {
          entry,
          part: await partOf(client, entry.partId),
          duplicate: true,
          stock: await readStockFor(client, entry.partId),
        } satisfies AppendEntryResult;
      });
      if (existing) return existing;
    }
    throw error;
  }
}

async function partOf(client: PoolClient, partId: string): Promise<PartRow> {
  const { rows } = await client.query(
    "SELECT id, vendor, vendor_part_number FROM parts WHERE id = $1",
    [partId],
  );
  const row = rows[0];
  if (!row) throw new LedgerError(`Part ${partId} is referenced by a ledger entry but missing.`);
  return {
    partId: row.id,
    vendor: row.vendor,
    vendorPartNumber: row.vendor_part_number,
    ref: formatPartRef(row.vendor, row.vendor_part_number),
  };
}

/**
 * Read stock for one part, or for every part.
 *
 * Always from `part_stock`, never from a stored total, so there is no number
 * that can drift away from the entries it came from.
 */
export async function readStock(
  db: DatabaseHandle,
  part?: PartRef,
): Promise<StockRow[]> {
  if (!part) {
    const rows = await db.query("SELECT * FROM part_stock ORDER BY vendor, vendor_part_number");
    return rows.map(toStock);
  }
  const rows =
    part.kind === "id"
      ? await db.query("SELECT * FROM part_stock WHERE part_id = $1", [part.id])
      : await db.query(
          `SELECT * FROM part_stock
             WHERE vendor = $1 AND lower(vendor_part_number) = lower($2)`,
          [part.vendor, part.vendorPartNumber],
        );
  return rows.map(toStock);
}

/** The entries behind a part's balance, newest first. For diagnostics and tests. */
export async function readEntries(
  db: DatabaseHandle,
  partId: string,
  limit = 100,
): Promise<LedgerEntry[]> {
  const rows = await db.query<RawEntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM ledger_entries WHERE part_id = $1 ORDER BY id DESC LIMIT $2`,
    [partId, limit],
  );
  return rows.map(toEntry);
}
