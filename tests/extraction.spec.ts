import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extraction, reconcile, disagreements } from '../src/extraction.js';
import { selectParser } from '../src/parsers/index.js';
export const fixture = (vendor: string) => readFileSync(new URL(`./fixtures/${vendor}-synthetic.txt`, import.meta.url), 'utf8');
describe('vendor extraction', () => {
  for (const vendor of ['mcmaster', 'sendcutsend']) {
    it(`parses the synthetic ${vendor} table and excludes shipping and tax`, () => {
      const parser = selectParser(fixture(vendor))!;
      expect(parser.vendor).toBe(vendor);
      const order = parser.parse(fixture(vendor));
      expect(order.lines).toHaveLength(2);
      expect(reconcile(order)).toEqual([]);
      expect(order.subtotal).toBe(vendor === 'mcmaster' ? 10 : 22.5);
    });
    it(`refuses truncated ${vendor} rows`, () => {
      expect(() => selectParser(fixture(vendor))!.parse(fixture(vendor).replace(/\| \$[\d.]+\nSubtotal/, '\nSubtotal'))).toThrow();
    });
  }
  const order = { orderNumber: 'SYNTH-1', subtotal: 0.3, lines: [{ vendorPartNumber: 'SYNTH-A', quantity: 3, unitPrice: 0.1 }] };
  it('reconciles decimal prices without binary floating point drift', () => expect(reconcile(extraction(order))).toEqual([]));
  it('detects subtotal and printed line-total mismatches', () => {
    expect(reconcile(extraction({ ...order, subtotal: 0.31 }))).toHaveLength(1);
    expect(reconcile(extraction({ ...order, lines: [{ ...order.lines[0], lineTotal: 0.31 }] }))).toHaveLength(1);
  });
  it('compares a multiset of lines rather than losing repeated parts in a map', () => {
    const x = extraction({ ...order, subtotal: 0.6, lines: [order.lines[0], order.lines[0]] });
    expect(disagreements(x, extraction(order))).toContain('Part numbers, quantities or prices differ');
  });
  it.each([NaN, Infinity, -1, 0, 0.00001, 1e10])('refuses unsafe quantity %s', quantity => {
    expect(() => extraction({ ...order, lines: [{ ...order.lines[0], quantity }] })).toThrow();
  });
  it('does not select disabled, ambiguous or mismatched vendor parsers', () => {
    expect(selectParser(fixture('mcmaster'), undefined, [])).toBeUndefined();
    expect(selectParser(fixture('mcmaster'), 'sendcutsend')).toBeUndefined();
    expect(selectParser(fixture('mcmaster') + '\nSendCutSend')).toBeUndefined();
  });
});

it('ignores an Order Confirmation heading when reading the order identifier', () => {
  const text = readFileSync(new URL('./fixtures/mcmaster-synthetic.txt', import.meta.url), 'utf8');
  expect(selectParser(text)!.parse('Order Confirmation\n' + text).orderNumber).toBe('SYNTH-MC-100');
  expect(() => selectParser(text)!.parse(text.replace('Order Number:', 'Order Number'))).toThrow();
});
