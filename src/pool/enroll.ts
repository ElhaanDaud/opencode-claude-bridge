import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import type {
  AccountRecord,
  ClaudeCliCredentials,
  Clock,
} from "./types.js";
import type { AccountStore } from "./manager.js";
import { PROFILE_URL } from "../constants.js";
import { claudeCredentialsPath } from "../keychain.js";

const CLAUDE_CLI_KEYCHAIN_SERVICE = "Claude Code-credentials";
const OAUTH_BETA = "oauth-2025-04-20";

export class EnrollmentError extends Error {}

/** The label is held by an account that may or may not be this one; only the user can decide. */
export class LabelConflictError extends EnrollmentError {
  constructor(
    readonly label: string,
    readonly existingEmail: string | null,
  ) {
    super(
      existingEmail
        ? `Label "${label}" already belongs to a different account (${existingEmail}). Choose another label or pass --replace.`
        : `Label "${label}" belongs to an account whose email was never resolved; it may be this one. Pass --replace to overwrite it, or choose another label.`,
    );
  }
}

const MAX_LABEL_LENGTH = 64;

/**
 * Labels are used verbatim as the keychain account and as a filename in the
 * non-darwin fallback, so they are constrained to a conservative charset.
 * A leading dash is rejected specifically because `security` would otherwise
 * parse the label as one of its own options.
 */
export function normalizeLabel(input: string): string {
  const label = String(input ?? "").trim().toLowerCase();

  if (label.length === 0) {
    throw new EnrollmentError("Account label cannot be empty");
  }
  if (label.length > MAX_LABEL_LENGTH) {
    throw new EnrollmentError(
      `Account label is too long (max ${MAX_LABEL_LENGTH} characters)`,
    );
  }
  if (label.startsWith("-")) {
    throw new EnrollmentError(
      `Account label cannot start with "-" (it would be read as a command option): ${label}`,
    );
  }
  if (!/^[a-z0-9._-]+$/.test(label)) {
    throw new EnrollmentError(
      `Account label may only contain letters, digits, dot, underscore and hyphen: ${label}`,
    );
  }
  if (label === "." || label === ".." || label.includes("..")) {
    throw new EnrollmentError(`Account label is not a safe filename: ${label}`);
  }

  return label;
}

/** Turn "Work.Account+tag@corp.io" into a usable, stable label. */
export function deriveLabelFromEmail(email: string): string {
  const local = String(email ?? "").split("@")[0] ?? "";
  const stripped = local.split("+")[0] ?? "";
  const cleaned = stripped.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (!cleaned) {
    throw new EnrollmentError(`Cannot derive an account label from "${email}"`);
  }
  return normalizeLabel(cleaned);
}

export function parseClaudeCredentials(raw: string): ClaudeCliCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EnrollmentError("Claude CLI credentials are not valid JSON");
  }

  const oauth = (parsed as ClaudeCliCredentials | null)?.claudeAiOauth;
  if (
    !oauth ||
    typeof oauth.accessToken !== "string" ||
    typeof oauth.refreshToken !== "string" ||
    typeof oauth.expiresAt !== "number"
  ) {
    throw new EnrollmentError(
      "Claude CLI credentials are missing claudeAiOauth.{accessToken,refreshToken,expiresAt}",
    );
  }

  return { claudeAiOauth: oauth };
}

export function toAccountRecord(
  label: string,
  creds: ClaudeCliCredentials,
  now: number,
  email?: string,
): AccountRecord {
  const o = creds.claudeAiOauth;
  const record: AccountRecord = {
    label,
    oauth: { access: o.accessToken, refresh: o.refreshToken, expires: o.expiresAt },
    enrolledAt: now,
  };

  // Only assign present values: undefined keys survive in memory but are
  // dropped by JSON.stringify, so emitting them makes a stored record
  // structurally unequal to the one just built.
  if (o.subscriptionType !== undefined) record.subscriptionType = o.subscriptionType;
  if (o.rateLimitTier !== undefined) record.rateLimitTier = o.rateLimitTier;
  if (o.scopes !== undefined) record.scopes = o.scopes;
  if (email !== undefined) record.email = email;

  return record;
}

export function readClaudeCliCredentialsRaw(): string {
  if (process.platform !== "darwin") {
    const path = claudeCredentialsPath();
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      throw new EnrollmentError(
        `No Claude CLI credentials found at ${path}. Run \`claude login\` first.`,
      );
    }
  }
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", CLAUDE_CLI_KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", timeout: 10_000 },
    ).trim();
  } catch {
    throw new EnrollmentError(
      `No Claude CLI credentials found in the keychain (service "${CLAUDE_CLI_KEYCHAIN_SERVICE}"). Run \`claude login\` first.`,
    );
  }
}

/**
 * Resolve the account's email so enrolled entries are identifiable. Best
 * effort: enrollment must still succeed offline or on a throttled token.
 */
export async function lookupEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch(PROFILE_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "anthropic-beta": OAUTH_BETA,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      account?: { email_address?: string; email?: string };
    };
    return body.account?.email_address ?? body.account?.email;
  } catch {
    return undefined;
  }
}

/** Same person, whatever their tokens: both copies' refresh tokens diverge after either refreshes. */
function findByEmail(accounts: AccountRecord[], email: string | undefined): AccountRecord | undefined {
  if (!email) return undefined;
  const wanted = email.toLowerCase();
  return accounts.find((a) => a.email?.toLowerCase() === wanted);
}

function firstFreeLabel(base: string, accounts: AccountRecord[]): string {
  const taken = new Set(accounts.map((a) => a.label));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export interface EnrollOptions {
  accounts: AccountStore;
  /** Optional: derived from the account's email when omitted. */
  label?: string;
  clock?: Clock;
  resolveEmail?: boolean | ((accessToken: string) => Promise<string | undefined>);
  readCredentials?: () => string;
  replace?: boolean;
}

/**
 * Snapshot whichever account the Claude CLI is currently logged into.
 *
 * Both the CLI keychain and opencode's auth.json hold exactly one Claude
 * credential, so `claude login` destroys the previous account. Enrolling
 * captures it into the pool first, making the sequence
 * "enroll, re-login, enroll" non-destructive.
 */
export async function enrollFromClaudeCli(
  opts: EnrollOptions,
): Promise<AccountRecord> {
  const now = (opts.clock ?? (() => Date.now()))();
  const readCredentials = opts.readCredentials ?? readClaudeCliCredentialsRaw;
  const creds = parseClaudeCredentials(readCredentials());

  const resolve = typeof opts.resolveEmail === "function" ? opts.resolveEmail : lookupEmail;
  const email =
    opts.resolveEmail === false
      ? undefined
      : await resolve(creds.claudeAiOauth.accessToken);

  const existing = await opts.accounts.listAccounts();
  const sameEmail = findByEmail(existing, email);

  let label: string;
  if (opts.label !== undefined) {
    label = normalizeLabel(opts.label);
  } else if (sameEmail) {
    label = sameEmail.label;
  } else if (email) {
    label = deriveLabelFromEmail(email);
  } else {
    throw new EnrollmentError(
      "Could not determine an account label. Pass one explicitly: claude-pool enroll <label>",
    );
  }

  if (sameEmail && sameEmail.label !== label) {
    throw new EnrollmentError(
      `${email} is already enrolled as "${sameEmail.label}". Enroll without a label to refresh its credentials.`,
    );
  }

  const duplicate = existing.find(
    (a) => a.oauth.refresh === creds.claudeAiOauth.refreshToken,
  );
  if (duplicate && duplicate.label !== label) {
    throw new EnrollmentError(
      `That account is already enrolled as "${duplicate.label}". Run \`claude login\` as a different account before enrolling again.`,
    );
  }

  const sameLabelDifferentAccount = existing.find(
    (a) => a.label === label
      && a !== sameEmail
      && a.oauth.refresh !== creds.claudeAiOauth.refreshToken,
  );
  if (sameLabelDifferentAccount && opts.replace !== true) {
    const derived = opts.label === undefined;
    const otherPerson = Boolean(email && sameLabelDifferentAccount.email);
    if (derived && otherPerson) {
      // alice@work and alice@home derive the same label; both belong in the pool.
      label = firstFreeLabel(label, existing);
    } else {
      throw new LabelConflictError(label, sameLabelDifferentAccount.email ?? null);
    }
  }

  const record = toAccountRecord(label, creds, now, email);
  await opts.accounts.putAccount(record);
  return record;
}

/**
 * Label of the pooled account holding Claude Code's current refresh token, if
 * any. Refresh tokens are single-use, so whichever side refreshes first logs
 * the other out. Compares only; never returns or logs a token.
 */
export async function labelSharingClaudeCliLogin(
  accounts: AccountStore,
  readCredentials: () => string = readClaudeCliCredentialsRaw,
): Promise<string | null> {
  let refresh: string;
  try {
    refresh = parseClaudeCredentials(readCredentials()).claudeAiOauth.refreshToken;
  } catch {
    return null;
  }
  return (await accounts.listAccounts()).find((a) => a.oauth.refresh === refresh)?.label ?? null;
}

export function sharedLoginWarning(label: string): string {
  return `"${label}" shares one login with Claude Code on this machine; whichever refreshes first logs the other out. `
    + "Run `claude login` again (as this or another account) and do not re-enroll it.";
}

export type AutoEnrollStatus =
  | "enrolled"
  | "already-enrolled"
  | "stale"
  | "unavailable"
  | "no-label";

export interface AutoEnrollResult {
  status: AutoEnrollStatus;
  label?: string;
  email?: string;
}

export interface AutoEnrollOptions {
  accounts: AccountStore;
  clock?: Clock;
  readCredentials?: () => string;
  resolveEmail?: (accessToken: string) => Promise<string | undefined>;
}

/**
 * Adopt whatever account the Claude CLI is currently logged into, if the pool
 * has not seen it before.
 *
 * Accounts are matched by refresh token, then by email: the pool's copy and
 * the CLI's copy stop sharing a refresh token once either refreshes. Never by
 * label, since two different accounts may derive the same one.
 *
 * Never throws: this runs during plugin startup, where a failure to adopt a new
 * account must not prevent the existing pool from serving requests.
 */
export async function autoEnrollIfNew(
  opts: AutoEnrollOptions,
): Promise<AutoEnrollResult> {
  const now = (opts.clock ?? (() => Date.now()))();
  const read = opts.readCredentials ?? readClaudeCliCredentialsRaw;
  const resolve = opts.resolveEmail ?? lookupEmail;

  let creds: ClaudeCliCredentials;
  try {
    creds = parseClaudeCredentials(read());
  } catch {
    return { status: "unavailable" };
  }

  const oauth = creds.claudeAiOauth;

  // An expired credential would enter the pool only to fail its first request
  // and be disabled, so leave it for an explicit `claude-pool enroll`.
  if (oauth.expiresAt <= now) return { status: "stale" };

  let existing: AccountRecord[];
  try {
    existing = await opts.accounts.listAccounts();
  } catch {
    return { status: "unavailable" };
  }

  const known = existing.find((a) => a.oauth.refresh === oauth.refreshToken);
  if (known) return { status: "already-enrolled", label: known.label };

  let email: string | undefined;
  try {
    email = await resolve(oauth.accessToken);
  } catch {
    email = undefined;
  }
  if (!email) return { status: "no-label" };

  const sameEmail = findByEmail(existing, email);
  if (sameEmail) return { status: "already-enrolled", label: sameEmail.label, email };

  let label: string;
  try {
    label = deriveLabelFromEmail(email);
  } catch {
    return { status: "no-label" };
  }

  label = firstFreeLabel(label, existing);

  try {
    await opts.accounts.putAccount(toAccountRecord(label, creds, now, email));
  } catch {
    return { status: "unavailable" };
  }

  return { status: "enrolled", label, email };
}
