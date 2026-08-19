import { execFileSync } from "node:child_process";

import type {
  AccountRecord,
  ClaudeCliCredentials,
  Clock,
} from "./types.js";
import type { AccountStore } from "./manager.js";

const CLAUDE_CLI_KEYCHAIN_SERVICE = "Claude Code-credentials";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_BETA = "oauth-2025-04-20";

export class EnrollmentError extends Error {}

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
    throw new EnrollmentError(
      "Snapshot enrollment currently reads the macOS keychain only",
    );
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

export interface EnrollOptions {
  accounts: AccountStore;
  label: string;
  clock?: Clock;
  resolveEmail?: boolean;
  readCredentials?: () => string;
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

  const existing = await opts.accounts.listAccounts();
  const duplicate = existing.find(
    (a) => a.oauth.refresh === creds.claudeAiOauth.refreshToken,
  );
  if (duplicate && duplicate.label !== opts.label) {
    throw new EnrollmentError(
      `That account is already enrolled as "${duplicate.label}". Run \`claude login\` as a different account before enrolling again.`,
    );
  }

  const email =
    opts.resolveEmail === false
      ? undefined
      : await lookupEmail(creds.claudeAiOauth.accessToken);

  const record = toAccountRecord(opts.label, creds, now, email);
  await opts.accounts.putAccount(record);
  return record;
}
