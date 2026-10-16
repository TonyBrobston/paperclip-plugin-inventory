/**
 * Quantities, and the one place they cross between JSON and `numeric(14,4)`.
 *
 * Two conversions, both easy to get silently wrong:
 *
 *   - **In.** A tool receives JSON, so a quantity arrives as a double. The
 *     column stores four decimal places, so a fifth would be rounded away
 *     without anybody being told. Rounding stock is exactly the kind of
 *     quiet wrongness a ledger exists to prevent, so more precision than the
 *     column holds is refused rather than rounded.
 *   - **Out.** `pg` returns `numeric` as a *string*, because not every
 *     `numeric` fits a double. Ours do — four decimals and ten integer digits
 *     is far inside 2^53 — so they are converted once, here, where the reason
 *     it is safe can be written down. Leaving them as strings instead would
 *     put `"5.0000"` in a tool result, and an agent comparing that to `5`
 *     gets the wrong answer.
 */

import { InputError } from "./errors.js";

/** Matches `numeric(14, 4)`: ten digits before the point, four after. */
export const QUANTITY_SCALE = 4;
const MAX_MAGNITUDE = 9_999_999_999;

const SCALE_FACTOR = 10 ** QUANTITY_SCALE;

export interface QuantityOptions {
  /** What the number is called in the error message. */
  label: string;
  /** Reject zero. A movement of nothing is never what the caller meant. */
  nonZero?: boolean;
  /** Reject anything at or below zero. */
  positive?: boolean;
}

/**
 * Validate one quantity from a tool call.
 *
 * Returns the number unchanged when it is acceptable; the point is the
 * refusals, not a transformation.
 */
export function parseQuantity(value: unknown, options: QuantityOptions): number {
  const { label } = options;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InputError(`${label} must be a number.`);
  }
  if (options.positive && value <= 0) {
    throw new InputError(`${label} must be greater than zero.`);
  }
  if ((options.nonZero || options.positive) && value === 0) {
    throw new InputError(
      `${label} cannot be zero — a movement of nothing is not a movement.`,
    );
  }
  if (Math.abs(value) > MAX_MAGNITUDE) {
    throw new InputError(`${label} is larger than this inventory can store.`);
  }
  // `5.00001 * 10000` is 50000.1 in binary floating point, so the remainder
  // test needs the tolerance; a genuine fifth decimal is many orders of
  // magnitude larger than the representation error at these magnitudes.
  const scaled = value * SCALE_FACTOR;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new InputError(
      `${label} has more than ${QUANTITY_SCALE} decimal places. Stock is stored to ${QUANTITY_SCALE} decimals, and rounding it quietly is how a ledger stops being trustworthy.`,
    );
  }
  return Math.round(scaled) / SCALE_FACTOR;
}

/**
 * Turn a `numeric` column into a number.
 *
 * Nulls become 0: every caller here is summing a quantity, and "no rows" and
 * "zero" are the same stock position.
 */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric value from the database, got ${String(value)}`);
  }
  // Re-rounded to the column's scale so that a value that made a round trip
  // through a double compares equal to the one that went in.
  return Math.round(parsed * SCALE_FACTOR) / SCALE_FACTOR;
}
