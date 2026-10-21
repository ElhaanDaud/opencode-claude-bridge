/**
 * Drives the real V1 fetch wrapper with no pool enrolled (single-account path)
 * against a stubbed Anthropic API.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "single-account-prompt-"));
process.env.ANTHROPIC_SYSTEM_PROMPT_PATH = path.join(promptDir, "claude-system-prompt.json");
fs.writeFileSync(
  process.env.ANTHROPIC_SYSTEM_PROMPT_PATH,
  JSON.stringify({ system: [{ type: "text", text: "CLAUDE CODE PROMPT" }] }),
);
process.env.CLAUDE_POOL_AUTO_ENROLL = "0";
Object.defineProperty(process, "platform", { value: "linux" });

// Local token endpoint where each refresh token works once, as in production.
// TOKEN_URL is read at import time.
const liveRefreshTokens = new Set<string>();
const refreshRequests: string[] = [];
const tokenServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const token = String(JSON.parse(raw).refresh_token);
    refreshRequests.push(token);
    res.setHeader("content-type", "application/json");
    if (!liveRefreshTokens.delete(token)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    liveRefreshTokens.add(`${token}/next`);
    res.end(JSON.stringify({ access_token: `${token}/access`, refresh_token: `${token}/next`, expires_in: 3600 }));
  });
});
await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/v1/oauth/token`;
after(() => tokenServer.close());

const { default: plugin } = await import("./index.js");
const { getResponseRetryDelayMs, getTokenRetryDelayMs, parseRetryAfterMs } = await import("./retry.js");

type Reply = { status: number; body?: string; headers?: Record<string, string> };

const realFetch = globalThis.fetch;
const realHome = process.env.HOME;
const realClaudeDir = process.env.CLAUDE_CONFIG_DIR;
let home = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "single-account-"));
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.HOME = realHome;
  if (realClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realClaudeDir;
  fs.rmSync(home, { recursive: true, force: true });
});

const OK: Reply = { status: 200, body: "event: message_stop\ndata: {}\n\n" };

async function send(replies: Reply[], body: unknown) {
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("/v1/messages")) return new Response("{}", { status: 404 });
    sent.push(JSON.parse(String(init?.body)));
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)]!;
    return new Response(reply.body ?? "{}", { status: reply.status, headers: reply.headers });
  }) as typeof fetch;

  const hooks = await plugin.server({ client: { auth: { set: async () => {} } } });
  const loaded = await hooks.auth.loader(
    async () => ({ type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 }),
    { models: {} },
  ) as { fetch: typeof fetch };
  const response = await loaded.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });
  await response.text();
  return { status: response.status, sent };
}

const plain = {
  model: "claude-haiku-4-5-20251001",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

describe("single-account retry", () => {
  it("retries a 529 and returns the recovered response", async () => {
    const { status, sent } = await send(
      [{ status: 529, headers: { "retry-after": "0" } }, OK],
      plain,
    );
    assert.equal(status, 200);
    assert.equal(sent.length, 2);
  });

  it("hands a long Retry-After straight back without retrying", async () => {
    const { status, sent } = await send([{ status: 429, headers: { "retry-after": "3600" } }], plain);
    assert.equal(status, 429);
    assert.equal(sent.length, 1);
  });

  it("stops after the retry budget", async () => {
    const { status, sent } = await send([{ status: 529, headers: { "retry-after": "0" } }], plain);
    assert.equal(status, 529);
    assert.equal(sent.length, 3);
  });

  it("retries a 429 without spending the refresh token of a valid access token", async () => {
    const before = refreshRequests.length;
    const { status, sent } = await send([{ status: 429, headers: { "retry-after": "0" } }, OK], plain);
    assert.equal(status, 200);
    assert.equal(sent.length, 2);
    assert.deepEqual(refreshRequests.slice(before), []);
  });
});

type StoredAuth = { type: string; access: string; refresh: string; expires: number };

/** A loaded fetch whose getAuth() re-reads `store`, as OpenCode's does; `status` answers each bearer. */
async function connect(
  store: { auth: StoredAuth },
  save: (body: StoredAuth) => Promise<void>,
  status: (bearer: string) => number = () => 200,
) {
  const bearers: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("/v1/messages")) return new Response("{}", { status: 404 });
    const bearer = (init?.headers as Record<string, string>).authorization!;
    bearers.push(bearer);
    return new Response(OK.body, { status: status(bearer) });
  }) as typeof fetch;

  const hooks = await plugin.server({
    client: { auth: { set: async ({ body }: { body: Record<string, unknown> }) => save(body as StoredAuth) } },
  });
  const loaded = await hooks.auth.loader(async () => ({ ...store.auth }), { models: {} }) as { fetch: typeof fetch };
  const call = async () => {
    const response = await loaded.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify(plain),
    });
    await response.text();
    return response.status;
  };
  return { call, bearers };
}

/** Logs the Claude CLI in with tokens valid for an hour. */
function cliLogin(access: string, refresh: string) {
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + 3_600_000 } }),
  );
}

/** Anthropic accepting only access tokens the token endpoint just issued. */
const refreshedOnly = (bearer: string) => (bearer.endsWith("/access") ? 200 : 401);

describe("single-account refresh", () => {
  it("shares one refresh between concurrent requests", async () => {
    liveRefreshTokens.add("shared");
    const store = { auth: { type: "oauth", access: "old", refresh: "shared", expires: Date.now() - 1000 } };
    const { call, bearers } = await connect(store, async (body) => { store.auth = body; });
    const before = refreshRequests.length;

    assert.deepEqual(await Promise.all([call(), call()]), [200, 200]);
    assert.deepEqual(refreshRequests.slice(before), ["shared"]);
    assert.deepEqual(bearers, ["Bearer shared/access", "Bearer shared/access"]);
  });

  it("keeps tokens whose save failed, and saves them on the next request", async () => {
    liveRefreshTokens.add("unsaved");
    const store = { auth: { type: "oauth", access: "old", refresh: "unsaved", expires: Date.now() - 1000 } };
    let failures = 1;
    const { call, bearers } = await connect(store, async (body) => {
      if (failures-- > 0) throw new Error("auth store unavailable");
      store.auth = body;
    });
    const before = refreshRequests.length;

    assert.equal(await call(), 200);
    assert.equal(store.auth.refresh, "unsaved");
    assert.equal(await call(), 200);
    assert.deepEqual(refreshRequests.slice(before), ["unsaved"]);
    assert.deepEqual(bearers, ["Bearer unsaved/access", "Bearer unsaved/access"]);
    assert.equal(store.auth.refresh, "unsaved/next");
  });

  it("refreshes a rejected token the Claude CLI also holds, and resends", async () => {
    // Plugin init copies the CLI login into the store, so both hold one token.
    liveRefreshTokens.add("copied-refresh");
    cliLogin("copied", "copied-refresh");
    const store = { auth: { type: "oauth", access: "copied", refresh: "copied-refresh", expires: Date.now() + 3_600_000 } };
    const { call, bearers } = await connect(store, async (body) => { store.auth = body; }, refreshedOnly);
    const before = refreshRequests.length;

    assert.equal(await call(), 200);
    assert.deepEqual(refreshRequests.slice(before), ["copied-refresh"]);
    assert.deepEqual(bearers, ["Bearer copied", "Bearer copied-refresh/access"]);
  });

  it("shares one refresh between concurrent requests whose token was rejected", async () => {
    liveRefreshTokens.add("twice-refresh");
    cliLogin("twice", "twice-refresh");
    const store = { auth: { type: "oauth", access: "twice", refresh: "twice-refresh", expires: Date.now() + 3_600_000 } };
    const { call, bearers } = await connect(store, async (body) => { store.auth = body; }, refreshedOnly);
    const before = refreshRequests.length;

    assert.deepEqual(await Promise.all([call(), call()]), [200, 200]);
    assert.deepEqual(refreshRequests.slice(before), ["twice-refresh"]);
    assert.deepEqual([...bearers].sort(), ["Bearer twice", "Bearer twice", "Bearer twice-refresh/access", "Bearer twice-refresh/access"]);
  });

  it("takes no rejected token back from a refresh already in flight", async () => {
    liveRefreshTokens.add("early");
    const store = { auth: { type: "oauth", access: "old", refresh: "early", expires: Date.now() - 1000 } };
    let saved!: () => void;
    const saving = new Promise<void>((resolve) => { saved = resolve; });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    // The first save lands in the store, then hangs until the CLI's token is rejected.
    const { call, bearers } = await connect(store, async (body) => { store.auth = body; saved(); await gate; }, (bearer) => {
      if (bearer === "Bearer cli-race") setTimeout(open);
      return refreshedOnly(bearer);
    });
    cliLogin("cli-race", "cli-race-refresh");
    const before = refreshRequests.length;

    // The first request's refresh takes the CLI's token; the second sends it and is rejected.
    const first = call();
    await saving;
    assert.deepEqual(await Promise.all([first, call()]), [200, 200]);
    assert.deepEqual(refreshRequests.slice(before), ["early"]);
    assert.deepEqual(bearers, ["Bearer cli-race", "Bearer early/access", "Bearer early/access"]);
  });

  it("resends on the Claude CLI's other valid token without spending a refresh token", async () => {
    const store = { auth: { type: "oauth", access: "stale", refresh: "kept", expires: Date.now() + 3_600_000 } };
    const { call, bearers } = await connect(store, async (body) => { store.auth = body; }, (bearer) => (bearer === "Bearer stale" ? 401 : 200));
    // After plugin init, so the store keeps its own token.
    cliLogin("relogged", "relogged-refresh");
    const before = refreshRequests.length;

    assert.equal(await call(), 200);
    assert.deepEqual(refreshRequests.slice(before), []);
    assert.deepEqual(bearers, ["Bearer stale", "Bearer relogged"]);
    assert.equal(store.auth.access, "relogged");
  });
});

describe("request body rewrite", () => {
  it("keeps OpenCode's system blocks after Claude Code's prompt", async () => {
    const { sent } = await send([OK], {
      ...plain,
      system: [{ type: "text", text: "OPENCODE AGENT PROMPT" }],
    });
    const texts = (sent[0]!.system as Array<{ text: string }>).map((block) => block.text);
    assert.match(texts[0]!, /^x-anthropic-billing-header:/);
    assert.equal(texts[1], "CLAUDE CODE PROMPT");
    assert.ok(texts.slice(2).some((text) => text.includes("OPENCODE AGENT PROMPT")));
    assert.equal(texts.filter((text) => text.startsWith("x-anthropic-billing-header:")).length, 1);
  });

  describe("tool_choice", () => {
    const schema = { type: "object", properties: {} };
    const withTools = {
      model: "claude-opus-5-5",
      messages: plain.messages,
      tools: [
        { name: "bash", description: "run", input_schema: schema },
        { name: "StructuredOutput", description: "answer", input_schema: schema },
      ],
    };

    it("keeps a forced tool, maps its name, and injects no thinking", async () => {
      for (const [name, wire] of [["StructuredOutput", "StructuredOutput"], ["bash", "Bash"]]) {
        const { sent } = await send([OK], { ...withTools, tool_choice: { type: "tool", name } });
        assert.deepEqual(sent[0]!.tool_choice, { type: "tool", name: wire });
        assert.ok((sent[0]!.tools as Array<{ name: string }>).some((tool) => tool.name === wire));
        assert.equal(sent[0]!.thinking, undefined);
      }
    });

    it("turns the caller's thinking off when it forces a tool", async () => {
      const { sent } = await send([OK], {
        ...withTools,
        tool_choice: { type: "any" },
        thinking: { type: "enabled", budget_tokens: 2048 },
        temperature: 0,
      });
      assert.deepEqual(sent[0]!.tool_choice, { type: "any" });
      assert.deepEqual(sent[0]!.thinking, { type: "disabled" });
      assert.equal(sent[0]!.temperature, 0);
    });

    it("drops a forced tool for Sonnet 5.5, which can't turn thinking off", async () => {
      const sonnet = { ...withTools, model: "claude-sonnet-5-5" };
      for (const extra of [
        { tool_choice: { type: "tool", name: "bash" } },
        { tool_choice: { type: "any" }, thinking: { type: "enabled", budget_tokens: 2048 } },
      ]) {
        const { sent } = await send([OK], { ...sonnet, ...extra });
        assert.equal(sent[0]!.tool_choice, undefined);
        assert.deepEqual(sent[0]!.thinking, { type: "adaptive" });
      }
      for (const choice of [{ type: "auto" }, { type: "none" }]) {
        const { sent } = await send([OK], { ...sonnet, tool_choice: choice });
        assert.deepEqual(sent[0]!.tool_choice, choice);
      }
    });

    it("keeps auto and none alongside adaptive thinking", async () => {
      for (const choice of [{ type: "auto", disable_parallel_tool_use: true }, { type: "none" }]) {
        const { sent } = await send([OK], { ...withTools, tool_choice: choice });
        assert.deepEqual(sent[0]!.tool_choice, choice);
        assert.deepEqual(sent[0]!.thinking, { type: "adaptive" });
      }
    });
  });

  it("ends an assistant-tailed request on a user turn and keeps the tail cache marker", async () => {
    const marker = { type: "ephemeral" };
    const { sent } = await send([OK], {
      ...plain,
      messages: [
        { role: "user", content: [{ type: "text", text: "q", cache_control: marker }] },
        { role: "assistant", content: [{ type: "text", text: "a", cache_control: marker }] },
      ],
    });
    const messages = sent[0]!.messages as Array<{ role: string; content: Array<{ cache_control?: unknown }> | string }>;
    assert.equal(messages.at(-1)!.role, "user");
    assert.equal("cache_control" in (messages[0]!.content as Array<object>)[0]!, false);
    assert.deepEqual((messages[1]!.content as Array<{ cache_control?: unknown }>)[0]!.cache_control, marker);
  });

  it("sends text that is a quoted string verbatim instead of JSON-decoding it", async () => {
    const texts = ['"hello"', '"a\\nb"', ' "padded" '];
    const { sent } = await send([OK], {
      ...plain,
      messages: [
        { role: "user", content: [{ type: "text", text: texts[0] }] },
        { role: "assistant", content: [{ type: "text", text: texts[1] }] },
        { role: "user", content: [{ type: "text", text: texts[2] }] },
      ],
    });
    const messages = sent[0]!.messages as Array<{ content: Array<{ text: string }> }>;
    assert.deepEqual(messages.map((message) => message.content[0]!.text), texts);
  });
});

describe("OAuth profile lookup", () => {
  /** Sends `count` requests on token `access`, with `profile` answering the profile endpoint. */
  async function sendAs(access: string, count: number, profile: (init?: RequestInit) => Promise<Response>) {
    const sent: Array<Record<string, unknown>> = [];
    let lookups = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/oauth/profile")) {
        lookups++;
        return profile(init);
      }
      if (!String(url).includes("/v1/messages")) return new Response("{}", { status: 404 });
      sent.push(JSON.parse(String(init?.body)));
      return new Response(OK.body, { status: OK.status });
    }) as typeof fetch;

    const hooks = await plugin.server({ client: { auth: { set: async () => {} } } });
    const loaded = await hooks.auth.loader(
      async () => ({ type: "oauth", access, refresh: "refresh", expires: Date.now() + 3_600_000 }),
      { models: {} },
    ) as { fetch: typeof fetch };
    const statuses: number[] = [];
    for (let i = 0; i < count; i++) {
      const response = await loaded.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify(plain),
      });
      await response.text();
      statuses.push(response.status);
    }
    return { statuses, sent, lookups };
  }

  it("sends the request without user_id when the profile endpoint never answers", { timeout: 15_000 }, async () => {
    // Accepts the connection and never answers; only the abort signal ends it.
    const { statuses, sent } = await sendAs("stalled-profile", 1, (init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    assert.deepEqual(statuses, [200]);
    assert.equal((sent[0]!.metadata as { user_id?: string }).user_id, undefined);
  });

  it("does not repeat a failed lookup on every request", async () => {
    const { statuses, lookups } = await sendAs("failed-profile", 2, async () => new Response("{}", { status: 500 }));
    assert.deepEqual(statuses, [200, 200]);
    assert.equal(lookups, 1);
  });
});

describe("retry policy", () => {
  it("parses Retry-After seconds and HTTP dates", () => {
    assert.equal(parseRetryAfterMs("2"), 2000);
    assert.equal(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
    assert.equal(parseRetryAfterMs("soon"), null);
  });

  it("refuses waits longer than 10s and backs off without a header", () => {
    assert.equal(getResponseRetryDelayMs(new Headers({ "retry-after": "11" }), 0), null);
    assert.equal(getResponseRetryDelayMs(new Headers(), 1), 4000);
  });

  it("honours retry_after in a token endpoint body", () => {
    assert.equal(getTokenRetryDelayMs(529, '{"error":{"retry_after":3}}', 0), 3000);
    assert.equal(getTokenRetryDelayMs(529, '{"retry_after":60}', 0), null);
    assert.equal(getTokenRetryDelayMs(429, "not json", 0, 0), 1000);
  });
});

process.on("exit", () => fs.rmSync(promptDir, { recursive: true, force: true }));
