/**
 * Shared type contract for the multi-account credential pool.
 *
 * Design invariants (see docs in manager.ts for rationale):
 *  - The pool store is the SOURCE OF TRUTH for credentials.
 *    OpenCode's single `anthropic` slot in auth.json is a DERIVED CACHE
 *    that mirrors whichever account is currently active.
 *  - Cold secrets (tokens) and hot state (cooldowns) are stored SEPARATELY.
 *    Cold changes only on token rotation; hot changes on every rate-limit hit.
 *    Keeping them apart avoids rewriting secret material on every 429, which
 *    would multiply the window in which a rotating refresh token can be lost.
 *  - Anthropic's OAuth refresh returns a NEW refresh token and invalidates the
 *    old one. Losing a refresh token permanently bricks that account, so every
 *    write path that touches `oauth.refresh` must be atomic and journalled.
 */

/** Service name used for pool entries in the macOS keychain. */
export const POOL_KEYCHAIN_SERVICE = "opencode-claude-bridge";

/** Current on-disk schema version for {@link RotationState}. */
export const ROTATION_STATE_VERSION = 1;

// ── Credentials (cold store) ────────────────────────────────────────

/**
 * OAuth token triple for a single Claude account.
 * `expires` is epoch MILLISECONDS, matching opencode's auth.json convention
 * and the Claude CLI keychain's `expiresAt`.
 */
export interface PoolOAuthTokens {
  access: string;
  refresh: string;
  expires: number;
}

/**
 * One enrolled Claude account. Serialized as JSON and stored as the secret
 * value of a single keychain item (or one 0600 file on non-darwin).
 */
export interface AccountRecord {
  /** Stable user-chosen identifier, e.g. "alice". Also the keychain `acct`. */
  label: string;
  oauth: PoolOAuthTokens;
  /** From the Claude CLI credentials, e.g. "max". Informational only. */
  subscriptionType?: string;
  /** From the Claude CLI credentials, e.g. "default_claude_max_20x". */
  rateLimitTier?: string;
  scopes?: string[];
  /** Epoch ms when this account was snapshotted into the pool. */
  enrolledAt: number;
}

// ── Rotation state (hot store) ──────────────────────────────────────

/** Mutable per-account scheduling state. Contains NO secret material. */
export interface AccountState {
  /**
   * Epoch ms until which this account must not be used. `null` = available.
   * Set from a 429's reset window so we can schedule the account's return
   * rather than blindly probing it.
   */
  cooldownUntil: number | null;
  /** Permanently excluded (revoked / suspended / flagged). Needs operator action. */
  disabled: boolean;
  /** Consecutive failures; reset on success. Diagnostics only. */
  failureCount: number;
  /** Human-readable explanation of the last cooldown/disable. */
  lastReason: string | null;
  /** Epoch ms of the last mutation. */
  updatedAt: number;
}

export interface RotationState {
  version: number;
  /** Label of the account currently mirrored into auth.json. */
  activeLabel: string | null;
  accounts: Record<string, AccountState>;
}

// ── Classifier ──────────────────────────────────────────────────────

/**
 * What to do with a non-2xx response from the Anthropic Messages API.
 *
 * IMPORTANT: these decisions are only actionable BEFORE the response body has
 * been read. Once SSE streaming has begun, rotation would corrupt the stream
 * (message ids / content-block indices from a second stream cannot be spliced
 * into the first), so mid-stream errors are always passed through.
 */
export type RotationAction =
  /** Transient limit. Back off, then retry the SAME account. */
  | "RETRY_SAME"
  /** Usage window exhausted. Cool this account down and switch accounts. */
  | "ROTATE_COOLDOWN"
  /** Credential revoked or account flagged. Exclude permanently, switch. */
  | "ROTATE_DISABLE"
  /** Not our concern. Hand the response to the caller untouched. */
  | "PASS_THROUGH";

/**
 * Which rung of the fallback ladder produced this decision.
 * Recorded for observability and asserted in tests, because the
 * subscription-tier rate-limit headers are not publicly documented and we
 * must be able to tell a real signal from a defaulted guess.
 */
export type DecisionSource =
  | "retry-after"
  | "unified-reset"
  | "token-reset"
  | "body-hint"
  | "default"
  | "status";

export interface RotationDecision {
  action: RotationAction;
  /** For RETRY_SAME: how long to wait before retrying. */
  backoffMs?: number;
  /** For ROTATE_COOLDOWN: epoch ms when the account becomes usable again. */
  until?: number;
  /** Human-readable justification, surfaced in logs and error responses. */
  reason: string;
  source: DecisionSource;
}

/** Input to the pure classifier. `headers` keys MUST be lowercased by the caller. */
export interface ClassifyInput {
  status: number;
  headers: Record<string, string>;
  /** Response body. Only ever populated for non-2xx responses. */
  bodyText?: string;
  /** Injected clock (epoch ms) so classification is deterministic in tests. */
  now: number;
  /** Consecutive RETRY_SAME attempts already made for this request. */
  attempt?: number;
}

// ── Selection ───────────────────────────────────────────────────────

export type SelectionResult =
  | { kind: "selected"; label: string }
  | {
      kind: "exhausted";
      /** Earliest epoch ms at which any cooling account frees up; null if all disabled. */
      earliestReset: number | null;
      /** Labels currently cooling down, for the fail-fast error message. */
      cooling: Array<{ label: string; until: number }>;
      /** Labels permanently disabled. */
      disabled: string[];
    };

// ── Storage backend ─────────────────────────────────────────────────

/**
 * Minimal secret persistence interface. Production uses the macOS keychain via
 * the `security` binary; tests inject an in-memory Map; non-darwin uses a
 * 0600 file. Kept deliberately tiny so faking it is trivial.
 */
export interface SecretBackend {
  get(label: string): Promise<string | null>;
  set(label: string, value: string): Promise<void>;
  remove(label: string): Promise<void>;
  list(): Promise<string[]>;
}

/** Injectable clock, so every time-dependent path is testable. */
export type Clock = () => number;
