/**
 * Reading this plugin's per-company settings, and refusing the bad ones.
 *
 * Kept apart from `worker.ts` so the rules are unit-testable without a host:
 * every check here is reachable from a plain function call.
 */

import type { EnvSecretRefBinding, PluginContext } from "@paperclipai/plugin-sdk";
import {
  CONFIG_KEYS,
  DEFAULT_DATABASE_SCHEMA,
  SCHEMA_NAME_PATTERN,
  SETTINGS_PATH,
  SUPPORTED_VENDORS,
  type SupportedVendor,
} from "./constants.js";

/** A configuration problem an operator can fix, phrased for the operator. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface InventorySettings {
  /** Unresolved. The value is fetched per call and never stored. */
  databaseUrlRef: EnvSecretRefBinding;
  databaseSchema: string;
  enabledVendors: SupportedVendor[];
}

const schemaNameRe = new RegExp(SCHEMA_NAME_PATTERN);

/**
 * A secret picker writes this object; a pasted string is not it.
 *
 * The host's binding parser accepts `version` as "latest" or a positive
 * integer and validates it itself, so this check deliberately ignores the
 * field rather than over-constraining a binding the form can legitimately
 * produce.
 */
export function isSecretRefBinding(value: unknown): value is EnvSecretRefBinding {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "secret_ref" &&
    typeof (value as { secretId?: unknown }).secretId === "string" &&
    (value as { secretId: string }).secretId.length > 0
  );
}

/**
 * Validate the schema name.
 *
 * A schema name is an identifier, so it cannot travel as a bind parameter and
 * has to be interpolated into SQL as text. Restricting it to unquoted-safe
 * characters is what makes that interpolation sound, and it also means the
 * quoted and unquoted spellings refer to the same schema — a mixed-case name
 * would not.
 */
export function parseDatabaseSchema(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_DATABASE_SCHEMA;
  }
  if (typeof value !== "string") {
    throw new ConfigError("The database schema must be text, or left blank.");
  }
  const trimmed = value.trim();
  if (!schemaNameRe.test(trimmed)) {
    throw new ConfigError(
      `"${trimmed}" is not a usable schema name. Use lowercase letters, digits and underscores, starting with a letter or underscore — for example ${DEFAULT_DATABASE_SCHEMA}.`,
    );
  }
  return trimmed;
}

/**
 * Validate the enabled-vendor list.
 *
 * An unknown vendor is refused rather than ignored: silently dropping it
 * would mean that company's orders fall through to "no parser for this
 * vendor" with nothing to explain why, long after the typo was made.
 */
export function parseEnabledVendors(value: unknown): SupportedVendor[] {
  if (value === undefined || value === null) return [...SUPPORTED_VENDORS];
  if (!Array.isArray(value)) {
    throw new ConfigError("Enabled vendors must be a list.");
  }
  const unknown = value.filter(
    (entry) => !SUPPORTED_VENDORS.includes(entry as SupportedVendor),
  );
  if (unknown.length > 0) {
    throw new ConfigError(
      `No parser ships for ${unknown.join(", ")}. Supported vendors are ${SUPPORTED_VENDORS.join(", ")}.`,
    );
  }
  return value as SupportedVendor[];
}

/** Read and validate one company's settings. */
export function parseSettings(config: Record<string, unknown>): InventorySettings {
  const databaseUrlRef = config[CONFIG_KEYS.databaseUrl];
  if (!isSecretRefBinding(databaseUrlRef)) {
    throw new ConfigError(
      `This plugin has no database connection configured. Save a PostgreSQL connection string as a Paperclip secret and pick it in ${SETTINGS_PATH}.`,
    );
  }
  return {
    databaseUrlRef,
    databaseSchema: parseDatabaseSchema(config[CONFIG_KEYS.databaseSchema]),
    enabledVendors: parseEnabledVendors(config[CONFIG_KEYS.enabledVendors]),
  };
}

/**
 * Read one company's settings and resolve the connection string.
 *
 * Resolved on every call rather than cached. A single worker process serves
 * every company that installs this plugin, so a cached credential becomes the
 * wrong credential as soon as a second company configures it, and a secret
 * rotated in Paperclip would not take effect until a restart.
 */
export async function resolveConnection(
  ctx: PluginContext,
  companyId: string,
): Promise<{ connectionString: string; settings: InventorySettings }> {
  const settings = parseSettings(await ctx.config.get(companyId));
  const connectionString = await ctx.secrets.resolve(settings.databaseUrlRef, {
    companyId,
    configPath: CONFIG_KEYS.databaseUrl,
  });
  if (!connectionString) {
    throw new ConfigError(
      "The configured database connection secret resolved to an empty value.",
    );
  }
  return { connectionString, settings };
}
