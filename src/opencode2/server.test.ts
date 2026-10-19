/**
 * Drives the V2 plugin's hooks the way @opencode/core 2.x does: run
 * `http.request`, send the (possibly replaced) request upstream, then run
 * `http.response` on the result. The pool runs on the file backend under a
 * throwaway HOME and the Anthropic API is a stubbed fetch.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

process.env.CLAUDE_POOL_AUTO_ENROLL = "0";
Object.defineProperty(process, "platform", { value: "linux" });

const { default: plugin } = await import("./server.js");
const { createAccountStore, createSecretBackend } = await import("../pool/secret-store.js");
const { createRotationStateStore, defaultStatePath } = await import("../pool/rotation-state.js");
type V2HttpRequestEvent = import("./server.js").V2HttpRequestEvent;
type V2HttpResponseEvent = import("./server.js").V2HttpResponseEvent;
type V2Context = import("./server.js").V2Context;

type Reply = { status: number; body: string; headers?: Record<string, string> };

const realFetch = globalThis.fetch;
const realHome = process.env.HOME;
let home = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "v2-plugin-"));
  process.env.HOME = home;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const OK: Reply = { status: 200, body: "event: message_stop\ndata: {}\n\n" };
const RATE_LIMITED: Reply = {
  status: 429,
  body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "limit" } }),
  headers: { "retry-after": "3600" },
};

async function enroll(labels: string[]): Promise<void> {
  const accounts = createAccountStore(createSecretBackend());
  const state = createRotationStateStore({ path: defaultStatePath() });
  for (const label of labels) {
    await accounts.putAccount({
      label,
      oauth: { access: `access-${label}`, refresh: `refresh-${label}`, expires: Date.now() + 3_600_000 },
      enrolledAt: Date.now(),
    });
    await state.ensureAccount(label);
  }
  await state.setActive(labels[0]!);
}

/** Load the plugin, stub the upstream, and run one request through both hooks. */
async function send(opts: {
  replies: Record<string, Reply>;
  providerID?: string;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  const sent: Request[] = [];
  const replyFor = (authorization: string | null) => {
    const label = String(authorization).replace("Bearer access-", "");
    return opts.replies[label] ?? { status: 401, body: "{}" };
  };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("/v1/messages")) return new Response("{}", { status: 404 });
    const request = new Request(url, init);
    sent.push(request);
    const reply = replyFor(request.headers.get("authorization"));
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  }) as typeof fetch;

  let onRequest: ((event: V2HttpRequestEvent) => Promise<void> | void) | undefined;
  let onResponse: ((event: V2HttpResponseEvent) => Promise<void> | void) | undefined;
  const hook = (async (name: string, callback: unknown) => {
    if (name === "http.request") onRequest = callback as typeof onRequest;
    if (name === "http.response") onResponse = callback as typeof onResponse;
  }) as V2Context["session"]["hook"];
  await plugin.setup({ session: { hook } });

  const model = { providerID: opts.providerID ?? "anthropic" };
  const before: V2HttpRequestEvent = {
    model,
    request: new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: JSON.stringify(
        opts.body ?? {
          model: "claude-haiku-4-5-20251001",
          system: [{ type: "text", text: "You are OpenCode." }],
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          tools: [{ name: "shell", input_schema: { type: "object" } }],
        },
      ),
    }),
  };
  await onRequest!(before);

  // What core does between the two hooks: send `before.request` upstream.
  const upstream = await globalThis.fetch(before.request.url, {
    method: before.request.method,
    headers: before.request.headers,
    body: await before.request.clone().text(),
  });
  const after: V2HttpResponseEvent = { model, request: before.request, response: upstream };
  await onResponse!(after);

  return { request: before.request, response: after.response, sent };
}

function accountState(label: string) {
  return createRotationStateStore({ path: defaultStatePath() }).load().accounts[label];
}

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
});
