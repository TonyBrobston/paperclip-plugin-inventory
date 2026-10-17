import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extraction, reconcile, disagreements } from '../src/extraction.js';
import { selectParser } from '../src/parsers/index.js';
import { parseMcMaster } from '../src/parsers/mcmaster.js';
import { sendCutSendOrderNumber } from '../src/parsers/sendcutsend.js';
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

it.each(['Order #SYNTH-MC-100', 'Order #: SYNTH-MC-100', 'Order Number: SYNTH-MC-100', 'Order: SYNTH-MC-100'])('reads explicit order identifiers: %s', header => {
  const text = fixture('mcmaster').replace('Order Number: SYNTH-MC-100', header);
  expect(selectParser(text)!.parse('Order Confirmation\n' + text).orderNumber).toBe('SYNTH-MC-100');
});

it.each(['Order Confirmation', 'Order Summary', 'Order Number SYNTH-MC-100'])('refuses ambiguous order headings: %s', header => {
  const text = fixture('mcmaster').replace('Order Number: SYNTH-MC-100', header);
  expect(() => selectParser(text)!.parse(text)).toThrow();
});

/**
 * Layouts taken from authorized McMaster and SendCutSend samples. The fixtures
 * reproduce the structure, labels and unit wording of those emails with every
 * name, address, order number, part number and price replaced.
 */
describe('real vendor email layouts', () => {
  const layout = (name: string) => readFileSync(new URL(`./fixtures/${name}-synthetic.txt`, import.meta.url), 'utf8');

  it.each(['mcmaster-confirmation', 'mcmaster-receipt'])('reads the %s layout and reconciles to Merchandise', name => {
    const raw = layout(name);
    const parser = selectParser(raw)!;
    expect(parser.vendor).toBe('mcmaster');
    const order = parser.parse(raw);
    expect(order.orderNumber).toBe('1014ASAMPLE');
    // Merchandise, not Total: shipping and tax are not stock.
    expect(order.subtotal).toBe(9);
    expect(reconcile(order)).toEqual([]);
    expect(order.lines.map(line => [line.vendorPartNumber, line.quantity, line.unitPrice])).toEqual([
      ['00000A100', 1, 4], ['00000A200', 1, 2.5], ['00000A300', 2, 1.25],
    ]);
  });

  it('matches a receipt whose body never spells the vendor name', () => {
    expect(/McMaster-Carr/i.test(layout('mcmaster-receipt'))).toBe(false);
    expect(selectParser(layout('mcmaster-receipt'))?.vendor).toBe('mcmaster');
  });

  it('reads the confirmation order date but leaves a receipt undated', () => {
    expect(selectParser(layout('mcmaster-confirmation'))!.parse(layout('mcmaster-confirmation')).orderDate).toBe('2026-10-14');
    expect(selectParser(layout('mcmaster-receipt'))!.parse(layout('mcmaster-receipt')).orderDate).toBeUndefined();
  });

  it('keeps the pack size in the description rather than dividing the pack price', () => {
    const order = selectParser(layout('mcmaster-confirmation'))!.parse(layout('mcmaster-confirmation'));
    expect(order.lines[0]!.description).toContain('(pack of 50)');
    expect(order.lines[2]!.quantity).toBe(2);
    expect(order.lines[2]!.description).toContain('(pack of 25)');
    // A receipt states its own pack size, so it is not restated.
    const receipt = selectParser(layout('mcmaster-receipt'))!.parse(layout('mcmaster-receipt'));
    expect(receipt.lines[0]!.description).toContain('Packs of 50');
    expect(receipt.lines[0]!.description).not.toContain('(pack of');
  });

  it('ignores delivery-date rows and the shipping, tax and total block', () => {
    const order = selectParser(layout('mcmaster-confirmation'))!.parse(layout('mcmaster-confirmation'));
    expect(order.lines).toHaveLength(3);
    expect(order.subtotal).not.toBe(14.72);
  });

  it('ignores the packing-list table that follows a receipt', () => {
    expect(selectParser(layout('mcmaster-receipt'))!.parse(layout('mcmaster-receipt')).lines).toHaveLength(3);
  });

  it.each([
    ['an unreadable quantity', '1 pack of 50', '1 pack of fifty'],
    ['an unreadable unit price', '4.00 pack', 'call for pricing'],
    ['a missing merchandise subtotal', '| | Merchandise | 9.00 |', '| | Merchandise | |'],
    ['a missing order number', '1014ASAMPLE[](https://www.mcmaster.com/order-history/order/000000000000000000000000)', 'Recent orders'],
  ])('fails closed on %s', (_label, from, to) => {
    expect(() => parseMcMaster(layout('mcmaster-confirmation').replace(from, to))).toThrow();
  });

  it('refuses a SendCutSend order email and names the PDF invoice as the reason', () => {
    const raw = layout('sendcutsend-order');
    expect(selectParser(raw)?.vendor).toBe('sendcutsend');
    expect(sendCutSendOrderNumber(raw)).toBe('SX00A000');
    expect(() => selectParser(raw)!.parse(raw)).toThrow(/no line items in the email body.*PDF attachment/s);
  });
});
