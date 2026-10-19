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
import { LockTimeoutError } from "./rotation-state.js";
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

/**
 * Refresh a token pair.
 *
 * May be sync or async. Prefer async: a synchronous refresh blocks the event
 * loop for the whole round trip, stalling every session in the process.
 */
export type RefreshFn = (
  refreshToken: string,
) => PoolOAuthTokens | Promise<PoolOAuthTokens>;

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
  /** Called after an account is disabled. Must not throw; errors are swallowed. */
  onAccountDisabled?: (label: string, reason: string) => void;
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
  // OAuth error codes are unambiguous wherever they appear.
  if (/\b(?:invalid_grant|invalid_client|unauthorized_client|access_denied)\b/i.test(detail)) {
    return true;
  }
  // A bare status must come from OUR message prefix, not from anywhere in the
  // text. Matching loosely meant a gateway body containing "(403)" — or an
  // incidental "(401)" in a network error — permanently disabled a healthy
  // account, and disabling requires manual operator action to undo.
  return /^Token refresh failed \((?:400|401|403)\)/i.test(detail.trim());
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

/**
 * One-line fail-fast message.
 *
 * Deliberately terse: opencode renders session errors as a 5-second toast over
 * the prompt area, with the duration hardcoded at its call site, so a
 * multi-sentence message is unreadable before it vanishes. The per-account
 * breakdown lives in `claude-pool dashboard`, which is where someone can
 * actually study it.
 */
export function describeExhaustion(info: ExhaustionInfo, now: number): string {
  const disabled = info.disabled.length;
  if (info.earliestReset !== null) {
    const soonest = info.cooling.reduce<{ label: string; until: number } | null>(
      (best, candidate) => (best === null || candidate.until < best.until ? candidate : best),
      null,
    );
    const who = soonest ? ` (${soonest.label})` : "";
    const alsoDisabled = disabled > 0 ? `; ${disabled} disabled` : "";
    return `Claude pool exhausted — next account free in ${formatWait(info.earliestReset - now)}${who}${alsoDisabled}`;
  }
  if (disabled === 0) {
    // Reachable when this request tried every account but none is cooling or disabled.
    return "Claude pool exhausted — every account failed this request";
  }
  if (disabled === 1) {
    return `Claude pool exhausted — "${info.disabled[0]}" disabled; re-login, then claude-pool enroll`;
  }
  return `Claude pool exhausted — ${disabled} accounts disabled; re-login and re-enroll each`;
}

export function formatWait(ms: number): string {
  const mins = Math.max(0, Math.ceil(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${Math.floor(hours / 24)}d`;
}

export function createRotationManager(opts: ManagerOptions) {
  const { accounts, state, refreshFn, mirrorFn } = opts;
  const clock: Clock = opts.clock ?? (() => Date.now());
  const journalPath = opts.journalPath ?? defaultJournalPath();
  const expiryBufferMs = opts.expiryBufferMs ?? 60_000;

  async function disable(label: string, reason: string): Promise<void> {
    await state.markDisabled(label, reason);
    try {
      opts.onAccountDisabled?.(label, reason);
    } catch {
      // A notification failure must not undo or abort the state change.
    }
  }

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
  // Caller must hold the lock, or another process can spend the dead keychain token.
  async function commitPendingJournalLocked(): Promise<JournalEntry | null> {
    const entry = readJournal();
    if (!entry) return null;
    await accounts.updateTokens(entry.label, entry.tokens);
    clearJournal();
    console.error(
      `[claude-pool] replayed pending refresh for "${entry.label}" from journal`,
    );
    return entry;
  }

  async function replayJournal(): Promise<boolean> {
    // Cheap pre-check so the common case (no journal) costs no lock.
    if (!readJournal()) return false;
    try {
      return (await state.withLock(commitPendingJournalLocked)) !== null;
    } catch (err) {
      console.error(
        `[claude-pool] failed to replay refresh journal: ${
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
        // Callers may reach this without going through acquire()'s journal replay.
        await commitPendingJournalLocked();
        // Another process may have refreshed while we waited for the lock.
        // Re-read inside the critical section before burning our token.
        const current = await accounts.getAccount(label);
        if (!current) throw new Error(`Account "${label}" is not enrolled`);
        if (isFresh(current.oauth, clock())) return current.oauth;

        const fresh = await refreshFn(current.oauth.refresh);

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
   * Returns `exhausted` when every account is cold, so the caller can fail
   * fast with a precise, actionable message. Throws LockTimeoutError only when
   * the lock stays busy and no other account is usable.
   */
  async function acquire(exclude?: ReadonlySet<string>): Promise<AcquireResult> {
    await replayJournal();
    await sync();

    const now = clock();
    const selection = selectNext(state.load(), now, exclude);
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
    let record: AccountRecord | null;
    try {
      record = await accounts.getAccount(label);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await state.markCooldown(label, clock() + TRANSIENT_REFRESH_COOLDOWN_MS, detail);
      return acquire(exclude);
    }
    if (!record) {
      // Enrolled in state but missing from the keychain: disable rather than
      // spin, so selection moves on instead of picking it again.
      await disable(label, "credentials missing from keychain");
      return acquire(exclude);
    }

    if (!isFresh(record.oauth, now)) {
      try {
        const fresh = await refreshLabel(label);
        record = { ...record, oauth: fresh };
      } catch (err) {
        if (!(err instanceof LockTimeoutError)) {
          const detail = err instanceof Error ? err.message : String(err);
          // Only a rejected credential justifies permanent exclusion. A network
          // blip or a 5xx from the token endpoint must cool the account down
          // instead, or one transient outage disables every account in turn and
          // wedges the pool with no automatic recovery.
          if (isCredentialRejected(detail)) {
            await disable(label, `refresh rejected: ${detail}`);
          } else {
            await state.markCooldown(
              label,
              clock() + TRANSIENT_REFRESH_COOLDOWN_MS,
              `refresh failed: ${detail}`,
            );
          }
          return acquire(exclude);
        }
        // The lock holder is most likely refreshing this very account: use its
        // result if it landed, else fail this request without blaming the account.
        const reread = await accounts.getAccount(label);
        if (!reread || !isFresh(reread.oauth, clock())) {
          const alternative = await acquire(new Set([...(exclude ?? []), label]));
          if (alternative.kind === "ok") return alternative;
          throw err;
        }
        record = reread;
      }
    }

    if (state.load().activeLabel !== label) {
      try {
        await state.setActive(label);
      } catch (err) {
        // Stickiness only; a busy lock must not fail a request that has a valid token.
        if (!(err instanceof LockTimeoutError)) throw err;
      }
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
    // Deferred penalties land after the pool has switched; don't clear the new pick.
    const releaseIfActive = () =>
      state.withLock((s) => {
        if (s.activeLabel === label) s.activeLabel = null;
      });
    switch (decision.action) {
      case "ROTATE_COOLDOWN":
        await state.markCooldown(
          label,
          decision.until ?? clock(),
          decision.reason,
          decision.windows,
        );
        await releaseIfActive();
        break;
      case "ROTATE_DISABLE":
        await disable(label, decision.reason);
        await releaseIfActive();
        break;
      case "RETRY_SAME":
      case "PASS_THROUGH":
        break;
    }
  }

  /**
   * Read-only view of every enrolled account for the dashboard. Deliberately
   * returns no secret material — only the token EXPIRY, never the token.
   */
  async function snapshot(): Promise<PoolSnapshot> {
    await sync();
    const now = clock();
    const rotation = state.load();
    const records = await accounts.listAccounts();
    const rows: PoolSnapshotRow[] = records.map((record) => {
      const account = rotation.accounts[record.label];
      const cooling =
        account?.cooldownUntil !== null &&
        account?.cooldownUntil !== undefined &&
        account.cooldownUntil > now;
      return {
        label: record.label,
        email: record.email ?? null,
        tier: record.subscriptionType ?? null,
        status: account?.disabled ? "disabled" : cooling ? "cooling" : "ready",
        cooldownUntil: cooling ? (account!.cooldownUntil as number) : null,
        reason: account?.lastReason ?? null,
        failureCount: account?.failureCount ?? 0,
        tokenExpires: record.oauth.expires,
        active: rotation.activeLabel === record.label,
        fiveHourReset: account?.fiveHourReset ?? null,
        sevenDayReset: account?.sevenDayReset ?? null,
        bindingWindow: account?.bindingWindow ?? null,
        scopes: record.scopes ?? null,
        rateLimitTier: record.rateLimitTier ?? null,
        enrolledAt: record.enrolledAt,
        updatedAt: account?.updatedAt ?? null,
      };
    });
    rows.sort((left, right) => {
      const rank = { ready: 0, cooling: 1, disabled: 2 } as const;
      return rank[left.status] - rank[right.status] || (left.label < right.label ? -1 : 1);
    });
    return { activeLabel: rotation.activeLabel, now, accounts: rows };
  }

  /**
   * True when a refresh journal is present, i.e. a previous process died
   * between minting new tokens and persisting them. Surfaced so the recovery
   * path is visible rather than silent.
   */
  function pendingRefreshLabel(): string | null {
    return readJournal()?.label ?? null;
  }

  return {
    isActive,
    sync,
    snapshot,
    pendingRefreshLabel,
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

export interface PoolSnapshotRow {
  label: string;
  email: string | null;
  tier: string | null;
  status: "ready" | "cooling" | "disabled";
  cooldownUntil: number | null;
  reason: string | null;
  failureCount: number;
  tokenExpires: number;
  active: boolean;
  fiveHourReset: number | null;
  sevenDayReset: number | null;
  bindingWindow: "five_hour" | "seven_day" | null;
  scopes: string[] | null;
  rateLimitTier: string | null;
  enrolledAt: number;
  updatedAt: number | null;
}

export interface PoolSnapshot {
  activeLabel: string | null;
  now: number;
  accounts: PoolSnapshotRow[];
}

export type RotationManager = ReturnType<typeof createRotationManager>;
