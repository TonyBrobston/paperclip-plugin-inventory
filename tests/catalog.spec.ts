/**
 * Resolving a BOM's catalog key against the store.
 *
 * The index is the answer to the defect that reshaped this phase's schema:
 * every product-level SKU in the real catalog is empty, so a BOM keyed on a
 * SKU resolves to nothing and a sale of it consumes nothing. These fixtures
 * reproduce that shape with synthetic ids.
 */

import { describe, expect, it } from "vitest";
import { indexProducts, parseCatalogSettings } from "../src/catalog.js";
import { CONFIG_KEYS } from "../src/constants.js";

const PRODUCTS = [
  // The common case here: no SKU anywhere, so `product-<id>` is the only key.
  { id: 9001, name: "Example Kit", sku: "", variants: [{ sku: "" }], options: [] },
  {
    id: 9002,
    name: "Optioned Kit",
    sku: "",
    variants: [{ sku: "KIT-9002-IN" }, { sku: "KIT-9002-IW" }],
    options: [
      {
        display_name: "Which switch type do you have?",
        option_values: [{ label: "Stock" }, { label: "Rocker" }, { label: "None" }],
      },
    ],
  },
];

describe("the catalog index", () => {
  const index = indexProducts(PRODUCTS);

  it("resolves a product whose variants carry no SKU", () => {
    expect(index.lookup("product-9001", "product_id")?.productId).toBe(9001);
    expect(index.variantSkuCount).toBe(2);
  });

  it("resolves a variant SKU to its product, case-insensitively", () => {
    expect(index.lookup("KIT-9002-IN", "variant_sku")?.productId).toBe(9002);
    expect(index.lookup("kit-9002-in", "variant_sku")?.productId).toBe(9002);
  });

  it("does not resolve a key of the wrong kind", () => {
    expect(index.lookup("KIT-9002-IN", "product_id")).toBeUndefined();
    expect(index.lookup("product-9002", "variant_sku")).toBeUndefined();
  });

  it("knows nothing about a product the store does not have", () => {
    expect(index.lookup("product-9999", "product_id")).toBeUndefined();
  });

  it("carries each product's option values, which is what a BOM line is scoped to", () => {
    const values = index.lookup("product-9002", "product_id")!.options.get("Which switch type do you have?");
    expect([...values!]).toEqual(["Stock", "Rocker", "None"]);
  });
});

describe("catalog settings", () => {
  it("refuses to sync without a store to check against", () => {
    expect(() => parseCatalogSettings({})).toThrow(/store hash/);
    expect(() =>
      parseCatalogSettings({ [CONFIG_KEYS.bigcommerceStoreHash]: "not a hash!" }),
    ).toThrow(/store hash/);
  });

  it("requires the token as a secret ref rather than as config", () => {
    expect(() =>
      parseCatalogSettings({
        [CONFIG_KEYS.bigcommerceStoreHash]: "abc123def4",
        [CONFIG_KEYS.bigcommerceToken]: "a-token-pasted-as-text",
      }),
    ).toThrow(/Paperclip secret/);
  });

  it("accepts a store hash and a secret ref", () => {
    expect(
      parseCatalogSettings({
        [CONFIG_KEYS.bigcommerceStoreHash]: "abc123def4",
        [CONFIG_KEYS.bigcommerceToken]: { type: "secret_ref", secretId: "bc" },
      }).storeHash,
    ).toBe("abc123def4");
  });
});
