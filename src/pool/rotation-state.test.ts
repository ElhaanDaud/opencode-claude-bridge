import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import {
  createRotationStateStore,
  defaultLockPath,
  defaultRotationState,
  defaultStatePath,
} from "./rotation-state.js";
import { ROTATION_STATE_VERSION } from "./types.js";
import type { RotationState } from "./types.js";

function tempStatePath(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rotation-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "state", "rotation-state.json");
}

function populatedState(): RotationState {
  return {
    version: ROTATION_STATE_VERSION,
    activeLabel: "primary",
    accounts: {
      primary: {
        cooldownUntil: 12_000,
        disabled: false,
        failureCount: 2,
        lastReason: "usage window exhausted",
        updatedAt: 1_000,
      },
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("rotation state persistence", () => {
  it("round-trips a saved state exactly", (t) => {
    const store = createRotationStateStore({ path: tempStatePath(t) });
    const expected = populatedState();

    store.save(expected);

    assert.deepEqual(store.load(), expected);
  });

  it("returns the default state when the file is missing", (t) => {
    const store = createRotationStateStore({ path: tempStatePath(t) });

    assert.deepEqual(store.load(), defaultRotationState());
  });

  it("returns the default state for malformed JSON without throwing", (t) => {
    const statePath = tempStatePath(t);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{not-json", { mode: 0o600 });
    const store = createRotationStateStore({ path: statePath });
    const originalConsoleError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    t.after(() => {
      console.error = originalConsoleError;
    });

    assert.doesNotThrow(() => store.load());
    assert.deepEqual(store.load(), defaultRotationState());
    assert.equal(errors.length, 2);
    assert.match(String(errors[0]?.[0]), /malformed|parse|corrupt/i);
  });

  it("returns the default state for a version mismatch", (t) => {
    const statePath = tempStatePath(t);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({ ...populatedState(), version: 999 }),
      { mode: 0o600 },
    );
    const store = createRotationStateStore({ path: statePath });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    t.after(() => {
      console.error = originalConsoleError;
    });

    assert.deepEqual(store.load(), defaultRotationState());
  });

  it("preserves the original file and removes temp files after a failed save", (t) => {
    const statePath = tempStatePath(t);
    const store = createRotationStateStore({ path: statePath });
    const original = populatedState();
    store.save(original);
    const parent = path.dirname(statePath);

    fs.chmodSync(parent, 0o500);
    try {
      assert.throws(() =>
        store.save({ ...original, activeLabel: "replacement" }),
      );
    } finally {
      fs.chmodSync(parent, 0o700);
    }

    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), original);
    assert.deepEqual(fs.readdirSync(parent), [path.basename(statePath)]);
  });

  it("creates the state file as 0600 and its parent directory as 0700", (t) => {
    const statePath = tempStatePath(t);
    const store = createRotationStateStore({ path: statePath });

    store.save(defaultRotationState());

    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(statePath)).mode & 0o777, 0o700);
  });
});

describe("rotation state locking", () => {
  it("serializes concurrent read-modify-write critical sections", async (t) => {
    const statePath = tempStatePath(t);
    const first = createRotationStateStore({ path: statePath, lockPollMs: 5 });
    const second = createRotationStateStore({ path: statePath, lockPollMs: 5 });
    await first.ensureAccount("shared");
    let firstEntered = false;
    let secondEntered = false;

    const firstRun = first.withLock(async (state) => {
      firstEntered = true;
      const previous = state.accounts.shared?.failureCount ?? 0;
      await delay(40);
      assert.equal(secondEntered, false);
      state.accounts.shared!.failureCount = previous + 1;
    });
    while (!firstEntered) await delay(1);
    const secondRun = second.withLock(async (state) => {
      secondEntered = true;
      const previous = state.accounts.shared?.failureCount ?? 0;
      await delay(5);
      state.accounts.shared!.failureCount = previous + 1;
    });

    await Promise.all([firstRun, secondRun]);

    assert.equal(secondEntered, true);
    assert.equal(first.load().accounts.shared?.failureCount, 2);
  });

  it("reclaims a stale lock and proceeds", async (t) => {
    const statePath = tempStatePath(t);
    const parent = path.dirname(statePath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      `${statePath}.lock`,
      JSON.stringify({ pid: 123, hostname: "crashed-host", acquiredAt: 1_000 }),
      { mode: 0o600 },
    );
    const store = createRotationStateStore({
      path: statePath,
      clock: () => 40_001,
      staleLockMs: 30_000,
      lockPollMs: 1,
    });

    let entered = false;
    await store.withLock(() => {
      entered = true;
    });

    assert.equal(entered, true);
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
  });

  it("never reclaims an old lock whose holder is alive under another user", async (t) => {
    const statePath = tempStatePath(t);
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    // pid 1 always exists; signalling it as a normal user fails with EPERM.
    fs.writeFileSync(
      `${statePath}.lock`,
      JSON.stringify({ pid: 1, hostname: os.hostname(), acquiredAt: 1_000, nonce: "held" }),
      { mode: 0o600 },
    );
    const store = createRotationStateStore({
      path: statePath,
      clock: () => 40_001,
      staleLockMs: 30_000,
      lockPollMs: 1,
      lockTimeoutMs: 0,
    });

    await assert.rejects(store.withLock(() => {}), /timed out/);
    assert.equal(JSON.parse(fs.readFileSync(`${statePath}.lock`, "utf8")).nonce, "held");
  });

  it("releases the lock and propagates when the callback throws", async (t) => {
    const statePath = tempStatePath(t);
    const store = createRotationStateStore({ path: statePath, lockPollMs: 1 });

    await assert.rejects(
      store.withLock(() => {
        throw new Error("callback failed");
      }),
      /callback failed/,
    );

    let entered = false;
    await store.withLock(() => {
      entered = true;
    });
    assert.equal(entered, true);
  });
});

describe("rotation state mutators", () => {
  it("tracks cooldown failures and resets them on success", async (t) => {
    let now = 5_000;
    const store = createRotationStateStore({
      path: tempStatePath(t),
      clock: () => now,
    });

    await store.markCooldown("primary", 10_000, "first limit");
    now = 6_000;
    await store.markCooldown("primary", 11_000, "second limit");

    assert.deepEqual(store.load().accounts.primary, {
      cooldownUntil: 11_000,
      disabled: false,
      failureCount: 2,
      lastReason: "second limit",
      updatedAt: 6_000,
    });

    now = 7_000;
    await store.markSuccess("primary");
    assert.deepEqual(store.load().accounts.primary, {
      cooldownUntil: null,
      disabled: false,
      failureCount: 0,
      lastReason: "second limit",
      updatedAt: 7_000,
    });
  });

  it("ensureAccount is idempotent and does not clobber existing state", async (t) => {
    const store = createRotationStateStore({
      path: tempStatePath(t),
      clock: () => 5_000,
    });
    await store.markCooldown("primary", 10_000, "limited");
    const before = store.load().accounts.primary;

    await store.ensureAccount("primary");
    await store.ensureAccount("primary");

    assert.deepEqual(store.load().accounts.primary, before);
    assert.deepEqual(Object.keys(store.load().accounts), ["primary"]);
  });

  it("persists the active label for a fresh store instance", async (t) => {
    const statePath = tempStatePath(t);
    const store = createRotationStateStore({ path: statePath });

    await store.setActive("secondary");

    assert.equal(createRotationStateStore({ path: statePath }).load().activeLabel, "secondary");
  });
});

describe("shared lock across relocated state files", () => {
  it("serialises stores whose state files differ but whose lock is shared", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-lock-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // The lock lives in a folder that does not exist yet.
    const lockPath = path.join(root, "home", "data", "rotation-state.json.lock");
    const a = createRotationStateStore({ path: path.join(root, "a", "state.json"), lockPath, lockPollMs: 1 });
    const b = createRotationStateStore({ path: path.join(root, "b", "state.json"), lockPath, lockPollMs: 1 });

    const events: string[] = [];
    const first = a.withLock(async () => {
      events.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 60));
      events.push("a-end");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = b.withLock(() => {
      events.push("b");
    });
    await Promise.all([first, second]);

    assert.deepEqual(events, ["a-start", "a-end", "b"]);
    assert.equal(fs.existsSync(lockPath), false);
  });

  it("keeps the default lock with the credentials when the state file is relocated", () => {
    const saved = process.env.CLAUDE_POOL_STATE_PATH;
    process.env.CLAUDE_POOL_STATE_PATH = "/tmp/elsewhere/state.json";
    try {
      assert.equal(defaultStatePath(), "/tmp/elsewhere/state.json");
      assert.equal(
        defaultLockPath(),
        path.join(os.homedir(), ".local", "share", "opencode-claude-bridge", "rotation-state.json.lock"),
      );
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_POOL_STATE_PATH;
      else process.env.CLAUDE_POOL_STATE_PATH = saved;
    }
  });
});
