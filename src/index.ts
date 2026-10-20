import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import {
  createAuthorizationRequest,
  exchangeCodeForTokens,
  parseAuthCode,
  parsePastedState,
  refreshTokens,
  startOAuthCallbackServer,
} from "./oauth.js";
import { getClaudeTokens, readClaudeCredentials } from "./keychain.js";
import {
  BETA_FLAGS,
  getCliVersion,
  OAUTH_BETA_FLAG,
  ANTHROPIC_VERSION,
  BILLING_CCH,
  STAINLESS_HEADERS,
  getUserAgent,
  PROFILE_URL,
  CLI_BUILD_ID,
  ENTRYPOINT,
  DEFAULT_EFFORT,
  CLEAR_THINKING_TYPE,
  SESSION_ID,
} from "./constants.js";
import {
  getClaudeTools,
  translateArgsOpencodeToClaude,
  translateToolArgsJsonString,
  computeFingerprint,
  extractFirstUserMessageText,
  shouldUseClaudeToolSchemas,
} from "./claude-tools.js";
import type { ToolDefinition } from "./claude-tools.js";
import { translateSseStream } from "./stream.js";
import { MAX_RESPONSE_RETRIES, RETRYABLE_STATUSES, getResponseRetryDelayMs } from "./retry.js";
import { buildPoolBusyResponse, buildPoolExhaustedResponse, createPool } from "./pool/bridge.js";
import { LockTimeoutError } from "./pool/rotation-state.js";
import { truncate } from "./pool/dashboard.js";
import { autoEnrollIfNew, labelSharingClaudeCliLogin, sharedLoginWarning } from "./pool/enroll.js";
import { createToaster } from "./pool/notify.js";
import type { Toaster } from "./pool/notify.js";
import type { PoolClient } from "./pool/bridge.js";
import { createAccountStore, createSecretBackend } from "./pool/secret-store.js";
import type { RotationManager } from "./pool/manager.js";
import type { RotationDecision } from "./pool/types.js";

// ── Types ──────────────────────────────────────────────────────────

type AuthType = {
  type: string;
  access?: string;
  refresh?: string;
  expires?: number;
};

type ProviderModel = {
  cost?: unknown;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  limit?: { context: number; output: number };
  modalities?: { input: string[]; output: string[] };
};

type OAuthProfile = {
  account?: { uuid?: string };
};

type ClaudeSystemPromptCache = {
  system?: Array<{ type?: string; text?: string; cache_control?: unknown }>;
  billing?: {
    ccVersion?: string;
    ccVersionSuffix?: string;
    ccEntrypoint?: string;
  };
};

const OUTBOUND_TOOL_NAME_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  edit: "Edit",
  write: "Write",
  task: "Agent",
  webfetch: "WebFetch",
  todowrite: "TodoWrite",
  skill: "Skill",
  mcp_bash: "Bash",
  mcp_read: "Read",
  mcp_glob: "Glob",
  mcp_grep: "Grep",
  mcp_edit: "Edit",
  mcp_write: "Write",
  mcp_task: "Agent",
  mcp_webfetch: "WebFetch",
  mcp_todowrite: "TodoWrite",
  mcp_skill: "Skill",
  question: "AskUserQuestion",
  mcp_question: "AskUserQuestion",
  plan_enter: "EnterPlanMode",
  plan_exit: "ExitPlanMode",
};

const INBOUND_TOOL_NAME_MAP: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  Edit: "edit",
  Write: "write",
  Agent: "task",
  WebFetch: "webfetch",
  TodoWrite: "todowrite",
  Skill: "skill",
  AskUserQuestion: "question",
  EnterPlanMode: "plan_enter",
  ExitPlanMode: "plan_exit",
};

// Fallback catalog, used only for ids the host's own model list lacks.
// Prices per million tokens, from platform.claude.com/docs/en/about-claude/pricing.
const ANTHROPIC_MODELS: Record<string, ProviderModel> = {
  "claude-fable-5-1": {
    name: "Claude Fable 5.1",
    attachment: true, reasoning: true, tool_call: true, temperature: false,
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
  },
  "claude-opus-5-5": {
    name: "Claude Opus 5.5",
    attachment: true, reasoning: true, tool_call: true, temperature: false,
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  },
  "claude-sonnet-5-5": {
    name: "Claude Sonnet 5.5",
    attachment: true, reasoning: true, tool_call: true, temperature: false,
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  },
  "claude-sonnet-5": {
    name: "Claude Sonnet 5",
    attachment: true, reasoning: true, tool_call: true, temperature: false,
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  },
  "claude-opus-4-6": {
    name: "Claude Opus 4.6",
    attachment: true, reasoning: true, tool_call: true, temperature: false,
    limit: { context: 200000, output: 32000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
  "claude-opus-4-5": {
    name: "Claude Opus 4.5",
    attachment: true, reasoning: true, tool_call: true, temperature: false,
    limit: { context: 200000, output: 32000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    attachment: true, reasoning: true, tool_call: true, temperature: false,
    limit: { context: 200000, output: 64000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  },
  "claude-sonnet-4-5": {
    name: "Claude Sonnet 4.5",
    attachment: true, reasoning: true, tool_call: true, temperature: false,
    limit: { context: 200000, output: 8192 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  },
  // Prompts over 100k tokens are billed at 5x these rates; the catalog has one price tier.
  "claude-haiku-5-5": {
    name: "Claude Haiku 5.5",
    attachment: true, reasoning: true, tool_call: true, temperature: false,
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
  },
  "claude-haiku-4-5-20251001": {
    name: "Claude Haiku 4.5",
    attachment: true, reasoning: false, tool_call: true, temperature: true,
    limit: { context: 200000, output: 64000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  },
};

type PluginClient = {
  auth: {
    set: (args: {
      path: { id: string };
      body: Record<string, unknown>;
    }) => Promise<void>;
  };
  /** Present on opencode hosts that expose the TUI control API. */
  tui?: {
    showToast?: (args: {
      body: {
        title?: string;
        message: string;
        variant: "info" | "success" | "warning" | "error";
        duration?: number;
      };
    }) => Promise<unknown>;
  };
};

// ── Helpers ────────────────────────────────────────────────────────

const CLAUDE_PREFIX =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/**
 * Derive a human-readable display name from a Claude model ID.
 *
 * Matches `claude-{family}-{major}[-{minor}][-{date}]` (the convention used
 * for every Claude model family to date) and renders e.g.
 *   claude-opus-4-7            -> "Opus 4.7"
 *   claude-haiku-4-5-20251001  -> "Haiku 4.5"
 *   claude-sonnet-5            -> "Sonnet 5"
 *
 * Falls back to the raw model ID if the convention doesn't match, so future
 * naming changes are surfaced truthfully instead of silently wrong.
 */
export function deriveModelDisplayName(modelId: string): string {
  // Minor is 1-2 digits so a dated major-only id (claude-sonnet-5-20260101) isn't read as "5.20260101".
  const m = modelId.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i);
  if (!m) return modelId;
  const [, family, major, minor] = m;
  const capitalized = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase();
  return minor === undefined ? `${capitalized} ${major}` : `${capitalized} ${major}.${minor}`;
}

/**
 * Rewrite model-identity lines inside the cached Claude Code system prompt
 * so they reflect the model actually being requested. Without this, every
 * request (regardless of selected model) gets a system prompt claiming
 * "You are powered by the model named Sonnet 4.6", which can bias behavior.
 */
export function rewriteSystemBlocksForModel(
  blocks: Array<{ type?: string; text?: string }>,
  modelId: string | undefined,
): Array<{ type?: string; text?: string }> {
  if (!modelId) return blocks;
  const display = deriveModelDisplayName(modelId);

  return blocks.map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    let text = block.text;

    text = text.replace(
      /You are powered by the model named [^\n]+? The exact model ID is [a-z0-9.-]+\./g,
      `You are powered by the model named ${display}. The exact model ID is ${modelId}.`,
    );

    return { ...block, text };
  });
}

// Explicit allowlist: Haiku 4.5 and older sonnet variants (e.g. claude-sonnet-4-5)
// reject the field entirely. Opus 4.x and Sonnet 4.6 are confirmed; Fable 5.x,
// Opus 5.x, Sonnet 5 and Haiku 5.5 are documented as adaptive-thinking models.
const ADAPTIVE_THINKING_MODELS = [
  "claude-opus-4",
  "claude-sonnet-4-6",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-haiku-5",
];

export function supportsAdaptiveThinking(model: unknown): boolean {
  return typeof model === "string" && ADAPTIVE_THINKING_MODELS.some((m) => model.includes(m));
}

const EFFORTS_ABOVE_HIGH = new Set(["xhigh", "max"]);

// Sonnet 5.5 rejects thinking:{type:"disabled"} and {type:"enabled"} (budget_tokens; omo
// builds it for metis, momus and sisyphus-junior) with a 400. "enabled" becomes adaptive;
// "between_tools" is its lowest thinking setting, accepts no other thinking field, and 400s
// at xhigh/max effort.
export function normalizeThinkingForSonnet55(parsed: {
  model?: unknown;
  thinking?: { type?: string; [key: string]: unknown };
  output_config?: { effort?: string; [key: string]: unknown };
}): void {
  if (typeof parsed.model !== "string" || !parsed.model.startsWith("claude-sonnet-5-5")) return;
  if (parsed.thinking?.type === "enabled") {
    const { budget_tokens, ...rest } = parsed.thinking;
    parsed.thinking = { ...rest, type: "adaptive" };
    return;
  }
  if (parsed.thinking?.type === "disabled") parsed.thinking = { type: "between_tools" };
  if (parsed.thinking?.type !== "between_tools") return;
  parsed.thinking = { type: "between_tools" };
  if (parsed.output_config?.effort && EFFORTS_ABOVE_HIGH.has(parsed.output_config.effort)) {
    parsed.output_config.effort = "high";
  }
}

// Haiku 5.5 400s on thinking:{type:"enabled"} (budget_tokens; omo sends it for some Claude
// agents), so that becomes adaptive. "disabled" works at high effort or below, takes no
// other thinking field, and 400s at xhigh/max.
export function normalizeThinkingForHaiku55(parsed: {
  model?: unknown;
  thinking?: { type?: string; [key: string]: unknown };
  output_config?: { effort?: string; [key: string]: unknown };
}): void {
  if (typeof parsed.model !== "string" || !parsed.model.startsWith("claude-haiku-5-5")) return;
  if (parsed.thinking?.type === "enabled") {
    const { budget_tokens, ...rest } = parsed.thinking;
    parsed.thinking = { ...rest, type: "adaptive" };
    return;
  }
  if (parsed.thinking?.type !== "disabled") return;
  parsed.thinking = { type: "disabled" };
  if (parsed.output_config?.effort && EFFORTS_ABOVE_HIGH.has(parsed.output_config.effort)) {
    parsed.output_config.effort = "high";
  }
}

export function stripSystemCacheControl(
  system: Array<{ type?: string; text?: string; cache_control?: unknown }>,
): Array<{ type?: string; text?: string }> {
  return system.map((block) => {
    if (!("cache_control" in block)) return block;
    const { cache_control, ...rest } = block;
    return rest;
  });
}

export function shouldInjectClaudeTools(input: {
  model?: string;
  requestUrl?: string;
  tools?: unknown;
}): boolean {
  if (!shouldUseClaudeToolSchemas({ model: input.model, requestUrl: input.requestUrl })) {
    return false;
  }
  return Array.isArray(input.tools) && input.tools.length > 0;
}

export type OutboundTool = ToolDefinition | { name: string;[key: string]: unknown };

/**
 * Tools with a Claude Code counterpart are swapped for the wire-captured Claude
 * schema; tools without one (plugin/MCP, e.g. DCP's `compress`) keep their own
 * schema rather than being dropped.
 */
export function getClaudeToolsForActiveOpenCodeTools(
  tools: unknown,
): OutboundTool[] {
  if (!Array.isArray(tools)) return [];

  const claudeCatalog = getClaudeTools();
  const claudeCatalogNames = new Set(claudeCatalog.map((tool) => tool.name));

  const matchedClaudeNames = new Set<string>();
  const unmatchedByName = new Map<string, OutboundTool>();

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const name = (tool as { name?: unknown }).name;
    if (typeof name !== "string") continue;

    const claudeName = OUTBOUND_TOOL_NAME_MAP[name] || name;
    if (claudeCatalogNames.has(claudeName)) {
      matchedClaudeNames.add(claudeName);
    } else if (!unmatchedByName.has(name)) {
      unmatchedByName.set(name, tool as OutboundTool);
    }
  }

  // Ordering is deterministic to keep the serialized prefix byte-stable across
  // turns: the bridge strips explicit cache_control and depends entirely on
  // Anthropic's implicit prefix caching.
  const passthrough = [...unmatchedByName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return [
    ...claudeCatalog.filter((tool) => matchedClaudeNames.has(tool.name)),
    ...passthrough,
  ];
}

const oauthProfileCache = new Map<string, Promise<OAuthProfile | null>>();
const SYSTEM_PROMPT_CACHE_PATH = process.env.ANTHROPIC_SYSTEM_PROMPT_PATH
  || join(process.env.HOME || "", ".cache", "opencode-claude-bridge", "claude-system-prompt.json");
const POOL_RECHECK_MS = 30_000;

function buildAuthFailureResponse(detail: string): Response {
  const message = [
    "Claude OAuth credentials are no longer valid.",
    detail,
    "Reconnect 'Claude Pro / Max (OAuth)' in OpenCode or run `claude login` again.",
  ].filter(Boolean).join(" ");

  return new Response(JSON.stringify({
    type: "error",
    error: {
      type: "authentication_error",
      message,
    },
  }), {
    status: 401,
    headers: {
      "content-type": "application/json",
    },
  });
}

/** Persist fresh tokens to OpenCode's auth store. */
async function storeAuth(
  client: PluginClient,
  tokens: { access: string; refresh: string; expires: number },
) {
  await client.auth.set({
    path: { id: "anthropic" },
    body: {
      type: "oauth",
      refresh: tokens.refresh,
      access: tokens.access,
      expires: tokens.expires,
    },
  });
}

/** Layered token refresh: valid keychain access → stored refresh → CLI refresh token. */
async function refreshAuth(
  auth: AuthType,
  client: PluginClient,
): Promise<string | null> {
  type Tokens = { access: string; refresh: string; expires: number };
  let fresh: Tokens | null = null;
  const errors: string[] = [];
  const attemptedRefreshTokens = new Set<string>();

  const tryRefresh = async (refreshToken: string | undefined): Promise<Tokens | null> => {
    if (!refreshToken || attemptedRefreshTokens.has(refreshToken)) return null;
    attemptedRefreshTokens.add(refreshToken);
    return refreshTokens(refreshToken);
  };

  // Layer 1: Claude CLI keychain, but only if the access token is already
  // valid. Expired keychain refresh tokens are often stale after re-login, so
  // do not try them before OpenCode's own stored OAuth refresh token.
  try {
    const kt = getClaudeTokens();
    if (kt && kt.expires > Date.now() + 60_000) fresh = kt;
  } catch (err) {
    errors.push(String(err));
  }

  // Layer 2: Stored refresh token
  if (!fresh && auth.refresh) {
    try { fresh = await tryRefresh(auth.refresh); }
    catch (err) { errors.push(String(err)); }
  }

  // Layer 3: CLI refresh token, only if it differs from tokens already tried.
  if (!fresh) {
    try {
      const creds = readClaudeCredentials();
      if (creds?.claudeAiOauth?.refreshToken)
        fresh = await tryRefresh(creds.claudeAiOauth.refreshToken);
    } catch (err) {
      errors.push(String(err));
    }
  }

  if (fresh) {
    // In memory first: the old refresh token is already spent, so if persisting
    // fails these are the only valid credentials this process has.
    auth.access = fresh.access;
    auth.refresh = fresh.refresh;
    auth.expires = fresh.expires;
    try {
      await storeAuth(client, fresh);
    } catch (err) {
      const detail = err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : String(err);
      console.error(`[opencode-claude-bridge] refreshed tokens could not be saved; they stay valid in memory until restart: ${detail}`);
    }
    return fresh.access;
  }

  if (errors.length > 0) {
    throw new Error(errors[errors.length - 1]);
  }

  return null;
}

/** Best-effort browser open — tries multiple methods on each platform. */
function openBrowser(url: string): void {
  (async () => {
    const { execFileSync } = await import("node:child_process");

    if (process.platform === "darwin") {
      const uid = String(process.getuid?.() ?? "");
      const attempts: Array<[string, () => void]> = [
        ["launchctl asuser", () => execFileSync("/bin/launchctl", ["asuser", uid, "/usr/bin/open", url], { timeout: 5000 })],
        ["open", () => execFileSync("/usr/bin/open", [url], { timeout: 3000 })],
        ["osascript", () => execFileSync("/usr/bin/osascript", ["-e", `open location "${url}"`], { timeout: 3000 })],
      ];
      for (const [name, attempt] of attempts) {
        try { attempt(); break; }
        catch {}
      }
    } else if (process.platform === "win32") {
      try { execFileSync("cmd", ["/c", "start", "", url], { timeout: 3000 }); }
      catch {}
    } else {
      const attempts: Array<[string, () => void]> = [
        ["xdg-open", () => execFileSync("/usr/bin/xdg-open", [url], { timeout: 3000 })],
        ["open", () => execFileSync("/usr/bin/open", [url], { timeout: 3000 })],
      ];
      for (const [name, attempt] of attempts) {
        try { attempt(); break; }
        catch {}
      }
    }
  })().catch(() => {});
}

/** Merge HeadersInit (Headers | string[][] | Record) onto a Headers object. */
function mergeHeaders(target: Headers, source: HeadersInit) {
  if (source instanceof Headers) {
    source.forEach((v, k) => target.set(k, v));
  } else if (Array.isArray(source)) {
    for (const [k, v] of source) {
      if (v !== undefined) target.set(k, String(v));
    }
  } else {
    for (const [k, v] of Object.entries(source)) {
      if (v !== undefined) target.set(k, String(v));
    }
  }
}

function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Pool bookkeeping waits on a cross-process lock that a slow token refresh
// elsewhere can hold past the 10s timeout; that must never fail a request.
async function recordPoolState(what: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.error(`[claude-pool] could not record ${what}; continuing: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function failureSignature(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { type?: unknown; message?: unknown } };
    if (parsed?.error && typeof parsed.error === "object") {
      return `${status}|${String(parsed.error.type ?? "")}|${String(parsed.error.message ?? "")}`;
    }
  } catch {}
  return `${status}|${bodyText.trim().slice(0, 500)}`;
}

/** Build deduplicated beta flags string. */
function buildBetaFlags(existing: string): string {
  // Dropping caller flags makes the API reject newer body fields they gate.
  const split = (s: string) => s.split(",").map((b) => b.trim()).filter(Boolean);
  const merged = [...split(BETA_FLAGS), ...split(existing)];
  const withoutSpecials = merged.filter(
    (beta) => beta !== "claude-code-20250219" && beta !== OAUTH_BETA_FLAG,
  );
  return [...new Set(["claude-code-20250219", OAUTH_BETA_FLAG, ...withoutSpecials])].join(",");
}

/** Deduplicate repeated Claude Code prefix in a text block. */
function deduplicatePrefix(text: string): string {
  const doubled = `${CLAUDE_PREFIX}\n\n${CLAUDE_PREFIX}`;
  while (text.includes(doubled)) {
    text = text.replace(doubled, CLAUDE_PREFIX);
  }
  return text;
}

function mapOutboundToolName(name: string | undefined): string | undefined {
  if (!name) return name;
  return OUTBOUND_TOOL_NAME_MAP[name] || name;
}

function maybeUnquoteText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("\"")) return text;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
  } catch {
    // Expected for non-JSON text — don't log.
  }
  return text;
}

const OPENCODE_CONTINUATION_NUDGE = "Continue with your tasks.";
const ASSISTANT_TAIL_CONTINUATION = "Continue.";

/**
 * The subscription endpoint rejects assistant prefill ("The conversation must
 * end with a user message"). OpenCode's content-free nudge is dropped; any
 * other assistant tail (max-steps notice, a resumed session) is kept and
 * followed by a minimal user turn.
 */
export function stripAssistantPrefillForClaude(
  messages: Array<{ role?: string; content?: unknown }>,
): Array<{ role?: string; content?: unknown }> {
  let result = messages;
  const last = result[result.length - 1];
  if (
    last?.role === "assistant" &&
    typeof last.content === "string" &&
    last.content.trim() === OPENCODE_CONTINUATION_NUDGE
  ) {
    result = result.slice(0, -1);
  }
  if (result[result.length - 1]?.role === "assistant") {
    result = [...result, { role: "user", content: ASSISTANT_TAIL_CONTINUATION }];
  }
  return result;
}

/**
 * OpenCode's prompt-prefix cache breakpoint sits on the tail message. Earlier
 * text breakpoints are stripped (the bridge relies on implicit prefix caching),
 * but removing the tail one too left text-tailed turns never reading the cache.
 * Run before stripAssistantPrefillForClaude so an appended turn doesn't
 * become the "tail" and cost the real tail its marker.
 */
export function stripMessageCacheControlPreservingTail(
  messages: Array<{ content?: unknown }>,
): void {
  for (let index = 0; index < messages.length - 1; index++) {
    const content = messages[index]?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === "text" && "cache_control" in block) delete block.cache_control;
    }
  }
}

/**
 * Claude Code's captured system prompt leads (billing header first), and
 * OpenCode's own system blocks — agent prompt, AGENTS.md, instructions — follow
 * instead of being discarded.
 */
export function mergeClaudeSystemPrompt(
  billingHeader: string,
  claudeBlocks: Array<{ type?: string; text?: string }>,
  opencodeBlocks: Array<{ type?: string; text?: string }>,
): Array<{ type?: string; text?: string }> {
  const own = opencodeBlocks.filter(
    (block) => !block.text?.startsWith("x-anthropic-billing-header:"),
  );
  return [{ type: "text", text: billingHeader }, ...claudeBlocks, ...own];
}

function normalizeSystemBlocks(
  system: Array<{ type?: string; text?: string }>,
): Array<{ type?: string; text?: string }> {
  const normalized = system.map((item) => {
    if (item.type === "text" && item.text) {
      return {
        ...item,
        text: deduplicatePrefix(
          item.text
            .replace(/OpenCode/g, "Claude Code")
            .replace(/opencode/gi, "Claude"),
        ),
      };
    }
    return item;
  });

  const billing = normalized[0];
  const prompt = normalized[1];
  if (
    billing?.type === "text"
    && billing.text?.startsWith("x-anthropic-billing-header:")
    && prompt?.type === "text"
    && prompt.text?.startsWith(`${CLAUDE_PREFIX}\n\n`)
  ) {
    const rest = prompt.text.slice(`${CLAUDE_PREFIX}\n\n`.length);
    return [
      billing,
      { ...prompt, text: CLAUDE_PREFIX },
      { ...prompt, text: rest },
      ...normalized.slice(2),
    ];
  }

  return normalized;
}

function readCachedClaudePromptCache(): ClaudeSystemPromptCache | null {
  try {
    const raw = readFileSync(SYSTEM_PROMPT_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as ClaudeSystemPromptCache;
    if (!Array.isArray(parsed.system) || parsed.system.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

let promptCacheMtime = -1;
let promptCache: ClaudeSystemPromptCache | null = null;

// Re-read when the file changes, so a fresh capture applies without a restart.
function currentPromptCache(): ClaudeSystemPromptCache | null {
  let mtime = 0;
  try {
    mtime = statSync(SYSTEM_PROMPT_CACHE_PATH).mtimeMs;
  } catch {}
  if (mtime !== promptCacheMtime) {
    promptCacheMtime = mtime;
    promptCache = mtime ? readCachedClaudePromptCache() : null;
  }
  return promptCache;
}

export function getStableDeviceId(): string {
  let who = "unknown";
  try {
    who = `${userInfo().username}@${hostname()}`;
  } catch {
    try {
      who = `${process.env.USER || process.env.USERNAME || "unknown"}@${hostname()}`;
    } catch {}
  }
  return createHash("sha256").update(who).digest("hex");
}

function buildBillingHeader(
  sessionId: string,
  cachedClaudePromptCache: ClaudeSystemPromptCache | null,
  dynamicFingerprint?: string,
): string {
  const cch = BILLING_CCH
    || createHash("sha256").update(sessionId).digest("hex").slice(0, 5);
  // Prefer dynamic fingerprint (computed per-request from first user message)
  // over static cached value, matching Claude Code's actual behavior.
  const suffix = dynamicFingerprint
    || cachedClaudePromptCache?.billing?.ccVersionSuffix
    || CLI_BUILD_ID;
  // Deliberately ignores the capture: the API gates model access on this.
  const ccVersion = `${getCliVersion()}.${suffix}`;
  const ccEntrypoint = cachedClaudePromptCache?.billing?.ccEntrypoint || ENTRYPOINT;
  return `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=${ccEntrypoint}; cch=${cch};`;
}

async function fetchOAuthProfile(accessToken: string): Promise<OAuthProfile | null> {
  const cached = oauthProfileCache.get(accessToken);
  if (cached) return cached;

  const pending = (async () => {
    try {
      const response = await globalThis.fetch(PROFILE_URL, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "user-agent": getUserAgent(),
          "anthropic-beta": OAUTH_BETA_FLAG,
        },
      });
      if (!response.ok) return null;
      return await response.json() as OAuthProfile;
    } catch {
      return null;
    }
  })();

  oauthProfileCache.set(accessToken, pending);
  void pending.then((profile) => {
    if (!profile) oauthProfileCache.delete(accessToken);
  });
  return pending;
}

async function buildUserId(token: string, deviceId: string, sessionId: string): Promise<string | undefined> {
  const profile = await fetchOAuthProfile(token);
  if (!profile?.account?.uuid) return undefined;
  return JSON.stringify({
    device_id: deviceId,
    account_uuid: profile.account.uuid,
    session_id: sessionId,
  });
}

function ensureClaudePrefix(system: Array<{ type?: string; text?: string }>): void {
  if (system.some((block) => block.text?.includes(CLAUDE_PREFIX))) return;
  const first = system.find((block) => block.type === "text" && typeof block.text === "string");
  if (first) first.text = `${CLAUDE_PREFIX}\n\n${first.text}`;
  else system.push({ type: "text", text: CLAUDE_PREFIX });
}

export interface PreparedRequest {
  finalUrl: string;
  outHeaders: Record<string, string>;
  body: BodyInit | null | undefined;
  /** True when the bridge, not the caller, set metadata.user_id (so rotation must rebind it). */
  ownsUserId: boolean;
}

/**
 * Rewrite one Anthropic request so it matches Claude Code on the wire: OAuth
 * bearer, Claude Code headers, billing block, system prompt, thinking fields.
 * `claudeTools` swaps in Claude Code's tool schemas and translates historical
 * tool_use blocks; it assumes OpenCode V1's tool names.
 */
export async function prepareRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
  accessToken: string,
  opts: { sessionId: string; deviceId: string; claudeTools: boolean; ensureClaudePrefix: boolean },
): Promise<PreparedRequest> {
  const { sessionId, deviceId } = opts;
  // ── Headers ──
  const headers = new Headers();
  if (input instanceof Request) mergeHeaders(headers, input.headers);
  if (init?.headers) mergeHeaders(headers, init.headers);

  headers.set("authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");
  headers.delete("x-session-affinity");
  headers.delete("x-session-id");
  if (!headers.has("accept")) headers.set("accept", "application/json");
  headers.set("user-agent", getUserAgent());
  headers.set("x-app", "cli");
  headers.set("x-claude-code-session-id", sessionId);
  headers.set("anthropic-version", ANTHROPIC_VERSION);
  headers.set("anthropic-dangerous-direct-browser-access", "true");
  for (const [k, v] of Object.entries(STAINLESS_HEADERS)) headers.set(k, v);
  if (!headers.has("x-stainless-retry-count")) headers.set("x-stainless-retry-count", "0");
  if (!headers.has("x-stainless-timeout")) headers.set("x-stainless-timeout", "600");
  headers.set("anthropic-beta", buildBetaFlags(headers.get("anthropic-beta") || ""));

  // ── Body ──
  const userIdFor = (token: string) => buildUserId(token, deviceId, sessionId);
  let ownsUserId = false;

  let body = init?.body;
  if (body && typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      let requestUrl = "";
      try {
        requestUrl = String(
          new URL(
            typeof input === "string" ? input
            : input instanceof URL ? input.toString()
            : input.url,
          ),
        );
      } catch {}

      const supportsThinking = supportsAdaptiveThinking(parsed.model);
      if (!parsed.thinking && supportsThinking) {
        parsed.thinking = { type: "adaptive" };
      }

      // Anthropic requires temperature=1 when thinking is enabled/adaptive
      const thinkingType = parsed.thinking?.type;
      if (
        (thinkingType === "enabled" || thinkingType === "adaptive") &&
        parsed.temperature !== undefined &&
        parsed.temperature !== 1
      ) {
        parsed.temperature = 1;
      }

      if (typeof parsed.system === "string") {
        parsed.system = [{ type: "text", text: parsed.system }];
      }
      if (!parsed.system) parsed.system = [];
      if (opts.ensureClaudePrefix) ensureClaudePrefix(parsed.system);
      if (Array.isArray(parsed.messages)) {
        stripMessageCacheControlPreservingTail(parsed.messages);
        parsed.messages = stripAssistantPrefillForClaude(parsed.messages);
      }
      // context_management and output_config.effort are only
      // supported by thinking-capable models. Sending them to
      // Haiku 4.5 produces a 400.
      if (supportsThinking) {
        if (!parsed.context_management) {
          parsed.context_management = {
            edits: [{ type: CLEAR_THINKING_TYPE, keep: "all" }],
          };
        }
        if (!parsed.output_config) {
          parsed.output_config = { effort: DEFAULT_EFFORT };
        }
      }
      normalizeThinkingForSonnet55(parsed);
      normalizeThinkingForHaiku55(parsed);

      if (!parsed.metadata) parsed.metadata = {};
      if (!parsed.metadata.user_id) {
        ownsUserId = true;
        const userId = await userIdFor(accessToken);
        if (userId) parsed.metadata.user_id = userId;
      }

      // Compute dynamic fingerprint from the first user message
      // (matches Claude Code's per-request fingerprint behavior).
      let dynamicFingerprint: string | undefined;
      if (parsed.messages && Array.isArray(parsed.messages)) {
        const firstText = extractFirstUserMessageText(parsed.messages);
        if (firstText) {
          dynamicFingerprint = computeFingerprint(firstText);
        }
      }

      // Inject billing header as first system block (required for OAuth).
      const hasBilling = parsed.system.some(
        (s: { text?: string }) =>
          s.text?.startsWith("x-anthropic-billing-header:"),
      );
      const cachedClaudePromptCache = currentPromptCache();
      const cachedClaudeSystem = cachedClaudePromptCache?.system || null;
      let billingHeader = buildBillingHeader(sessionId, cachedClaudePromptCache, dynamicFingerprint);
      if (!hasBilling) {
        parsed.system.unshift({
          type: "text",
          text: billingHeader,
        });
      } else {
        billingHeader = parsed.system[0]?.text || billingHeader;
      }

      // A locally captured Claude Code system prompt leads; OpenCode's
      // own blocks (agent prompt, AGENTS.md) follow it.
      if (cachedClaudeSystem) {
        const rewritten = rewriteSystemBlocksForModel(
          cachedClaudeSystem,
          typeof parsed.model === "string" ? parsed.model : undefined,
        );
        parsed.system = mergeClaudeSystemPrompt(billingHeader, rewritten, parsed.system);
      } else if (parsed.system && Array.isArray(parsed.system)) {
        // Otherwise keep the existing prompt but shape it closer to Claude Code.
        parsed.system = normalizeSystemBlocks(parsed.system);
      }
      parsed.system = stripSystemCacheControl(parsed.system);

      // Keep OpenCode's default tool schemas for non-Claude targets.
      // Claude wire schemas are only useful for Anthropic-native
      // requests or Claude-family models on Anthropic-compatible
      // routers such as OpenRouter.
      if (opts.claudeTools) {
        if (shouldInjectClaudeTools({ model: parsed.model, requestUrl, tools: parsed.tools })) {
          parsed.tools = getClaudeToolsForActiveOpenCodeTools(parsed.tools);
        }
        delete parsed.tool_choice;
      }

      // Normalize message content blocks:
      // - Translate tool names (OpenCode → Claude Code)
      // - Translate tool_use input arguments (camelCase → snake_case)
      // - Clean up text blocks
      if (parsed.messages && Array.isArray(parsed.messages)) {
        for (const msg of parsed.messages) {
          if (!Array.isArray(msg.content)) continue;
          for (const block of msg.content) {
            if (block.type === "text" && typeof block.text === "string") {
              block.text = maybeUnquoteText(block.text);
            }
            if (opts.claudeTools && block.type === "tool_use" && block.name) {
              block.name = mapOutboundToolName(block.name);
              // Consolidated OpenCode → Claude argument translation:
              // key renames, Agent/AskUserQuestion/Skill/WebFetch/TodoWrite
              // field bridging. Mirrors translateToolArgsJsonString
              // (inbound) so round-trips preserve meaning. See
              // translateArgsOpencodeToClaude in claude-tools.ts.
              if (block.input && typeof block.input === "object") {
                block.input = translateArgsOpencodeToClaude(
                  block.name,
                  block.input as Record<string, unknown>,
                );
              }
            }
            // tool_result blocks reference tool names via tool_use_id,
            // no name translation needed here.
          }
        }
      }

      body = JSON.stringify(parsed);
    } catch (err) {
      ownsUserId = false;
      console.error(
        `[opencode-claude-bridge] request rewrite failed; sending the body unmodified: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── URL: add ?beta=true ──
  let requestUrl: URL | null = null;
  try {
    requestUrl = new URL(
      typeof input === "string" ? input
        : input instanceof URL ? input.toString()
        : input.url,
    );
  } catch {}

  if (requestUrl?.pathname === "/messages") {
    requestUrl.pathname = "/v1/messages";
  }
  if (requestUrl?.pathname === "/v1/messages" && !requestUrl.searchParams.has("beta")) {
    requestUrl.searchParams.set("beta", "true");
  }
  const finalUrl = requestUrl?.toString()
    ?? (input instanceof Request ? input.url : String(input));

  const outHeaders: Record<string, string> = {};
  headers.forEach((v, k) => { outHeaders[k] = v; });
  return { finalUrl, outHeaders, body, ownsUserId };
}

export interface SettleInput {
  pool: RotationManager;
  toast: Toaster;
  response: Response;
  activeLabel: string;
  outHeaders: Record<string, string>;
  body: BodyInit | null | undefined;
  ownsUserId: boolean;
  send: (headers: Record<string, string>, body: BodyInit | null | undefined) => Promise<Response>;
  signal?: AbortSignal | null;
  sessionId: string;
  deviceId: string;
}

/**
 * Pool failure handling for one request served by `activeLabel`: retry,
 * rotate or pass through, then record success. Returns the response to hand
 * downstream. Mutates `outHeaders` with the serving account's bearer.
 */
export async function settlePoolResponse(input: SettleInput): Promise<Response> {
  const { pool, toast, outHeaders, ownsUserId, send, signal, sessionId, deviceId } = input;
  let { response, activeLabel, body } = input;
  // Pool-aware failure handling. This runs BEFORE response.body is
  // read below, which is the only point where rotation is safe: once
  // SSE streaming has begun, a second stream's message ids and
  // content-block indices cannot be spliced into the first.
  //
  // Only non-2xx bodies are consumed here (short JSON error
  // envelopes, never a live stream), and they are rebuilt verbatim
  // before being handed downstream.
  if (!response.ok) {
    const maxRotations = (await pool.listLabels()).length;
    let rotations = 0;
    let attempt = 0;
    const tried = new Set<string>();
    // 401/403 penalties wait until another account SUCCEEDS with the same
    // request: an identical failure blames the request, and a 429 or 5xx
    // from the next account says nothing about the first one.
    const unconfirmed: Array<{ label: string; decision: RotationDecision; signature: string }> = [];
    const confirmPenalties = async () => {
      for (const { label, decision } of unconfirmed.splice(0)) {
        await recordPoolState(`penalty for "${label}"`, () => pool.applyDecision(label, decision));
      }
    };
    const unconfirmedLabels = () => unconfirmed.map((u) => `"${u.label}"`).join(", ");

    for (;;) {
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      const bodyText = await response.text();
      const rebuild = () => {
        // response.text() already decoded the body, so carrying the
        // original content-encoding/content-length would describe
        // bytes that no longer exist and corrupt the error downstream.
        const outbound = new Headers(response.headers);
        outbound.delete("content-encoding");
        outbound.delete("content-length");
        return new Response(bodyText, {
          status: response.status,
          statusText: response.statusText,
          headers: outbound,
        });
      };

      const decision = pool.classifyResponse({
        status: response.status,
        headers,
        bodyText,
        now: Date.now(),
        attempt,
      });

      if (decision.action === "PASS_THROUGH") {
        if (unconfirmed.length > 0) {
          console.error(
            `[claude-pool] no other account succeeded, so ${unconfirmedLabels()} ${unconfirmed.length === 1 ? "is" : "are"} not penalised`,
          );
        }
        return rebuild();
      }

      if (decision.action === "RETRY_SAME") {
        attempt += 1;
        console.error(
          `[claude-pool] ${activeLabel}: ${decision.reason}; retrying in ${decision.backoffMs ?? 1000}ms`,
        );
        await abortableSleep(decision.backoffMs ?? 1000, signal);
        response = await send(outHeaders, body);
        if (response.ok) {
          await confirmPenalties();
          break;
        }
        continue;
      }

      // ROTATE_COOLDOWN / ROTATE_DISABLE
      const signature = failureSignature(response.status, bodyText);
      const repeated = unconfirmed.find((u) => u.signature === signature);
      if (repeated) {
        console.error(
          `[claude-pool] "${repeated.label}" and "${activeLabel}" failed identically (HTTP ${response.status}); the request is at fault, not the accounts — passing the error through without penalising either`,
        );
        return rebuild();
      }
      tried.add(activeLabel);

      if (response.status === 401 || response.status === 403) {
        console.error(
          `[claude-pool] ${activeLabel}: ${decision.reason}; checking another account before penalising`,
        );
        unconfirmed.push({ label: activeLabel, decision, signature });
      } else {
        console.error(
          `[claude-pool] ${activeLabel}: ${decision.reason}; rotating account`,
        );
        const penalised = activeLabel;
        await recordPoolState(`penalty for "${penalised}"`, () => pool.applyDecision(penalised, decision));
      }

      rotations += 1;
      if (rotations > maxRotations) return rebuild();

      let next: Awaited<ReturnType<typeof pool.acquire>>;
      try {
        next = await pool.acquire(tried);
      } catch (err) {
        if (!(err instanceof LockTimeoutError)) throw err;
        console.error(`[claude-pool] ${err.message}; passing the current error through`);
        return rebuild();
      }
      if (next.kind === "exhausted" && unconfirmed.length > 0) {
        // Unconfirmed disables need manual repair; surface the real error.
        console.error(
          `[claude-pool] no other account available to confirm ${unconfirmedLabels()} ${unconfirmed.length === 1 ? "is" : "are"} at fault; passing the error through without penalising`,
        );
        return rebuild();
      }
      if (next.kind === "exhausted") {
        const message = pool.describeExhaustion(next.info);
        console.error(`[claude-pool] ${message}`);
        toast("warning", message, `exhausted:${next.info.earliestReset}`);
        return buildPoolExhaustedResponse(
          message,
          next.info.earliestReset,
          Date.now(),
        );
      }

      const why = unconfirmed.at(-1)?.label === activeLabel
        ? `HTTP ${response.status}, checking another account`
        : truncate(decision.reason, 60);
      toast("info", `Switched from "${activeLabel}" to "${next.label}" (${why})`);
      activeLabel = next.label;
      outHeaders["authorization"] = `Bearer ${next.accessToken}`;
      if (ownsUserId && typeof body === "string") {
        const rebound = JSON.parse(body);
        const userId = await buildUserId(next.accessToken, deviceId, sessionId);
        rebound.metadata ??= {};
        if (userId) rebound.metadata.user_id = userId;
        else delete rebound.metadata.user_id;
        body = JSON.stringify(rebound);
      }
      attempt = 0;
      console.error(`[claude-pool] now using account "${activeLabel}"`);
      response = await send(outHeaders, body);
      if (response.ok) {
        await confirmPenalties();
        break;
      }
    }
  }

  if (response.ok) {
    const served = activeLabel;
    await recordPoolState(`success for "${served}"`, () => pool.markSuccess(served));
  }
  return response;
}

export interface StartedPool {
  pool: RotationManager;
  initiallyActive: boolean;
  /** Re-checks enrollment at most every POOL_RECHECK_MS. */
  currentPoolActive: () => Promise<boolean>;
}

/** Pool start-up shared by the V1 and V2 entrypoints. */
export async function startPool(client: PoolClient, toast: Toaster): Promise<StartedPool> {
  // Multi-account pool. Inactive until the user enrolls an account, in which
  // case every path below falls back to the original single-account behaviour.
  const pool: RotationManager = createPool(client, {
    onAccountDisabled: (label, reason) => {
      toast("error", `"${label}" disabled (${truncate(reason, 80)}); re-login, then claude-pool enroll`);
    },
  });
  let poolActive = false;
  try {
    poolActive = await pool.isActive();

    // Adopt a newly logged-in account automatically. Only once the pool is
    // already in use, so installing the plugin never silently captures
    // credentials from someone who has not opted in.
    if (poolActive && process.env.CLAUDE_POOL_AUTO_ENROLL !== "0") {
      const adopted = await autoEnrollIfNew({
        accounts: createAccountStore(createSecretBackend()),
      });
      if (adopted.status === "enrolled") {
        console.error(
          `[claude-pool] auto-enrolled "${adopted.label}" (${adopted.email}) from the Claude CLI`,
        );
        toast("success", `Added "${adopted.label}" (${adopted.email}) to the pool`);
      }
    }

    if (poolActive) {
      await pool.sync();
      const shared = await labelSharingClaudeCliLogin(createAccountStore(createSecretBackend()));
      if (shared) {
        console.error(`[claude-pool] ${sharedLoginWarning(shared)}`);
        toast("warning", sharedLoginWarning(shared));
      }
    }
  } catch (err) {
    console.error(
      `[claude-pool] disabled (${err instanceof Error ? err.message : String(err)})`,
    );
    poolActive = false;
  }

  // Enrolling the first account or removing the last must apply without a
  // restart, but listing the keychain on every request is too slow.
  let poolCheckedAt = Date.now();
  let poolCheckFailing = false;
  const currentPoolActive = async (): Promise<boolean> => {
    if (Date.now() - poolCheckedAt < POOL_RECHECK_MS) return poolActive;
    poolCheckedAt = Date.now();
    try {
      const active = await pool.isActive();
      if (active && !poolActive) await pool.sync();
      poolCheckFailing = false;
      if (active !== poolActive) {
        poolActive = active;
        const note = active
          ? "Accounts enrolled — rotating across the pool"
          : "No accounts enrolled — using the single OpenCode login";
        console.error(`[claude-pool] ${note}`);
        toast("info", note);
      }
    } catch (err) {
      // Keep the last known mode: a locked keychain must not flip it back and forth.
      if (!poolCheckFailing) {
        console.error(
          `[claude-pool] could not re-check enrolled accounts; keeping pool ${poolActive ? "on" : "off"}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      poolCheckFailing = true;
    }
    return poolActive;
  };

  return { pool, initiallyActive: poolActive, currentPoolActive };
}

// ── Plugin ─────────────────────────────────────────────────────────

const OpenCodeClaudeBridge = async ({ client }: { client: PluginClient }) => {
  // Save and clear ANTHROPIC_API_KEY so SDK doesn't bypass our fetch.
  // Restored if OAuth isn't active (API key providers still work).
  const savedApiKey = process.env.ANTHROPIC_API_KEY;
  const sessionId = SESSION_ID || randomUUID();
  const deviceId = getStableDeviceId();

  const toast = createToaster(client);

  const { pool, initiallyActive: poolActive, currentPoolActive } = await startPool(client, toast);

  // Bootstrap auth at plugin init time — before OpenCode builds its provider
  // state — so the loader runs on startup and models appear immediately
  // without requiring a restart.
  //
  // With the pool active we seed from the pool rather than the Claude CLI
  // keychain: that keychain holds whichever account `claude login` last used,
  // so seeding from it would overwrite the active account on every startup and
  // silently undo rotation.
  try {
    if (poolActive) {
      await pool.acquire();
    } else {
      const tokens = getClaudeTokens();
      if (tokens) await storeAuth(client, tokens);
    }
  } catch {}

  return {
    "experimental.chat.system.transform": (
      input: { model?: { providerID: string } },
      output: { system: string[] },
    ) => {
      if (input.model?.providerID !== "anthropic") return;
      if (output.system.some((s) => s.includes(CLAUDE_PREFIX))) return;
      if (output.system.length > 0) {
        output.system[0] = `${CLAUDE_PREFIX}\n\n${output.system[0]}`;
      } else {
        output.system.push(CLAUDE_PREFIX);
      }
    },

    auth: {
      provider: "anthropic",

      async loader(
        getAuth: () => Promise<AuthType>,
        provider: { models: Record<string, ProviderModel> },
      ) {
        // Always inject Claude models — runs before any auth check so models
        // appear in the selector even on a fresh install with no auth configured
        if (provider?.models !== undefined) {
          for (const [id, def] of Object.entries(ANTHROPIC_MODELS)) {
            if (!provider.models[id]) provider.models[id] = { ...def };
          }
        }

        let auth = await getAuth();

        // Auto-bootstrap if no OAuth tokens are stored. With the pool active
        // this seeds from the pool, not the Claude CLI keychain, for the same
        // anti-clobber reason as the init path above.
        if (auth.type !== "oauth") {
          try {
            if (await currentPoolActive()) {
              const acquired = await pool.acquire();
              if (acquired.kind === "ok") auth = await getAuth();
            } else {
              const tokens = getClaudeTokens();
              if (tokens) {
                await storeAuth(client, tokens);
                auth = { type: "oauth", ...tokens };
              }
            }
          } catch {}
        }

        // API key mode — set the key in env and let the SDK handle everything
        if (auth.type === "apikey" && auth.access) {
          process.env.ANTHROPIC_API_KEY = auth.access;
          return {};
        }

        if (auth.type !== "oauth") {
          // Not configured — restore env API key if present so SDK can use it
          if (savedApiKey) process.env.ANTHROPIC_API_KEY = savedApiKey;
          return {};
        }

        // OAuth active — set a placeholder so the SDK doesn't error on missing key.
        // Our fetch wrapper sets the real Authorization: Bearer header and removes x-api-key.
        process.env.ANTHROPIC_API_KEY = "oauth-placeholder";

        return {
          // OpenCode 1.4.0 now rejects Anthropic provider config when both an
          // apiKey and authToken are present. Keep the placeholder apiKey for
          // provider init, and let the fetch wrapper supply the real bearer token.
          async fetch(input: string | URL | Request, init?: RequestInit) {
            const auth = await getAuth();
            if (auth.type !== "oauth") return fetch(input, init);

            let accessToken = auth.access || null;
            // Label of the pool account serving this request, so a later
            // rate-limit response can be attributed to the right account.
            let activeLabel: string | null = null;
            const usePool = await currentPoolActive();

            if (usePool) {
              let acquired: Awaited<ReturnType<typeof pool.acquire>>;
              try {
                acquired = await pool.acquire();
              } catch (err) {
                if (!(err instanceof LockTimeoutError)) throw err;
                console.error(`[claude-pool] ${err.message}`);
                return buildPoolBusyResponse();
              }
              if (acquired.kind === "exhausted") {
                const message = pool.describeExhaustion(acquired.info);
                console.error(`[claude-pool] ${message}`);
                toast("warning", message, `exhausted:${acquired.info.earliestReset}`);
                return buildPoolExhaustedResponse(
                  message,
                  acquired.info.earliestReset,
                  Date.now(),
                );
              }
              activeLabel = acquired.label;
              accessToken = acquired.accessToken;
            } else if (!accessToken || !auth.expires || auth.expires < Date.now() + 60_000) {
              try {
                accessToken = await refreshAuth(auth, client);
              } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                console.error(`[opencode-claude-bridge] OAuth refresh failed: ${detail}`);
                return buildAuthFailureResponse(detail);
              }
            }

            if (!accessToken) {
              return buildAuthFailureResponse("No usable OAuth access token is available.");
            }

            const prepared = await prepareRequest(input, init, accessToken, {
              sessionId, deviceId, claudeTools: true, ensureClaudePrefix: false,
            });
            const { finalUrl, outHeaders, body } = prepared;

            // ── Request (with 429 auto-refresh retry) ──
            const doFetch = () => globalThis.fetch(finalUrl, {
              method: init?.method || "POST",
              body,
              headers: outHeaders,
              signal: init?.signal,
            });

            let response = await doFetch();

            if (usePool && activeLabel) {
              response = await settlePoolResponse({
                pool, toast, response, activeLabel, outHeaders, body,
                ownsUserId: prepared.ownsUserId,
                send: (headers, sendBody) => globalThis.fetch(finalUrl, {
                  method: init?.method || "POST", body: sendBody, headers, signal: init?.signal,
                }),
                signal: init?.signal, sessionId, deviceId,
              });
            }

            if (!usePool && response.status === 401) {
              console.error("[opencode-claude-bridge] 401 from Anthropic; refreshing token and retrying once");
              let freshToken: string | null = null;
              try {
                freshToken = await refreshAuth(auth, client);
              } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                console.error(`[opencode-claude-bridge] OAuth refresh failed after 401: ${detail}`);
                await response.body?.cancel();
                return buildAuthFailureResponse(detail);
              }
              if (freshToken && freshToken !== accessToken) {
                await response.body?.cancel();
                outHeaders["authorization"] = `Bearer ${freshToken}`;
                response = await doFetch();
              }
            }

            // Single-account path: retry 429 (rate limited) and 529 (overloaded)
            // as long as Retry-After asks. A longer wait is handed back at once,
            // so a 429 resetting in hours neither blocks the request nor spends
            // a single-use refresh token for nothing.
            for (
              let retry = 0;
              !usePool && retry < MAX_RESPONSE_RETRIES && RETRYABLE_STATUSES.has(response.status);
              retry++
            ) {
              const delayMs = getResponseRetryDelayMs(response.headers, retry);
              if (delayMs === null) break;
              const attempt = `attempt ${retry + 1}/${MAX_RESPONSE_RETRIES}`;
              if (response.status === 429) {
                // Rate limits may be per access token, so a fresh one can help.
                console.error(`[opencode-claude-bridge] 429 rate limited (${attempt}), refreshing token...`);
                let freshToken: string | null = null;
                try {
                  freshToken = await refreshAuth(auth, client);
                } catch (err) {
                  const detail = err instanceof Error ? err.message : String(err);
                  console.error(`[opencode-claude-bridge] OAuth refresh failed after 429: ${detail}`);
                  await response.body?.cancel();
                  return buildAuthFailureResponse(detail);
                }
                if (!freshToken) {
                  console.error("[opencode-claude-bridge] Token refresh failed, returning 429");
                  break;
                }
                outHeaders["authorization"] = `Bearer ${freshToken}`;
              } else {
                console.error(`[opencode-claude-bridge] ${response.status} overloaded (${attempt}), retrying in ${Math.ceil(delayMs / 1000)}s`);
              }
              await response.body?.cancel();
              await abortableSleep(delayMs, init?.signal);
              response = await doFetch();
            }

            // ── Map Claude-style tool names and arguments back to OpenCode ──
            if (!response.body) return response;

            // Tool_use arguments are buffered and translated whole at
            // content_block_stop, since fragments split mid-key (e.g. "file_" +
            // "path"). See src/stream.ts.
            return new Response(
              translateSseStream(response.body, {
                inboundToolNameMap: INBOUND_TOOL_NAME_MAP,
                translateToolArgs: translateToolArgsJsonString,
                debug: (msg) => console.error(`[opencode-claude-bridge] stream: ${msg}`),
              }),
              { status: response.status, statusText: response.statusText, headers: response.headers },
            );
          },
        };
      },

      methods: [
        {
          label: "Claude Pro / Max (OAuth)",
          type: "oauth" as const,
          authorize: async () => {
            // First try: auto-bootstrap from Claude CLI keychain
            const tokens = getClaudeTokens();
            if (tokens) {
              await storeAuth(client, tokens);
              return {
                instructions: "Connected via Claude CLI — press Esc, then restart OpenCode if Anthropic models aren't visible",
                method: "code" as const,
                callback: async () => ({ type: "success" as const, ...tokens }),
              };
            }

            // Start a local HTTP server to capture the OAuth redirect.
            // This gives us an ephemeral port so the redirect_uri is
            // http://localhost:{port}/callback — matching Claude Code's flow.
            let callbackServer: Awaited<ReturnType<typeof startOAuthCallbackServer>> | null = null;
            try {
              callbackServer = await startOAuthCallbackServer();
            } catch (err) {
              console.error(`[opencode-oauth] Failed to start callback server: ${err}`);
            }

            if (callbackServer) {
              const { url, manualUrl, verifier, port, state } = callbackServer;
              const redirectUri = `http://localhost:${port}/callback`;

              // Best-effort browser open
              openBrowser(url);

              // Race: localhost callback vs manual code paste.
              // If the browser redirects to localhost, the callback server
              // captures the code automatically. Otherwise, the user can
              // paste the code from the manual-flow URL.
              //
              // We set up the automatic flow listener in the background.
              // If the user pastes a code first, that wins.
              let autoCode: string | null = null;
              callbackServer.waitForCode().then((code) => {
                autoCode = code;
              }).catch(() => {});

              return {
                url,
                instructions: `Opening browser for OAuth...\n\nIf the browser redirected back successfully, just press Enter.\nOtherwise, open this URL and paste the code:\n${manualUrl}`,
                method: "code" as const,
                callback: async (manualInput: string) => {
                  try {
                    // Brief pause to let the auto-flow resolve if it just arrived
                    if (!autoCode && !manualInput?.trim()) {
                      await new Promise((r) => setTimeout(r, 500));
                    }

                    if (autoCode) {
                      // Auto-flow captured the code via localhost redirect
                      const tokens = await exchangeCodeForTokens(autoCode, verifier, redirectUri);
                      await storeAuth(client, tokens);
                      callbackServer?.close();
                      return { type: "success" as const, ...tokens };
                    }

                    const pastedState = parsePastedState(manualInput);
                    if (pastedState !== null && pastedState !== state) {
                      console.error("[opencode-oauth] Pasted code belongs to a different login attempt (state mismatch)");
                      callbackServer?.close();
                      return { type: "failed" as const };
                    }
                    const code = parseAuthCode(manualInput);
                    if (!code) {
                      console.error("[opencode-oauth] No authorization code received");
                      callbackServer?.close();
                      return { type: "failed" as const };
                    }

                    // Manual flow — redirect_uri defaults to MANUAL_REDIRECT_URL
                    const tokens = await exchangeCodeForTokens(code, verifier);
                    await storeAuth(client, tokens);
                    callbackServer?.close();
                    return { type: "success" as const, ...tokens };
                  } catch (err) {
                    console.error(`[opencode-oauth] Token exchange failed: ${err}`);
                    callbackServer?.close();
                    return { type: "failed" as const };
                  }
                },
              };
            }

            // Fallback: no callback server — use manual redirect URL flow only.
            // This is the path for environments where we can't bind localhost.
            const { url, verifier, state } = createAuthorizationRequest();

            openBrowser(url);

            return {
              url,
              instructions: `Opening browser for OAuth...\n\nAfter authorizing, you'll see a code — paste it below:\n${url}`,
              method: "code" as const,
              callback: async (code: string) => {
                try {
                  const pastedState = parsePastedState(code);
                  if (pastedState !== null && pastedState !== state) {
                    console.error("[opencode-oauth] Pasted code belongs to a different login attempt (state mismatch)");
                    return { type: "failed" as const };
                  }
                  // redirect_uri defaults to MANUAL_REDIRECT_URL in exchangeCodeForTokens
                  const tokens = await exchangeCodeForTokens(parseAuthCode(code), verifier);
                  await storeAuth(client, tokens);
                  return { type: "success" as const, ...tokens };
                } catch (err) {
                  console.error(`[opencode-oauth] Token exchange failed: ${err}`);
                  return { type: "failed" as const };
                }
              },
            };
          },
        },
        {
          label: "Claude API Key",
          type: "oauth" as const,
          authorize: async () => {
            // Auto-detect from environment
            const envKey = process.env.ANTHROPIC_API_KEY || savedApiKey;
            if (envKey) {
              await client.auth.set({
                path: { id: "anthropic" },
                body: { type: "apikey", access: envKey, expires: Date.now() + 365 * 24 * 60 * 60 * 1000 },
              });
              return {
                instructions: "✓ API key found in environment — press Esc, then restart OpenCode if Anthropic models aren't visible",
                method: "code" as const,
                callback: async () => ({ type: "success" as const, access: envKey, refresh: "", expires: Date.now() + 365 * 24 * 60 * 60 * 1000 }),
              };
            }
            // Prompt user to paste key
            return {
              instructions: "Paste your Anthropic API key (sk-ant-...):",
              method: "code" as const,
              callback: async (key: string) => {
                const k = key.trim();
                if (!k) return { type: "failed" as const };
                await client.auth.set({
                  path: { id: "anthropic" },
                  body: { type: "apikey", access: k, expires: Date.now() + 365 * 24 * 60 * 60 * 1000 },
                });
                return { type: "success" as const, access: k, refresh: "", expires: Date.now() + 365 * 24 * 60 * 60 * 1000 };
              },
            };
          },
        },
      ],
    },
  };
};

export default OpenCodeClaudeBridge;
