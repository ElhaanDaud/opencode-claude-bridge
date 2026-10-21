import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { createRotationManager, describeExhaustion, formatWait } from "./manager.js";
import { createRotationStateStore } from "./rotation-state.js";
import { createAccountStore } from "./secret-store.js";
import type {
  AccountRecord,
  PoolOAuthTokens,
  SecretBackend,
} from "./types.js";

const NOW = 1_000_000;

function memoryBackend(seed: Record<string, string> = {}): SecretBackend {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    async get(label) {
      return map.get(label) ?? null;
    },
    async set(label, value) {
      map.set(label, value);
    },
    async remove(label) {
      map.delete(label);
    },
    async list() {
      return [...map.keys()];
    },
  };
}

function record(
  label: string,
  overrides: Partial<PoolOAuthTokens> = {},
): AccountRecord {
  return {
    label,
    oauth: {
      access: `access-${label}`,
      refresh: `refresh-${label}`,
      expires: NOW + 3_600_000,
      ...overrides,
    },
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    enrolledAt: NOW - 10_000,
  };
}

interface Harness {
  manager: ReturnType<typeof createRotationManager>;
  state: ReturnType<typeof createRotationStateStore>;
  accounts: ReturnType<typeof createAccountStore>;
  refreshCalls: string[];
  mirrored: PoolOAuthTokens[];
  disabledEvents: string[];
  journalPath: string;
  statePath: string;
  setNow: (n: number) => void;
}

function harness(
  t: TestContext,
  seedRecords: AccountRecord[],
  refreshImpl?: (refreshToken: string) => PoolOAuthTokens,
): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-manager-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const seed: Record<string, string> = {};
  for (const r of seedRecords) seed[r.label] = JSON.stringify(r);

  let now = NOW;
  const clock = () => now;
  const accounts = createAccountStore(memoryBackend(seed));
  const statePath = path.join(root, "rotation-state.json");
  const state = createRotationStateStore({
    path: statePath,
    clock,
    lockPollMs: 1,
  });
  const journalPath = path.join(root, "refresh-journal.json");

  const refreshCalls: string[] = [];
  const mirrored: PoolOAuthTokens[] = [];
  const disabledEvents: string[] = [];

  const manager = createRotationManager({
    accounts,
    state,
    clock,
    journalPath,
    onAccountDisabled: (label) => {
      disabledEvents.push(label);
    },
    refreshFn: (token) => {
      refreshCalls.push(token);
      if (refreshImpl) return refreshImpl(token);
      const label = token.replace(/^refresh-/, "");
      return {
        access: `access-${label}-v2`,
        refresh: `refresh-${label}-v2`,
        expires: now + 3_600_000,
      };
    },
    mirrorFn: async (tokens) => {
      mirrored.push(tokens);
    },
  });

  return {
    manager,
    state,
    accounts,
    refreshCalls,
    mirrored,
    disabledEvents,
    journalPath,
    statePath,
    setNow: (n) => {
      now = n;
    },
  };
}

describe("rotation manager activation", () => {
  it("stays inactive until an account is enrolled", async (t) => {
    const empty = harness(t, []);
    assert.equal(await empty.manager.isActive(), false);

    const seeded = harness(t, [record("alice")]);
    assert.equal(await seeded.manager.isActive(), true);
  });

  it("stays active and registers accounts whose credentials cannot be read", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-manager-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // A locked keychain still lists its items but refuses to read them.
    const locked: SecretBackend = {
      ...memoryBackend({ alice: JSON.stringify(record("alice")) }),
      async get(label) {
        throw new Error(`Failed to read keychain account "${label}"`);
      },
    };
    const state = createRotationStateStore({ path: path.join(root, "state.json"), lockPollMs: 1 });
    const manager = createRotationManager({
      accounts: createAccountStore(locked),
      state,
      clock: () => NOW,
      journalPath: path.join(root, "journal.json"),
      refreshFn: () => {
        throw new Error("unused");
      },
      mirrorFn: async () => {},
    });

    assert.equal(await manager.isActive(), true);
    assert.deepEqual(await manager.listLabels(), ["alice"]);
    await manager.sync();
    assert.ok(state.load().accounts.alice);
  });
});

describe("rotation manager token acquisition", () => {
  it("returns the existing token when it is still fresh", async (t) => {
    const h = harness(t, [record("alice")]);

    const result = await h.manager.acquire();

    assert.equal(result.kind, "ok");
    assert.equal(result.kind === "ok" && result.label, "alice");
    assert.equal(result.kind === "ok" && result.accessToken, "access-alice");
    assert.deepEqual(h.refreshCalls, []);
    assert.equal(h.mirrored.length, 1);
  });

  it("refreshes an expired token, persists it, and mirrors it", async (t) => {
    const h = harness(t, [record("alice", { expires: NOW - 1 })]);

    const result = await h.manager.acquire();

    assert.equal(result.kind === "ok" && result.accessToken, "access-alice-v2");
    assert.deepEqual(h.refreshCalls, ["refresh-alice"]);

    const stored = await h.accounts.getAccount("alice");
    assert.equal(stored?.oauth.refresh, "refresh-alice-v2");
    // Non-token fields must survive a refresh.
    assert.equal(stored?.subscriptionType, "max");
    assert.equal(h.mirrored.at(-1)?.access, "access-alice-v2");
  });

  it("still returns the token when mirroring into auth.json fails", async (t) => {
    const h = harness(t, [record("alice")]);
    const manager = createRotationManager({
      accounts: h.accounts,
      state: h.state,
      clock: () => NOW,
      journalPath: h.journalPath,
      refreshFn: () => {
        throw new Error("must not refresh a fresh token");
      },
      mirrorFn: async (tokens) => {
        throw new Error(`auth.set boom for ${tokens.access}`);
      },
    });
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    t.after(() => {
      console.error = originalError;
    });

    const result = await manager.acquire();

    // auth.json is only a copy of the pool; failing to write it must not fail the request.
    assert.equal(result.kind === "ok" && result.accessToken, "access-alice");
    assert.equal(h.state.load().activeLabel, "alice");
    assert.ok(errors.some((e) => e.includes("auth.json")), errors.join("\n"));
    assert.ok(!errors.some((e) => e.includes("access-alice")), errors.join("\n"));
  });

  it("mirrors into auth.json only when the tokens differ from the last mirror", async (t) => {
    const h = harness(t, [record("alice"), record("bob")]);

    const cool = (label: string) =>
      h.manager.applyDecision(label, {
        action: "ROTATE_COOLDOWN",
        until: NOW + 7_200_000,
        reason: "exhausted",
        source: "retry-after",
      });
    const mirrored = () => h.mirrored.map((m) => m.access);

    await h.manager.acquire();
    await h.manager.acquire();
    // Each mirror rewrites OpenCode's auth.json; unchanged tokens need no write.
    assert.deepEqual(mirrored(), ["access-alice"]);

    await cool("alice");
    await h.manager.acquire();
    assert.deepEqual(mirrored(), ["access-alice", "access-bob"]);

    // Back to alice with the same tokens: auth.json now holds bob's.
    await h.manager.markSuccess("alice", NOW);
    await cool("bob");
    await h.manager.acquire();
    assert.deepEqual(mirrored(), ["access-alice", "access-bob", "access-alice"]);

    h.setNow(NOW + 3_600_000);
    await h.manager.acquire();
    assert.deepEqual(mirrored(), ["access-alice", "access-bob", "access-alice", "access-alice-v2"]);
  });

  it("retries a failed mirror on the next acquire", async (t) => {
    const h = harness(t, [record("alice")]);
    const attempts: string[] = [];
    let failing = true;
    const manager = createRotationManager({
      accounts: h.accounts,
      state: h.state,
      clock: () => NOW,
      journalPath: h.journalPath,
      refreshFn: () => {
        throw new Error("must not refresh a fresh token");
      },
      mirrorFn: async (tokens) => {
        attempts.push(tokens.access);
        if (failing) throw new Error("auth.set boom");
      },
    });
    const originalError = console.error;
    console.error = () => {};
    t.after(() => {
      console.error = originalError;
    });

    await manager.acquire();
    failing = false;
    await manager.acquire();
    await manager.acquire();

    assert.deepEqual(attempts, ["access-alice", "access-alice"]);
  });

  it("collapses concurrent refreshes of one account into a single call", async (t) => {
    const h = harness(t, [record("alice", { expires: NOW - 1 })]);

    await Promise.all([
      h.manager.acquire(),
      h.manager.acquire(),
      h.manager.acquire(),
    ]);

    // More than one call means we burned a refresh token needlessly, which is
    // exactly how an account gets bricked.
    assert.equal(h.refreshCalls.length, 1);
  });

  it("clears the journal once the refresh is committed", async (t) => {
    const h = harness(t, [record("alice", { expires: NOW - 1 })]);

    await h.manager.acquire();

    assert.equal(fs.existsSync(h.journalPath), false);
  });

  it("journals the new tokens before committing them", async (t) => {
    const order: string[] = [];
    const h = harness(t, [record("alice", { expires: NOW - 1 })]);
    const originalUpdate = h.accounts.updateTokens.bind(h.accounts);
    h.accounts.updateTokens = async (label, tokens) => {
      // The journal must already exist by the time we commit, otherwise a
      // crash here would lose the only valid refresh token.
      order.push(fs.existsSync(h.journalPath) ? "journal-first" : "commit-first");
      return originalUpdate(label, tokens);
    };

    await h.manager.acquire();

    assert.deepEqual(order, ["journal-first"]);
  });

  it("commits the new tokens even when the journal cannot be written", async (t) => {
    const h = harness(t, [record("alice", { expires: NOW - 1 })]);
    // A directory in the journal's place makes the final rename fail.
    fs.mkdirSync(h.journalPath);

    const tokens = await h.manager.refreshLabel("alice");

    assert.equal(tokens.refresh, "refresh-alice-v2");
    assert.deepEqual(h.refreshCalls, ["refresh-alice"]);
    assert.equal((await h.accounts.getAccount("alice"))?.oauth.refresh, "refresh-alice-v2");
    const leftovers = fs.readdirSync(path.dirname(h.journalPath)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});

describe("rotation manager token-endpoint firewall pages", () => {
  it("cools every account on an HTML 403 instead of disabling the pool", async (t) => {
    const { parseTokenResponse } = await import("../oauth.js");
    const page = "<html><head><title>Just a moment...</title></head><body>challenge</body></html>";
    const h = harness(
      t,
      ["a", "b", "c"].map((label) => record(label, { expires: NOW - 1 })),
      () => parseTokenResponse(403, page, "Token refresh"),
    );

    const result = await h.manager.acquire();

    assert.equal(result.kind, "exhausted");
    for (const account of Object.values(h.state.load().accounts)) {
      assert.equal(account.disabled, false);
      assert.ok((account.cooldownUntil ?? 0) > NOW);
      assert.ok(!account.lastReason?.includes("<html"), account.lastReason ?? "");
    }
  });
});

describe("rotation manager lock contention during refresh", () => {
  // A second process on the same pool: real-clock locks with a short timeout.
  function otherProcess(h: Harness, refreshCalls: string[]) {
    return createRotationManager({
      accounts: h.accounts,
      state: createRotationStateStore({ path: h.statePath, lockPollMs: 1, lockTimeoutMs: 100 }),
      clock: () => NOW,
      journalPath: h.journalPath,
      refreshFn: (token) => {
        refreshCalls.push(token);
        throw new Error("must not refresh while another process holds the lock");
      },
      mirrorFn: async () => {},
    });
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Timeline (ms): holder takes the lock at 0; the other process reads a stale
  // token at ~20 and then waits for the lock until ~120.
  function holdLock(h: Harness, holdMs: number, whileHeld: () => Promise<void> = async () => {}) {
    const holder = createRotationStateStore({ path: h.statePath, lockPollMs: 1 });
    return holder.withLock(async () => {
      await whileHeld();
      await sleep(holdMs);
    });
  }

  it("uses the holder's freshly refreshed token instead of cooling the account", async (t) => {
    const h = harness(t, [record("alice", { expires: NOW - 1 })]);
    const calls: string[] = [];
    await h.manager.sync();
    // The holder's refresh lands at ~60, after the stale read but before the timeout.
    const held = holdLock(h, 400, async () => {
      await sleep(60);
      await h.accounts.updateTokens("alice", { access: "access-alice-v2", refresh: "refresh-alice-v2", expires: NOW + 3_600_000 });
    });
    await sleep(20);

    const result = await otherProcess(h, calls).acquire();
    await held;

    assert.equal(result.kind === "ok" && result.accessToken, "access-alice-v2");
    assert.deepEqual(calls, []);
    assert.equal(h.state.load().accounts.alice?.cooldownUntil ?? null, null);
  });

  it("falls back to another usable account while the lock is busy", async (t) => {
    const h = harness(t, [record("alice", { expires: NOW - 1 }), record("bob")]);
    await h.manager.sync();
    const held = holdLock(h, 400);
    await sleep(20);

    const result = await otherProcess(h, []).acquire();
    await held;

    assert.equal(result.kind === "ok" && result.label, "bob");
    const alice = h.state.load().accounts.alice;
    assert.equal(alice?.cooldownUntil ?? null, null);
    assert.equal(alice?.disabled, false);
  });

  it("fails the request without penalising the account when the token is still stale", async (t) => {
    const h = harness(t, [record("alice", { expires: NOW - 1 })]);
    await h.manager.sync();
    // Released at ~150, just after the timeout, so a cooldown write would succeed.
    const held = holdLock(h, 150);
    await sleep(20);

    await assert.rejects(otherProcess(h, []).acquire(), /timed out/);
    await held;

    const alice = h.state.load().accounts.alice;
    assert.equal(alice?.cooldownUntil ?? null, null);
    assert.equal(alice?.disabled, false);
  });
});

describe("rotation manager keychain read failures", () => {
  it("cools an account whose credentials cannot be read, instead of disabling it", async (t) => {
    const h = harness(t, [record("alice"), record("bob")]);
    const originalGet = h.accounts.getAccount.bind(h.accounts);
    h.accounts.getAccount = async (label) => {
      if (label === "alice") throw new Error('Failed to read keychain account "alice"');
      return originalGet(label);
    };

    const result = await h.manager.acquire();

    assert.equal(result.kind === "ok" && result.label, "bob");
    const alice = h.state.load().accounts.alice;
    assert.equal(alice?.disabled, false);
    assert.ok((alice?.cooldownUntil ?? 0) > NOW);
  });
});

describe("rotation manager journal replay", () => {
  it("commits a journal left behind by a crashed process", async (t) => {
    const h = harness(t, [record("alice")]);
    fs.mkdirSync(path.dirname(h.journalPath), { recursive: true });
    // No `replaces`, as journaled by versions before it existed: still replayed.
    fs.writeFileSync(
      h.journalPath,
      JSON.stringify({
        label: "alice",
        tokens: {
          access: "recovered-access",
          refresh: "recovered-refresh",
          expires: NOW + 3_600_000,
        },
        writtenAt: NOW - 5_000,
      }),
    );

    const replayed = await h.manager.replayJournal();

    assert.equal(replayed, true);
    const stored = await h.accounts.getAccount("alice");
    assert.equal(stored?.oauth.refresh, "recovered-refresh");
    assert.equal(fs.existsSync(h.journalPath), false);
  });

  it("reports nothing to replay when no journal exists", async (t) => {
    const h = harness(t, [record("alice")]);
    assert.equal(await h.manager.replayJournal(), false);
  });

  it("keeps the lock held until the replayed tokens are committed", async (t) => {
    const h = harness(t, [record("alice")]);
    writePendingJournal(h.journalPath);
    const events: string[] = [];
    const originalUpdate = h.accounts.updateTokens.bind(h.accounts);
    h.accounts.updateTokens = async (label, tokens) => {
      events.push("commit-start");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const updated = await originalUpdate(label, tokens);
      events.push("commit-end");
      return updated;
    };

    const replay = h.manager.replayJournal();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Stands in for another OpenCode process contending for the same lock.
    const otherProcess = h.state.withLock(() => {
      events.push("other-process-lock");
    });
    await Promise.all([replay, otherProcess]);

    assert.deepEqual(events, ["commit-start", "commit-end", "other-process-lock"]);
  });

  it("refreshLabel uses a pending journal instead of spending the dead keychain token", async (t) => {
    const h = harness(t, [record("alice", { expires: NOW - 1 })], (token) => {
      if (token === "refresh-alice") throw new Error("Token refresh failed (400): invalid_grant");
      throw new Error(`unexpected refresh with ${token}`);
    });
    writePendingJournal(h.journalPath);

    const tokens = await h.manager.refreshLabel("alice");

    assert.equal(tokens.refresh, "recovered-refresh");
    assert.deepEqual(h.refreshCalls, []);
    assert.equal(fs.existsSync(h.journalPath), false);
  });

  it("sets aside a journal for an account that is no longer enrolled", async (t) => {
    const h = harness(t, [record("alice", { expires: NOW - 1 })]);
    writePendingJournal(h.journalPath, "removed");

    const tokens = await h.manager.refreshLabel("alice");

    assert.equal(tokens.refresh, "refresh-alice-v2");
    assert.equal(fs.existsSync(h.journalPath), false);
    const aside = setAsideJournals(h.journalPath);
    assert.equal(aside.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(aside[0]!, "utf8")).tokens.refresh, "recovered-refresh");
  });

  it("sets aside a crash journal instead of overwriting a re-enrolled account", async (t) => {
    const h = harness(t, [record("alice", { expires: NOW - 1 })]);
    const originalUpdate = h.accounts.updateTokens.bind(h.accounts);
    h.accounts.updateTokens = async () => {
      throw new Error("crashed before commit");
    };
    await assert.rejects(h.manager.refreshLabel("alice"), /crashed before commit/);
    h.accounts.updateTokens = originalUpdate;
    // Re-login and re-enroll before anything replays the journal.
    await h.accounts.putAccount(record("alice", { access: "access-new", refresh: "refresh-new" }));

    assert.equal(await h.manager.replayJournal(), false);

    assert.equal((await h.accounts.getAccount("alice"))?.oauth.refresh, "refresh-new");
    assert.equal(fs.existsSync(h.journalPath), false);
    assert.equal(setAsideJournals(h.journalPath).length, 1);
  });
});

function writePendingJournal(journalPath: string, label = "alice"): void {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.writeFileSync(
    journalPath,
    JSON.stringify({
      label,
      tokens: {
        access: "recovered-access",
        refresh: "recovered-refresh",
        expires: NOW + 3_600_000,
      },
      writtenAt: NOW - 5_000,
      replaces: `refresh-${label}`,
    }),
  );
}

function setAsideJournals(journalPath: string): string[] {
  const dir = path.dirname(journalPath);
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${path.basename(journalPath)}.`) && f.endsWith(".stale"))
    .map((f) => path.join(dir, f));
}

describe("rotation manager rotation", () => {
  it("a penalty applied after the switch keeps the new active account", async (t) => {
    const h = harness(t, [record("alice"), record("bob")]);
    await h.manager.acquire();
    await h.manager.acquire(new Set(["alice"]));
    assert.equal(h.state.load().activeLabel, "bob");

    await h.manager.applyDecision("alice", {
      action: "ROTATE_DISABLE",
      reason: "credential rejected",
      source: "status",
    });

    assert.equal(h.state.load().activeLabel, "bob");
    assert.equal(h.state.load().accounts.alice?.disabled, true);
  });

  it("rotates to the other account after a cooldown decision", async (t) => {
    const h = harness(t, [record("alice"), record("bob")]);

    const first = await h.manager.acquire();
    assert.equal(first.kind === "ok" && first.label, "alice");

    await h.manager.applyDecision("alice", {
      action: "ROTATE_COOLDOWN",
      until: NOW + 6 * 3_600_000,
      reason: "usage window exhausted",
      source: "retry-after",
    });

    const second = await h.manager.acquire();
    assert.equal(second.kind === "ok" && second.label, "bob");
    assert.equal(second.kind === "ok" && second.accessToken, "access-bob");
  });

  it("permanently excludes a disabled account", async (t) => {
    const h = harness(t, [record("alice"), record("bob")]);
    await h.manager.acquire();

    await h.manager.applyDecision("alice", {
      action: "ROTATE_DISABLE",
      reason: "account suspended",
      source: "body-hint",
    });

    const next = await h.manager.acquire();
    assert.equal(next.kind === "ok" && next.label, "bob");
    assert.equal(h.state.load().accounts.alice?.disabled, true);
  });

  it("falls through to another account when a refresh fails", async (t) => {
    const h = harness(t, [record("alice", { expires: NOW - 1 }), record("bob")], (token) => {
      if (token === "refresh-alice") throw new Error("invalid_grant");
      return {
        access: "unused",
        refresh: "unused",
        expires: NOW + 3_600_000,
      };
    });

    const result = await h.manager.acquire();

    assert.equal(result.kind === "ok" && result.label, "bob");
    assert.equal(h.state.load().accounts.alice?.disabled, true);
  });

  it("reports exhaustion with the earliest reset instead of hanging", async (t) => {
    const h = harness(t, [record("alice"), record("bob")]);
    await h.manager.acquire();

    await h.manager.applyDecision("alice", {
      action: "ROTATE_COOLDOWN",
      until: NOW + 7_200_000,
      reason: "exhausted",
      source: "retry-after",
    });
    await h.manager.applyDecision("bob", {
      action: "ROTATE_COOLDOWN",
      until: NOW + 3_600_000,
      reason: "exhausted",
      source: "retry-after",
    });

    const result = await h.manager.acquire();

    assert.equal(result.kind, "exhausted");
    if (result.kind !== "exhausted") return;
    assert.equal(result.info.earliestReset, NOW + 3_600_000);
    assert.deepEqual(
      result.info.cooling.map((c) => c.label),
      ["bob", "alice"],
    );
  });

  it("clears cooldown on success so the account returns to the pool", async (t) => {
    const h = harness(t, [record("alice"), record("bob")]);
    await h.manager.applyDecision("alice", {
      action: "ROTATE_COOLDOWN",
      until: NOW + 3_600_000,
      reason: "exhausted",
      source: "retry-after",
    });

    await h.manager.markSuccess("alice", NOW);

    assert.equal(h.state.load().accounts.alice?.cooldownUntil, null);
    assert.equal(h.state.load().accounts.alice?.failureCount, 0);
  });
});

describe("exhaustion messaging", () => {
  it("names the cooling accounts and when they return", () => {
    const message = describeExhaustion(
      {
        earliestReset: NOW + 3_600_000,
        cooling: [{ label: "bob", until: NOW + 3_600_000 }],
        disabled: ["alice"],
      },
      NOW,
    );

    // Single line on purpose: opencode renders session errors as a 5s toast
    // with a hardcoded duration, so anything longer is unreadable before it
    // disappears. The full breakdown belongs in the dashboard.
    assert.equal(message.split("\n").length, 1);
    assert.ok(message.length <= 80, `message too long for a toast: ${message.length}`);
    assert.match(message, /bob/, "names the account that frees up first");
    assert.match(message, /60m|1h/, "states when it frees up");
  });

  it("points at re-enrollment when every account is disabled", () => {
    const message = describeExhaustion(
      { earliestReset: null, cooling: [], disabled: ["alice", "bob"] },
      NOW,
    );

    assert.equal(message.split("\n").length, 1);
    assert.match(message, /2 accounts disabled/i);
    assert.match(message, /re-enroll|re-login/i);
  });

  it("keeps the minutes instead of rounding down to whole hours", () => {
    const message = describeExhaustion(
      { earliestReset: NOW + 119 * 60_000, cooling: [{ label: "bob", until: NOW + 119 * 60_000 }], disabled: [] },
      NOW,
    );
    assert.match(message, /1h 59m \(bob\)$/);
  });

  it("names every cooling account soonest first, each with its wait", () => {
    const message = describeExhaustion(
      {
        earliestReset: NOW + 3_600_000,
        cooling: [
          { label: "a", until: NOW + 5 * 3_600_000 },
          { label: "c", until: NOW + 167 * 3_600_000 },
          { label: "b", until: NOW + 3_600_000 },
        ],
        disabled: ["d"],
      },
      NOW,
    );
    assert.equal(message, "Claude pool exhausted — next account free in 1h (b), then a in 5h, c in 6d 23h; 1 disabled");
  });

  it("names at most four cooling accounts and counts the rest", () => {
    const cooling = ["a", "b", "c", "d", "e", "f"].map((label, i) => ({ label, until: NOW + (i + 1) * 60_000 }));
    const message = describeExhaustion({ earliestReset: NOW + 60_000, cooling, disabled: [] }, NOW);
    assert.equal(message, "Claude pool exhausted — next account free in 1m (a), then b in 2m, c in 3m, d in 4m, +2 more");
  });

  it("mentions disabled accounts alongside the cooling one", () => {
    const message = describeExhaustion(
      { earliestReset: NOW + 60_000, cooling: [{ label: "bob", until: NOW + 60_000 }], disabled: ["alice"] },
      NOW,
    );
    assert.match(message, /1m \(bob\); 1 disabled$/);
  });

  it("names a single disabled account and how to bring it back, within toast length", () => {
    const message = describeExhaustion({ earliestReset: null, cooling: [], disabled: ["alice"] }, NOW);
    assert.match(message, /"alice" disabled/);
    assert.match(message, /claude-pool enroll/);
    assert.ok(message.length <= 80, `message too long for a toast: ${message.length}`);
  });

  it("does not blame disabled accounts when none are disabled or cooling", () => {
    const message = describeExhaustion({ earliestReset: null, cooling: [], disabled: [] }, NOW);
    assert.doesNotMatch(message, /disabled|re-login/);
  });
});

describe("formatWait", () => {
  it("renders minutes, hours and days", () => {
    assert.equal(formatWait(0), "0m");
    assert.equal(formatWait(45 * 60_000), "45m");
    assert.equal(formatWait(60 * 60_000), "1h");
    assert.equal(formatWait(119 * 60_000), "1h 59m");
    assert.equal(formatWait(51 * 3_600_000), "2d 3h");
    assert.equal(formatWait(48 * 3_600_000), "2d");
  });
});

describe("disabled-account notification", () => {
  it("reports a credential missing from the keychain", async (t) => {
    const h = harness(t, [record("alice")]);
    await h.state.ensureAccount("ghost");
    await h.state.setActive("ghost");

    const result = await h.manager.acquire();

    assert.equal(result.kind === "ok" && result.label, "alice");
    assert.deepEqual(h.disabledEvents, ["ghost"]);
  });

  it("reports a rejected refresh but not a transient one", async (t) => {
    const rejected = harness(t, [record("alice", { expires: NOW - 1 })], () => {
      throw new Error("Token refresh failed (400): invalid_grant");
    });
    await rejected.manager.acquire();
    assert.deepEqual(rejected.disabledEvents, ["alice"]);

    const transient = harness(t, [record("alice", { expires: NOW - 1 })], () => {
      throw new Error("Token endpoint unreachable: request timed out");
    });
    await transient.manager.acquire();
    assert.deepEqual(transient.disabledEvents, []);
  });

  it("reports a ROTATE_DISABLE decision", async (t) => {
    const h = harness(t, [record("alice")]);
    await h.manager.applyDecision("alice", {
      action: "ROTATE_DISABLE",
      reason: "revoked",
      source: "status",
    });
    assert.deepEqual(h.disabledEvents, ["alice"]);
  });

  it("still disables the account when the listener throws", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-manager-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const state = createRotationStateStore({ path: path.join(root, "state.json"), lockPollMs: 1 });
    const manager = createRotationManager({
      accounts: createAccountStore(memoryBackend({ alice: JSON.stringify(record("alice")) })),
      state,
      clock: () => NOW,
      journalPath: path.join(root, "journal.json"),
      refreshFn: () => {
        throw new Error("unused");
      },
      mirrorFn: async () => {},
      onAccountDisabled: () => {
        throw new Error("toast failed");
      },
    });

    await manager.applyDecision("alice", { action: "ROTATE_DISABLE", reason: "revoked", source: "status" });

    assert.equal(state.load().accounts.alice?.disabled, true);
  });
});
