import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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

/**
 * Read Claude CLI credentials from macOS Keychain.
 * Falls back to the credentials file on other platforms.
 */
export function readClaudeCredentials(): KeychainCredentials | null {
  if (process.platform === "darwin") {
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: "utf8", timeout: 5000 },
      ).trim();
      if (raw && raw !== "") {
        return JSON.parse(raw) as KeychainCredentials;
      }
    } catch {
      // Keychain not available or entry missing
    }
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
