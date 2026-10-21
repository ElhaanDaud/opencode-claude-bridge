/**
 * Drives the V2 plugin's hooks the way @opencode/core 2.x does: run
 * `http.request`, send the (possibly replaced) request upstream, then run
 * `http.response` on the result. The pool runs on the file backend under a
 * throwaway HOME, the Anthropic API is a stubbed fetch, and the OAuth token
 * endpoint is a local server (the real code path shells out to curl).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";

type TokenReply = { status: number; body: unknown };
const tokenRequests: Array<Record<string, string>> = [];
let tokenReply: () => TokenReply = () => ({ status: 200, body: {} });
let tokenDelayMs = 0;
// Captured so the server still answers while a test mocks timers.
const realSetTimeout = globalThis.setTimeout;
const tokenServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    tokenRequests.push(JSON.parse(raw) as Record<string, string>);
    realSetTimeout(() => {
      const reply = tokenReply();
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    }, tokenDelayMs);
  });
});
await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
const tokenPort = (tokenServer.address() as { port: number }).port;

process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${tokenPort}/token`;
process.env.ANTHROPIC_CLI_VERSION = "2.1.98";
process.env.CLAUDE_POOL_AUTO_ENROLL = "0";
Object.defineProperty(process, "platform", { value: "linux" });

const { default: plugin, authorizeByPaste } = await import("./server.js");
const { createAccountStore, createSecretBackend } = await import("../pool/secret-store.js");
const { createRotationStateStore, defaultStatePath } = await import("../pool/rotation-state.js");
type V2HttpRequestEvent = import("./server.js").V2HttpRequestEvent;
type V2HttpResponseEvent = import("./server.js").V2HttpResponseEvent;
type V2RetryEvent = import("./server.js").V2RetryEvent;
type V2Context = import("./server.js").V2Context;
type V2Connection = import("./server.js").V2Connection;
type V2Credential = import("./server.js").V2Credential;
type V2OAuthCredential = import("./server.js").V2OAuthCredential;
type V2IntegrationEditor = import("./server.js").V2IntegrationEditor;

type Reply = { status: number; body: string; headers?: Record<string, string>; reject?: boolean };

const realFetch = globalThis.fetch;
const realHome = process.env.HOME;
const realClaudeDir = process.env.CLAUDE_CONFIG_DIR;
let home = "";
let cleanups: Array<() => void> = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "v2-plugin-"));
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  tokenRequests.length = 0;
  tokenDelayMs = 0;
  tokenReply = () => ({ status: 200, body: {} });
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  mock.timers.reset();
  globalThis.fetch = realFetch;
  process.env.HOME = realHome;
  if (realClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realClaudeDir;
  fs.rmSync(home, { recursive: true, force: true });
});

after(() => {
  tokenServer.close();
});

const OK: Reply = { status: 200, body: "event: message_stop\ndata: {}\n\n" };
const RATE_LIMITED: Reply = {
  status: 429,
  body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "limit" } }),
  headers: { "retry-after": "3600" },
};

async function enroll(labels: string[], lifetimeMs = 3_600_000): Promise<void> {
  const accounts = createAccountStore(createSecretBackend());
  const state = createRotationStateStore({ path: defaultStatePath() });
  for (const label of labels) {
    await accounts.putAccount({
      label,
      oauth: { access: `access-${label}`, refresh: `refresh-${label}`, expires: Date.now() + lifetimeMs },
      enrolledAt: Date.now(),
    });
    await state.ensureAccount(label);
  }
  await state.setActive(labels[0]!);
}

async function coolAll(labels: string[]): Promise<void> {
  const state = createRotationStateStore({ path: defaultStatePath() });
  for (const label of labels) await state.markCooldown(label, Date.now() + 3_600_000, "test");
}

/** The Claude CLI's login, as the file fallback reads it. */
function writeClaudeLogin(access: string, expiresAt = Date.now() + 3_600_000): void {
  const dir = path.join(home, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: "cli-refresh", expiresAt } }),
  );
}

interface LoadOptions {
  replies?: Record<string, Reply>;
  /** What V2 reports as the active anthropic connection and its credential. */
  connection?: V2Connection;
  credential?: V2Credential;
  activation?: string;
}

/** Load the plugin against a fake V2 context and stub the upstream. */
async function load(opts: LoadOptions = {}) {
  const replies = opts.replies ?? {};
  const sent: Request[] = [];
  const timeouts: unknown[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("data:")) return realFetch(url, init);
    if (!String(url).includes("/v1/messages")) return new Response("{}", { status: 404 });
    const request = new Request(url, init);
    sent.push(request);
    timeouts.push(init && "timeout" in init ? init.timeout : undefined);
    const label = request.headers.get("authorization")?.replace("Bearer access-", "") ?? "none";
    const reply = replies[label] ?? { status: 401, body: "{}" };
    if (reply.reject) throw new TypeError("fetch failed");
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  }) as typeof fetch;

  const hooks: {
    request?: (event: V2HttpRequestEvent) => Promise<void> | void;
    response?: (event: V2HttpResponseEvent) => Promise<void> | void;
    retry?: (event: V2RetryEvent) => Promise<void> | void;
  } = {};
  const hook = (async (name: string, callback: unknown) => {
    if (name === "http.request") hooks.request = callback as typeof hooks.request;
    if (name === "http.response") hooks.response = callback as typeof hooks.response;
    if (name === "retry") hooks.retry = callback as typeof hooks.retry;
  }) as V2Context["session"]["hook"];

  const registered: Array<Parameters<V2IntegrationEditor["method"]["update"]>[0]> = [];
  const providers = { anthropic: { activation: opts.activation ?? "auto" } };
  const ctx: V2Context = {
    session: { hook },
    integration: {
      transform: async (callback) => {
        callback({ method: { update: (input) => void registered.push(input) } });
      },
      connection: {
        active: async () => opts.connection,
        resolve: async () => opts.credential,
      },
    },
    provider: {
      transform: async (callback) => {
        callback({
          get: (id) => (id === "anthropic" ? { provider: providers.anthropic } : undefined),
          update: (id, update) => {
            if (id === "anthropic") update(providers.anthropic);
          },
        });
      },
    },
  };
  const cleanup = await plugin.setup(ctx);
  cleanups.push(cleanup);
  const method = registered[0];
  assert.ok(method, "the OAuth method is registered");
  return { hooks, sent, timeouts, providers, method, cleanup };
}

type Loaded = Awaited<ReturnType<typeof load>>;

interface ThroughOptions {
  sessionID?: string;
  kind?: string;
  providerID?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** What another plugin running after ours might do to the request. */
  replace?: (request: Request) => Request;
}

/** One request through both hooks, with core's send in between. */
async function through(loaded: Loaded, opts: ThroughOptions = {}) {
  const model = { providerID: opts.providerID ?? "anthropic" };
  const sessionID = opts.sessionID ?? "ses_1";
  const kind = opts.kind ?? "primary";
  const method = opts.method ?? "POST";
  const before: V2HttpRequestEvent = {
    sessionID,
    kind,
    model,
    request: new Request(opts.url ?? "https://api.anthropic.com/v1/messages", {
      method,
      headers: { "content-type": "application/json", ...opts.headers },
      body: method === "GET" ? undefined : JSON.stringify(
        opts.body ?? {
          model: "claude-haiku-4-5-20251001",
          system: [{ type: "text", text: "You are OpenCode." }],
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          tools: [{ name: "shell", input_schema: { type: "object" } }],
        },
      ),
    }),
  };
  await loaded.hooks.request!(before);
  if (opts.replace) before.request = opts.replace(before.request);

  // What core does between the two hooks: send `before.request` upstream.
  const upstream = await globalThis.fetch(before.request.url, {
    method: before.request.method,
    headers: before.request.headers,
    body: before.request.method === "GET" ? undefined : await before.request.clone().text(),
  });
  const after: V2HttpResponseEvent = { sessionID, kind, model, request: before.request, response: upstream };
  await loaded.hooks.response!(after);
  return { request: before.request, response: after.response };
}

async function send(opts: LoadOptions & ThroughOptions) {
  const loaded = await load(opts);
  const result = await through(loaded, opts);
  return { ...result, sent: loaded.sent, timeouts: loaded.timeouts };
}

function accountState(label: string) {
  return createRotationStateStore({ path: defaultStatePath() }).load().accounts[label];
}

const OWN_CONNECTION: V2Connection = { type: "credential", id: "cred_1", method: "oauth" };
const ownCredential = (access: string): V2OAuthCredential => ({
  type: "oauth",
  methodID: "claude-pro-max",
  access,
  refresh: "own-refresh",
  expires: Date.now() + 3_600_000,
});

describe("OpenCode 2 entrypoint", () => {
  it("exports a V2 plugin definition", () => {
    assert.equal(plugin.id, "opencode-claude-bridge");
    assert.equal(typeof plugin.setup, "function");
  });

  it("rewrites the request with the pooled account's bearer and Claude Code identity", async () => {
    await enroll(["alice", "bob"]);
    const { request, response } = await send({ replies: { alice: OK } });

    assert.equal(response.status, 200);
    assert.equal(request.headers.get("authorization"), "Bearer access-alice");
    assert.equal(request.headers.get("x-api-key"), null);
    assert.equal(request.headers.get("content-length"), null);
    assert.match(request.headers.get("user-agent") ?? "", /^claude-cli\//);
    assert.match(request.headers.get("anthropic-beta") ?? "", /oauth-2025-04-20/);
    assert.equal(new URL(request.url).searchParams.get("beta"), "true");

    const body = JSON.parse(await request.text());
    assert.match(body.system[0].text, /^x-anthropic-billing-header:/);
    assert.ok(
      body.system.some((block: { text: string }) =>
        block.text.includes("You are a Claude agent, built on Anthropic's Claude Agent SDK."),
      ),
    );
    // V2 tool schemas are sent as V2 defines them.
    assert.deepEqual(body.tools, [{ name: "shell", input_schema: { type: "object" } }]);
  });

  it("rotates to the next account when the active one is rate-limited", async () => {
    await enroll(["alice", "bob"]);
    const { response, sent } = await send({ replies: { alice: RATE_LIMITED, bob: OK } });

    assert.equal(response.status, 200);
    assert.deepEqual(
      sent.map((r) => r.headers.get("authorization")),
      ["Bearer access-alice", "Bearer access-bob"],
    );
    assert.ok((accountState("alice")?.cooldownUntil ?? 0) > Date.now());
    assert.equal(createRotationStateStore({ path: defaultStatePath() }).load().activeLabel, "bob");
  });

  it("turns Bun's own fetch timeout off when it resends to the next account", async () => {
    await enroll(["alice", "bob"]);
    const { response, timeouts } = await send({ replies: { alice: RATE_LIMITED, bob: OK } });

    assert.equal(response.status, 200);
    // The first send is core's; the resend is the plugin's own.
    assert.deepEqual(timeouts, [undefined, false]);
  });

  it("fails fast with the pool's 429 when every account is cooling", async () => {
    await enroll(["alice", "bob"]);
    const state = createRotationStateStore({ path: defaultStatePath() });
    await state.markCooldown("alice", Date.now() + 3_600_000, "test");
    await state.markCooldown("bob", Date.now() + 3_600_000, "test");

    const { response } = await send({ replies: { alice: OK, bob: OK } });

    assert.equal(response.status, 429);
    const body = await response.json() as { error: { type: string; message: string } };
    assert.equal(body.error.type, "rate_limit_error");
    assert.ok(Number(response.headers.get("retry-after")) > 0);
  });

  it("leaves a request carrying the user's own credential untouched", async () => {
    await enroll(["alice"]);
    const { request, sent } = await send({
      replies: {},
      headers: { "x-api-key": "sk-ant-user" },
    });

    assert.equal(request.headers.get("x-api-key"), "sk-ant-user");
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(sent.length, 1);
  });

  it("ignores the V1 bridge's placeholder API key", async () => {
    await enroll(["alice"]);
    const { request } = await send({
      replies: { alice: OK },
      headers: { "x-api-key": "oauth-placeholder" },
    });

    assert.equal(request.headers.get("authorization"), "Bearer access-alice");
    assert.equal(request.headers.get("x-api-key"), null);
  });

  it("passes the request through with no pool and no Claude CLI login", async () => {
    const { request } = await send({ replies: {} });

    assert.equal(request.headers.get("authorization"), null);
    assert.equal(new URL(request.url).searchParams.get("beta"), null);
  });

  it("drops V2's own session headers, which Claude Code never sends", async () => {
    await enroll(["alice"]);
    const { request } = await send({
      replies: { alice: OK },
      headers: {
        "x-opencode-session-id": "ses_1",
        "x-opencode-parent-session-id": "ses_0",
        "x-parent-session-id": "ses_0",
        "x-opencode-project": "project-hash",
        "x-opencode-session": "ses_1",
        "x-opencode-client": "cli",
      },
    });

    const leaked: string[] = [];
    request.headers.forEach((_, name) => {
      if (name.startsWith("x-opencode-") || name === "x-parent-session-id") leaked.push(name);
    });
    assert.deepEqual(leaked, []);
  });

  it("authenticates a GET without giving it a body", async () => {
    await enroll(["alice"]);
    const { request } = await send({ replies: { alice: OK }, method: "GET", url: "https://api.anthropic.com/v1/models" });

    assert.equal(request.method, "GET");
    assert.equal(request.body, null);
    assert.equal(request.headers.get("authorization"), "Bearer access-alice");
  });

  it("only authenticates count_tokens: its body is left alone and a 429 is not rotated", async () => {
    await enroll(["alice", "bob"]);
    const body = { model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "hello" }] };
    const { request, response, sent } = await send({
      replies: { alice: RATE_LIMITED, bob: OK },
      url: "https://api.anthropic.com/v1/messages/count_tokens",
      body,
    });

    assert.equal(request.headers.get("authorization"), "Bearer access-alice");
    assert.deepEqual(JSON.parse(await request.text()), body);
    assert.equal(response.status, 429);
    assert.equal(sent.length, 1);
    assert.equal(accountState("alice")?.cooldownUntil ?? 0, 0);
  });
});

describe("zero-setup routing", () => {
  it("enables the anthropic provider when accounts are enrolled", async () => {
    await enroll(["alice"]);
    const { providers } = await load();
    assert.equal(providers.anthropic.activation, "enabled");
  });

  it("enables it when the Claude CLI is logged in", async () => {
    writeClaudeLogin("cli-access");
    const { providers } = await load();
    assert.equal(providers.anthropic.activation, "enabled");
  });

  it("leaves it alone with neither a pool nor a CLI login", async () => {
    const { providers } = await load();
    assert.equal(providers.anthropic.activation, "auto");
  });

  it("never overrides a provider the user disabled", async () => {
    await enroll(["alice"]);
    const { providers } = await load({ activation: "disabled" });
    assert.equal(providers.anthropic.activation, "disabled");
  });

  it("uses the Claude CLI login read-only when there is no pool or V2 credential", async () => {
    writeClaudeLogin("cli-access");
    const { request } = await send({ replies: {} });

    assert.equal(request.headers.get("authorization"), "Bearer cli-access");
    assert.match(request.headers.get("anthropic-beta") ?? "", /oauth-2025-04-20/);
    assert.equal(tokenRequests.length, 0);
  });
});

describe("Claude Pro / Max (OAuth) method", () => {
  it("registers an oauth method on the anthropic integration", async () => {
    const { method } = await load();
    assert.equal(method.integrationID, "anthropic");
    assert.deepEqual(method.method, { id: "claude-pro-max", type: "oauth", label: "Claude Pro / Max (OAuth)" });
    assert.equal(typeof method.refresh, "function");
  });

  it("completes the browser flow through the local callback and then closes the server", async () => {
    tokenReply = () => ({ status: 200, body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 } });
    const { method } = await load();
    const auth = await method.authorize({});
    assert.equal(auth.mode, "auto");
    const url = new URL(auth.url);
    const redirect = url.searchParams.get("redirect_uri")!;
    assert.match(redirect, /^http:\/\/localhost:\d+\/callback$/);

    const hit = await realFetch(`${redirect}?code=the-code&state=${url.searchParams.get("state")}`);
    assert.equal(hit.status, 200);
    const credential = await (auth.callback as Promise<V2OAuthCredential>);

    assert.equal(credential.type, "oauth");
    assert.equal(credential.methodID, "claude-pro-max");
    assert.equal(credential.access, "new-access");
    assert.equal(credential.refresh, "new-refresh");
    assert.ok(credential.expires > Date.now());
    assert.equal(tokenRequests[0]!.grant_type, "authorization_code");
    assert.equal(tokenRequests[0]!.code, "the-code");
    assert.equal(tokenRequests[0]!.redirect_uri, redirect);
    await assert.rejects(realFetch(redirect));
  });

  it("ignores a callback carrying another attempt's state", async () => {
    tokenReply = () => ({ status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 3600 } });
    const { method } = await load();
    const auth = await method.authorize({});
    const url = new URL(auth.url);
    const redirect = url.searchParams.get("redirect_uri")!;

    assert.equal((await realFetch(`${redirect}?code=forged&state=other`)).status, 400);
    assert.equal(tokenRequests.length, 0);
    await realFetch(`${redirect}?code=real&state=${url.searchParams.get("state")}`);
    await (auth.callback as Promise<V2OAuthCredential>);
    assert.equal(tokenRequests[0]!.code, "real");
  });

  it("closes the callback server when the browser reports an error", async () => {
    const { method } = await load();
    const auth = await method.authorize({});
    const url = new URL(auth.url);
    const redirect = url.searchParams.get("redirect_uri")!;
    const settled = (auth.callback as Promise<V2OAuthCredential>).then(
      () => "resolved",
      (err: Error) => err.message,
    );

    await realFetch(`${redirect}?error=access_denied&state=${url.searchParams.get("state")}`);
    assert.match(await settled, /access_denied/);
    await assert.rejects(realFetch(redirect));
  });

  it("closes the callback server when the token exchange fails", async () => {
    tokenReply = () => ({ status: 400, body: { error: "invalid_grant" } });
    const { method } = await load();
    const auth = await method.authorize({});
    const url = new URL(auth.url);
    const redirect = url.searchParams.get("redirect_uri")!;

    await realFetch(`${redirect}?code=c&state=${url.searchParams.get("state")}`);
    await assert.rejects(auth.callback as Promise<V2OAuthCredential>, /Token exchange failed \(400\)/);
    await assert.rejects(realFetch(redirect));
  });

  it("closes a pending callback server when the plugin is unloaded", async () => {
    const { method, cleanup } = await load();
    const auth = await method.authorize({});
    const redirect = new URL(auth.url).searchParams.get("redirect_uri")!;
    (auth.callback as Promise<unknown>).catch(() => undefined);

    cleanup();
    await assert.rejects(realFetch(redirect));
  });

  it("never reads the Claude CLI login while authorizing", async () => {
    writeClaudeLogin("cli-access");
    const { method } = await load();
    const auth = await method.authorize({});
    (auth.callback as Promise<unknown>).catch(() => undefined);

    assert.equal(tokenRequests.length, 0);
    assert.ok(!auth.url.includes("cli-access"));
  });
});

describe("manual paste flow", () => {
  const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

  it("exchanges a pasted code#state for this attempt", async () => {
    tokenReply = () => ({ status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 3600 } });
    const auth = authorizeByPaste();
    assert.equal(auth.mode, "code");
    const credential = await (auth.callback as (code: string) => Promise<V2OAuthCredential>)(
      `the-code#${stateOf(auth.url)}`,
    );

    assert.equal(credential.methodID, "claude-pro-max");
    assert.equal(tokenRequests[0]!.code, "the-code");
    assert.equal(tokenRequests[0]!.code_verifier.length > 20, true);
  });

  it("rejects a code whose state belongs to another attempt without calling the token endpoint", async () => {
    const auth = authorizeByPaste();
    await assert.rejects(
      (auth.callback as (code: string) => Promise<V2OAuthCredential>)("the-code#someone-elses-state"),
      /different login attempt/,
    );
    assert.equal(tokenRequests.length, 0);
  });

  it("rejects a callback URL carrying another attempt's state", async () => {
    const auth = authorizeByPaste();
    await assert.rejects(
      (auth.callback as (code: string) => Promise<V2OAuthCredential>)("http://localhost/callback?code=c&state=nope"),
      /different login attempt/,
    );
    assert.equal(tokenRequests.length, 0);
  });

  it("rejects an empty paste", async () => {
    const auth = authorizeByPaste();
    await assert.rejects((auth.callback as (code: string) => Promise<V2OAuthCredential>)("   "), /No authorization code/);
  });
});

describe("token refresh", () => {
  const stale = (): V2OAuthCredential => ({
    type: "oauth",
    methodID: "claude-pro-max",
    access: "old-access",
    refresh: "old-refresh",
    expires: Date.now() - 1000,
    metadata: { note: "kept" },
  });

  it("returns the refreshed credential for V2 to persist", async () => {
    tokenReply = () => ({ status: 200, body: { access_token: "fresh", refresh_token: "fresh-r", expires_in: 3600 } });
    const { method } = await load();
    const credential = await method.refresh!(stale());

    assert.equal(credential.access, "fresh");
    assert.equal(credential.refresh, "fresh-r");
    assert.equal(credential.methodID, "claude-pro-max");
    assert.deepEqual(credential.metadata, { note: "kept" });
    assert.ok(credential.expires > Date.now() + 3_000_000);
    assert.deepEqual(tokenRequests.map((r) => [r.grant_type, r.refresh_token]), [["refresh_token", "old-refresh"]]);
  });

  it("collapses concurrent refreshes of one token into a single request", async () => {
    tokenDelayMs = 100;
    tokenReply = () => ({ status: 200, body: { access_token: "fresh", refresh_token: "fresh-r", expires_in: 3600 } });
    const { method } = await load();
    const results = await Promise.all([method.refresh!(stale()), method.refresh!(stale()), method.refresh!(stale())]);

    assert.equal(tokenRequests.length, 1);
    assert.deepEqual(results.map((c) => c.access), ["fresh", "fresh", "fresh"]);
    // A caller still holding the spent token afterwards gets the same answer.
    assert.equal((await method.refresh!(stale())).access, "fresh");
    assert.equal(tokenRequests.length, 1);
  });

  it("still answers the spent token long after the refresh, since V2 may have failed to store the new pair", async () => {
    tokenReply = () => ({ status: 200, body: { access_token: "fresh", refresh_token: "fresh-r", expires_in: 3600 } });
    const { method } = await load();
    mock.timers.enable({ apis: ["setTimeout"] });
    await method.refresh!(stale());
    mock.timers.tick(60 * 60_000);

    assert.equal((await method.refresh!(stale())).refresh, "fresh-r");
    assert.equal(tokenRequests.length, 1);
  });

  it("sends a failing refresh once: a retried single-use token can only be rejected", async () => {
    tokenReply = () => ({ status: 503, body: { error: { message: "unavailable" } } });
    const { method } = await load();

    await assert.rejects(method.refresh!(stale()), /Token refresh failed \(503\)/);
    assert.equal(tokenRequests.length, 1);
  });

  it("refreshes different tokens independently", async () => {
    tokenReply = () => ({ status: 200, body: { access_token: "fresh", refresh_token: "fresh-r", expires_in: 3600 } });
    const { method } = await load();
    await method.refresh!(stale());
    await method.refresh!({ ...stale(), refresh: "another-refresh" });

    assert.equal(tokenRequests.length, 2);
  });
});

describe("credential order without a pool", () => {
  it("uses the connection created by this method over the CLI login", async () => {
    writeClaudeLogin("cli-access");
    const credential = ownCredential("own-access");
    const { request, sent } = await send({
      replies: {},
      connection: OWN_CONNECTION,
      credential,
      // V2 attaches the connection's access token as a bearer itself.
      headers: { authorization: `Bearer ${credential.access}` },
    });

    assert.equal(request.headers.get("authorization"), "Bearer own-access");
    assert.match(request.headers.get("anthropic-beta") ?? "", /oauth-2025-04-20/);
    assert.match(request.headers.get("user-agent") ?? "", /^claude-cli\//);
    assert.equal(sent.length, 1);
  });

  it("does not mistake its own bearer for a user credential, and does not refresh it itself", async () => {
    const credential = ownCredential("own-access");
    const { request } = await send({
      replies: {},
      connection: OWN_CONNECTION,
      credential,
      headers: { authorization: `Bearer ${credential.access}` },
    });

    assert.equal(new URL(request.url).searchParams.get("beta"), "true");
    assert.equal(tokenRequests.length, 0);
  });

  it("leaves a different bearer alone", async () => {
    const { request } = await send({
      replies: {},
      connection: OWN_CONNECTION,
      credential: ownCredential("own-access"),
      headers: { authorization: "Bearer someone-elses" },
    });

    assert.equal(request.headers.get("authorization"), "Bearer someone-elses");
    assert.equal(new URL(request.url).searchParams.get("beta"), null);
  });

  it("leaves a bearer alone when the active connection is the user's API key", async () => {
    const { request } = await send({
      replies: {},
      connection: { type: "credential", id: "cred_2", method: "key" },
      credential: { type: "key", key: "sk-ant-user" },
      headers: { authorization: "Bearer sk-ant-user" },
    });

    assert.equal(request.headers.get("authorization"), "Bearer sk-ant-user");
    assert.equal(new URL(request.url).searchParams.get("beta"), null);
  });

  it("leaves a user's API-key connection untouched even with a CLI login present", async () => {
    writeClaudeLogin("cli-access");
    const { request } = await send({
      replies: {},
      connection: { type: "credential", id: "cred_2", method: "key" },
      credential: { type: "key", key: "sk-ant-user" },
      headers: { "x-api-key": "sk-ant-user" },
    });

    assert.equal(request.headers.get("x-api-key"), "sk-ant-user");
    assert.equal(request.headers.get("authorization"), null);
  });

  it("answers an expired Claude CLI login with a 401 that says what to do, without sending it", async () => {
    writeClaudeLogin("cli-access", Date.now() - 1000);
    const { request, response, sent } = await send({ replies: {} });

    assert.ok(request.url.startsWith("data:"));
    assert.equal(sent.length, 0);
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { type: string; message: string } };
    assert.equal(body.error.type, "authentication_error");
    assert.match(body.error.message, /claude-pool enroll/);
  });

  it("warns again when the Claude CLI login expires after having recovered", async () => {
    const errors = mock.method(console, "error", () => undefined);
    const warnings = () => errors.mock.calls.filter((call) => /no fresh Claude CLI login/i.test(String(call.arguments[0]))).length;
    const loaded = await load({ replies: { "cli-access": OK } });
    writeClaudeLogin("cli-access", Date.now() - 1000);
    await through(loaded);
    await through(loaded);
    writeClaudeLogin("cli-access");
    await through(loaded);
    writeClaudeLogin("cli-access", Date.now() - 1000);
    await through(loaded);
    errors.mock.restore();

    assert.equal(warnings(), 2);
  });

  // V2 imports OpenCode 1's auth.json on first start: the bridge's V1 login
  // becomes an OAuth credential of method "oauth" that V2 attaches as a bearer.
  const imported: V2OAuthCredential = {
    type: "oauth",
    methodID: "oauth",
    access: "v1-access",
    refresh: "v1-refresh",
    expires: Date.now() + 3_600_000,
  };
  const importedRequest = { connection: OWN_CONNECTION, credential: imported, headers: { authorization: "Bearer v1-access" } };

  it("does not mistake V2's import of the OpenCode 1 login for a user credential", async () => {
    await enroll(["alice"]);
    const { request } = await send({ replies: { alice: OK }, ...importedRequest });

    assert.equal(request.headers.get("authorization"), "Bearer access-alice");
  });

  it("uses the Claude CLI login rather than the imported OpenCode 1 login", async () => {
    writeClaudeLogin("cli-access");
    const { request } = await send({ replies: {}, ...importedRequest });

    assert.equal(request.headers.get("authorization"), "Bearer cli-access");
    assert.equal(tokenRequests.length, 0);
  });

  it("answers 401 rather than send the imported OpenCode 1 login unshaped", async () => {
    const { response, sent } = await send({ replies: {}, ...importedRequest });

    assert.equal(sent.length, 0);
    assert.equal(response.status, 401);
  });

  it("lets the pool win over the connection when accounts are enrolled", async () => {
    await enroll(["alice"]);
    const credential = ownCredential("own-access");
    const { request } = await send({
      replies: { alice: OK },
      connection: OWN_CONNECTION,
      credential,
      headers: { authorization: `Bearer ${credential.access}` },
    });

    assert.equal(request.headers.get("authorization"), "Bearer access-alice");
  });
});

describe("exhausted pool and busy lock", () => {
  it("keeps the request off the network and answers with the pool's message", async () => {
    await enroll(["alice", "bob"]);
    await coolAll(["alice", "bob"]);
    const { request, response, sent } = await send({ replies: { alice: OK, bob: OK } });

    assert.ok(request.url.startsWith("data:"), "the request no longer targets Anthropic");
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(sent.length, 0);
    assert.equal(response.status, 429);
    const body = (await response.json()) as { error: { message: string }; claude_pool_exhausted: boolean };
    assert.match(body.error.message, /Claude pool exhausted/);
    assert.equal(body.claude_pool_exhausted, true);
    assert.ok(Number(response.headers.get("retry-after")) > 0);
  });

  it("does not leak the original request body into the inert request", async () => {
    await enroll(["alice"]);
    await coolAll(["alice"]);
    const { request } = await send({ replies: { alice: OK } });

    assert.equal(request.method, "GET");
    assert.equal(await request.text(), "");
  });

  it("answers a busy lock with a retryable 503 and sends nothing upstream", async () => {
    // Near expiry, so acquiring has to refresh the token, which takes the lock.
    await enroll(["alice"], 10_000);
    // A live holder (this process) of a fresh lock, with the clock then moved
    // past the lock timeout instead of waiting it out.
    const lockPath = `${defaultStatePath()}.lock`;
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now(), nonce: "held" }),
    );
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const pendingSend = send({ replies: { alice: OK } });
    for (let i = 0; i < 400; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      mock.timers.tick(100);
    }
    const { request, response, sent } = await pendingSend;
    mock.timers.reset();

    assert.ok(request.url.startsWith("data:"));
    assert.equal(sent.length, 0);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.claude_pool_exhausted, undefined);
  });
});

describe("rotation", () => {
  it("passes the original error through when the rotation resend fails", async () => {
    await enroll(["alice", "bob"]);
    const { response } = await send({ replies: { alice: RATE_LIMITED, bob: { status: 0, body: "", reject: true } } });

    assert.equal(response.status, 429);
    const body = (await response.json()) as { error: { type: string } };
    assert.equal(body.error.type, "rate_limit_error");
  });

  it("marks the pool's 429 when rotation runs out of accounts, so V2 does not retry it", async () => {
    await enroll(["alice", "bob"]);
    const loaded = await load({ replies: { alice: RATE_LIMITED, bob: RATE_LIMITED } });
    const { response } = await through(loaded);
    assert.equal(response.status, 429);
    const event: V2RetryEvent = {
      model: { providerID: "anthropic" },
      error: { type: "provider.rate-limit", message: "x", status: 429, response: { body: await response.text() } },
      attempt: 1,
      decision: { retry: true, delay: 900_000 },
    };
    await loaded.hooks.retry!(event);

    assert.deepEqual(event.decision, { retry: false });
  });
});

describe("retry hook", () => {
  async function exhaustedError() {
    await enroll(["alice"]);
    await coolAll(["alice"]);
    const { response } = await send({ replies: { alice: OK } });
    return { status: response.status, response: { body: await response.text() } };
  }

  const retryEvent = (error: V2RetryEvent["error"]): V2RetryEvent => ({
    model: { providerID: "anthropic" },
    error,
    attempt: 1,
    decision: { retry: true, delay: 5 },
  });

  it("stops V2 from retrying an exhausted pool", async () => {
    const error = await exhaustedError();
    const loaded = await load();
    const event = retryEvent({ type: "provider", message: "Claude pool exhausted", ...error });
    await loaded.hooks.retry!(event);

    assert.deepEqual(event.decision, { retry: false });
  });

  it("leaves a real Anthropic rate limit to V2", async () => {
    const loaded = await load();
    const event = retryEvent({ type: "provider", message: "rate limited", status: 429, response: { body: RATE_LIMITED.body } });
    await loaded.hooks.retry!(event);

    assert.deepEqual(event.decision, { retry: true, delay: 5 });
  });

  it("leaves other statuses, unparseable bodies and missing bodies to V2", async () => {
    const loaded = await load();
    for (const error of [
      { type: "provider", message: "busy", status: 503, response: { body: JSON.stringify({ claude_pool_exhausted: true }) } },
      { type: "provider", message: "x", status: 429, response: { body: "not json" } },
      { type: "provider", message: "x", status: 429 },
      { type: "transport", message: "x" },
    ]) {
      const event = retryEvent(error);
      await loaded.hooks.retry!(event);
      assert.deepEqual(event.decision, { retry: true, delay: 5 }, JSON.stringify(error));
    }
  });
});

describe("request/response correlation", () => {
  const cloneRequest = (request: Request) =>
    new Request(request.url, { method: request.method, headers: request.headers, body: request.body, duplex: "half" } as RequestInit);

  it("still rotates when another plugin replaced the request after ours", async () => {
    await enroll(["alice", "bob"]);
    const { response, sent } = await send({
      replies: { alice: RATE_LIMITED, bob: OK },
      replace: (request) => new Request(request.url, { method: request.method, headers: request.headers, body: "{}" }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(
      sent.map((r) => r.headers.get("authorization")),
      ["Bearer access-alice", "Bearer access-bob"],
    );
  });

  it("still swaps in the pool's answer when the inert request was replaced", async () => {
    await enroll(["alice"]);
    await coolAll(["alice"]);
    const loaded = await load({ replies: { alice: OK } });
    const event: V2HttpRequestEvent = {
      sessionID: "ses_1",
      kind: "primary",
      model: { providerID: "anthropic" },
      request: new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
    };
    await loaded.hooks.request!(event);
    const replaced = new Request("data:text/plain,other-plugin");
    const after: V2HttpResponseEvent = {
      sessionID: "ses_1",
      kind: "primary",
      model: event.model,
      request: replaced,
      response: new Response("inert"),
    };
    await loaded.hooks.response!(after);

    assert.equal(after.response.status, 429);
  });

  it("does not guess between concurrent requests of one session and kind", async () => {
    await enroll(["alice", "bob"]);
    const loaded = await load({ replies: { alice: RATE_LIMITED, bob: OK } });
    const events = [0, 1].map((): V2HttpRequestEvent => ({
      sessionID: "ses_1",
      kind: "primary",
      model: { providerID: "anthropic" },
      request: new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
    }));
    await Promise.all(events.map((event) => loaded.hooks.request!(event)));
    // Another plugin replaced both; the responses then arrive.
    const answers = await Promise.all(
      events.map(async (event) => {
        const replaced = cloneRequest(event.request);
        const upstream = await globalThis.fetch(replaced.url, {
          method: "POST",
          headers: replaced.headers,
          body: await replaced.clone().text(),
        });
        const after: V2HttpResponseEvent = { sessionID: "ses_1", kind: "primary", model: event.model, request: replaced, response: upstream };
        await loaded.hooks.response!(after);
        return after.response;
      }),
    );

    // Without a safe match neither response is rotated: both stay the raw 429.
    assert.deepEqual(answers.map((r) => r.status), [429, 429]);
    assert.equal(loaded.sent.length, 2);
    assert.ok(loaded.sent.every((r) => r.headers.get("authorization") === "Bearer access-alice"));
  });

  it("matches concurrent requests from different sessions or kinds", async () => {
    await enroll(["alice", "bob"]);
    const loaded = await load({ replies: { alice: RATE_LIMITED, bob: OK } });
    const replace = (request: Request) => cloneRequest(request);
    const results = await Promise.all([
      through(loaded, { sessionID: "ses_1", kind: "primary", replace }),
      through(loaded, { sessionID: "ses_2", kind: "primary", replace }),
      through(loaded, { sessionID: "ses_1", kind: "title", replace }),
    ]);

    assert.deepEqual(results.map((r) => r.response.status), [200, 200, 200]);
  });

  it("does not hand an unanswered request's entry to a later one left untouched", async () => {
    await enroll(["alice", "bob"]);
    const loaded = await load({ replies: { alice: RATE_LIMITED, bob: OK, none: RATE_LIMITED } });
    // V2 gives hooks no abort signal, so a request cancelled or failed in
    // transport leaves its entry behind.
    await loaded.hooks.request!({
      sessionID: "ses_1",
      kind: "primary",
      model: { providerID: "anthropic" },
      request: new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
    });
    const { response } = await through(loaded, { headers: { "x-api-key": "sk-ant-user" } });

    assert.equal(response.status, 429);
    assert.equal(loaded.sent.length, 1);
  });

  it("does not hand a stale entry to a later request that was not rewritten", async () => {
    const loaded = await load({ replies: { alice: OK } });
    // No pool, no CLI login: the first request passes through untouched.
    const first = await through(loaded);
    assert.equal(first.response.status, 401);
    const second = await through(loaded);
    assert.equal(second.response.status, 401);
  });
});
