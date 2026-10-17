/**
 * McMaster-Carr order emails, as they actually arrive.
 *
 * Two layouts were inspected from authorized samples, and they are not the
 * same document:
 *
 *   - **Confirmation**, from the regional sales address. Pipe-delimited cells
 *     with no header row. The order number is a cell of its own, carrying a
 *     link into order history. Quantities read `1 pack of 50`, unit prices
 *     read `4.00 pack`.
 *   - **Receipt**, from the invoicing address. A real bordered table headed
 *     `Line | | Product | Ordered | Shipped | Balance | Price | Total`. The
 *     order number is the `Purchase Order` field, quantities read `1 Pack` and
 *     unit prices read `4.00 Per Pack`.
 *
 * Neither layout prints anything resembling `Order Number:`, and the receipt
 * never spells "McMaster-Carr" in its body — only the `mcmaster.com` domain —
 * so vendor matching keys on the domain too.
 *
 * Two things are deliberate:
 *
 *   - **The reconcilable subtotal is `Merchandise`, not `Total`.** Total adds
 *     shipping and tax, which are not line items and must not reach the ledger
 *     as stock value.
 *   - **Quantity is the number of purchase units, not the number of pieces.**
 *     A pack of 50 screws is one line of quantity 1 at the pack price, because
 *     that is what the vendor charges for and what reconciles exactly against
 *     the printed figures. Dividing a pack price by its pack size to get a
 *     per-piece price invents precision the email does not contain (a $12.70
 *     pack of 3 has no exact per-piece price) and would turn a sound order
 *     into a false reconciliation failure. The pack size is preserved in the
 *     description so a later phase can expand packs into pieces on purpose.
 *
 * Anything that does not match these shapes raises, which routes the email to
 * review without touching stock.
 */
import type { VendorParser } from './types.js';
import { parseTable } from './table.js';
import { extraction, type OrderLine } from '../extraction.js';
import { InputError } from '../errors.js';

/** Cells of a pipe-delimited row, or undefined when the row is not one. */
function cells(row: string): string[] | undefined {
  const trimmed = row.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined;
  return trimmed.slice(1, -1).split('|').map(cell => cell.trim());
}

function amount(raw: string, label: string): number {
  const matched = /^\$?([\d,]+\.\d{2,4})$/.exec(raw.trim());
  if (!matched) throw new InputError(`Unreadable McMaster ${label} "${raw.trim()}"; independent review required.`);
  return Number(matched[1]!.replace(/,/g, ''));
}

/** `4.00 pack`, `4.00 Per Pack`, `1.25 each` or a bare amount. */
function unitPrice(raw: string): number {
  const matched = /^(\$?[\d,]+\.\d{2,4})(?:\s+(?:per\s+)?(?:pack|each))?$/i.exec(raw.trim());
  if (!matched) throw new InputError(`Unreadable McMaster unit price "${raw.trim()}"; independent review required.`);
  return amount(matched[1]!, 'unit price');
}

/**
 * `1 pack of 50`, `1 Pack`, `2 each` or a bare count.
 *
 * Returns the count of purchase units and, when the email says so, how many
 * pieces one of those units holds.
 */
function ordered(raw: string): { quantity: number; packSize?: number } {
  const trimmed = raw.trim();
  const pack = /^(\d+)\s+packs?\s+of\s+(\d+)$/i.exec(trimmed);
  if (pack) return { quantity: Number(pack[1]), packSize: Number(pack[2]) };
  const plain = /^(\d+)(?:\s+(?:packs?|each))?$/i.exec(trimmed);
  if (plain) return { quantity: Number(plain[1]) };
  throw new InputError(`Unreadable McMaster quantity "${trimmed}"; independent review required.`);
}

/** `<description> <PARTNUMBER>[](url)`, or a bare `<PARTNUMBER>[](url)` cell. */
function partLink(raw: string): { vendorPartNumber: string; description: string } | undefined {
  const matched = /^(.*?)\s*([0-9A-Za-z]+)\[\]\([^)]*\)$/.exec(raw.trim());
  return matched ? { vendorPartNumber: matched[2]!, description: matched[1]!.trim() } : undefined;
}

function describe(description: string, packSize?: number): string | undefined {
  const text = packSize === undefined ? description : `${description} (pack of ${packSize})`.trim();
  return text ? text : undefined;
}

/** `| | Merchandise | 9.00 |` and `| Merchandise | 9.00 |` both appear. */
function merchandise(raw: string): number | undefined {
  const matched = /^\|(?:\s*\|)*\s*Merchandise\s*\|\s*(\$?[\d,]+\.\d{2,4})\s*\|$/mi.exec(raw);
  return matched ? amount(matched[1]!, 'merchandise subtotal') : undefined;
}

function isConfirmation(raw: string): boolean {
  return /\[\]\(https?:\/\/[^)]*mcmaster\.com\/order-history\/order\/[^)]*\)/i.test(raw);
}

function receiptHeader(rows: readonly string[]): number {
  return rows.findIndex(row => {
    const row8 = cells(row);
    return !!row8 && row8.length === 8 && /^Line$/i.test(row8[0]!) && /^Product$/i.test(row8[2]!)
      && /^Ordered$/i.test(row8[3]!) && /^Price$/i.test(row8[6]!) && /^Total$/i.test(row8[7]!);
  });
}

function parseConfirmation(raw: string) {
  const orderNumber = /^\|\s*([0-9A-Za-z][0-9A-Za-z-]*)\[\]\(https?:\/\/[^)]*mcmaster\.com\/order-history\/order\/[^)]*\)\s*\|$/mi.exec(raw)?.[1];
  const date = /\bOrder date\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i.exec(raw);
  const orderDate = date ? `${date[3]}-${date[1]!.padStart(2, '0')}-${date[2]!.padStart(2, '0')}` : undefined;
  const lines: OrderLine[] = [];
  for (const row of raw.split(/\r?\n/)) {
    const cell = cells(row);
    // A confirmation line item is the only five-cell row numbered in column
    // one whose second cell links a part. Delivery dates are single cells and
    // the totals block has three, so neither is mistaken for stock.
    if (!cell || cell.length !== 5 || !/^\d+$/.test(cell[0]!)) continue;
    const part = partLink(cell[1]!);
    if (!part) continue;
    const { quantity, packSize } = ordered(cell[2]!);
    lines.push({
      vendorPartNumber: part.vendorPartNumber, quantity, unitPrice: unitPrice(cell[3]!),
      lineTotal: amount(cell[4]!, 'line total'),
      ...(describe(part.description, packSize) ? { description: describe(part.description, packSize)! } : {}),
    });
  }
  if (!lines.length) throw new InputError('No McMaster confirmation line items were recognised; independent review required.');
  return extraction({ orderNumber, orderDate, subtotal: merchandise(raw), lines });
}

function parseReceipt(raw: string, header: number) {
  const rows = raw.split(/\r?\n/);
  const orderNumber = /^\|\s*Purchase Order\s*\|\s*([0-9A-Za-z][0-9A-Za-z-]*)\s*\|$/mi.exec(raw)?.[1];
  const lines: OrderLine[] = [];
  for (const row of rows.slice(header + 1)) {
    const cell = cells(row);
    if (!cell || cell.length !== 8 || !/^\d+$/.test(cell[0]!)) continue;
    const part = partLink(cell[1]!);
    if (!part) continue;
    const { quantity, packSize } = ordered(cell[3]!);
    // A receipt's own product text already ends in `, Packs of 50`, so the
    // pack size only needs appending when the description omits it.
    const stated = /\bpacks?\s+of\s+\d+\b/i.test(cell[2]!);
    const described = describe(cell[2]!, stated ? undefined : packSize);
    lines.push({
      vendorPartNumber: part.vendorPartNumber, quantity, unitPrice: unitPrice(cell[6]!),
      lineTotal: amount(cell[7]!, 'line total'),
      ...(described ? { description: described } : {}),
    });
  }
  if (!lines.length) throw new InputError('No McMaster receipt line items were recognised; independent review required.');
  // A receipt prints an invoice date, not an order date. Guessing that they
  // are the same would put an invented date on the order record.
  return extraction({ orderNumber, subtotal: merchandise(raw), lines });
}

export function parseMcMaster(raw: string) {
  const header = receiptHeader(raw.split(/\r?\n/));
  if (header >= 0) return parseReceipt(raw, header);
  if (isConfirmation(raw)) return parseConfirmation(raw);
  // A labelled plain-text table remains readable, but no inspected McMaster
  // email uses one, so it is the last resort rather than the expectation.
  return parseTable(raw);
}

export const mcmaster: VendorParser = {
  vendor: 'mcmaster',
  matches: email => /\bMcMaster-Carr\b/i.test(email) || /\bmcmaster\.com\b/i.test(email),
  parse: parseMcMaster,
};
