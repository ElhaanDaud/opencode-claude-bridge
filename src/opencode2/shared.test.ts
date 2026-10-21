/**
 * The OpenCode 2 path through the code it shares with V1: prepareRequest,
 * settlePoolResponse and startPool in src/index.ts. The V1 suites cover those
 * fixes through the V1 fetch wrapper; these drive V2's hooks the way core
 * does (see server.test.ts). Pool, Claude CLI login and the captured-prompt
 * path live under a throwaway HOME, the Anthropic API is a stubbed fetch, and
 * token refreshes go to a local endpoint (the real path shells out to curl).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

// Mints `access-<label>-renewed` for `refresh-<label>`.
const refreshCalls: string[] = [];
const tokenServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const refreshToken = String(JSON.parse(raw).refresh_token);
    refreshCalls.push(refreshToken);
    const label = refreshToken.replace("refresh-", "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ access_token: `access-${label}-renewed`, refresh_token: `refresh-${label}-renewed`, expires_in: 3600 }));
  });
});
await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
const local = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}`;
after(() => tokenServer.close());

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "v2-shared-"));
process.env.HOME = scratch;
process.env.CLAUDE_CONFIG_DIR = path.join(scratch, ".claude");
process.env.ANTHROPIC_TOKEN_URL = `${local}/v1/oauth/token`;
process.env.ANTHROPIC_PROFILE_URL = `${local}/api/oauth/profile`;
// No captured Claude Code prompt, so OpenCode's own system prompt is normalised.
process.env.ANTHROPIC_SYSTEM_PROMPT_PATH = path.join(scratch, "claude-system-prompt.json");
process.env.ANTHROPIC_CLI_VERSION = "2.1.200";
process.env.CLAUDE_POOL_AUTO_ENROLL = "0";
Object.defineProperty(process, "platform", { value: "linux" });
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { default: plugin } = await import("./server.js");
const { createAccountStore, createSecretBackend } = await import("../pool/secret-store.js");
const { createRotationStateStore, defaultStatePath } = await import("../pool/rotation-state.js");
type V2HttpRequestEvent = import("./server.js").V2HttpRequestEvent;
type V2HttpResponseEvent = import("./server.js").V2HttpResponseEvent;
type V2Context = import("./server.js").V2Context;

type Reply = { status: number; body: string; headers?: Record<string, string> };
type Sent = { token: string; body: Record<string, unknown> };

const realFetch = globalThis.fetch;
let home = "";
let cleanups: Array<() => void> = [];
let profile: () => Response;
let profileLookups = 0;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(scratch, "home-"));
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  process.env.CLAUDE_POOL_ACCOUNTS_DIR = path.join(home, "accounts");
  process.env.CLAUDE_POOL_STATE_PATH = path.join(home, "rotation-state.json");
  refreshCalls.length = 0;
  profileLookups = 0;
  profile = () => Response.json({ account: { uuid: "uuid-alice", email_address: "alice@example.com" } });
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  globalThis.fetch = realFetch;
  process.env.HOME = scratch;
});

const errorBody = (type: string, message: string) =>
  JSON.stringify({ type: "error", error: { type, message }, request_id: `req_${Math.random()}` });

const OK: Reply = { status: 200, body: "event: message_stop\ndata: {}\n\n" };
const OAUTH_UNSUPPORTED: Reply = {
  status: 401,
  body: errorBody("authentication_error", "OAuth authentication is currently not supported."),
};
const limited = (retryAfter: string): Reply => ({
  status: 429,
  body: errorBody("rate_limit_error", "limit"),
  headers: { "retry-after": retryAfter },
});

const PLAIN = {
  model: "claude-haiku-4-5-20251001",
  system: [{ type: "text", text: "You are OpenCode." }],
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

async function enroll(labels: string[], email?: string): Promise<void> {
  const accounts = createAccountStore(createSecretBackend());
  const state = createRotationStateStore({ path: defaultStatePath() });
  for (const label of labels) {
    await accounts.putAccount({
      label,
      oauth: { access: `access-${label}`, refresh: `refresh-${label}`, expires: Date.now() + 3_600_000 },
      enrolledAt: Date.now(),
      ...(email ? { email } : {}),
    });
    await state.ensureAccount(label);
  }
  await state.setActive(labels[0]!);
}

function accountState(label: string) {
  return createRotationStateStore({ path: defaultStatePath() }).load().accounts[label];
}

/** Stub Anthropic: `upstream` answers /v1/messages by access token minus `access-`. */
function stubFetch(upstream: (token: string) => Reply | Promise<Reply>): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("data:")) return realFetch(url, init);
    if (String(url).includes("/oauth/profile")) {
      profileLookups++;
      return profile();
    }
    if (!String(url).includes("/v1/messages")) return new Response("{}", { status: 404 });
    const request = new Request(url, init);
    const token = String(request.headers.get("authorization")).replace("Bearer access-", "");
    sent.push({ token, body: JSON.parse(await request.text()) as Record<string, unknown> });
    const reply = await upstream(token);
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
  return sent;
}

/** Load the plugin against a minimal V2 context. */
async function load() {
  const hooks: {
    request?: (event: V2HttpRequestEvent) => Promise<void> | void;
    response?: (event: V2HttpResponseEvent) => Promise<void> | void;
  } = {};
  const ctx: V2Context = {
    session: {
      hook: (async (name: string, callback: unknown) => {
        if (name === "http.request") hooks.request = callback as typeof hooks.request;
        if (name === "http.response") hooks.response = callback as typeof hooks.response;
      }) as V2Context["session"]["hook"],
    },
    integration: {
      transform: async () => undefined,
      connection: { active: async () => undefined, resolve: async () => undefined },
    },
    provider: { transform: async () => undefined },
  };
  cleanups.push(await plugin.setup(ctx));
  return hooks;
}

/** One request through both hooks, with core's send in between; resolves once the body is read. */
async function through(hooks: Awaited<ReturnType<typeof load>>, body: unknown = PLAIN, sessionID = "ses_1") {
  const model = { providerID: "anthropic" };
  const before: V2HttpRequestEvent = {
    sessionID,
    kind: "primary",
    model,
    request: new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
  await hooks.request!(before);
  const upstream = await globalThis.fetch(before.request.url, {
    method: before.request.method,
    headers: before.request.headers,
    body: await before.request.clone().text(),
  });
  const after: V2HttpResponseEvent = { sessionID, kind: "primary", model, request: before.request, response: upstream };
  await hooks.response!(after);
  await after.response.text();
  return after.response.status;
}

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

describe("OpenCode 2: request rewrite (prepareRequest)", () => {
  it("keeps a forced tool and turns thinking off, except on Sonnet 5.5", async () => {
    await enroll(["alice"]);
    const sent = stubFetch(() => OK);
    const hooks = await load();
    const forced = {
      ...PLAIN,
      model: "claude-opus-5-5",
      tools: [{ name: "shell", description: "run", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "any" },
      thinking: { type: "enabled", budget_tokens: 2048 },
      temperature: 0,
    };

    assert.equal(await through(hooks, forced), 200);
    assert.deepEqual(sent[0]!.body.tool_choice, { type: "any" });
    assert.deepEqual(sent[0]!.body.thinking, { type: "disabled" });
    assert.equal(sent[0]!.body.temperature, 0);

    assert.equal(await through(hooks, { ...forced, model: "claude-sonnet-5-5" }), 200);
    assert.equal(sent[1]!.body.tool_choice, undefined);
    assert.deepEqual(sent[1]!.body.thinking, { type: "adaptive" });
  });

  it("sends quoted text verbatim and renames only a standalone OpenCode", async () => {
    await enroll(["alice"]);
    const sent = stubFetch(() => OK);
    const hooks = await load();

    assert.equal(await through(hooks, {
      ...PLAIN,
      system: [{ type: "text", text: "You are OpenCode. Config: /Applications/OpenCode.app, ~/.config/opencode" }],
      messages: [{ role: "user", content: [{ type: "text", text: '"hello"' }] }],
    }), 200);
    const system = (sent[0]!.body.system as Array<{ text: string }>).map((block) => block.text).join("\n");
    assert.match(system, /You are Claude Code\. Config: \/Applications\/OpenCode\.app, ~\/\.config\/opencode/);
    const messages = sent[0]!.body.messages as Array<{ content: Array<{ text: string }> }>;
    assert.equal(messages[0]!.content[0]!.text, '"hello"');
  });

  it("does not repeat a failed profile lookup on every request", async () => {
    await enroll(["carol"]);
    profile = () => new Response("{}", { status: 500 });
    const sent = stubFetch(() => OK);
    const hooks = await load();

    assert.equal(await through(hooks), 200);
    assert.equal(await through(hooks), 200);
    assert.equal(profileLookups, 1);
    assert.equal((sent[1]!.body.metadata as { user_id?: string }).user_id, undefined);
  });
});

describe("OpenCode 2: pool rotation (settlePoolResponse)", () => {
  it("refreshes a rejected access token and resends before blaming the account", async () => {
    await enroll(["alice", "bob"]);
    const sent = stubFetch((token) => (token === "alice" ? OAUTH_UNSUPPORTED : OK));
    const hooks = await load();

    assert.equal(await through(hooks), 200);
    assert.deepEqual(sent.map((s) => s.token), ["alice", "alice-renewed"]);
    assert.deepEqual(refreshCalls, ["refresh-alice"]);
    assert.equal(accountState("alice")?.disabled, false);
    const stored = await createAccountStore(createSecretBackend()).getAccount("alice");
    assert.equal(stored?.oauth.refresh, "refresh-alice-renewed");
  });

  it("a late success does not clear a cooldown set while it was in flight", async () => {
    await enroll(["alice", "bob"]);
    // The first request to reach alice is held; the next one is rate-limited.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const firstSent = new Promise<void>((resolve) => (reached = resolve));
    let aliceCalls = 0;
    stubFetch(async (token) => {
      if (token !== "alice") return OK;
      if (++aliceCalls > 1) return limited("3600");
      reached();
      await held;
      return OK;
    });
    const hooks = await load();

    const first = through(hooks, PLAIN, "ses_1");
    await firstSent;
    assert.equal(await through(hooks, PLAIN, "ses_2"), 200);
    const cooled = accountState("alice");
    assert.ok((cooled?.cooldownUntil ?? 0) > Date.now());

    release();
    assert.equal(await first, 200);
    assert.deepEqual(accountState("alice"), cooled);
  });

  it("retries a short reset in place, then rotates once the wait budget is spent", async () => {
    await enroll(["alice", "bob"]);
    const sent = stubFetch((token) => (token === "alice" ? limited("4") : OK));
    const hooks = await load();

    const { result, waits } = await recordingWaits(() => through(hooks));
    assert.equal(result, 200);
    assert.deepEqual(sent.map((s) => s.token), ["alice", "alice", "alice", "bob"]);
    assert.deepEqual(waits, [4000, 4000]);
    assert.ok((accountState("alice")?.cooldownUntil ?? 0) > Date.now());
  });
});

describe("OpenCode 2: pool start-up (startPool)", () => {
  it("repairs a disabled account from a newer Claude CLI login and re-enables it", async () => {
    await enroll(["alice"], "alice@example.com");
    await createRotationStateStore({ path: defaultStatePath() }).markDisabled("alice", "invalid_grant");
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "access-cli", refreshToken: "refresh-cli", expiresAt: Date.now() + 7_200_000 },
      }),
    );
    stubFetch(() => OK);
    process.env.CLAUDE_POOL_AUTO_ENROLL = "1";
    try {
      await load();
    } finally {
      process.env.CLAUDE_POOL_AUTO_ENROLL = "0";
    }

    const stored = await createAccountStore(createSecretBackend()).getAccount("alice");
    assert.equal(stored?.oauth.refresh, "refresh-cli");
    assert.equal(accountState("alice")?.disabled, false);
  });
});
