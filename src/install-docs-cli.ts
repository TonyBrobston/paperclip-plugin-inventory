/**
 * The documentation generator, as a command.
 *
 * Reads a checkout of the private config repository and a checkout of the
 * public documentation repository, and rewrites each install document's
 * included-kit list from its BOM. Nothing else: it does not commit, does not
 * push, and has no credentials — delivery is a pull request a human opens from
 * the working tree it leaves behind, which is the only way the "public repo
 * never receives a direct push" rule can be checked by looking at this file.
 *
 *     node dist/install-docs-cli.js --config ../config --docs ../documentation
 *     node dist/install-docs-cli.js --config ../config --docs ../documentation --write
 *
 * Dry by default. With no `--write` it prints what would change and touches
 * nothing, which is the mode a reviewer should see first.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseBom } from "./bom.js";
import { generateIncludedList, publicLines } from "./install-docs.js";

interface Options {
  config: string;
  docs: string;
  write: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const config = flag("config");
  const docs = flag("docs");
  if (!config || !docs) {
    throw new Error(
      "Usage: install-docs-cli --config <config-repo checkout> --docs <documentation checkout> [--write]",
    );
  }
  return { config: path.resolve(config), docs: path.resolve(docs), write: argv.includes("--write") };
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const bomDir = path.join(options.config, "bom");
  const entries = (await readdir(bomDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

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
      console.log(`bom/${fileName}: draft held, ${pending} line(s) unresolved — nothing published`);
      continue;
    }
    if (!bom.installDocument) {
      console.log(`bom/${fileName}: no install_document, so no public list to generate`);
      continue;
    }

    const target = path.join(options.docs, bom.installDocument);
    let markdown: string;
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
      console.error(`bom/${fileName}: ${(error as Error).message}`);
    }
  }

  console.log(
    `\n${changed} document(s) ${options.write ? "written" : "would change"}, ${failures} refused.` +
      (options.write && changed > 0
        ? " Review the diff and open a pull request against the documentation repository; nothing was pushed."
        : ""),
  );
  return failures > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2)).catch((error: Error) => {
  console.error(error.message);
  return 1;
});
