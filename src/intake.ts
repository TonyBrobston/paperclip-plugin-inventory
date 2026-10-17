/** Email is data, never a command. All writes below are transactional. */
import type { PoolClient } from 'pg';
import type { PluginContext, ToolRunContext, ToolResult } from '@paperclipai/plugin-sdk';
import type { DatabaseHandle } from './db.js';
import { InputError } from './errors.js';
import { appendEntry } from './ledger.js';
import { parsePartRef } from './parts.js';
import { parseEnabledVendors } from './config.js';
import { openStore } from './storage.js';
import { object, text, extraction, vendorKey, disagreements, reconcile, type Extraction } from './extraction.js';
import { parsers, selectParser } from './parsers/index.js';

function provenance(run: ToolRunContext, source: string) {
  return { source, agentId: run.agentId, runId: run.runId, companyId: run.companyId, projectId: run.projectId };
}
interface Verification {
  extraction?: Extraction;
  evidence?: unknown;
  reasons: string[];
}
function independent(input: Record<string, unknown>, agent: Extraction): Verification {
  try {
    const evidence = object(input.independentExtraction);
    const primaryModel = text(input.agentModel, 'Primary model').toLowerCase();
    const model = text(evidence.model, 'Independent model').toLowerCase();
    const extractionId = text(evidence.extractionId, 'Independent extraction run');
    if (model === primaryModel) return { reasons: ['Unsupported vendor requires extraction by a different model'] };
    const second = extraction(evidence.extraction);
    return { extraction: second, evidence: { model, primaryModel, extractionId }, reasons: [...disagreements(agent, second), ...reconcile(second)] };
  } catch {
    return { reasons: ['Unsupported vendor requires an independent second-model extraction, model identities and extraction run id'] };
  }
}
async function lock(client: PoolClient, value: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [value]);
}
async function disposition(client: PoolClient, messageId: string) {
  const { rows } = await client.query(`SELECT i.message_id, COALESCE(i.order_id, r.resolved_order_id) AS order_id, i.review_id, r.status AS review_status
    FROM email_intake i LEFT JOIN review_queue r ON r.id=i.review_id WHERE i.message_id=$1`, [messageId]);
  const row = rows[0];
  return row ? { status: row.order_id ? 'recorded' : row.review_status, orderId: row.order_id, reviewItemId: row.review_id, duplicate: true } : undefined;
}
async function previousOrder(client: PoolClient, vendor: string, order: Extraction) {
  const result = await client.query('SELECT id, vendor_order_number, order_date::text, subtotal FROM orders WHERE vendor=$1 AND lower(vendor_order_number)=lower($2)', [vendor, order.orderNumber]);
  const old = result.rows[0];
  if (!old) return undefined;
  const lines = await client.query(`SELECT p.vendor_part_number, l.quantity, l.unit_price FROM order_lines l JOIN parts p ON p.id=l.part_id WHERE l.order_id=$1 ORDER BY l.line_number`, [old.id]);
  const stored = extraction({ orderNumber: old.vendor_order_number, ...(old.order_date ? { orderDate: old.order_date } : {}), subtotal: Number(old.subtotal), lines: lines.rows.map(l => ({ vendorPartNumber: l.vendor_part_number, quantity: Number(l.quantity), unitPrice: Number(l.unit_price) })) });
  return { orderId: old.id as string, conflicts: disagreements(stored, order) };
}
async function recordOrder(db: DatabaseHandle, client: PoolClient, vendor: string, order: Extraction, messageId: string, rawText: string, run: ToolRunContext, reviewItemId?: string) {
  await lock(client, JSON.stringify(['order', vendor, order.orderNumber.toLowerCase()]));
  const previous = await previousOrder(client, vendor, order);
  if (previous?.conflicts.length) throw new InputError('This vendor order is already recorded with different contents. Existing stock was not changed.');
  if (previous) return { orderId: previous.orderId, duplicate: true };
  const created = await client.query(`INSERT INTO orders (vendor, vendor_order_number, order_date, subtotal, source_message_id, raw_email)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [vendor, order.orderNumber, order.orderDate ?? null, order.subtotal, messageId, rawText]);
  const orderId = created.rows[0].id as string;
  // Stable part ordering avoids deadlocks between multi-line orders sharing parts.
  const numbered = order.lines.map((line, i) => ({ line, number: i + 1 })).sort((a, b) => a.line.vendorPartNumber.toLowerCase().localeCompare(b.line.vendorPartNumber.toLowerCase()) || a.number - b.number);
  for (const { line, number } of numbered) {
    const result = await appendEntry(db, {
      part: parsePartRef(`${vendor}:${line.vendorPartNumber}`), entryType: 'purchase', quantity: line.quantity,
      unitCost: line.unitPrice, reference: order.orderNumber, idempotencyScope: ['purchase', orderId, String(number)],
      provenance: { ...provenance(run, reviewItemId ? 'resolve_review_item' : 'submit_order_email'), messageId, rawText, orderId, line: number, ...(reviewItemId ? { reviewItemId } : {}) },
      createdBy: run.agentId, createMissingPart: true, description: line.description,
    }, client);
    await client.query(`INSERT INTO order_lines (order_id,line_number,part_id,quantity,unit_price,line_total)
      VALUES ($1,$2,$3,$4,$5,round($4::numeric*$5::numeric,4))`, [orderId, number, result.part.partId, line.quantity, line.unitPrice]);
  }
  return { orderId, duplicate: false };
}
export async function submitOrderEmail(ctx: PluginContext, raw: unknown, run: ToolRunContext): Promise<ToolResult> {
  const input = object(raw);
  const messageId = text(input.messageId, 'Message id');
  text(input.rawText, 'Raw email', 1_000_000);
  const rawText = input.rawText as string;
  const vendorHint = input.vendor === undefined ? undefined : vendorKey(input.vendor);
  const enabled = parseEnabledVendors((await ctx.config.get(run.companyId)).enabledVendors);
  const parser = selectParser(rawText, vendorHint, enabled);
  const vendor = parser?.vendor ?? vendorHint ?? 'unknown';
  let agent: Extraction | undefined;
  let verifier: Extraction | undefined;
  let evidence: unknown;
  const reasons: string[] = [];
  if (vendorHint && parsers.some(p => p.vendor === vendorHint) && !parser) reasons.push('The named vendor parser is disabled or does not recognise this email');
  try { agent = extraction(input.agentExtraction); reasons.push(...reconcile(agent)); }
  catch { reasons.push('Agent extraction is invalid or incomplete'); }
  if (parser) {
    try { verifier = parser.parse(rawText); reasons.push(...reconcile(verifier)); }
    // A parser's own refusal says which layout or field defeated it, and that
    // is the first thing a reviewer needs; only unexpected failures fall back
    // to the generic wording.
    catch (error) { reasons.push(error instanceof InputError ? error.message : 'Vendor parser could not safely read this email layout'); }
    if (agent && verifier) reasons.push(...disagreements(agent, verifier));
  } else if (agent) {
    const second = independent(input, agent);
    verifier = second.extraction; evidence = second.evidence; reasons.push(...second.reasons);
    if (!vendorHint) reasons.push('Vendor must be specified when no parser identifies the email');
    // A known but disabled parser must not be bypassed using agent extraction.
    if (vendorHint && !enabled.includes(vendorHint as typeof enabled[number]) && ['mcmaster', 'sendcutsend'].includes(vendorHint)) reasons.push('Vendor parser is disabled in company configuration');
  }
  const db = await openStore(ctx, run.companyId);
  const result = await db.transaction(async client => {
    await lock(client, JSON.stringify(['message', messageId]));
    const existing = await disposition(client, messageId);
    if (existing) return existing;
    let orderId: string | null = null;
    let reviewItemId: string | null = null;
    let duplicate = false;
    if (!reasons.length && verifier) {
      await lock(client, JSON.stringify(['order', vendor, verifier.orderNumber.toLowerCase()]));
      const previous = await previousOrder(client, vendor, verifier);
      if (previous?.conflicts.length) reasons.push('Previously recorded order has different contents');
    }
    if (!reasons.length && agent && verifier) {
      const order = await recordOrder(db, client, vendor, verifier, messageId, rawText, run);
      orderId = order.orderId; duplicate = order.duplicate;
    } else {
      const queued = await client.query(`INSERT INTO review_queue (vendor,source_message_id,reason,parser_extraction,agent_extraction,raw_email)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6) RETURNING id`, [vendor, messageId, [...new Set(reasons)].join('; '), JSON.stringify(verifier ?? null), JSON.stringify(input.agentExtraction ?? null), rawText]);
      reviewItemId = queued.rows[0].id;
    }
    await client.query(`INSERT INTO email_intake (message_id,vendor,raw_email,agent_extraction,verifier_extraction,provenance,order_id,review_id)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)`, [messageId, vendor, rawText, JSON.stringify(input.agentExtraction ?? null), JSON.stringify(verifier ?? null), JSON.stringify({ ...provenance(run, 'submit_order_email'), parser: parser?.vendor, independent: evidence }), orderId, reviewItemId]);
    return { status: orderId ? 'recorded' : 'open', orderId, reviewItemId, duplicate };
  });
  return { content: result.orderId ? (result.duplicate ? 'Order already recorded; stock unchanged.' : 'Verified order recorded as on order.') : 'Email is in review; no ledger entries were written.', data: result };
}
export async function listReviewQueue(ctx: PluginContext, raw: unknown, run: ToolRunContext): Promise<ToolResult> {
  const input = object(raw);
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw new InputError('Limit must be an integer from 1 to 200.');
  const vendor = input.vendor === undefined ? null : vendorKey(input.vendor);
  const db = await openStore(ctx, run.companyId);
  const items = await db.query(`SELECT id,vendor,source_message_id,reason,parser_extraction,agent_extraction,raw_email,created_at,
    (SELECT provenance FROM email_intake i WHERE i.review_id=review_queue.id) AS intake_provenance
    FROM review_queue WHERE status='open' AND ($1::text IS NULL OR vendor=$1) ORDER BY created_at,id LIMIT $2`, [vendor, limit]);
  return { content: `${items.length} email(s) awaiting review.`, data: { items, count: items.length } };
}
export async function resolveReviewItem(ctx: PluginContext, raw: unknown, run: ToolRunContext): Promise<ToolResult> {
  const input = object(raw);
  const id = text(input.reviewItemId, 'Review item id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new InputError('Review item id must be a UUID.');
  const resolution = text(input.resolution, 'Resolution');
  if (!['accept', 'accept_with_corrections', 'reject'].includes(resolution)) throw new InputError('Unknown review resolution.');
  const note = text(input.note, 'Resolution note');
  const db = await openStore(ctx, run.companyId);
  const result = await db.transaction(async client => {
    const rows = await client.query('SELECT * FROM review_queue WHERE id=$1 FOR UPDATE', [id]);
    const item = rows.rows[0];
    if (!item) throw new InputError('Review item was not found.');
    if (item.status !== 'open') {
      if (item.status !== (resolution === 'reject' ? 'rejected' : resolution === 'accept' ? 'accepted' : 'accepted_with_corrections')) throw new InputError('Review item already has a different final resolution.');
      return { reviewItemId: id, status: item.status, duplicate: true };
    }
    let selected: Extraction | undefined;
    let orderId: string | undefined;
    if (resolution !== 'reject') {
      selected = extraction(resolution === 'accept_with_corrections' ? input.corrections : item.agent_extraction);
      const reasons = reconcile(selected);
      if (resolution === 'accept' && item.parser_extraction) {
        const saved = extraction(item.parser_extraction);
        reasons.push(...reconcile(saved), ...disagreements(selected, saved));
      }
      const enabled = parseEnabledVendors((await ctx.config.get(run.companyId)).enabledVendors);
      const parser = selectParser(item.raw_email, item.vendor, enabled);
      if (!parser) reasons.push(...independent(input, selected).reasons);
      if (item.vendor === 'unknown') reasons.push('Reject and resubmit with an explicit vendor');
      if (['mcmaster','sendcutsend'].includes(item.vendor) && !enabled.includes(item.vendor)) reasons.push('Vendor parser is disabled');
      if (reasons.length) throw new InputError(`Cannot resolve: ${reasons.join('; ')}.`);
      const order = await recordOrder(db, client, item.vendor, selected, item.source_message_id, item.raw_email, run, id);
      orderId = order.orderId;
    }
    const status = resolution === 'reject' ? 'rejected' : resolution === 'accept' ? 'accepted' : 'accepted_with_corrections';
    await client.query(`UPDATE review_queue SET status=$2,resolution_note=$3,resolved_at=now(),resolved_by=$4,
      resolution_extraction=$5::jsonb,resolution_provenance=$6::jsonb,resolved_order_id=$7 WHERE id=$1`, [id, status, note, run.agentId, JSON.stringify(selected ?? null), JSON.stringify({ ...provenance(run, 'resolve_review_item'), independentExtraction: input.independentExtraction, agentModel: input.agentModel, parserDisagreements: selected && item.parser_extraction ? disagreements(extraction(item.parser_extraction), selected) : [] }), orderId ?? null]);
    // Retain review_id for audit, so disposition derives the accepted order through it.
    return { reviewItemId: id, status, orderId, duplicate: false };
  });
  return { content: `Review item ${result.status}.`, data: result };
}
