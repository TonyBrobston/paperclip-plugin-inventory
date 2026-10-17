/**
 * What the generator is allowed to write into the public documentation
 * repository, and everything it refuses.
 *
 * The acceptance criterion for this half of the phase is negative — the public
 * output contains no private references and no vendor identifiers — so most of
 * these tests assert that a write did *not* happen.
 */

import { describe, expect, it } from "vitest";
import { parseBom, type BomFile } from "../src/bom.js";
import {
  generateIncludedList,
  INCLUDED_ANCHOR,
  NOT_INCLUDED_ANCHOR,
  publicTextProblems,
  renderLine,
} from "../src/install-docs.js";

/** The structure every install document has, with synthetic contents. */
const DOCUMENT = `Do you have questions? Email us.

# Example Kit Install Instructions

### Tools Needed:

- Drill
- T30 Torx bit

![0-tools.jpg](./example-kit-images/0-tools.jpg)

${INCLUDED_ANCHOR}

- 2x - Old bracket
- 6x - Old screws

![00-brackets-and-fasteners.jpg](./example-kit-images/00-brackets-and-fasteners.jpg)

${NOT_INCLUDED_ANCHOR}

- A microwave
- A 120v outlet

## Installation:

1. Fit the bracket.
`;

const BOM = `
catalog_key: product-9001
status: active
install_document: install-instructions/Example-Kit-Install-Instructions.MD
lines:
  - part: vendor-a:part-002
    qty: 1
    customer_description: "Shelf bracket"
  - part: vendor-a:part-001
    qty: 8
    customer_description: "Countersunk screws (for the shelf)"
options:
  - bigcommerce_option: "Which switch type do you have?"
    option_value: "Rocker"
    lines:
      - part: vendor-b:part-010
        qty: 1
        customer_description: "Rocker switch plate"
`;

function bomOf(text = BOM): BomFile {
  const { bom, problems } = parseBom("product-9001.yaml", text);
  expect(problems).toEqual([]);
  return bom!;
}

describe("generating the included list", () => {
  it("replaces only the bullets under the anchor", () => {
    const { markdown, unchanged } = generateIncludedList(DOCUMENT, bomOf());
    expect(unchanged).toBe(false);
    expect(markdown).toContain("- 1x - Shelf bracket\n- 8x - Countersunk screws (for the shelf)");
    expect(markdown).not.toContain("Old bracket");
    // Everything around it survives: the heading, the photo, the steps, and in
    // particular the list of things the customer supplies.
    expect(markdown).toContain("![00-brackets-and-fasteners.jpg](./example-kit-images/00-brackets-and-fasteners.jpg)");
    expect(markdown).toContain(`${NOT_INCLUDED_ANCHOR}\n\n- A microwave\n- A 120v outlet`);
    expect(markdown).toContain("- Drill\n- T30 Torx bit");
    expect(markdown).toContain("1. Fit the bracket.");
  });

  it("leaves option-only lines out of the public list", () => {
    // They are not in every kit, and the documents say so in their own words.
    expect(generateIncludedList(DOCUMENT, bomOf()).markdown).not.toContain("Rocker switch plate");
  });

  it("reports an unchanged document rather than rewriting it", () => {
    const first = generateIncludedList(DOCUMENT, bomOf()).markdown;
    expect(generateIncludedList(first, bomOf()).unchanged).toBe(true);
  });

  it("writes the quantity in the format the documents already use", () => {
    expect(renderLine({ qty: 8, customerDescription: "Countersunk screws" })).toBe(
      "- 8x - Countersunk screws",
    );
  });

  it("inserts a list where the document has a heading and no bullets yet", () => {
    const withoutList = DOCUMENT.replace("- 2x - Old bracket\n- 6x - Old screws\n", "");
    expect(generateIncludedList(withoutList, bomOf()).markdown).toContain("- 1x - Shelf bracket");
  });
});

describe("refusals", () => {
  const refuse = (document: string, bom: BomFile = bomOf()) => () => generateIncludedList(document, bom);

  it("refuses a document with no anchor", () => {
    expect(refuse(DOCUMENT.replace(INCLUDED_ANCHOR, "### Kit contents:"))).toThrow(/no "###/);
  });

  it("refuses a document with two anchors, because which list is not guessable", () => {
    expect(refuse(`${DOCUMENT}\n${INCLUDED_ANCHOR}\n\n- 1x - Something\n`)).toThrow(/2 "###/);
  });

  it("refuses a draft BOM", () => {
    const draft = parseBom(
      "product-9002.yaml",
      `
catalog_key: product-9002
status: draft
install_document: install-instructions/Example-Kit-Install-Instructions.MD
lines:
  - qty: 4
    customer_description: "Cap head screws"
    pending: ["part unresolved"]
`,
    ).bom!;
    expect(refuse(DOCUMENT, draft)).toThrow(/draft/);
  });

  it("refuses a BOM with nothing unconditional to publish", () => {
    const optionsOnly = parseBom(
      "product-9003.yaml",
      `
catalog_key: product-9003
status: active
lines:
  - part: vendor-a:part-001
    qty: 1
    customer_description: "Base part"
`,
    ).bom!;
    optionsOnly.lines[0]!.optionName = "Which switch type do you have?";
    optionsOnly.lines[0]!.optionValue = "Rocker";
    expect(refuse(DOCUMENT, optionsOnly)).toThrow(/no unconditional lines/);
  });

  it("refuses to publish a vendor name or a part number", () => {
    for (const description of [
      "McMaster screws",
      "Screws, mcmaster-carr 99999Z999",
      "Screws (vendor-a:part-001)",
      "Part 99999Z999",
    ]) {
      expect(publicTextProblems(description), description).not.toEqual([]);
      const leaky = bomOf(BOM.replace('"Shelf bracket"', JSON.stringify(description)));
      expect(refuse(DOCUMENT, leaky)).toThrow(/Refusing to write/);
    }
  });

  it("publishes the specifications a customer actually needs", () => {
    // The refusal has to be narrow enough to be usable: these are
    // measurements, not identifiers, and every real document is full of them.
    for (const description of [
      "M6 x 25mm cap head allen bolts",
      "10mm ball studs 5/16-18 x 1/2",
      "Self tapping countersunk head screws (for shelf)",
      "6 inch L-Track",
      "1x 3/8 in. spacer",
    ]) {
      expect(publicTextProblems(description), description).toEqual([]);
    }
  });
});
