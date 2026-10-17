/**
 * Identifiers and config keys shared by the manifest and the worker.
 *
 * They live here rather than in either file because the manifest declares the
 * settings form and the worker reads what that form produced. When the two
 * disagree about a key name the failure is silent: the form saves green and
 * every tool call reports "not configured".
 */

/**
 * The plugin's stable identifier.
 *
 * `tbro` is the author namespace, the role an npm scope plays — not a
 * Brobston-specific setting. The host namespaces every tool as
 * `<pluginId>:<toolName>`, so `get_stock` reaches an agent as
 * `tbro.inventory:get_stock`.
 */
export const PLUGIN_ID = "tbro.inventory";

export const PLUGIN_VERSION = "0.1.0";

export const CONFIG_KEYS = {
  /**
   * Secret ref holding the PostgreSQL connection string.
   *
   * A ref rather than a string: the value carries a password, and a password
   * in plugin config is a password in a database row and in every settings
   * API response.
   */
  databaseUrl: "databaseUrl",
  /**
   * Schema the plugin owns inside that database.
   *
   * Configurable because this plugin is meant to be reusable: another
   * deployment may already have an `inventory` schema, or may want the tables
   * somewhere else entirely.
   */
  databaseSchema: "databaseSchema",
  /**
   * Vendors whose parsers are enabled for this company.
   *
   * Which vendors a business buys from is a deployment setting, so it comes
   * from config. The parser modules themselves ship with the plugin.
   */
  enabledVendors: "enabledVendors",
  /**
   * The private config repository holding `bom/`, as `owner/name`.
   *
   * Which repository is a deployment setting, so it comes from config rather
   * than from this code: the plugin is reusable and another business's BOMs
   * live somewhere else entirely.
   */
  configRepo: "configRepo",
  /** Branch to read BOMs from. Blank means the repository's default branch. */
  configRepoBranch: "configRepoBranch",
  /**
   * Secret ref holding a GitHub token with read access to that repository.
   *
   * A ref rather than a string for the same reason as the database URL: the
   * BOM files are private, and a token in plugin config is a token in a
   * database row and in every settings API response.
   */
  configRepoToken: "configRepoToken",
  /** BigCommerce store hash, used to resolve a BOM's catalog key. */
  bigcommerceStoreHash: "bigcommerceStoreHash",
  /** Secret ref holding a BigCommerce API token with product read access. */
  bigcommerceToken: "bigcommerceToken",
} as const;

/** Used when `databaseSchema` is left blank, which is the normal case. */
export const DEFAULT_DATABASE_SCHEMA = "inventory";

/**
 * A PostgreSQL identifier we are willing to interpolate into SQL.
 *
 * The schema name cannot be passed as a bind parameter — it is an identifier,
 * not a value — so it is the one piece of config that reaches SQL as text.
 * Unquoted lowercase letters, digits and underscores only, so that the
 * quoted and unquoted forms of the name are the same name.
 */
export const SCHEMA_NAME_PATTERN = "^[a-z_][a-z0-9_]{0,62}$";

/**
 * Vendors with a parser module in this repository.
 *
 * The list is the plugin's, not a deployment's: adding a vendor means adding a
 * parser and fixtures here. A deployment chooses a subset through
 * `enabledVendors`.
 */
export const SUPPORTED_VENDORS = [
  "mcmaster",
  "sendcutsend",
  "amazon",
  "formlabs",
] as const;

export type SupportedVendor = (typeof SUPPORTED_VENDORS)[number];

/** Where an operator finds this plugin's settings, for error messages. */
export const SETTINGS_PATH = "Settings → Plugins → Inventory";
