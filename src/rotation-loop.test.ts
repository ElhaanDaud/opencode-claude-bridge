/**
 * Drives the real plugin fetch wrapper through the pool's failure handling.
 * The pool runs on the file backend under a throwaway HOME (the keychain
 * backend is chosen by platform), the Anthropic API is a stubbed fetch, and
 * token refreshes go to a local token endpoint.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

process.env.CLAUDE_POOL_AUTO_ENROLL = "0";
Object.defineProperty(process, "platform", { value: "linux" });

// Refreshes run through curl, so they need a real endpoint. It rejects every
// refresh token unless `renewTokens` is set, then mints `access-<label>-renewed`.
let renewTokens = false;
let refreshCalls: string[] = [];
const tokenServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const refreshToken = String(JSON.parse(raw).refresh_token);
    refreshCalls.push(refreshToken);
    res.setHeader("content-type", "application/json");
    if (!renewTokens) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }));
      return;
    }
    const label = refreshToken.replace("refresh-", "");
    res.end(JSON.stringify({ access_token: `access-${label}-renewed`, refresh_token: `refresh-${label}-renewed`, expires_in: 3600 }));
  });
});
await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/v1/oauth/token`;
after(() => tokenServer.close());

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
  renewTokens = false;
  refreshCalls = [];
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

/**
 * Enroll `alice` (active) and `bob`, then send one request through the plugin.
 * Replies are keyed by access token minus `access-`, so `alice-renewed` answers
 * alice's refreshed token.
 */
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
    const token = String((init?.headers as Record<string, string>).authorization).replace("Bearer access-", "");
    tried.push(token);
    const reply = replies[token]!;
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  }) as typeof fetch;

  const hooks = await plugin.server({ client: { auth: { set: async () => {} } } });
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
    assert.deepEqual(refreshCalls, ["refresh-alice"]);
    assert.equal(accountState("alice")?.disabled, true);
  });

  it("refreshes a rejected access token and resends before blaming the account", async () => {
    renewTokens = true;
    const { status, tried } = await sendWith({ alice: OAUTH_UNSUPPORTED, "alice-renewed": OK, bob: OK });

    assert.equal(status, 200);
    assert.deepEqual(tried, ["alice", "alice-renewed"]);
    assert.deepEqual(refreshCalls, ["refresh-alice"]);
    assert.equal(accountState("alice")?.disabled, false);
  });

  it("disables the account when its refreshed token is rejected too and another account succeeds", async () => {
    renewTokens = true;
    const { status, tried } = await sendWith({
      alice: OAUTH_UNSUPPORTED,
      "alice-renewed": OAUTH_UNSUPPORTED,
      bob: OK,
    });

    assert.equal(status, 200);
    assert.deepEqual(tried, ["alice", "alice-renewed", "bob"]);
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
    // The identical failure is caught before bob's refresh token is spent.
    assert.deepEqual(refreshCalls, ["refresh-alice"]);
    assert.equal(accountState("alice")?.disabled, false);
    assert.equal(accountState("bob")?.disabled, false);
  });
});

describe("pool rotation: concurrent requests on one account", () => {
  it("a late success does not clear a cooldown set while it was in flight", async () => {
    await sendWith({ alice: OK, bob: OK }); // enrolls both, alice active

    // The first request to reach alice is held; the next one is rate-limited.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let sent!: () => void;
    const firstSent = new Promise<void>((resolve) => (sent = resolve));
    let aliceCalls = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes("/v1/messages")) return new Response("{}", { status: 404 });
      const label = String((init?.headers as Record<string, string>).authorization).replace("Bearer access-", "");
      if (label === "alice" && ++aliceCalls === 1) {
        sent();
        await held;
      } else if (label === "alice") {
        return new Response(RATE_LIMITED.body, { status: 429, headers: RATE_LIMITED.headers });
      }
      return new Response(OK.body, { status: 200 });
    }) as typeof fetch;

    const hooks = await plugin.server({ client: { auth: { set: async () => {} } } });
    const loaded = await hooks.auth.loader(
      async () => ({ type: "oauth", access: "unused", refresh: "unused", expires: Date.now() + 3_600_000 }),
      { models: {} },
    ) as { fetch: typeof fetch };
    const send = () => loaded.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [] }),
    });

    const first = send();
    await firstSent;
    await (await send()).text();
    const cooled = accountState("alice");
    assert.ok((cooled?.cooldownUntil ?? 0) > Date.now());

    release();
    const response = await first;
    await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(accountState("alice"), cooled);
  });
});

describe("pool rotation: in-place retries share one wait budget per request", () => {
  const limited = (retryAfter: string): Reply => ({
    status: 429,
    body: errorBody("rate_limit_error", "limit"),
    headers: { "retry-after": retryAfter },
  });

  /** Run backoff sleeps at once, recording what each one asked for. */
  async function recordingWaits<T>(run: () => Promise<T>): Promise<{ result: T; waits: number[] }> {
    const realSetTimeout = globalThis.setTimeout;
    const waits: number[] = [];
    globalThis.setTimeout = ((fn: () => void, ms = 0) => {
      if (ms < 1000) return realSetTimeout(fn, ms);
      waits.push(ms);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout;
    try {
      return { result: await run(), waits };
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  }

  it("retries a short reset in place, then rotates once the budget is spent", async () => {
    const { result, waits } = await recordingWaits(() => sendWith({ alice: limited("4"), bob: OK }));

    assert.equal(result.status, 200);
    assert.deepEqual(result.tried, ["alice", "alice", "alice", "bob"]);
    assert.deepEqual(waits, [4000, 4000]);
    assert.ok((accountState("alice")?.cooldownUntil ?? 0) > Date.now());
  });

  it("cools every account instead of sleeping when each asks to retry in 60s", async () => {
    const { result, waits } = await recordingWaits(() =>
      sendWith({ alice: limited("60"), bob: limited("60") }));

    assert.equal(result.status, 429);
    assert.deepEqual(result.tried, ["alice", "bob"]);
    assert.deepEqual(waits, []);
    assert.ok((accountState("alice")?.cooldownUntil ?? 0) > Date.now());
    assert.ok((accountState("bob")?.cooldownUntil ?? 0) > Date.now());
  });
});
