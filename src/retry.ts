/** Rate limited and overloaded: the statuses retried in place. */
export const RETRYABLE_STATUSES = new Set([429, 529]);

/** Retries per request before the response goes back to OpenCode. */
export const MAX_RESPONSE_RETRIES = 2;

/**
 * Longest wait absorbed inside one request. A longer Retry-After (e.g. a usage
 * window resetting in hours) is returned at once so OpenCode's own retry,
 * which shows the wait and can be cancelled, takes over.
 */
export const MAX_RETRY_DELAY_MS = 10_000;

function overloadedBackoffMs(attempt: number): number {
  return Math.min(2000 * 2 ** attempt, 8000);
}

/** Parse Retry-After (delay seconds or an HTTP date) into milliseconds. */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value?.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(date - now, 0) : null;
}

/** Delay before retrying a response, or null when it should be returned as-is. */
export function getResponseRetryDelayMs(
  headers: Headers,
  attempt: number,
  now = Date.now(),
): number | null {
  const delayMs = parseRetryAfterMs(headers.get("retry-after"), now) ?? overloadedBackoffMs(attempt);
  return delayMs > MAX_RETRY_DELAY_MS ? null : delayMs;
}

/** Delay before retrying the token endpoint, honouring `retry_after` in its body. */
export function getTokenRetryDelayMs(
  status: number,
  body: string,
  attempt: number,
  random = Math.random(),
): number | null {
  let requestedMs: number | null = null;
  try {
    const parsed = JSON.parse(body) as {
      retry_after?: number | string;
      error?: { retry_after?: number | string };
    };
    const seconds = Number(parsed.retry_after ?? parsed.error?.retry_after);
    if (Number.isFinite(seconds) && seconds >= 0) requestedMs = seconds * 1000;
  } catch {
    // Not JSON: fall back to backoff.
  }
  const delayMs = requestedMs
    ?? (status === 529 ? overloadedBackoffMs(attempt) : 1000 * 2 ** attempt + random * 1000);
  return delayMs > MAX_RETRY_DELAY_MS ? null : delayMs;
}
