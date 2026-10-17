import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { selectParser } from '../src/parsers/index.js';
import { disagreements, reconcile } from '../src/extraction.js';
for (const vendor of ['amazon', 'formlabs']) {
  const raw = readFileSync(new URL(`./fixtures/${vendor}-synthetic.txt`, import.meta.url), 'utf8');
  it(`${vendor}: recognises and reconciles explicit itemised orders`, () => {
    const parser = selectParser(raw)!;
    expect(parser.vendor).toBe(vendor);
    expect(reconcile(parser.parse(raw))).toEqual([]);
    expect(parser.parse(raw).lines[0]?.quantity).toBe(2);
    expect(selectParser(raw, vendor, ['mcmaster'])).toBeUndefined();
  });
  it(`${vendor}: rejects missing identifiers and detects quantity disagreements`, () => {
    const parser = selectParser(raw)!;
    expect(() => parser.parse(raw.replace(/(?:ASIN|SKU):/, 'Product:'))).toThrow();
    const wrong = parser.parse(raw); wrong.lines[0]!.quantity = 20;
    expect(disagreements(parser.parse(raw), wrong)).toContain('Part numbers, quantities or prices differ');
  });
  it(`${vendor}: handles CRLF and refuses ambiguous totals or unknown item content`, () => {
    const parser = selectParser(raw)!;
    expect(parser.parse(raw.replaceAll('\n', '\r\n')).subtotal).toBe(10);
    expect(() => parser.parse(raw+'\nSubtotal: $10.00')).toThrow();
    expect(() => parser.parse(raw.replace('Subtotal:', 'Unexpected item\nSubtotal:'))).toThrow();
    expect(reconcile(parser.parse(raw.replace('Line total: $10.00', 'Line total: $11.00')))).toContain('Printed line total differs from quantity × unit price');
  });
  it(`${vendor}: refuses shipment subsets even when their subtotal reconciles`, () => {
    expect(() => selectParser(raw)!.parse(raw + '\nShipment 1 of 2')).toThrow(/review/i);
  });
}
