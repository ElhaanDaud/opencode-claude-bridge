import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// TOKEN_URL is read at import time. It names a port that was bound and then
// released, so connections are refused until a test serves tokens on it.
const probe = http.createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const tokenPort = (probe.address() as AddressInfo).port;
await new Promise((resolve) => probe.close(resolve));
process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${tokenPort}/v1/oauth/token`;
const {
  buildTokenCurlArgs,
  curlFailedBeforeSending,
  exchangeCodeForTokens,
  FALLBACK_TOKEN_LIFETIME_MS,
  parsePastedState,
  parseTokenResponse,
  refreshTokens,
  startOAuthCallbackServer,
  UNCERTAIN_SEND_HOLD_MS,
} = await import("./oauth.js");
const { isCredentialRejected } = await import("./pool/manager.js");

const noPause = async () => {};

describe("token response validation", () => {
  it("returns the tokens and their lifetime", () => {
    const before = Date.now();
    const tokens = parseTokenResponse(
      200,
      JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 3600 }),
      "Token refresh",
    );
    assert.equal(tokens.access, "a1");
    assert.equal(tokens.refresh, "r1");
    assert.ok(tokens.expires >= before + 3_600_000 && tokens.expires <= Date.now() + 3_600_000);
  });

  it("rejects a 200 without both tokens instead of returning undefined credentials", () => {
    for (const body of [
      JSON.stringify({ access_token: "a1", expires_in: 3600 }),
      JSON.stringify({ refresh_token: "r1", expires_in: 3600 }),
      JSON.stringify({ access_token: "", refresh_token: "r1", expires_in: 3600 }),
      "null",
    ]) {
      assert.throws(() => parseTokenResponse(200, body, "Token refresh"), /without an access and refresh token/);
    }
  });

  it("does not quote a malformed 200 body, which may contain token fragments", () => {
    const body = '{"access_token":"sk-ant-oat01-SECRET","refresh_token":"sk-ant-ort01-SEC';
    assert.throws(
      () => parseTokenResponse(200, body, "Token refresh"),
      (err: Error) => /malformed response/.test(err.message) && !err.message.includes("SECRET"),
    );
  });

  it("keeps valid tokens whose lifetime is missing, with a short expiry", () => {
    const before = Date.now();
    const tokens = parseTokenResponse(200, JSON.stringify({ access_token: "a1", refresh_token: "r1" }), "Token refresh");
    assert.equal(tokens.refresh, "r1");
    assert.ok(Number.isFinite(tokens.expires));
    assert.ok(tokens.expires >= before + FALLBACK_TOKEN_LIFETIME_MS);
    assert.ok(tokens.expires <= Date.now() + FALLBACK_TOKEN_LIFETIME_MS);
  });

  it("is not treated as a rejected credential, so the account cools instead of being disabled", () => {
    try {
      parseTokenResponse(200, "{}", "Token refresh");
      assert.fail("expected a throw");
    } catch (err) {
      assert.equal(isCredentialRejected((err as Error).message), false);
    }
  });
});

describe("token endpoint secret handling", () => {
  it("never places the request payload in curl's argv", () => {
    const args = buildTokenCurlArgs();
    assert.deepEqual(args.slice(-2), ["--data-binary", "@-"]);
    assert.ok(!args.some((arg) => arg.includes("refresh_token")));
  });

  it("does not leak the refresh token when the endpoint is unreachable", async () => {
    const secret = "sk-ant-ort01-TEST-SECRET-VALUE";
    let caught: unknown;
    try {
      await refreshTokens(secret, 3, noPause);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, "expected refreshTokens to throw");
    assert.ok(!caught.message.includes(secret), caught.message);
    assert.match(caught.message, /^Token endpoint unreachable: /);
    // A network failure must cool the account, never permanently disable it.
    assert.equal(isCredentialRejected(caught.message), false);
  });
});

describe("OAuth state verification", () => {
  it("reads the state from each pasted form", () => {
    assert.equal(parsePastedState("abc123#st4te"), "st4te");
    assert.equal(parsePastedState("https://x/callback?code=abc&state=st%3Dte"), "st=te");
    assert.equal(parsePastedState("  abc123  "), null);
  });

  it("ignores a forged callback and still accepts the real one", async () => {
    const server = await startOAuthCallbackServer();
    try {
      const base = `http://localhost:${server.port}/callback`;
      const forged = await fetch(`${base}?code=attacker&state=wrong`);
      assert.equal(forged.status, 400);
      const noState = await fetch(`${base}?error=access_denied`);
      assert.equal(noState.status, 400);

      const real = await fetch(`${base}?code=genuine&state=${encodeURIComponent(server.state)}`);
      assert.equal(real.status, 200);
      assert.equal(await server.waitForCode(), "genuine");
    } finally {
      server.close();
    }
  });
});

describe("token endpoint error bodies", () => {
  const cloudflare = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>${"x".repeat(5000)}</body></html>`;

  it("does not treat a firewall page as a rejected credential, and never quotes it", () => {
    let message = "";
    try {
      parseTokenResponse(403, cloudflare, "Token refresh");
    } catch (err) {
      message = (err as Error).message;
    }
    assert.match(message, /HTTP 403 with a non-JSON body \("Just a moment\.\.\."\)/);
    assert.ok(!message.includes("<html"), message);
    assert.ok(message.length < 200, `message is ${message.length} chars`);
    assert.equal(isCredentialRejected(message), false);
  });

  it("still treats an OAuth invalid_grant as a rejected credential", () => {
    let message = "";
    try {
      parseTokenResponse(400, JSON.stringify({ error: "invalid_grant", error_description: "revoked" }), "Token refresh");
    } catch (err) {
      message = (err as Error).message;
    }
    assert.equal(isCredentialRejected(message), true);
  });
});

describe("token endpoint resends", () => {
  const requests: Array<Record<string, string>> = [];
  let answer: (res: http.ServerResponse, n: number) => void = () => {};
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(raw) as Record<string, string>);
      answer(res, requests.length);
    });
  });
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const fresh = { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 };
  // The server reads the request, spends the token, and the reply never arrives.
  const loseFirstReply = (res: http.ServerResponse, n: number) => {
    if (n === 1) {
      res.socket?.destroy();
      return;
    }
    json(res, 400, { error: "invalid_grant", error_description: "Refresh token already used" });
  };

  async function serve(reply: typeof answer): Promise<void> {
    requests.length = 0;
    answer = reply;
    await new Promise<void>((resolve) => server.listen(tokenPort, "127.0.0.1", resolve));
  }

  afterEach(async () => {
    mock.timers.reset();
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("sends a refresh token once when the reply is lost after the server read the request", async () => {
    await serve(loseFirstReply);
    await assert.rejects(refreshTokens("old-refresh"), (err: Error) => {
      assert.match(err.message, /^Token endpoint unreachable: /);
      // The account cools instead of being disabled.
      assert.equal(isCredentialRejected(err.message), false);
      return true;
    });
    assert.deepEqual(requests.map((r) => r.refresh_token), ["old-refresh"]);
  });

  it("holds a possibly spent refresh token back from the next caller, then lets it be tried again", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    await serve(loseFirstReply);
    await assert.rejects(refreshTokens("held-refresh"), /^Error: Token endpoint unreachable: /);
    // A second request holding the same token gets the same failure, unsent.
    await assert.rejects(refreshTokens("held-refresh"), /^Error: Token endpoint unreachable: /);
    assert.equal(requests.length, 1);

    // The server may never have read it, so after the hold it is sent once more.
    mock.timers.tick(UNCERTAIN_SEND_HOLD_MS);
    await assert.rejects(refreshTokens("held-refresh"), /Token refresh failed \(400\): invalid_grant/);
    assert.deepEqual(requests.map((r) => r.refresh_token), ["held-refresh", "held-refresh"]);
  });

  it("sends an authorization code once when the reply is lost, as codes are single-use too", async () => {
    await serve(loseFirstReply);
    await assert.rejects(exchangeCodeForTokens("the-code", "the-verifier"), /^Error: Token endpoint unreachable: /);
    assert.deepEqual(requests.map((r) => r.code), ["the-code"]);
  });

  it("resends after a 429, which the server answered without spending the token", async () => {
    await serve((res, n) => (n === 1 ? json(res, 429, { error: { type: "rate_limit_error" } }) : json(res, 200, fresh)));
    const tokens = await refreshTokens("limited-refresh", 3, noPause);
    assert.equal(tokens.refresh, "new-refresh");
    assert.deepEqual(requests.map((r) => r.refresh_token), ["limited-refresh", "limited-refresh"]);
  });

  it("resends after a refused connection, which never sent the request", async () => {
    let pauses = 0;
    // Nothing listens on the port until the pause before the second attempt.
    const tokens = await refreshTokens("refused-refresh", 3, async () => {
      pauses++;
      await serve((res) => json(res, 200, fresh));
    });
    assert.equal(tokens.refresh, "new-refresh");
    assert.equal(pauses, 1);
    assert.deepEqual(requests.map((r) => r.refresh_token), ["refused-refresh"]);
  });

  it("resends only after curl failed to resolve, connect or handshake", () => {
    for (const code of [6, 7, 35]) assert.equal(curlFailedBeforeSending({ code }), true, `exit ${code}`);
    for (const err of [
      { code: 28 }, // timed out
      { code: 52 }, // empty reply
      { code: 55 }, // send failure
      { code: 56 }, // receive failure
      { code: null, killed: true, signal: "SIGTERM" }, // runCurl's timeout
      { code: null, signal: "SIGHUP" }, // killed from outside
      { code: "ENOENT" },
      new Error("unknown"),
    ]) {
      assert.equal(curlFailedBeforeSending(err), false, JSON.stringify(err));
    }
  });

  it("keeps curl out of the caller's process group, so a terminal's SIGHUP does not lose the reply", async () => {
    let caller: ChildProcess | undefined;
    await serve((res) => {
      // As closing the terminal does: signal the caller's whole group once the token is spent.
      process.kill(-caller!.pid!, "SIGHUP");
      setTimeout(() => json(res, 200, fresh), 200);
    });
    const home = mkdtempSync(join(tmpdir(), "oauth-test-"));
    // The caller outlives SIGHUP to wait for its refresh, as the pool dashboard does.
    const script = `
      process.on("SIGHUP", () => {});
      const { refreshTokens } = await import(${JSON.stringify(new URL("./oauth.js", import.meta.url).href)});
      const result = await refreshTokens("hangup-refresh").catch((err) => ({ error: err.message }));
      process.stdout.write(JSON.stringify(result));
    `;
    caller = spawn(process.execPath, ["--input-type=module", "-e", script], {
      detached: true, // its own process group, like a terminal's foreground job
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_CLI_VERSION: "2.1.200" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    caller.stdout!.on("data", (chunk) => { out += chunk; });
    await once(caller, "close");
    rmSync(home, { recursive: true, force: true });
    assert.equal(JSON.parse(out).refresh, "new-refresh", out);
    assert.deepEqual(requests.map((r) => r.refresh_token), ["hangup-refresh"]);
  });

  it("kills curl after 30 s and does not resend, as the server may have read the request", async () => {
    let received!: () => void;
    const read = new Promise<void>((resolve) => { received = resolve; });
    await serve(() => received()); // reads the request and never answers
    mock.timers.enable({ apis: ["setTimeout"] });
    const refresh = refreshTokens("stalled-refresh", 3, noPause);
    await read;
    mock.timers.tick(30_000);
    await assert.rejects(refresh, /^Error: Token endpoint unreachable: request timed out$/);
    assert.equal(requests.length, 1);
  });

  it("rejects a reply over 1 MiB without resending", async () => {
    await serve((res) => json(res, 200, { ...fresh, padding: "x".repeat(1024 * 1024) }));
    await assert.rejects(refreshTokens("bloated-refresh", 3, noPause), /^Error: Token endpoint unreachable: /);
    assert.equal(requests.length, 1);
  });

  it("reports a missing curl plainly", async () => {
    const path = process.env.PATH;
    process.env.PATH = join(tmpdir(), "no-such-dir");
    try {
      await assert.rejects(
        refreshTokens("no-curl-refresh"),
        /^Error: Token endpoint unreachable: curl is not installed or not on PATH$/,
      );
    } finally {
      process.env.PATH = path;
    }
  });
});
