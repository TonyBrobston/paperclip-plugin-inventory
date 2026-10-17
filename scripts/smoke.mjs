/**
 * End-to-end smoke test for the *built* plugin.
 *
 * Forks `dist/worker.js` the way the Paperclip host does — stdio pipes, NDJSON
 * JSON-RPC, a deliberately minimal environment — plays the host side of the
 * protocol, and drives every declared tool.
 *
 * The unit suite imports `src/`, so it cannot see a bundling fault. This can,
 * and already has: the first build inlined `pg`, whose CommonJS `require` call
 * esbuild turns into a throwing stub, and the worker died during module load
 * before answering a single RPC. Nothing else in the repository would have
 * noticed until an operator installed it.
 *
 * It also re-checks the result-forwarding rule against the real worker rather
 * than against the harness, because that is the defect class that shipped in
 * the BigCommerce plugin.
 */
import { fork } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const manifest = (await import(`${PLUGIN_DIR}/dist/manifest.js`)).default;

const child = fork(`${PLUGIN_DIR}/dist/worker.js`, [], {
  stdio: ["pipe", "pipe", "pipe", "ipc"],
  // The same minimal environment the host gives a worker. If the plugin ever
  // starts depending on an inherited variable, it fails here first.
  env: { PATH: process.env.PATH, NODE_ENV: "production", TZ: "UTC" },
});

const pending = new Map();
let nextId = 1;

function send(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return promise;
}

function reply(id, result) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const SECRET_REF = { type: "secret_ref", secretId: "secret-smoke" };
const CONNECTION_STRING = "postgres://smoke:smoke@127.0.0.1:1/smoke";

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log("  [worker stdout non-JSON]", line.slice(0, 160));
    return;
  }

  // A response to something we sent.
  if (msg.id !== undefined && msg.method === undefined) {
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result);
    }
    return;
  }

  // An outbound host call from the worker — we are the host.
  if (msg.method) {
    if (msg.method === "config.get") {
      reply(msg.id, { databaseUrl: SECRET_REF, databaseSchema: "inventory" });
    } else if (msg.method === "secrets.resolve") {
      reply(msg.id, CONNECTION_STRING);
    } else if (msg.id !== undefined) {
      reply(msg.id, null);
    }
  }
});

createInterface({ input: child.stderr }).on("line", (l) =>
  console.log("  [worker stderr]", l.slice(0, 200)),
);

const fail = (msg) => {
  console.log(`\nFAIL: ${msg}`);
  child.kill();
  process.exit(1);
};

const runContext = {
  agentId: "agent-smoke",
  runId: "run-smoke",
  companyId: "company-smoke",
  projectId: "project-smoke",
};

/**
 * The host's forwarding rule, from the `tools/call` branch of the MCP tool
 * gateway an agent run mounts:
 *
 *   content:           [{ type: "text", text: <result.content ?? JSON(data)> }]
 *   structuredContent: result.data ?? null
 *
 * Note the `?? null`. `error` is not one of the two fields that travel, so a
 * `ToolResult` carrying only `error` reaches the agent as an explicit
 * `structuredContent: null`, which the client's schema rejects — discarding
 * `content` along with it. A tool that writes its message into `error` alone
 * is a tool whose message never arrives.
 */
const forwardAsMcpResult = (result) => ({
  content: [
    {
      type: "text",
      text:
        typeof result?.content === "string"
          ? result.content
          : JSON.stringify(result?.data ?? result ?? null),
    },
  ],
  structuredContent: result?.data ?? null,
});

/** The client-side schema check that rejects a non-object. */
const clientAcceptsStructuredContent = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function assertForwardable(label, result) {
  const forwarded = forwardAsMcpResult(result);
  if (!clientAcceptsStructuredContent(forwarded.structuredContent)) {
    fail(
      `${label} produced structuredContent the agent's client rejects: ${JSON.stringify(
        forwarded.structuredContent,
      )}`,
    );
  }
  if (typeof forwarded.content[0].text !== "string" || forwarded.content[0].text === "") {
    fail(`${label} forwarded an empty text block`);
  }
  return forwarded;
}

try {
  await send("initialize", {
    manifest,
    config: {},
    instanceInfo: {
      instanceId: "00000000-0000-0000-0000-000000000000",
      hostVersion: "0.0.0-smoke",
    },
    apiVersion: 1,
  });
  console.log("initialize: ok");

  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
    fail("the built manifest declares no tools");
  }

  /**
   * Tools with a handler, as of phase 5. Repeated here rather than imported
   * because `dist/worker.js` starts a worker the moment it is loaded;
   * `tests/worker.spec.ts` asserts this list still matches `dispatch`.
   *
   * The host above hands them a connection string pointing at a closed port,
   * which is the interesting case for a smoke test: the three implemented
   * tools must come back with something an operator can act on, through the
   * real bundle, rather than taking the worker down with them.
   */
  const IMPLEMENTED = new Set(["record_receipt", "record_adjustment", "get_stock", "submit_order_email", "list_review_queue", "resolve_review_item", "sync_sheet", "sync_boms", "record_sale"]);

  for (const tool of manifest.tools) {
    const result = await send("executeTool", {
      toolName: tool.name,
      parameters: {},
      runContext,
    });

    // Whatever the answer is, it has to survive the trip to the agent.
    const forwarded = assertForwardable(tool.name, result);

    // The remaining handlers land over phases 3-6. Until then the honest
    // answer is which phase the tool is waiting on.
    const expected = IMPLEMENTED.has(tool.name)
      ? /could not be (opened|brought up to date)|is required|not a part reference|must be a UUID|Configure the inventory spreadsheet ID|Set the private config repository/
      : /phase \d/;

    for (const [label, text] of [
      ["error", result?.error ?? ""],
      ["the agent's text block", forwarded.content[0].text],
      ["structuredContent", JSON.stringify(forwarded.structuredContent)],
    ]) {
      if (!expected.test(text)) {
        fail(`${tool.name} said nothing useful in ${label}: ${JSON.stringify(result)}`);
      }
    }

    // A failure that leaks the connection string is worse than no failure
    // message at all, and this is the only place the real bundle is exercised
    // against a connection it cannot make.
    const everything = `${result?.error} ${forwarded.content[0].text} ${JSON.stringify(forwarded.structuredContent)}`;
    if (/smoke:smoke|127\.0\.0\.1:1\b/.test(everything)) {
      fail(`${tool.name} quoted the connection string back to the agent`);
    }

    // The bundle has to find `migrations/` relative to dist/worker.js, which
    // only the built artifact can prove: the unit suite imports src/, and a
    // bundler that rewrote import.meta.url would break this and nothing else.
    // Reaching the connection attempt at all means the files were read.
    if (/missing its migrations directory/.test(everything)) {
      fail(`${tool.name} could not find migrations/ next to the built worker`);
    }

    console.log(`${tool.name}: ${result.error}`);
  }

  // Test Connection, through the built worker rather than the source module.
  const bad = await send("validateConfig", { config: { databaseUrl: "postgres://nope" } });
  if (bad?.ok !== false) fail("validateConfig accepted a connection string pasted as text");

  const good = await send("validateConfig", {
    config: { databaseUrl: SECRET_REF, databaseSchema: "inventory" },
  });
  if (good?.ok !== true) fail(`validateConfig rejected a valid config: ${JSON.stringify(good)}`);
  console.log("validateConfig: refuses a pasted string, accepts a secret ref");

  console.log(`\nPASS: ${manifest.tools.length} tools registered and reachable in the built worker`);
  child.kill();
  process.exit(0);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
