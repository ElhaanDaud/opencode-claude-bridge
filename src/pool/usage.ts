/**
 * Per-account subscription usage, as shown by Claude Code's `/usage`.
 *
 * Source: `GET https://api.anthropic.com/api/oauth/usage` with the account's
 * OAuth access token. Returns utilization percentages and reset times for the
 * rolling 5-hour and 7-day windows.
 *
 * This is the only way to get UTILIZATION. Rate-limit response headers disclose
 * reset times but not how much of a window is spent, and they only appear once
 * you are already being throttled — too late to be useful as a gauge.
 */

export const USAGE_URL =
  process.env.ANTHROPIC_USAGE_URL ?? "https://api.anthropic.com/api/oauth/usage";

const USAGE_TIMEOUT_MS = 10_000;

/** One usage window. `utilization` is a percentage, 0-100. */
export interface UsageWindow {
  utilization: number;
  resetsAt: number | null;
  lockedReason: string | null;
}

export interface AccountUsage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** Model-specific windows, only present on some plans. */
  sevenDayOpus: UsageWindow | null;
  fetchedAt: number;
}

interface RawWindow {
  utilization?: unknown;
  resets_at?: unknown;
  locked_reason?: unknown;
}

function parseWindow(raw: unknown): UsageWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const window = raw as RawWindow;
  const utilization = typeof window.utilization === "number" ? window.utilization : null;
  if (utilization === null) return null;

  let resetsAt: number | null = null;
  if (typeof window.resets_at === "string") {
    const parsed = Date.parse(window.resets_at);
    if (Number.isFinite(parsed)) resetsAt = parsed;
  }

  return {
    // Clamp: a bar is a fixed-width widget and out-of-range input would
    // either overflow the row or render negative.
    utilization: Math.max(0, Math.min(100, utilization)),
    resetsAt,
    lockedReason:
      typeof window.locked_reason === "string" ? window.locked_reason : null,
  };
}

export function parseUsage(body: unknown, now: number): AccountUsage {
  const root = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  return {
    fiveHour: parseWindow(root.five_hour),
    sevenDay: parseWindow(root.seven_day),
    sevenDayOpus: parseWindow(root.seven_day_opus),
    fetchedAt: now,
  };
}

/**
 * Fetch usage for one access token.
 *
 * Throws on a non-2xx so the caller can distinguish "expired token" from
 * "no usage data". Times out rather than hanging the UI.
 */
export async function fetchUsage(
  accessToken: string,
  opts: { url?: string; now?: () => number; fetchImpl?: typeof fetch } = {},
): Promise<AccountUsage> {
  const url = opts.url ?? USAGE_URL;
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
  try {
    const response = await doFetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`usage request failed (${response.status})`);
    }
    return parseUsage(await response.json(), now());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render a fixed-width meter. Uses eighth-blocks so a 20-cell bar still shows
 * single-percent movement; falls back to ASCII when the terminal is limited.
 */
export function renderBar(
  utilization: number,
  width: number,
  ascii = false,
): string {
  const clamped = Math.max(0, Math.min(100, utilization));
  const cells = Math.max(1, width);
  if (ascii) {
    const filled = Math.round((clamped / 100) * cells);
    return `${"#".repeat(filled)}${"-".repeat(cells - filled)}`;
  }
  const exact = (clamped / 100) * cells;
  const full = Math.floor(exact);
  const remainder = exact - full;
  const partials = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const partial = full < cells ? partials[Math.floor(remainder * 8)] ?? "" : "";
  const used = "█".repeat(full) + partial;
  return used.padEnd(cells, "░").slice(0, cells);
}
