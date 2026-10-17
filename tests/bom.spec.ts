/**
 * The BOM file format's refusals.
 *
 * Every assertion here is a file somebody could plausibly write and a sale
 * that would then consume the wrong thing. The fixtures are synthetic: this
 * repository is public, so no real catalog key, vendor part number or kit
 * contents appear in it.
 */

import { describe, expect, it } from "vitest";
import { contentHash, parseBom, selectLines, type BomFile } from "../src/bom.js";

const VALID = `
catalog_key: product-9001
status: active
install_document: install-instructions/Example-Kit-Install-Instructions.MD
source_revision: 0123456789abcdef0123456789abcdef01234567
lines:
  - part: vendor-a:part-001
    qty: 8
    customer_description: "Countersunk screws (for the shelf)"
    source_line_id: example-kit:01
  - part: vendor-a:part-002
    qty: 1
    customer_description: "Shelf bracket"
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

function parse(text: string, fileName = "product-9001.yaml") {
  return parseBom(fileName, text);
}

describe("a valid BOM", () => {
  it("parses lines, option scopes and provenance", () => {
    const { bom, problems } = parse(VALID);
    expect(problems).toEqual([]);
    expect(bom?.catalogKey).toBe("product-9001");
    expect(bom?.catalogKeyKind).toBe("product_id");
    expect(bom?.status).toBe("active");
    expect(bom?.lines).toHaveLength(3);
    expect(bom?.lines[0]?.sourceLineId).toBe("example-kit:01");
    // The `None` value consumes nothing and is still declared, because at sale
    // time "no parts for this value" and "this value is missing" differ.
    expect(bom?.optionScopes).toEqual([
      { optionName: "Which switch type do you have?", optionValue: "Rocker" },
      { optionName: "Which switch type do you have?", optionValue: "None" },
    ]);
  });

  it("infers a variant SKU key from its shape", () => {
    const { bom, problems } = parse(VALID.replace("product-9001", "KIT-9001-IN"), "KIT-9001-IN.yaml");
    expect(problems).toEqual([]);
    expect(bom?.catalogKeyKind).toBe("variant_sku");
  });
});

describe("refusals", () => {
  const problemsOf = (text: string, fileName?: string) => parse(text, fileName).problems.join("\n");

  it("refuses a file whose name disagrees with its key", () => {
    expect(problemsOf(VALID, "product-9002.yaml")).toContain("does not match the file name");
  });

  it("refuses a key that is neither a SKU nor product-<id>", () => {
    expect(problemsOf(VALID.replace("product-9001", "a key with spaces"), "a key with spaces.yaml"))
      .toContain("neither a variant SKU nor product-<id>");
  });

  it("refuses a stated key kind that contradicts the key", () => {
    expect(problemsOf(`${VALID}\ncatalog_key_kind: variant_sku\n`)).toContain("catalog_key_kind says");
  });

  it("refuses a quantity that is not a positive number", () => {
    expect(problemsOf(VALID.replace("qty: 8", "qty: 0"))).toContain("must be a positive number");
    expect(problemsOf(VALID.replace("qty: 8", 'qty: "8"'))).toContain("must be a positive number");
    expect(problemsOf(VALID.replace("qty: 8", "qty: 0.00001"))).toContain("decimal places");
  });

  it("refuses a missing customer description, which is what a customer reads", () => {
    expect(problemsOf(VALID.replace('customer_description: "Shelf bracket"', "customer_description: \"\"")))
      .toContain("customer_description is required");
  });

  it("refuses the same part twice in one scope, and allows it across two option values", () => {
    expect(problemsOf(VALID.replace("vendor-a:part-002", "vendor-a:part-001")))
      .toContain("twice in the same option scope");

    const sharedAcrossValues = VALID.replace(
      `  - bigcommerce_option: "Which switch type do you have?"
    option_value: "None"
    lines: []`,
      `  - bigcommerce_option: "Which switch type do you have?"
    option_value: "Stock"
    lines:
      - part: vendor-b:part-010
        qty: 2
        customer_description: "Stock switch plate"`,
    );
    expect(parse(sharedAcrossValues).problems).toEqual([]);
  });

  it("refuses an option with no value, because a name cannot say which part", () => {
    expect(problemsOf(VALID.replace('    option_value: "Rocker"\n', ""))).toContain("option_value is required");
  });

  it("refuses a duplicated option value", () => {
    expect(problemsOf(VALID.replace('option_value: "None"', 'option_value: "Rocker"')))
      .toContain("repeats the option value");
  });

  it("refuses an install_document outside the documentation repository's folder", () => {
    expect(problemsOf(VALID.replace("install-instructions/Example-Kit-Install-Instructions.MD", "../../etc/passwd")))
      .toContain("is not an install-instructions/");
  });

  it("refuses YAML that is not YAML", () => {
    expect(problemsOf("catalog_key: [unclosed")).toContain("is not valid YAML");
  });

  it("refuses an empty base line list", () => {
    expect(problemsOf(VALID.replace(/lines:\n  - part: vendor-a:part-001[\s\S]*?options:/, "lines: []\noptions:")))
      .toContain("must list at least one line");
  });
});

describe("drafts", () => {
  const DRAFT = `
catalog_key: product-9002
status: draft
lines:
  - qty: 4
    customer_description: "Cap head screws (for the mount)"
    pending:
      - "part unresolved: two purchased candidates, neither confirmed"
`;

  it("accepts a line with no part when it says what is unresolved", () => {
    const { bom, problems } = parseBom("product-9002.yaml", DRAFT);
    expect(problems).toEqual([]);
    expect(bom?.status).toBe("draft");
    expect(bom?.lines[0]?.part).toBeUndefined();
    expect(bom?.lines[0]?.pending).toHaveLength(1);
  });

  it("accepts a documented line whose quantity is not written down anywhere", () => {
    // "Rubber with adhesive backing" names no length, area or unit. A zero
    // there would be a lie about what is in the kit.
    const { bom, problems } = parseBom(
      "product-9002.yaml",
      `
catalog_key: product-9002
status: draft
lines:
  - customer_description: "Rubber with adhesive backing"
    pending:
      - "quantity and unit of consumption are not in the document"
      - "part unresolved"
`,
    );
    expect(problems).toEqual([]);
    expect(bom?.lines[0]?.qty).toBeUndefined();
  });

  it("refuses a line with no quantity and no reason", () => {
    expect(
      parseBom(
        "product-9002.yaml",
        "catalog_key: product-9002\nstatus: active\nlines:\n  - part: vendor-a:part-001\n    customer_description: \"Bracket\"\n",
      ).problems.join("\n"),
    ).toContain("needs a qty, or a pending reason");
  });

  it("refuses a line with no part and no reason", () => {
    expect(parseBom("product-9002.yaml", DRAFT.replace(/    pending:[\s\S]*$/, "")).problems.join("\n"))
      .toContain("needs a part, or a pending reason");
  });

  it("refuses an active BOM that still has pending lines", () => {
    expect(parseBom("product-9002.yaml", DRAFT.replace("status: draft", "status: active")).problems.join("\n"))
      .toContain("cannot be active");
  });

  it("refuses a draft with nothing pending, which would stay inert unnoticed", () => {
    expect(parse(VALID.replace("status: active", "status: draft")).problems.join("\n"))
      .toContain("Set status: active");
  });
});

describe("content hash", () => {
  const bomOf = (text: string): BomFile => {
    const { bom, problems } = parse(text);
    expect(problems).toEqual([]);
    return bom!;
  };

  it("ignores formatting, comments and line order", () => {
    const reordered = VALID.replace(
      `  - part: vendor-a:part-001
    qty: 8
    customer_description: "Countersunk screws (for the shelf)"
    source_line_id: example-kit:01
  - part: vendor-a:part-002
    qty: 1
    customer_description: "Shelf bracket"`,
      `  # the bracket first this time
  - part: vendor-a:part-002
    qty: 1
    customer_description: "Shelf bracket"
  - part: vendor-a:part-001
    qty: 8
    customer_description: "Countersunk screws (for the shelf)"
    source_line_id: example-kit:01`,
    );
    expect(contentHash(bomOf(reordered))).toBe(contentHash(bomOf(VALID)));
  });

  it("changes when a quantity, a part or a description changes", () => {
    const base = contentHash(bomOf(VALID));
    expect(contentHash(bomOf(VALID.replace("qty: 8", "qty: 9")))).not.toBe(base);
    expect(contentHash(bomOf(VALID.replace("vendor-a:part-002", "vendor-a:part-003")))).not.toBe(base);
    expect(contentHash(bomOf(VALID.replace("Shelf bracket", "Shelf bracket, powder coated")))).not.toBe(base);
  });

  it("changes when an option value that consumes nothing is added", () => {
    const withoutNone = VALID.replace(
      `  - bigcommerce_option: "Which switch type do you have?"
    option_value: "None"
    lines: []`,
      "",
    );
    expect(contentHash(bomOf(withoutNone))).not.toBe(contentHash(bomOf(VALID)));
  });
});

describe("selecting the lines one sale consumes", () => {
  const bom = parse(VALID).bom!;

  it("reports missing declared options when no option is selected", () => {
    const { lines, unmatched, ignored, missing } = selectLines(bom, []);
    expect(missing).toEqual(["Which switch type do you have?"]);
    expect(lines.map((line) => line.part)).toEqual(["vendor-a:part-001", "vendor-a:part-002"]);
    expect(unmatched).toEqual([]);
    expect(ignored).toEqual([]);
  });

  it("adds the selected option's lines", () => {
    const { lines } = selectLines(bom, [{ option: "Which switch type do you have?", value: "Rocker" }]);
    expect(lines.map((line) => line.part)).toContain("vendor-b:part-010");
  });

  it("consumes nothing extra for a declared value with no lines", () => {
    const { lines, unmatched } = selectLines(bom, [
      { option: "Which switch type do you have?", value: "None" },
    ]);
    expect(lines).toHaveLength(2);
    expect(unmatched).toEqual([]);
  });

  it("reports a value the BOM has never heard of, rather than under-consuming", () => {
    const { unmatched } = selectLines(bom, [
      { option: "Which switch type do you have?", value: "Toggle" },
    ]);
    expect(unmatched).toEqual([{ option: "Which switch type do you have?", value: "Toggle" }]);
  });

  it("ignores an option the BOM does not mention at all", () => {
    const { unmatched, ignored } = selectLines(bom, [{ option: "Engraving", value: "Yes" }]);
    expect(unmatched).toEqual([]);
    expect(ignored).toEqual([{ option: "Engraving", value: "Yes" }]);
  });
});


describe("unresolved inclusion and document containment", () => {
  it.each(["install-instructions/../../outside.MD", "install-instructions/sub/file.MD", "install-instructions/..\\outside.MD"])("refuses %s", (target) => {
    expect(parse(VALID.replace("install-instructions/Example-Kit-Install-Instructions.MD", target)).problems.length).toBeGreaterThan(0);
  });
  it("holds unresolved inclusion separately even when parts and quantities are known", () => {
    const yaml = VALID + `
unresolved_lines:
  - part: vendor-a:part-099
    qty: 1
    customer_description: Conditional bracket
`;
    expect(parse(yaml).problems.join()).toContain("no confirmed inclusion rule");
    const draft = parse(yaml.replace("status: active", "status: draft"));
    expect(draft.problems).toEqual([]);
    expect(selectLines(draft.bom!, []).lines.map(l => l.part)).not.toContain("vendor-a:part-099");
  });
  it("reports conflicting values for a declared option", () => {
    expect(selectLines(parse(VALID).bom!, [{option: "Which switch type do you have?", value: "Rocker"}, {option: "Which switch type do you have?", value: "None"}]).conflicting).toEqual(["Which switch type do you have?"]);
  });
});
