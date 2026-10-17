// src/install-docs-cli.ts
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// src/bom.ts
import { parse as parseYaml } from "yaml";
var PRODUCT_KEY = /^product-[0-9]+$/;
var VARIANT_SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var PART_REF = /^[a-z0-9][a-z0-9._-]*:[^\s][^\u0000-\u001f]{0,127}$/;
var QUANTITY_SCALE = 4;
var MAX_QUANTITY = 1e6;
var MAX_TEXT = 500;
var CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function text(value, label, problems, max = MAX_TEXT) {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${label} is required`);
    return void 0;
  }
  if (value.length > max) {
    problems.push(`${label} is longer than ${max} characters`);
    return void 0;
  }
  if (CONTROL_CHARACTERS.test(value)) {
    problems.push(`${label} contains control characters`);
    return void 0;
  }
  return value.trim();
}
function quantity(value, label, problems) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    problems.push(`${label} must be a positive number, found ${JSON.stringify(value)}`);
    return void 0;
  }
  if (value > MAX_QUANTITY) {
    problems.push(`${label} is ${value}; a per-unit quantity that large is a typo`);
    return void 0;
  }
  if (Number(value.toFixed(QUANTITY_SCALE)) !== value) {
    problems.push(`${label} has more than ${QUANTITY_SCALE} decimal places`);
    return void 0;
  }
  return value;
}
function pendingOf(value, label, problems) {
  if (value === void 0 || value === null) return [];
  const entries = Array.isArray(value) ? value : [value];
  const reasons = [];
  for (const [index, entry] of entries.entries()) {
    const reason = text(entry, `${label}[${index}]`, problems, 1e3);
    if (reason) reasons.push(reason);
  }
  if (reasons.length === 0) problems.push(`${label} must say what is unresolved`);
  return reasons;
}
function parseLines(raw, where, scope, problems, seen, { allowEmpty = false } = {}) {
  if (allowEmpty && Array.isArray(raw) && raw.length === 0) return [];
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push(`${where} must list at least one line`);
    return [];
  }
  const lines = [];
  for (const [index, entry] of raw.entries()) {
    const at = `${where}[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${at} is not a mapping`);
      continue;
    }
    const line = entry;
    const pending = pendingOf(line.pending, `${at} pending`, problems);
    const description = text(line.customer_description, `${at} customer_description`, problems);
    let qty;
    if (line.qty === void 0 || line.qty === null) {
      if (pending.length === 0) {
        problems.push(`${at} needs a qty, or a pending reason saying why it has none yet`);
      }
    } else {
      qty = quantity(line.qty, `${at} qty`, problems);
      if (qty === void 0) continue;
    }
    let part;
    if (line.part === void 0 || line.part === null) {
      if (pending.length === 0) {
        problems.push(`${at} needs a part, or a pending reason saying why it has none yet`);
      }
    } else if (typeof line.part !== "string" || !PART_REF.test(line.part)) {
      problems.push(`${at} part must look like vendor:part-number, found ${JSON.stringify(line.part)}`);
    } else {
      part = line.part.trim();
      const key = `${scope.optionName ?? ""}\0${scope.optionValue ?? ""}\0${part.toLowerCase()}`;
      if (seen.has(key)) problems.push(`${at} lists ${part} twice in the same option scope`);
      seen.add(key);
    }
    const sourceLineId = line.source_line_id === void 0 ? void 0 : text(line.source_line_id, `${at} source_line_id`, problems, 120);
    if (description === void 0) continue;
    lines.push({
      ...part ? { part } : {},
      ...qty === void 0 ? {} : { qty },
      customerDescription: description,
      ...scope.optionName ? { optionName: scope.optionName, optionValue: scope.optionValue } : {},
      ...sourceLineId ? { sourceLineId } : {},
      pending
    });
  }
  return lines;
}
function validateBom(fileName, document) {
  const problems = [];
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return { problems: ["is empty or is not a mapping"] };
  }
  const raw = document;
  const expectedKey = fileName.replace(/\.ya?ml$/, "");
  const catalogKey = text(raw.catalog_key, "catalog_key", problems, 64);
  if (catalogKey !== void 0 && catalogKey !== expectedKey) {
    problems.push(`catalog_key "${catalogKey}" does not match the file name "${expectedKey}"`);
  }
  let catalogKeyKind;
  if (catalogKey !== void 0) {
    const inferred = PRODUCT_KEY.test(catalogKey) ? "product_id" : VARIANT_SKU.test(catalogKey) ? "variant_sku" : void 0;
    if (!inferred) {
      problems.push(
        `catalog_key "${catalogKey}" is neither a variant SKU nor product-<id>. Use the variant SKU when the product has one; otherwise product-<BigCommerce product id>.`
      );
    } else if (raw.catalog_key_kind !== void 0 && raw.catalog_key_kind !== inferred) {
      problems.push(
        `catalog_key_kind says ${JSON.stringify(raw.catalog_key_kind)} but "${catalogKey}" is a ${inferred}`
      );
    } else {
      catalogKeyKind = inferred;
    }
  }
  const status = raw.status === void 0 ? "active" : raw.status;
  if (status !== "active" && status !== "draft") {
    problems.push(`status must be "active" or "draft", found ${JSON.stringify(raw.status)}`);
  }
  const installDocument = raw.install_document === void 0 ? void 0 : text(raw.install_document, "install_document", problems, 300);
  if (installDocument !== void 0 && !/^install-instructions\/[^\s]+\.MD$/.test(installDocument)) {
    problems.push(
      `install_document "${installDocument}" is not an install-instructions/<name>.MD path in the documentation repository`
    );
  }
  const sourceRevision = raw.source_revision === void 0 ? void 0 : text(raw.source_revision, "source_revision", problems, 64);
  const seen = /* @__PURE__ */ new Set();
  const lines = parseLines(raw.lines, "lines", {}, problems, seen);
  const optionScopes = [];
  if (raw.options !== void 0) {
    if (!Array.isArray(raw.options)) {
      problems.push("options must be a list");
    } else {
      const scopes = /* @__PURE__ */ new Set();
      for (const [index, entry] of raw.options.entries()) {
        const at = `options[${index}]`;
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          problems.push(`${at} is not a mapping`);
          continue;
        }
        const option = entry;
        const optionName = text(option.bigcommerce_option, `${at} bigcommerce_option`, problems, 250);
        const optionValue = text(option.option_value, `${at} option_value`, problems, 250);
        if (optionName === void 0 || optionValue === void 0) continue;
        const scope = `${optionName}\0${optionValue}`;
        if (scopes.has(scope)) {
          problems.push(`${at} repeats the option value "${optionName}: ${optionValue}"`);
        }
        scopes.add(scope);
        optionScopes.push({ optionName, optionValue });
        lines.push(
          ...parseLines(option.lines, `${at} lines`, { optionName, optionValue }, problems, seen, {
            allowEmpty: true
          })
        );
      }
    }
  }
  const unresolved = lines.filter((line) => line.pending.length > 0);
  if (status === "active" && unresolved.length > 0) {
    problems.push(
      `${unresolved.length} line(s) are still pending, so this BOM cannot be active. Resolve them, or set status: draft.`
    );
  }
  if (status === "draft" && unresolved.length === 0) {
    problems.push("status: draft with nothing pending. Set status: active to put this BOM into use.");
  }
  if (problems.length > 0 || catalogKey === void 0 || catalogKeyKind === void 0) {
    return { problems };
  }
  return {
    bom: {
      fileName,
      catalogKey,
      catalogKeyKind,
      status,
      ...installDocument ? { installDocument } : {},
      ...sourceRevision ? { sourceRevision } : {},
      lines,
      optionScopes
    },
    problems
  };
}
function parseBom(fileName, yamlText) {
  let document;
  try {
    document = parseYaml(yamlText);
  } catch (error) {
    return { problems: [`is not valid YAML: ${error.message}`] };
  }
  return validateBom(fileName, document);
}

// src/errors.ts
var OperatorFacingError = class extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
};

// src/constants.ts
var SUPPORTED_VENDORS = [
  "mcmaster",
  "sendcutsend",
  "amazon",
  "formlabs"
];

// src/install-docs.ts
var DocumentGenerationError = class extends OperatorFacingError {
};
var INCLUDED_ANCHOR = "### Brackets and fasteners included in the kit:";
var VENDOR_WORDS = [...SUPPORTED_VENDORS, "mcmaster-carr", "mc master"];
var PART_NUMBER = /\b\d{4,6}[A-Za-z]\d{2,4}\b/;
var PART_REFERENCE = /\b[a-z0-9][a-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._/-]{2,}\b/;
function renderLine(line) {
  return `- ${line.qty}x - ${line.customerDescription}`;
}
function publicLines(bom) {
  return bom.lines.filter((line) => line.optionName === void 0);
}
function publicTextProblems(text2) {
  const problems = [];
  for (const vendor of VENDOR_WORDS) {
    if (new RegExp(`\\b${vendor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text2)) {
      problems.push(`names the vendor "${vendor}"`);
    }
  }
  const partNumber = PART_NUMBER.exec(text2);
  if (partNumber) problems.push(`contains "${partNumber[0]}", which looks like a vendor part number`);
  const reference = PART_REFERENCE.exec(text2);
  if (reference) problems.push(`contains the internal part reference "${reference[0]}"`);
  return problems;
}
function generateIncludedList(markdown, bom) {
  if (bom.status !== "active") {
    throw new DocumentGenerationError(
      `bom/${bom.fileName} is a draft. A draft's quantities are documented but its parts are not confirmed, and publishing from one would present an unreviewed kit list as final.`
    );
  }
  const lines = publicLines(bom);
  if (lines.length === 0) {
    throw new DocumentGenerationError(
      `bom/${bom.fileName} has no unconditional lines, so there is no kit list to publish.`
    );
  }
  const bullets = lines.map(
    (line) => renderLine({ qty: line.qty, customerDescription: line.customerDescription })
  );
  const problems = bullets.flatMap((bullet) => publicTextProblems(bullet).map((problem) => `"${bullet}" ${problem}`));
  if (problems.length > 0) {
    throw new DocumentGenerationError(
      `Refusing to write to the public documentation repository. ${problems.length} line(s) would publish something private:
${problems.map((problem) => `  - ${problem}`).join("\n")}`
    );
  }
  const fileLines = markdown.split("\n");
  const anchors = fileLines.flatMap((line, index) => line.trimEnd() === INCLUDED_ANCHOR ? [index] : []);
  if (anchors.length !== 1) {
    throw new DocumentGenerationError(
      anchors.length === 0 ? `That document has no "${INCLUDED_ANCHOR}" heading, so there is nowhere to write the kit list. Add the heading in a human-reviewed commit first.` : `That document has ${anchors.length} "${INCLUDED_ANCHOR}" headings. Which list to rewrite is not guessable.`
    );
  }
  const anchor = anchors[0];
  let end = anchor + 1;
  let firstBullet = -1;
  let lastBullet = -1;
  while (end < fileLines.length) {
    const line = fileLines[end];
    if (line.trim() === "") {
      end += 1;
      continue;
    }
    if (!line.startsWith("- ")) break;
    if (firstBullet < 0) firstBullet = end;
    lastBullet = end;
    end += 1;
  }
  const replaced = firstBullet >= 0 ? [...fileLines.slice(0, firstBullet), ...bullets, ...fileLines.slice(lastBullet + 1)] : (
    // No list yet. Insert one, with the blank line the documents all have
    // between the heading and the first bullet.
    [...fileLines.slice(0, anchor + 1), "", ...bullets, ...fileLines.slice(anchor + 1)]
  );
  const result = replaced.join("\n");
  return { markdown: result, unchanged: result === markdown, bullets };
}

// src/install-docs-cli.ts
function parseArgs(argv) {
  const flag = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : void 0;
  };
  const config = flag("config");
  const docs = flag("docs");
  if (!config || !docs) {
    throw new Error(
      "Usage: install-docs-cli --config <config-repo checkout> --docs <documentation checkout> [--write]"
    );
  }
  return { config: path.resolve(config), docs: path.resolve(docs), write: argv.includes("--write") };
}
async function main(argv) {
  const options = parseArgs(argv);
  const bomDir = path.join(options.config, "bom");
  const entries = (await readdir(bomDir, { withFileTypes: true })).filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name)).map((entry) => entry.name).sort();
  let failures = 0;
  let changed = 0;
  for (const fileName of entries) {
    const { bom, problems } = parseBom(fileName, await readFile(path.join(bomDir, fileName), "utf8"));
    if (!bom) {
      failures += 1;
      console.error(`bom/${fileName}: ${problems.join("; ")}`);
      continue;
    }
    if (bom.status === "draft") {
      const pending = bom.lines.filter((line) => line.pending.length > 0).length;
      console.log(`bom/${fileName}: draft held, ${pending} line(s) unresolved \u2014 nothing published`);
      continue;
    }
    if (!bom.installDocument) {
      console.log(`bom/${fileName}: no install_document, so no public list to generate`);
      continue;
    }
    const target = path.join(options.docs, bom.installDocument);
    let markdown;
    try {
      markdown = await readFile(target, "utf8");
    } catch {
      failures += 1;
      console.error(`bom/${fileName}: ${bom.installDocument} is not in the documentation checkout`);
      continue;
    }
    try {
      const generated = generateIncludedList(markdown, bom);
      if (generated.unchanged) {
        console.log(`${bom.installDocument}: already current`);
        continue;
      }
      changed += 1;
      console.log(`${bom.installDocument}: ${publicLines(bom).length} bullet(s) would change`);
      for (const bullet of generated.bullets) console.log(`  + ${bullet}`);
      if (options.write) {
        await writeFile(target, generated.markdown, "utf8");
        console.log(`  written`);
      }
    } catch (error) {
      failures += 1;
      console.error(`bom/${fileName}: ${error.message}`);
    }
  }
  console.log(
    `
${changed} document(s) ${options.write ? "written" : "would change"}, ${failures} refused.` + (options.write && changed > 0 ? " Review the diff and open a pull request against the documentation repository; nothing was pushed." : "")
  );
  return failures > 0 ? 1 : 0;
}
process.exitCode = await main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  return 1;
});
//# sourceMappingURL=install-docs-cli.js.map
