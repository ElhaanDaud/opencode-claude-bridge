/**
 * Drives the real plugin fetch wrapper through the pool's failure handling.
 * The pool runs on the file backend under a throwaway HOME (the keychain
 * backend is chosen by platform), and the Anthropic API is a stubbed fetch.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

process.env.CLAUDE_POOL_AUTO_ENROLL = "0";
Object.defineProperty(process, "platform", { value: "linux" });

const { default: plugin } = await import("./index.js");
const { createAccountStore, createSecretBackend } = await import("./pool/secret-store.js");
const { createRotationStateStore, defaultStatePath } = await import("./pool/rotation-state.js");

type Reply = { status: number; body: string; headers?: Record<string, string> };

const realFetch = globalThis.fetch;
const realHome = process.env.HOME;
let home = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rotation-loop-"));
  process.env.HOME = home;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const errorBody = (type: string, message: string) =>
  JSON.stringify({ type: "error", error: { type, message }, request_id: `req_${Math.random()}` });

const OAUTH_UNSUPPORTED: Reply = {
  status: 401,
  body: errorBody("authentication_error", "OAuth authentication is currently not supported."),
};
const RATE_LIMITED: Reply = {
  status: 429,
  body: errorBody("rate_limit_error", "limit"),
  headers: { "retry-after": "3600" },
};
const BAD_REQUEST: Reply = { status: 400, body: errorBody("invalid_request_error", "bad field") };
const OK: Reply = { status: 200, body: "event: message_stop\ndata: {}\n\n" };

/** Enroll `alice` (active) and `bob`, then send one request through the plugin. */
async function sendWith(replies: Record<string, Reply>): Promise<{ status: number; tried: string[] }> {
  const accounts = createAccountStore(createSecretBackend());
  for (const label of ["alice", "bob"]) {
    await accounts.putAccount({
      label,
      oauth: { access: `access-${label}`, refresh: `refresh-${label}`, expires: Date.now() + 3_600_000 },
      enrolledAt: Date.now(),
    });
  }
  const state = createRotationStateStore({ path: defaultStatePath() });
  await state.ensureAccount("alice");
  await state.ensureAccount("bob");
  await state.setActive("alice");

  const tried: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("/v1/messages")) return new Response("{}", { status: 404 });
    const label = String((init?.headers as Record<string, string>).authorization).replace("Bearer access-", "");
    tried.push(label);
    const reply = replies[label]!;
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  }) as typeof fetch;

  const hooks = await plugin({ client: { auth: { set: async () => {} } } });
  const loaded = await hooks.auth.loader(
    async () => ({ type: "oauth", access: "unused", refresh: "unused", expires: Date.now() + 3_600_000 }),
    { models: {} },
  ) as { fetch: typeof fetch };
  const response = await loaded.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [] }),
  });
  await response.text();
  return { status: response.status, tried };
}

function accountState(label: string) {
  return createRotationStateStore({ path: defaultStatePath() }).load().accounts[label];
}

describe("pool rotation: 401/403 penalties need another account to succeed", () => {
  it("disables the first account once another account serves the same request", async () => {
    const { status, tried } = await sendWith({ alice: OAUTH_UNSUPPORTED, bob: OK });

    assert.equal(status, 200);
    assert.deepEqual(tried, ["alice", "bob"]);
    assert.equal(accountState("alice")?.disabled, true);
  });

  it("does not disable the first account when the next one is merely rate-limited", async () => {
    const { status, tried } = await sendWith({ alice: OAUTH_UNSUPPORTED, bob: RATE_LIMITED });

    assert.deepEqual(tried, ["alice", "bob"]);
    assert.equal(status, 429);
    assert.equal(accountState("alice")?.disabled, false);
    assert.equal(accountState("alice")?.cooldownUntil, null);
    // The rate limit itself is the second account's own, so it still cools.
    assert.ok((accountState("bob")?.cooldownUntil ?? 0) > Date.now());
  });

  it("does not penalise the first account when the next one rejects the request", async () => {
    const { status } = await sendWith({ alice: OAUTH_UNSUPPORTED, bob: BAD_REQUEST });

    assert.equal(status, 400);
    assert.equal(accountState("alice")?.disabled, false);
    assert.equal(accountState("bob")?.disabled, false);
  });

  it("blames the request when both accounts fail identically", async () => {
    const { status } = await sendWith({ alice: OAUTH_UNSUPPORTED, bob: OAUTH_UNSUPPORTED });

    assert.equal(status, 401);
    assert.equal(accountState("alice")?.disabled, false);
    assert.equal(accountState("bob")?.disabled, false);
  });
});
