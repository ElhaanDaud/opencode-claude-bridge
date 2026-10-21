import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { OAuthTokens } from "./oauth.js";

interface KeychainCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

/** Where the Claude CLI stores its login outside the macOS keychain (Linux, Windows). */
export function claudeCredentialsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json");
}

const KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Pick the first candidate that actually carries `claudeAiOauth`.
 *
 * More than one Keychain item can share the service name, and a match is not
 * the same thing as the right item: attaching an MCP server writes a second
 * item under this service holding only `mcpOAuth`. Selecting on content rather
 * than on "the first thing `security` returned" is what keeps that item from
 * shadowing the real credential.
 *
 * Exported for tests; the selection is pure so it can be exercised without a
 * Keychain.
 */
export function selectClaudeCredentials(
  candidates: Array<KeychainCredentials | null>,
): KeychainCredentials | null {
  for (const candidate of candidates) {
    if (candidate?.claudeAiOauth) return candidate;
  }
  return null;
}

/** Read one Keychain item, optionally scoped to an account. */
function readKeychainItem(account?: string): KeychainCredentials | null {
  const args = ["find-generic-password", "-s", KEYCHAIN_SERVICE];
  if (account) args.push("-a", account);
  args.push("-w");
  try {
    // execFileSync, not a shell string: the account name is user-controlled
    // and must not be interpolated into a command line.
    const raw = execFileSync("security", args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!raw) return null;
    return JSON.parse(raw) as KeychainCredentials;
  } catch {
    // Item missing, Keychain unavailable, or unparseable contents.
    return null;
  }
}

/**
 * Read Claude CLI credentials from macOS Keychain.
 * Falls back to the credentials file on other platforms.
 */
export function readClaudeCredentials(): KeychainCredentials | null {
  if (process.platform === "darwin") {
    let account: string | undefined;
    try {
      account = userInfo().username;
    } catch {
      // userInfo() throws when there is no passwd entry for the uid.
      account = undefined;
    }

    // Scoped lookup first (Claude Code stores under the current account), then
    // the historical unscoped lookup so anyone whose item lives under a
    // different account name keeps working exactly as before.
    const found = selectClaudeCredentials([
      account ? readKeychainItem(account) : null,
      readKeychainItem(),
    ]);
    if (found) return found;
    // Deliberately fall through when the Keychain had matches but none carried
    // claudeAiOauth. Returning such an item made the credentials-file fallback
    // below unreachable.
  }

  // Fallback: credentials file
  try {
    const raw = readFileSync(claudeCredentialsPath(), "utf8");
    return JSON.parse(raw) as KeychainCredentials;
  } catch {
    return null;
  }
}

/** Claude CLI's tokens while valid. Never refreshes: that single-use token is Claude Code's. */
export function getClaudeTokens(): OAuthTokens | null {
  const creds = readClaudeCredentials();
  if (!creds?.claudeAiOauth) return null;

  const { accessToken, refreshToken, expiresAt } = creds.claudeAiOauth;

  // Token still valid (60s buffer)
  if (expiresAt > Date.now() + 60_000) {
    return {
      access: accessToken,
      refresh: refreshToken,
      expires: expiresAt,
    };
  }

  return null;
}
