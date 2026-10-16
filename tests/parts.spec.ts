/**
 * How a caller names a part.
 *
 * The rules decide whether an unknown part is created or refused, so getting
 * them wrong means either silently inventing parts from typos or being unable
 * to enter an opening balance at all.
 */

import { describe, expect, it } from "vitest";
import { InputError } from "../src/errors.js";
import { formatPartRef, parsePartRef } from "../src/parts.js";

describe("parsePartRef", () => {
  it("reads a vendor-qualified reference", () => {
    expect(parsePartRef("vendor-a:part-001")).toEqual({
      kind: "vendor",
      vendor: "vendor-a",
      vendorPartNumber: "part-001",
      ref: "vendor-a:part-001",
    });
  });

  it("lowercases the vendor but keeps the part number as the vendor prints it", () => {
    // Several vendors print part numbers with capitals in them. Echoing one
    // back in a different case makes an operator doubt whether they are
    // looking at the same part. (Synthetic number: this repository is public
    // and carries no real vendor part numbers.)
    const parsed = parsePartRef("  Vendor-A : PART-00A1 ");
    expect(parsed).toMatchObject({ vendor: "vendor-a", vendorPartNumber: "PART-00A1" });
  });

  it("splits on the first colon only", () => {
    // Some vendors put colons in their own part numbers; the vendor key never
    // has one, so the first colon is always the separator.
    expect(parsePartRef("vendor-a:part:001:x")).toMatchObject({
      vendor: "vendor-a",
      vendorPartNumber: "part:001:x",
    });
  });

  it("reads an internal id", () => {
    const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    expect(parsePartRef(id)).toEqual({ kind: "id", id });
    expect(parsePartRef(id.toUpperCase())).toEqual({ kind: "id", id });
  });

  it("refuses anything that is neither", () => {
    for (const bad of ["", "   ", "part-001", "mcmaster:", ":part-001", "::"]) {
      expect(() => parsePartRef(bad), JSON.stringify(bad)).toThrow(InputError);
    }
  });

  it("refuses a non-string", () => {
    for (const bad of [undefined, null, 7, {}, [], true]) {
      expect(() => parsePartRef(bad), JSON.stringify(bad)).toThrow(InputError);
    }
  });

  it("refuses a vendor key that is not a key", () => {
    // These would each become a separate "vendor" and silently split one
    // vendor's parts across several.
    for (const bad of ["vendor a:p1", "vendor/a:p1", "vendor'a:p1", "-vendor:p1", "véndor:p1"]) {
      expect(() => parsePartRef(bad), bad).toThrow(/not a usable vendor key/);
    }
  });

  it("refuses a part number that is really a description", () => {
    expect(() => parsePartRef(`vendor-a:${"x".repeat(129)}`)).toThrow(/at most 128/);
    expect(parsePartRef(`vendor-a:${"x".repeat(128)}`).kind).toBe("vendor");
  });

  it("refuses control characters in a part number", () => {
    expect(() => parsePartRef("vendor-a:part\u0000001")).toThrow(/control characters/);
    expect(() => parsePartRef("vendor-a:part\n001")).toThrow(/control characters/);
  });

  it("produces a reference that parses back to itself", () => {
    const parsed = parsePartRef("Vendor-B:PART-002");
    if (parsed.kind !== "vendor") throw new Error("expected a vendor-qualified reference");
    const round = parsePartRef(formatPartRef(parsed.vendor, parsed.vendorPartNumber));
    expect(round).toEqual(parsed);
  });
});
