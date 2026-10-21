/**
 * OpenCode 2 TUI entrypoint.
 *
 * V2 server plugins have no toast API, so pool events reach the user from
 * here: the TUI watches the rotation state file that every process using the
 * pool writes, and toasts whatever changed between snapshots. This only works
 * when the TUI runs on the same machine (and sees the same state path) as the
 * server doing the rotation.
 */

import fs from "node:fs";
import path from "node:path";
import { describeExhaustion } from "../pool/manager.js";
import type { ExhaustionInfo } from "../pool/manager.js";
import { createToaster } from "../pool/notify.js";
import type { ToastVariant } from "../pool/notify.js";
import { defaultStatePath } from "../pool/rotation-state.js";

/** The subset of the V2 TUI plugin context this plugin uses. */
export interface V2TuiContext {
  readonly ui: {
    readonly toast: {
      show(options: {
        readonly title?: string;
        readonly message: string;
        readonly variant?: ToastVariant;
        readonly duration?: number;
      }): void;
    };
  };
}

type Cleanup = () => void;

export interface PoolAccountSnapshot {
  cooldownUntil: number | null;
  disabled: boolean;
  lastReason: string | null;
}

export interface PoolSnapshot {
  activeLabel: string | null;
  accounts: Record<string, PoolAccountSnapshot>;
}

export interface PoolEvent {
  variant: ToastVariant;
  message: string;
  /** Names the condition when the text changes over time. */
  dedupeKey: string;
}

const POLL_MS = 2_000;
const DEBOUNCE_MS = 150;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Tolerant of anything unexpected: returns null rather than throwing. */
export function parsePoolSnapshot(raw: string): PoolSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { activeLabel, accounts } = parsed as { activeLabel?: unknown; accounts?: unknown };
  if (typeof accounts !== "object" || accounts === null) return null;

  const out: PoolSnapshot = {
    activeLabel: typeof activeLabel === "string" ? activeLabel : null,
    accounts: {},
  };
  for (const [label, value] of Object.entries(accounts)) {
    if (typeof value !== "object" || value === null) continue;
    const a = value as Record<string, unknown>;
    out.accounts[label] = {
      cooldownUntil: typeof a.cooldownUntil === "number" ? a.cooldownUntil : null,
      disabled: a.disabled === true,
      lastReason: typeof a.lastReason === "string" ? a.lastReason : null,
    };
  }
  return out;
}

function exhaustionOf(snapshot: PoolSnapshot, now: number): ExhaustionInfo | null {
  const labels = Object.keys(snapshot.accounts);
  if (labels.length === 0) return null;
  const cooling: ExhaustionInfo["cooling"] = [];
  const disabled: string[] = [];
  for (const label of labels) {
    const account = snapshot.accounts[label]!;
    if (account.disabled) disabled.push(label);
    else if (account.cooldownUntil !== null && account.cooldownUntil > now) {
      cooling.push({ label, until: account.cooldownUntil });
    } else {
      return null;
    }
  }
  const earliestReset = cooling.length ? Math.min(...cooling.map((c) => c.until)) : null;
  return { earliestReset, cooling, disabled };
}

/** Events implied by `prev` -> `next`. `prev === null` is the initial snapshot: nothing to report. */
export function diffPoolSnapshots(
  prev: PoolSnapshot | null,
  next: PoolSnapshot,
  now: number,
): PoolEvent[] {
  if (prev === null) return [];
  const events: PoolEvent[] = [];

  for (const [label, account] of Object.entries(next.accounts)) {
    const before = prev.accounts[label];
    if (!before) {
      events.push({ variant: "success", message: `Added "${label}" to the pool`, dedupeKey: `added:${label}` });
    }
    if (account.disabled && !before?.disabled) {
      const reason = account.lastReason ? ` (${truncate(account.lastReason, 80)})` : "";
      events.push({
        variant: "error",
        message: `"${label}" disabled${reason}; re-login, then claude-pool enroll`,
        dedupeKey: `disabled:${label}`,
      });
    }
  }

  if (prev.activeLabel && next.activeLabel && prev.activeLabel !== next.activeLabel) {
    events.push({
      variant: "info",
      message: `Switched from "${prev.activeLabel}" to "${next.activeLabel}"`,
      dedupeKey: `switched:${prev.activeLabel}:${next.activeLabel}`,
    });
  }

  const exhausted = exhaustionOf(next, now);
  if (exhausted && !exhaustionOf(prev, now)) {
    events.push({
      variant: "warning",
      message: describeExhaustion(exhausted, now),
      dedupeKey: `exhausted:${exhausted.earliestReset}`,
    });
  }
  return events;
}

/**
 * A state file that went missing or unusable is replaced by a fresh one, which
 * the pool fills back in as it syncs. Until then the accounts it lacks are
 * fresh, not gone: diffed as-is, the first rebuilt file reads as an exhausted
 * pool and every account re-registered after it as newly added.
 */
function carryAccounts(prev: PoolSnapshot, next: PoolSnapshot): PoolSnapshot {
  const accounts = { ...next.accounts };
  for (const label of Object.keys(prev.accounts)) {
    accounts[label] ??= { cooldownUntil: null, disabled: false, lastReason: null };
  }
  return { ...next, accounts };
}

export interface PoolWatcherOptions {
  statePath: string;
  onEvents: (events: PoolEvent[]) => void;
  clock?: () => number;
  pollMs?: number;
}

/** Starts watching; the returned function stops all watchers and timers. */
export function watchPoolState(opts: PoolWatcherOptions): Cleanup {
  const { statePath, onEvents } = opts;
  const clock = opts.clock ?? (() => Date.now());
  const dir = path.dirname(statePath);
  const base = path.basename(statePath);

  let prev: PoolSnapshot | null = null;
  // The file was missing or unusable since `prev`, so the pool is rebuilding it.
  let rebuilding = false;
  let lastSignature = "";
  let stopped = false;
  let debounce: NodeJS.Timeout | undefined;

  const check = (): void => {
    if (stopped) return;
    try {
      // Writes are atomic renames, so a changed inode/mtime/size marks a new version.
      const st = fs.statSync(statePath);
      const signature = `${st.ino}:${st.mtimeMs}:${st.size}`;
      if (signature === lastSignature) return;
      let next = parsePoolSnapshot(fs.readFileSync(statePath, "utf8"));
      lastSignature = signature;
      if (!next) {
        // The pool moves an unusable file aside and starts afresh.
        if (prev) rebuilding = true;
        return;
      }
      if (rebuilding && prev) next = carryAccounts(prev, next);
      rebuilding = false;
      const events = diffPoolSnapshots(prev, next, clock());
      // A rotation clears activeLabel before it picks the next account, and the
      // pick (keychain reads, a token refresh) can outlast the debounce: keep
      // diffing against the account last in use.
      prev = next.activeLabel === null && prev?.activeLabel ? { ...next, activeLabel: prev.activeLabel } : next;
      if (events.length) onEvents(events);
    } catch (err) {
      // Missing or unreadable state means no toast; keep the last good snapshot.
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && prev) rebuilding = true;
    }
  };

  check();

  let watcher: fs.FSWatcher | undefined;
  try {
    // Watch the directory: the rename-over write replaces the file's inode.
    watcher = fs.watch(dir, (_event, filename) => {
      if (filename && filename.toString() !== base) return;
      clearTimeout(debounce);
      debounce = setTimeout(check, DEBOUNCE_MS);
      debounce.unref();
    });
    watcher.on("error", () => {});
  } catch {
    // Directory missing or watching unsupported: polling still covers it.
  }

  const timer = setInterval(check, Math.max(opts.pollMs ?? POLL_MS, 50));
  timer.unref();

  return () => {
    stopped = true;
    clearTimeout(debounce);
    clearInterval(timer);
    watcher?.close();
  };
}

export default {
  id: "opencode-claude-bridge",
  setup(context: V2TuiContext): Cleanup | void {
    try {
      const toast = createToaster({
        tui: { showToast: async ({ body }) => context.ui.toast.show(body) },
      });
      return watchPoolState({
        statePath: defaultStatePath(),
        onEvents: (events) => {
          for (const event of events) toast(event.variant, event.message, event.dedupeKey);
        },
      });
    } catch {
      // Toasts are a convenience; never break the TUI.
    }
  },
};
