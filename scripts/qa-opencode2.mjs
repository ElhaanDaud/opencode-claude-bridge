#!/usr/bin/env node
/**
 * End-to-end QA harness: the REAL OpenCode 2 binary + this plugin + a local
 * fake Anthropic API.
 *
 *   node scripts/qa-opencode2.mjs --bin <opencode> [--plugin <abs dist/opencode2>]
 *        [--placeholder-key] [scenario ...]
 *
 * Every scenario gets a fresh isolated environment (HOME, XDG_*, CLAUDE_CONFIG_DIR,
 * pool account dir, rotation state) and its own fake server, so nothing can reach
 * the user's keychain, real accounts, or anthropic.com. Before OpenCode starts,
 * the plugin's own dist is asked what credentials it can see; anything other
 * than the fake ones aborts the run.
 *
 * Without --placeholder-key ANTHROPIC_API_KEY is unset, as for a real user;
 * with it, ANTHROPIC_API_KEY=oauth-placeholder (what V1 exports).
 * QA_DEBUG=1 prints every request the fake received (auth header, tool count).
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = "anthropic/claude-haiku-4-5-20251001";
const CAPTURE_DIR = path.join(os.tmpdir(), "opencode2-capture");
const RUN_TIMEOUT_MS = 90_000;
const RETRY_TIMEOUT_MS = 45_000;
const FAKE_TEXT = "FAKE-REPLY-7731";
const CLAUDE_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

// ── args ────────────────────────────────────────────────────────────

function die(message) {
  console.error(`qa-opencode2: ${message}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const opts = { bin: "", plugin: path.join(REPO, "dist", "opencode2"), placeholder: false, names: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--bin") opts.bin = argv[++i] ?? "";
  else if (a === "--plugin") opts.plugin = path.resolve(argv[++i] ?? "");
  else if (a === "--placeholder-key") opts.placeholder = true;
  else if (a.startsWith("--")) die(`unknown option ${a}`);
  else opts.names.push(a);
}
if (!opts.bin || !fs.existsSync(opts.bin)) die("--bin <path to the OpenCode 2 binary> is required");
if (!fs.existsSync(path.join(opts.plugin, "server.js"))) die(`no server.js in ${opts.plugin} (run npm run build?)`);
const DIST = path.dirname(opts.plugin);

// ── fake Anthropic API ──────────────────────────────────────────────

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

function messageStream(model, blocks, stopReason) {
  let out = sse("message_start", {
    message: {
      id: "msg_fake", type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      out += sse("content_block_start", { index, content_block: { type: "text", text: "" } });
      out += sse("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else {
      out += sse("content_block_start", {
        index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      out += sse("content_block_delta", {
        index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    out += sse("content_block_stop", { index });
  });
  out += sse("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
  out += sse("message_stop", {});
  return out;
}

const textStep = (text = FAKE_TEXT) => ({ blocks: [{ type: "text", text }] });
const toolStep = (name, input) => ({ blocks: [{ type: "tool_use", id: "toolu_fake1", name, input }], stop: "tool_use" });
const errorStep = (status, headers = {}) => ({ status, headers });

/**
 * `script` entries are consumed per main (tool-bearing) request; the last one
 * repeats. V2 also sends a tool-less title request alongside each prompt; it
 * always gets plain text so it cannot shift the script.
 */
function startFake(script) {
  const requests = [];
  const sockets = new Set();
  let calls = 0;
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url, "http://fake");
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body, raw });

      if (url.pathname.endsWith("/messages")) {
        const isMain = (body?.tools?.length ?? 0) > 0;
        const step = isMain ? script[Math.min(calls++, script.length - 1)] : textStep("Title");
        if (step.status) {
          const type = step.status === 429 ? "rate_limit_error" : "api_error";
          res.writeHead(step.status, { "content-type": "application/json", ...step.headers });
          res.end(JSON.stringify({ type: "error", error: { type, message: "fake error" } }));
          return;
        }
        const model = body?.model ?? "claude-haiku-4-5";
        if (body?.stream === false) {
          json(res, 200, {
            id: "msg_fake", type: "message", role: "assistant", model,
            content: step.blocks.map((b) => (b.type === "text" ? b : { type: "tool_use", id: b.id, name: b.name, input: b.input })),
            stop_reason: step.stop ?? "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
          });
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(messageStream(model, step.blocks, step.stop ?? "end_turn"));
      } else if (url.pathname.includes("/oauth/token")) {
        json(res, 200, { access_token: "refreshed-access", refresh_token: "refreshed-refresh", expires_in: 3600 });
      } else if (url.pathname.includes("profile")) {
        json(res, 200, { account: { uuid: "fake-uuid", email: "fake@example.invalid" }, organization: { uuid: "fake-org" } });
      } else if (url.pathname.includes("usage")) {
        const window = (ms) => ({ utilization: 10, resets_at: new Date(Date.now() + ms).toISOString() });
        json(res, 200, { five_hour: window(3600e3), seven_day: window(86400e3) });
      } else {
        json(res, 404, {});
      }
    });
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    resolve({
      url: `http://127.0.0.1:${port}`,
      messages: () => requests.filter((r) => r.path.endsWith("/messages")),
      main: () => requests.filter((r) => r.path.endsWith("/messages") && (r.body?.tools?.length ?? 0) > 0),
      close: () => new Promise((done) => { for (const s of sockets) s.destroy(); server.close(() => done()); }),
    });
  }));
}

// ── isolated environment ────────────────────────────────────────────

async function makeEnv({ script = [textStep()], plugin = true, creds = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qa-oc2-"));
  const dirs = {
    root,
    home: path.join(root, "home"),
    claude: path.join(root, "claude"),
    accounts: path.join(root, "accounts"),
    project: path.join(root, "project"),
    config: path.join(root, "xdg", "config"),
    statePath: path.join(root, "rotation-state.json"),
  };
  for (const d of [dirs.home, dirs.claude, dirs.accounts, dirs.project, path.join(dirs.config, "opencode")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const fake = await startFake(script);
  const env = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LANG: "en_US.UTF-8",
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: path.join(root, "xdg", "data"),
    XDG_STATE_HOME: path.join(root, "xdg", "state"),
    XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
    CLAUDE_CONFIG_DIR: dirs.claude,
    CLAUDE_POOL_AUTO_ENROLL: "0",
    CLAUDE_POOL_ACCOUNTS_DIR: dirs.accounts,
    CLAUDE_POOL_STATE_PATH: dirs.statePath,
    ANTHROPIC_TOKEN_URL: `${fake.url}/v1/oauth/token`,
    ANTHROPIC_PROFILE_URL: `${fake.url}/api/oauth/profile`,
    ANTHROPIC_USAGE_URL: `${fake.url}/api/oauth/usage`,
    ANTHROPIC_CLI_VERSION: "2.1.0", // else the plugin shells out to `claude --version`
  };
  if (opts.placeholder) env.ANTHROPIC_API_KEY = "oauth-placeholder";
  if (creds) {
    fs.writeFileSync(path.join(dirs.claude, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: Date.now() + 3600e3 },
    }), { mode: 0o600 });
  }
  const config = { providers: { anthropic: { settings: { baseURL: `${fake.url}/v1` } } } };
  if (plugin) config.plugins = [`file://${opts.plugin}`];
  fs.writeFileSync(path.join(dirs.config, "opencode", "opencode.json"), JSON.stringify(config, null, 2));

  return {
    ...dirs, env, fake,
    runNode: (code) => spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 30_000 }),
    async cleanup() {
      await fake.close();
      // `plugin list` starts a background service under this env; it must not outlive it
      spawnSync(opts.bin, ["service", "stop"], { env, encoding: "utf8", timeout: 20_000 });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The plugin's own dist, under the isolated env, must see only fake credentials. */
function safetyCheck(e, expectedLabels) {
  const r = e.runNode(`
    import { createAccountStore, createSecretBackend } from ${JSON.stringify(path.join(DIST, "pool", "secret-store.js"))};
    import { getClaudeTokens } from ${JSON.stringify(path.join(DIST, "keychain.js"))};
    const accounts = await createAccountStore(createSecretBackend()).listAccounts();
    console.log(JSON.stringify({ accounts: accounts.map((a) => a.label).sort(), tokens: getClaudeTokens() }));
  `);
  if (r.status !== 0) return `safety check failed to run: ${r.stderr.trim().slice(0, 300)}`;
  let seen;
  try { seen = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { return `safety check unreadable: ${r.stdout.slice(0, 200)}`; }
  if (JSON.stringify(seen.accounts) !== JSON.stringify(expectedLabels)) return `isolated store holds accounts ${JSON.stringify(seen.accounts)}`;
  if (seen.tokens && seen.tokens.access !== "fake-access") return "getClaudeTokens() returned a non-fake token";
  return null;
}

// ── pool accounts ───────────────────────────────────────────────────

// Without the override the store would be the macOS keychain, which must never be written.
function distHasAccountsOverride() {
  const file = path.join(DIST, "pool", "secret-store.js");
  return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("CLAUDE_POOL_ACCOUNTS_DIR");
}

function seedAccounts(e, labels) {
  const r = e.runNode(`
    import { createAccountStore, createSecretBackend } from ${JSON.stringify(path.join(DIST, "pool", "secret-store.js"))};
    const store = createAccountStore(createSecretBackend());
    for (const label of ${JSON.stringify(labels)}) {
      await store.putAccount({ label, enrolledAt: Date.now(), oauth: { access: "fake-access-" + label, refresh: "fake-refresh-" + label, expires: Date.now() + 3600e3 } });
    }
  `);
  if (r.status !== 0) throw new Error(`seeding accounts failed: ${r.stderr.trim().slice(0, 300)}`);
}

function coolingAccounts(e) {
  let state;
  try { state = JSON.parse(fs.readFileSync(e.statePath, "utf8")); } catch { return {}; }
  const out = {};
  for (const [label, v] of Object.entries(state.accounts ?? {})) {
    if (v.cooldownUntil && v.cooldownUntil > Date.now()) out[label] = Math.round((v.cooldownUntil - Date.now()) / 1000);
  }
  return out;
}

// ── running OpenCode ────────────────────────────────────────────────

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function runV2(e, args, { timeout = RUN_TIMEOUT_MS, env: extra = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(opts.bin, args, { cwd: e.project, env: { ...e.env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ timedOut, output: strip(stdout + stderr) });
    });
  });
}

const debugReq = (e) => { if (process.env.QA_DEBUG) for (const q of e.fake.messages()) console.error("REQ", q.headers.authorization, "tools="+(q.body?.tools ?? []).length); };
const prompt = async (e, text, extra) => {
  const { args = [], ...rest } = extra ?? {};
  const r = await runV2(e, ["run", "--standalone", "--auto", ...args, "-m", MODEL, text], rest);
  debugReq(e);
  return r;
};
const brief = (s, n = 160) => s.replace(/\s+/g, " ").trim().slice(0, n);

// ── helpers ─────────────────────────────────────────────────────────

const pass = (reason) => ({ ok: true, reason });
const fail = (reason) => ({ ok: false, reason });
const skip = (reason) => ({ ok: true, skipped: true, reason });
const noRequest = (r) => fail(`no request reached the fake (V2 printed: "${brief(r.output)}")`);
const done = (problems, facts) => (problems.length ? fail(`${problems.join("; ")} [${facts}]`) : pass(facts));

const toolNames = (req) => (req.body?.tools ?? []).map((t) => t.name);

function redact(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /^(authorization|x-api-key|cookie|proxy-authorization)$/i.test(k)
      ? String(v).replace(/^(Bearer\s+)?.*$/i, (_, scheme) => `${scheme ?? ""}[redacted]`)
      : v;
  }
  return out;
}

function saveCapture(name, req, keyNote) {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CAPTURE_DIR, name), JSON.stringify({
    note: `captured by qa-opencode2; ${keyNote}`,
    method: req.method, path: req.path, query: req.query, headers: redact(req.headers), body: req.body ?? req.raw,
  }, null, 2));
}

const keyNote = () => (opts.placeholder ? "ANTHROPIC_API_KEY=oauth-placeholder" : "ANTHROPIC_API_KEY unset");

// ── scenarios ───────────────────────────────────────────────────────

const scenarios = {
  async routes() {
    const e = await makeEnv();
    try {
      const r = await prompt(e, "Reply with one word.");
      const n = e.fake.messages().length;
      return n > 0
        ? pass(`V2 sent the anthropic request (${n} to fake)`)
        : fail(`V2 sent NO anthropic request (V2 printed: "${brief(r.output)}")`);
    } finally { await e.cleanup(); }
  },

  async loads() {
    const e = await makeEnv();
    try {
      const expected = path.join(opts.plugin, "server.js");
      const list = await runV2(e, ["plugin", "list"], { timeout: 60_000 });
      if (/opencode-claude-bridge/.test(list.output) && list.output.includes(expected)) return pass(`plugin list shows it from ${expected}`);
      // V2.1.2 `plugin list` shows only package plugins, so fall back to the load log.
      const run = await prompt(e, "Say hello.", { args: ["--print-logs"], env: { ANTHROPIC_API_KEY: "oauth-placeholder" } });
      const loaded = run.output.split("\n").find((l) => l.includes("loading plugin") && l.includes(pathToFileURL(expected).href));
      return loaded
        ? pass(`plugin list says "${brief(list.output, 60)}", but the V2 log shows it loaded from ${expected}`)
        : fail(`plugin list says "${brief(list.output, 60)}" and the V2 log has no "loading plugin" for ${expected}`);
    } finally { await e.cleanup(); }
  },

  async rewrite() {
    const e = await makeEnv();
    try {
      const r = await prompt(e, "Say hello.");
      const req = e.fake.main()[0];
      if (!req) return noRequest(r);
      const h = req.headers;
      const system = typeof req.body?.system === "string" ? [{ text: req.body.system }] : (req.body?.system ?? []);
      const texts = system.map((b) => b.text ?? "");
      const prefixLines = texts.join("\n").split("\n").filter((l) => l.trim() === CLAUDE_PREFIX).length;
      const own = texts.filter((t) => !t.startsWith("x-anthropic-billing-header:") && t.trim() !== CLAUDE_PREFIX).join("\n");

      const problems = [];
      if (!r.output.includes(FAKE_TEXT)) problems.push(`V2 did not print the fake text ("${brief(r.output, 100)}")`);
      if (h.authorization !== "Bearer fake-access") problems.push(`authorization=${JSON.stringify(h.authorization)}`);
      if (h["x-api-key"] !== undefined) problems.push("x-api-key present");
      if (!String(h["user-agent"] ?? "").startsWith("claude-cli/")) problems.push(`user-agent=${h["user-agent"]}`);
      if (!String(h["anthropic-beta"] ?? "").includes("oauth-2025-04-20")) problems.push(`anthropic-beta=${h["anthropic-beta"]}`);
      if (!/(^|&)beta=true(&|$)/.test(req.query.slice(1))) problems.push(`query=${req.query || "(none)"}`);
      if (!texts[0]?.startsWith("x-anthropic-billing-header:")) problems.push(`first system block="${brief(texts[0] ?? "", 50)}"`);
      if (prefixLines !== 1) problems.push(`Claude-agent line appears ${prefixLines}x`);
      if (own.trim().length === 0) problems.push("V2's own system text is gone");
      return done(problems, `claude-agent lines=${prefixLines}, system blocks=${texts.length}, V2 system chars=${own.length}`);
    } finally { await e.cleanup(); }
  },

  async tools() {
    const target = "qa-written.txt";
    // The tool path must be absolute inside the project, which only exists after makeEnv.
    const script = [toolStep("Write", { file_path: "", content: "hello from fake" }), textStep("done")];
    const e = await makeEnv({ script });
    try {
      const file = path.join(e.project, target);
      script[0].blocks[0].input.file_path = file;
      const r = await prompt(e, `Write the file ${target}.`);
      const reqs = e.fake.main();
      if (reqs.length === 0) return noRequest(r);
      const problems = [];
      if (!fs.existsSync(file)) problems.push(`file not written (V2 printed: "${brief(r.output, 120)}")`);
      if (!reqs[1]) problems.push(`no follow-up request (${reqs.length} total)`);
      else if (!JSON.stringify(reqs[1].body?.messages ?? []).includes('"tool_result"')) problems.push("follow-up request carries no tool_result");
      return done(problems, `${reqs.length} request(s), tools sent=[${toolNames(reqs[0])}]`);
    } finally { await e.cleanup(); }
  },

  async capture() {
    const notes = [];
    // Native V2 needs some key to send at all, so retry once with a dummy one.
    const native = await makeEnv({ plugin: false });
    try {
      let r = await prompt(native, "Say hello.");
      let note = keyNote();
      if (native.fake.main().length === 0) {
        r = await prompt(native, "Say hello.", { env: { ANTHROPIC_API_KEY: "native-capture-key" } });
        note = "ANTHROPIC_API_KEY=native-capture-key (nothing was sent without a key)";
      }
      const req = native.fake.main()[0];
      if (!req) return fail(`native V2 sent no request even with a key ("${brief(r.output)}")`);
      saveCapture("native-request.json", req, note);
      notes.push(`native tools=[${toolNames(req)}]`);
    } finally { await native.cleanup(); }

    const withPlugin = await makeEnv();
    try {
      const r = await prompt(withPlugin, "Say hello.");
      const req = withPlugin.fake.main()[0];
      if (!req) return fail(`${notes[0]}; with plugin no request reached the fake ("${brief(r.output)}")`);
      saveCapture("with-plugin-request.json", req, keyNote());
      notes.push(`with-plugin tools=[${toolNames(req)}]`);
    } finally { await withPlugin.cleanup(); }
    return pass(`saved to ${CAPTURE_DIR}; ${notes.join("; ")}`);
  },

  async "retry-429"() {
    const e = await makeEnv({ script: [errorStep(429, { "retry-after": "3600" })] });
    try {
      const r = await prompt(e, "Say hello.", { timeout: RETRY_TIMEOUT_MS });
      const n = e.fake.main().length;
      if (n === 0) return noRequest(r);
      const killed = r.timedOut ? `, V2 still running after ${RETRY_TIMEOUT_MS / 1000}s (killed)` : "";
      return pass(`${n} main request(s) reached the fake (${e.fake.messages().length} incl. title)${killed}; V2 printed: "${brief(r.output)}"`);
    } finally { await e.cleanup(); }
  },

  async rotate() {
    if (!distHasAccountsOverride()) return skip("dist lacks CLAUDE_POOL_ACCOUNTS_DIR");
    const e = await makeEnv({ creds: false, script: [errorStep(429, { "retry-after": "3600" }), textStep()] });
    try {
      seedAccounts(e, ["a", "b"]);
      const bad = safetyCheck(e, ["a", "b"]);
      if (bad) return fail(bad);
      const r = await prompt(e, "Say hello.", { timeout: RETRY_TIMEOUT_MS });
      const reqs = e.fake.main();
      if (reqs.length === 0) return noRequest(r);
      const auths = reqs.map((q) => q.headers.authorization);
      const cooling = coolingAccounts(e);
      const problems = [];
      if (!r.output.includes(FAKE_TEXT)) problems.push(`V2 did not print the fake text ("${brief(r.output, 100)}")`);
      if (!auths[1] || auths[1] === auths[0]) problems.push("second request did not use a different account");
      if (!(cooling[auths[0]?.replace("Bearer fake-access-", "")] > 3000)) problems.push("first account not cooling ~1h");
      return done(problems, `${reqs.length} request(s), auth=[${auths}], cooling(s)=${JSON.stringify(cooling)}`);
    } finally { await e.cleanup(); }
  },

  async exhausted() {
    if (!distHasAccountsOverride()) return skip("dist lacks CLAUDE_POOL_ACCOUNTS_DIR");
    const e = await makeEnv({ creds: false, script: [errorStep(429, { "retry-after": "3600" })] });
    try {
      seedAccounts(e, ["a", "b"]);
      const bad = safetyCheck(e, ["a", "b"]);
      if (bad) return fail(bad);
      // First run cools both accounts through real 429s; the second meets an exhausted pool.
      await prompt(e, "Say hello.", { timeout: RETRY_TIMEOUT_MS });
      const before = e.fake.main().length;
      const r = await prompt(e, "Say hello again.", { timeout: RETRY_TIMEOUT_MS});
      const sent = e.fake.main().length - before;
      const cooling = Object.keys(coolingAccounts(e));
      const problems = [];
      if (cooling.length < 2) problems.push("both accounts not cooling after the first run");
      if (!/pool|exhaust|cooling|resets?/i.test(r.output)) problems.push("V2 did not show a pool-exhausted message");
      if (sent > 0) problems.push(`${sent} request(s) still sent upstream while the pool was exhausted`);
      const killed = r.timedOut ? `, still running after ${RETRY_TIMEOUT_MS / 1000}s (killed)` : "";
      return done(problems, `cooling=[${cooling}], first run sent ${before}, second run sent ${sent}${killed}, V2 printed: "${brief(r.output)}"`);
    } finally { await e.cleanup(); }
  },
};

// ── main ────────────────────────────────────────────────────────────

async function main() {
  const all = Object.keys(scenarios);
  const names = opts.names.length ? opts.names : all;
  for (const n of names) if (!scenarios[n]) die(`unknown scenario "${n}" (have: ${all.join(", ")})`);

  // Gate before any V2 process starts.
  const gate = await makeEnv();
  try {
    const bad = safetyCheck(gate, []);
    if (bad) { console.error(`SAFETY STOP: ${bad}`); process.exit(3); }
  } finally { await gate.cleanup(); }

  console.log(`bin=${opts.bin}\nplugin=${opts.plugin}\nANTHROPIC_API_KEY=${opts.placeholder ? "oauth-placeholder" : "(unset)"}\n`);
  let failed = 0;
  for (const name of names) {
    let result;
    try { result = await scenarios[name](); } catch (err) { result = fail(`harness error: ${err instanceof Error ? err.message : err}`); }
    if (!result.ok) failed++;
    console.log(`${result.skipped ? "SKIP" : result.ok ? "PASS" : "FAIL"}  ${name}: ${result.reason}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
