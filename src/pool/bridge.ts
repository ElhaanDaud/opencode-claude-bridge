import { refreshTokens } from "../oauth.js";
import { createRotationManager } from "./manager.js";
import { createRotationStateStore, defaultLockPath, defaultStatePath } from "./rotation-state.js";
import { createAccountStore, createSecretBackend } from "./secret-store.js";
import type { ManagerOptions, RotationManager } from "./manager.js";
import type { PoolOAuthTokens } from "./types.js";

export interface PoolClient {
  auth: {
    set(input: {
      path: { id: string };
      body: { type: string; refresh: string; access: string; expires: number };
    }): Promise<unknown>;
  };
}

export function createPool(
  client: PoolClient,
  hooks: Pick<ManagerOptions, "onAccountDisabled"> = {},
): RotationManager {
  const accounts = createAccountStore(createSecretBackend());
  const state = createRotationStateStore({ path: defaultStatePath(), lockPath: defaultLockPath() });

  return createRotationManager({
    accounts,
    state,
    onAccountDisabled: hooks.onAccountDisabled,
    refreshFn: (refreshToken) => refreshTokens(refreshToken),
    mirrorFn: async (tokens: PoolOAuthTokens) => {
      await client.auth.set({
        path: { id: "anthropic" },
        body: {
          type: "oauth",
          refresh: tokens.refresh,
          access: tokens.access,
          expires: tokens.expires,
        },
      });
    },
  });
}

/** 503 + retry-after, which clients retry: another process holds the lock mid-refresh. */
export function buildPoolBusyResponse(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "overloaded_error",
        message: "Claude pool is busy: another process is refreshing a token. Retrying shortly.",
      },
    }),
    { status: 503, headers: { "content-type": "application/json", "retry-after": "5" } },
  );
}

/**
 * Build the fail-fast response for a fully-exhausted pool.
 *
 * Returned as 429 rather than 401 so opencode does not prompt the user to
 * re-authenticate: nothing is wrong with the credentials, every account is
 * simply mid-cooldown. `retry-after` is set from the earliest reset so any
 * upstream retry logic waits for a real recovery instead of hot-looping.
 */
export function buildPoolExhaustedResponse(
  message: string,
  earliestReset: number | null,
  now: number,
): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (earliestReset !== null) {
    headers["retry-after"] = String(
      Math.max(1, Math.ceil((earliestReset - now) / 1000)),
    );
  }

  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message },
    }),
    { status: 429, headers },
  );
}
