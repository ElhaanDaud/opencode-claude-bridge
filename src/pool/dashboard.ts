/**
 * Human-readable pool dashboard.
 *
 * Pure formatting over {@link PoolSnapshot} so it is trivially testable and
 * contains no I/O. Never renders token material — only expiry timestamps.
 */

import type { PoolSnapshot, PoolSnapshotRow } from "./manager.js";

const STATUS_ICON: Record<PoolSnapshotRow["status"], string> = {
  ready: "●",
  cooling: "◐",
  disabled: "○",
};

function relative(target: number, now: number): string {
  const deltaMs = target - now;
  const abs = Math.abs(deltaMs);
  const mins = Math.round(abs / 60_000);
  if (mins < 60) return deltaMs >= 0 ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  const text = rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
  return deltaMs >= 0 ? `in ${text}` : `${text} ago`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function formatDashboard(snapshot: PoolSnapshot): string {
  const { accounts, now, activeLabel } = snapshot;

  if (accounts.length === 0) {
    return [
      "Claude pool: no accounts enrolled.",
      "",
      "The pool is inactive, so the bridge uses your single Claude CLI login.",
      "Enroll with:  claude login  &&  claude-pool enroll",
    ].join("\n");
  }

  const ready = accounts.filter((a) => a.status === "ready");
  const cooling = accounts.filter((a) => a.status === "cooling");
  const disabled = accounts.filter((a) => a.status === "disabled");

  const lines: string[] = [];
  lines.push(
    `Claude pool — ${accounts.length} enrolled · ${ready.length} ready · ${cooling.length} cooling · ${disabled.length} disabled`,
  );
  lines.push("");

  for (const account of accounts) {
    const marker = account.active ? "▸" : " ";
    const icon = STATUS_ICON[account.status];
    const who = truncate(account.email ?? account.label, 30);
    const head = `${marker} ${icon} ${truncate(account.label, 22).padEnd(22)} ${who.padEnd(30)}`;

    let detail: string;
    if (account.status === "cooling" && account.cooldownUntil !== null) {
      detail = `back ${relative(account.cooldownUntil, now)}`;
    } else if (account.status === "disabled") {
      detail = "needs re-login";
    } else {
      detail = `token expires ${relative(account.tokenExpires, now)}`;
    }
    lines.push(`${head} ${detail}`);

    // Only surface the reason when it explains a non-ready state; on a healthy
    // account it is stale history and just adds noise.
    if (account.status !== "ready" && account.reason) {
      lines.push(`${" ".repeat(4)}↳ ${truncate(account.reason, 88)}`);
    }
  }

  lines.push("");
  if (ready.length > 0) {
    lines.push(`Active: ${activeLabel ?? "(none — will be chosen on next request)"}`);
  } else if (cooling.length > 0) {
    const soonest = cooling.reduce((best, candidate) =>
      (candidate.cooldownUntil ?? Infinity) < (best.cooldownUntil ?? Infinity) ? candidate : best,
    );
    lines.push(
      `No account is usable right now. Earliest recovery: ${soonest.label} ${
        soonest.cooldownUntil !== null ? relative(soonest.cooldownUntil, now) : "unknown"
      }.`,
    );
  } else {
    lines.push("Every account is disabled. Re-login and re-enroll to recover.");
  }

  return lines.join("\n");
}
