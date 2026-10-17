import type { VendorParser } from './types.js';
import { parseItemBlocks } from './item-blocks.js';
import { InputError } from '../errors.js';

/** Only itemised order confirmations with stable part identifiers are safe.
 * Shipment subsets must never become a complete order under the same order id.
 */
export const amazon: VendorParser = {
  vendor: 'amazon',
  matches: raw => /\bamazon\.(?:com|co\.uk)\b/i.test(raw) || /^Amazon\s*$/mi.test(raw),
  parse(raw) {
    if (/\b(?:shipped|shipment|arriving|dispatched|split order|part of your order|items? in this delivery)\b/i.test(raw)) {
      throw new InputError('Amazon shipment or split-order email requires review of the complete order; no partial purchase was recorded.');
    }
    if (!/^Order confirmation\s*$/mi.test(raw)) throw new InputError('Amazon requires an itemised order confirmation with explicit part identifiers; independent review required.');
    return parseItemBlocks(raw, 'ASIN');
  },
};
