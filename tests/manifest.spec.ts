/**
 * The manifest is the plugin's contract with the host, and the host validates
 * it with a Zod schema at install time. A manifest that fails there does not
 * produce a broken plugin — it produces no plugin at all, discovered by an
 * operator rather than by CI.
 *
 * So these assertions run the host's own validator, imported from
 * `@paperclipai/shared`, rather than a restatement of what it probably checks.
 */

import { describe, expect, it } from "vitest";
import { PLUGIN_CAPABILITIES, pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import { CONFIG_KEYS, PLUGIN_ID, SUPPORTED_VENDORS } from "../src/constants.js";
import { TOOL_DECLARATIONS } from "../src/tools.js";

describe("manifest", () => {
  it("passes the host's own manifest validator", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    // Surfacing the issues keeps a failure readable; a bare `.success` tells
    // you only that something is wrong.
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("declares only capabilities the host knows", () => {
    for (const capability of manifest.capabilities) {
      expect(PLUGIN_CAPABILITIES).toContain(capability);
    }
  });

  it("asks for tool registration, because every feature is a tool", () => {
    expect(manifest.capabilities).toContain("agent.tools.register");
  });

  it("asks for secret resolution, because the connection string is a secret ref", () => {
    expect(manifest.capabilities).toContain("secrets.read-ref");
  });

  it("does not ask for the host database namespace", () => {
    // The plugin owns its own PostgreSQL connection so the ledger can be
    // written in transactions — see docs/sdk-notes.md (c). Declaring these
    // would be claiming a namespace nothing uses, and would start host-run
    // migrations against a schema this plugin does not write to.
    for (const capability of manifest.capabilities) {
      expect(capability.startsWith("database.namespace.")).toBe(false);
    }
  });

  it("publishes every declared tool", () => {
    expect(manifest.tools?.map((tool) => tool.name)).toEqual(
      TOOL_DECLARATIONS.map((tool) => tool.name),
    );
  });

  it("keeps the plugin id stable", () => {
    // Tool names, the agent-facing MCP names and any saved per-company config
    // are all keyed on this. Changing it orphans all three.
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(PLUGIN_ID).toBe("tbro.inventory");
  });
});

describe("settings form", () => {
  const properties = manifest.instanceConfigSchema?.properties as Record<
    string,
    Record<string, unknown>
  >;

  it("requires the database connection and nothing else", () => {
    expect(manifest.instanceConfigSchema?.required).toEqual([CONFIG_KEYS.databaseUrl]);
  });

  it("renders the connection as a secret picker, typed as the object the picker writes", () => {
    const field = properties[CONFIG_KEYS.databaseUrl]!;
    expect(field.format).toBe("secret-ref");
    // Typed `string` here and the form saves nothing: the host runs Ajv over
    // this schema before it looks for secret bindings, so the binding object
    // the picker produces would be rejected as "must be string".
    expect(field.type).toBe("object");
    expect(field.required).toEqual(["type", "secretId"]);
  });

  it("leaves the secret binding's version unconstrained", () => {
    // The host accepts "latest" or a pinned integer and parses it itself.
    // Constraining it here is what makes a pinned binding unsaveable.
    const field = properties[CONFIG_KEYS.databaseUrl]!;
    const inner = field.properties as Record<string, unknown>;
    expect(inner.version).toBeUndefined();
  });

  it("constrains the schema name in the schema, where a save is actually checked", () => {
    // `onValidateConfig` runs only behind the Test Connection button, so a
    // rule that exists only there does not block a save.
    const pattern = properties[CONFIG_KEYS.databaseSchema]!.pattern as string;
    expect(new RegExp(pattern).test("inventory")).toBe(true);
    expect(new RegExp(pattern).test("public; drop schema public")).toBe(false);
    expect(new RegExp(pattern).test("Inventory")).toBe(false);
  });

  it("keeps operational and Google configuration out of host settings", () => {
    expect(properties).not.toHaveProperty("enabledVendors");
    expect(properties).not.toHaveProperty("spreadsheetId");
    expect(properties).not.toHaveProperty("googleServiceAccount");
  });
});
