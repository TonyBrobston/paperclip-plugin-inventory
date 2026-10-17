import type { PluginContext, ToolRunContext, ToolResult } from '@paperclipai/plugin-sdk';
import type { PoolClient } from 'pg';
import type { DatabaseHandle } from './db.js';
import { InputError } from './errors.js';
import { appendEntry } from './ledger.js';
import { parseQuantity, toNumber } from './quantity.js';
import { openStore } from './storage.js';
import { cellValue, googleSheetsClient, gridRows, parseSheetSettings, SheetError, writeCells, type CellValue, type GridCell, type SheetsClient, type SheetTab } from './sheets-client.js';

export const INVENTORY_HEADERS = ['Part ID', 'Part', 'Description', 'Unit', 'On hand', 'Committed', 'On order', 'Sellable impact', 'Last cost', 'Avg cost', 'Last ordered', 'Reorder point', 'Target qty', 'Location', 'Notes', 'Active'];
export const ADJUSTMENT_HEADERS = ['Count ID', 'Part ID', 'Physical count', 'Reason', 'Counted at', 'Counted by', 'Processed at', 'Result'];
export const REVIEW_HEADERS = ['Review ID', 'Vendor', 'Message ID', 'Reason', 'Parser extraction', 'Agent extraction', 'Created at'];
const MANAGED = 'inventory-plugin:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface Count { row: number; id: string; partId: string; count: number; reason: string; countedAt: string; countedBy: string }
function text(value: CellValue | undefined, label: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new SheetError(`${label} must be nonblank text (at most ${max} characters).`);
  return value.trim();
}
function values(row: GridCell[] = []): (CellValue | undefined)[] { return row.map(cellValue); }
function populated(row: GridCell[] = []): boolean { return row.some(cell => cellValue(cell) !== undefined && cellValue(cell) !== ''); }
function validateHeader(tab: SheetTab, expected: string[]): void {
  const rows = gridRows(tab);
  if (!rows.some(populated)) return;
  if (expected.some((label, i) => cellValue(rows[0]?.[i]) !== label)) {
    throw new SheetError(`${tab.properties.title} has unexpected columns. Restore the documented header order; no cells or ledger entries were changed.`);
  }
}
function validateInputCells(row: GridCell[], label: string): void {
  if (row.some(cell => cell?.userEnteredValue?.formulaValue !== undefined)) throw new SheetError(`${label} contains formulas. Enter literal values before syncing.`);
}
function parseCounts(rows: GridCell[][]): Count[] {
  const counts: Count[] = [];
  const ids = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (!populated(row.slice(0, 6))) continue;
    validateInputCells(row.slice(0, 6), `Adjustments row ${i + 1}`);
    const cells = values(row);
    const id = text(cells[0], `Adjustments row ${i + 1} Count ID`, 100);
    if (ids.has(id)) throw new SheetError(`Duplicate Count ID in Adjustments row ${i + 1}. Give each physical count a unique ID.`);
    ids.add(id);
    const partId = text(cells[1], `Adjustments row ${i + 1} Part ID`).toLowerCase();
    if (!UUID.test(partId)) throw new SheetError(`Adjustments row ${i + 1} requires the Inventory Part ID.`);
    const count = parseQuantity(cells[2], { label: `Adjustments row ${i + 1} physical count` });
    if (count < 0) throw new SheetError('Physical counts cannot be negative.');
    const countedAt = text(cells[4], `Adjustments row ${i + 1} Counted at`);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(countedAt) || !Number.isFinite(Date.parse(countedAt))) throw new SheetError(`Adjustments row ${i + 1} Counted at must be an ISO timestamp with a time zone.`);
    counts.push({ row: i, id, partId, count, reason: text(cells[3], `Adjustments row ${i + 1} Count reason`), countedAt, countedBy: text(cells[5], `Adjustments row ${i + 1} Counted by`) });
  }
  return counts;
}
function settingsOf(row: GridCell[], rowNumber: number): Record<string, CellValue | null> {
  const label = `Inventory row ${rowNumber}`;
  validateInputCells(row.slice(11, 16), `${label} human settings`);
  const cells = row.map(cell => {
    try { return cellValue(cell); }
    catch (error) {
      if (error instanceof SheetError) throw new SheetError(`${label} human settings: ${error.message}`);
      throw error;
    }
  });
  const result: Record<string, CellValue | null> = {};
  for (const [offset, name] of ['reorderPoint', 'targetQty', 'location', 'notes', 'active'].entries()) {
    const value = cells[11 + offset];
    if (value === undefined || value === '') { result[name] = null; continue; }
    if (offset < 2) {
      const qty = parseQuantity(value, { label: `${label} ${name}` });
      if (qty < 0) throw new SheetError(`${label} ${name} cannot be negative.`);
      result[name] = qty;
    } else if (offset === 4) {
      if (typeof value !== 'boolean') throw new SheetError(`${label} active must be a checkbox boolean.`);
      result[name] = value;
    } else result[name] = text(value, `${label} ${name}`, 5000);
  }
  return result;
}

/** Upsert only our own protection; never remove operator-created protections. */
function protect(tab: SheetTab, suffix: string, range: Record<string, unknown>, email: string): Record<string, unknown> {
  const description = MANAGED + suffix;
  const existing = tab.protectedRanges?.find(p => p.description === description);
  const protectedRange = { description, range: { sheetId: tab.properties.sheetId, ...range }, warningOnly: false, editors: { users: [email], domainUsersCanEdit: false } };
  return existing
    ? { updateProtectedRange: { protectedRange: { ...protectedRange, protectedRangeId: existing.protectedRangeId }, fields: 'range,description,warningOnly,editors' } }
    : { addProtectedRange: { protectedRange } };
}
function ensureSize(tab: SheetTab, rows: number, columns: number): Record<string, unknown>[] {
  const grid = tab.properties.gridProperties;
  if (grid.rowCount >= rows && grid.columnCount >= columns) return [];
  return [{ updateSheetProperties: { properties: { sheetId: tab.properties.sheetId, gridProperties: { rowCount: Math.max(grid.rowCount, rows), columnCount: Math.max(grid.columnCount, columns) } }, fields: 'gridProperties.rowCount,gridProperties.columnCount' } }];
}

/** A durable row receipt makes sheet status advisory; it is never the dedupe authority. */
async function applyCount(db: DatabaseHandle, client: PoolClient, spreadsheetId: string, count: Count, run: ToolRunContext, dryRun: boolean) {
  const prior = (await client.query('SELECT * FROM sheet_counts WHERE spreadsheet_id=$1 AND count_id=$2', [spreadsheetId, count.id])).rows[0];
  if (prior) {
    if (prior.part_id !== count.partId || toNumber(prior.physical_count) !== count.count || prior.reason !== count.reason || prior.counted_at !== count.countedAt || prior.counted_by !== count.countedBy) throw new SheetError(`Count ID ${count.id} was already processed with different inputs. Add a new Count ID to correct it.`);
    return { ...count, delta: toNumber(prior.delta), processedAt: (prior.processed_at as Date).toISOString(), duplicate: true };
  }
  await client.query('SELECT id FROM parts WHERE id=$1 FOR UPDATE', [count.partId]);
  const stock = (await client.query('SELECT on_hand FROM part_stock WHERE part_id=$1', [count.partId])).rows[0];
  if (!stock) throw new SheetError(`Count ID ${count.id} names an unknown part.`);
  const before = toNumber(stock.on_hand);
  const delta = parseQuantity(Math.round((count.count - before) * 10000) / 10000, { label: 'Physical-count adjustment' });
  let entryId: string | null = null;
  if (!dryRun && delta !== 0) {
    const entry = await appendEntry(db, {
      part: { kind: 'id', id: count.partId }, entryType: 'adjustment', quantity: delta,
      reference: `sheet-count:${count.id}`, idempotencyScope: ['sheet-count', spreadsheetId],
      note: count.reason, createdBy: run.agentId,
      provenance: { source: 'sync_sheet', companyId: run.companyId, agentId: run.agentId, runId: run.runId, spreadsheetId, countId: count.id, physicalCount: count.count, beforeCount: before, countedAt: count.countedAt, countedBy: count.countedBy },
    }, client);
    entryId = entry.entry.id;
  }
  const processedAt = new Date().toISOString();
  if (!dryRun) await client.query(`INSERT INTO sheet_counts (spreadsheet_id,count_id,part_id,physical_count,reason,counted_at,counted_by,before_count,delta,ledger_entry_id,processed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [spreadsheetId, count.id, count.partId, count.count, count.reason, count.countedAt, count.countedBy, before, delta, entryId, processedAt]);
  return { ...count, delta, processedAt, duplicate: false };
}

export async function synchronizeSheet(db: DatabaseHandle, sheets: SheetsClient, spreadsheetId: string, run: ToolRunContext, dryRun = false): Promise<Record<string, unknown>> {
  // Hold a session lock across the DB commit and Sheet publish, without making
  // the ledger transaction depend on the final network acknowledgement.
  const lock = await db.pool.connect();
  const lockKey = JSON.stringify(['inventory-sheet', db.schema, spreadsheetId]);
  try {
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    const snapshot = await sheets.read();
    const requests: Record<string, unknown>[] = [];
    let nextId = Math.max(0, ...snapshot.sheets.map(t => t.properties.sheetId)) + 1;
    const tab = (title: string, headers: string[]): SheetTab => {
      const existing = snapshot.sheets.find(t => t.properties.title === title);
      if (existing) { validateHeader(existing, headers); return existing; }
      const created = { properties: { sheetId: nextId++, title, gridProperties: { rowCount: 1000, columnCount: Math.max(26, headers.length) } } };
      requests.push({ addSheet: { properties: created.properties } });
      return created;
    };
    const inventory = tab('Inventory', INVENTORY_HEADERS);
    const adjustments = tab('Adjustments', ADJUSTMENT_HEADERS);
    const review = tab('Needs Review', REVIEW_HEADERS);
    const inventoryRows = gridRows(inventory);
    const counts = parseCounts(gridRows(adjustments));
    const rowMap = new Map<string, number>();
    const settings = new Map<string, Record<string, CellValue | null>>();
    for (let i = 1; i < inventoryRows.length; i++) {
      const row = inventoryRows[i] ?? [];
      const rawId = cellValue(row[0]);
      if (rawId === undefined || rawId === '') {
        if (populated(row.slice(0, 11))) throw new SheetError(`Inventory row ${i + 1} has system values but no Part ID. Restore its Part ID before syncing.`);
        continue;
      }
      const id = text(rawId, `Inventory row ${i + 1} Part ID`).toLowerCase();
      if (!UUID.test(id) || rowMap.has(id)) throw new SheetError(`Inventory row ${i + 1} has an invalid or duplicate Part ID. No rows were changed.`);
      rowMap.set(id, i);
      settings.set(id, settingsOf(row, i + 1));
    }
    const result = await db.transaction(async client => {
      const known = new Set((await client.query('SELECT id FROM parts')).rows.map(p => p.id));
      for (const id of rowMap.keys()) if (!known.has(id)) throw new SheetError('Inventory contains an unknown Part ID. Restore its original ID before syncing.');
      for (const count of counts) if (!known.has(count.partId)) throw new SheetError(`Count ID ${count.id} names an unknown part.`);
      // Consistent order across all physical counts avoids deadlocks with intake.
      const partIds = [...new Set(counts.map(c => c.partId))].sort();
      for (const id of partIds) await client.query('SELECT id FROM parts WHERE id=$1 FOR UPDATE', [id]);
      const processed = [];
      for (const count of counts) processed.push(await applyCount(db, client, spreadsheetId, count, run, dryRun));
      if (!dryRun) for (const [id, setting] of settings) await client.query(`INSERT INTO part_sheet_settings(spreadsheet_id,part_id,settings) VALUES ($1,$2,$3::jsonb) ON CONFLICT(spreadsheet_id,part_id) DO UPDATE SET settings=EXCLUDED.settings,synced_at=now()`, [spreadsheetId, id, JSON.stringify(setting)]);
      const stock = (await client.query(`SELECT s.*, costs.last_cost, costs.avg_cost, costs.last_ordered FROM part_stock s LEFT JOIN LATERAL (
        SELECT (array_agg(unit_cost ORDER BY created_at DESC,id DESC) FILTER (WHERE unit_cost IS NOT NULL))[1] AS last_cost,
        SUM(quantity_delta*unit_cost) FILTER (WHERE entry_type='purchase' AND unit_cost IS NOT NULL) / NULLIF(SUM(quantity_delta) FILTER (WHERE entry_type='purchase' AND unit_cost IS NOT NULL),0) AS avg_cost,
        MAX(created_at) FILTER (WHERE entry_type='purchase') AS last_ordered FROM ledger_entries WHERE part_id=s.part_id
      ) costs ON true ORDER BY s.vendor,s.vendor_part_number`)).rows;
      const reviews = (await client.query("SELECT id,vendor,source_message_id,reason,parser_extraction,agent_extraction,created_at FROM review_queue WHERE status='open' ORDER BY created_at,id")).rows;
      return { processed, stock, reviews };
    });
    let nextRow = Math.max(1, inventoryRows.length);
    for (const part of result.stock) {
      const row = rowMap.get(part.part_id) ?? nextRow++;
      rowMap.set(part.part_id, row);
      requests.push(writeCells(inventory.properties.sheetId, row, 0, [[part.part_id, `${part.vendor}:${part.vendor_part_number}`, part.description ?? '', part.unit_of_measure, toNumber(part.on_hand), toNumber(part.committed), toNumber(part.on_order), 'Pending BOM integration', part.last_cost === null ? '' : toNumber(part.last_cost), part.avg_cost === null ? '' : toNumber(part.avg_cost), part.last_ordered ? (part.last_ordered as Date).toISOString() : '']]));
    }
    for (const count of result.processed) requests.push(writeCells(adjustments.properties.sheetId, count.row, 6, [[count.processedAt, `Processed: ${count.delta >= 0 ? '+' : ''}${count.delta}`]]));
    const excerpt = (value: unknown) => { const json = JSON.stringify(value); return json.length <= 49000 ? json : json.slice(0, 48900) + '… [truncated; use list_review_queue for the full extraction]'; };
    const reviewValues: CellValue[][] = result.reviews.map(r => [r.id, r.vendor ?? '', r.source_message_id ?? '', r.reason, r.parser_extraction ? excerpt(r.parser_extraction) : '', r.agent_extraction ? excerpt(r.agent_extraction) : '', (r.created_at as Date).toISOString()]);
    // Clear stale resolved items while leaving other tabs and extra columns alone.
    const reviewLength = Math.max(reviewValues.length, gridRows(review).length - 1);
    while (reviewValues.length < reviewLength) reviewValues.push(Array(REVIEW_HEADERS.length).fill(''));
    if (reviewValues.length) requests.push(writeCells(review.properties.sheetId, 1, 0, reviewValues));
    const sizes = [...ensureSize(inventory, nextRow, INVENTORY_HEADERS.length), ...ensureSize(adjustments, Math.max(2, gridRows(adjustments).length), ADJUSTMENT_HEADERS.length), ...ensureSize(review, reviewLength + 1, REVIEW_HEADERS.length)];
    // Grid growth must precede value writes.
    requests.splice(requests.filter(r => 'addSheet' in r).length, 0, ...sizes);
    for (const [t, headers] of [[inventory, INVENTORY_HEADERS], [adjustments, ADJUSTMENT_HEADERS], [review, REVIEW_HEADERS]] as const) {
      // Human column headers are initialized only on an empty tab.
      if (!gridRows(t).some(populated)) requests.push(writeCells(t.properties.sheetId, 0, 0, [[...headers]]));
      requests.push(protect(t, `${t.properties.title}:header`, { startRowIndex: 0, endRowIndex: 1 }, sheets.email));
    }
    requests.push(protect(inventory, 'Inventory:system', { startColumnIndex: 0, endColumnIndex: 11 }, sheets.email));
    requests.push(protect(adjustments, 'Adjustments:status', { startColumnIndex: 6, endColumnIndex: 8 }, sheets.email));
    requests.push(protect(review, 'Needs Review:system', { startColumnIndex: 0, endColumnIndex: REVIEW_HEADERS.length }, sheets.email));
    if (!dryRun) await sheets.batch(requests);
    return { dryRun, inventoryParts: result.stock.length, settingsRead: settings.size, countsProcessed: result.processed.filter(c => !c.duplicate).length, countsReplayed: result.processed.filter(c => c.duplicate).length, openReviews: result.reviews.length, sellableImpact: 'Pending BOM integration' };
  } finally {
    try { await lock.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]); } finally { lock.release(); }
  }
}
export async function syncSheet(ctx: PluginContext, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new InputError('sync_sheet parameters must be an object.');
  const dryRun = (params as Record<string, unknown>).dryRun;
  if (dryRun !== undefined && typeof dryRun !== 'boolean') throw new InputError('dryRun must be a boolean.');
  const settings = parseSheetSettings(await ctx.config.get(run.companyId));
  const db = await openStore(ctx, run.companyId);
  const client = await googleSheetsClient(ctx, run.companyId, settings);
  const data = await synchronizeSheet(db, client, settings.spreadsheetId, run, dryRun === true);
  return { content: `${dryRun ? 'Previewed' : 'Synced'} inventory Sheet: ${data.inventoryParts} parts, ${data.countsProcessed} new counts, ${data.openReviews} open reviews. Sellable impact awaits BOM integration.`, data };
}
