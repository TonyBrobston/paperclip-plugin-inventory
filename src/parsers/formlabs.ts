import type { VendorParser } from './types.js';
import { parseItemBlocks } from './item-blocks.js';
import { InputError } from '../errors.js';

export const formlabs: VendorParser = {
  vendor: 'formlabs',
  matches: raw => /\bFormlabs\b/i.test(raw) || /\bformlabs\.com\b/i.test(raw),
  parse(raw) {
    if (/\b(?:shipment|shipped|partial delivery)\b/i.test(raw)) throw new InputError('Formlabs shipment email requires the complete itemised order for review.');
    return parseItemBlocks(raw, 'SKU');
  },
};
