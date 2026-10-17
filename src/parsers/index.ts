import type { VendorParser } from './types.js';
import { amazon } from './amazon.js';
import { formlabs } from './formlabs.js';
import { mcmaster } from './mcmaster.js';
import { sendcutsend } from './sendcutsend.js';
/** New vendor modules register here; verification and storage do not change. */
export const parsers: readonly VendorParser[] = [mcmaster, sendcutsend, amazon, formlabs];
export function selectParser(raw: string, vendor?: string, enabled?: readonly string[], registry = parsers): VendorParser | undefined {
  const matches = registry.filter(p => (!enabled || enabled.includes(p.vendor)) && p.matches(raw));
  if (vendor) return matches.find(p => p.vendor === vendor);
  return matches.length === 1 ? matches[0] : undefined;
}
