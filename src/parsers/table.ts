/** Conservative text-table reader. Unrecognised layouts fail closed into review. */
import { extraction } from '../extraction.js';
import { InputError } from '../errors.js';
export function parseTable(raw: string) {
  const orderNumber = raw.match(/^Order(?: Number| #| number)?\s*:\s*([\w-]+)\s*$/mi)?.[1];
  const orderDate = raw.match(/^(?:Order Date|Date)\s*:\s*(\d{4}-\d{2}-\d{2})\s*$/mi)?.[1];
  const subtotal = raw.match(/^Subtotal\s*:?\s*\$?([\d,]+\.\d{2,4})\s*$/mi)?.[1];
  const rows = raw.split(/\r?\n/);
  const start = rows.findIndex(row => /^Part(?: Number)?\s*\|\s*Description\s*\|\s*Quantity\s*\|\s*Unit Price\s*\|\s*Total\s*$/i.test(row.trim()));
  if (start < 0) throw new InputError('Unrecognised vendor line-item table; independent review required.');
  const lines = [];
  for (const row of rows.slice(start + 1)) {
    if (!row.trim()) continue;
    if (/^Subtotal\b/i.test(row.trim())) break;
    const cells = row.split('|').map(x => x.trim());
    if (cells.length !== 5) throw new InputError('Unrecognised vendor line item; independent review required.');
    const money = (s: string) => /^\$?[\d,]+\.\d{2,4}$/.test(s) ? Number(s.replace(/[$,]/g, '')) : NaN;
    lines.push({ vendorPartNumber: cells[0], description: cells[1], quantity: Number(cells[2]), unitPrice: money(cells[3]!), lineTotal: money(cells[4]!) });
  }
  return extraction({ orderNumber, orderDate, subtotal: subtotal ? Number(subtotal.replace(/,/g, '')) : undefined, lines });
}
