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
import { enrollFromClaudeCli, EnrollmentError, readClaudeCliCredentialsRaw, parseClaudeCredentials, lookupEmail } from "../dist/pool/enroll.js";
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

async function enroll(label, flags = []) {
  const record = await enrollFromClaudeCli({
    accounts,
    label,
    replace: flags.includes("--replace"),
  });
  // Fresh credentials mean any prior disable/cooldown is stale. Without this,
  // re-enrolling a revoked account reports success while rotation keeps
  // skipping it.
  await state.resetHealth(label);
  console.log(
    `Enrolled "${label}" (${record.email ?? "email unresolved"}), tier ${record.subscriptionType ?? "?"}.`,
  );
  const total = (await accounts.listAccounts()).length;
  console.log(`Pool now holds ${total} account${total === 1 ? "" : "s"}.`);
  if (total < 2) {
    console.log("Add another so rotation has somewhere to go:");
    console.log("  claude login          # as the next account");
    console.log("  claude-pool enroll    # label is derived from its email");
  }
}

async function whoami() {
  const creds = parseClaudeCredentials(readClaudeCliCredentialsRaw());
  const email = await lookupEmail(creds.claudeAiOauth.accessToken);
  const enrolled = (await accounts.listAccounts()).find(
    (a) => a.oauth.refresh === creds.claudeAiOauth.refreshToken,
  );
  if (enrolled) {
    console.log(`Claude CLI is logged in as: ${email ?? enrolled.email ?? "(unresolved)"}`);
    console.log(`Already enrolled in the pool as "${enrolled.label}".`);
    return;
  }

  if (!email) {
    // The pool rotates refresh tokens, which supersedes the Claude CLI's own
    // copy. A stale CLI credential therefore proves nothing about whether the
    // underlying account is enrolled, so do not claim that it is not.
    console.log("Claude CLI's stored credential is expired or superseded.");
    console.log("It may already be in the pool under a newer token — check `claude-pool list`.");
    console.log("To enroll this account fresh: run `claude login`, then `claude-pool enroll`.");
    return;
  }

  console.log(`Claude CLI is logged in as: ${email}`);
  const byEmail = (await accounts.listAccounts()).find((a) => a.email === email);
  console.log(
    byEmail
      ? `That account is in the pool as "${byEmail.label}" (its token has since been rotated).`
      : "Not yet in the pool. Run `claude-pool enroll` to add it.",
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

const [command, ...rest] = process.argv.slice(2);
const flags = rest.filter((a) => a.startsWith("--"));
const arg = rest.find((a) => !a.startsWith("--"));
try {
  switch (command) {
    case "enroll": await enroll(arg, flags); break;
    case "list": await list(); break;
    case "status": await status(); break;
    case "whoami": await whoami(); break;
    case "remove": await remove(arg); break;
    case "clear-cooldowns": await clearCooldowns(); break;
    default:
      console.log([
        "usage: claude-pool <command>",
        "",
        "  enroll [label] [--replace]  add the account Claude CLI is logged into",
        "                              (label defaults to the account's email name)",
        "  whoami                      show which account Claude CLI is logged into",
        "  list                        show every enrolled account and its status",
        "  status                      show active account and what rotation picks next",
        "  remove <label>              drop an account from the pool",
        "  clear-cooldowns             re-enable everything after a rate-limit storm",
        "",
        "Adding accounts (repeat for as many as you like):",
        "  claude login   # as the account you want to add",
        "  claude-pool enroll",
      ].join("\n"));
      process.exit(1);
  }
} catch (err) {
  console.error(err instanceof EnrollmentError ? err.message : (err?.stack ?? String(err)));
  process.exit(1);
}
