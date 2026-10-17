import { createSign } from 'node:crypto';
import type { PluginContext } from '@paperclipai/plugin-sdk';
import { isSecretRefBinding, ConfigError } from './config.js';
import { OperatorFacingError } from './errors.js';

export class SheetError extends OperatorFacingError {}
export type CellValue = string | number | boolean;
export interface GridCell {
  userEnteredValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean; formulaValue?: string };
  effectiveValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean; errorValue?: unknown };
}
export interface SheetTab {
  properties: { sheetId: number; title: string; gridProperties: { rowCount: number; columnCount: number } };
  protectedRanges?: { protectedRangeId: number; description?: string }[];
  data?: { startRow?: number; startColumn?: number; rowData?: { values?: GridCell[] }[] }[];
}
export interface SheetSnapshot { sheets: SheetTab[] }
export interface SheetsClient {
  email: string;
  read(): Promise<SheetSnapshot>;
  batch(requests: Record<string, unknown>[]): Promise<void>;
}
export interface SheetSettings { spreadsheetId: string; serviceAccount: import('@paperclipai/plugin-sdk').EnvSecretRefBinding }
export function parseSheetSettings(config: Record<string, unknown>): SheetSettings {
  const id = config.spreadsheetId;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{10,200}$/.test(id)) {
    throw new ConfigError('Configure the inventory spreadsheet ID from private settings before running sync_sheet.');
  }
  if (!isSecretRefBinding(config.googleServiceAccount)) {
    throw new ConfigError('Select a Paperclip secret containing the Google service-account JSON key. Share the spreadsheet with that service account as an editor.');
  }
  return { spreadsheetId: id, serviceAccount: config.googleServiceAccount };
}

/** Fixed Google endpoints: credential JSON must never supply a token destination. */
export async function googleSheetsClient(ctx: PluginContext, companyId: string, settings: SheetSettings): Promise<SheetsClient> {
  const raw = await ctx.secrets.resolve(settings.serviceAccount, { companyId, configPath: 'googleServiceAccount' });
  let key: { type?: string; client_email?: string; private_key?: string };
  try { key = JSON.parse(raw); } catch { throw new ConfigError('The Google service-account secret must contain a JSON key.'); }
  if (!key || typeof key !== 'object' || key.type !== 'service_account' || typeof key.client_email !== 'string' || !key.client_email.includes('@') || typeof key.private_key !== 'string') {
    throw new ConfigError('The Google service-account secret is missing its account identity or private key.');
  }
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  let assertion: string;
  try { assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url')}`; }
  catch { throw new ConfigError('The Google service-account private key could not sign a request.'); }
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!tokenResponse.ok) throw new SheetError('Google rejected the service-account credentials. Check the Paperclip secret.');
  const token = await tokenResponse.json() as { access_token?: string };
  if (!token.access_token) throw new SheetError('Google did not return a service-account access token.');
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(settings.spreadsheetId)}`;
  const request = async (url: string, body?: unknown) => {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new SheetError(`Google Sheets request failed (HTTP ${response.status}). Check sharing, protected-range permissions and API access; rerun sync_sheet safely after fixing it.`);
    return response.json();
  };
  return {
    email: key.client_email,
    read: async () => await request(`${base}?includeGridData=true`) as SheetSnapshot,
    batch: async requests => { if (requests.length) await request(`${base}:batchUpdate`, { requests }); },
  };
}

/** Typed cell writes never interpret a vendor description as a formula. */
export function writeCells(sheetId: number, row: number, column: number, values: CellValue[][]): Record<string, unknown> {
  return { updateCells: { start: { sheetId, rowIndex: row, columnIndex: column }, fields: 'userEnteredValue', rows: values.map(cells => ({ values: cells.map(value => ({ userEnteredValue: typeof value === 'number' ? { numberValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: value } })) })) } };
}
export function gridRows(tab: SheetTab): GridCell[][] {
  const rows: GridCell[][] = [];
  for (const block of tab.data ?? []) for (const [i, row] of (block.rowData ?? []).entries()) {
    const index = (block.startRow ?? 0) + i;
    rows[index] ??= [];
    for (const [j, cell] of (row.values ?? []).entries()) rows[index][(block.startColumn ?? 0) + j] = cell;
  }
  return rows;
}
export function cellValue(cell?: GridCell): CellValue | undefined {
  const value = cell?.effectiveValue ?? cell?.userEnteredValue;
  if (value && 'errorValue' in value) throw new SheetError('A spreadsheet cell contains an error. Fix it before syncing.');
  return value?.stringValue ?? value?.numberValue ?? value?.boolValue;
}
