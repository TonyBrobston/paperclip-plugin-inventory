import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  CONFIG_KEYS,
  DEFAULT_DATABASE_SCHEMA,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SCHEMA_NAME_PATTERN,
  SUPPORTED_VENDORS,
} from "./constants.js";
import { TOOL_DECLARATIONS } from "./tools.js";

/**
 * Inventory, as a Paperclip plugin.
 *
 * Capabilities are kept to what the spec actually needs. In particular there
 * is no `database.namespace.*`: this plugin owns its PostgreSQL connection so
 * that the ledger can be written in transactions, which the host-owned
 * namespace does not allow. `docs/sdk-notes.md` (c) has the reasoning and the
 * evidence.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Inventory",
  description:
    "Parts inventory for a small manufacturing business. Records purchases from vendor order emails with a double-extraction check, derives on-hand stock from an append-only ledger, and consumes parts through a bill of materials when products sell.",
  author: "Tony Brobston",
  categories: ["automation"],
  capabilities: ["secrets.read-ref", "agent.tools.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      [CONFIG_KEYS.databaseUrl]: {
        // `format: "secret-ref"` is what makes the settings form render a
        // secret picker, and the picker writes a binding *object*, not a
        // string. The host validates this schema with Ajv before it looks for
        // secret bindings, so `type: "string"` here would reject the only
        // value the form can produce.
        //
        // Ajv's strict mode logs that `format` expects a string or number
        // type. It is a log, not an error: the keyword is a host-side UI hint
        // that never validates a value.
        type: "object",
        format: "secret-ref",
        title: "Database connection",
        description:
          "Save your PostgreSQL connection string as a Paperclip secret and pick it here, for example postgres://user:password@host:5432/dbname. The plugin creates and owns one schema inside that database. A connection string pasted as plain text is refused rather than stored in plugin config.",
        properties: {
          type: { const: "secret_ref" },
          secretId: { type: "string", minLength: 1 },
          // `version` is left unconstrained on purpose: the host's binding
          // parser accepts "latest" or a positive integer and validates it
          // itself, so over-constraining it here is what makes a legitimate
          // pinned-version binding impossible to save.
        },
        required: ["type", "secretId"],
      },
      spreadsheetId: {
        type: "string", title: "Spreadsheet ID (optional until Sheet sync)",
        description: "Copy from private deployment settings. Never put a real spreadsheet ID in public code.",
        pattern: "^[a-zA-Z0-9_-]{10,200}$",
      },
      googleServiceAccount: {
        type: "object", format: "secret-ref", title: "Google service-account JSON key",
        properties: { type: { const: "secret_ref" }, secretId: { type: "string", minLength: 1 } },
        required: ["type", "secretId"],
      },
      [CONFIG_KEYS.databaseSchema]: {
        type: "string",
        title: "Schema name (optional)",
        description: `Leave blank for "${DEFAULT_DATABASE_SCHEMA}". Set it only if that name is already taken in your database. Lowercase letters, digits and underscores.`,
        // The pattern has to carry the rule itself, because saving validates
        // against this schema and nothing else — `onValidateConfig` runs only
        // behind the Test Connection button. The same expression is enforced
        // again in `parseDatabaseSchema` at request time, so the form and the
        // worker cannot disagree about what is acceptable.
        pattern: SCHEMA_NAME_PATTERN,
      },
      [CONFIG_KEYS.enabledVendors]: {
        type: "array",
        title: "Enabled vendors (optional)",
        description:
          "Which vendor order-email parsers to run. Leave blank to enable all of them. A vendor with no parser cannot be enabled here; its orders need a second independent extraction instead.",
        items: {
          type: "string",
          enum: [...SUPPORTED_VENDORS],
        },
        uniqueItems: true,
      },
    },
    required: [CONFIG_KEYS.databaseUrl],
  },
  tools: TOOL_DECLARATIONS.map((tool) => ({
    name: tool.name,
    displayName: tool.displayName,
    description: tool.description,
    parametersSchema: tool.parametersSchema,
  })),
};

export default manifest;
