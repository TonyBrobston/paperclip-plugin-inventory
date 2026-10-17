/**
 * The BigCommerce catalog, read-only, for the two checks only the store can
 * answer: does this catalog key name something that can be sold, and does that
 * product really have this option value.
 *
 * `SPEC.md` requires it — "every SKU must exist in BigCommerce. Fail loudly
 * otherwise" — and it is the half of the acceptance criteria a part lookup
 * cannot cover. A BOM attached to a key the store does not have consumes
 * nothing on every sale, and nothing about the ledger looks wrong while it
 * happens.
 *
 * Deliberately only reads. Reservations, sales events and the sellable-quantity
 * push are the phase 6 bridge; what is here is an index of products, variant
 * SKUs and option values, fetched once per sync.
 */

import type { EnvSecretRefBinding, PluginContext } from "@paperclipai/plugin-sdk";
import { ConfigError, isSecretRefBinding } from "./config.js";
import { CONFIG_KEYS, SETTINGS_PATH } from "./constants.js";
import { OperatorFacingError } from "./errors.js";
import type { CatalogKeyKind } from "./bom.js";

export class CatalogError extends OperatorFacingError {}

const STORE_HASH = /^[a-z0-9]{5,30}$/;
const PAGE_SIZE = 250;
const MAX_PAGES = 40;
const TIMEOUT_MS = 30_000;

export interface CatalogSettings {
  storeHash: string;
  token: EnvSecretRefBinding;
}

export function parseCatalogSettings(config: Record<string, unknown>): CatalogSettings {
  const storeHash = config[CONFIG_KEYS.bigcommerceStoreHash];
  if (typeof storeHash !== "string" || !STORE_HASH.test(storeHash)) {
    throw new ConfigError(
      `Set the BigCommerce store hash in ${SETTINGS_PATH}. A BOM is only accepted once its catalog key is known to the store, so syncing cannot skip this check.`,
    );
  }
  if (!isSecretRefBinding(config[CONFIG_KEYS.bigcommerceToken])) {
    throw new ConfigError(
      "Select a Paperclip secret holding a BigCommerce API token with read access to products. The plugin only reads the catalog with it.",
    );
  }
  return { storeHash, token: config[CONFIG_KEYS.bigcommerceToken] as EnvSecretRefBinding };
}

export interface CatalogProduct {
  productId: number;
  name: string;
  /** Option display name → the value labels the storefront offers. */
  options: Map<string, Set<string>>;
}

export interface CatalogIndex {
  /** The product a catalog key names, or undefined if the store has no such thing. */
  lookup(key: string, kind: CatalogKeyKind): CatalogProduct | undefined;
  productCount: number;
  variantSkuCount: number;
}

interface RawProduct {
  id: number;
  name?: string;
  sku?: string;
  variants?: { sku?: string }[];
  options?: { display_name?: string; option_values?: { label?: string }[] }[];
}

/**
 * Build the index from a page-by-page read of the catalog.
 *
 * Variants and options are asked for in the same request rather than per
 * product: a second round trip per product is the difference between a sync
 * that takes a second and one that takes a minute, and the catalog is small.
 */
export function indexProducts(products: readonly RawProduct[]): CatalogIndex {
  const byProductKey = new Map<string, CatalogProduct>();
  const bySku = new Map<string, CatalogProduct>();
  let variantSkuCount = 0;

  for (const raw of products) {
    const options = new Map<string, Set<string>>();
    for (const option of raw.options ?? []) {
      const name = option.display_name;
      if (typeof name !== "string" || name === "") continue;
      const values = options.get(name) ?? new Set<string>();
      for (const value of option.option_values ?? []) {
        if (typeof value.label === "string" && value.label !== "") values.add(value.label);
      }
      options.set(name, values);
    }
    const product: CatalogProduct = { productId: raw.id, name: raw.name ?? "", options };
    byProductKey.set(`product-${raw.id}`, product);
    // A product-level SKU is legal and simply empty in this store; a variant
    // SKU is where the real ones live. Both resolve to the same product.
    for (const sku of [raw.sku, ...(raw.variants ?? []).map((variant) => variant.sku)]) {
      if (typeof sku !== "string" || sku.trim() === "") continue;
      bySku.set(sku.trim().toLowerCase(), product);
      variantSkuCount += 1;
    }
  }

  return {
    productCount: byProductKey.size,
    variantSkuCount,
    lookup(key, kind) {
      return kind === "product_id"
        ? byProductKey.get(key)
        : bySku.get(key.trim().toLowerCase());
    },
  };
}

/** Fetch and index every product. One call per sync. */
export async function readCatalog(
  ctx: PluginContext,
  companyId: string,
  settings: CatalogSettings,
): Promise<CatalogIndex> {
  const token = await ctx.secrets.resolve(settings.token, {
    companyId,
    configPath: CONFIG_KEYS.bigcommerceToken,
  });
  if (!token) throw new ConfigError("The configured BigCommerce token secret resolved to an empty value.");

  const products: RawProduct[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.bigcommerce.com/stores/${settings.storeHash}/v3/catalog/products?include=variants,options&limit=${PAGE_SIZE}&page=${page}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "X-Auth-Token": token, Accept: "application/json" },
    });
    if (!response.ok) {
      throw new CatalogError(
        `BigCommerce refused to list the catalog (HTTP ${response.status}). Check the store hash and token in ${SETTINGS_PATH}; nothing was imported.`,
      );
    }
    const body = (await response.json()) as {
      data?: RawProduct[];
      meta?: { pagination?: { total_pages?: number } };
    };
    products.push(...(body.data ?? []));
    if (page >= (body.meta?.pagination?.total_pages ?? 1)) break;
  }
  const index = indexProducts(products);
  ctx.logger.info("Read the BigCommerce catalog", {
    companyId,
    products: index.productCount,
    variantSkus: index.variantSkuCount,
  });
  return index;
}
