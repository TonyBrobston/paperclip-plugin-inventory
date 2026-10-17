/**
 * Reading `bom/` out of the private config repository, at one commit.
 *
 * BOM files are source: they change through pull requests, and a sync records
 * which commit it read. So this reads a *commit*, never a working copy and
 * never "whatever the branch says right now" halfway through a run — a push
 * landing mid-sync would otherwise produce a version nobody can reproduce.
 *
 * Only `bom/*.yaml` is ever requested. The rest of that repository is private
 * business settings, and a reader that walked it would be a reader that could
 * be pointed at them.
 */

import type { EnvSecretRefBinding, PluginContext } from "@paperclipai/plugin-sdk";
import { ConfigError, isSecretRefBinding } from "./config.js";
import { CONFIG_KEYS, SETTINGS_PATH } from "./constants.js";
import { OperatorFacingError } from "./errors.js";

export class ConfigRepoError extends OperatorFacingError {}

/** `owner/name`, as GitHub spells it. */
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/** A commit-ish we are willing to put in a URL: a sha, or a branch name. */
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;

/** The contents API tops out around a megabyte; a BOM is kilobytes. */
const MAX_FILE_BYTES = 256 * 1024;

/** Enough for every product a small manufacturer sells, and a stop on a loop. */
const MAX_FILES = 300;

const TIMEOUT_MS = 30_000;

export interface ConfigRepoSettings {
  repo: string;
  /** Unresolved; the value is fetched per call and never stored. */
  token: EnvSecretRefBinding;
  /** Omitted means "the repository's default branch". */
  branch?: string;
}

export function parseConfigRepoSettings(config: Record<string, unknown>): ConfigRepoSettings {
  const repo = config[CONFIG_KEYS.configRepo];
  if (typeof repo !== "string" || !REPO.test(repo)) {
    throw new ConfigError(
      `Set the private config repository as owner/name in ${SETTINGS_PATH} before syncing BOMs.`,
    );
  }
  if (!isSecretRefBinding(config[CONFIG_KEYS.configRepoToken])) {
    throw new ConfigError(
      "Select a Paperclip secret holding a GitHub token with read access to the private config repository. BOM files are private, so the token is a secret ref rather than plugin config.",
    );
  }
  const branch = config[CONFIG_KEYS.configRepoBranch];
  if (branch !== undefined && branch !== null && branch !== "") {
    if (typeof branch !== "string" || !REF.test(branch)) {
      throw new ConfigError("The config repository branch is not a usable branch name.");
    }
  }
  return {
    repo,
    token: config[CONFIG_KEYS.configRepoToken] as EnvSecretRefBinding,
    ...(typeof branch === "string" && branch !== "" ? { branch } : {}),
  };
}

export interface BomSource {
  /** Path in the repository, e.g. `bom/product-127.yaml`. */
  path: string;
  /** File name only, which is what has to match the catalog key. */
  fileName: string;
  text: string;
}

export interface ConfigRepo {
  repo: string;
  /** The commit a sync without an explicit commit should read. */
  headCommit(): Promise<string>;
  /** Every `bom/*.yaml` at that commit, in a stable order. */
  readBoms(commit: string): Promise<BomSource[]>;
}

interface ContentEntry {
  name: string;
  path: string;
  type: string;
  size?: number;
}

/**
 * A GitHub reader for one repository.
 *
 * The token is resolved once per client and held only in this closure; it is
 * never logged, never returned, and never included in an error. A GitHub error
 * reaches the agent as a status and a sentence about what to check, because
 * the response body of a 404 on a private repository is indistinguishable from
 * the body of a 404 on a repository the token cannot see.
 */
export async function githubConfigRepo(
  ctx: PluginContext,
  companyId: string,
  settings: ConfigRepoSettings,
): Promise<ConfigRepo> {
  const token = await ctx.secrets.resolve(settings.token, {
    companyId,
    configPath: CONFIG_KEYS.configRepoToken,
  });
  if (!token) throw new ConfigError("The configured GitHub token secret resolved to an empty value.");

  const base = `https://api.github.com/repos/${settings.repo}`;
  const request = async (url: string, accept: string): Promise<Response> => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "paperclip-plugin-inventory",
      },
    });
    if (!response.ok) {
      throw new ConfigRepoError(
        `GitHub refused to read ${settings.repo} (HTTP ${response.status}). Check that the token in ${SETTINGS_PATH} is current and has read access to that repository, then run sync_boms again.`,
      );
    }
    return response;
  };
  const json = async <T>(path: string): Promise<T> =>
    (await (await request(`${base}${path}`, "application/vnd.github+json")).json()) as T;

  return {
    repo: settings.repo,

    async headCommit(): Promise<string> {
      const branch =
        settings.branch ?? (await json<{ default_branch?: string }>("")).default_branch;
      if (!branch || !REF.test(branch)) {
        throw new ConfigRepoError(`${settings.repo} did not report a usable default branch.`);
      }
      const commit = await json<{ sha?: string }>(`/commits/${encodeURIComponent(branch)}`);
      if (!commit.sha || !/^[0-9a-f]{40}$/.test(commit.sha)) {
        throw new ConfigRepoError(`${settings.repo} did not report a commit for ${branch}.`);
      }
      return commit.sha;
    },

    async readBoms(commit: string): Promise<BomSource[]> {
      if (!REF.test(commit)) throw new ConfigError("That is not a usable commit or branch name.");
      const ref = `?ref=${encodeURIComponent(commit)}`;
      const listing = await json<ContentEntry[] | ContentEntry>(`/contents/bom${ref}`);
      if (!Array.isArray(listing)) {
        throw new ConfigRepoError(`${settings.repo} has no bom/ directory at ${commit}.`);
      }
      const files = listing
        .filter((entry) => entry.type === "file" && /\.ya?ml$/.test(entry.name))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (files.length > MAX_FILES) {
        throw new ConfigRepoError(
          `bom/ holds ${files.length} files, more than this sync will read at once (${MAX_FILES}).`,
        );
      }
      const sources: BomSource[] = [];
      for (const file of files) {
        if ((file.size ?? 0) > MAX_FILE_BYTES) {
          throw new ConfigRepoError(
            `${file.path} is ${file.size} bytes, which is too large to be a BOM. Nothing was imported.`,
          );
        }
        // Raw rather than the base64 envelope: one decode fewer, and the
        // envelope's own `content` field is absent above a megabyte anyway.
        const response = await request(
          `${base}/contents/${file.path
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/")}${ref}`,
          "application/vnd.github.raw",
        );
        sources.push({ path: file.path, fileName: file.name, text: await response.text() });
      }
      ctx.logger.info("Read BOM files from the config repository", {
        companyId,
        repo: settings.repo,
        commit,
        files: sources.length,
      });
      return sources;
    },
  };
}
