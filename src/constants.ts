import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_BINARIES = [
  "claude",
  join(homedir(), ".local", "bin", "claude"),
  join(homedir(), ".claude", "local", "claude"),
];
const FALLBACK_CLI_VERSION = "2.1.98";
const VERSION_RECHECK_MS = 10 * 60_000;

function parseVersion(output: string): string | null {
  return output.trim().match(/^(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

function detectClaudeVersion(): string {
  for (const binary of CLAUDE_BINARIES) {
    try {
      const version = parseVersion(execFileSync(binary, ["--version"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }));
      if (version) return version;
    } catch {}
  }
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    const parsed = JSON.parse(readFileSync(credPath, "utf8"));
    if (parsed.version && typeof parsed.version === "string") {
      return parsed.version;
    }
  } catch {}
  console.error(
    `[opencode-claude-bridge] Claude Code CLI not found; advertising version ${FALLBACK_CLI_VERSION}, which newer models reject. Set ANTHROPIC_CLI_VERSION to override.`,
  );
  return FALLBACK_CLI_VERSION;
}

let cliVersion = process.env.ANTHROPIC_CLI_VERSION || detectClaudeVersion();
let versionCheckedAt = Date.now();

function recheckVersionInBackground(index = 0): void {
  if (index >= CLAUDE_BINARIES.length) return;
  execFile(CLAUDE_BINARIES[index]!, ["--version"], { encoding: "utf8", timeout: 3000 }, (err, stdout) => {
    const version = err ? null : parseVersion(stdout);
    if (version) cliVersion = version;
    else recheckVersionInBackground(index + 1);
  });
}

// Not a const: Claude Code auto-updates under us and the API gates models on this.
export function getCliVersion(): string {
  if (!process.env.ANTHROPIC_CLI_VERSION && Date.now() - versionCheckedAt > VERSION_RECHECK_MS) {
    versionCheckedAt = Date.now();
    recheckVersionInBackground();
  }
  return cliVersion;
}

export const CLIENT_ID =
  process.env.ANTHROPIC_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// claude.ai serves this path behind a Cloudflare challenge that always 403s.
export const PROFILE_URL =
  process.env.ANTHROPIC_PROFILE_URL ||
  "https://api.anthropic.com/api/oauth/profile";

export const TOKEN_URL =
  process.env.ANTHROPIC_TOKEN_URL ||
  "https://platform.claude.com/v1/oauth/token";

export const AUTHORIZE_URL =
  process.env.ANTHROPIC_AUTHORIZE_URL ||
  "https://claude.ai/oauth/authorize";

// Manual redirect URL — used when the local server can't receive the callback
// (e.g., user copies the code from the browser). This matches Claude CLI's
// MANUAL_REDIRECT_URL from the production OAuth config.
export const MANUAL_REDIRECT_URL =
  process.env.ANTHROPIC_MANUAL_REDIRECT_URL ||
  "https://platform.claude.com/oauth/code/callback";

// All OAuth scopes — union of Console + Claude.ai scopes, matching Claude CLI's
// ALL_OAUTH_SCOPES. Includes org:create_api_key for Console -> Claude.ai redirect.
export const SCOPES =
  process.env.ANTHROPIC_SCOPES ||
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export const CLI_BUILD_ID =
  process.env.ANTHROPIC_CLI_BUILD_ID || "835";

export const ENTRYPOINT =
  process.env.ANTHROPIC_ENTRYPOINT ||
  process.env.CLAUDE_CODE_ENTRYPOINT ||
  "sdk-cli";

export function getUserAgent(): string {
  return process.env.ANTHROPIC_USER_AGENT ||
    `claude-cli/${getCliVersion()} (external, ${ENTRYPOINT})`;
}

// Exact beta flags from Claude Code 2.1.178 (confirmed via request interception)
// oauth-2025-04-20 is added separately only for OAuth auth.
export const BETA_FLAGS =
  process.env.ANTHROPIC_BETA_FLAGS ||
  "interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219,advisor-tool-2026-03-01,effort-2025-11-24,extended-cache-ttl-2025-04-11";

export const OAUTH_BETA_FLAG = "oauth-2025-04-20";

// Exact anthropic-version header from Claude Code SDK
export const ANTHROPIC_VERSION = "2023-06-01";

// Stainless SDK headers (matches what Claude Code's bundled SDK sends)
export const STAINLESS_HEADERS: Record<string, string> = {
  "x-stainless-lang": "js",
  "x-stainless-package-version": process.env.ANTHROPIC_SDK_VERSION || "0.94.0",
  "x-stainless-os": process.platform === "darwin" ? "MacOS" : process.platform === "linux" ? "Linux" : "Windows",
  "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": process.version,
};

export const DEFAULT_EFFORT =
  process.env.ANTHROPIC_DEFAULT_EFFORT || "medium";

export const CLEAR_THINKING_TYPE =
  process.env.ANTHROPIC_CLEAR_THINKING_TYPE || "clear_thinking_20251015";

export const BILLING_CCH =
  process.env.ANTHROPIC_BILLING_CCH || "";

export const SESSION_ID =
  process.env.ANTHROPIC_SESSION_ID || "";

export const TOOL_PREFIX = "mcp_";

// Long enough to read a per-account recovery time; the toast clears itself.
export const POOL_TOAST_DURATION_MS = 10_000;
