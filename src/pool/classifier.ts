import type { ClassifyInput, DecisionSource, RotationDecision } from "./types.js";

export const RETRY_SAME_MAX_RESET_SECONDS = 60;
export const DEFAULT_UNKNOWN_COOLDOWN_MS = 3_600_000;
export const MAX_TRANSIENT_ATTEMPTS = 3;

export const UNIFIED_RESET_HEADERS = [
  "anthropic-ratelimit-unified-reset",
  "anthropic-ratelimit-unified-5h-reset",
] as const;

const TOKEN_RESET_HEADERS = [
  "anthropic-ratelimit-input-tokens-reset",
  "anthropic-ratelimit-output-tokens-reset",
] as const;

const ACCOUNT_DISABLED_MARKERS = [
  "suspended",
  "disabled",
  "banned",
  "deactivated",
  "revoked",
] as const;

interface ResetWindow {
  seconds: number;
  source: DecisionSource;
}

function passThrough(reason: string): RotationDecision {
  return { action: "PASS_THROUGH", reason, source: "status" };
}

function finiteNow(now: unknown): number {
  return typeof now === "number" && Number.isFinite(now) ? now : 0;
}

function readHeader(headers: unknown, name: string): unknown {
  try {
    if (typeof headers !== "object" || headers === null) return undefined;
    return Reflect.get(headers, name);
  } catch {
    return undefined;
  }
}

function normalizeResetValue(value: unknown, now: number): number | undefined {
  try {
    const text = typeof value === "number" ? String(value) : value;
    if (typeof text !== "string") return undefined;

    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;

    if (/^[+-]?\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) return undefined;

      let seconds: number;
      if (numeric >= 1_000_000_000_000) {
        seconds = (numeric - now) / 1000;
      } else if (numeric >= 1_000_000_000) {
        seconds = numeric - now / 1000;
      } else {
        seconds = numeric;
      }

      return Number.isFinite(seconds) ? Math.max(0, seconds) : undefined;
    }

    const timestamp = Date.parse(trimmed);
    if (!Number.isFinite(timestamp)) return undefined;

    const seconds = (timestamp - now) / 1000;
    return Number.isFinite(seconds) ? Math.max(0, seconds) : undefined;
  } catch {
    return undefined;
  }
}

function resolveRetryAfter(headers: unknown, now: number): ResetWindow | undefined {
  try {
    const seconds = normalizeResetValue(readHeader(headers, "retry-after"), now);
    return seconds === undefined ? undefined : { seconds, source: "retry-after" };
  } catch {
    return undefined;
  }
}

function resolveUnifiedReset(headers: unknown, now: number): ResetWindow | undefined {
  try {
    for (const name of UNIFIED_RESET_HEADERS) {
      const seconds = normalizeResetValue(readHeader(headers, name), now);
      if (seconds !== undefined) return { seconds, source: "unified-reset" };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function resolveTokenReset(headers: unknown, now: number): ResetWindow | undefined {
  try {
    const resets = TOKEN_RESET_HEADERS.map((name) =>
      normalizeResetValue(readHeader(headers, name), now),
    ).filter((value): value is number => value !== undefined);

    return resets.length === 0
      ? undefined
      : { seconds: Math.max(...resets), source: "token-reset" };
  } catch {
    return undefined;
  }
}

function durationFromMessage(message: unknown): number | undefined {
  try {
    if (typeof message !== "string") return undefined;

    const match = message.match(
      /(?:in|after)?\s*(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i,
    );
    if (!match) return undefined;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount < 0) return undefined;

    const unit = match[2].toLowerCase();
    let multiplier: number;
    if (unit === "ms" || unit.startsWith("millisecond")) multiplier = 0.001;
    else if (unit === "s" || unit.startsWith("sec")) multiplier = 1;
    else if (unit === "m" || unit.startsWith("min")) multiplier = 60;
    else if (unit === "h" || unit.startsWith("hr") || unit.startsWith("hour")) multiplier = 3600;
    else multiplier = 86_400;

    const seconds = amount * multiplier;
    return Number.isFinite(seconds) ? seconds : undefined;
  } catch {
    return undefined;
  }
}

function timestampFromMessage(message: unknown, now: number): number | undefined {
  try {
    if (typeof message !== "string") return undefined;

    const timestamp = message.match(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/i,
    )?.[0];
    if (timestamp !== undefined) return normalizeResetValue(timestamp, now);

    const epoch = message.match(/\b\d{10,13}\b/)?.[0];
    return epoch === undefined ? undefined : normalizeResetValue(epoch, now);
  } catch {
    return undefined;
  }
}

function findResetField(root: unknown, now: number): number | undefined {
  try {
    const queue: unknown[] = [root];
    let visited = 0;

    while (queue.length > 0 && visited < 10_000) {
      const current = queue.shift();
      visited += 1;
      if (typeof current !== "object" || current === null) continue;

      for (const [key, value] of Object.entries(current)) {
        if (key === "resetsAt" || key === "reset_at") {
          const seconds = normalizeResetValue(value, now);
          if (seconds !== undefined) return seconds;
        }
        if (typeof value === "object" && value !== null) queue.push(value);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function resolveBodyHint(bodyText: unknown, now: number): ResetWindow | undefined {
  let parsed: unknown;
  try {
    if (typeof bodyText !== "string") return undefined;
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return undefined;
  }

  try {
    let message: unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const error = Reflect.get(parsed, "error");
      if (typeof error === "object" && error !== null) message = Reflect.get(error, "message");
    }

    const seconds =
      durationFromMessage(message) ??
      timestampFromMessage(message, now) ??
      findResetField(parsed, now);
    return seconds === undefined ? undefined : { seconds, source: "body-hint" };
  } catch {
    return undefined;
  }
}

function safeDurationMs(seconds: number): number {
  const milliseconds = seconds * 1000;
  return Number.isFinite(milliseconds) ? milliseconds : Number.MAX_SAFE_INTEGER;
}

function safeUntil(now: number, durationMs: number): number {
  const until = now + durationMs;
  return Number.isFinite(until) ? until : Number.MAX_SAFE_INTEGER;
}

function decisionFromReset(reset: ResetWindow, now: number): RotationDecision {
  const durationMs = safeDurationMs(reset.seconds);
  if (reset.seconds <= RETRY_SAME_MAX_RESET_SECONDS) {
    return {
      action: "RETRY_SAME",
      backoffMs: Math.max(1000, durationMs),
      reason: `Rate limit resets in ${reset.seconds} seconds`,
      source: reset.source,
    };
  }

  return {
    action: "ROTATE_COOLDOWN",
    until: safeUntil(now, durationMs),
    reason: `Account rate limit resets in ${reset.seconds} seconds`,
    source: reset.source,
  };
}

function classifyInternal(input: ClassifyInput): RotationDecision {
  const status = input.status;
  const now = finiteNow(input.now);

  if (status >= 200 && status < 300) return passThrough("Successful response");

  // OAuth refresh already ran upstream; passing 401 through preserves genuine auth errors.
  if (status === 401) return passThrough("Authentication error after upstream refresh");

  if (status === 403) {
    const body = typeof input.bodyText === "string" ? input.bodyText.toLowerCase() : "";
    const marker = ACCOUNT_DISABLED_MARKERS.find((candidate) => body.includes(candidate));
    if (marker !== undefined) {
      return {
        action: "ROTATE_DISABLE",
        reason: `Account appears ${marker}`,
        source: "body-hint",
      };
    }
    return {
      action: "ROTATE_COOLDOWN",
      until: safeUntil(now, DEFAULT_UNKNOWN_COOLDOWN_MS),
      reason: "Forbidden response without a permanent account marker",
      source: "default",
    };
  }

  if (status === 429) {
    const reset =
      resolveRetryAfter(input.headers, now) ??
      resolveUnifiedReset(input.headers, now) ??
      resolveTokenReset(input.headers, now) ??
      resolveBodyHint(input.bodyText, now);

    if (reset !== undefined) return decisionFromReset(reset, now);
    return {
      action: "ROTATE_COOLDOWN",
      until: safeUntil(now, DEFAULT_UNKNOWN_COOLDOWN_MS),
      reason: "Rate limit reset is unknown; conservatively cooling the account",
      source: "default",
    };
  }

  if (status >= 500 && status < 600) {
    const attempt =
      typeof input.attempt === "number" && Number.isFinite(input.attempt) && input.attempt >= 0
        ? Math.floor(input.attempt)
        : 0;
    if (attempt < MAX_TRANSIENT_ATTEMPTS) {
      return {
        action: "RETRY_SAME",
        backoffMs: 1000 * 2 ** attempt,
        reason: `Transient server error; retry attempt ${attempt + 1}`,
        source: "status",
      };
    }
    return passThrough("Transient retry limit reached");
  }

  return passThrough("Response status does not trigger rotation");
}

export function classify(input: ClassifyInput): RotationDecision {
  try {
    if (typeof input !== "object" || input === null) return passThrough("Invalid classifier input");
    return classifyInternal(input);
  } catch {
    return passThrough("Classifier could not safely inspect the response");
  }
}
