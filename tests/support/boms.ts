/**
 * A config repository and a catalog, in memory.
 *
 * The sync's two inputs are a GitHub repository and the BigCommerce catalog.
 * Both are replaced here by their interfaces, so the suite exercises the real
 * validation, versioning and insert paths against a real database without
 * either network.
 */

import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { indexProducts } from "../../src/catalog.js";
import type { ConfigRepo } from "../../src/config-repo.js";

export const RUN: ToolRunContext = {
  agentId: "agent-test",
  runId: "run-test",
  companyId: "11111111-1111-4111-8111-111111111111",
  projectId: "project-test",
} as ToolRunContext;

/** A repository whose `bom/` is whatever the test says it is, per commit. */
export function fakeConfigRepo(commits: Record<string, Record<string, string>>): ConfigRepo {
  const order = Object.keys(commits);
  return {
    repo: "example-org/example-config",
    async headCommit() {
      return order[order.length - 1]!;
    },
    async readBoms(commit: string) {
      const files = commits[commit];
      if (!files) throw new Error(`the test has no commit ${commit}`);
      return Object.entries(files)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([fileName, text]) => ({ fileName, path: `bom/${fileName}`, text }));
    },
  };
}

/** Two synthetic products: one with no SKU anywhere, one with options. */
export const CATALOG = indexProducts([
  { id: 9001, name: "Example Kit", sku: "", variants: [{ sku: "" }], options: [] },
  {
    id: 9002,
    name: "Optioned Kit",
    sku: "",
    variants: [{ sku: "KIT-9002-IN" }],
    options: [
      {
        display_name: "Which switch type do you have?",
        option_values: [{ label: "Stock" }, { label: "Rocker" }, { label: "None" }],
      },
    ],
  },
]);

export function activeBomYaml(
  lines: { part: string; qty: number; description?: string }[],
  options: { key?: string; extra?: string } = {},
): string {
  return [
    `catalog_key: ${options.key ?? "product-9001"}`,
    "status: active",
    "lines:",
    ...lines.flatMap((line) => [
      `  - part: ${line.part}`,
      `    qty: ${line.qty}`,
      `    customer_description: "${line.description ?? `Part ${line.part.split(":")[1]}`}"`,
    ]),
    options.extra ?? "",
  ].join("\n");
}
