/** Values stored at four decimal places, compared using integer arithmetic. */
import { InputError } from './errors.js';
import { parsePartRef } from './parts.js';

export interface OrderLine {
  vendorPartNumber: string;
  description?: string;
  quantity: number;
  unitPrice: number;
  lineTotal?: number;
}
export interface Extraction {
  orderNumber: string;
  orderDate?: string;
  subtotal: number;
  lines: OrderLine[];
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Parameters must be an object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new InputError(`${label} is required and must be printable text of at most ${max} characters.`);
  }
  return value.trim();
}
export function scaled(value: unknown, label = 'Amount', positive = false): bigint {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1e10 || (positive && value === 0)) throw new InputError(`${label} must be a finite ${positive ? 'positive' : 'non-negative'} number below 10 billion.`);
  const scaled = Math.round(value * 10000);
  if (Math.abs(value * 10000 - scaled) > 0.0001) throw new InputError(`${label} supports at most four decimal places.`);
  return BigInt(scaled);
}
export function vendorKey(value: unknown): string {
  const vendor = text(value, 'Vendor', 63).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(vendor)) throw new InputError('Vendor must be a lowercase vendor key.');
  return vendor;
}
export function extraction(value: unknown): Extraction {
  const x = object(value);
  const orderNumber = text(x.orderNumber, 'Order number');
  if (!Array.isArray(x.lines) || !x.lines.length || x.lines.length > 500) throw new InputError('An extraction needs 1–500 lines.');
  scaled(x.subtotal, 'Subtotal');
  let orderDate: string | undefined;
  if (x.orderDate !== undefined) {
    orderDate = text(x.orderDate, 'Order date', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate) || new Date(orderDate).toISOString().slice(0, 10) !== orderDate) throw new InputError('Order date must be a real ISO date.');
  }
  const lines = x.lines.map(value => {
    const line = object(value);
    const vendorPartNumber = text(line.vendorPartNumber, 'Part number', 128);
    parsePartRef(`vendor:${vendorPartNumber}`);
    scaled(line.quantity, 'Quantity', true);
    scaled(line.unitPrice, 'Unit price');
    if (line.lineTotal !== undefined) scaled(line.lineTotal, 'Line total');
    return { vendorPartNumber, quantity: line.quantity as number, unitPrice: line.unitPrice as number,
      ...(line.description === undefined ? {} : { description: text(line.description, 'Description') }),
      ...(line.lineTotal === undefined ? {} : { lineTotal: line.lineTotal as number }) };
  });
  return { orderNumber, ...(orderDate ? { orderDate } : {}), subtotal: x.subtotal as number, lines };
}
function lineKey(line: OrderLine): string {
  return JSON.stringify([line.vendorPartNumber.toLowerCase(), scaled(line.quantity).toString(), scaled(line.unitPrice).toString()]);
}
export function disagreements(a: Extraction, b: Extraction): string[] {
  const reasons: string[] = [];
  if (a.orderNumber.toLowerCase() !== b.orderNumber.toLowerCase()) reasons.push('Order numbers differ');
  if (a.orderDate !== b.orderDate) reasons.push('Order dates differ');
  if (scaled(a.subtotal) !== scaled(b.subtotal)) reasons.push('Subtotals differ');
  if (JSON.stringify(a.lines.map(lineKey).sort()) !== JSON.stringify(b.lines.map(lineKey).sort())) reasons.push('Part numbers, quantities or prices differ');
  return reasons;
}
export function reconcile(x: Extraction): string[] {
  let total = 0n;
  const reasons: string[] = [];
  for (const line of x.lines) {
    // Round each extended price once to the storage precision, half up.
    const extended = (scaled(line.quantity) * scaled(line.unitPrice) + 5000n) / 10000n;
    total += extended;
    if (line.lineTotal !== undefined && scaled(line.lineTotal) !== extended) reasons.push('Printed line total differs from quantity × unit price');
  }
  if (total !== scaled(x.subtotal)) reasons.push('Line totals do not reconcile to the subtotal (tax and shipping excluded)');
  return reasons;
}
