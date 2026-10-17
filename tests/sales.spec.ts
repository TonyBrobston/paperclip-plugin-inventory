/**
 * `record_sale`: a sale expanded through the BOM version active at the time.
 *
 * The history claim is the one worth proving against a real database — that a
 * BOM edited after a sale does not change what that sale consumed — and it is
 * only provable with the sync, the version numbers and the ledger all present.
 */

import { afterEach, beforeEach, expect, it } from "vitest";
import { synchronizeBoms } from "../src/bom-sync.js";
import { appendEntry, readEntries, readStock } from "../src/ledger.js";
import { expandSale } from "../src/sales.js";
import { activeBomYaml, CATALOG, fakeConfigRepo, RUN } from "./support/boms.js";
import { dropSchema, freshSchema, integration, type TestSchema } from "./support/database.js";

integration("record_sale", () => {
  let target: TestSchema;

  const stock = async (vendorPartNumber: string, quantity: number) => {
    await appendEntry(target.db, {
      part: { kind: "vendor", vendor: "vendor-a", vendorPartNumber, ref: `vendor-a:${vendorPartNumber}` },
      entryType: "receipt",
      quantity,
      reference: `opening-${vendorPartNumber}`,
      createMissingPart: true,
      provenance: { source: "test" },
      createdBy: "test",
    });
  };

  const sync = (files: Record<string, string>, commit = "commit1") =>
    synchronizeBoms(target.db, fakeConfigRepo({ [commit]: files }), CATALOG, RUN, { commit });

  const KIT = {
    "product-9001.yaml": activeBomYaml([
      { part: "vendor-a:part-001", qty: 8, description: "Countersunk screws" },
      { part: "vendor-a:part-002", qty: 1, description: "Shelf bracket" },
    ]),
  };

  const sell = (overrides: Partial<Parameters<typeof expandSale>[1]> = {}) =>
    expandSale(target.db, {
      catalogKey: "product-9001",
      qty: 1,
      reference: "bc-order-1:line-1",
      selections: [],
      run: RUN,
      ...overrides,
    });

  beforeEach(async () => {
    target = await freshSchema();
    await stock("part-001", 100);
    await stock("part-002", 10);
  });

  afterEach(async () => {
    await dropSchema(target);
  });

  it("consumes every line, multiplied by the quantity sold", async () => {
    await sync(KIT);
    const result = await sell({ qty: 2 });

    expect(result.bomVersion).toBe(1);
    expect(result.lines).toEqual([
      expect.objectContaining({ partRef: "vendor-a:part-001", quantityConsumed: 16, onHand: 84 }),
      expect.objectContaining({ partRef: "vendor-a:part-002", quantityConsumed: 2, onHand: 8 }),
    ]);
  });

  it("records the same sale twice as one sale", async () => {
    await sync(KIT);
    await sell();
    const repeat = await sell();
    expect(repeat.duplicate).toBe(true);
    const [part] = await readStock(target.db, {
      kind: "vendor",
      vendor: "vendor-a",
      vendorPartNumber: "part-001",
      ref: "vendor-a:part-001",
    });
    expect(part?.onHand).toBe(92);
  });

  it("keeps what a sale consumed when the BOM changes afterwards", async () => {
    await sync(KIT);
    await sell();
    await sync(
      {
        "product-9001.yaml": activeBomYaml([
          { part: "vendor-a:part-001", qty: 20, description: "Countersunk screws" },
          { part: "vendor-a:part-002", qty: 1, description: "Shelf bracket" },
        ]),
      },
      "commit2",
    );

    const second = await sell({ reference: "bc-order-2:line-1" });
    expect(second.bomVersion).toBe(2);
    expect(second.lines[0]?.quantityConsumed).toBe(20);

    // The first sale's entry still says 8, and still names the version it
    // expanded against.
    const entries = await readEntries(target.db, second.lines[0]!.partId);
    const first = entries.find((entry) => entry.reference === "bc-order-1:line-1")!;
    expect(first.quantityDelta).toBe(-8);
    const provenance = await target.db.query<{ provenance: Record<string, unknown> }>(
      "SELECT provenance FROM ledger_entries WHERE id = $1",
      [first.id],
    );
    expect(provenance[0]?.provenance).toMatchObject({ bomVersion: 1, catalogKey: "product-9001" });
  });

  it("refuses the same reference once the BOM expands to different parts", async () => {
    await sync(KIT);
    await sell();
    await stock("part-003", 5);
    await sync(
      {
        "product-9001.yaml": activeBomYaml([
          { part: "vendor-a:part-001", qty: 8, description: "Countersunk screws" },
          { part: "vendor-a:part-002", qty: 1, description: "Shelf bracket" },
          { part: "vendor-a:part-003", qty: 1, description: "Switch plate" },
        ]),
      },
      "commit2",
    );
    await expect(sell()).rejects.toThrow(/already recorded against a different set of parts/);
  });

  it("adds an option's lines only when that value was chosen", async () => {
    const optioned = `${activeBomYaml([{ part: "vendor-a:part-001", qty: 1 }], { key: "KIT-9002-IN" })}
options:
  - bigcommerce_option: "Which switch type do you have?"
    option_value: "Rocker"
    lines:
      - part: vendor-a:part-002
        qty: 2
        customer_description: "Rocker switch plate"
  - bigcommerce_option: "Which switch type do you have?"
    option_value: "None"
    lines: []
`;
    await sync({ "KIT-9002-IN.yaml": optioned });

    const withRocker = await sell({
      catalogKey: "KIT-9002-IN",
      selections: [{ option: "Which switch type do you have?", value: "Rocker" }],
    });
    expect(withRocker.lines.map((line) => line.partRef)).toEqual([
      "vendor-a:part-001",
      "vendor-a:part-002",
    ]);

    const withNone = await sell({
      catalogKey: "KIT-9002-IN",
      reference: "bc-order-2:line-1",
      selections: [{ option: "Which switch type do you have?", value: "None" }],
    });
    expect(withNone.lines).toHaveLength(1);
  });

  it("refuses an option value the BOM has no answer for", async () => {
    await sync({
      "KIT-9002-IN.yaml": `${activeBomYaml([{ part: "vendor-a:part-001", qty: 1 }], { key: "KIT-9002-IN" })}
options:
  - bigcommerce_option: "Which switch type do you have?"
    option_value: "Rocker"
    lines:
      - part: vendor-a:part-002
        qty: 1
        customer_description: "Rocker switch plate"
`,
    });
    await expect(
      sell({
        catalogKey: "KIT-9002-IN",
        selections: [{ option: "Which switch type do you have?", value: "Stock" }],
      }),
    ).rejects.toThrow(/no answer for "Which switch type do you have\?: Stock"/);
    // Nothing was consumed: the refusal is the whole transaction.
    const [part] = await readStock(target.db, {
      kind: "vendor",
      vendor: "vendor-a",
      vendorPartNumber: "part-001",
      ref: "vendor-a:part-001",
    });
    expect(part?.onHand).toBe(100);
  });

  it("reports an option with no parts behind it instead of refusing the sale", async () => {
    await sync(KIT);
    const result = await sell({ selections: [{ option: "Engraving", value: "Yes" }] });
    expect(result.ignoredOptions).toEqual([{ option: "Engraving", value: "Yes" }]);
    expect(result.lines).toHaveLength(2);
  });

  it("says so when the product has no BOM at all", async () => {
    await expect(sell()).rejects.toThrow(/No BOM is active for product-9001/);
  });

  it("refuses a sale that would overdraw stock, and consumes none of it", async () => {
    await sync(KIT);
    await expect(sell({ qty: 20 })).rejects.toThrow(/on-hand cannot go negative/);
    const [bracket] = await readStock(target.db, {
      kind: "vendor",
      vendor: "vendor-a",
      vendorPartNumber: "part-002",
      ref: "vendor-a:part-002",
    });
    expect(bracket?.onHand).toBe(10);
  });
});
