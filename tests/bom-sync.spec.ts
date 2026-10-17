/**
 * `sync_boms` against a real schema.
 *
 * The phase's acceptance criteria are all here: an invalid part or catalog key
 * is rejected, nothing is imported when anything fails, and a historical
 * version does not move when the file changes.
 */

import { afterEach, beforeEach, expect, it } from "vitest";
import { synchronizeBoms, lastSyncedCommit } from "../src/bom-sync.js";
import { dropSchema, freshSchema, exec, insertPart, integration, type TestSchema } from "./support/database.js";
import { activeBomYaml, CATALOG, fakeConfigRepo, RUN } from "./support/boms.js";

integration("sync_boms", () => {
  let target: TestSchema;

  beforeEach(async () => {
    target = await freshSchema();
    await insertPart(target, "vendor-a", "part-001");
    await insertPart(target, "vendor-a", "part-002");
    await insertPart(target, "vendor-b", "part-010");
  });

  afterEach(async () => {
    await dropSchema(target);
  });

  const sync = (files: Record<string, string>, options: { dryRun?: boolean; commit?: string } = {}) =>
    synchronizeBoms(target.db, fakeConfigRepo({ commit1: files }), CATALOG, RUN, {
      commit: options.commit ?? "commit1",
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    });

  const ONE_PART = {
    "product-9001.yaml": activeBomYaml([{ part: "vendor-a:part-001", qty: 8 }]),
  };

  it("imports an active BOM as version 1 and records where it came from", async () => {
    const report = await sync(ONE_PART);
    expect(report.imported).toEqual([
      expect.objectContaining({ catalogKey: "product-9001", version: 1, lines: 1 }),
    ]);

    const rows = await exec(target, "SELECT * FROM boms");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      catalog_key: "product-9001",
      catalog_key_kind: "product_id",
      version: 1,
      source_commit: "commit1",
      source_path: "bom/product-9001.yaml",
    });
    expect(await lastSyncedCommit(target.db)).toBe("commit1");

    const lines = await exec(target, "SELECT quantity_per_unit, customer_description FROM bom_lines");
    expect(lines[0]).toMatchObject({ quantity_per_unit: "8.0000" });
  });

  it("imports nothing twice for the same content, whatever the file looks like", async () => {
    await sync(ONE_PART);
    const reformatted = {
      "product-9001.yaml": `# a comment somebody added\n${ONE_PART["product-9001.yaml"]}\n`,
    };
    const second = await sync(reformatted);
    expect(second.imported).toEqual([]);
    expect(second.unchanged).toEqual(["product-9001"]);
    expect(await exec(target, "SELECT id FROM boms")).toHaveLength(1);
  });

  it("records a changed quantity as a new version and leaves the old one alone", async () => {
    await sync(ONE_PART);
    const report = await sync({
      "product-9001.yaml": activeBomYaml([{ part: "vendor-a:part-001", qty: 9 }]),
    });
    expect(report.imported[0]).toMatchObject({ version: 2 });

    const versions = await exec(
      target,
      "SELECT b.version, l.quantity_per_unit FROM boms b JOIN bom_lines l ON l.bom_id = b.id ORDER BY b.version",
    );
    // The point of the version number: the first row still says 8.
    expect(versions).toEqual([
      expect.objectContaining({ version: 1, quantity_per_unit: "8.0000" }),
      expect.objectContaining({ version: 2, quantity_per_unit: "9.0000" }),
    ]);
  });

  it("refuses to update or delete a version that already exists", async () => {
    await sync(ONE_PART);
    await expect(exec(target, "UPDATE boms SET version = 7")).rejects.toThrow(/immutable/);
    await expect(exec(target, "DELETE FROM bom_lines")).rejects.toThrow(/immutable/);
  });

  it("imports nothing when one file out of several is invalid", async () => {
    await expect(
      sync({
        ...ONE_PART,
        "product-9002.yaml": "catalog_key: product-9002\nstatus: active\nlines: []\n",
      }),
    ).rejects.toThrow(/must list at least one line/);
    expect(await exec(target, "SELECT id FROM boms")).toHaveLength(0);
  });

  it("rejects a part this inventory has never heard of", async () => {
    await expect(sync({ "product-9001.yaml": activeBomYaml([{ part: "vendor-a:part-404", qty: 1 }]) }))
      .rejects.toThrow(/no part vendor-a:part-404/);
    expect(await exec(target, "SELECT id FROM boms")).toHaveLength(0);
  });

  it("rejects a catalog key the store does not have", async () => {
    await expect(
      sync({
        "product-9404.yaml": activeBomYaml([{ part: "vendor-a:part-001", qty: 1 }], { key: "product-9404" }),
      }),
    ).rejects.toThrow(/BigCommerce has no product product-9404/);
  });

  it("rejects an option value the store does not offer", async () => {
    const yaml = `${activeBomYaml([{ part: "vendor-a:part-001", qty: 1 }], { key: "KIT-9002-IN" })}
options:
  - bigcommerce_option: "Which switch type do you have?"
    option_value: "Toggle"
    lines:
      - part: vendor-b:part-010
        qty: 1
        customer_description: "Toggle plate"
`;
    await expect(sync({ "KIT-9002-IN.yaml": yaml })).rejects.toThrow(/no value "Toggle"/);
  });

  it("accepts an option value that exists, including one that consumes nothing", async () => {
    const yaml = `${activeBomYaml([{ part: "vendor-a:part-001", qty: 1 }], { key: "KIT-9002-IN" })}
options:
  - bigcommerce_option: "Which switch type do you have?"
    option_value: "Rocker"
    lines:
      - part: vendor-b:part-010
        qty: 1
        customer_description: "Rocker switch plate"
  - bigcommerce_option: "Which switch type do you have?"
    option_value: "None"
    lines: []
`;
    const report = await sync({ "KIT-9002-IN.yaml": yaml });
    expect(report.imported[0]).toMatchObject({ catalogKey: "KIT-9002-IN", lines: 2 });
    const rows = await exec(target, "SELECT option_scopes FROM boms");
    expect(rows[0]?.option_scopes).toEqual([
      { option: "Which switch type do you have?", value: "Rocker" },
      { option: "Which switch type do you have?", value: "None" },
    ]);
  });

  it("warns in preview and sync when a deleted file leaves a live version", async () => {
    await sync(ONE_PART);
    for (const dryRun of [true, false]) {
      const report = await synchronizeBoms(target.db, fakeConfigRepo({ removed: {} }), CATALOG, RUN, {commit: "removed", dryRun});
      expect(report.warnings.join()).toMatch(/product-9001.*version 1 is still active/);
      expect(await exec(target, "SELECT id FROM boms")).toHaveLength(1);
    }
  });

  it("holds a draft rather than importing it", async () => {
    const report = await sync({
      "product-9001.yaml": `catalog_key: product-9001
status: draft
lines:
  - qty: 4
    customer_description: "Cap head screws (for the mount)"
    pending: ["part unresolved: two candidates, neither confirmed"]
`,
    });
    expect(report.held).toEqual([
      { catalogKey: "product-9001", pendingLines: 1, activeVersion: null },
    ]);
    expect(report.imported).toEqual([]);
    expect(await exec(target, "SELECT id FROM boms")).toHaveLength(0);
  });

  it("warns, rather than pretending, when a draft replaces an active BOM", async () => {
    await sync(ONE_PART);
    const report = await sync({
      "product-9001.yaml": `catalog_key: product-9001
status: draft
lines:
  - qty: 8
    customer_description: "Countersunk screws"
    pending: ["which part this is, is back under review"]
`,
    });
    expect(report.held[0]).toMatchObject({ activeVersion: 1 });
    expect(report.warnings.join(" ")).toMatch(/version 1 of product-9001 is already active/);
  });

  it("warns about a draft keyed on a product the store does not have", async () => {
    const report = await sync({
      "product-9404.yaml": `catalog_key: product-9404
status: draft
lines:
  - qty: 1
    customer_description: "Bracket"
    pending: ["part unresolved"]
`,
    });
    expect(report.warnings.join(" ")).toMatch(/BigCommerce has no product product-9404/);
    expect(report.held).toHaveLength(1);
  });

  it("previews without writing anything, cursor included", async () => {
    const report = await sync(ONE_PART, { dryRun: true });
    expect(report.imported[0]).toMatchObject({ version: 1 });
    expect(await exec(target, "SELECT id FROM boms")).toHaveLength(0);
    expect(await lastSyncedCommit(target.db)).toBeNull();
  });

  it("refuses two files that declare the same catalog key", async () => {
    await expect(
      sync({
        "product-9001.yaml": ONE_PART["product-9001.yaml"]!,
        "product-9001.yml": ONE_PART["product-9001.yaml"]!,
      }),
    ).rejects.toThrow(/is also declared by/);
  });
});
