/**
 * SendCutSend order emails, as they actually arrive.
 *
 * Every authorized sample inspected — "Thank you for your order", "We've got
 * your order! Here's what's next.", and the order-tracking mail — carries the
 * order number and nothing else. There is no line-item table, no part list and
 * no subtotal anywhere in the body; the itemised invoice is a PDF attachment
 * named `Order <number> invoice.pdf`.
 *
 * So this module recognises the vendor and reads the order number, then
 * refuses. A parser that cannot see quantities must not produce any, and the
 * refusal routes the email to review with a reason that says why, rather than
 * leaving an operator to guess at an "unrecognised layout". Recording stock
 * from one of these emails needs the invoice read and reviewed, which is what
 * `resolve_review_item` with `accept_with_corrections` is for.
 */
import type { VendorParser } from './types.js';
import { parseTable } from './table.js';
import { InputError } from '../errors.js';

/** `ORDER SX00A000` on its own line, or `SendCutSend Order SX00A000 ...`. */
export function sendCutSendOrderNumber(raw: string): string | undefined {
  return /^ORDER\s+([0-9A-Za-z][0-9A-Za-z-]*)\s*$/mi.exec(raw)?.[1]
    ?? /\bSendCutSend\s+Order\s+([0-9A-Za-z][0-9A-Za-z-]*)\b/i.exec(raw)?.[1];
}

export function parseSendCutSend(raw: string) {
  try {
    // No inspected email uses a labelled table, but one would be readable.
    return parseTable(raw);
  } catch (error) {
    const orderNumber = sendCutSendOrderNumber(raw);
    if (orderNumber) {
      throw new InputError(`SendCutSend order ${orderNumber} prints no line items in the email body; its itemised invoice is a PDF attachment, so quantities and prices need independent extraction and review before they can affect stock.`);
    }
    throw error;
  }
}

export const sendcutsend: VendorParser = {
  vendor: 'sendcutsend',
  matches: email => /\bSendCutSend\b/i.test(email) || /\bsendcutsend\.com\b/i.test(email),
  parse: parseSendCutSend,
};
