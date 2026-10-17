/** Host authority is checked before opening a company database. */
import type { PluginContext, ToolRunContext } from '@paperclipai/plugin-sdk';
import type { PluginPerformActionContext } from '@paperclipai/plugin-sdk';
import { InputError, OperatorFacingError } from './errors.js';
import { object, text } from './extraction.js';
import { openStore } from './storage.js';
import { executeNative, readNative, type NativeActor } from './native-service.js';
import { resolveReviewDomain } from './intake.js';
import { pushStock } from './bridge.js';

export function companyScope(value: unknown): string {
  return text(value, 'Host-authorized company', 200);
}
export function actionActor(context: PluginPerformActionContext): NativeActor {
  const actor = context?.actor;
  if (!actor || actor.companyId !== context.companyId) throw new InputError('Authenticated company context is required.');
  const companyId = companyScope(actor.companyId);
  if (actor.type === 'user') return { type: 'user', id: text(actor.userId, 'Authenticated human identity', 200), companyId };
  if (actor.type === 'agent') return { type: 'agent', id: text(actor.agentId, 'Authenticated agent identity', 200), companyId };
  throw new InputError('An authenticated user or agent is required.');
}
export function toolActor(run: ToolRunContext): NativeActor {
  return { type: 'agent', id: text(run.agentId, 'Authenticated agent identity', 200), companyId: companyScope(run.companyId) };
}

export async function nativeAction(ctx: PluginContext, actor: NativeActor, raw: unknown) {
  const input = object(raw);
  const operation = text(input.operation, 'Operation');
  const db = await openStore(ctx, actor.companyId);
  const result = operation === 'resolve_review'
    ? await resolveReviewDomain(ctx, db, input, actor)
    : await executeNative(db, actor, operation, input);
  // Inventory changes remain committed if the separate stock push fails.
  if (['submit_count', 'approve_count', 'confirm_receipt', 'resolve_review', 'adjust'].includes(operation)) {
    const run = { companyId: actor.companyId, agentId: actor.type === 'agent' ? actor.id : undefined, runId: undefined } as unknown as ToolRunContext;
    try { return { ...object(result), stockSync: await pushStock(ctx, run) }; }
    catch { return { ...object(result), stockSync: { pending: true, message: 'Saved; stock push pending. Run reconcile_bigcommerce to retry.' } }; }
  }
  return result;
}
export function registerNative(ctx: PluginContext) {
  ctx.data.register('inventory_page', async params => {
    // The host overwrites params.companyId; data handlers never mutate inventory.
    const companyId = companyScope(params.companyId);
    const db = await openStore(ctx, companyId);
    return readNative(db, text(params.page ?? 'inventory', 'Page'), params);
  });
  ctx.actions.register('inventory_action', async (params, context) => {
    try { return await nativeAction(ctx, actionActor(context), params); }
    catch (error) {
      if (error instanceof OperatorFacingError) throw error;
      ctx.logger.warn('Inventory action failed', { reason: (error as Error)?.name });
      throw new InputError('The inventory action failed. Check the plugin log.');
    }
  });
}
