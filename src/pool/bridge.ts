import { refreshTokens } from "../oauth.js";
import { createRotationManager } from "./manager.js";
import { createRotationStateStore, defaultStatePath } from "./rotation-state.js";
import { createAccountStore, createSecretBackend } from "./secret-store.js";
import type { RotationManager } from "./manager.js";
import type { PoolOAuthTokens } from "./types.js";

export interface PoolClient {
  auth: {
    set(input: {
      path: { id: string };
      body: { type: string; refresh: string; access: string; expires: number };
    }): Promise<unknown>;
  };
}

export function createPool(client: PoolClient): RotationManager {
  const accounts = createAccountStore(createSecretBackend());
  const state = createRotationStateStore({ path: defaultStatePath() });

  return createRotationManager({
    accounts,
    state,
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
