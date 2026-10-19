import { describe, it } from "node:test";
import assert from "node:assert/strict";

// TOKEN_URL is read at import time; point it at a port that refuses connections.
process.env.ANTHROPIC_TOKEN_URL = "http://127.0.0.1:1/v1/oauth/token";
const {
  buildTokenCurlArgs,
  FALLBACK_TOKEN_LIFETIME_MS,
  parseTokenResponse,
  refreshTokens,
} = await import("./oauth.js");
const { isCredentialRejected } = await import("./pool/manager.js");

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
      await refreshTokens(secret);
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
