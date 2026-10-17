import { afterEach, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { bigcommerceClient } from "../src/bigcommerce.js";
const binding = { type: "secret_ref", secretId: "synthetic-secret" };
const ctx = {
  config: { get: async () => ({ bigcommerceStoreHash: "example", bigcommerceToken: binding, bigcommerceBridgeToken: binding }) },
  secrets: { resolve: async () => "synthetic-token" },
} as unknown as PluginContext;
const order = { id: 900, status_id: 11, date_modified: "2026-01-02T00:00:00Z", is_deleted: false };
const line = { id: 1, product_id: 9001, type: "physical", sku: "", quantity: 4, quantity_shipped: 2, quantity_refunded: 1, product_options: [{ display_name: "Choice", display_value: "Yes" }] };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
afterEach(() => vi.unstubAllGlobals());
it("maps physical order counters and options without retaining customer data", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response([order])).mockResolvedValueOnce(response([line])).mockResolvedValueOnce(response(order));
  vi.stubGlobal("fetch", fetcher);
  const api = await bigcommerceClient(ctx, "company");
  expect(await api.orders("2026-01-01T00:00:00Z")).toEqual({ orderIds: ["900"], snapshots: [{ orderId: "900", lineId: "1", catalogKey: "product-9001", options: [{ option: "Choice", value: "Yes" }], ordered: 4, shipped: 2, refunded: 1, cancelled: false, observedAt: new Date(order.date_modified).toISOString() }] });
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "error", headers: { "X-Auth-Token": "synthetic-token" } });
});
it("does not pin an incomplete checkout as a cancelled order", async () => {
  const fetcher = vi.fn().mockResolvedValue(response([{ ...order, status_id: 0 }]));
  vi.stubGlobal("fetch", fetcher);
  expect((await (await bigcommerceClient(ctx, "company")).orders("2026-01-01")).snapshots).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("refuses an order that changes while its lines are read", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response([order])).mockResolvedValueOnce(response([line])).mockResolvedValueOnce(response({ ...order, is_deleted: true })));
  await expect((await bigcommerceClient(ctx, "company")).orders("2026-01-01")).rejects.toThrow("changed");
});
it("does not expose API response content on HTTP failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ private: "never-return-this" }, 429)));
  await expect((await bigcommerceClient(ctx, "company")).orders("2026-01-01")).rejects.toThrow("HTTP 429");
});
it("pushes absolute product stock only with product inventory tracking", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ data: { inventory_tracking: "product" } })).mockResolvedValueOnce(response({ data: {} }));
  vi.stubGlobal("fetch", fetcher);
  await (await bigcommerceClient(ctx, "company")).push("product-9001", 6);
  expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: "PUT", body: '{"inventory_level":6}' });
});
it("refuses stock writes to a product without inventory tracking", async () => {
  const fetcher = vi.fn().mockResolvedValue(response({ data: { inventory_tracking: "none" } }));
  vi.stubGlobal("fetch", fetcher);
  await expect((await bigcommerceClient(ctx, "company")).push("product-9001", 6)).rejects.toThrow("tracking");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("resolves SKU stock writes to exactly one tracked variant", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response({ data: [{ id: 2, product_id: 9001, sku: "EXAMPLE" }], meta: { pagination: { total_pages: 1 } } })).mockResolvedValueOnce(response({ data: { inventory_tracking: "variant" } })).mockResolvedValueOnce(response({ data: {} }));
  vi.stubGlobal("fetch", fetcher);
  await (await bigcommerceClient(ctx, "company")).push("EXAMPLE", 3);
  expect(fetcher.mock.calls[2]![0]).toContain("/products/9001/variants/2");
  expect(fetcher.mock.calls[2]![1]).toMatchObject({ method: "PUT", body: '{"inventory_level":3}' });
});
