import { generateKeyPairSync } from 'node:crypto';
import { createTestHarness } from '@paperclipai/plugin-sdk/testing';
import manifest from '../src/manifest.js';
import plugin from '../src/worker.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolRunContext } from '@paperclipai/plugin-sdk';
import { synchronizeSheet, INVENTORY_HEADERS, ADJUSTMENT_HEADERS, REVIEW_HEADERS } from '../src/sheet-sync.js';
import { writeCells, cellValue, parseSheetSettings, type SheetSnapshot, type SheetsClient, type CellValue, type SheetTab, type GridCell } from '../src/sheets-client.js';
import { appendEntry, readStock } from '../src/ledger.js';
import { freshSchema, dropSchema, integration, exec, type TestSchema } from './support/database.js';
const run = { companyId: 'synthetic-company', agentId: 'synthetic-agent', runId: 'synthetic-run' } as ToolRunContext;
const sheetId = 'synthetic-spreadsheet';
function cells(values: CellValue[]): GridCell[] {
  return (writeCells(1, 0, 0, [values]) as any).updateCells.rows[0].values;
}
function tab(id: number, title: string, rows: CellValue[][]): SheetTab {
  return { properties: { sheetId: id, title, gridProperties: { rowCount: 1000, columnCount: 26 } }, data: [{ rowData: rows.map(row => ({ values: cells(row) })) }] };
}
class FakeSheets implements SheetsClient {
  email = 'robot@example.invalid';
  snapshot: SheetSnapshot = { sheets: [] };
  batches: Record<string, any>[][] = [];
  fail = false;
  async read() { return structuredClone(this.snapshot); }
  async batch(requests: Record<string, any>[]) {
    this.batches.push(requests);
    if (this.fail) throw new Error('synthetic Sheets outage');
    for (const req of requests) {
      if (req.addSheet) this.snapshot.sheets.push({ properties: req.addSheet.properties });
      if (req.updateSheetProperties) {
        const props = req.updateSheetProperties.properties;
        this.snapshot.sheets.find(t => t.properties.sheetId === props.sheetId)!.properties.gridProperties = props.gridProperties;
      }
      if (req.updateCells) {
        const { start, rows } = req.updateCells;
        const t = this.snapshot.sheets.find(t => t.properties.sheetId === start.sheetId)!;
        t.data ??= [{ rowData: [] }];
        const target = t.data[0].rowData ??= [];
        for (const [i, row] of rows.entries()) {
          target[start.rowIndex + i] ??= { values: [] };
          const dest = target[start.rowIndex + i].values!;
          row.values.forEach((cell: GridCell, j: number) => dest[start.columnIndex + j] = cell);
        }
      }
      if (req.addProtectedRange) {
        const p = req.addProtectedRange.protectedRange;
        const t = this.snapshot.sheets.find(t => t.properties.sheetId === p.range.sheetId)!;
        t.protectedRanges ??= [];
        t.protectedRanges.push({ protectedRangeId: t.protectedRanges.length + 1, description: p.description });
      }
    }
  }
  rows(title: string) { return this.snapshot.sheets.find(t => t.properties.title === title)!.data![0].rowData!; }
  setRows(title: string, rows: CellValue[][]) {
    const t = this.snapshot.sheets.find(t => t.properties.title === title)!;
    t.data = [{ rowData: rows.map(row => ({ values: cells(row) })) }];
  }
}

describe('Sheet boundary safety', () => {
  it('requires a spreadsheet ID and a secret binding, never a raw credential', () => {
    expect(() => parseSheetSettings({})).toThrow(/spreadsheet ID/);
    expect(() => parseSheetSettings({ spreadsheetId: sheetId, googleServiceAccount: 'private-key' })).toThrow(/Paperclip secret/);
    expect(parseSheetSettings({ spreadsheetId: sheetId, googleServiceAccount: { type: 'secret_ref', secretId: 'synthetic-key' } }).spreadsheetId).toBe(sheetId);
  });
  it.each([
    [11, { userEnteredValue: { numberValue: -1 } }, 'reorderPoint cannot be negative'],
    [12, { userEnteredValue: { numberValue: -1 } }, 'targetQty cannot be negative'],
    [11, { userEnteredValue: { stringValue: 'invalid' } }, 'reorderPoint'],
    [15, { userEnteredValue: { stringValue: 'yes' } }, 'active must be a checkbox boolean'],
    [13, { userEnteredValue: { stringValue: 'x'.repeat(5001) } }, 'location'],
    [14, { userEnteredValue: { stringValue: 'x'.repeat(5001) } }, 'notes'],
    [11, { userEnteredValue: { formulaValue: '=1' } }, 'human settings'],
    [12, { effectiveValue: { errorValue: { type: 'VALUE', message: 'Invalid' } } }, 'human settings'],
  ])('identifies the Inventory settings row for column %s', async (column, invalidCell, message) => {
    const sheets = new FakeSheets();
    const id = '11111111-1111-4111-8111-111111111111';
    sheets.snapshot.sheets = [tab(1, 'Inventory', [INVENTORY_HEADERS, [], [id]])];
    sheets.rows('Inventory')[2].values![column] = invalidCell as GridCell;
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const release = vi.fn();
    const transaction = vi.fn();
    const db = { schema: 'synthetic', pool: { connect: async () => ({ query, release }) }, transaction };
    await expect(synchronizeSheet(db as any, sheets, sheetId, run)).rejects.toThrow(`Inventory row 3 ${message}`);
    expect(transaction).not.toHaveBeenCalled();
    expect(sheets.batches).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });
  it('writes formula-looking text as literal string cells', () => {
    const result = writeCells(1, 1, 0, [['=IMPORTXML("https://example.invalid")', 3, false]]) as any;
    expect(result.updateCells.rows[0].values.map((c: any) => c.userEnteredValue)).toEqual([{ stringValue: '=IMPORTXML("https://example.invalid")' }, { numberValue: 3 }, { boolValue: false }]);
  });
});

integration('Sheet sync against PostgreSQL', () => {
  let t: TestSchema;
  let sheets: FakeSheets;
  let partId: string;
  beforeEach(async () => {
    t = await freshSchema(); sheets = new FakeSheets();
    const entry = await appendEntry(t.db, { part: { kind: 'vendor', vendor: 'vendor-a', vendorPartNumber: 'part-001', ref: 'vendor-a:part-001' }, entryType: 'receipt', quantity: 10, reference: 'synthetic-opening', provenance: { source: 'test' }, createdBy: 'test', createMissingPart: true });
    partId = entry.part.partId;
  });
  afterEach(async () => { vi.unstubAllGlobals(); await dropSchema(t); });
  const sync = (dryRun = false) => synchronizeSheet(t.db, sheets, sheetId, run, dryRun);
  const countRow = (id = 'count-001', qty = 7): CellValue[] => [id, partId, qty, 'Synthetic physical count', '2026-10-17T00:00:00Z', 'Test counter'];
  async function withCount(qty = 7) {
    await sync(); sheets.setRows('Adjustments', [ADJUSTMENT_HEADERS, countRow('count-001', qty)]);
  }
  async function counts() { return exec(t, 'SELECT * FROM sheet_counts'); }
  async function onHand() { return (await readStock(t.db))[0].onHand; }
  it('runs the registered sync_sheet tool through configuration, secret resolution, Google HTTP and PostgreSQL', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = JSON.stringify({ type: 'service_account', client_email: sheets.email, private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    const harness = createTestHarness({ manifest, config: {
      databaseUrl: { type: 'secret_ref', secretId: 'db' }, databaseSchema: t.schema,
      spreadsheetId: sheetId, googleServiceAccount: { type: 'secret_ref', secretId: 'google' },
    } });
    harness.ctx.secrets.resolve = async ref => (ref as {secretId: string}).secretId === 'db' ? process.env.INVENTORY_TEST_DATABASE_URL! : key;
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
      if (url.endsWith('/token')) return Response.json({ access_token: 'synthetic-token' });
      if (url.endsWith(':batchUpdate')) { await sheets.batch(JSON.parse(options!.body as string).requests); return Response.json({}); }
      return Response.json(await sheets.read());
    });
    await plugin.definition.setup(harness.ctx);
    const result = await harness.executeTool('sync_sheet', {}, { companyId: t.poolKey, agentId: 'test', runId: 'test-run' }) as any;
    expect(result.error).toBeUndefined();
    expect(result.data.inventoryParts).toBe(1);
    expect(sheets.snapshot.sheets).toHaveLength(3);
    const bad = await harness.executeTool('sync_sheet', { dryRun: 'true' }, { companyId: t.poolKey }) as any;
    expect(bad.error).toContain('boolean');
  });
  it('creates only three managed tabs and protects system columns with restrictive editors', async () => {
    const result = await sync();
    expect(result.inventoryParts).toBe(1);
    expect(sheets.snapshot.sheets.map(t => t.properties.title)).toEqual(['Inventory', 'Adjustments', 'Needs Review']);
    const protections = sheets.batches[0].filter(r => r.addProtectedRange).map(r => r.addProtectedRange.protectedRange);
    expect(protections).toHaveLength(6);
    expect(protections.every(p => p.warningOnly === false && p.editors.users[0] === sheets.email)).toBe(true);
    expect(protections.find(p => p.description.endsWith('Inventory:system')).range).toMatchObject({ startColumnIndex: 0, endColumnIndex: 11 });
    await sync();
    expect(sheets.batches[1].filter(r => r.addProtectedRange)).toHaveLength(0);
    expect(sheets.batches[1].filter(r => r.updateProtectedRange)).toHaveLength(6);
  });
  it('reads human settings without writing them, preserves row identity and blank values', async () => {
    await sync();
    const human = [3, 20, 'Shelf 1', 'Synthetic note', false];
    const original = sheets.rows('Inventory')[1].values!.map(c => cellValue(c) ?? '');
    sheets.setRows('Inventory', [INVENTORY_HEADERS, [...original, ...human]]);
    await sync(); await sync();
    expect(sheets.rows('Inventory')).toHaveLength(2);
    expect(sheets.rows('Inventory')[1].values!.slice(11).map(cellValue)).toEqual(human);
    expect((await exec(t, 'SELECT settings FROM part_sheet_settings'))[0].settings).toEqual({ reorderPoint: 3, targetQty: 20, location: 'Shelf 1', notes: 'Synthetic note', active: false });
    for (const req of sheets.batches.slice(1).flat()) if (req.updateCells?.start.sheetId === 1) {
      expect(req.updateCells.start.columnIndex).toBe(0);
      expect(req.updateCells.rows[0].values.length).toBe(11);
    }
  });
  it('preserves unassigned human settings and scratch cells while appending new parts', async () => {
    await sync();
    const managed = sheets.rows('Inventory')[1].values!.map(c => cellValue(c) ?? '');
    const reorder = [...Array(11).fill(''), 5];
    const scratch = [...Array(16).fill(''), 'scratch'];
    sheets.setRows('Inventory', [INVENTORY_HEADERS, managed, reorder, scratch]);
    await appendEntry(t.db, { part: { kind: 'vendor', vendor: 'vendor-a', vendorPartNumber: 'part-002', ref: 'vendor-a:part-002' }, entryType: 'receipt', quantity: 2, reference: 'new-part', provenance: { source: 'test' }, createdBy: 'test', createMissingPart: true });
    await withCount(); await sync(); await sync();
    expect(sheets.rows('Inventory')[2].values!.map(cellValue)).toEqual(reorder);
    expect(sheets.rows('Inventory')[3].values!.map(cellValue)).toEqual(scratch);
    expect(cellValue(sheets.rows('Inventory')[4].values![1])).toBe('vendor-a:part-002');
    expect(await exec(t, 'SELECT * FROM part_sheet_settings')).toHaveLength(2);
    expect(await counts()).toHaveLength(1);
  });
  it('rejects system values without a Part ID before writing', async () => {
    await sync();
    sheets.setRows('Inventory', [INVENTORY_HEADERS, ['', 'orphaned system value']]);
    await expect(sync()).rejects.toThrow(/Inventory row 2 has system values but no Part ID/);
    expect(sheets.batches).toHaveLength(1);
  });
  it('ignores cleared count inputs with protected status and retains durable deduplication', async () => {
    await withCount(); await sync();
    const status = sheets.rows('Adjustments')[1].values!.slice(6, 8).map(c => cellValue(c)!);
    const cleared = [...Array(6).fill(''), ...status];
    sheets.setRows('Adjustments', [ADJUSTMENT_HEADERS, cleared, countRow('count-002', 8)]);
    await exec(t, "INSERT INTO review_queue(reason) VALUES ('Synthetic review')");
    const result = await sync();
    expect(result.openReviews).toBe(1); expect(result.countsProcessed).toBe(1);
    expect(sheets.rows('Adjustments')[1].values!.map(cellValue)).toEqual(cleared);
    expect(cellValue(sheets.rows('Inventory')[1].values![4])).toBe(8);
    expect(sheets.rows('Needs Review')).toHaveLength(2);
    sheets.setRows('Adjustments', [ADJUSTMENT_HEADERS, countRow(), countRow('count-002', 8)]);
    expect((await sync()).countsReplayed).toBe(2);
    expect(await onHand()).toBe(8); expect(await counts()).toHaveLength(2);
    expect(await exec(t, "SELECT id FROM ledger_entries WHERE entry_type='adjustment'")).toHaveLength(2);
  });
  it.each([3, 4, 5])('identifies the row for invalid count input in column %i', async column => {
    await withCount();
    const row = countRow(); row[column] = column === 4 ? 'invalid timestamp' : '';
    sheets.setRows('Adjustments', [ADJUSTMENT_HEADERS, row]);
    await expect(sync()).rejects.toThrow(/Adjustments row 2/);
    expect(await counts()).toHaveLength(0);
  });
  it('applies a physical count once, repairs status after publish failure, and ignores forged processed status', async () => {
    await withCount();
    sheets.fail = true;
    await expect(sync()).rejects.toThrow(/outage/);
    expect(await onHand()).toBe(7); expect(await counts()).toHaveLength(1);
    // An intervening receipt must survive retry of the old count.
    await appendEntry(t.db, { part: { kind: 'id', id: partId }, entryType: 'receipt', quantity: 2, reference: 'later', provenance: { source: 'test' }, createdBy: 'test' });
    sheets.fail = false;
    const replay = await sync();
    expect(replay.countsReplayed).toBe(1); expect(await onHand()).toBe(9);
    expect(cellValue(sheets.rows('Adjustments')[1].values![7])).toBe('Processed: -3');
    sheets.setRows('Adjustments', [ADJUSTMENT_HEADERS, [...countRow('count-002', 8), 'forged', 'Processed']]);
    await sync(); expect(await onHand()).toBe(8); expect(await counts()).toHaveLength(2);
  });
  it('retains zero-delta count receipts across retries and later movements', async () => {
    await withCount(10); await sync();
    await appendEntry(t.db, { part: { kind: 'id', id: partId }, entryType: 'receipt', quantity: 1, reference: 'later', provenance: { source: 'test' }, createdBy: 'test' });
    await sync(); expect(await onHand()).toBe(11);
    expect((await counts())[0].ledger_entry_id).toBeNull();
  });
  it('serializes concurrent syncs and keeps one count and adjustment', async () => {
    await withCount();
    await Promise.all([sync(), sync()]);
    expect(await onHand()).toBe(7); expect(await counts()).toHaveLength(1);
    expect(await exec(t, "SELECT id FROM ledger_entries WHERE entry_type='adjustment'")).toHaveLength(1);
  });
  it('rejects edited count inputs without changing history', async () => {
    await withCount(); await sync();
    sheets.setRows('Adjustments', [ADJUSTMENT_HEADERS, countRow('count-001', 9)]);
    await expect(sync()).rejects.toThrow(/different inputs/);
    expect(await onHand()).toBe(7); expect(await counts()).toHaveLength(1);
  });
  it('rejects duplicate count IDs before any changes', async () => {
    await withCount(); sheets.setRows('Adjustments', [ADJUSTMENT_HEADERS, countRow(), countRow()]);
    await expect(sync()).rejects.toThrow(/Duplicate Count ID/);
    expect(await onHand()).toBe(10); expect(await counts()).toHaveLength(0);
  });
  it('rolls back earlier counts if a later immutable count conflicts', async () => {
    await withCount(); await sync();
    sheets.setRows('Adjustments', [ADJUSTMENT_HEADERS, countRow('count-002', 4), countRow('count-001', 9)]);
    await expect(sync()).rejects.toThrow(/different inputs/);
    expect(await onHand()).toBe(7); expect(await counts()).toHaveLength(1);
  });
  it('dry run writes neither Sheet, count receipts, settings nor ledger', async () => {
    await withCount(); const before = sheets.batches.length;
    const result = await sync(true);
    expect(result.countsProcessed).toBe(1); expect(sheets.batches).toHaveLength(before);
    expect(await counts()).toHaveLength(0); expect(await onHand()).toBe(10);
    expect(await exec(t, 'SELECT * FROM part_sheet_settings')).toHaveLength(0);
  });
  it('exposes every open review with both extractions and clears resolved items', async () => {
    await exec(t, `INSERT INTO review_queue(reason,parser_extraction,agent_extraction) VALUES ('Synthetic mismatch','{"quantity":2}','{"quantity":3}')`);
    await sync();
    expect(sheets.rows('Needs Review')[1].values!.map(cellValue).slice(3,6)).toEqual(['Synthetic mismatch', '{"quantity":2}', '{"quantity":3}']);
    await exec(t, "UPDATE review_queue SET status='rejected',resolved_at=now() WHERE status='open'");
    const result = await sync(); expect(result.openReviews).toBe(0);
    expect(sheets.rows('Needs Review')[1].values!.map(cellValue)).toEqual(Array(REVIEW_HEADERS.length).fill(''));
  });
  it('fails closed on reordered headers or duplicated Inventory IDs', async () => {
    await sync(); sheets.setRows('Inventory', [['Wrong headers']]);
    await expect(sync()).rejects.toThrow(/unexpected columns/);
    const row = [partId, 'vendor-a:part-001'];
    sheets.setRows('Inventory', [INVENTORY_HEADERS, row, row]);
    await expect(sync()).rejects.toThrow(/duplicate Part ID/);
    expect(sheets.batches).toHaveLength(1);
  });
  it('rejects formula physical counts, missing IDs, negative counts and fractional precision loss', async () => {
    await withCount();
    const bad = [countRow('', 7), countRow('negative', -1), countRow('precision', 0.00001)];
    for (const row of bad) {
      sheets.setRows('Adjustments', [ADJUSTMENT_HEADERS, row]);
      await expect(sync()).rejects.toThrow();
    }
    sheets.setRows('Adjustments', [ADJUSTMENT_HEADERS, countRow()]);
    sheets.rows('Adjustments')[1].values![2] = { userEnteredValue: { formulaValue: '=7' }, effectiveValue: { numberValue: 7 } };
    await expect(sync()).rejects.toThrow(/formulas/);
    expect(await counts()).toHaveLength(0); expect(await onHand()).toBe(10);
  });
  it('does not reuse cached settings to overwrite cleared human cells', async () => {
    await sync(); const row = sheets.rows('Inventory')[1].values!.map(c => cellValue(c) ?? '');
    sheets.setRows('Inventory', [INVENTORY_HEADERS, [...row, 2, 6, 'Shelf', 'note', true]]);
    await sync();
    sheets.setRows('Inventory', [INVENTORY_HEADERS, row]); await sync();
    expect((await exec(t, 'SELECT settings FROM part_sheet_settings'))[0].settings).toEqual({ reorderPoint: null, targetQty: null, location: null, notes: null, active: null });
    expect(sheets.rows('Inventory')[1].values!.length).toBe(11);
  });
});
