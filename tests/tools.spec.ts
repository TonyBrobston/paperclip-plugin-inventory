/**
 * The declared tool surface against the one `SPEC.md` names.
 *
 * The spec's tool list is a contract with the agent and with the skill that
 * will drive it in phase 7. Renaming `get_stock` is a breaking change to
 * something written down, so it should take a deliberate edit here rather
 * than a quiet one in `src/tools.ts`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_DECLARATIONS, TOOL_NAMES } from "../src/tools.js";

/** Exactly the tools under "Plugin tools exposed to agents" in SPEC.md. */
const SPEC_TOOLS = [
  "submit_order_email",
  "record_receipt",
  "record_adjustment",
  "record_sale",
  "list_review_queue",
  "resolve_review_item",
  "get_stock",
  "get_sellable",
  "sync_sheet",
  "sync_boms",
  "reconcile_bigcommerce",
];

describe("tool declarations", () => {
  it("covers the spec's tool list, with nothing extra", () => {
    expect([...TOOL_NAMES].sort()).toEqual([...SPEC_TOOLS].sort());
  });

  it("still matches the committed SPEC.md", () => {
    // Guards against the list above drifting from the document it transcribes.
    const spec = readFileSync(path.join(import.meta.dirname, "..", "SPEC.md"), "utf8");
    for (const name of SPEC_TOOLS) {
      expect(spec, `SPEC.md no longer mentions ${name}`).toContain(name);
    }
  });

  it("gives every tool a unique name", () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it("gives every tool an object parameter schema", () => {
    // The host passes tool arguments as an object and the MCP client requires
    // an object schema to describe them.
    for (const tool of TOOL_DECLARATIONS) {
      expect(tool.parametersSchema.type, tool.name).toBe("object");
      expect(tool.parametersSchema.properties, tool.name).toBeTypeOf("object");
    }
  });

  it("describes every tool in terms of what it does to inventory", () => {
    // The description is the only thing an agent reads before choosing a
    // tool. A one-word description is how the wrong tool gets called.
    for (const tool of TOOL_DECLARATIONS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.displayName.length, tool.name).toBeGreaterThan(0);
    }
  });

  it("assigns every tool to a phase that exists", () => {
    for (const tool of TOOL_DECLARATIONS) {
      expect([2, 3, 4, 5, 6], tool.name).toContain(tool.phase);
    }
  });

  it("requires the fields a call is meaningless without", () => {
    const required = (name: string) =>
      (TOOL_DECLARATIONS.find((tool) => tool.name === name)!.parametersSchema
        .required ?? []) as string[];

    // Provenance is an invariant in SPEC.md: every entry stores where it came
    // from. These are the parameters that carry it.
    expect(required("submit_order_email")).toContain("messageId");
    expect(required("submit_order_email")).toContain("agentExtraction");
    // Idempotency keys. Without them a retry double-counts.
    expect(required("record_receipt")).toContain("reference");
    // `delivery` refines that key rather than replacing it, so a split
    // delivery is representable without a second order number.
    expect(required("record_receipt")).not.toContain("delivery");
    expect(required("record_sale")).toContain("reference");
    // An adjustment is the one entry with no document behind it.
    expect(required("record_adjustment")).toContain("reason");
  });

  it("leaves read-only tools callable with no arguments", () => {
    for (const name of ["get_stock", "get_sellable", "list_review_queue"]) {
      const tool = TOOL_DECLARATIONS.find((entry) => entry.name === name)!;
      expect(tool.parametersSchema.required ?? [], name).toEqual([]);
    }
  });
});
