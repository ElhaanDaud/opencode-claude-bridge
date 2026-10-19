/**
 * End-to-end QA harness for multi-account rotation.
 *
 * Drives the REAL plugin factory and its real auth.loader fetch wrapper.
 * Rotation paths are exercised against a local upstream that returns
 * controlled 429/403 responses, because deliberately exhausting a live Max
 * subscription to observe a real 429 is not a reasonable test cost.
 */

import http from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRotationStateStore, defaultLockPath, defaultStatePath } from "../dist/pool/rotation-state.js";
import OpenCodeClaudeBridge from "../dist/index.js";

// A running OpenCode writes the live state file under its own lock while this
// harness deletes and rewrites it, so the two raced and scenario penalties
// leaked into the live pool. Scenarios get a private state file instead. The
// lock and refresh journal deliberately stay shared: they guard the real
// credentials, and a private lock would let two processes spend one token.
if (!process.env.CLAUDE_POOL_STATE_PATH) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-rotation-"));
  process.env.CLAUDE_POOL_STATE_PATH = path.join(dir, "rotation-state.json");
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}
const statePath = defaultStatePath();
const state = createRotationStateStore({ path: statePath, lockPath: defaultLockPath() });

function resetState() {
  try { fs.rmSync(statePath, { force: true }); } catch {}
}

function fakeClient() {
  const store = { value: null };
  return {
    store,
    auth: {
      async set({ body }) {
        store.value = body;
        return true;
      },
    },
  };
}

async function makeFetch(client) {
  const hooks = await OpenCodeClaudeBridge({ client });
  const getAuth = async () =>
    client.store.value ?? { type: "oauth", access: "", refresh: "", expires: 0 };
  const provider = { models: {} };
  const result = await hooks.auth.loader(getAuth, provider);
  return result.fetch;
}

function messagesBody() {
  return JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with the single word: pong" }],
  });
}

/** Local upstream returning a scripted sequence of responses. */
function startMockUpstream(script) {
  let i = 0;
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      let userAccount = null;
      try {
        userAccount = JSON.parse(JSON.parse(body).metadata?.user_id ?? "null")?.account_uuid ?? null;
      } catch {}
      seen.push({
        auth: req.headers["authorization"] ?? "",
        url: req.url,
        userAccount,
      });
      res.writeHead(step.status, {
        "content-type": "application/json",
        ...(step.headers ?? {}),
      });
      res.end(JSON.stringify(step.body ?? { type: "error", error: { type: "rate_limit_error", message: "limit" } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1/messages`,
        seen,
        calls: () => i,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Fingerprint rather than slice: comparing tokens must not print live
// credential material, even a suffix, to the QA log.
function tokenId(header) {
  if (!header) return "(none)";
  return createHash("sha256").update(header).digest("hex").slice(0, 10);
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}\n`);
}

// ── S1: live happy path against real Anthropic ──────────────────────
async function s1() {
  resetState();
  const client = fakeClient();
  const doFetch = await makeFetch(client);
  const res = await doFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: messagesBody(),
    headers: { "content-type": "application/json" },
  });
  const text = await res.text();
  const active = state.load().activeLabel;
  record(
    "S1 live request through pool succeeds",
    res.status === 200,
    `HTTP ${res.status} via account "${active}" | body: ${text.slice(0, 120).replace(/\s+/g, " ")}`,
  );
}

// ── S2: long reset window rotates to the other account ──────────────
async function s2() {
  resetState();
  const up = await startMockUpstream([
    { status: 429, headers: { "retry-after": "21600" } },
    { status: 200, body: { type: "message", content: [] } },
  ]);
  const client = fakeClient();
  const doFetch = await makeFetch(client);
  const res = await doFetch(up.url, {
    method: "POST",
    body: messagesBody(),
    headers: { "content-type": "application/json" },
  });
  await res.text();

  const s = state.load();
  const first = up.seen[0]?.auth;
  const second = up.seen[1]?.auth;
  const rotated = Boolean(first && second && first !== second);
  const cooled = Object.entries(s.accounts).filter(([, a]) => a.cooldownUntil);
  await up.close();

  record(
    "S2 long reset window rotates account",
    res.status === 200 && rotated && cooled.length === 1,
    `HTTP ${res.status} | token1=…${tokenId(first)} token2=…${tokenId(second)} rotated=${rotated} | cooled=${JSON.stringify(cooled.map(([l, a]) => [l, new Date(a.cooldownUntil).toISOString()]))}`,
  );
}

// ── S3: short reset retries the SAME account (no rotation) ──────────
async function s3() {
  resetState();
  const up = await startMockUpstream([
    { status: 429, headers: { "retry-after": "1" } },
    { status: 200, body: { type: "message", content: [] } },
  ]);
  const client = fakeClient();
  const doFetch = await makeFetch(client);
  const res = await doFetch(up.url, {
    method: "POST",
    body: messagesBody(),
    headers: { "content-type": "application/json" },
  });
  await res.text();

  const same = up.seen[0]?.auth === up.seen[1]?.auth;
  const cooled = Object.values(state.load().accounts).filter((a) => a.cooldownUntil).length;
  await up.close();

  record(
    "S3 short reset retries same account",
    res.status === 200 && same && cooled === 0,
    `HTTP ${res.status} | sameToken=${same} | accountsCooled=${cooled} (expect 0) | upstreamCalls=${up.calls()}`,
  );
}

// ── S4: every account exhausted fails fast with detail ──────────────
async function s4() {
  resetState();
  const up = await startMockUpstream([{ status: 429, headers: { "retry-after": "21600" } }]);
  const client = fakeClient();
  const doFetch = await makeFetch(client);
  const res = await doFetch(up.url, {
    method: "POST",
    body: messagesBody(),
    headers: { "content-type": "application/json" },
  });
  const body = JSON.parse(await res.text());
  const retryAfter = res.headers.get("retry-after");
  await up.close();

  const msg = body?.error?.message ?? "";
  const labels = Object.keys(state.load().accounts);
  const namesBoth = labels.length > 0 && labels.every((l) => msg.includes(l));
  record(
    "S4 full exhaustion fails fast",
    res.status === 429 && namesBoth && Number(retryAfter) > 0,
    `HTTP ${res.status} retry-after=${retryAfter} | namesBothAccounts=${namesBoth} | msg: ${msg.slice(0, 200)}`,
  );
}

// ── S5: 403 suspension permanently disables and rotates ─────────────
async function s5() {
  resetState();
  const up = await startMockUpstream([
    { status: 403, body: { type: "error", error: { type: "forbidden", message: "account suspended" } } },
    { status: 200, body: { type: "message", content: [] } },
  ]);
  const client = fakeClient();
  const doFetch = await makeFetch(client);
  const res = await doFetch(up.url, {
    method: "POST",
    body: messagesBody(),
    headers: { "content-type": "application/json" },
  });
  await res.text();

  const disabled = scenarioAccounts().filter(([, a]) => a.disabled);
  await up.close();

  record(
    "S5 suspension disables account and rotates",
    res.status === 200 && disabled.length === 1,
    `HTTP ${res.status} | disabled=${JSON.stringify(disabled.map(([l, a]) => [l, a.lastReason]))}`,
  );
}

// ── S6: revoked credential (401) disables and rotates ───────────────
// Reproduces the real incident: a spent refresh token left the account
// returning "OAuth access token has been revoked", which previously passed
// straight through to the user instead of rotating to a healthy account.
async function s6() {
  resetState();
  const up = await startMockUpstream([
    {
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "OAuth access token has been revoked." } },
    },
    { status: 200, body: { type: "message", content: [] } },
  ]);
  const client = fakeClient();
  const doFetch = await makeFetch(client);
  const res = await doFetch(up.url, {
    method: "POST",
    body: messagesBody(),
    headers: { "content-type": "application/json" },
  });
  await res.text();

  const disabled = scenarioAccounts().filter(([, a]) => a.disabled);
  const rotated = up.seen[0]?.auth !== up.seen[1]?.auth;
  await up.close();

  record(
    "S6 revoked credential disables account and rotates",
    res.status === 200 && disabled.length === 1 && rotated,
    `HTTP ${res.status} | rotated=${rotated} | disabled=${JSON.stringify(disabled.map(([l, a]) => [l, a.lastReason]))}`,
  );
}

// Penalties from the mocked responses only. Accounts whose real refresh token
// is already dead get disabled during acquire(), which is not what S7/S8 test.
function scenarioAccounts() {
  return Object.entries(state.load().accounts).filter(
    ([, a]) => !/^(refresh (rejected|failed)|credentials missing)/.test(a.lastReason ?? ""),
  );
}

function penalised() {
  return scenarioAccounts()
    .filter(([, a]) => a.disabled || (a.cooldownUntil !== null && a.cooldownUntil > Date.now()))
    .map(([label, a]) => `${label}: ${a.lastReason}`);
}

async function identicalFailureScenario(name, failure) {
  resetState();
  const up = await startMockUpstream([failure, failure, { status: 200, body: { type: "message", content: [] } }]);
  const doFetch = await makeFetch(fakeClient());
  const res = await doFetch(up.url, {
    method: "POST",
    body: messagesBody(),
    headers: { "content-type": "application/json" },
  });
  await res.text();

  const hit = penalised();
  const twoAccounts = up.seen.length === 2 && up.seen[0].auth !== up.seen[1].auth;
  await up.close();

  record(
    name,
    res.status === failure.status && hit.length === 0 && twoAccounts,
    `HTTP ${res.status} | upstream calls=${up.seen.length} | distinct accounts=${twoAccounts} | penalised=${JSON.stringify(hit)}`,
  );
}

// ── S7/S8: a failure caused by the request, not the account ─────────
// The same 401/403 from two different accounts must pass through without
// disabling or cooling anything; previously it walked the whole pool.
async function s7() {
  await identicalFailureScenario("S7 identical 401 on two accounts penalises nobody", {
    status: 401,
    body: { type: "error", error: { type: "authentication_error", message: "OAuth authentication is currently not supported." } },
  });
}

async function s8() {
  await identicalFailureScenario("S8 identical 403 on two accounts penalises nobody", {
    status: 403,
    body: { type: "error", error: { type: "permission_error", message: "Your account does not have access to this model." } },
  });
}

// ── S9: distinct failures are each charged to their own account ─────
async function s9() {
  resetState();
  const up = await startMockUpstream([
    { status: 403, body: { type: "error", error: { type: "permission_error", message: "no access to model" } } },
    { status: 401, body: { type: "error", error: { type: "authentication_error", message: "OAuth access token has been revoked." } } },
    { status: 200, body: { type: "message", content: [] } },
  ]);
  const doFetch = await makeFetch(fakeClient());
  const res = await doFetch(up.url, {
    method: "POST",
    body: messagesBody(),
    headers: { "content-type": "application/json" },
  });
  await res.text();

  const accounts = scenarioAccounts().map(([, a]) => a);
  const cooled = accounts.filter((a) => !a.disabled && a.cooldownUntil > Date.now()).length;
  const disabled = accounts.filter((a) => a.disabled).length;
  const distinct = new Set(up.seen.map((s) => s.auth)).size;
  await up.close();

  record(
    "S9 distinct 403 then 401 then success charges both accounts",
    res.status === 200 && cooled === 1 && disabled === 1 && distinct === 3,
    `HTTP ${res.status} | cooled=${cooled} disabled=${disabled} | distinct accounts=${distinct}`,
  );
}

// ── S10: metadata.user_id follows the account actually serving the request ──
async function s10() {
  resetState();
  const up = await startMockUpstream([
    { status: 429, headers: { "retry-after": "21600" } },
    { status: 200, body: { type: "message", content: [] } },
  ]);
  const doFetch = await makeFetch(fakeClient());
  const res = await doFetch(up.url, {
    method: "POST",
    body: messagesBody(),
    headers: { "content-type": "application/json" },
  });
  await res.text();
  const [first, second] = up.seen;
  await up.close();

  const ok =
    res.status === 200 &&
    first?.auth !== second?.auth &&
    Boolean(second?.userAccount) &&
    second.userAccount !== first?.userAccount;
  record(
    "S10 rotation re-stamps user_id with the new account",
    ok,
    `HTTP ${res.status} | uuid#1=${first?.userAccount?.slice(0, 8)} uuid#2=${second?.userAccount?.slice(0, 8)}`,
  );
}

const only = process.argv[2];
const all = { s1, s2, s3, s4, s5, s6, s7, s8, s9, s10 };
if (only && !Object.hasOwn(all, only)) {
  console.error(`Unknown scenario "${only}". Choose one of: ${Object.keys(all).join(", ")}`);
  process.exit(2);
}
for (const [name, fn] of Object.entries(all)) {
  if (only && only !== name) continue;
  try {
    await fn();
  } catch (err) {
    record(name, false, `threw: ${err?.stack ?? err}`);
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} scenarios passed =====`);
process.exit(failed.length === 0 ? 0 : 1);
