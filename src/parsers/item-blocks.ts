import { extraction } from '../extraction.js';
import { InputError } from '../errors.js';

/** Labelled plain-text item blocks. Missing fields and unknown item content fail closed. */
export function parseItemBlocks(raw: string, identifier: 'ASIN' | 'SKU') {
  const orderNumber = /^Order(?: number| #)?\s*:\s*([\w-]+)\s*$/mi.exec(raw)?.[1];
  const orderDate = /^Order date:\s*(\d{4}-\d{2}-\d{2})\s*$/mi.exec(raw)?.[1];
  const subtotals = [...raw.matchAll(/^(?:Items subtotal|Subtotal):\s*\$([\d,]+\.\d{2})\s*$/gmi)];
  if (subtotals.length !== 1) throw new InputError('Expected one merchandise subtotal; complete order review required.');
  const rows = raw.split(/\r?\n/);
  const start = rows.findIndex(row => /^Order details\s*$/i.test(row));
  const end = rows.findIndex((row, i) => i > start && /^(?:Items subtotal|Subtotal):/i.test(row));
  if (start < 0 || end < 0) throw new InputError('Missing itemised order details; independent review required.');
  const items = rows.slice(start + 1, end).join('\n').trim().split(/\n\s*\n/);
  const money = (value: string) => Number(value.replace(/,/g, ''));
  const lines = items.map(item => {
    const pattern = new RegExp(`^([^\\n]+)\\n${identifier}: ([A-Za-z0-9_-]+)\\nQuantity: ([0-9]+)\\nUnit price: \\$([0-9,]+\\.[0-9]{2})\\nLine total: \\$([0-9,]+\\.[0-9]{2})$`, 'i');
    const m = pattern.exec(item);
    if (!m) throw new InputError(`Incomplete item or missing ${identifier}; independent review required.`);
    return { description: m[1], vendorPartNumber: m[2], quantity: Number(m[3]), unitPrice: money(m[4]!), lineTotal: money(m[5]!) };
  });
  return extraction({orderNumber, ...(orderDate ? {orderDate} : {}), subtotal: money(subtotals[0]![1]!), lines});
}
