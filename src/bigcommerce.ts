import type { PluginContext } from "@paperclipai/plugin-sdk";
import { parseCatalogSettings } from "./catalog.js";
import { ConfigError, isSecretRefBinding } from "./config.js";
import { InputError, OperatorFacingError } from "./errors.js";
import type { OrderLineSnapshot } from "./bridge.js";

class BridgeApiError extends OperatorFacingError {}
export async function bigcommerceClient(ctx: PluginContext, companyId: string) {
  const config = await ctx.config.get(companyId);
  const settings = parseCatalogSettings(config);
  // Keep the Phase 5 read-only credential separate from stock-write authority.
  const binding = config.bigcommerceBridgeToken;
  if (!isSecretRefBinding(binding))
    throw new ConfigError(
      "Select a BigCommerce bridge token secret with Orders read and Products modify access.",
    );
  const token = await ctx.secrets.resolve(binding, {
    companyId,
    configPath: "bigcommerceBridgeToken",
  });
  if (!token) throw new ConfigError("BigCommerce bridge token is empty.");
  const base = `https://api.bigcommerce.com/stores/${settings.storeHash}`;
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<any> {
    const response = await fetch(base + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        "X-Auth-Token": token,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new BridgeApiError(
        `BigCommerce bridge request failed (HTTP ${response.status}); local progress is retained. Retry reconciliation.`,
      );
    if (response.status === 204) return [];
    return response.json();
  }
  async function pages(path: string, v3 = false): Promise<any[]> {
    const all: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const body = await request(
        `${path}${path.includes("?") ? "&" : "?"}limit=250&page=${page}`,
      );
      const rows = v3 ? body.data : body;
      if (!Array.isArray(rows))
        throw new BridgeApiError(
          "BigCommerce returned an invalid page; cursor unchanged.",
        );
      all.push(...rows);
      if (
        v3
          ? page >=
            Number(
              body.meta?.pagination?.total_pages ??
                (rows.length < 250 ? page : page + 1),
            )
          : rows.length < 250
      )
        return all;
    }
    throw new BridgeApiError(
      "BigCommerce pagination limit reached; narrow the reconciliation range. Cursor unchanged.",
    );
  }
  return {
    async orders(
      since: string,
    ): Promise<{ snapshots: OrderLineSnapshot[]; orderIds: string[] }> {
      const orders = await pages(
        `/v2/orders?min_date_modified=${encodeURIComponent(new Date(since).toISOString())}&sort=id:asc`,
      );
      const snapshots: OrderLineSnapshot[] = [];
      for (const order of orders) {
        // Incomplete checkouts are not placed orders. Do not pin a terminal
        // cancellation that would prevent their later completed checkout.
        if (order.status_id === 0) continue;
        if (!Number.isSafeInteger(order.id) || order.id <= 0)
          throw new BridgeApiError("Invalid order identity.");
        if (
          !Number.isInteger(order.status_id) ||
          order.status_id < 0 ||
          order.status_id > 14
        )
          throw new BridgeApiError("Unknown order status; cursor unchanged.");
        const lines = await pages(`/v2/orders/${order.id}/products`);
        const current = await request(`/v2/orders/${order.id}`);
        if (
          current.date_modified !== order.date_modified ||
          current.status_id !== order.status_id ||
          current.is_deleted !== order.is_deleted
        )
          throw new BridgeApiError(
            "An order changed while being read; retry reconciliation. Cursor unchanged.",
          );
        for (const line of lines) {
          if (line.type && line.type !== "physical") continue;
          if (
            !Number.isSafeInteger(line.id) ||
            !Number.isSafeInteger(line.product_id) ||
            line.product_id <= 0
          )
            throw new BridgeApiError(
              "Custom or invalid physical order line requires an explicit mapping.",
            );
          const sku = typeof line.sku === "string" ? line.sku.trim() : "";
          snapshots.push({
            orderId: String(order.id),
            lineId: String(line.id),
            catalogKey: sku || `product-${line.product_id}`,
            options: (line.product_options ?? []).map((o: any) => {
              if (
                typeof o.display_name !== "string" ||
                typeof o.display_value !== "string"
              )
                throw new BridgeApiError("Invalid order option labels.");
              return { option: o.display_name, value: o.display_value };
            }),
            ordered: line.quantity,
            shipped: line.quantity_shipped,
            refunded: line.quantity_refunded,
            cancelled:
              [5, 6].includes(order.status_id) ||
              order.is_deleted === true,
            observedAt: new Date(order.date_modified).toISOString(),
          });
        }
      }
      return { snapshots, orderIds: orders.map((o) => String(o.id)) };
    },
    async push(key: string, quantity: number) {
      if (/^product-[0-9]+$/.test(key)) {
        const id = key.slice(8);
        const result = await request(`/v3/catalog/products/${id}`);
        if (result.data?.inventory_tracking !== "product")
          throw new InputError(
            `Catalog key ${key} requires product inventory tracking before stock can be pushed.`,
          );
        await request(`/v3/catalog/products/${id}`, "PUT", {
          inventory_level: quantity,
        });
      } else {
        const variants = await pages(
          `/v3/catalog/variants?sku=${encodeURIComponent(key)}`,
          true,
        );
        const matches = variants.filter((v) => v.sku === key);
        if (matches.length !== 1)
          throw new InputError(
            `Catalog key ${key} must resolve to exactly one variant.`,
          );
        const v = matches[0];
        const product = await request(`/v3/catalog/products/${v.product_id}`);
        if (product.data?.inventory_tracking !== "variant")
          throw new InputError(
            `Catalog key ${key} requires variant inventory tracking before stock can be pushed.`,
          );
        await request(
          `/v3/catalog/products/${v.product_id}/variants/${v.id}`,
          "PUT",
          { inventory_level: quantity },
        );
      }
    },
  };
}
