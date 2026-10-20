/**
 * Drives the real V1 fetch wrapper with no pool enrolled (single-account path)
 * against a stubbed Anthropic API.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "single-account-prompt-"));
process.env.ANTHROPIC_SYSTEM_PROMPT_PATH = path.join(promptDir, "claude-system-prompt.json");
fs.writeFileSync(
  process.env.ANTHROPIC_SYSTEM_PROMPT_PATH,
  JSON.stringify({ system: [{ type: "text", text: "CLAUDE CODE PROMPT" }] }),
);
process.env.CLAUDE_POOL_AUTO_ENROLL = "0";
Object.defineProperty(process, "platform", { value: "linux" });

const { default: plugin } = await import("./index.js");
const { getResponseRetryDelayMs, getTokenRetryDelayMs, parseRetryAfterMs } = await import("./retry.js");

type Reply = { status: number; body?: string; headers?: Record<string, string> };

const realFetch = globalThis.fetch;
const realHome = process.env.HOME;
let home = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "single-account-"));
  process.env.HOME = home;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.HOME = realHome;
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
