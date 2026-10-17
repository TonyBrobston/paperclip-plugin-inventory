/**
 * Reading `bom/` out of the private config repository.
 *
 * Two claims worth a test: the reader only ever asks for `bom/`, and a GitHub
 * failure reaches an agent as something to check rather than as a token or a
 * response body.
 */

import { describe, expect, it, vi } from "vitest";
import { githubConfigRepo, parseConfigRepoSettings } from "../src/config-repo.js";
import { CONFIG_KEYS } from "../src/constants.js";

const SETTINGS = {
  [CONFIG_KEYS.configRepo]: "example-org/example-config",
  [CONFIG_KEYS.configRepoToken]: { type: "secret_ref", secretId: "gh" },
};

const TOKEN = "ghp-not-a-real-token";

function contextWith(fetchImpl: typeof fetch) {
  vi.stubGlobal("fetch", fetchImpl);
  const logged: Record<string, unknown>[] = [];
  return {
    logged,
    ctx: {
      secrets: { resolve: async () => TOKEN },
      logger: {
        info: (_message: string, fields?: Record<string, unknown>) => logged.push(fields ?? {}),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    } as never,
  };
}

describe("config repository settings", () => {
  it("refuses a repository that is not owner/name", () => {
    expect(() => parseConfigRepoSettings({})).toThrow(/owner\/name/);
    expect(() => parseConfigRepoSettings({ ...SETTINGS, [CONFIG_KEYS.configRepo]: "not a repo" })).toThrow();
  });

  it("requires the token as a secret ref", () => {
    expect(() =>
      parseConfigRepoSettings({ ...SETTINGS, [CONFIG_KEYS.configRepoToken]: "ghp-pasted" }),
    ).toThrow(/Paperclip secret/);
  });

  it("treats a blank branch as the repository's default", () => {
    expect(parseConfigRepoSettings({ ...SETTINGS, [CONFIG_KEYS.configRepoBranch]: "" }).branch).toBeUndefined();
    expect(parseConfigRepoSettings({ ...SETTINGS, [CONFIG_KEYS.configRepoBranch]: "master" }).branch).toBe("master");
  });
});

describe("reading BOM files", () => {
  const listing = [
    { name: "product-9001.yaml", path: "bom/product-9001.yaml", type: "file", size: 400 },
    { name: "README.md", path: "bom/README.md", type: "file", size: 100 },
    { name: "archive", path: "bom/archive", type: "dir" },
  ];

  it("asks only for bom/, at the commit it was given", async () => {
    const urls: string[] = [];
    const { ctx } = contextWith((async (url: string) => {
      urls.push(url);
      if (url.includes("/contents/bom?")) {
        return new Response(JSON.stringify(listing), { status: 200 });
      }
      return new Response("catalog_key: product-9001\n", { status: 200 });
    }) as never);

    const repo = await githubConfigRepo(ctx, "company", parseConfigRepoSettings(SETTINGS));
    const sources = await repo.readBoms("a".repeat(40));

    expect(sources).toHaveLength(1);
    expect(sources[0]?.fileName).toBe("product-9001.yaml");
    expect(sources[0]?.text).toContain("product-9001");
    // Every request names bom/ and the commit. Nothing walks the rest of the
    // repository, which holds private business settings.
    expect(urls.every((url) => url.includes("/contents/bom") && url.includes("ref=" + "a".repeat(40)))).toBe(true);
  });

  it("refuses a file too large to be a BOM, before reading any of them", async () => {
    const { ctx } = contextWith((async () =>
      new Response(JSON.stringify([{ ...listing[0], size: 9_000_000 }]), { status: 200 })) as never);
    const repo = await githubConfigRepo(ctx, "company", parseConfigRepoSettings(SETTINGS));
    await expect(repo.readBoms("b".repeat(40))).rejects.toThrow(/too large to be a BOM/);
  });

  it("reports a GitHub refusal without quoting the token or the response", async () => {
    const { ctx } = contextWith((async () =>
      new Response(`{"message":"Bad credentials","token":"${TOKEN}"}`, { status: 401 })) as never);
    const repo = await githubConfigRepo(ctx, "company", parseConfigRepoSettings(SETTINGS));
    await expect(repo.readBoms("c".repeat(40))).rejects.toThrow(/HTTP 401/);
    await expect(repo.readBoms("c".repeat(40))).rejects.not.toThrow(new RegExp(TOKEN));
  });

  it("resolves the default branch's head when no commit is given", async () => {
    const { ctx } = contextWith((async (url: string) => {
      if (url.endsWith("/example-config")) {
        return new Response(JSON.stringify({ default_branch: "master" }), { status: 200 });
      }
      return new Response(JSON.stringify({ sha: "d".repeat(40) }), { status: 200 });
    }) as never);
    const repo = await githubConfigRepo(ctx, "company", parseConfigRepoSettings(SETTINGS));
    expect(await repo.headCommit()).toBe("d".repeat(40));
  });
});
