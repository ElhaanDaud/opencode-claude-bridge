import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { createRotationManager, describeExhaustion } from "./manager.js";
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
  journalPath: string;
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
  const state = createRotationStateStore({
    path: path.join(root, "rotation-state.json"),
    clock,
    lockPollMs: 1,
  });
  const journalPath = path.join(root, "refresh-journal.json");

  const refreshCalls: string[] = [];
  const mirrored: PoolOAuthTokens[] = [];

  const manager = createRotationManager({
    accounts,
    state,
    clock,
    journalPath,
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
    journalPath,
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
});

describe("rotation manager journal replay", () => {
  it("commits a journal left behind by a crashed process", async (t) => {
    const h = harness(t, [record("alice")]);
    fs.mkdirSync(path.dirname(h.journalPath), { recursive: true });
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
});

describe("rotation manager rotation", () => {
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

    await h.manager.markSuccess("alice");

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

    assert.match(message, /bob/);
    assert.match(message, /alice/);
    assert.match(message, /60m/);
    assert.match(message, /re-authentication/i);
  });

  it("says recovery is impossible when every account is disabled", () => {
    const message = describeExhaustion(
      { earliestReset: null, cooling: [], disabled: ["alice", "bob"] },
      NOW,
    );

    assert.match(message, /no account will recover automatically/i);
  });
});
