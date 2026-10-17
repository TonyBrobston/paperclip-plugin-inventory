/**
 * The worker, driven through the SDK's in-memory host harness.
 *
 * `createTestHarness` is the same context shape the real host passes, with
 * capability checks seeded from the manifest, so a tool that works here is
 * wired correctly — registration, result shape and error policy included.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { IMPLEMENTED_TOOLS, structured } from "../src/worker.js";
import { TOOL_DECLARATIONS } from "../src/tools.js";
import { CONFIG_KEYS } from "../src/constants.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

async function harnessWithPlugin(config: Record<string, unknown> = {}): Promise<TestHarness> {
  const harness = createTestHarness({ manifest, config });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

describe("tool registration", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await harnessWithPlugin();
  });

  it("registers every tool the spec names", async () => {
    // Registered, not merely declared: a declared tool with no handler is a
    // tool an agent can see and cannot call.
    for (const declaration of TOOL_DECLARATIONS) {
      await expect(
        harness.executeTool(declaration.name, {}, { companyId: COMPANY_ID }),
      ).resolves.toBeTruthy();
    }
  });

  it("says which phase an unimplemented tool is waiting on", async () => {
    const result = await harness.executeTool<{ error?: string }>(
      "record_sale",
      {},
      { companyId: COMPANY_ID },
    );
    // A tool that is not built yet should read as "not built yet" rather than
    // as a crash, so an agent stops instead of retrying.
    expect(result.error).toContain("phase 5");
  });

  it("keeps IMPLEMENTED_TOOLS honest about which tools have a handler", async () => {
    // Two things read that list — the readiness log and `scripts/smoke.mjs` —
    // and both would quietly describe the wrong build if a later phase wired
    // a handler without updating it. This config is empty, so an implemented
    // tool fails on configuration and an unimplemented one names its phase;
    // the difference is what makes the two distinguishable here.
    for (const declaration of TOOL_DECLARATIONS) {
      const result = await harness.executeTool<{ error?: string }>(
        declaration.name,
        {},
        { companyId: COMPANY_ID },
      );
      const saysPhase = /is not implemented yet/.test(result.error ?? "");
      const claimed = (IMPLEMENTED_TOOLS as readonly string[]).includes(declaration.name);
      expect(saysPhase, `${declaration.name} is listed as implemented but is not`).toBe(!claimed);
    }
  });

  it("lists every declared tool's phase as one still to come", () => {
    // The flip side: a phase number left behind on a tool that now works.
    for (const declaration of TOOL_DECLARATIONS) {
      if ((IMPLEMENTED_TOOLS as readonly string[]).includes(declaration.name)) {
        expect(declaration.phase, `${declaration.name} works, so its phase should be 2`).toBeLessThanOrEqual(3);
      } else {
        expect(declaration.phase).toBeGreaterThan(3);
      }
    }
  });
});

describe("tool result shape", () => {
  /**
   * The host forwards `data` as MCP `structuredContent` and the client
   * requires an object there. A non-object — including the `null` the host
   * sends for an absent `data` — makes the client discard the whole result,
   * `content` included, before the agent reads any of it.
   *
   * This is the defect that made every BigCommerce tool call fail. These
   * assertions are the guard against reintroducing it in a later phase.
   */
  it("returns an object in `data` from every tool, including the failures", async () => {
    const harness = await harnessWithPlugin();
    for (const declaration of TOOL_DECLARATIONS) {
      const result = await harness.executeTool<{ data?: unknown }>(
        declaration.name,
        {},
        { companyId: COMPANY_ID },
      );
      expect(result.data, `${declaration.name} returned a non-object data`).toBeTypeOf("object");
      expect(Array.isArray(result.data)).toBe(false);
      expect(result.data).not.toBeNull();
    }
  });

  it("carries an error message in `content` as well as `error`", async () => {
    const harness = await harnessWithPlugin();
    const result = await harness.executeTool<{ error?: string; content?: string }>(
      "get_stock",
      {},
      { companyId: COMPANY_ID },
    );
    // `error` alone travels in neither field the host forwards, so the
    // message would never reach the agent.
    expect(result.content).toBe(result.error);
  });

  it("wraps a non-object in `structured` rather than passing it through", () => {
    expect(structured(null)).toEqual({ value: null });
    expect(structured([1, 2])).toEqual({ value: [1, 2] });
    expect(structured("text")).toEqual({ value: "text" });
    expect(structured({ ok: true })).toEqual({ ok: true });
  });
});

describe("onValidateConfig", () => {
  const validate = plugin.definition.onValidateConfig!;

  it("refuses a connection string typed as plain text", async () => {
    const result = await validate({
      [CONFIG_KEYS.databaseUrl]: "postgres://user:password@nas:5432/inventory",
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toMatch(/secret/i);
  });

  it("refuses a schema name that is not an identifier", async () => {
    const result = await validate({
      [CONFIG_KEYS.databaseUrl]: { type: "secret_ref", secretId: "db" },
      [CONFIG_KEYS.databaseSchema]: "inventory; drop schema public cascade",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a vendor with no parser", async () => {
    const result = await validate({
      [CONFIG_KEYS.databaseUrl]: { type: "secret_ref", secretId: "db" },
      [CONFIG_KEYS.enabledVendors]: ["mcmaster", "grainger"],
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toContain("grainger");
  });

  it("accepts a well-formed config, and says what it did not check", async () => {
    const result = await validate({
      [CONFIG_KEYS.databaseUrl]: { type: "secret_ref", secretId: "db" },
    });
    expect(result.ok).toBe(true);
    // It cannot open the database — the host passes no company id, so the
    // secret cannot be resolved. Reporting a green "connected" it never
    // tested would be worse than saying so.
    expect(result.warnings?.join(" ")).toMatch(/does not open the database/i);
  });
});
