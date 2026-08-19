/**
 * Hot, mutable rotation state: which account is active, plus per-account
 * cooldown / disabled / failure bookkeeping. Contains NO secret material —
 * credentials live in the separate keychain-backed store.
 *
 * Two properties here are load-bearing:
 *
 *  1. ATOMIC WRITES. State is written to a temp file in the same directory,
 *     fsync'd, then renamed over the target. A crash mid-write leaves the
 *     previous state fully intact rather than a truncated file.
 *
 *  2. A CROSS-PROCESS LOCK. Multiple opencode processes — and many agents
 *     within one process — share this file. Beyond protecting state, this same
 *     lock guards the token-refresh critical section in the manager:
 *     Anthropic's OAuth refresh rotates the refresh token and invalidates the
 *     old one, so two concurrent refreshes of one account can permanently
 *     brick it. This lock is what makes that impossible.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ROTATION_STATE_VERSION } from "./types.js";
import type { AccountState, Clock, RotationState } from "./types.js";

export interface RotationStateStoreOptions {
  path: string;
  clock?: Clock;
  /** Age after which a lockfile is presumed abandoned by a crashed process. */
  staleLockMs?: number;
  /** Poll interval while waiting on a contended lock. */
  lockPollMs?: number;
  /** Give up acquiring the lock after this long. */
  lockTimeoutMs?: number;
}

interface LockPayload {
  pid: number;
  hostname: string;
  acquiredAt: number;
  /** Distinguishes our lock from a replacement, for safe reclaim and release. */
  nonce: string;
}

export function defaultRotationState(): RotationState {
  return { version: ROTATION_STATE_VERSION, activeLabel: null, accounts: {} };
}

export function defaultStatePath(): string {
  return path.join(
    os.homedir(),
    ".local",
    "share",
    "opencode-claude-bridge",
    "rotation-state.json",
  );
}

function defaultAccountState(now: number): AccountState {
  return {
    cooldownUntil: null,
    disabled: false,
    failureCount: 0,
    lastReason: null,
    updatedAt: now,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRotationStateStore(opts: RotationStateStoreOptions) {
  const statePath = opts.path;
  const lockPath = `${statePath}.lock`;
  const clock: Clock = opts.clock ?? (() => Date.now());
  // Must comfortably exceed the worst-case guarded operation. A token refresh
  // runs up to 3 curl attempts at 30s each plus backoff (~100s), so a 30s
  // threshold would declare a healthy, actively-refreshing holder "stale".
  const staleLockMs = opts.staleLockMs ?? 180_000;
  const lockPollMs = opts.lockPollMs ?? 50;
  const lockTimeoutMs = opts.lockTimeoutMs ?? 10_000;

  /**
   * Create the parent directory if absent. We only chmod when we actually
   * created it: an unconditional chmod would silently repair permissions an
   * operator deliberately set, masking a real failure.
   */
  function ensureDir(): void {
    const dir = path.dirname(statePath);
    const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (created) fs.chmodSync(dir, 0o700);
  }

  function load(): RotationState {
    let raw: string;
    try {
      raw = fs.readFileSync(statePath, "utf8");
    } catch {
      // Missing or unreadable simply means a fresh pool, not an error.
      return defaultRotationState();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(
        `[claude-pool] rotation state at ${statePath} is malformed JSON; falling back to defaults`,
      );
      return defaultRotationState();
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as RotationState).version !== ROTATION_STATE_VERSION
    ) {
      console.error(
        `[claude-pool] rotation state at ${statePath} has an unsupported version; falling back to defaults`,
      );
      return defaultRotationState();
    }

    const state = parsed as RotationState;
    return {
      version: state.version,
      activeLabel: state.activeLabel ?? null,
      accounts: state.accounts ?? {},
    };
  }

  function save(state: RotationState): void {
    ensureDir();
    const tmp = `${statePath}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify(state, null, 2));
      // fsync before rename: rename atomically swaps the directory entry, but
      // without fsync the contents may not have reached disk yet.
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, statePath);
      fs.chmodSync(statePath, 0o600);
    } catch (err) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
      // The failed-write path is exactly where stray temp files would
      // accumulate unnoticed, so clean up before rethrowing.
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
      throw err;
    }
  }

  function readLock(): LockPayload | null {
    try {
      return JSON.parse(fs.readFileSync(lockPath, "utf8")) as LockPayload;
    } catch {
      return null;
    }
  }

  /** Atomically create the lockfile. Returns our nonce, or null if held. */
  function tryCreateLock(): string | null {
    const nonce = randomUUID();
    const payload: LockPayload = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: clock(),
      nonce,
    };
    let fd: number;
    try {
      // "wx" fails if the file exists — atomic on POSIX, no dependency needed.
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch {
      return null;
    }
    try {
      fs.writeSync(fd, JSON.stringify(payload));
      fs.fsyncSync(fd);
    } finally {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    return nonce;
  }

  /**
   * Reclaim a lock abandoned by a crashed process.
   *
   * The naive approach — "if it looks stale, unlink it" — has a real race: two
   * waiters both see the stale lock, the first reclaims and acquires, then the
   * second deletes that *fresh* lock, leaving two holders. We guard by renaming
   * the lockfile aside and verifying the bytes we moved carry the same nonce we
   * observed. If they differ, someone already reclaimed it, so we put it back
   * and keep waiting.
   */
  /**
   * Age alone is not a crash signal — it is a timeout, and the guarded refresh
   * can legitimately outlast it. Reclaiming a live holder lets two processes
   * refresh one account concurrently, which rotates its refresh token twice and
   * permanently bricks it. So on this host we require proof the process is
   * actually gone. A lock from another host is unverifiable, so it falls back
   * to the age heuristic.
   */
  function holderIsGone(payload: LockPayload): boolean {
    if (payload.hostname !== os.hostname()) return true;
    try {
      process.kill(payload.pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  function tryReclaimStale(observed: LockPayload): boolean {
    const aside = `${lockPath}.${randomUUID()}.stale`;
    try {
      fs.renameSync(lockPath, aside);
    } catch {
      return false; // Someone else got there first.
    }

    let moved: LockPayload | null = null;
    try {
      moved = JSON.parse(fs.readFileSync(aside, "utf8")) as LockPayload;
    } catch {
      moved = null;
    }

    if (moved && moved.nonce !== observed.nonce) {
      // We moved a lock that had already been replaced — restore it.
      try { fs.renameSync(aside, lockPath); } catch { /* best effort */ }
      return false;
    }

    try { fs.rmSync(aside, { force: true }); } catch { /* best effort */ }
    return true;
  }

  async function acquire(): Promise<string> {
    ensureDir();
    const deadline = clock() + lockTimeoutMs;

    for (;;) {
      const nonce = tryCreateLock();
      if (nonce) return nonce;

      const existing = readLock();

      // An unparseable lockfile is usually a torn write, which must not wedge
      // the pool forever. But it is also what a lock looks like in the instant
      // between being created and being written, so removing it on sight would
      // evict a holder that is mid-acquisition. Only discard it once it is old
      // enough that no in-progress acquisition could still be responsible.
      if (!existing) {
        let age = Infinity;
        try {
          age = clock() - fs.statSync(lockPath).mtimeMs;
        } catch {
          continue;
        }
        if (age > staleLockMs) {
          try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
        } else {
          await sleep(lockPollMs);
        }
        continue;
      }

      if (clock() - existing.acquiredAt > staleLockMs && holderIsGone(existing)) {
        if (tryReclaimStale(existing)) {
          const reclaimed = tryCreateLock();
          if (reclaimed) return reclaimed;
        }
        continue;
      }

      if (clock() >= deadline) {
        throw new Error(
          `[claude-pool] timed out after ${lockTimeoutMs}ms waiting for the rotation lock at ${lockPath} ` +
            `(held by pid ${existing.pid} on ${existing.hostname})`,
        );
      }

      await sleep(lockPollMs);
    }
  }

  function release(nonce: string): void {
    // Only release a lock we still own. If ours was reclaimed from under us,
    // deleting it would evict whoever legitimately holds it now.
    const current = readLock();
    if (current && current.nonce !== nonce) return;
    try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
  }

  /**
   * Run `fn` inside the cross-process lock. State is loaded INSIDE the lock and
   * handed to `fn`; whatever `fn` mutates is persisted once `fn` resolves.
   * If `fn` throws, nothing is persisted but the lock is still released.
   */
  async function withLock<T>(
    fn: (state: RotationState) => T | Promise<T>,
  ): Promise<T> {
    const nonce = await acquire();
    try {
      const state = load();
      const result = await fn(state);
      save(state);
      return result;
    } finally {
      release(nonce);
    }
  }

  async function mutateAccount(
    label: string,
    mutate: (account: AccountState, now: number) => void,
  ): Promise<void> {
    await withLock((state) => {
      const now = clock();
      if (!state.accounts[label]) state.accounts[label] = defaultAccountState(now);
      mutate(state.accounts[label]!, now);
    });
  }

  return {
    load,
    save,
    withLock,

    async setActive(label: string | null): Promise<void> {
      await withLock((state) => {
        state.activeLabel = label;
      });
    },

    async ensureAccount(label: string): Promise<void> {
      await withLock((state) => {
        if (!state.accounts[label]) {
          state.accounts[label] = defaultAccountState(clock());
        }
      });
    },

    async markCooldown(label: string, until: number, reason: string): Promise<void> {
      await mutateAccount(label, (account, now) => {
        account.cooldownUntil = until;
        account.failureCount += 1;
        account.lastReason = reason;
        account.updatedAt = now;
      });
    },

    async markDisabled(label: string, reason: string): Promise<void> {
      await mutateAccount(label, (account, now) => {
        account.disabled = true;
        account.lastReason = reason;
        account.updatedAt = now;
      });
    },

    async markSuccess(label: string): Promise<void> {
      await mutateAccount(label, (account, now) => {
        account.cooldownUntil = null;
        account.failureCount = 0;
        account.updatedAt = now;
      });
    },
  };
}

export type RotationStateStore = ReturnType<typeof createRotationStateStore>;
