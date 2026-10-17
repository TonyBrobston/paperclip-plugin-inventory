// src/constants.ts
var PLUGIN_ID = "tbro.inventory";
var PLUGIN_VERSION = "0.1.0";
var CONFIG_KEYS = {
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
  enabledVendors: "enabledVendors"
};
var DEFAULT_DATABASE_SCHEMA = "inventory";
var SCHEMA_NAME_PATTERN = "^[a-z_][a-z0-9_]{0,62}$";
var SUPPORTED_VENDORS = [
  "mcmaster",
  "sendcutsend",
  "amazon",
  "formlabs"
];

// src/tools.ts
var PART_ID = {
  type: "string",
  description: "Internal part id, or a vendor-qualified reference such as vendor-a:part-001.",
  minLength: 1
};
var POSITIVE_QTY = {
  type: "number",
  description: "Quantity. Must be greater than zero.",
  exclusiveMinimum: 0
};
var TOOL_DECLARATIONS = [
  {
    name: "submit_order_email",
    displayName: "Submit a vendor order email",
    description: "The purchase intake path. Runs the matching vendor parser over the raw email, compares it to the extraction you pass in, and reconciles line totals against the email subtotal. Records the order only when the two extractions agree; otherwise it goes to the review queue and nothing reaches the ledger. Safe to call twice with the same message: a repeat is recognised and never double-counted.",
    phase: 3,
    parametersSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "The Gmail message id this email came from. Used for provenance and to make reprocessing idempotent.",
          minLength: 1
        },
        vendor: {
          type: "string",
          description: "Vendor key, if you already know it. Leave it out and the parser registry will identify the vendor from the email."
        },
        rawText: {
          type: "string",
          description: "The full plain-text body of the order email.",
          minLength: 1
        },
        agentModel: { type: "string", description: "Primary extraction model identity; required for unsupported vendors." },
        independentExtraction: { type: "object", description: "Unsupported vendors require {model, extractionId, extraction}, extracted independently by a different model. Model and run identities are caller attestations, retained for audit." },
        agentExtraction: {
          type: "object",
          description: "What you read from the email. This is one half of the double extraction, so extract it from the email itself rather than from a parser's output.",
          properties: {
            orderNumber: { type: "string", description: "The vendor's order number." },
            orderDate: {
              type: "string",
              description: "Order date as an ISO 8601 date, e.g. 2026-10-16."
            },
            subtotal: {
              type: "number",
              description: "The subtotal printed on the email, excluding tax and shipping."
            },
            lines: {
              type: "array",
              description: "One entry per ordered line item.",
              items: {
                type: "object",
                properties: {
                  vendorPartNumber: {
                    type: "string",
                    description: "The part number exactly as the vendor prints it."
                  },
                  description: { type: "string" },
                  quantity: POSITIVE_QTY,
                  unitPrice: { type: "number", minimum: 0 }
                },
                required: ["vendorPartNumber", "quantity", "unitPrice"]
              }
            }
          },
          required: ["orderNumber", "lines", "subtotal"]
        }
      },
      required: ["messageId", "rawText", "agentExtraction"]
    }
  },
  {
    name: "record_receipt",
    displayName: "Record a receipt",
    description: "Record that ordered parts physically arrived, moving them from on-order to on-hand.",
    phase: 2,
    parametersSchema: {
      type: "object",
      properties: {
        partId: PART_ID,
        quantity: POSITIVE_QTY,
        reference: {
          type: "string",
          description: "What this receipt relates to, such as a vendor order number. Reused references are treated as the same receipt."
        },
        delivery: {
          type: "string",
          description: "Which shipment this is, such as a packing-slip number. Only needed when one order arrives in more than one box: it makes the second shipment a separate receipt that still draws down the same order's on-order quantity. Omit it and the reference identifies the receipt on its own."
        },
        note: { type: "string" }
      },
      required: ["partId", "quantity", "reference"]
    }
  },
  {
    name: "record_adjustment",
    displayName: "Record an adjustment",
    description: "Correct on-hand quantity for a part \u2014 a physical count, breakage, or a mistake being put right. This is the only way on-hand is allowed to go negative, and the reason is required because an adjustment is the one ledger entry with no external document behind it.",
    phase: 2,
    parametersSchema: {
      type: "object",
      properties: {
        partId: PART_ID,
        quantityDelta: {
          type: "number",
          description: "Signed change to on-hand. Negative removes stock. Must not be zero."
        },
        reason: { type: "string", minLength: 1 },
        reference: {
          type: "string",
          description: "Optional stable key, such as an Adjustments-tab row id, so re-running a sync does not apply the same adjustment twice."
        }
      },
      required: ["partId", "quantityDelta", "reason"]
    }
  },
  {
    name: "record_sale",
    displayName: "Record a sale",
    description: "Consume parts for a sold product by expanding it through the BOM version that was active at the time of the sale. Later BOM changes never rewrite this history.",
    phase: 5,
    parametersSchema: {
      type: "object",
      properties: {
        productSku: {
          type: "string",
          description: "The BigCommerce SKU of the product sold.",
          minLength: 1
        },
        options: {
          type: "array",
          description: "Selected BigCommerce option names, which may add their own BOM lines.",
          items: { type: "string" }
        },
        qty: POSITIVE_QTY,
        reference: {
          type: "string",
          description: "The BigCommerce order id and line, which makes the sale idempotent.",
          minLength: 1
        }
      },
      required: ["productSku", "qty", "reference"]
    }
  },
  {
    name: "list_review_queue",
    displayName: "List review queue",
    description: "Everything that failed verification and is waiting on a human or an agent decision, with the reason and both extractions.",
    phase: 3,
    parametersSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        vendor: { type: "string" }
      }
    }
  },
  {
    name: "resolve_review_item",
    displayName: "Resolve a review item",
    description: "Accept, correct or reject one review-queue item. Accepting posts it to the ledger; rejecting records the decision and leaves the ledger untouched.",
    phase: 3,
    parametersSchema: {
      type: "object",
      properties: {
        reviewItemId: { type: "string", minLength: 1 },
        resolution: {
          type: "string",
          enum: ["accept", "accept_with_corrections", "reject"]
        },
        corrections: {
          type: "object",
          description: "The corrected extraction. Required when the resolution is accept_with_corrections."
        },
        agentModel: { type: "string" },
        independentExtraction: { type: "object", description: "Required for accepting unsupported vendors; same evidence shape as submit_order_email." },
        note: { type: "string", minLength: 1, description: "Required explanation of the decision." }
      },
      required: ["reviewItemId", "resolution", "note"]
    }
  },
  {
    name: "get_stock",
    displayName: "Get stock",
    description: "On hand, on order and committed for one part or for everything. On hand is always derived from the ledger, never read from a stored number.",
    phase: 2,
    parametersSchema: {
      type: "object",
      properties: {
        partId: {
          type: "string",
          description: "Omit to get every part."
        }
      }
    }
  },
  {
    name: "get_sellable",
    displayName: "Get sellable quantity",
    description: "How many of a product could be shipped right now: across the product's BOM parts, the lowest whole number of products the uncommitted stock supports.",
    phase: 6,
    parametersSchema: {
      type: "object",
      properties: {
        productSku: {
          type: "string",
          description: "Omit to get every product with a BOM."
        }
      }
    }
  },
  {
    name: "sync_sheet",
    displayName: "Sync the Google Sheet",
    description: "Push system-owned columns to the inventory sheet, read the human-owned ones back, turn Adjustments-tab rows into ledger adjustments and mark them processed, and refresh the Needs Review view.",
    phase: 4,
    parametersSchema: {
      type: "object",
      properties: {
        dryRun: {
          type: "boolean",
          description: "Report what would change without writing to the sheet or the ledger.",
          default: false
        }
      }
    }
  },
  {
    name: "sync_boms",
    displayName: "Sync BOMs",
    description: "Read the BOM files from the config repository into versioned BOM records. Validates that every part reference exists and every SKU exists in BigCommerce, and fails loudly rather than importing a BOM that would silently consume the wrong part.",
    phase: 5,
    parametersSchema: {
      type: "object",
      properties: {
        commit: {
          type: "string",
          description: "Config-repository commit to sync. Defaults to the current head of the configured branch."
        },
        dryRun: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "reconcile_bigcommerce",
    displayName: "Reconcile with BigCommerce",
    description: "Walk recent BigCommerce orders and bring reservations, sales and pushed sellable quantities back into agreement with the ledger. This is the path that keeps the two systems in step, because the BigCommerce plugin emits no events for this one to subscribe to.",
    phase: 6,
    parametersSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "ISO 8601 timestamp. Defaults to the last reconciliation cursor."
        },
        dryRun: { type: "boolean", default: false }
      }
    }
  }
];
var TOOL_NAMES = TOOL_DECLARATIONS.map((tool) => tool.name);

// src/manifest.ts
var manifest = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Inventory",
  description: "Parts inventory for a small manufacturing business. Records purchases from vendor order emails with a double-extraction check, derives on-hand stock from an append-only ledger, and consumes parts through a bill of materials when products sell.",
  author: "Tony Brobston",
  categories: ["automation"],
  capabilities: ["secrets.read-ref", "agent.tools.register"],
  entrypoints: {
    worker: "./dist/worker.js"
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
        description: "Save your PostgreSQL connection string as a Paperclip secret and pick it here, for example postgres://user:password@host:5432/dbname. The plugin creates and owns one schema inside that database. A connection string pasted as plain text is refused rather than stored in plugin config.",
        properties: {
          type: { const: "secret_ref" },
          secretId: { type: "string", minLength: 1 }
          // `version` is left unconstrained on purpose: the host's binding
          // parser accepts "latest" or a positive integer and validates it
          // itself, so over-constraining it here is what makes a legitimate
          // pinned-version binding impossible to save.
        },
        required: ["type", "secretId"]
      },
      spreadsheetId: {
        type: "string",
        title: "Spreadsheet ID (optional until Sheet sync)",
        description: "Copy from private deployment settings. Never put a real spreadsheet ID in public code.",
        pattern: "^[a-zA-Z0-9_-]{10,200}$"
      },
      googleServiceAccount: {
        type: "object",
        format: "secret-ref",
        title: "Google service-account JSON key",
        properties: { type: { const: "secret_ref" }, secretId: { type: "string", minLength: 1 } },
        required: ["type", "secretId"]
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
        pattern: SCHEMA_NAME_PATTERN
      },
      [CONFIG_KEYS.enabledVendors]: {
        type: "array",
        title: "Enabled vendors (optional)",
        description: "Which vendor order-email parsers to run. Leave blank to enable all of them. A vendor with no parser cannot be enabled here; its orders need a second independent extraction instead.",
        items: {
          type: "string",
          enum: [...SUPPORTED_VENDORS]
        },
        uniqueItems: true
      }
    },
    required: [CONFIG_KEYS.databaseUrl]
  },
  tools: TOOL_DECLARATIONS.map((tool) => ({
    name: tool.name,
    displayName: tool.displayName,
    description: tool.description,
    parametersSchema: tool.parametersSchema
  }))
};
var manifest_default = manifest;
export {
  manifest_default as default
};
//# sourceMappingURL=manifest.js.map
