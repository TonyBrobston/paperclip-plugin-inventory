/**
 * The BOM file format, as rules rather than as documentation.
 *
 * One YAML file per product in the private config repo. Everything here is
 * pure: text in, a validated BOM or a list of problems out, with no database
 * and no network. That is deliberate — the config repo's own validator runs on
 * every push and has to agree with the plugin about what a legal file is, and
 * the only way two implementations agree is if the rules are small enough to
 * state twice.
 *
 * Two shapes differ from the provisional schema in phase 1, both because the
 * live catalog disagreed with it:
 *
 *   - A BOM hangs on a **catalog key** — a variant SKU where one exists,
 *     otherwise `product-<id>`. Every product-level SKU in the store is empty,
 *     so a SKU-keyed BOM would resolve to nothing and consume nothing.
 *   - An option line carries a **name and a value**. "Which macerator switch
 *     type do you have?" has three values and a different part behind each.
 *
 * A file may also be a **draft**: every documented quantity and customer
 * description, with the part mappings still unconfirmed. A draft is a real
 * file in `bom/` so the conversion is reviewable where BOMs live, and the sync
 * refuses to import one. `pending` is what makes that refusal structural
 * rather than a note in a comment.
 */

import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

/** A BOM nobody has confirmed the part mappings for yet. Never imported. */
export type BomStatus = "active" | "draft";

export type CatalogKeyKind = "product_id" | "variant_sku";

export interface BomLine {
  /** Absent only in a draft, where `pending` says what is missing. */
  part?: string;
  /**
   * Absent only in a draft.
   *
   * Some documented lines have no number at all — "Rubber with adhesive
   * backing" names no length, area or unit of consumption. A zero there would
   * be a lie about what the kit contains, so the line exists with its
   * quantity still open.
   */
  qty?: number;
  customerDescription: string;
  /** Set on an option-scoped line; both halves or neither. */
  optionName?: string;
  optionValue?: string;
  /** The documented line this was converted from, for traceability. */
  sourceLineId?: string;
  /** What has to be resolved before this line may be activated. */
  pending: string[];
}

export interface OptionScope {
  optionName: string;
  optionValue: string;
}

export interface BomFile {
  fileName: string;
  catalogKey: string;
  catalogKeyKind: CatalogKeyKind;
  status: BomStatus;
  /** Path in the public documentation repo whose kit list this BOM generates. */
  installDocument?: string;
  /** Documentation revision the included list was converted from. */
  sourceRevision?: string;
  lines: BomLine[];
  /**
   * Every option value this BOM has an answer for, including the ones that
   * consume nothing.
   *
   * Declared rather than inferred from the lines, because "this value adds no
   * parts" and "nobody has written this value down" have to be different
   * answers at sale time. "Which macerator switch type do you have?" has a
   * `None (no switch)` value that legitimately consumes nothing; an option
   * value that is *not* here is a value the storefront has and this file does
   * not, which is a rename nobody propagated.
   */
  optionScopes: OptionScope[];
}

export interface BomProblems {
  file: string;
  problems: string[];
}

/** `product-127`, the key for a product whose variants carry no SKU. */
const PRODUCT_KEY = /^product-[0-9]+$/;

/**
 * A variant SKU, as BigCommerce stores them. Deliberately narrow: a SKU with a
 * space or a slash in it is more often a copied cell than a SKU.
 */
const VARIANT_SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `vendor:part-number`, the same reference the ledger takes. */
const PART_REF = /^[a-z0-9][a-z0-9._-]*:[^\s][^\u0000-\u001f]{0,127}$/;

/** `numeric(14, 4)` in the database; the same limit, stated once here. */
const QUANTITY_SCALE = 4;
const MAX_QUANTITY = 1_000_000;

const MAX_TEXT = 500;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function text(value: unknown, label: string, problems: string[], max = MAX_TEXT): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${label} is required`);
    return undefined;
  }
  if (value.length > max) {
    problems.push(`${label} is longer than ${max} characters`);
    return undefined;
  }
  if (CONTROL_CHARACTERS.test(value)) {
    problems.push(`${label} contains control characters`);
    return undefined;
  }
  return value.trim();
}

function quantity(value: unknown, label: string, problems: string[]): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    problems.push(`${label} must be a positive number, found ${JSON.stringify(value)}`);
    return undefined;
  }
  if (value > MAX_QUANTITY) {
    problems.push(`${label} is ${value}; a per-unit quantity that large is a typo`);
    return undefined;
  }
  if (Number(value.toFixed(QUANTITY_SCALE)) !== value) {
    problems.push(`${label} has more than ${QUANTITY_SCALE} decimal places`);
    return undefined;
  }
  return value;
}

/** Fractions are legal — sealant, wire by the foot — so `pending` is a list. */
function pendingOf(value: unknown, label: string, problems: string[]): string[] {
  if (value === undefined || value === null) return [];
  const entries = Array.isArray(value) ? value : [value];
  const reasons: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const reason = text(entry, `${label}[${index}]`, problems, 1000);
    if (reason) reasons.push(reason);
  }
  if (reasons.length === 0) problems.push(`${label} must say what is unresolved`);
  return reasons;
}

interface LineScope {
  optionName?: string;
  optionValue?: string;
}

function parseLines(
  raw: unknown,
  where: string,
  scope: LineScope,
  problems: string[],
  seen: Set<string>,
  { allowEmpty = false } = {},
): BomLine[] {
  // An option value that consumes nothing is a real answer — `None (no
  // switch)` — so an option may list no lines. The base list may not: a BOM
  // that consumes nothing for every unit is not a BOM.
  if (allowEmpty && Array.isArray(raw) && raw.length === 0) return [];
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push(`${where} must list at least one line`);
    return [];
  }
  const lines: BomLine[] = [];
  for (const [index, entry] of raw.entries()) {
    const at = `${where}[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${at} is not a mapping`);
      continue;
    }
    const line = entry as Record<string, unknown>;
    const pending = pendingOf(line.pending, `${at} pending`, problems);
    const description = text(line.customer_description, `${at} customer_description`, problems);
    let qty: number | undefined;
    if (line.qty === undefined || line.qty === null) {
      if (pending.length === 0) {
        problems.push(`${at} needs a qty, or a pending reason saying why it has none yet`);
      }
    } else {
      qty = quantity(line.qty, `${at} qty`, problems);
      if (qty === undefined) continue;
    }

    let part: string | undefined;
    if (line.part === undefined || line.part === null) {
      // A line with no part is only meaningful while the mapping is still
      // open, and then only if it says so.
      if (pending.length === 0) {
        problems.push(`${at} needs a part, or a pending reason saying why it has none yet`);
      }
    } else if (typeof line.part !== "string" || !PART_REF.test(line.part)) {
      problems.push(`${at} part must look like vendor:part-number, found ${JSON.stringify(line.part)}`);
    } else {
      part = line.part.trim();
      // Scoped to the option, matching `bom_lines_unique_within_option_idx`:
      // two values of one option may consume the same fastener, but the same
      // part twice in one scope is a merge that went wrong.
      const key = `${scope.optionName ?? ""}\u0000${scope.optionValue ?? ""}\u0000${part.toLowerCase()}`;
      if (seen.has(key)) problems.push(`${at} lists ${part} twice in the same option scope`);
      seen.add(key);
    }

    const sourceLineId =
      line.source_line_id === undefined
        ? undefined
        : text(line.source_line_id, `${at} source_line_id`, problems, 120);

    if (description === undefined) continue;
    lines.push({
      ...(part ? { part } : {}),
      ...(qty === undefined ? {} : { qty }),
      customerDescription: description,
      ...(scope.optionName ? { optionName: scope.optionName, optionValue: scope.optionValue } : {}),
      ...(sourceLineId ? { sourceLineId } : {}),
      pending,
    });
  }
  return lines;
}

/**
 * Validate one parsed BOM document.
 *
 * Collects every problem rather than throwing on the first, because a sync
 * that reports one bad line per run makes fixing a file an afternoon of
 * round trips.
 */
export function validateBom(fileName: string, document: unknown): { bom?: BomFile; problems: string[] } {
  const problems: string[] = [];
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return { problems: ["is empty or is not a mapping"] };
  }
  const raw = document as Record<string, unknown>;

  const expectedKey = fileName.replace(/\.ya?ml$/, "");
  const catalogKey = text(raw.catalog_key, "catalog_key", problems, 64);
  if (catalogKey !== undefined && catalogKey !== expectedKey) {
    // A file named for one product and declaring another is read as the one it
    // declares, so the file name quietly stops meaning anything.
    problems.push(`catalog_key "${catalogKey}" does not match the file name "${expectedKey}"`);
  }

  let catalogKeyKind: CatalogKeyKind | undefined;
  if (catalogKey !== undefined) {
    const inferred: CatalogKeyKind | undefined = PRODUCT_KEY.test(catalogKey)
      ? "product_id"
      : VARIANT_SKU.test(catalogKey)
        ? "variant_sku"
        : undefined;
    if (!inferred) {
      problems.push(
        `catalog_key "${catalogKey}" is neither a variant SKU nor product-<id>. Use the variant SKU when the product has one; otherwise product-<BigCommerce product id>.`,
      );
    } else if (raw.catalog_key_kind !== undefined && raw.catalog_key_kind !== inferred) {
      // Stated and inferred disagreeing means one of them is wrong, and which
      // is not guessable: a `variant_sku` of `product-128` is either a key
      // typo or a kind typo.
      problems.push(
        `catalog_key_kind says ${JSON.stringify(raw.catalog_key_kind)} but "${catalogKey}" is a ${inferred}`,
      );
    } else {
      catalogKeyKind = inferred;
    }
  }

  const status = raw.status === undefined ? "active" : raw.status;
  if (status !== "active" && status !== "draft") {
    problems.push(`status must be "active" or "draft", found ${JSON.stringify(raw.status)}`);
  }

  const installDocument =
    raw.install_document === undefined
      ? undefined
      : text(raw.install_document, "install_document", problems, 300);
  if (installDocument !== undefined && !/^install-instructions\/[^\s]+\.MD$/.test(installDocument)) {
    // The generator writes into one directory of one repository. A path it
    // cannot recognise is refused here rather than at write time.
    problems.push(
      `install_document "${installDocument}" is not an install-instructions/<name>.MD path in the documentation repository`,
    );
  }
  const sourceRevision =
    raw.source_revision === undefined
      ? undefined
      : text(raw.source_revision, "source_revision", problems, 64);

  const seen = new Set<string>();
  const lines = parseLines(raw.lines, "lines", {}, problems, seen);
  const optionScopes: OptionScope[] = [];

  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options)) {
      problems.push("options must be a list");
    } else {
      const scopes = new Set<string>();
      for (const [index, entry] of raw.options.entries()) {
        const at = `options[${index}]`;
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          problems.push(`${at} is not a mapping`);
          continue;
        }
        const option = entry as Record<string, unknown>;
        const optionName = text(option.bigcommerce_option, `${at} bigcommerce_option`, problems, 250);
        const optionValue = text(option.option_value, `${at} option_value`, problems, 250);
        if (optionName === undefined || optionValue === undefined) continue;
        const scope = `${optionName}\u0000${optionValue}`;
        if (scopes.has(scope)) {
          problems.push(`${at} repeats the option value "${optionName}: ${optionValue}"`);
        }
        scopes.add(scope);
        optionScopes.push({ optionName, optionValue });
        lines.push(
          ...parseLines(option.lines, `${at} lines`, { optionName, optionValue }, problems, seen, {
            allowEmpty: true,
          }),
        );
      }
    }
  }

  const unresolved = lines.filter((line) => line.pending.length > 0);
  if (status === "active" && unresolved.length > 0) {
    problems.push(
      `${unresolved.length} line(s) are still pending, so this BOM cannot be active. Resolve them, or set status: draft.`,
    );
  }
  if (status === "draft" && unresolved.length === 0) {
    // Otherwise a BOM that is finished stays inert because nobody noticed the
    // word "draft" at the top of the file.
    problems.push("status: draft with nothing pending. Set status: active to put this BOM into use.");
  }

  if (problems.length > 0 || catalogKey === undefined || catalogKeyKind === undefined) {
    return { problems };
  }
  return {
    bom: {
      fileName,
      catalogKey,
      catalogKeyKind,
      status: status as BomStatus,
      ...(installDocument ? { installDocument } : {}),
      ...(sourceRevision ? { sourceRevision } : {}),
      lines,
      optionScopes,
    },
    problems,
  };
}

/** Parse and validate one file's text. A YAML syntax error is one problem. */
export function parseBom(fileName: string, yamlText: string): { bom?: BomFile; problems: string[] } {
  let document: unknown;
  try {
    document = parseYaml(yamlText);
  } catch (error) {
    return { problems: [`is not valid YAML: ${(error as Error).message}`] };
  }
  return validateBom(fileName, document);
}

/**
 * A hash of what the BOM *consumes*.
 *
 * Content only: the key, and every line's part, quantity, option scope and
 * customer description. Not the file's bytes, not its comments, not
 * `source_revision`. Reformatting a file must not create a version, because a
 * version is what a sale that already happened points at; changing a quantity
 * must, because that is a different BOM.
 *
 * Lines are sorted, so reordering a file is not a change either.
 */
export function contentHash(bom: BomFile): string {
  const canonical = <T>(rows: T[]): T[] =>
    [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  const lines = canonical(
    bom.lines.map((line) => [
      line.optionName ?? "",
      line.optionValue ?? "",
      line.part ?? "",
      line.qty,
      line.customerDescription,
    ]),
  );
  // Scopes are content too: adding a `None` value that consumes nothing
  // changes what a sale carrying it does, from refused to expanded.
  const scopes = canonical(bom.optionScopes.map((s) => [s.optionName, s.optionValue]));
  return createHash("sha256")
    .update(JSON.stringify([bom.catalogKey, bom.catalogKeyKind, lines, scopes]))
    .digest("hex");
}

export interface OptionSelection {
  option: string;
  value: string;
}

/**
 * The lines one sale consumes.
 *
 * Base lines always; an option-scoped line only when that option's selected
 * value matches. Two kinds of selection the BOM has no lines for are told
 * apart, because they are different events:
 *
 *   - The BOM declares the option **name** but not that **value**
 *     (`unmatched`). The storefront has a value this file does not, which is
 *     an option renamed or added and not propagated here. Consuming the base
 *     lines alone would under-consume every unit of it, silently, so the
 *     caller refuses the sale.
 *   - The BOM never mentions the option at all (`ignored`). A colour or an
 *     engraving has no parts behind it, and that is not an error.
 */
export function selectLines(
  bom: BomFile,
  selections: readonly OptionSelection[],
): { lines: BomLine[]; unmatched: OptionSelection[]; ignored: OptionSelection[] } {
  const chosen = new Set(selections.map((s) => `${s.option}\u0000${s.value}`));
  const declared = new Set(bom.optionScopes.map((s) => `${s.optionName}\u0000${s.optionValue}`));
  const names = new Set(bom.optionScopes.map((s) => s.optionName));
  return {
    lines: bom.lines.filter(
      (line) =>
        line.optionName === undefined ||
        chosen.has(`${line.optionName}\u0000${line.optionValue}`),
    ),
    unmatched: selections.filter(
      (s) => names.has(s.option) && !declared.has(`${s.option}\u0000${s.value}`),
    ),
    ignored: selections.filter((s) => !names.has(s.option)),
  };
}
