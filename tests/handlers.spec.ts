/**
 * The three phase 2 tools, driven the way an agent drives them.
 *
 * Through the SDK's host harness and against a real PostgreSQL, so what is
 * under test is the whole path — registration, parameter parsing, the
 * transaction, the result shape — rather than the handler functions in
 * isolation. An agent never calls `recordReceipt`; it calls a registered tool
 * with a JSON object and reads a `ToolResult`, and every step between those
 * two is somewhere a mistake can hide.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { CONFIG_KEYS } from "../src/constants.js";
import { closeAll, dropSchema, exec, freshSchema, integration, type TestSchema } from "./support/database.js";

interface Result {
  content?: string;
  error?: string;
  data?: Record<string, unknown>;
}

integration("the phase 2 tools", () => {
  let t: TestSchema;
  let harness: TestHarness;
  let companyId: string;
  let counter = 0;

  beforeEach(async () => {
    t = await freshSchema();
    companyId = `11111111-1111-4111-8111-${String(++counter).padStart(12, "0")}`;
    harness = createTestHarness({
      manifest,
      config: {
        [CONFIG_KEYS.databaseUrl]: { type: "secret_ref", secretId: "test-db" },
        [CONFIG_KEYS.databaseSchema]: t.schema,
      },
    });
    // The harness resolves any ref to the literal string `resolved:<ref>`,
    // which is not a connection string. Everything else about it — capability
    // checks, tool registration, the run context — is the real thing, so only
    // this one method is replaced.
    harness.ctx.secrets.resolve = async () => process.env.INVENTORY_TEST_DATABASE_URL!;
    await plugin.definition.setup(harness.ctx);
  });

  afterEach(async () => {
    await dropSchema(t);
  });
  afterAll(async () => {
    await closeAll();
  });

  const call = (tool: string, params: Record<string, unknown>) =>
    harness.executeTool<Result>(tool, params, { companyId, agentId: "agent-7", runId: "run-7" });

  const receipt = (params: Record<string, unknown>) =>
    call("record_receipt", { partId: "vendor-a:part-001", quantity: 5, reference: "PO-1", ...params });

  // ----------------------------------------------------------------------
  describe("record_receipt", () => {
    it("creates the part it has never seen and reports where that left things", async () => {
      // A receipt is physical evidence the part exists. Refusing it until an
      // order email arrives would mean an opening balance could never be
      // entered at all.
      const result = await receipt({});
      expect(result.error).toBeUndefined();
      expect(result.data).toMatchObject({
        recorded: true,
        duplicate: false,
        partRef: "vendor-a:part-001",
        stock: { onHand: 5, onOrder: 0, committed: 0, available: 5 },
      });
      expect(result.content).toContain("5 on hand");
    });

    it("runs the migrations on the first call, with nobody having to remember", async () => {
      // The host migrates only plugins that use `ctx.db`; this one owns its
      // connection, so the first tool call is what brings the schema up.
      const rows = await exec(t, "SELECT count(*)::int AS n FROM schema_migrations");
      expect(rows[0]!.n).toBe(15);
      await receipt({});
      expect((await exec(t, "SELECT count(*)::int AS n FROM ledger_entries"))[0]!.n).toBe(1);
    });

    it("treats a repeated reference as the same receipt", async () => {
      await receipt({});
      const again = await receipt({});
      expect(again.data).toMatchObject({ recorded: false, duplicate: true, stock: { onHand: 5 } });
      expect(again.content).toMatch(/already recorded/i);
    });

    it("treats a retry that spells the part number differently as the same receipt", async () => {
      // Parts match case-insensitively, so these are one part — and the retry
      // is one receipt. If the key disagreed with the lookup, this would be
      // 10 on hand from a single delivery, written by a retry.
      await receipt({});
      const shouted = await receipt({ partId: "vendor-a:PART-001" });
      expect(shouted.data).toMatchObject({ duplicate: true, stock: { onHand: 5 } });
      expect((await exec(t, "SELECT count(*)::int AS n FROM ledger_entries"))[0]!.n).toBe(1);
    });

    it("treats a retry addressed by internal part id as the same receipt", async () => {
      const first = await receipt({});
      const byId = await receipt({ partId: (first.data!.partId as string) });
      expect(byId.data).toMatchObject({ duplicate: true, stock: { onHand: 5 } });
      expect((await exec(t, "SELECT count(*)::int AS n FROM ledger_entries"))[0]!.n).toBe(1);
    });

    it("refuses a reused reference with a different quantity rather than picking one", async () => {
      // Either a typo or a second shipment against the same order. Merging
      // them silently would lose a number somebody meant.
      await receipt({});
      const conflict = await receipt({ quantity: 7 });
      expect(conflict.error).toMatch(/already used to receive 5/);
      expect(conflict.error).toMatch(/pass its packing slip as "delivery"/);
      const stock = await call("get_stock", { partId: "vendor-a:part-001" });
      expect(stock.data).toMatchObject({ parts: [{ onHand: 5 }] });
    });

    it("takes a second shipment against one order without losing the order", async () => {
      // The path the error above points at. Both shipments are receipts
      // against PO-1, so both draw down what PO-1 put on order.
      await receipt({ quantity: 4, delivery: "slip-1" });
      await receipt({ quantity: 6, delivery: "slip-2" });
      const stock = await call("get_stock", { partId: "vendor-a:part-001" });
      expect(stock.data).toMatchObject({ parts: [{ onHand: 10 }] });
    });

    it("still absorbs a retry of one shipment", async () => {
      await receipt({ quantity: 4, delivery: "slip-1" });
      const again = await receipt({ quantity: 4, delivery: "slip-1" });
      expect(again.data).toMatchObject({ duplicate: true, stock: { onHand: 4 } });
    });

    it("names the shipment when that is what the quantity disagrees about", async () => {
      await receipt({ quantity: 4, delivery: "slip-1" });
      const conflict = await receipt({ quantity: 9, delivery: "slip-1" });
      expect(conflict.error).toMatch(/Delivery "slip-1" against reference "PO-1"/);
    });

    it("keeps separate references separate", async () => {
      await receipt({ reference: "PO-1" });
      await receipt({ reference: "PO-2" });
      const stock = await call("get_stock", { partId: "vendor-a:part-001" });
      expect(stock.data).toMatchObject({ parts: [{ onHand: 10 }] });
    });

    it("says what is wrong with a part reference it cannot read", async () => {
      const result = await receipt({ partId: "part-001" });
      expect(result.error).toMatch(/not a part reference/);
    });

    it("refuses a quantity finer than stock is stored to", async () => {
      const result = await receipt({ quantity: 1.00001 });
      expect(result.error).toMatch(/more than 4 decimal places/);
    });

    it("refuses a receipt of nothing, and one with no reference", async () => {
      expect((await receipt({ quantity: 0 })).error).toMatch(/greater than zero/);
      expect((await receipt({ reference: "  " })).error).toMatch(/reference is required/i);
    });

    it("refuses text that cannot be stored, naming the field", async () => {
      // A NUL reaches PostgreSQL as an encoding error that names neither the
      // field nor anything an operator can act on.
      const result = await receipt({ reference: "PO-\u00001" });
      expect(result.error).toMatch(/control characters/);
    });

    it("records the calling agent and run as the entry's provenance", async () => {
      await receipt({});
      const rows = await exec(t, "SELECT provenance, created_by FROM ledger_entries");
      expect(rows[0]!.created_by).toBe("agent-7");
      expect(rows[0]!.provenance).toMatchObject({
        source: "record_receipt",
        agentId: "agent-7",
        runId: "run-7",
        companyId,
      });
    });

    it("cannot be told a different agent wrote it", async () => {
      // Provenance comes from the run context, which the host sets, not from
      // the parameters, which the agent writes.
      await receipt({ createdBy: "someone-else", provenance: { source: "forged" } });
      const rows = await exec(t, "SELECT provenance, created_by FROM ledger_entries");
      expect(rows[0]!.created_by).toBe("agent-7");
      expect(rows[0]!.provenance).toMatchObject({ source: "record_receipt" });
    });
  });

  // ----------------------------------------------------------------------
  describe("record_adjustment", () => {
    const adjust = (params: Record<string, unknown>) =>
      call("record_adjustment", {
        partId: "vendor-a:part-001",
        quantityDelta: -2,
        reason: "physical count",
        ...params,
      });

    it("corrects stock downward", async () => {
      await receipt({});
      const result = await adjust({});
      expect(result.data).toMatchObject({ status: "pending", duplicate: false });
      expect((await call("get_stock",{partId:"vendor-a:part-001"})).data).toMatchObject({parts:[{onHand:5}]});
    });

    it("holds a negative-stock adjustment for approval", async () => {
      // SPEC.md's one exception to the non-negative rule. It is also almost
      // always a missing receipt, which is worth saying out loud.
      const result = await adjust({ quantityDelta: -4 });
      expect(result.error).toBeUndefined();
      expect(result.data).toMatchObject({status:"pending"});
      expect(await exec(t,"SELECT * FROM ledger_entries")).toHaveLength(0);
    });

    it("applies a referenced adjustment once however often the sync runs", async () => {
      await adjust({ reference: "sheet-row-12" });
      const again = await adjust({ reference: "sheet-row-12" });
      expect(again.data).toMatchObject({ duplicate: true, status: "pending" });
    });

    it("applies it once even when the sync spells the part number differently", async () => {
      // A sheet row re-read with the vendor's own casing is the same row.
      await adjust({ reference: "sheet-row-12" });
      const again = await adjust({ partId: "vendor-a:PART-001", reference: "sheet-row-12" });
      expect(again.data).toMatchObject({ duplicate: true, status: "pending" });
    });

    it("treats an unreferenced adjustment as a new event each time", async () => {
      // Two physical counts of the same part are two events. Collapsing them
      // would silently throw one away.
      await adjust({});
      await adjust({});
      const stock = await call("get_stock", { partId: "vendor-a:part-001" });
      expect(stock.data).toMatchObject({ parts: [{ onHand: 0 }] });
      expect(await exec(t,"SELECT * FROM physical_counts")).toHaveLength(2);
    });

    it("requires a reason, because an adjustment has no document behind it", async () => {
      expect((await adjust({ reason: "" })).error).toMatch(/reason is required/i);
    });

    it("refuses an adjustment of zero", async () => {
      expect((await adjust({ quantityDelta: 0 })).error).toMatch(/cannot be zero/);
    });

    it("keeps the original reason and authenticated submitter in the count", async () => {
      await adjust({ reason: "annual count, two short" });
      const rows = await exec(t, "SELECT reason, submitted_by FROM physical_counts");
      expect(rows[0]!.reason).toBe("annual count, two short");
      expect(rows[0]!.submitted_by).toMatchObject({type:"agent",id:"agent-7",companyId});
    });
  });

  // ----------------------------------------------------------------------
  describe("get_stock", () => {
    it("answers for one part", async () => {
      await receipt({});
      const result = await call("get_stock", { partId: "vendor-a:part-001" });
      expect(result.data).toMatchObject({
        matched: true,
        count: 1,
        parts: [{ partRef: "vendor-a:part-001", onHand: 5, onOrder: 0, committed: 0 }],
      });
    });

    it("answers for everything when asked for nothing in particular", async () => {
      await receipt({ partId: "vendor-a:part-001" });
      await receipt({ partId: "vendor-b:part-002", reference: "PO-2", quantity: 3 });
      const result = await call("get_stock", {});
      expect(result.data).toMatchObject({ count: 2 });
      expect((result.data!.parts as Array<{ partRef: string }>).map((p) => p.partRef)).toEqual([
        "vendor-a:part-001",
        "vendor-b:part-002",
      ]);
    });

    it("says there is no such part instead of failing", async () => {
      // "We have never heard of it" is a true answer to "how many do we
      // have". An error would make an agent retry something that cannot work.
      const result = await call("get_stock", { partId: "vendor-z:part-999" });
      expect(result.error).toBeUndefined();
      expect(result.data).toMatchObject({ matched: false, count: 0, parts: [] });
    });

    it("reports an empty inventory as empty", async () => {
      const result = await call("get_stock", {});
      expect(result.data).toMatchObject({ count: 0 });
      expect(result.content).toMatch(/No parts yet/);
    });

    it("answers whether the part matched only when a part was named", async () => {
      // `matched: true` over an empty inventory would read as if the flag
      // were about the query, and would say the same thing as "we have never
      // heard of this part" — which is a different answer.
      await receipt({});
      expect((await call("get_stock", {})).data).not.toHaveProperty("matched");
      expect((await call("get_stock", { partId: "vendor-a:part-001" })).data).toMatchObject({
        matched: true,
      });
      expect((await call("get_stock", { partId: "vendor-z:part-999" })).data).toMatchObject({
        matched: false,
      });
    });

    it("never reads a stored total", async () => {
      // The only source is the view over the ledger, so there is no number
      // that can drift away from the entries behind it.
      await receipt({});
      const columns = await exec(
        t,
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'parts'`,
        [t.schema],
      );
      expect(columns.map((row) => row.column_name)).not.toContain("on_hand");
    });

    it("returns an ISO timestamp an agent can read", async () => {
      await receipt({});
      const result = await call("get_stock", { partId: "vendor-a:part-001" });
      const [first] = result.data!.parts as Array<{ lastEntryAt: string }>;
      expect(first!.lastEntryAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // ----------------------------------------------------------------------
  describe("failure reaches the agent as something it can act on", () => {
    it("reports a missing database connection as a configuration problem", async () => {
      const broken = createTestHarness({ manifest, config: {} });
      await plugin.definition.setup(broken.ctx);
      const result = await broken.executeTool<Result>(
        "get_stock",
        {},
        { companyId, agentId: "agent-7" },
      );
      expect(result.error).toMatch(/no database connection configured/i);
      expect(result.content).toBe(result.error);
      expect(result.data).toBeTypeOf("object");
    });

    it("does not quote the database's own error back to the agent", async () => {
      // A `pg` connection failure names the host, the port and often the
      // user. A tool result goes to an agent.
      const unreachable = createTestHarness({
        manifest,
        config: { [CONFIG_KEYS.databaseUrl]: { type: "secret_ref", secretId: "test-db" } },
      });
      unreachable.ctx.secrets.resolve = async () =>
        "postgres://secretuser:hunter2@nas.example.invalid:5432/inventory";
      await plugin.definition.setup(unreachable.ctx);
      const result = await unreachable.executeTool<Result>(
        "get_stock",
        {},
        { companyId: "22222222-2222-4222-8222-222222222222", agentId: "agent-7" },
      );
      const text = `${result.error} ${result.content} ${JSON.stringify(result.data)}`;
      expect(text).not.toMatch(/hunter2|secretuser|nas\.example\.invalid/);
      expect(result.error).toMatch(/could not be/i);
    });
  });
});
