import type { VendorParser } from './types.js';
import { parseTable } from './table.js';
export const sendcutsend: VendorParser = {
  vendor: 'sendcutsend',
  matches: email => /\bSendCutSend\b/i.test(email),
  parse: parseTable,
};
