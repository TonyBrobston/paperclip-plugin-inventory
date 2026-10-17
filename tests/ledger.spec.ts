/**
 * The ledger, against a real PostgreSQL.
 *
 * This is the suite BRO-198's acceptance criteria name: idempotency,
 * atomicity, provenance, and on-hand never going negative except through an
 * explicit adjustment. It runs against a server rather than a fake because
 * every one of those four is enforced by the database — a unique index, a
 * transaction, a `NOT NULL`, a row lock — and a fake would be testing the
 * mock's opinion of them.
 *
 * Where a rule is enforceable in SQL, there are two tests: one through
 * `appendEntry`, and one writing the bad row directly, because the
 * application is not the only thing that will ever hold a connection to this
 * database.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEntry, readEntries, readStock, type Provenance } from "../src/ledger.js";
import { executeNative } from "../src/native-service.js";
import { InputError, LedgerError } from "../src/errors.js";
import { parsePartRef, type PartRef } from "../src/parts.js";
import { quoteIdentifier } from "../src/db.js";
import { closeAll, dropSchema, exec, freshSchema, insertPart, integration, type TestSchema } from "./support/database.js";

const PROVENANCE: Provenance = {
  source: "test",
  agentId: "agent-1",
  runId: "run-1",
  companyId: "company-1",
};

const AGENT = "agent-1";

integration("the ledger", () => {
  let t: TestSchema;
  // Narrowed, not asserted: every helper below needs the vendor-qualified
  // half of the union, and `parsePartRef` returns either.
  const part = parsePartRef("vendor-a:part-001") as Extract<PartRef, { kind: "vendor" }>;

  beforeEach(async () => {
    t = await freshSchema();
  });
  afterEach(async () => {
    await dropSchema(t);
  });
  afterAll(async () => {
    await closeAll();
  });

  const receipt = (quantity: number, reference: string, scope?: readonly string[]) =>
    appendEntry(t.db, {
      part,
      entryType: "receipt",
      note: "Synthetic receipt: overages checked",
      quantity,
      reference,
      idempotencyScope: scope ?? ["receipt"],
      provenance: PROVENANCE,
      createdBy: AGENT,
      createMissingPart: true,
    });

  const purchase = (quantity: number, reference: string) =>
    appendEntry(t.db, {
      part,
      entryType: "purchase",
      quantity,
      reference,
      idempotencyScope: ["purchase"],
      provenance: PROVENANCE,
      createdBy: AGENT,
      createMissingPart: true,
    });

  const sale = (quantity: number, reference: string) =>
    appendEntry(t.db, {
      part,
      entryType: "sale",
      quantity,
      reference,
      idempotencyScope: ["sale"],
      provenance: PROVENANCE,
      createdBy: AGENT,
    });

  const adjustment = async (quantityDelta: number, reference: string, scope?: readonly string[]) => {
    if(!quantityDelta) throw new InputError('The adjustment changes nothing.');
    const result=await executeNative(t.db,{type:'agent',id:AGENT,companyId:'company-1'},'adjust',{
      partId:'vendor-a:part-001',quantityDelta,reason:'physical count',...(scope?{reference}:{}),
    });
    if(result.status==='pending')await executeNative(t.db,{type:'user',id:'reviewer',companyId:'company-1'},'approve_count',{countId:result.countId,reason:'Verified synthetic count'});
    return result;
  };

  const stockOf = async () => (await readStock(t.db, part))[0]!;

  // ----------------------------------------------------------------------
  describe("the migrations produce the schema SPEC.md describes", () => {
    it("creates every core table and the derived view", async () => {
      const rows = await exec(
        t,
        `SELECT table_name, table_type FROM information_schema.tables
          WHERE table_schema = $1 ORDER BY table_name`,
        [t.schema],
      );
      const byName = new Map(rows.map((row) => [row.table_name, row.table_type]));
      for (const table of [
        "parts",
        "ledger_entries",
        "orders",
        "order_lines",
        "reservations",
        "review_queue",
        "boms",
        "bom_lines",
        "sync_state",
        "schema_migrations",
      ]) {
        expect(byName.get(table), `${table} is missing`).toBe("BASE TABLE");
      }
      // On-hand is a view precisely so that it cannot be stored and edited.
      expect(byName.get("part_stock")).toBe("VIEW");
    });

    it("puts everything in the configured schema and nothing in public", async () => {
      const leaked = await exec(
        t,
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name IN
            ('parts','ledger_entries','orders','order_lines','reservations',
             'review_queue','boms','bom_lines','sync_state','part_stock')`,
      );
      expect(leaked).toEqual([]);
    });

    it("is a no-op the second time", async () => {
      // `freshSchema` already migrated once; `part_stock` existing proves it.
      const applied = await exec(t, "SELECT key FROM schema_migrations ORDER BY key");
      expect(applied.map((row) => row.key)).toEqual([
        "0001_parts",
        "0002_ledger",
        "0003_orders",
        "0004_reservations",
        "0005_review_queue",
        "0006_boms",
        "0007_sync_state",
        "0008_part_stock",
        "0009_intake",
        "0010_review_disposition",
        "0011_sheet_sync",
        "0012_bom_catalog_keys",
        "0013_bigcommerce_bridge",
        "0014_native_inventory",
        "0015_company_scope",
      ]);
    });
  });

  // ----------------------------------------------------------------------
  describe("the three quantities stay separate", () => {
    it("an order puts stock on order without putting it on hand", async () => {
      await purchase(10, "PO-1");
      expect(await stockOf()).toMatchObject({ onOrder: 10, onHand: 0, committed: 0 });
    });

    it("a receipt moves it from on order to on hand", async () => {
      await purchase(10, "PO-1");
      await receipt(4, "PO-1");
      expect(await stockOf()).toMatchObject({ onOrder: 6, onHand: 4 });
    });

    it("receiving more than was ordered does not drive on order negative", async () => {
      // A vendor over-ships, or a receipt is entered against the wrong order.
      // "Minus four on order" is not a quantity anybody can act on.
      await purchase(10, "PO-1");
      await receipt(14, "PO-1");
      expect(await stockOf()).toMatchObject({ onOrder: 0, onHand: 14 });
    });

    it("stock that arrives with no order behind it discharges nothing", async () => {
      // An opening balance, or a free sample. On order stays where it was.
      await receipt(7, "opening balance");
      expect(await stockOf()).toMatchObject({ onOrder: 0, onHand: 7 });
    });

    it("clears the order when it arrives in two shipments", async () => {
      // Each shipment is its own event — a different delivery, so a different
      // key — but both discharge the same order. Were the second one forced
      // onto a new reference instead, it would discharge nothing and this
      // fully delivered order would sit at 6 on order forever.
      await purchase(10, "PO-1");
      await receipt(4, "PO-1", ["receipt", "slip-1"]);
      expect(await stockOf()).toMatchObject({ onOrder: 6, onHand: 4 });
      await receipt(6, "PO-1", ["receipt", "slip-2"]);
      expect(await stockOf()).toMatchObject({ onOrder: 0, onHand: 10 });
    });

    it("does not let an extra shipment drive on order below zero", async () => {
      await purchase(10, "PO-1");
      await receipt(10, "PO-1", ["receipt", "slip-1"]);
      await receipt(3, "PO-1", ["receipt", "slip-2"]);
      expect(await stockOf()).toMatchObject({ onOrder: 0, onHand: 13 });
    });

    it("a receipt against a different reference leaves the first order outstanding", async () => {
      await purchase(10, "PO-1");
      await receipt(10, "PO-2");
      expect(await stockOf()).toMatchObject({ onOrder: 10, onHand: 10 });
    });

    it("committed is a promise, so it lowers available without touching on hand", async () => {
      await receipt(10, "opening balance");
      const partId = (await stockOf()).partId;
      await exec(
        t,
        `INSERT INTO reservations (part_id, quantity, bigcommerce_order_id, bigcommerce_line_id, status)
         VALUES ($1, 3, 'bc-100', 'line-1', 'committed')`,
        [partId],
      );
      expect(await stockOf()).toMatchObject({ onHand: 10, committed: 3, available: 7 });
    });

    it("a released reservation stops counting as committed", async () => {
      await receipt(10, "opening balance");
      const partId = (await stockOf()).partId;
      await exec(
        t,
        `INSERT INTO reservations (part_id, quantity, bigcommerce_order_id, bigcommerce_line_id, status)
         VALUES ($1, 3, 'bc-100', 'line-1', 'released')`,
        [partId],
      );
      expect(await stockOf()).toMatchObject({ onHand: 10, committed: 0, available: 10 });
    });
  });

  // ----------------------------------------------------------------------
  describe("idempotency", () => {
    it("a repeated receipt writes one entry, not two", async () => {
      const first = await receipt(5, "PO-1");
      const second = await receipt(5, "PO-1");

      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(second.entry.id).toBe(first.entry.id);
      expect(await stockOf()).toMatchObject({ onHand: 5 });
      expect(await readEntries(t.db, first.part.partId)).toHaveLength(1);
    });

    it("two identical receipts racing produce one entry", async () => {
      // The row lock orders them; the unique index catches the interleaving
      // where neither held the lock yet, because the part did not exist.
      const results = await Promise.all([
        receipt(5, "PO-RACE"),
        receipt(5, "PO-RACE"),
        receipt(5, "PO-RACE"),
      ]);
      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(await stockOf()).toMatchObject({ onHand: 5 });
      expect(await readEntries(t.db, results[0]!.part.partId)).toHaveLength(1);
    });

    it("a different reference is a different receipt", async () => {
      await receipt(5, "PO-1");
      await receipt(5, "PO-2");
      expect(await stockOf()).toMatchObject({ onHand: 10 });
    });

    it("an unreferenced adjustment is a new event every time", async () => {
      // Two physical counts of the same part really are two events, and
      // collapsing them would lose one.
      await adjustment(2, "count");
      await adjustment(2, "count");
      expect(await stockOf()).toMatchObject({ onHand: 4 });
    });

    it("a referenced adjustment is applied once however often the sync runs", async () => {
      await adjustment(2, "sheet-row-12", ["adjustment"]);
      const again = await adjustment(2, "sheet-row-12", ["adjustment"]);
      expect(again.duplicate).toBe(true);
      expect(await stockOf()).toMatchObject({ onHand: 2 });
    });

    it("recognises the retry whatever the caller spelled the part number as", async () => {
      // The key names the resolved part, not the caller's spelling of it.
      // `parts` matches case-insensitively, so if the key did not, a retry
      // that shouted the part number would find no row for its key, resolve
      // to the same part, and append a second receipt — doubling stock by
      // doing the one thing the key exists to absorb.
      const first = await receipt(5, "PO-1");
      const shouted = await appendEntry(t.db, {
        part: parsePartRef("vendor-a:PART-001"),
        entryType: "receipt",
        quantity: 5,
        reference: "PO-1",
        idempotencyScope: ["receipt"],
        provenance: PROVENANCE,
        createdBy: AGENT,
        createMissingPart: true,
      });

      expect(shouted.duplicate).toBe(true);
      expect(shouted.entry.id).toBe(first.entry.id);
      expect(await stockOf()).toMatchObject({ onHand: 5 });
      expect(await readEntries(t.db, first.part.partId)).toHaveLength(1);
    });

    it("recognises the retry when it addresses the part by its internal id", async () => {
      // Same defect one scope wider: a caller that read the part id back from
      // a previous result and retried with it must not get a second entry.
      const first = await receipt(5, "PO-1");
      const byId = await appendEntry(t.db, {
        part: parsePartRef(first.part.partId),
        entryType: "receipt",
        quantity: 5,
        reference: "PO-1",
        idempotencyScope: ["receipt"],
        provenance: PROVENANCE,
        createdBy: AGENT,
      });

      expect(byId.duplicate).toBe(true);
      expect(byId.entry.id).toBe(first.entry.id);
      expect(await stockOf()).toMatchObject({ onHand: 5 });
    });

    it("keeps one part's events from colliding with another's", async () => {
      // The key carries the part, so the same scope and reference on a
      // different part is a different event.
      await receipt(5, "PO-1");
      await appendEntry(t.db, {
        part: parsePartRef("vendor-a:part-002"),
        entryType: "receipt",
        quantity: 3,
        reference: "PO-1",
        idempotencyScope: ["receipt"],
        provenance: PROVENANCE,
        createdBy: AGENT,
        createMissingPart: true,
      });
      expect(await stockOf()).toMatchObject({ onHand: 5 });
      expect((await readStock(t.db, parsePartRef("vendor-a:part-002")))[0]).toMatchObject({
        onHand: 3,
      });
    });

    it("refuses a second entry under the same key, in the database itself", async () => {
      // The guarantee is the index, not the read that precedes it.
      const first = await receipt(5, "PO-1");
      await expect(
        exec(
          t,
          `INSERT INTO ledger_entries
             (part_id, entry_type, quantity_delta, on_hand_delta, reference, idempotency_key, provenance, created_by)
           VALUES ($1, 'receipt', 1, 1, 'PO-1', $2, '{"source":"manual"}'::jsonb, 'someone')`,
          [first.part.partId, first.entry.idempotencyKey],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("leaves entries without a key free to repeat", async () => {
      const partId = await insertPart(t, "vendor-a", "part-free");
      for (let i = 0; i < 2; i++) {
        await exec(
          t,
          `INSERT INTO ledger_entries
             (part_id, entry_type, quantity_delta, on_hand_delta, reference, provenance, created_by)
           VALUES ($1, 'receipt', 1, 1, 'receipt', '{"source":"manual"}'::jsonb, 'someone')`,
          [partId],
        );
      }
      const rows = await exec(t, "SELECT count(*)::int AS n FROM ledger_entries WHERE part_id = $1", [partId]);
      expect(rows[0]!.n).toBe(2);
    });
  });

  // ----------------------------------------------------------------------
  describe("atomicity", () => {
    it("a failed entry leaves no part behind it", async () => {
      // The part is created in the same transaction as the entry that needed
      // it. If that were two transactions, a rejected receipt would leave a
      // phantom part in the catalogue with no stock and no history.
      await expect(
        appendEntry(t.db, {
          part: parsePartRef("vendor-a:part-phantom"),
          entryType: "receipt",
          quantity: 5,
          reference: "PO-1",
          createMissingPart: true,
          createdBy: AGENT,
          // Refused by `ledger_provenance_is_a_fact`.
          provenance: {} as Provenance,
        }),
      ).rejects.toThrow();

      const rows = await exec(t, "SELECT id FROM parts WHERE vendor_part_number = 'part-phantom'");
      expect(rows).toEqual([]);
    });

    it("a refused sale writes nothing at all", async () => {
      await receipt(3, "PO-1");
      const before = await readEntries(t.db, (await stockOf()).partId);
      await expect(sale(5, "bc-1")).rejects.toThrow(LedgerError);
      expect(await readEntries(t.db, (await stockOf()).partId)).toEqual(before);
      expect(await stockOf()).toMatchObject({ onHand: 3 });
    });

    it("rolls back every statement when one of them fails", async () => {
      const partId = await insertPart(t, "vendor-a", "part-tx");
      await expect(
        t.db.transaction(async (client) => {
          await client.query(
            `INSERT INTO ledger_entries (part_id, entry_type, quantity_delta, on_hand_delta, reference, provenance, created_by)
             VALUES ($1, 'receipt', 5, 5, 'PO-1', '{"source":"manual"}'::jsonb, 'someone')`,
            [partId],
          );
          throw new Error("the second half failed");
        }),
      ).rejects.toThrow(/second half/);
      expect(await readEntries(t.db, partId)).toEqual([]);
    });
  });

  // ----------------------------------------------------------------------
  describe("provenance", () => {
    it("records who wrote the entry, in which run, from which tool", async () => {
      const result = await receipt(5, "PO-1");
      const rows = await exec(t, "SELECT provenance, created_by FROM ledger_entries WHERE id = $1", [
        result.entry.id,
      ]);
      expect(rows[0]!.created_by).toBe(AGENT);
      expect(rows[0]!.provenance).toMatchObject({
        source: "test",
        agentId: "agent-1",
        runId: "run-1",
      });
    });

    it("refuses an entry with no provenance", async () => {
      const partId = await insertPart(t, "vendor-a", "part-np");
      await expect(
        exec(
          t,
          `INSERT INTO ledger_entries (part_id, entry_type, quantity_delta, on_hand_delta, reference, created_by)
           VALUES ($1, 'receipt', 1, 1, 'PO-1', 'someone')`,
          [partId],
        ),
      ).rejects.toThrow(/provenance/);
    });

    it("refuses provenance that says nothing", async () => {
      // An empty object satisfies NOT NULL and answers no question, so the
      // constraint asks for more than the column type does.
      const partId = await insertPart(t, "vendor-a", "part-ep");
      await expect(
        exec(
          t,
          `INSERT INTO ledger_entries (part_id, entry_type, quantity_delta, on_hand_delta, reference, provenance, created_by)
           VALUES ($1, 'receipt', 1, 1, 'PO-1', '{}'::jsonb, 'someone')`,
          [partId],
        ),
      ).rejects.toThrow(/ledger_provenance_is_a_fact/);
    });

    it("refuses an entry nobody admits to writing", async () => {
      const partId = await insertPart(t, "vendor-a", "part-nb");
      await expect(
        exec(
          t,
          `INSERT INTO ledger_entries (part_id, entry_type, quantity_delta, on_hand_delta, reference, provenance, created_by)
           VALUES ($1, 'receipt', 1, 1, 'PO-1', '{"source":"manual"}'::jsonb, '   ')`,
          [partId],
        ),
      ).rejects.toThrow(/ledger_created_by_not_blank/);
    });

    it("refuses an entry about nothing", async () => {
      const partId = await insertPart(t, "vendor-a", "part-nr");
      await expect(
        exec(
          t,
          `INSERT INTO ledger_entries (part_id, entry_type, quantity_delta, on_hand_delta, reference, provenance, created_by)
           VALUES ($1, 'receipt', 1, 1, '  ', '{"source":"manual"}'::jsonb, 'someone')`,
          [partId],
        ),
      ).rejects.toThrow(/ledger_reference_not_blank/);
    });
  });

  // ----------------------------------------------------------------------
  describe("on-hand never goes negative, except by adjustment", () => {
    it("allows a sale the stock covers", async () => {
      await receipt(10, "PO-1");
      await sale(4, "bc-1");
      expect(await stockOf()).toMatchObject({ onHand: 6 });
    });

    it("refuses a sale the stock does not cover, and says what it has", async () => {
      await receipt(3, "PO-1");
      await expect(sale(5, "bc-1")).rejects.toThrow(/cannot go negative.*On hand is 3/s);
    });

    it("refuses it exactly at the boundary and allows it one unit below", async () => {
      await receipt(5, "PO-1");
      await expect(sale(6, "bc-over")).rejects.toThrow(LedgerError);
      await sale(5, "bc-exact");
      expect(await stockOf()).toMatchObject({ onHand: 0 });
    });

    it("waits for whoever else is writing this part before deciding", async () => {
      // This is why the write path locks the part row before it reads the
      // balance. Without the lock, two sales of the last five units both read
      // "5 on hand", both decide they fit, and the ledger lands at minus five
      // with no adjustment explaining it.
      //
      // Firing two sales at once would not prove the lock exists — they
      // mostly do not overlap, and the test passes either way. So the
      // competing writer here is this test, holding the lock explicitly, and
      // the assertion is that `appendEntry` does not reach a decision while
      // it is held.
      await receipt(5, "PO-1");
      const partId = (await stockOf()).partId;

      const holder = await t.db.pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(`SET LOCAL search_path TO ${quoteIdentifier(t.schema)}`);
        await holder.query("SELECT id FROM parts WHERE id = $1 FOR UPDATE", [partId]);
        // The competing writer spends all five units, but has not committed.
        await holder.query(
          `INSERT INTO ledger_entries
             (part_id, entry_type, quantity_delta, on_hand_delta, reference, provenance, created_by)
           VALUES ($1, 'sale', -5, -5, 'bc-a', '{"source":"competitor"}'::jsonb, 'agent-2')`,
          [partId],
        );

        let settled = false;
        const outcome = sale(5, "bc-b").then(
          () => {
            settled = true;
            return "allowed" as const;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );

        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled, "the sale decided while another writer held the part").toBe(false);

        await holder.query("COMMIT");

        // Now it may proceed, and the balance it reads is the one the other
        // writer left behind — not the one it would have read before.
        expect(await outcome).toBeInstanceOf(LedgerError);
      } finally {
        holder.release();
      }

      expect(await stockOf()).toMatchObject({ onHand: 0 });
    });

    it("lets an adjustment take stock negative, because the shelf is the authority", async () => {
      // SPEC.md's named exception. If a count says we have fewer than the
      // ledger thinks, the honest record is the negative number plus the
      // adjustment that explains it.
      await receipt(2, "PO-1");
      await adjustment(-10, "annual count");
      expect(await stockOf()).toMatchObject({ onHand: -8 });
    });

    it("still refuses a sale once an adjustment has left stock negative", async () => {
      await adjustment(-5, "miscount");
      await expect(sale(1, "bc-1")).rejects.toThrow(LedgerError);
    });

    it("refuses a receipt or sale of nothing", async () => {
      await expect(
        appendEntry(t.db, {
          part,
          entryType: "receipt",
          quantity: 0,
          reference: "PO-1",
          provenance: PROVENANCE,
          createdBy: AGENT,
          createMissingPart: true,
        }),
      ).rejects.toThrow(InputError);
      await expect(adjustment(0, "nothing")).rejects.toThrow(/changes nothing/);
    });

    it("refuses an entry with no reference", async () => {
      await expect(
        appendEntry(t.db, {
          part,
          entryType: "receipt",
          quantity: 1,
          reference: "   ",
          provenance: PROVENANCE,
          createdBy: AGENT,
          createMissingPart: true,
        }),
      ).rejects.toThrow(/reference is required/);
    });
  });

  // ----------------------------------------------------------------------
  describe("append-only", () => {
    it("refuses an update", async () => {
      const result = await receipt(5, "PO-1");
      await expect(
        exec(t, "UPDATE ledger_entries SET quantity_delta = 99 WHERE id = $1", [result.entry.id]),
      ).rejects.toThrow(/append-only; UPDATE/);
    });

    it("refuses a delete", async () => {
      const result = await receipt(5, "PO-1");
      await expect(
        exec(t, "DELETE FROM ledger_entries WHERE id = $1", [result.entry.id]),
      ).rejects.toThrow(/append-only; DELETE/);
    });

    it("refuses a truncate, which fires no row triggers at all", async () => {
      await receipt(5, "PO-1");
      await expect(exec(t, "TRUNCATE ledger_entries CASCADE")).rejects.toThrow(/append-only; TRUNCATE/);
    });

    it("leaves the row intact after a refused update", async () => {
      const result = await receipt(5, "PO-1");
      await exec(t, "UPDATE ledger_entries SET quantity_delta = 99 WHERE id = $1", [
        result.entry.id,
      ]).catch(() => undefined);
      expect(await stockOf()).toMatchObject({ onHand: 5 });
    });
  });

  // ----------------------------------------------------------------------
  describe("an entry's type and its buckets have to agree", () => {
    const badEntries: Array<[string, string]> = [
      ["a sale that adds stock", "'sale', 5, 5, 0"],
      ["a sale with a negative quantity but no movement", "'sale', -5, 0, 0"],
      ["a purchase that lands on hand", "'purchase', 5, 5, 0"],
      ["a receipt that discharges more than it delivered", "'receipt', 5, 5, -6"],
      ["a receipt that puts stock back on order", "'receipt', 5, 5, 1"],
      ["an adjustment that touches on order", "'adjustment', 5, 5, -1"],
      ["an adjustment of nothing", "'adjustment', 0, 0, 0"],
      ["an unknown type", "'shrinkage', 5, 5, 0"],
    ];

    for (const [label, values] of badEntries) {
      it(`refuses ${label}`, async () => {
        const partId = await insertPart(t, "vendor-a", `part-${label.replace(/\W+/g, "-")}`);
        await expect(
          exec(
            t,
            `INSERT INTO ledger_entries
               (part_id, entry_type, quantity_delta, on_hand_delta, on_order_delta, reference, provenance, created_by)
             VALUES ($1, ${values}, 'ref', '{"source":"manual"}'::jsonb, 'someone')`,
            [partId],
          ),
        ).rejects.toThrow(/ledger_(buckets_match_entry_type|entry_type_known)|authorized count line/);
      });
    }

    it("accepts unguarded purchase, receipt and sale shapes", async () => {
      const partId = await insertPart(t, "vendor-a", "part-ok");
      for (const values of [
        "'purchase', 5, 0, 5",
        "'receipt', 5, 5, -5",
        "'sale', -2, -2, 0",
      ]) {
        await exec(
          t,
          `INSERT INTO ledger_entries
             (part_id, entry_type, quantity_delta, on_hand_delta, on_order_delta, reference, provenance, created_by)
           VALUES ($1, ${values}, 'ref', '{"source":"manual"}'::jsonb, 'someone')`,
          [partId],
        );
      }
      const rows = await exec(t, "SELECT on_hand, on_order FROM part_stock WHERE part_id = $1", [partId]);
      expect(Number(rows[0]!.on_hand)).toBe(3);
      expect(Number(rows[0]!.on_order)).toBe(0);
    });
  });

  // ----------------------------------------------------------------------
  describe("parts", () => {
    it("treats a part number's casing as the same part", async () => {
      // Two rows here would split one part's stock in half, and nothing would
      // look wrong on either of them.
      await receipt(5, "PO-1");
      const upper = await appendEntry(t.db, {
        part: parsePartRef("vendor-a:PART-001"),
        entryType: "receipt",
        quantity: 5,
        reference: "PO-2",
        provenance: PROVENANCE,
        createdBy: AGENT,
        createMissingPart: true,
      });
      expect(upper.part.partId).toBe((await stockOf()).partId);
      expect(await stockOf()).toMatchObject({ onHand: 10 });
      // The first spelling we saw is the one we keep showing.
      expect(upper.part.ref).toBe("vendor-a:part-001");
    });

    it("refuses an internal id nobody has seen", async () => {
      await expect(
        appendEntry(t.db, {
          part: parsePartRef("3f2504e0-4f89-41d3-9a0c-0305e82c3301"),
          entryType: "receipt",
          quantity: 1,
          reference: "PO-1",
          createMissingPart: true,
          provenance: PROVENANCE,
          createdBy: AGENT,
        }),
      ).rejects.toThrow(/No part has the id/);
    });

    it("refuses an unknown part where the caller said not to create one", async () => {
      await expect(
        appendEntry(t.db, {
          part: parsePartRef("vendor-b:part-404"),
          entryType: "sale",
          quantity: 1,
          reference: "bc-1",
          provenance: PROVENANCE,
          createdBy: AGENT,
        }),
      ).rejects.toThrow(/has no part vendor-b:part-404/);
    });

    it("refuses an uppercase vendor straight into the table", async () => {
      await expect(
        exec(t, "INSERT INTO parts (vendor, vendor_part_number) VALUES ('McMaster', 'x')"),
      ).rejects.toThrow(/parts_vendor_is_lowercase/);
    });
  });

  // ----------------------------------------------------------------------
  describe("reading stock", () => {
    it("returns nothing for a part nobody has recorded", async () => {
      expect(await readStock(t.db, parsePartRef("vendor-z:part-999"))).toEqual([]);
    });

    it("lists every part, ordered so the output is stable", async () => {
      await receipt(1, "PO-1");
      await appendEntry(t.db, {
        part: parsePartRef("vendor-b:part-002"),
        entryType: "receipt",
        quantity: 2,
        reference: "PO-2",
        provenance: PROVENANCE,
        createdBy: AGENT,
        createMissingPart: true,
      });
      const all = await readStock(t.db);
      expect(all.map((row) => row.ref)).toEqual(["vendor-a:part-001", "vendor-b:part-002"]);
    });

    it("reports a part with no entries as zero rather than omitting it", async () => {
      // A part exists the moment it is ordered. "We have none" and "we have
      // never heard of it" are different answers.
      await insertPart(t, "vendor-c", "part-003");
      const rows = await readStock(t.db, parsePartRef("vendor-c:part-003"));
      expect(rows[0]).toMatchObject({ onHand: 0, onOrder: 0, committed: 0, lastEntryAt: null });
    });

    it("keeps fractional quantities exact through the round trip", async () => {
      await receipt(2.5, "PO-1");
      await receipt(0.0001, "PO-2");
      expect((await stockOf()).onHand).toBe(2.5001);
    });
  });

  // ----------------------------------------------------------------------
  describe("the idempotency constraints the later phases rely on", () => {
    it("allows one order per vendor order number", async () => {
      await exec(t, "INSERT INTO orders (vendor, vendor_order_number) VALUES ('vendor-a', 'PO-1')");
      await expect(
        exec(t, "INSERT INTO orders (vendor, vendor_order_number) VALUES ('vendor-a', 'PO-1')"),
      ).rejects.toMatchObject({ code: "23505" });
      // A different vendor may use the same number.
      await exec(t, "INSERT INTO orders (vendor, vendor_order_number) VALUES ('vendor-b', 'PO-1')");
    });

    it("allows one order per Gmail message, and many with no message at all", async () => {
      await exec(
        t,
        "INSERT INTO orders (vendor, vendor_order_number, source_message_id) VALUES ('vendor-a','PO-1','msg-1')",
      );
      await expect(
        exec(
          t,
          "INSERT INTO orders (vendor, vendor_order_number, source_message_id) VALUES ('vendor-a','PO-2','msg-1')",
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await exec(t, "INSERT INTO orders (vendor, vendor_order_number) VALUES ('vendor-a','PO-3')");
      await exec(t, "INSERT INTO orders (vendor, vendor_order_number) VALUES ('vendor-a','PO-4')");
    });

    it("allows one line per line number on an order", async () => {
      const partId = await insertPart(t, "vendor-a", "part-ol");
      const order = await exec(
        t,
        "INSERT INTO orders (vendor, vendor_order_number) VALUES ('vendor-a','PO-1') RETURNING id",
      );
      const orderId = order[0]!.id;
      const insertLine = (line: number) =>
        exec(
          t,
          `INSERT INTO order_lines (order_id, line_number, part_id, quantity, unit_price, line_total)
           VALUES ($1, $2, $3, 1, 1, 1)`,
          [orderId, line, partId],
        );
      await insertLine(1);
      await expect(insertLine(1)).rejects.toMatchObject({ code: "23505" });
      await insertLine(2);
    });

    it("allows one reservation per BigCommerce line and part, and several parts per line", async () => {
      // One sold line expands through the BOM into several parts, so the
      // (order, line) pair alone would reject every part after the first.
      const a = await insertPart(t, "vendor-a", "part-r1");
      const b = await insertPart(t, "vendor-a", "part-r2");
      const reserve = (partId: string) =>
        exec(
          t,
          `INSERT INTO reservations (part_id, quantity, bigcommerce_order_id, bigcommerce_line_id, status)
           VALUES ($1, 1, 'bc-1', 'line-1', 'committed')`,
          [partId],
        );
      await reserve(a);
      await reserve(b);
      await expect(reserve(a)).rejects.toMatchObject({ code: "23505" });
    });

    it("keeps one open review item per message, but lets a resolved one come back", async () => {
      const open = () =>
        exec(
          t,
          "INSERT INTO review_queue (reason, source_message_id) VALUES ('subtotal mismatch', 'msg-1')",
        );
      await open();
      await expect(open()).rejects.toMatchObject({ code: "23505" });
      await exec(
        t,
        "UPDATE review_queue SET status = 'rejected', resolved_at = now() WHERE source_message_id = 'msg-1'",
      );
      await open();
    });

    it("refuses a review item that lies about being resolved", async () => {
      await expect(
        exec(
          t,
          "INSERT INTO review_queue (reason, status, resolved_at) VALUES ('x', 'open', now())",
        ),
      ).rejects.toThrow(/review_queue_resolution_is_consistent/);
      await expect(
        exec(t, "INSERT INTO review_queue (reason, status) VALUES ('x', 'accepted')"),
      ).rejects.toThrow(/review_queue_resolution_is_consistent/);
    });

    it("lets two mutually exclusive options consume the same part", async () => {
      // Phase 1 QA found the config repo's validator refusing this. A black
      // kit and a white kit can both use the same fastener; only one of them
      // ships.
      const partId = await insertPart(t, "vendor-a", "part-099");
      const bom = await exec(
        t,
        "INSERT INTO boms (catalog_key, catalog_key_kind, version, content_hash) VALUES ('KIT-1', 'variant_sku', 1, 'hash-1') RETURNING id",
      );
      const bomId = bom[0]!.id;
      const line = (value: string | null) =>
        exec(
          t,
          `INSERT INTO bom_lines (bom_id, option_name, option_value, part_id, quantity_per_unit,
                                  customer_description)
           VALUES ($1, $2, $3, $4, 4, 'A fastener')`,
          [bomId, value === null ? null : "Colour", value, partId],
        );
      await line("Black");
      await line("White");
      await line(null);
      // Twice in the same place is still a mistake.
      await expect(line("Black")).rejects.toMatchObject({ code: "23505" });
    });

    it("keeps BOM versions distinct per product", async () => {
      await exec(t, "INSERT INTO boms (catalog_key, catalog_key_kind, version, content_hash) VALUES ('KIT-1', 'variant_sku', 1, 'h1')");
      await expect(
        exec(t, "INSERT INTO boms (catalog_key, catalog_key_kind, version, content_hash) VALUES ('KIT-1', 'variant_sku', 1, 'h1')"),
      ).rejects.toMatchObject({ code: "23505" });
      await exec(t, "INSERT INTO boms (catalog_key, catalog_key_kind, version, content_hash) VALUES ('KIT-1', 'variant_sku', 2, 'h2')");
    });

    it("stores one row per sync cursor", async () => {
      await exec(t, "INSERT INTO sync_state (key, cursor) VALUES ('gmail', 'msg-1')");
      await expect(
        exec(t, "INSERT INTO sync_state (key, cursor) VALUES ('gmail', 'msg-2')"),
      ).rejects.toMatchObject({ code: "23505" });
    });
  });
});
