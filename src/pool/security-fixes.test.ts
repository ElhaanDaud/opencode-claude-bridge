/**
 * Regression tests for issues found in the credential-pool security audit.
 * Each case pins a failure mode that is silent and expensive if it returns.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { classify, MAX_TRANSIENT_ATTEMPTS } from "./classifier.js";
import { isCredentialRejected } from "./manager.js";
import { createRotationStateStore } from "./rotation-state.js";

const NOW = 1_000_000;

function tempPath(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-sec-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "rotation-state.json");
}

describe("audit M1: bounded short-reset retries", () => {
  it("retries the same account while under the attempt cap", () => {
    const decision = classify({
      status: 429,
      headers: { "retry-after": "30" },
      now: NOW,
      attempt: 0,
    });
    assert.equal(decision.action, "RETRY_SAME");
  });

  it("escalates to rotation once short-reset retries are exhausted", () => {
    const decision = classify({
      status: 429,
      headers: { "retry-after": "30" },
      now: NOW,
      attempt: MAX_TRANSIENT_ATTEMPTS,
    });

    // Without the cap this returns RETRY_SAME forever and the request hangs.
    assert.equal(decision.action, "ROTATE_COOLDOWN");
    assert.equal(decision.until, NOW + 30_000);
  });
});

describe("audit H2: refresh failure classification", () => {
  it("treats a rejected credential as permanent", () => {
    assert.equal(isCredentialRejected("Token refresh failed (400): invalid_grant"), true);
    assert.equal(isCredentialRejected("Token refresh failed (401): unauthorized_client"), true);
    assert.equal(isCredentialRejected("invalid_client"), true);
  });

  it("treats an unreachable or failing endpoint as transient", () => {
    assert.equal(isCredentialRejected("Token refresh failed (500): server error"), false);
    assert.equal(isCredentialRejected("Token refresh failed (429): Rate limited"), false);
    assert.equal(isCredentialRejected("connect ETIMEDOUT 1.2.3.4:443"), false);
    assert.equal(isCredentialRejected("spawn curl ENOENT"), false);
  });
});

describe("re-enrollment restores a disabled account", () => {
  it("clears disabled, cooldown and failure count when fresh credentials arrive", async (t) => {
    const store = createRotationStateStore({ path: tempPath(t), clock: () => NOW });
    await store.markDisabled("alice", "refresh rejected: invalid_grant");
    await store.markCooldown("alice", NOW + 3_600_000, "exhausted");

    await store.resetHealth("alice");

    const account = store.load().accounts.alice;
    // Enrolling new credentials that leave the account disabled would make
    // rotation skip it forever while the CLI reports enrollment succeeded.
    assert.equal(account?.disabled, false);
    assert.equal(account?.cooldownUntil, null);
    assert.equal(account?.failureCount, 0);
  });

  it("creates a healthy account when one does not exist yet", async (t) => {
    const store = createRotationStateStore({ path: tempPath(t), clock: () => NOW });

    await store.resetHealth("bob");

    assert.equal(store.load().accounts.bob?.disabled, false);
  });
});

describe("audit H1: stale lock reclaim requires a dead holder", () => {
  it("does not reclaim an aged lock whose holder is still alive", async (t) => {
    const statePath = tempPath(t);
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    // Our own pid: unambiguously alive. Aged far past the stale threshold, as
    // a slow-but-healthy token refresh legitimately would be.
    fs.writeFileSync(
      `${statePath}.lock`,
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: 0,
        nonce: "live-holder",
      }),
      { mode: 0o600 },
    );

    // Clock must advance or the acquire loop can never reach its deadline.
    let now = 10_000_000;
    const store = createRotationStateStore({
      path: statePath,
      clock: () => (now += 5),
      staleLockMs: 1_000,
      lockPollMs: 1,
      lockTimeoutMs: 40,
    });

    // Reclaiming here would let a second process refresh the same account
    // concurrently, rotating its refresh token twice and bricking it.
    await assert.rejects(store.withLock(() => undefined), /timed out/);

    const held = JSON.parse(fs.readFileSync(`${statePath}.lock`, "utf8"));
    assert.equal(held.nonce, "live-holder");
  });

  it("still reclaims an aged lock from a process that is gone", async (t) => {
    const statePath = tempPath(t);
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      `${statePath}.lock`,
      JSON.stringify({
        pid: 2, // pid 2 is not a live node process we can signal
        hostname: "some-other-host",
        acquiredAt: 1_000,
        nonce: "dead-holder",
      }),
      { mode: 0o600 },
    );

    const store = createRotationStateStore({
      path: statePath,
      clock: () => 10_000_000,
      staleLockMs: 1_000,
      lockPollMs: 1,
    });

    let entered = false;
    await store.withLock(() => {
      entered = true;
    });

    assert.equal(entered, true);
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
  });
});
