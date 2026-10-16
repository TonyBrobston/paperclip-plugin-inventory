/**
 * The JSON/`numeric(14,4)` boundary.
 *
 * Both directions are places where a wrong number arrives looking like a
 * right one, which is the failure a ledger is supposed to make impossible.
 */

import { describe, expect, it } from "vitest";
import { InputError } from "../src/errors.js";
import { parseQuantity, toNumber } from "../src/quantity.js";

describe("parseQuantity", () => {
  const positive = { label: "Quantity", positive: true } as const;
  const signed = { label: "The adjustment", nonZero: true } as const;

  it("accepts whole and fractional quantities within the column's scale", () => {
    for (const value of [1, 5, 0.5, 2.25, 1.0001, 9_999_999_999]) {
      expect(parseQuantity(value, positive), String(value)).toBe(value);
    }
  });

  it("accepts a negative adjustment", () => {
    expect(parseQuantity(-3, signed)).toBe(-3);
  });

  it("refuses a fifth decimal place rather than rounding it away", () => {
    // Rounding here is the quiet kind of wrong: the call succeeds, the number
    // is not the number, and nothing downstream can tell.
    expect(() => parseQuantity(1.00001, positive)).toThrow(/more than 4 decimal places/);
    expect(() => parseQuantity(-2.123456, signed)).toThrow(/more than 4 decimal places/);
  });

  it("refuses zero, whichever rule is in force", () => {
    expect(() => parseQuantity(0, positive)).toThrow(InputError);
    expect(() => parseQuantity(0, signed)).toThrow(/cannot be zero/);
  });

  it("refuses a negative quantity where only positive makes sense", () => {
    expect(() => parseQuantity(-1, positive)).toThrow(/greater than zero/);
  });

  it("refuses what is not a finite number", () => {
    for (const bad of [undefined, null, "5", NaN, Infinity, -Infinity, {}, []]) {
      expect(() => parseQuantity(bad, positive), JSON.stringify(bad)).toThrow(/must be a number/);
    }
  });

  it("refuses a magnitude the column cannot hold", () => {
    expect(() => parseQuantity(10_000_000_000, positive)).toThrow(/larger than/);
  });

  it("names the field it is complaining about", () => {
    expect(() => parseQuantity("x", { label: "The adjustment" })).toThrow(/^The adjustment/);
  });
});

describe("toNumber", () => {
  it("converts the strings pg returns for numeric", () => {
    // `pg` returns numeric as a string because not every numeric fits a
    // double. Leaving it a string would put "5.0000" in a tool result, and an
    // agent comparing that to 5 gets the wrong answer.
    expect(toNumber("5.0000")).toBe(5);
    expect(toNumber("-2.5000")).toBe(-2.5);
    expect(toNumber("0.0001")).toBe(0.0001);
  });

  it("treats absent as zero, because no rows and no stock are the same position", () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
  });

  it("passes a number through", () => {
    expect(toNumber(3)).toBe(3);
  });

  it("throws on something that is not a number at all", () => {
    expect(() => toNumber("not a number")).toThrow(/Expected a numeric value/);
  });
});
