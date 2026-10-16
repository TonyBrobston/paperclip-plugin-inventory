import type { VendorParser } from './types.js';
import { parseTable } from './table.js';
export const mcmaster: VendorParser = {
  vendor: 'mcmaster',
  matches: email => /\bMcMaster-Carr\b/i.test(email),
  parse: parseTable,
};
