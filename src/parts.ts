/**
 * How a caller names a part.
 *
 * Two forms, and the difference between them decides whether an unknown part
 * is an error or a new row:
 *
 *   - `vendor-a:part-001` — a vendor-qualified reference. It carries enough to
 *     create the part if we have not seen it before.
 *   - a uuid — this plugin's own id for a part that already exists. It carries
 *     nothing, so an unknown one is a typo, not a new part.
 *
 * Parsing lives here rather than inside the ledger so the rules are testable
 * without a database, and so every tool that takes a `partId` agrees on them.
 */

import { InputError } from "./errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Vendor keys are lowercase and URL-ish, matching the `vendor-a:part-001`
 * shape the spec uses and the parser module names in `SUPPORTED_VENDORS`.
 */
const VENDOR_KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** Long enough for any real part number; short enough to be a part number. */
const MAX_PART_NUMBER_LENGTH = 128;

/** Anything that would make a part number unprintable or unmatchable. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type PartRef =
  | { kind: "id"; id: string }
  | { kind: "vendor"; vendor: string; vendorPartNumber: string; ref: string };

/**
 * Parse a `partId` parameter.
 *
 * The uuid check runs first because a uuid cannot contain a colon, so the two
 * forms can never be confused.
 */
export function parsePartRef(value: unknown): PartRef {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError(
      "A part is required: either a vendor-qualified reference such as vendor-a:part-001, or the part's internal id.",
    );
  }
  const trimmed = value.trim();
  if (UUID.test(trimmed)) return { kind: "id", id: trimmed.toLowerCase() };

  const separator = trimmed.indexOf(":");
  if (separator < 0) {
    throw new InputError(
      `"${trimmed}" is not a part reference. Use vendor:part-number, for example vendor-a:part-001, or the part's internal id.`,
    );
  }

  // Split on the first colon only: some vendors put colons inside their own
  // part numbers, and the vendor key never contains one.
  const vendor = trimmed.slice(0, separator).trim().toLowerCase();
  const vendorPartNumber = trimmed.slice(separator + 1).trim();

  if (!VENDOR_KEY.test(vendor)) {
    throw new InputError(
      `"${vendor}" is not a usable vendor key. Use lowercase letters, digits, dots, dashes and underscores — for example mcmaster.`,
    );
  }
  if (vendorPartNumber === "") {
    throw new InputError(`"${trimmed}" names a vendor but no part number.`);
  }
  if (vendorPartNumber.length > MAX_PART_NUMBER_LENGTH) {
    throw new InputError(
      `That part number is ${vendorPartNumber.length} characters long. A part number is at most ${MAX_PART_NUMBER_LENGTH}; this is probably a description.`,
    );
  }
  if (CONTROL_CHARACTERS.test(vendorPartNumber)) {
    throw new InputError("That part number contains control characters.");
  }

  return {
    kind: "vendor",
    vendor,
    vendorPartNumber,
    // Normalised, so the value we echo back is the value that would match next
    // time. Only the vendor half is lowercased: the part number keeps the
    // vendor's own casing, and the database matches it case-insensitively.
    ref: `${vendor}:${vendorPartNumber}`,
  };
}

/** How a part is named back to the agent. */
export function formatPartRef(vendor: string, vendorPartNumber: string): string {
  return `${vendor}:${vendorPartNumber}`;
}
