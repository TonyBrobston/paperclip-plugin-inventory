import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  applyOrderLine,
  flushStock,
  sellableInTransaction,
  type OrderLineSnapshot,
} from "../src/bridge.js";
import { bigcommerceClient } from "../src/bigcommerce.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { executeNative } from "../src/native-service.js";
import { appendEntry, readStock } from "../src/ledger.js";
import { synchronizeBoms } from "../src/bom-sync.js";
import { activeBomYaml, CATALOG, fakeConfigRepo, RUN } from "./support/boms.js";
import {
  freshSchema,
  dropSchema,
  integration,
  type TestSchema,
} from "./support/database.js";
integration("BigCommerce lifecycle", () => {
  let target: TestSchema;
  const yaml = (qty = 2) => activeBomYaml([{ part: "vendor-a:part-001", qty }]);
  const sync = async (qty = 2) =>
    synchronizeBoms(
      target.db,
      fakeConfigRepo({ [`c${qty}`]: { "product-9001.yaml": yaml(qty) } }),
      CATALOG,
      RUN,
      {},
    );
  const line = (
    overrides: Partial<OrderLineSnapshot> = {},
  ): OrderLineSnapshot => ({
    orderId: "900",
    lineId: "1",
    catalogKey: "product-9001",
    options: [],
    ordered: 4,
    shipped: 0,
    refunded: 0,
    cancelled: false,
    observedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
  const apply = (overrides: Partial<OrderLineSnapshot> = {}, dry = false) =>
    applyOrderLine(target.db, line(overrides), RUN, dry);
  const stock = async () => (await readStock(target.db))[0]!;
  beforeEach(async () => {
    target = await freshSchema();
    await appendEntry(target.db, {
      part: {
        kind: "vendor",
        vendor: "vendor-a",
        vendorPartNumber: "part-001",
        ref: "vendor-a:part-001",
      },
      quantity: 20,
      reference: "opening",
      entryType: "receipt",
      createMissingPart: true,
      provenance: { source: "test" },
      createdBy: "test",
    });
    await sync();
    const policy=await target.db.query<any>('SELECT settings,revision FROM operational_settings');
    await executeNative(target.db,{type:'user',id:'reviewer',companyId:RUN.companyId},'save_settings',{revision:String(policy[0].revision),reason:'Synthetic automatic refund policy',settings:{...policy[0].settings,approvalMode:'threshold',absoluteThreshold:1000,percentThreshold:1000}});
  });
  afterEach(async () => { vi.unstubAllGlobals(); await dropSchema(target); });
  it("reserves once and subtracts commitments from sellable", async () => {
    await apply();
    expect(await apply()).toEqual({ duplicate: true });
    expect(await stock()).toMatchObject({ onHand: 20, committed: 8 });
    expect(
      await target.db.transaction((c) => sellableInTransaction(c)),
    ).toMatchObject([{ quantity: 6 }]);
  });
  it("consumes partial shipments once and reverses shipped refunds", async () => {
    await apply();
    const shipped = { shipped: 2, observedAt: "2026-01-02T00:00:00Z" };
    await apply(shipped);
    await apply(shipped);
    expect(await stock()).toMatchObject({ onHand: 16, committed: 4 });
    await apply({
      ...shipped,
      refunded: 1,
      observedAt: "2026-01-03T00:00:00Z",
    });
    expect(await stock()).toMatchObject({ onHand: 18, committed: 4 });
    await apply({
      ...shipped,
      refunded: 4,
      observedAt: "2026-01-04T00:00:00Z",
    });
    expect(await stock()).toMatchObject({ onHand: 20, committed: 0 });
  });
  it("holds refunds under the default approval policy and retries after authenticated approval", async()=>{
    const rows=await target.db.query<any>('SELECT settings,revision FROM operational_settings');
    await executeNative(target.db,{type:'user',id:'reviewer',companyId:RUN.companyId},'save_settings',{revision:String(rows[0].revision),reason:'Require human review',settings:{...rows[0].settings,approvalMode:'all'}});
    await apply({shipped:2,observedAt:'2026-01-02T00:00:00Z'});
    const snapshot={shipped:2,refunded:1,observedAt:'2026-01-03T00:00:00Z'};
    const pending=await apply(snapshot);expect(pending).toMatchObject({pendingApproval:true,status:'pending'});
    expect(await stock()).toMatchObject({onHand:16});
    await executeNative(target.db,{type:'user',id:'reviewer',companyId:RUN.companyId},'approve_count',{countId:(pending as any).countId,reason:'Returned parts verified'});
    await apply(snapshot);expect(await stock()).toMatchObject({onHand:18});
    expect(await apply(snapshot)).toEqual({duplicate:true});
  });
  it("refreshes a rejected stale refund with audited human authorization and credits once", async()=>{
    const human={type:'user' as const,id:'reviewer',companyId:RUN.companyId};
    const rows=await target.db.query<any>('SELECT settings,revision FROM operational_settings');
    await executeNative(target.db,human,'save_settings',{revision:String(rows[0].revision),reason:'Require review',settings:{...rows[0].settings,approvalMode:'all'}});
    await apply({shipped:2,observedAt:'2026-01-02T00:00:00Z'});
    const observation={shipped:2,refunded:1,observedAt:'2026-01-03T00:00:00Z'};
    const first=await apply(observation) as any;
    const part=(await stock()).partId;
    await appendEntry(target.db,{part:{kind:'id',id:part},entryType:'receipt',quantity:1,reference:'later',createdBy:'test',provenance:{source:'test'}});
    await expect(executeNative(target.db,human,'approve_count',{countId:first.countId,reason:'Reviewed'})).rejects.toThrow(/Stale/);
    await executeNative(target.db,human,'reject_count',{countId:first.countId,reason:'Stock moved; refresh'});
    expect(await apply(observation)).toMatchObject({status:'rejected'});
    await expect(executeNative(target.db,{type:'agent',id:'agent',companyId:RUN.companyId},'refresh_refund_count',{countId:first.countId,reason:'Refresh'})).rejects.toThrow(/human/);
    const policy=await target.db.query<any>('SELECT settings,revision FROM operational_settings');
    await executeNative(target.db,human,'save_settings',{revision:String(policy[0].revision),reason:'Allow routine adjustments',settings:{...policy[0].settings,approvalMode:'threshold',absoluteThreshold:1000,percentThreshold:1000}});
    const refreshed=await executeNative(target.db,human,'refresh_refund_count',{countId:first.countId,reason:'Recheck returned parts'});
    expect(refreshed).toMatchObject({status:'pending',duplicate:false});expect(refreshed.countId).not.toBe(first.countId);
    expect(await executeNative(target.db,human,'refresh_refund_count',{countId:first.countId,reason:'Retry'})).toMatchObject({countId:refreshed.countId,duplicate:true});
    expect(await apply(observation)).toMatchObject({countId:refreshed.countId,status:'pending'});
    await expect(executeNative(target.db,human,'approve_count',{countId:refreshed.countId,reason:'Self approval'})).rejects.toThrow(/own count/);
    await executeNative(target.db,{...human,id:'second-reviewer'},'approve_count',{countId:refreshed.countId,reason:'Verified fresh proposal'});
    await apply(observation);expect(await stock()).toMatchObject({onHand:19});
    expect(await apply(observation)).toEqual({duplicate:true});
    const audit=await target.db.query<any>("SELECT * FROM operational_audit WHERE operation='refresh_refund_count'");
    expect(audit).toHaveLength(1);expect(audit[0].actor.id).toBe(human.id);expect(audit[0].after_value.countId).toBe(refreshed.countId);
  });
  it("releases cancellations and ignores older placed snapshots", async () => {
    await apply({ cancelled: true, observedAt: "2026-01-02T00:00:00Z" });
    expect(await apply()).toEqual({ stale: true });
    expect(await stock()).toMatchObject({ onHand: 20, committed: 0 });
  });
  it.each([5, 6])("preserves live-status commitments until terminal status %i", async (terminal) => {
    const binding = { type: "secret_ref", secretId: "synthetic-secret" };
    const ctx = {
      config: { get: async () => ({ bigcommerceStoreHash: "example", bigcommerceToken: binding, bigcommerceBridgeToken: binding }) },
      secrets: { resolve: async () => "synthetic-token" },
    } as unknown as PluginContext;
    const api = await bigcommerceClient(ctx, "company");
    for (const [index, status_id] of [11, 7, 8, 9, terminal].entries()) {
      const order = { id: 900, status_id, date_modified: `2026-01-0${index + 1}T00:00:00Z` };
      const product = { id: 1, product_id: 9001, type: "physical", quantity: 4, quantity_shipped: 0, quantity_refunded: 0 };
      const response = (data: unknown) => new Response(JSON.stringify(data));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response([order])).mockResolvedValueOnce(response([product])).mockResolvedValueOnce(response(order)));
      const { snapshots } = await api.orders("2026-01-01");
      await applyOrderLine(target.db, snapshots[0]!, RUN);
      expect(await stock()).toMatchObject({ onHand: 20, committed: status_id === terminal ? 0 : 8 });
    }
  });
  it("pins expansion across BOM updates", async () => {
    await apply();
    await sync(3);
    await apply({ shipped: 4, observedAt: "2026-01-02T00:00:00Z" });
    expect(await stock()).toMatchObject({ onHand: 12, committed: 0 });
  });
  it("concurrent duplicate shipments consume once", async () => {
    await Promise.all([apply({ shipped: 4 }), apply({ shipped: 4 })]);
    expect(await stock()).toMatchObject({ onHand: 12, committed: 0 });
  });
  it("rejects changed identity and conflicting snapshots without changing stock", async () => {
    await apply();
    await expect(
      apply({ ordered: 5, observedAt: "2026-01-02T00:00:00Z" }),
    ).rejects.toThrow("changed");
    await expect(apply({ ordered: 5 })).rejects.toThrow("changed");
    expect(await stock()).toMatchObject({ onHand: 20, committed: 8 });
  });
  it("accepts same-second shipment, refund and cancellation progress with retries", async () => {
    await apply();
    await apply({ shipped: 2 });
    expect(await stock()).toMatchObject({ onHand: 16, committed: 4 });
    expect(await apply({ shipped: 2 })).toEqual({ duplicate: true });
    expect(await apply()).toEqual({ stale: true });
    await apply({ shipped: 2, refunded: 1 });
    expect(await stock()).toMatchObject({ onHand: 18, committed: 4 });
    expect(await apply({ shipped: 2 })).toEqual({ stale: true });
    await apply({ shipped: 2, refunded: 1, cancelled: true });
    expect(await stock()).toMatchObject({ onHand: 20, committed: 0 });
    expect(await apply({ shipped: 2, refunded: 1 })).toEqual({ stale: true });
    expect(await apply({ shipped: 2, refunded: 1, cancelled: true })).toEqual({ duplicate: true });
    expect(await target.db.query("SELECT * FROM ledger_entries WHERE entry_type = 'sale'")).toHaveLength(1);
  });
  it("ignores dominated same-second observations received in reverse order", async () => {
    await apply({ shipped: 4, refunded: 2 });
    for (const observation of [{ shipped: 2, refunded: 1 }, { shipped: 4 }, {}])
      expect(await apply(observation)).toEqual({ stale: true });
    expect(await stock()).toMatchObject({ onHand: 16, committed: 0 });
  });
  it("rejects incomparable same-second counters and terminal-state regressions", async () => {
    await apply({ shipped: 2, refunded: 1 });
    await expect(apply({ shipped: 3 })).rejects.toThrow("Conflicting");
    await expect(apply({ shipped: 1, refunded: 2 })).rejects.toThrow("Conflicting");
    await apply({ shipped: 2, refunded: 1, cancelled: true });
    await expect(apply({ shipped: 3, refunded: 1 })).rejects.toThrow("Conflicting");
    await expect(apply({ shipped: 2, refunded: 1, observedAt: "2026-01-02T00:00:00Z" })).rejects.toThrow("regressed");
    expect(await stock()).toMatchObject({ onHand: 20, committed: 0 });
  });
  it("preview leaves no reservation, snapshot, or movement", async () => {
    await apply({ shipped: 2 }, true);
    expect(
      await target.db.query("SELECT * FROM bigcommerce_lines"),
    ).toHaveLength(0);
    expect(await stock()).toMatchObject({ onHand: 20, committed: 0 });
  });
  it("insufficient shipment stock rolls back all movements and reservations", async () => {
    await expect(apply({ ordered: 11, shipped: 11 })).rejects.toThrow();
    expect(await stock()).toMatchObject({ onHand: 20, committed: 0 });
    expect(
      await target.db.query("SELECT * FROM bigcommerce_lines"),
    ).toHaveLength(0);
  });
  it("adds shared base and option quantities, and publishes conservative stock", async () => {
    const extra =
      "options:\n  - bigcommerce_option: Choice\n    option_value: Yes\n    lines:\n      - part: vendor-a:part-001\n        qty: 3\n        customer_description: Extra\n  - bigcommerce_option: Choice\n    option_value: No\n    lines: []";
    const catalog = {
      ...CATALOG,
      lookup: () => ({
        productId: 9001,
        name: "Example",
        options: new Map([["Choice", new Set(["Yes", "No"])]]),
      }),
    };
    await synchronizeBoms(
      target.db,
      fakeConfigRepo({
        option: {
          "product-9001.yaml": activeBomYaml(
            [{ part: "vendor-a:part-001", qty: 2 }],
            { extra },
          ),
        },
      }),
      catalog,
      RUN,
      {},
    );
    expect(
      await target.db.transaction((c) => sellableInTransaction(c)),
    ).toMatchObject([{ quantity: 4 }]);
    await apply({ ordered: 1, options: [{ option: "Choice", value: "Yes" }] });
    expect(await stock()).toMatchObject({ committed: 5 });
    await expect(apply({ lineId: "2", options: [] })).rejects.toThrow(
      "options",
    );
  });
  it("failed stock pushes remain pending and retry the latest absolute quantity", async () => {
    await expect(
      flushStock(target.db, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(
      (await target.db.query("SELECT * FROM bigcommerce_stock_dirty")).length,
    ).toBeGreaterThan(0);
    await apply();
    const pushed: number[] = [];
    await flushStock(target.db, async (_key, quantity) => {
      pushed.push(quantity);
    });
    expect(pushed).toEqual([6]);
    expect(
      await target.db.query("SELECT * FROM bigcommerce_stock_dirty"),
    ).toHaveLength(0);
    expect(
      await flushStock(target.db, async () => {
        throw new Error("must not push");
      }),
    ).toEqual({ pushed: 0 });
  });
  it("a mutation during a stock push remains pending for another push", async () => {
    await flushStock(target.db, async () => {
      await apply();
    });
    expect(
      (await target.db.query("SELECT * FROM bigcommerce_stock_dirty")).length,
    ).toBeGreaterThan(0);
    const pushed: number[] = [];
    await flushStock(target.db, async (_key, q) => {
      pushed.push(q);
    });
    expect(pushed).toEqual([6]);
  });
  it("uses scaled arithmetic for fractional part quantities", async () => {
    await sync(0.1);
    const count=await executeNative(target.db,{type:'agent',id:RUN.agentId,companyId:RUN.companyId},'adjust',{partId:'vendor-a:part-001',quantityDelta:-19.7,reference:'count',reason:'Synthetic fractional count'});
    await executeNative(target.db,{type:'user',id:'reviewer',companyId:RUN.companyId},'approve_count',{countId:count.countId,reason:'Verified'});
    expect(
      await target.db.transaction((c) => sellableInTransaction(c)),
    ).toMatchObject([{ quantity: 3 }]);
  });
});
