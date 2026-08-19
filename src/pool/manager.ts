/**
 * Rotation manager — the orchestrator.
 *
 * Ties together the cold credential store (keychain), the hot rotation state
 * (cooldowns), the rate-limit classifier, and the selection policy.
 *
 * THE REFRESH-TOKEN SAFETY PROTOCOL
 * ---------------------------------
 * Anthropic's OAuth refresh returns a NEW refresh token and invalidates the old
 * one. That creates a window in which the server has already burned our stored
 * token but we have not yet persisted its replacement. A crash inside that
 * window permanently bricks the account — the user must log in again.
 *
 * We narrow that window with journal-then-commit:
 *
 *   1. acquire the cross-process lock (also collapses concurrent refreshes)
 *   2. call the token endpoint
 *   3. fsync the new tokens to a journal file        <- crash-safe from here
 *   4. commit them to the keychain (authoritative)
 *   5. delete the journal
 *   6. mirror to opencode's single `anthropic` slot
 *
 * A journal found at startup means we died between 3 and 5, so we replay it.
 * The irreducible risk is a crash between 2 and 3, which is microseconds wide.
 *
 * SOURCE OF TRUTH
 * ---------------
 * The pool is authoritative. opencode's `auth.json` holds only ONE anthropic
 * entry, so we treat it as a derived cache that mirrors whichever account is
 * currently active.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

import { classify } from "./classifier.js";
import { selectNext } from "./selection.js";
import type { RotationStateStore } from "./rotation-state.js";
import type { createAccountStore } from "./secret-store.js";
import type {
  AccountRecord,
  ClassifyInput,
  Clock,
  PoolOAuthTokens,
  RotationDecision,
} from "./types.js";

export type AccountStore = ReturnType<typeof createAccountStore>;

/** Refresh a token pair. Sync, mirroring oauth.ts's curl-based refreshTokens. */
export type RefreshFn = (refreshToken: string) => PoolOAuthTokens;

/** Mirror the active account into opencode's single `anthropic` auth slot. */
export type MirrorFn = (tokens: PoolOAuthTokens) => Promise<void>;

export interface ManagerOptions {
  accounts: AccountStore;
  state: RotationStateStore;
  refreshFn: RefreshFn;
  mirrorFn: MirrorFn;
  clock?: Clock;
  journalPath?: string;
  /** Refresh when the access token expires within this window. */
  expiryBufferMs?: number;
}

interface JournalEntry {
  label: string;
  tokens: PoolOAuthTokens;
  writtenAt: number;
}

export interface ExhaustionInfo {
  earliestReset: number | null;
  cooling: Array<{ label: string; until: number }>;
  disabled: string[];
}

export type AcquireResult =
  | { kind: "ok"; label: string; accessToken: string }
  | { kind: "exhausted"; info: ExhaustionInfo };

/** Cooldown applied when a refresh fails for a reason that may resolve itself. */
export const TRANSIENT_REFRESH_COOLDOWN_MS = 60_000;

/**
 * Distinguish "this credential is no longer valid" from "the token endpoint
 * was unreachable". refreshTokens throws `Token refresh failed (<status>): …`,
 * so both the HTTP status and the OAuth error code are available in the text.
 */
export function isCredentialRejected(detail: string): boolean {
  return /invalid_grant|invalid_client|unauthorized_client|access_denied|\((?:400|401|403)\)/i.test(
    detail,
  );
}

export function defaultJournalPath(): string {
  return path.join(
    os.homedir(),
    ".local",
    "share",
    "opencode-claude-bridge",
    "refresh-journal.json",
  );
}

/** Human-readable fail-fast message naming who is cold and when they return. */
export function describeExhaustion(info: ExhaustionInfo, now: number): string {
  const parts: string[] = ["All Claude accounts in the pool are unavailable."];

  if (info.cooling.length > 0) {
    const list = info.cooling
      .map((c) => {
        const mins = Math.max(0, Math.ceil((c.until - now) / 60_000));
        return `${c.label} (available in ~${mins}m, at ${new Date(c.until).toISOString()})`;
      })
      .join(", ");
    parts.push(`Cooling down: ${list}.`);
  }

  if (info.disabled.length > 0) {
    parts.push(
      `Disabled (needs re-authentication): ${info.disabled.join(", ")}.`,
    );
  }

  if (info.earliestReset !== null) {
    parts.push(
      `Earliest availability: ${new Date(info.earliestReset).toISOString()}.`,
    );
  } else {
    parts.push("No account will recover automatically; re-enroll or re-login.");
  }

  return parts.join(" ");
}

export function createRotationManager(opts: ManagerOptions) {
  const { accounts, state, refreshFn, mirrorFn } = opts;
  const clock: Clock = opts.clock ?? (() => Date.now());
  const journalPath = opts.journalPath ?? defaultJournalPath();
  const expiryBufferMs = opts.expiryBufferMs ?? 60_000;

  /** Collapses concurrent in-process refreshes of the same account. */
  const inFlight = new Map<string, Promise<PoolOAuthTokens>>();

  // ── Journal ───────────────────────────────────────────────────────

  function writeJournal(entry: JournalEntry): void {
    const dir = path.dirname(journalPath);
    const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (created) fs.chmodSync(dir, 0o700);

    const tmp = `${journalPath}.${randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(entry));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, journalPath);
  }

  function clearJournal(): void {
    try { fs.rmSync(journalPath, { force: true }); } catch { /* best effort */ }
  }

  function readJournal(): JournalEntry | null {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(journalPath, "utf8"),
      ) as JournalEntry;
      if (!parsed?.label || !parsed?.tokens?.refresh) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Commit a journal left behind by a process that died after refreshing but
   * before persisting. Without this, those tokens — the only valid ones,
   * because the server already invalidated their predecessors — would be lost.
   */
  async function replayJournal(): Promise<boolean> {
    const entry = readJournal();
    if (!entry) return false;
    try {
      await accounts.updateTokens(entry.label, entry.tokens);
      clearJournal();
      console.error(
        `[claude-pool] replayed pending refresh for "${entry.label}" from journal`,
      );
      return true;
    } catch (err) {
      console.error(
        `[claude-pool] failed to replay refresh journal for "${entry.label}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  // ── Enrollment / activation ───────────────────────────────────────

  async function listLabels(): Promise<string[]> {
    return (await accounts.listAccounts()).map((a) => a.label);
  }

  /**
   * The pool is active only once the user has enrolled at least one account.
   * With none enrolled we stay completely out of the way and the plugin's
   * original single-account behaviour is preserved byte for byte.
   */
  async function isActive(): Promise<boolean> {
    return (await listLabels()).length > 0;
  }

  /** Register every enrolled account in the rotation state (idempotent). */
  async function sync(): Promise<void> {
    for (const label of await listLabels()) {
      await state.ensureAccount(label);
    }
  }

  // ── Token acquisition ─────────────────────────────────────────────

  function isFresh(tokens: PoolOAuthTokens, now: number): boolean {
    return Boolean(tokens.access) && tokens.expires > now + expiryBufferMs;
  }

  /**
   * Refresh one account. The lock makes this safe across processes; the
   * in-flight map collapses duplicates within this process.
   */
  async function refreshLabel(label: string): Promise<PoolOAuthTokens> {
    const existing = inFlight.get(label);
    if (existing) return existing;

    const task = (async (): Promise<PoolOAuthTokens> => {
      return state.withLock(async () => {
        // Another process may have refreshed while we waited for the lock.
        // Re-read inside the critical section before burning our token.
        const current = await accounts.getAccount(label);
        if (!current) throw new Error(`Account "${label}" is not enrolled`);
        if (isFresh(current.oauth, clock())) return current.oauth;

        const fresh = refreshFn(current.oauth.refresh);

        // Journal BEFORE committing: the server has already invalidated the
        // old refresh token, so these are now the only usable credentials.
        writeJournal({ label, tokens: fresh, writtenAt: clock() });
        await accounts.updateTokens(label, fresh);
        clearJournal();

        return fresh;
      });
    })();

    inFlight.set(label, task);
    try {
      return await task;
    } finally {
      inFlight.delete(label);
    }
  }

  /** Mirror an account's tokens into opencode's single anthropic slot. */
  async function mirror(record: AccountRecord): Promise<void> {
    await mirrorFn(record.oauth);
  }

  /**
   * Pick an account and return a usable access token, refreshing if needed.
   * Returns `exhausted` (never throws) when every account is cold, so the
   * caller can fail fast with a precise, actionable message.
   */
  async function acquire(): Promise<AcquireResult> {
    await replayJournal();
    await sync();

    const now = clock();
    const selection = selectNext(state.load(), now);
    if (selection.kind === "exhausted") {
      return {
        kind: "exhausted",
        info: {
          earliestReset: selection.earliestReset,
          cooling: selection.cooling,
          disabled: selection.disabled,
        },
      };
    }

    const label = selection.label;
    let record = await accounts.getAccount(label);
    if (!record) {
      // Enrolled in state but missing from the keychain: disable rather than
      // spin, so selection moves on instead of picking it again.
      await state.markDisabled(label, "credentials missing from keychain");
      return acquire();
    }

    if (!isFresh(record.oauth, now)) {
      try {
        const fresh = await refreshLabel(label);
        record = { ...record, oauth: fresh };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        // Only a rejected credential justifies permanent exclusion. A network
        // blip or a 5xx from the token endpoint must cool the account down
        // instead, or one transient outage disables every account in turn and
        // wedges the pool with no automatic recovery.
        if (isCredentialRejected(detail)) {
          await state.markDisabled(label, `refresh rejected: ${detail}`);
        } else {
          await state.markCooldown(
            label,
            clock() + TRANSIENT_REFRESH_COOLDOWN_MS,
            `refresh failed: ${detail}`,
          );
        }
        return acquire();
      }
    }

    if (state.load().activeLabel !== label) {
      await state.setActive(label);
    }
    await mirror(record);

    return { kind: "ok", label, accessToken: record.oauth.access };
  }

  /**
   * Apply a classifier decision to the pool.
   *
   * NOTE: only meaningful BEFORE the response body has been read. Once SSE
   * streaming has begun, a second stream's message ids and content-block
   * indices cannot be spliced into the first, so callers must pass such
   * responses through untouched rather than rotating.
   */
  async function applyDecision(
    label: string,
    decision: RotationDecision,
  ): Promise<void> {
    switch (decision.action) {
      case "ROTATE_COOLDOWN":
        await state.markCooldown(
          label,
          decision.until ?? clock(),
          decision.reason,
        );
        await state.setActive(null);
        break;
      case "ROTATE_DISABLE":
        await state.markDisabled(label, decision.reason);
        await state.setActive(null);
        break;
      case "RETRY_SAME":
      case "PASS_THROUGH":
        break;
    }
  }

  return {
    isActive,
    sync,
    acquire,
    refreshLabel,
    applyDecision,
    replayJournal,
    listLabels,

    /** Classify a failed response without mutating anything. */
    classifyResponse(input: ClassifyInput): RotationDecision {
      return classify(input);
    },

    async markSuccess(label: string): Promise<void> {
      await state.markSuccess(label);
    },

    async exhaustionInfo(): Promise<ExhaustionInfo> {
      const selection = selectNext(state.load(), clock());
      if (selection.kind === "selected") {
        return { earliestReset: null, cooling: [], disabled: [] };
      }
      return {
        earliestReset: selection.earliestReset,
        cooling: selection.cooling,
        disabled: selection.disabled,
      };
    },

    describeExhaustion(info: ExhaustionInfo): string {
      return describeExhaustion(info, clock());
    },
  };
}

export type RotationManager = ReturnType<typeof createRotationManager>;
