import { beforeEach, afterEach, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestHarness, type TestHarness } from '@paperclipai/plugin-sdk/testing';
import manifest from '../src/manifest.js';
import plugin from '../src/worker.js';
import { selectParser } from '../src/parsers/index.js';
import { freshSchema, dropSchema, exec, integration, type TestSchema } from './support/database.js';
const rawText = readFileSync(new URL('./fixtures/mcmaster-synthetic.txt', import.meta.url), 'utf8');
const correct = () => selectParser(rawText)!.parse(rawText);
interface Result { error?: string; data?: Record<string, any> }
integration('verified email intake through the host harness', () => {
  let t: TestSchema;
  let harness: TestHarness;
  beforeEach(async () => {
    t = await freshSchema();
    harness = createTestHarness({ manifest, config: { databaseUrl: {type:'secret_ref', secretId:'test-db'}, databaseSchema:t.schema } });
    harness.ctx.secrets.resolve = async () => process.env.INVENTORY_TEST_DATABASE_URL!;
    await plugin.definition.setup(harness.ctx);
  });
  afterEach(async () => dropSchema(t));
  const call = (tool: string, params: Record<string, unknown>) => harness.executeTool<Result>(tool, params, {companyId:t.schema, agentId:'author',runId:'run-synthetic'});
  const submit = (overrides: Record<string, unknown> = {}) => call('submit_order_email', {messageId:'synthetic-message',rawText,agentExtraction:correct(),...overrides});
  const count = async (table: string) => Number((await exec(t, `SELECT count(*)::int AS n FROM ${table}`))[0]!.n);
  const resolve = (id: unknown, extra: Record<string, unknown> = {}) => call('resolve_review_item', {reviewItemId:id,resolution:'accept',note:'Checked against the source email',...extra});
  it('records verified purchases as on order, with exact provenance and no on-hand movement', async () => {
    const result = await submit();
    expect(result.error).toBeUndefined(); expect(result.data?.status).toBe('recorded');
    expect(await count('orders')).toBe(1); expect(await count('order_lines')).toBe(2); expect(await count('ledger_entries')).toBe(2);
    const rows = await exec(t,'SELECT on_hand_delta,on_order_delta,provenance FROM ledger_entries ORDER BY quantity_delta');
    expect(rows.map(r=>Number(r.on_hand_delta))).toEqual([0,0]);
    expect(rows.map(r=>Number(r.on_order_delta))).toEqual([2,4]);
    expect(rows[0]!.provenance).toMatchObject({agentId:'author',runId:'run-synthetic',messageId:'synthetic-message',rawText});
  });
  it('puts a deliberately wrong agent quantity into review without creating even a part', async () => {
    const wrong = correct(); wrong.lines[0]!.quantity = 400;
    const result = await submit({agentExtraction:wrong});
    expect(result.data?.status).toBe('open'); expect(await count('review_queue')).toBe(1);
    expect(await count('ledger_entries')).toBe(0); expect(await count('parts')).toBe(0); expect(await count('orders')).toBe(0);
    const listed = await call('list_review_queue',{});
    expect(listed.data?.items[0]).toMatchObject({agent_extraction:wrong, parser_extraction:correct()});
  });
  it('rejects a matching pair whose lines do not reconcile to the printed subtotal', async () => {
    const text = rawText.replace('Subtotal: $10.00','Subtotal: $11.00');
    const result = await submit({rawText:text,agentExtraction:selectParser(text)!.parse(text)});
    expect(result.data?.status).toBe('open'); expect(await count('ledger_entries')).toBe(0);
  });
  it('fails closed for an unrecognised vendor layout or invalid extraction', async () => {
    const result = await submit({rawText:'McMaster-Carr\nUnrecognised format'});
    expect(result.data?.status).toBe('open');
    const bad = await submit({messageId:'invalid', agentExtraction:{lines:[]}});
    expect(bad.data?.status).toBe('open'); expect(await count('ledger_entries')).toBe(0);
  });
  it('serialises twelve concurrent retries of the same message', async () => {
    const results = await Promise.all(Array.from({length:12},()=>submit()));
    expect(results.every(r=>!r.error)).toBe(true); expect(await count('ledger_entries')).toBe(2); expect(await count('email_intake')).toBe(1);
  });
  it('deduplicates concurrent alias messages and case variants of the same vendor order', async () => {
    await Promise.all(Array.from({length:8},(_,i)=>submit({messageId:`alias-${i}`})));
    const x = correct(); x.orderNumber = x.orderNumber.toLowerCase();
    expect((await submit({messageId:'case',rawText:rawText.replace('SYNTH-MC-100','synth-mc-100'),agentExtraction:x})).error).toBeUndefined();
    expect(await count('ledger_entries')).toBe(2); expect(await count('orders')).toBe(1); expect(await count('email_intake')).toBe(9);
  });
  it('queues a changed alias order instead of silently discarding new quantities', async () => {
    await submit();
    const changedText = rawText.replace('4 | $2.25 | $9.00','8 | $2.25 | $18.00').replace('Subtotal: $10.00','Subtotal: $19.00');
    const result = await submit({messageId:'changed',rawText:changedText,agentExtraction:selectParser(changedText)!.parse(changedText)});
    expect(result.data?.status).toBe('open'); expect(await count('ledger_entries')).toBe(2);
  });
  it('requires a different model and independent extraction run for an unsupported vendor', async () => {
    const params = {vendor:'vendor-synthetic',rawText:'Unsupported synthetic order',agentModel:'model-a'};
    const first = await submit(params); expect(first.data?.status).toBe('open');
    const same = await submit({...params,messageId:'same-model',independentExtraction:{model:'model-a',extractionId:'second-run',extraction:correct()}});
    expect(same.data?.status).toBe('open'); expect(await count('ledger_entries')).toBe(0);
    const result = await submit({...params,messageId:'independent',independentExtraction:{model:'model-b',extractionId:'independent-run',extraction:correct()}});
    expect(result.error).toBeUndefined(); expect(result.data?.status).toBe('recorded'); expect(await count('ledger_entries')).toBe(2);
  });
  it('does not bypass independent extraction when accepting an unsupported vendor', async () => {
    const queued = await submit({vendor:'vendor-synthetic',rawText:'Unknown layout'});
    const blocked = await resolve(queued.data?.reviewItemId);
    expect(blocked.error).toContain('independent'); expect(await count('ledger_entries')).toBe(0);
    const ok = await resolve(queued.data?.reviewItemId,{agentModel:'model-a',independentExtraction:{model:'model-b',extractionId:'run-b',extraction:correct()}});
    expect(ok.error).toBeUndefined(); expect(await count('ledger_entries')).toBe(2);
  });
  it('rejects without writes and never reopens a rejected message on retry', async () => {
    const wrong = correct(); wrong.lines[0]!.quantity=40;
    const first = await submit({agentExtraction:wrong});
    expect((await resolve(first.data?.reviewItemId,{resolution:'reject'})).data?.status).toBe('rejected');
    const retry = await submit(); expect(retry.data?.status).toBe('rejected'); expect(retry.data?.duplicate).toBe(true);
    expect(await count('ledger_entries')).toBe(0); expect(await count('review_queue')).toBe(1);
  });
  it('requires reconciled corrections, then resolves once with an authenticated audit trail', async () => {
    const wrong = correct(); wrong.lines[0]!.quantity=40;
    const queued = await submit({agentExtraction:wrong});
    const id = queued.data?.reviewItemId;
    expect((await resolve(id)).error).toContain('reconcile');
    const results = await Promise.all(Array.from({length:4},()=>resolve(id,{resolution:'accept_with_corrections',corrections:correct()})));
    expect(results.every(r=>!r.error)).toBe(true); expect(await count('ledger_entries')).toBe(2);
    const row = (await exec(t,'SELECT * FROM review_queue'))[0]!;
    expect(row.resolved_by).toBe('author'); expect(row.resolution_extraction).toEqual(correct());
    expect(row.agent_extraction).toEqual(wrong);
  });
  it('reports the recorded order on retries after corrected review, including aliases', async () => {
    const recorded = await submit();
    const wrong = correct(); wrong.lines[0]!.quantity = 40;
    const queued = await submit({messageId:'review-alias',agentExtraction:wrong});
    const resolved = await resolve(queued.data?.reviewItemId,{resolution:'accept_with_corrections',corrections:correct()});
    const retry = await submit({messageId:'review-alias'});
    expect(resolved.data?.orderId).toBe(recorded.data?.orderId);
    expect(retry.data).toMatchObject({status:'recorded',orderId:recorded.data?.orderId,duplicate:true,reviewItemId:queued.data?.reviewItemId});
    expect(await count('ledger_entries')).toBe(2);
  });
  it('requires corrections to override a reconciled disagreement with the saved parser', async () => {
    const wrong = correct(); wrong.lines[0]!.quantity = 8; wrong.lines[0]!.unitPrice = 1.125;
    const queued = await submit({agentExtraction:wrong});
    expect((await resolve(queued.data?.reviewItemId)).error).toContain('Cannot resolve');
    expect(await count('ledger_entries')).toBe(0);
    expect((await resolve(queued.data?.reviewItemId,{resolution:'accept_with_corrections',corrections:correct()})).error).toBeUndefined();
    const retry = await submit();
    expect(retry.data?.orderId).toBeTruthy(); expect(retry.data?.status).toBe('recorded');
    expect(await count('ledger_entries')).toBe(2);
  });
  it('backfills legacy accepted reviews for original and alias messages on upgrade', async () => {
    const wrong = correct(); wrong.lines[0]!.quantity=40;
    for (const messageId of ['original-review','alias-review']) {
      const queued = await submit({messageId,agentExtraction:wrong});
      expect((await resolve(queued.data?.reviewItemId,{resolution:'accept_with_corrections',corrections:correct()})).error).toBeUndefined();
    }
    await exec(t,'ALTER TABLE review_queue DROP COLUMN resolved_order_id');
    await exec(t,'DROP INDEX email_intake_review_id_idx');
    await exec(t,'DROP INDEX email_intake_order_id_idx');
    await exec(t,readFileSync(new URL('../migrations/0010_review_disposition.sql',import.meta.url),'utf8'));
    const rows = await exec(t,'SELECT resolved_order_id FROM review_queue');
    expect(rows.every(r=>r.resolved_order_id)).toBe(true);
    expect(new Set(rows.map(r=>r.resolved_order_id)).size).toBe(1);
  });
  it('rejects malformed UUIDs before database access', async () => {
    expect((await resolve('-'.repeat(36))).error).toContain('must be a UUID');
  });
  it('rolls back every line, part and order if a later ledger insert fails', async () => {
    await exec(t,`CREATE FUNCTION fail_second() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.quantity_delta=2 THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$`);
    await exec(t,'CREATE TRIGGER fail_second BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION fail_second()');
    expect((await submit()).error).toBe('The inventory request failed.');
    for (const table of ['parts','orders','order_lines','ledger_entries','email_intake']) expect(await count(table),table).toBe(0);
  });
  it('receipts discharge purchases using the vendor order reference', async () => {
    await submit();
    await call('record_receipt',{partId:'mcmaster:synth-mc-a',quantity:4,reference:correct().orderNumber});
    const stock = await call('get_stock',{partId:'mcmaster:SYNTH-MC-A'});
    expect(stock.data?.parts[0]).toMatchObject({onHand:4,onOrder:0});
  });
});
