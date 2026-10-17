import {
  definePlugin,
  runWorker,
  type PluginConfigValidationResult,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { ConfigError, isSecretRefBinding, parseDatabaseSchema } from "./config.js";
import { CONFIG_KEYS, DEFAULT_DATABASE_SCHEMA, SETTINGS_PATH } from "./constants.js";
import { closeAllDatabases } from "./db.js";
import { OperatorFacingError } from "./errors.js";
import { getStock, recordAdjustment, recordReceipt } from "./handlers.js";
import { submitOrderEmail, listReviewQueue, resolveReviewItem } from "./intake.js";
import { getSellable, reconcileBigcommerce, pushStock } from "./bridge.js";
import { syncBoms } from "./bom-sync.js";
import { recordSale } from "./sales.js";
import { registerNative, nativeAction, toolActor } from "./native.js";
import { readNative } from "./native-service.js";
import { openStore } from "./storage.js";
import { TOOL_DECLARATIONS } from "./tools.js";

/**
 * Raised by a tool whose phase has not landed yet.
 *
 * Every tool in `SPEC.md` is registered from this phase on, so an agent's tool
 * list is stable and a missing capability reads as "not built yet" rather than
 * as a tool that silently is not there.
 */
export class NotImplementedError extends OperatorFacingError {
  constructor(toolName: string, phase: number) {
    super(
      `${toolName} is not implemented yet — it lands in phase ${phase} of the inventory plugin build.`,
    );
  }
}

/**
 * Force the structured half of a tool result to be a JSON object.
 *
 * The host forwards `ToolResult.data` as MCP `structuredContent`, and the
 * agent's client requires an object there. An array, a scalar, or an absent
 * `data` (forwarded as an explicit `null`) makes the client discard the whole
 * result — `content` included — before the agent reads any of it.
 *
 * This is the defect that made every call to the BigCommerce plugin fail with
 * `structuredContent: expected record, received null`. It is an unconditional
 * backstop at the single point the host reads, so a tool added in a later
 * phase cannot reintroduce it. See `docs/sdk-notes.md` (a).
 */
export function structured(data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { value: data };
}

/**
 * Turn a thrown error into a tool result.
 *
 * Returning `{ error }` rather than throwing keeps the message useful: a
 * missing config should read as "an operator needs to set this", not as a
 * plugin crash. Only messages this plugin wrote are passed through — that is
 * what `OperatorFacingError` marks — because an arbitrary runtime error can
 * carry a connection string, a hostname or row data in its text, and a tool
 * result goes to an agent.
 *
 * `content` and `data` are set alongside `error` for the reason above: `error`
 * alone travels in neither field the host forwards, so the message would never
 * arrive.
 */
export function toolError(
  ctx: PluginContext,
  toolName: string,
  companyId: string,
  error: unknown,
): ToolResult {
  const expected = error instanceof OperatorFacingError;
  const message = expected ? error.message : "The inventory request failed.";
  ctx.logger.warn("Inventory tool call failed", {
    tool: toolName,
    companyId,
    // The unexpected error's own text is withheld from the agent. The log is
    // operator-facing, so record its class to keep a failure diagnosable.
    reason: expected ? message : `unexpected ${(error as Error)?.name ?? "error"}`,
  });
  return { error: message, content: message, data: { error: message } };
}

/**
 * Route a tool call to its handler.
 *
 * The single seam every phase adds to. Keeping it here, rather than attaching
 * a handler to each declaration, is what lets `worker.ts` own the result
 * shape and the error policy for all eleven tools at once.
 *
 * Phase 2 fills in the three ledger tools. The other eight still answer with
 * the phase that owns them.
 */
/**
 * Tools with a handler today.
 *
 * Exported so the tests can assert that this list and `dispatch` agree: a
 * tool named here that still throws `NotImplementedError`, or one missing
 * from it that works, means the two have drifted.
 */
export const IMPLEMENTED_TOOLS = ["record_receipt", "record_adjustment", "get_stock", "submit_order_email", "list_review_queue", "resolve_review_item", "sync_boms", "inventory_action", "inventory_page", "record_sale", "get_sellable", "reconcile_bigcommerce"] as const;

export async function dispatch(
  ctx: PluginContext,
  declaration: (typeof TOOL_DECLARATIONS)[number],
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  toolActor(runCtx);
  switch (declaration.name) {
    case "inventory_action": {
      const data = structured(await nativeAction(ctx, toolActor(runCtx), params));
      return { content: 'Inventory operation completed.', data };
    }
    case "inventory_page": {
      const input = params as Record<string, unknown>;
      const db = await openStore(ctx, runCtx.companyId);
      return { content: 'Inventory data.', data: structured(await readNative(db, String(input.page ?? 'inventory'), input)) };
    }
    case "get_sellable":
      return getSellable(ctx, params, runCtx);
    case "reconcile_bigcommerce":
      return reconcileBigcommerce(ctx, params, runCtx);
    case "sync_boms":
      return syncBoms(ctx, params, runCtx);
    case "record_sale":
      return recordSale(ctx, params, runCtx);
    case "submit_order_email":
      return submitOrderEmail(ctx, params, runCtx);
    case "list_review_queue":
      return listReviewQueue(ctx, params, runCtx);
    case "resolve_review_item":
      return resolveReviewItem(ctx, params, runCtx);
    case "record_receipt":
      return recordReceipt(ctx, params, runCtx);
    case "record_adjustment":
      return recordAdjustment(ctx, params, runCtx);
    case "get_stock":
      return getStock(ctx, params, runCtx);
    default:
      throw new NotImplementedError(declaration.name, declaration.phase);
  }
}

const plugin = definePlugin({
  async setup(ctx: PluginContext): Promise<void> {
    registerNative(ctx);
    for (const declaration of TOOL_DECLARATIONS) {
      ctx.tools.register(
        declaration.name,
        {
          displayName: declaration.displayName,
          description: declaration.description,
          parametersSchema: declaration.parametersSchema,
        },
        async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
          try {
            const result = await dispatch(ctx, declaration, params, runCtx);
            const data = structured(result.data);
            const mutates = ["record_receipt", "record_adjustment", "record_sale", "submit_order_email", "resolve_review_item", "sync_boms"].includes(declaration.name);
            if (mutates && !(params as { dryRun?: boolean } | null)?.dryRun && !result.error) {
              try { data.stockSync = await pushStock(ctx, runCtx); }
              catch { data.stockSync = { pending: true, message: "Local change saved; stock push pending. Run reconcile_bigcommerce to retry." }; }
            }
            return { ...result, data };
          } catch (error) {
            return toolError(ctx, declaration.name, runCtx.companyId, error);
          }
        },
      );
    }

    ctx.logger.info("Inventory plugin ready", {
      tools: TOOL_DECLARATIONS.length,
      // Honest about what this build is. The remaining handlers arrive over
      // phases 3-6.
      implemented: IMPLEMENTED_TOOLS.length,
    });
  },

  /**
   * Shape-only validation, and the "only" is deliberate.
   *
   * The host calls this from exactly one place: the settings page's Test
   * Connection button. Saving does not call it — `POST
   * /api/plugins/:id/config` validates against `instanceConfigSchema` with Ajv
   * and nothing else — so anything that must block a save belongs in that
   * schema. See `docs/sdk-notes.md` (b).
   *
   * It also cannot open the database: the host passes the config without a
   * company id, and resolving the connection secret needs one. So it checks
   * what it can and says plainly what it did not check, rather than reporting
   * a green "connected" that was never tested.
   */
  async onValidateConfig(
    config: Record<string, unknown>,
  ): Promise<PluginConfigValidationResult> {
    const errors: string[] = [];

    if (!isSecretRefBinding(config[CONFIG_KEYS.databaseUrl])) {
      errors.push(
        `Select a Paperclip secret holding the PostgreSQL connection string. A connection string typed as plain text is refused rather than stored in ${SETTINGS_PATH}.`,
      );
    }

    let schema = DEFAULT_DATABASE_SCHEMA;
    try {
      schema = parseDatabaseSchema(config[CONFIG_KEYS.databaseSchema]);
    } catch (error) {
      errors.push(error instanceof ConfigError ? error.message : "The schema name could not be validated.");
    }

    if (errors.length > 0) return { ok: false, errors };

    return {
      ok: true,
      warnings: [
        `The connection secret and the schema name "${schema}" look valid. This check does not open the database — ask an agent to run get_stock to confirm the credentials are accepted and the migrations have run.`,
      ],
    };
  },

  async onShutdown(): Promise<void> {
    await closeAllDatabases();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
