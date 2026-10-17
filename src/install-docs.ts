/**
 * Regenerating the "included in the kit" list in a public install-instruction
 * document, from a BOM.
 *
 * The acceptance criterion for this half of the phase is a negative one: the
 * public output contains no private references and no vendor identifiers. So
 * the rules are refusals, and they live in code rather than in a reviewer's
 * attention:
 *
 *   - **One anchor, one block.** Only the bullet run directly beneath
 *     `### Brackets and fasteners included in the kit:` is rewritten. The
 *     run ends at the first line that is neither a bullet nor blank, which is
 *     what keeps the generator inside it — the next heading, the kit photo and
 *     every installation step are outside by construction.
 *   - **`### Not included in the kit:` is never touched.** Two documents have
 *     one, listing what the customer supplies. Those are not BOM lines.
 *   - **Only `customer_description` and a quantity are written.** Option-scoped
 *     lines are left out: they are not in every kit, and the documents say so
 *     in their own words rather than in a generated bullet.
 *   - **A vendor name or a part number aborts the write.** Nothing is written
 *     at all in that case, because a half-written document is a published one.
 */

import type { BomFile, BomLine } from "./bom.js";
import { OperatorFacingError } from "./errors.js";
import { SUPPORTED_VENDORS } from "./constants.js";

export class DocumentGenerationError extends OperatorFacingError {}

/** The heading the list hangs under, character for character. */
export const INCLUDED_ANCHOR = "### Brackets and fasteners included in the kit:";

/** The heading that must survive untouched. */
export const NOT_INCLUDED_ANCHOR = "### Not included in the kit:";

/**
 * Vendor identities that may never reach the public repository.
 *
 * The parser list plus the spellings a human writes. Checked
 * case-insensitively on word boundaries, so "amazon" is caught and
 * "amazonite" would be too — which is the right way round for a check whose
 * failure mode is publishing a supplier's name.
 */
const VENDOR_WORDS = [...SUPPORTED_VENDORS, "mcmaster-carr", "mc master"];

/**
 * A vendor part number, in the shapes these vendors actually use.
 *
 * `90935A148` is McMaster's. Deliberately not a general "looks like a code"
 * rule: the documents are full of `M6 x 25mm` and `5/16-18`, which are
 * specifications a customer needs, not identifiers.
 */
const PART_NUMBER = /\b\d{4,6}[A-Za-z]\d{2,4}\b/;

/** `vendor:part-number`, the internal reference form. */
const PART_REFERENCE = /\b[a-z0-9][a-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._/-]{2,}\b/;

/**
 * The bullet the documents already use: `- 8x - Driver door bracket`.
 *
 * The quantity is required here even though a draft line may not have one:
 * a draft is refused before anything is rendered, so a bullet with no number
 * has no way to exist.
 */
export function renderLine(line: { qty: number; customerDescription: string }): string {
  return `- ${line.qty}x - ${line.customerDescription}`;
}

/** The lines a document may show: the ones in every kit. */
export function publicLines(bom: BomFile): BomLine[] {
  return bom.lines.filter((line) => line.optionName === undefined);
}

/** Every reason this text may not be published, or an empty list. */
export function publicTextProblems(text: string): string[] {
  const problems: string[] = [];
  for (const vendor of VENDOR_WORDS) {
    if (new RegExp(`\\b${vendor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text)) {
      problems.push(`names the vendor "${vendor}"`);
    }
  }
  const partNumber = PART_NUMBER.exec(text);
  if (partNumber) problems.push(`contains "${partNumber[0]}", which looks like a vendor part number`);
  const reference = PART_REFERENCE.exec(text);
  if (reference) problems.push(`contains the internal part reference "${reference[0]}"`);
  return problems;
}

export interface GeneratedDocument {
  markdown: string;
  /** True when the document already said exactly this. */
  unchanged: boolean;
  bullets: string[];
}

/**
 * Rewrite one document's included list.
 *
 * Returns the whole file rather than a patch, so the caller can diff it, and
 * refuses rather than guessing wherever the document does not look like the
 * one it was written for.
 */
export function generateIncludedList(markdown: string, bom: BomFile): GeneratedDocument {
  if (bom.status !== "active") {
    throw new DocumentGenerationError(
      `bom/${bom.fileName} is a draft. A draft's quantities are documented but its parts are not confirmed, and publishing from one would present an unreviewed kit list as final.`,
    );
  }
  const lines = publicLines(bom);
  if (lines.length === 0) {
    throw new DocumentGenerationError(
      `bom/${bom.fileName} has no unconditional lines, so there is no kit list to publish.`,
    );
  }

  const bullets = lines.map((line) =>
    renderLine({ qty: line.qty!, customerDescription: line.customerDescription }),
  );
  const problems = bullets.flatMap((bullet) => publicTextProblems(bullet).map((problem) => `"${bullet}" ${problem}`));
  if (problems.length > 0) {
    throw new DocumentGenerationError(
      `Refusing to write to the public documentation repository. ${problems.length} line(s) would publish something private:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  }

  const fileLines = markdown.split("\n");
  const anchors = fileLines.flatMap((line, index) => (line.trimEnd() === INCLUDED_ANCHOR ? [index] : []));
  if (anchors.length !== 1) {
    throw new DocumentGenerationError(
      anchors.length === 0
        ? `That document has no "${INCLUDED_ANCHOR}" heading, so there is nowhere to write the kit list. Add the heading in a human-reviewed commit first.`
        : `That document has ${anchors.length} "${INCLUDED_ANCHOR}" headings. Which list to rewrite is not guessable.`,
    );
  }
  const anchor = anchors[0]!;

  // The run beneath the anchor: blanks and bullets only. The first line that is
  // neither — a heading, the kit photo, a paragraph — ends it, which is what
  // keeps "Not included in the kit" and every installation step out of range.
  let end = anchor + 1;
  let firstBullet = -1;
  let lastBullet = -1;
  while (end < fileLines.length) {
    const line = fileLines[end]!;
    if (line.trim() === "") {
      end += 1;
      continue;
    }
    if (!line.startsWith("- ")) break;
    if (firstBullet < 0) firstBullet = end;
    lastBullet = end;
    end += 1;
  }

  const replaced =
    firstBullet >= 0
      ? [...fileLines.slice(0, firstBullet), ...bullets, ...fileLines.slice(lastBullet + 1)]
      : // No list yet. Insert one, with the blank line the documents all have
        // between the heading and the first bullet.
        [...fileLines.slice(0, anchor + 1), "", ...bullets, ...fileLines.slice(anchor + 1)];

  const result = replaced.join("\n");
  return { markdown: result, unchanged: result === markdown, bullets };
}
