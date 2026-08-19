#!/usr/bin/env node
/**
 * Pool management CLI.
 *
 * Typical multi-account setup, which must be done in this order because both
 * the Claude CLI keychain and opencode's auth.json hold only ONE credential
 * and `claude login` overwrites it:
 *
 *   claude login                      # as the first account
 *   claude-pool enroll alice
 *   claude login                      # as the second account
 *   claude-pool enroll bob
 *   claude-pool list
 */

import { createRotationStateStore, defaultStatePath } from "../dist/pool/rotation-state.js";
import { createAccountStore, createSecretBackend } from "../dist/pool/secret-store.js";
import { enrollFromClaudeCli, EnrollmentError } from "../dist/pool/enroll.js";
import { selectNext } from "../dist/pool/selection.js";

const accounts = createAccountStore(createSecretBackend());
const state = createRotationStateStore({ path: defaultStatePath() });

/**
 * Register every enrolled account in the rotation state. The state file is
 * derived, not authoritative: deleting it must not make enrolled accounts
 * look exhausted. The runtime does this on acquire(); the CLI needs it too
 * so its view matches what a request would actually do.
 */
async function syncEnrolled() {
  for (const record of await accounts.listAccounts()) {
    await state.ensureAccount(record.label);
  }
}

function when(ts) {
  if (!ts) return "-";
  const mins = Math.ceil((ts - Date.now()) / 60_000);
  return `${new Date(ts).toISOString()} (${mins > 0 ? `in ~${mins}m` : "now"})`;
}

async function list() {
  await syncEnrolled();
  const records = await accounts.listAccounts();
  if (records.length === 0) {
    console.log("No accounts enrolled. Run: claude-pool enroll <label>");
    return;
  }
  const s = state.load();
  console.log(
    `${"LABEL".padEnd(10)}${"EMAIL".padEnd(30)}${"TIER".padEnd(10)}${"STATUS".padEnd(12)}TOKEN EXPIRES`,
  );
  for (const r of records.sort((a, b) => a.label.localeCompare(b.label))) {
    const st = s.accounts[r.label];
    const active = s.activeLabel === r.label ? "*" : " ";
    const status = st?.disabled
      ? "DISABLED"
      : st?.cooldownUntil && st.cooldownUntil > Date.now()
        ? "COOLING"
        : "ready";
    console.log(
      `${active}${r.label.padEnd(9)}${(r.email ?? "?").padEnd(30)}${(r.subscriptionType ?? "?").padEnd(10)}${status.padEnd(12)}${new Date(r.oauth.expires).toISOString()}`,
    );
    if (st?.cooldownUntil && st.cooldownUntil > Date.now()) {
      console.log(`${" ".repeat(10)}cooling until ${when(st.cooldownUntil)} — ${st.lastReason ?? ""}`);
    }
    if (st?.disabled) {
      console.log(`${" ".repeat(10)}disabled — ${st.lastReason ?? ""}`);
    }
  }
  console.log("\n* = active account (mirrored into opencode's anthropic slot)");
}

async function enroll(label) {
  if (!label) throw new Error("usage: claude-pool enroll <label>");
  const record = await enrollFromClaudeCli({ accounts, label });
  // Fresh credentials mean any prior disable/cooldown is stale. Without this,
  // re-enrolling a revoked account reports success while rotation keeps
  // skipping it.
  await state.resetHealth(label);
  console.log(
    `Enrolled "${label}" (${record.email ?? "email unresolved"}), tier ${record.subscriptionType ?? "?"}.`,
  );
  console.log(
    "To add another account: run `claude login` as that account, then `claude-pool enroll <other-label>`.",
  );
}

async function status() {
  await syncEnrolled();
  const records = await accounts.listAccounts();
  const s = state.load();
  const selection = selectNext(s, Date.now());
  console.log(`enrolled: ${records.length}`);
  console.log(`active:   ${s.activeLabel ?? "(none)"}`);
  if (selection.kind === "selected") {
    console.log(`next:     ${selection.label}`);
  } else {
    console.log("next:     NONE — pool exhausted");
    for (const c of selection.cooling) console.log(`  cooling ${c.label} until ${when(c.until)}`);
    for (const d of selection.disabled) console.log(`  disabled ${d}`);
  }
  console.log(`state:    ${defaultStatePath()}`);
}

async function remove(label) {
  if (!label) throw new Error("usage: claude-pool remove <label>");
  await accounts.removeAccount(label);
  await state.withLock((s) => {
    delete s.accounts[label];
    if (s.activeLabel === label) s.activeLabel = null;
  });
  console.log(`Removed "${label}".`);
}

async function clearCooldowns() {
  await state.withLock((s) => {
    for (const account of Object.values(s.accounts)) {
      account.cooldownUntil = null;
      account.disabled = false;
      account.failureCount = 0;
    }
  });
  console.log("Cleared all cooldowns and re-enabled every account.");
}

const [command, arg] = process.argv.slice(2);
try {
  switch (command) {
    case "enroll": await enroll(arg); break;
    case "list": await list(); break;
    case "status": await status(); break;
    case "remove": await remove(arg); break;
    case "clear-cooldowns": await clearCooldowns(); break;
    default:
      console.log("usage: claude-pool <enroll <label> | list | status | remove <label> | clear-cooldowns>");
      process.exit(1);
  }
} catch (err) {
  console.error(err instanceof EnrollmentError ? err.message : (err?.stack ?? String(err)));
  process.exit(1);
}
