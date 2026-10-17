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
  bigcommerceToken: "bigcommerceToken"
};
var DEFAULT_DATABASE_SCHEMA = "inventory";
var SCHEMA_NAME_PATTERN = "^[a-z_][a-z0-9_]{0,62}$";

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
          description: "The product's catalog key: its BigCommerce variant SKU, or product-<id> for a product whose variants carry no SKU. Most products in this catalog are the second kind.",
          minLength: 1
        },
        options: {
          type: "array",
          description: 'The option values the customer chose, as "option name: value" or { option, value }. The value is required, not just the name: one option can mean a different part per value, so a name alone cannot say which to consume. Every option name declared by the BOM requires exactly one selected value, including explicit no-parts values. Missing or conflicting selections refuse the sale. Options absent from the BOM are ignored and reported back.',
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  option: { type: "string", minLength: 1 },
                  value: { type: "string", minLength: 1 }
                },
                required: ["option", "value"]
              }
            ]
          }
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
        },
        options: {
          type: "array",
          items: { type: "object", properties: { option: { type: "string" }, value: { type: "string" } }, required: ["option", "value"] }
        }
      }
    }
  },
  {
    name: "inventory_page",
    displayName: "Read Inventory pages",
    description: "Read inventory, counts, receiving, review, settings, history or dashboard data in the host-authorized company.",
    phase: 4,
    parametersSchema: { type: "object", properties: {
      page: { type: "string", enum: ["inventory", "counts", "receiving", "review", "settings", "history", "dashboard"] },
      search: { type: "string" },
      vendor: { type: "string" },
      active: { type: "string", enum: ["all", "true", "false"] },
      lowStock: { type: "boolean" },
      orderId: { type: "string" },
      partId: { type: "string" }
    }, required: ["page"] }
  },
  {
    name: "inventory_action",
    displayName: "Manage Inventory",
    description: "Preview and submit atomic physical counts or receipts under Inventory policy. Human approval, metadata, settings and review operations require authenticated host authority; actor fields in parameters grant no permission.",
    phase: 4,
    parametersSchema: { type: "object", properties: {
      operation: { type: "string", enum: ["preview_count", "submit_count", "adjust", "approve_count", "reject_count", "preview_receipt", "confirm_receipt", "short_close", "edit_part", "save_settings", "import_legacy_settings", "resolve_review"] },
      lines: { type: "array", items: { type: "object", properties: { partId: { type: "string" }, counted: { type: "number" }, expected: { type: "number" }, ledgerRevision: { type: "string" }, quantity: { type: "number" } }, required: ["partId"] } },
      reason: { type: "string" },
      submissionKey: { type: "string" },
      countId: { type: "string" },
      orderId: { type: "string" },
      previewId: { type: "string" },
      shipmentReference: { type: "string" },
      partId: { type: "string" },
      quantityDelta: { type: "number" },
      reference: { type: "string" },
      revision: { type: "string" },
      settings: { type: "object" },
      parts: { type: "array", items: { type: "object" } },
      reorderPoint: { type: "number" },
      targetQuantity: { type: "number" },
      location: { type: "string" },
      notes: { type: "string" },
      active: { type: "boolean" },
      ledgerRevision: { type: "string" },
      outstanding: { type: "number" },
      reviewItemId: { type: "string" },
      resolution: { type: "string", enum: ["accept", "accept_with_corrections", "reject"] },
      note: { type: "string" },
      corrections: { type: "object" },
      independentExtraction: { type: "object" },
      agentModel: { type: "string" }
    }, required: ["operation"] }
  },
  {
    name: "sync_boms",
    displayName: "Sync BOMs",
    description: "Read the BOM files from the config repository into versioned BOM records. Validates that every part reference exists, and that every catalog key and option value exists in BigCommerce, and fails loudly rather than importing a BOM that would silently consume the wrong part. A changed quantity becomes a new version; what past sales consumed never changes. Draft BOMs \u2014 documented quantities whose part mappings are not confirmed yet \u2014 are reported and held, never imported.",
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
  capabilities: ["secrets.read-ref", "agent.tools.register", "ui.page.register", "ui.sidebar.register", "ui.dashboardWidget.register", "ui.action.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: { slots: [
    { id: "inventory", type: "page", displayName: "Inventory", exportName: "InventoryPage", routePath: "inventory" },
    { id: "inventory-nav", type: "sidebar", displayName: "Inventory", exportName: "InventorySidebar" },
    { id: "inventory-alerts", type: "dashboardWidget", displayName: "Inventory", exportName: "InventoryDashboard" }
  ] },
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
      [CONFIG_KEYS.configRepo]: {
        type: "string",
        title: "Private config repository (optional until BOM sync)",
        description: "The repository holding bom/, as owner/name. Copy it from private deployment settings; the repository name belongs in config, never in public code.",
        pattern: "^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$"
      },
      [CONFIG_KEYS.configRepoBranch]: {
        type: "string",
        title: "Config repository branch (optional)",
        description: "Leave blank to read the repository's default branch.",
        pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$"
      },
      [CONFIG_KEYS.configRepoToken]: {
        type: "object",
        format: "secret-ref",
        title: "GitHub token for the config repository",
        description: "Save a GitHub token with read access to that repository as a Paperclip secret and pick it here. BOM files are private business data; the plugin only reads them.",
        properties: { type: { const: "secret_ref" }, secretId: { type: "string", minLength: 1 } },
        required: ["type", "secretId"]
      },
      [CONFIG_KEYS.bigcommerceStoreHash]: {
        type: "string",
        title: "BigCommerce store hash (optional until BOM sync)",
        description: "Used to check that a BOM's catalog key and option values exist in the store before the BOM is accepted. A BOM keyed on something the store does not have consumes nothing on every sale.",
        pattern: "^[a-z0-9]{5,30}$"
      },
      bigcommerceBridgeToken: {
        type: "object",
        format: "secret-ref",
        title: "BigCommerce bridge token (Orders read, Products modify)",
        description: "Separate stock-write credential. Required for reconciliation and stock pushes; stored only in Paperclip secrets.",
        properties: { type: { const: "secret_ref" }, secretId: { type: "string", minLength: 1 } },
        required: ["type", "secretId"]
      },
      [CONFIG_KEYS.bigcommerceToken]: {
        type: "object",
        format: "secret-ref",
        title: "BigCommerce API token (products: read-only)",
        description: "A token with read access to products. BOM sync only reads the catalog with it.",
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
