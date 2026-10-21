/**
 * Drives the real V1 plugin hooks with an API-key login stored in OpenCode 1's
 * auth.json, next to a Claude CLI login and, in one case, an enrolled pool.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-key-prompt-"));
process.env.ANTHROPIC_SYSTEM_PROMPT_PATH = path.join(promptDir, "claude-system-prompt.json");
process.env.ANTHROPIC_CLI_VERSION = "2.1.200";
process.env.CLAUDE_POOL_AUTO_ENROLL = "0";
Object.defineProperty(process, "platform", { value: "linux" });

const { default: plugin } = await import("./index.js");
const { createAccountStore, createSecretBackend } = await import("./pool/secret-store.js");

type Stored = Record<string, unknown>;

const KEY = "sk-ant-api03-TEST-KEY";
const ENV_KEYS = [
  "HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_POOL_ACCOUNTS_DIR",
  "CLAUDE_POOL_STATE_PATH", "ANTHROPIC_API_KEY", "OPENCODE_AUTH_CONTENT",
] as const;
const realEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "api-key-"));
  process.env.HOME = path.join(root, "home");
  process.env.XDG_DATA_HOME = path.join(root, "data");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "home", ".claude");
  process.env.CLAUDE_POOL_ACCOUNTS_DIR = path.join(root, "accounts");
  process.env.CLAUDE_POOL_STATE_PATH = path.join(root, "rotation-state.json");
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENCODE_AUTH_CONTENT;
  // A Claude CLI login the OAuth bootstrap could seed from.
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "cli-access", refreshToken: "cli-refresh", expiresAt: Date.now() + 3_600_000 } }),
  );
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (realEnv[k] === undefined) delete process.env[k];
    else process.env[k] = realEnv[k];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** OpenCode 1's auth.json, which `auth.set` writes and `getAuth` reads back. */
function authStore(initial: Stored | null) {
  const file = path.join(process.env.XDG_DATA_HOME!, "opencode", "auth.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const save = (auth: Stored | null) => fs.writeFileSync(file, JSON.stringify(auth ? { anthropic: auth } : {}));
  save(initial);
  const writes: Stored[] = [];
  return {
    writes,
    client: { auth: { set: async ({ body }: { body: Stored }) => { writes.push(body); save(body); } } },
    getAuth: async () => JSON.parse(fs.readFileSync(file, "utf8")).anthropic,
  };
}

async function load(initial: Stored | null) {
  const store = authStore(initial);
  const hooks = await plugin.server({ client: store.client });
  const loaded = await hooks.auth.loader(store.getAuth, { models: {} }) as Record<string, unknown>;
  return { hooks, loaded, store };
}

function systemFor(hooks: Awaited<ReturnType<typeof plugin.server>>) {
  const output = { system: ["OpenCode prompt"] };
  hooks["experimental.chat.system.transform"]({ model: { providerID: "anthropic" } }, output);
  return output.system[0];
}

describe("API key login", () => {
  it("keeps a stored API key and hands it to OpenCode without a fetch wrapper", async () => {
    const { loaded, store } = await load({ type: "api", key: KEY });
    assert.deepEqual(loaded, { apiKey: KEY });
    assert.deepEqual(store.writes, []);
    assert.deepEqual(await store.getAuth(), { type: "api", key: KEY });
  });

  it("keeps the legacy apikey credential too", async () => {
    const { loaded, store } = await load({ type: "apikey", access: KEY });
    assert.deepEqual(loaded, { apiKey: KEY });
    assert.deepEqual(store.writes, []);
  });

  it("keeps the API key with accounts enrolled, and leaves the pool unused", async () => {
    await createAccountStore(createSecretBackend()).putAccount({
      label: "a",
      enrolledAt: Date.now(),
      oauth: { access: "pool-access", refresh: "pool-refresh", expires: Date.now() + 3_600_000 },
    });
    const { loaded, store } = await load({ type: "api", key: KEY });
    assert.deepEqual(loaded, { apiKey: KEY });
    // pool.acquire() would have mirrored the account into auth.json.
    assert.deepEqual(store.writes, []);
  });

  it("does not add the Claude Code prefix to an API-key request", async () => {
    const { hooks } = await load({ type: "api", key: KEY });
    assert.equal(systemFor(hooks), "OpenCode prompt");
  });

  it("still bootstraps and rewrites for OAuth", async () => {
    const { hooks, loaded, store } = await load(null);
    assert.equal(typeof loaded.fetch, "function");
    assert.equal(store.writes[0]?.type, "oauth");
    assert.equal(store.writes[0]?.access, "cli-access");
    assert.equal(process.env.ANTHROPIC_API_KEY, "oauth-placeholder");
    assert.match(systemFor(hooks), /^You are a Claude agent/);
  });

  it("declares an api method, so OpenCode stores an api credential itself", async () => {
    const hooks = await plugin.server({ client: authStore(null).client });
    const method = hooks.auth.methods.find((m) => m.label === "Claude API Key");
    assert.equal(method?.type, "api");
    assert.equal("authorize" in method!, false);
  });
});

describe("OAuth placeholder", () => {
  it("is cleared, not kept, once an API key is loaded in the same process", async () => {
    fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"));
    await load({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 });
    assert.equal(process.env.ANTHROPIC_API_KEY, "oauth-placeholder");
    // OpenCode re-creates the plugin after a login, in the same process.
    const { loaded } = await load({ type: "api", key: KEY });
    assert.deepEqual(loaded, { apiKey: KEY });
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  });

  it("puts back the user's own ANTHROPIC_API_KEY", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-FROM-ENV";
    const store = authStore({ type: "api", key: KEY });
    const hooks = await plugin.server({ client: store.client });
    process.env.ANTHROPIC_API_KEY = "oauth-placeholder";
    await hooks.auth.loader(store.getAuth, { models: {} });
    assert.equal(process.env.ANTHROPIC_API_KEY, "sk-ant-api03-FROM-ENV");
  });

  it("is never taken for a stored key", async () => {
    const { loaded, store } = await load({ type: "api", key: "oauth-placeholder" });
    assert.equal(loaded.apiKey, undefined);
    assert.equal(store.writes[0]?.access, "cli-access");
  });
});
