import type { Extraction } from '../extraction.js';
export interface VendorParser {
  vendor: string;
  matches(email: string): boolean;
  parse(rawText: string): Extraction;
}
