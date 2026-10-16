/**
 * Config parsing, including the paths that exist to refuse something.
 *
 * These run without a host because every rule in `src/config.ts` is a plain
 * function — which is the reason they are plain functions.
 */

import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  ConfigError,
  isSecretRefBinding,
  parseDatabaseSchema,
  parseEnabledVendors,
  parseSettings,
  resolveConnection,
} from "../src/config.js";
import { CONFIG_KEYS, DEFAULT_DATABASE_SCHEMA, SUPPORTED_VENDORS } from "../src/constants.js";

const SECRET_REF = { type: "secret_ref" as const, secretId: "inventory-db" };
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

describe("isSecretRefBinding", () => {
  it("accepts what the secret picker writes", () => {
    expect(isSecretRefBinding(SECRET_REF)).toBe(true);
    expect(isSecretRefBinding({ ...SECRET_REF, version: "latest" })).toBe(true);
    expect(isSecretRefBinding({ ...SECRET_REF, version: 3 })).toBe(true);
  });

  it("rejects a raw string, which is how a password ends up in a config row", () => {
    expect(isSecretRefBinding("postgres://user:password@nas:5432/inventory")).toBe(false);
    expect(isSecretRefBinding({ type: "secret_ref", secretId: "" })).toBe(false);
    expect(isSecretRefBinding(null)).toBe(false);
    expect(isSecretRefBinding([SECRET_REF])).toBe(false);
  });
});

describe("parseDatabaseSchema", () => {
  it("defaults to inventory when left blank", () => {
    expect(parseDatabaseSchema(undefined)).toBe(DEFAULT_DATABASE_SCHEMA);
    expect(parseDatabaseSchema("")).toBe(DEFAULT_DATABASE_SCHEMA);
    expect(parseDatabaseSchema(null)).toBe(DEFAULT_DATABASE_SCHEMA);
  });

  it("accepts an ordinary identifier", () => {
    expect(parseDatabaseSchema("inventory")).toBe("inventory");
    expect(parseDatabaseSchema("  parts_inventory  ")).toBe("parts_inventory");
    expect(parseDatabaseSchema("_v2")).toBe("_v2");
  });

  it("refuses anything that would not survive being interpolated into SQL", () => {
    // The schema name is an identifier, so it cannot be a bind parameter.
    // This is the check that makes interpolating it sound.
    for (const bad of [
      "inventory; drop schema public cascade",
      'inventory"',
      "inventory schema",
      "1inventory",
      "Inventory",
      "inv-entory",
      "a".repeat(64),
    ]) {
      expect(() => parseDatabaseSchema(bad), bad).toThrow(ConfigError);
    }
  });

  it("refuses a non-string", () => {
    expect(() => parseDatabaseSchema(42)).toThrow(ConfigError);
  });
});

describe("parseEnabledVendors", () => {
  it("enables every shipped parser when unset", () => {
    expect(parseEnabledVendors(undefined)).toEqual([...SUPPORTED_VENDORS]);
  });

  it("accepts a subset", () => {
    expect(parseEnabledVendors(["mcmaster"])).toEqual(["mcmaster"]);
    expect(parseEnabledVendors([])).toEqual([]);
  });

  it("names the vendor it cannot enable, instead of dropping it", () => {
    // Silently ignoring a typo means that vendor's orders fail much later,
    // as "no parser for this vendor", with nothing pointing back here.
    expect(() => parseEnabledVendors(["mcmaster", "mcmastr"])).toThrow(/mcmastr/);
    expect(() => parseEnabledVendors("mcmaster")).toThrow(ConfigError);
  });
});

describe("parseSettings", () => {
  it("reads a complete config", () => {
    expect(
      parseSettings({
        [CONFIG_KEYS.databaseUrl]: SECRET_REF,
        [CONFIG_KEYS.databaseSchema]: "inventory",
        [CONFIG_KEYS.enabledVendors]: ["mcmaster", "sendcutsend"],
      }),
    ).toEqual({
      databaseUrlRef: SECRET_REF,
      databaseSchema: "inventory",
      enabledVendors: ["mcmaster", "sendcutsend"],
    });
  });

  it("tells an operator where to fix a missing connection", () => {
    expect(() => parseSettings({})).toThrow(/Settings → Plugins → Inventory/);
  });
});

describe("resolveConnection", () => {
  function contextWith(config: Record<string, unknown>, secret = "postgres://nas/inventory") {
    const resolve = vi.fn().mockResolvedValue(secret);
    const ctx = {
      config: { get: vi.fn().mockResolvedValue(config) },
      secrets: { resolve },
    } as unknown as PluginContext;
    return { ctx, resolve };
  }

  it("resolves the secret per call, so a rotation takes effect immediately", async () => {
    const { ctx, resolve } = contextWith({ [CONFIG_KEYS.databaseUrl]: SECRET_REF });
    await resolveConnection(ctx, COMPANY_ID);
    await resolveConnection(ctx, COMPANY_ID);
    // One worker process serves every company. A cached credential is the
    // wrong credential as soon as a second company configures the plugin.
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledWith(SECRET_REF, {
      companyId: COMPANY_ID,
      configPath: CONFIG_KEYS.databaseUrl,
    });
  });

  it("refuses a secret that resolved to nothing", async () => {
    const { ctx } = contextWith({ [CONFIG_KEYS.databaseUrl]: SECRET_REF }, "");
    await expect(resolveConnection(ctx, COMPANY_ID)).rejects.toThrow(ConfigError);
  });
});
