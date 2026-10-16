/**
 * The tool surface from `SPEC.md`, declared in full.
 *
 * Every tool the spec names is declared here in this phase, even though the
 * handlers arrive over phases 2 to 6. Declaring the whole surface up front is
 * what makes the parameter shapes a design decision reviewed once, rather than
 * four separate improvisations; `phase` records which phase owns each handler,
 * and `tests/tools.spec.ts` asserts the set matches the spec exactly.
 *
 * A tool whose phase has not landed is registered and callable — it returns a
 * clear "not implemented yet" result rather than vanishing from the agent's
 * tool list, because a missing tool and a broken tool look identical from the
 * other side.
 */

export interface ToolDeclaration {
  name: string;
  displayName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  /** The phase that implements the handler. */
  phase: 2 | 3 | 4 | 5 | 6;
}

const PART_ID = {
  type: "string",
  description:
    "Internal part id, or a vendor-qualified reference such as vendor-a:part-001.",
  minLength: 1,
} as const;

const POSITIVE_QTY = {
  type: "number",
  description: "Quantity. Must be greater than zero.",
  exclusiveMinimum: 0,
} as const;

export const TOOL_DECLARATIONS: readonly ToolDeclaration[] = [
  {
    name: "submit_order_email",
    displayName: "Submit a vendor order email",
    description:
      "The purchase intake path. Runs the matching vendor parser over the raw email, compares it to the extraction you pass in, and reconciles line totals against the email subtotal. Records the order only when the two extractions agree; otherwise it goes to the review queue and nothing reaches the ledger. Safe to call twice with the same message: a repeat is recognised and never double-counted.",
    phase: 3,
    parametersSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description:
            "The Gmail message id this email came from. Used for provenance and to make reprocessing idempotent.",
          minLength: 1,
        },
        vendor: {
          type: "string",
          description:
            "Vendor key, if you already know it. Leave it out and the parser registry will identify the vendor from the email.",
        },
        rawText: {
          type: "string",
          description: "The full plain-text body of the order email.",
          minLength: 1,
        },
        agentExtraction: {
          type: "object",
          description:
            "What you read from the email. This is one half of the double extraction, so extract it from the email itself rather than from a parser's output.",
          properties: {
            orderNumber: { type: "string", description: "The vendor's order number." },
            orderDate: {
              type: "string",
              description: "Order date as an ISO 8601 date, e.g. 2026-10-16.",
            },
            subtotal: {
              type: "number",
              description:
                "The subtotal printed on the email, excluding tax and shipping.",
            },
            lines: {
              type: "array",
              description: "One entry per ordered line item.",
              items: {
                type: "object",
                properties: {
                  vendorPartNumber: {
                    type: "string",
                    description: "The part number exactly as the vendor prints it.",
                  },
                  description: { type: "string" },
                  quantity: POSITIVE_QTY,
                  unitPrice: { type: "number", minimum: 0 },
                },
                required: ["vendorPartNumber", "quantity", "unitPrice"],
              },
            },
          },
          required: ["orderNumber", "lines", "subtotal"],
        },
      },
      required: ["messageId", "rawText", "agentExtraction"],
    },
  },
  {
    name: "record_receipt",
    displayName: "Record a receipt",
    description:
      "Record that ordered parts physically arrived, moving them from on-order to on-hand.",
    phase: 2,
    parametersSchema: {
      type: "object",
      properties: {
        partId: PART_ID,
        quantity: POSITIVE_QTY,
        reference: {
          type: "string",
          description:
            "What this receipt relates to, such as a vendor order number. Reused references are treated as the same receipt.",
        },
        delivery: {
          type: "string",
          description:
            "Which shipment this is, such as a packing-slip number. Only needed when one order arrives in more than one box: it makes the second shipment a separate receipt that still draws down the same order's on-order quantity. Omit it and the reference identifies the receipt on its own.",
        },
        note: { type: "string" },
      },
      required: ["partId", "quantity", "reference"],
    },
  },
  {
    name: "record_adjustment",
    displayName: "Record an adjustment",
    description:
      "Correct on-hand quantity for a part — a physical count, breakage, or a mistake being put right. This is the only way on-hand is allowed to go negative, and the reason is required because an adjustment is the one ledger entry with no external document behind it.",
    phase: 2,
    parametersSchema: {
      type: "object",
      properties: {
        partId: PART_ID,
        quantityDelta: {
          type: "number",
          description:
            "Signed change to on-hand. Negative removes stock. Must not be zero.",
        },
        reason: { type: "string", minLength: 1 },
        reference: {
          type: "string",
          description:
            "Optional stable key, such as an Adjustments-tab row id, so re-running a sync does not apply the same adjustment twice.",
        },
      },
      required: ["partId", "quantityDelta", "reason"],
    },
  },
  {
    name: "record_sale",
    displayName: "Record a sale",
    description:
      "Consume parts for a sold product by expanding it through the BOM version that was active at the time of the sale. Later BOM changes never rewrite this history.",
    phase: 5,
    parametersSchema: {
      type: "object",
      properties: {
        productSku: {
          type: "string",
          description: "The BigCommerce SKU of the product sold.",
          minLength: 1,
        },
        options: {
          type: "array",
          description:
            "Selected BigCommerce option names, which may add their own BOM lines.",
          items: { type: "string" },
        },
        qty: POSITIVE_QTY,
        reference: {
          type: "string",
          description:
            "The BigCommerce order id and line, which makes the sale idempotent.",
          minLength: 1,
        },
      },
      required: ["productSku", "qty", "reference"],
    },
  },
  {
    name: "list_review_queue",
    displayName: "List review queue",
    description:
      "Everything that failed verification and is waiting on a human or an agent decision, with the reason and both extractions.",
    phase: 3,
    parametersSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        vendor: { type: "string" },
      },
    },
  },
  {
    name: "resolve_review_item",
    displayName: "Resolve a review item",
    description:
      "Accept, correct or reject one review-queue item. Accepting posts it to the ledger; rejecting records the decision and leaves the ledger untouched.",
    phase: 3,
    parametersSchema: {
      type: "object",
      properties: {
        reviewItemId: { type: "string", minLength: 1 },
        resolution: {
          type: "string",
          enum: ["accept", "accept_with_corrections", "reject"],
        },
        corrections: {
          type: "object",
          description:
            "The corrected extraction. Required when the resolution is accept_with_corrections.",
        },
        note: { type: "string" },
      },
      required: ["reviewItemId", "resolution"],
    },
  },
  {
    name: "get_stock",
    displayName: "Get stock",
    description:
      "On hand, on order and committed for one part or for everything. On hand is always derived from the ledger, never read from a stored number.",
    phase: 2,
    parametersSchema: {
      type: "object",
      properties: {
        partId: {
          type: "string",
          description: "Omit to get every part.",
        },
      },
    },
  },
  {
    name: "get_sellable",
    displayName: "Get sellable quantity",
    description:
      "How many of a product could be shipped right now: across the product's BOM parts, the lowest whole number of products the uncommitted stock supports.",
    phase: 6,
    parametersSchema: {
      type: "object",
      properties: {
        productSku: {
          type: "string",
          description: "Omit to get every product with a BOM.",
        },
      },
    },
  },
  {
    name: "sync_sheet",
    displayName: "Sync the Google Sheet",
    description:
      "Push system-owned columns to the inventory sheet, read the human-owned ones back, turn Adjustments-tab rows into ledger adjustments and mark them processed, and refresh the Needs Review view.",
    phase: 4,
    parametersSchema: {
      type: "object",
      properties: {
        dryRun: {
          type: "boolean",
          description:
            "Report what would change without writing to the sheet or the ledger.",
          default: false,
        },
      },
    },
  },
  {
    name: "sync_boms",
    displayName: "Sync BOMs",
    description:
      "Read the BOM files from the config repository into versioned BOM records. Validates that every part reference exists and every SKU exists in BigCommerce, and fails loudly rather than importing a BOM that would silently consume the wrong part.",
    phase: 5,
    parametersSchema: {
      type: "object",
      properties: {
        commit: {
          type: "string",
          description:
            "Config-repository commit to sync. Defaults to the current head of the configured branch.",
        },
        dryRun: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "reconcile_bigcommerce",
    displayName: "Reconcile with BigCommerce",
    description:
      "Walk recent BigCommerce orders and bring reservations, sales and pushed sellable quantities back into agreement with the ledger. This is the path that keeps the two systems in step, because the BigCommerce plugin emits no events for this one to subscribe to.",
    phase: 6,
    parametersSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description:
            "ISO 8601 timestamp. Defaults to the last reconciliation cursor.",
        },
        dryRun: { type: "boolean", default: false },
      },
    },
  },
] as const;

export const TOOL_NAMES = TOOL_DECLARATIONS.map((tool) => tool.name);
