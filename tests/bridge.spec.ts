import { afterEach, beforeEach, expect, it } from "vitest";
import {
  applyOrderLine,
  flushStock,
  sellableInTransaction,
  type OrderLineSnapshot,
} from "../src/bridge.js";
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
  });
  afterEach(async () => dropSchema(target));
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
  it("releases cancellations and ignores older placed snapshots", async () => {
    await apply({ cancelled: true, observedAt: "2026-01-02T00:00:00Z" });
    expect(await apply()).toEqual({ stale: true });
    expect(await stock()).toMatchObject({ onHand: 20, committed: 0 });
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
    await expect(apply({ shipped: 1 })).rejects.toThrow("Conflicting");
    expect(await stock()).toMatchObject({ onHand: 20, committed: 8 });
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
    await appendEntry(target.db, {
      part: {
        kind: "vendor",
        vendor: "vendor-a",
        vendorPartNumber: "part-001",
        ref: "vendor-a:part-001",
      },
      quantity: -19.7,
      reference: "count",
      entryType: "adjustment",
      provenance: { source: "test" },
      createdBy: "test",
    });
    expect(
      await target.db.transaction((c) => sellableInTransaction(c)),
    ).toMatchObject([{ quantity: 3 }]);
  });
});
