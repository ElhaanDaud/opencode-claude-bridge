/**
 * OpenCode 2 entrypoint.
 *
 * V2 sends Anthropic requests through its own HTTP client, so instead of the
 * V1 custom fetch this plugin rewrites each request in `http.request` and does
 * pool rotation in `http.response` by re-sending the request itself and
 * replacing the response. Tool schemas are left as V2 defines them: the Claude
 * Code tool mapping assumes V1's tool names.
 */

import { randomUUID } from "node:crypto";
import { SESSION_ID } from "../constants.js";
import { getClaudeTokens } from "../keychain.js";
import { getStableDeviceId, prepareRequest, settlePoolResponse, startPool } from "../index.js";
import type { PreparedRequest } from "../index.js";
import { buildPoolBusyResponse, buildPoolExhaustedResponse } from "../pool/bridge.js";
import { createToaster } from "../pool/notify.js";
import { LockTimeoutError } from "../pool/rotation-state.js";

const PROVIDER_ID = "anthropic";
const EXPIRY_BUFFER_MS = 60_000;
const V1_PLACEHOLDER_KEY = "oauth-placeholder";

export interface V2HttpRequestEvent {
  readonly model: { readonly providerID: string };
  request: Request;
}

export interface V2HttpResponseEvent {
  readonly model: { readonly providerID: string };
  readonly request: Request;
  response: Response;
}

type HookOptions = { readonly providerID?: string };

/** The subset of the V2 plugin context this plugin uses. */
export interface V2Context {
  readonly session: {
    hook(
      name: "http.request",
      callback: (event: V2HttpRequestEvent) => Promise<void> | void,
      options?: HookOptions,
    ): Promise<unknown>;
    hook(
      name: "http.response",
      callback: (event: V2HttpResponseEvent) => Promise<void> | void,
      options?: HookOptions,
    ): Promise<unknown>;
  };
}

type Pending =
  | { kind: "pool"; label: string; prepared: PreparedRequest; method: string; signal: AbortSignal | null; sentAt: number }
  | { kind: "single" }
  | { kind: "replace"; build: () => Response };

// V2 has no auth.json slot to mirror the active account into: the bearer is
// injected per request below.
const noMirrorClient = { auth: { set: async () => undefined } };

async function setup(ctx: V2Context): Promise<void> {
  const sessionId = SESSION_ID || randomUUID();
  const deviceId = getStableDeviceId();
  // V2's plugin context has no toast API; pool events are logged instead.
  const toast = createToaster({});
  const { currentPoolActive, pool } = await startPool(noMirrorClient, toast);
  const pending = new WeakMap<Request, Pending>();
  let warnedNoCredential = false;

  const onRequest = async (event: V2HttpRequestEvent): Promise<void> => {
    if (event.model.providerID !== PROVIDER_ID) return;
    const original = event.request;
    // A credential the user configured in V2 (API key or token) wins. The V1
    // bridge exports ANTHROPIC_API_KEY=oauth-placeholder into its process, so a
    // V2 launched from inside V1 inherits it; that value is never a real key.
    const apiKey = original.headers.get("x-api-key");
    const userKey = apiKey && apiKey !== V1_PLACEHOLDER_KEY;
    if (userKey || original.headers.get("authorization")) return;

    let accessToken: string;
    let label: string | null = null;
    if (await currentPoolActive()) {
      let acquired: Awaited<ReturnType<typeof pool.acquire>>;
      try {
        acquired = await pool.acquire();
      } catch (err) {
        if (!(err instanceof LockTimeoutError)) throw err;
        console.error(`[claude-pool] ${err.message}`);
        replaceResponse(event, buildPoolBusyResponse);
        return;
      }
      if (acquired.kind === "exhausted") {
        const message = pool.describeExhaustion(acquired.info);
        console.error(`[claude-pool] ${message}`);
        replaceResponse(event, () =>
          buildPoolExhaustedResponse(message, acquired.info.earliestReset, Date.now()),
        );
        return;
      }
      label = acquired.label;
      accessToken = acquired.accessToken;
    } else {
      // Single-account mode reads the Claude CLI login and never refreshes it:
      // refresh tokens rotate, and V2 offers no place to persist the new one.
      const tokens = getClaudeTokens();
      if (!tokens || tokens.expires < Date.now() + EXPIRY_BUFFER_MS) {
        if (!warnedNoCredential) {
          warnedNoCredential = true;
          console.error(
            "[opencode-claude-bridge] no fresh Claude CLI login and no pooled account; run `claude` once to refresh it, or enroll accounts with `claude-pool enroll`",
          );
        }
        return;
      }
      accessToken = tokens.access;
    }

    const method = original.method;
    const signal = original.signal ?? null;
    const prepared = await prepareRequest(
      original.url,
      { method, headers: original.headers, body: await original.clone().text(), signal },
      accessToken,
      { sessionId, deviceId, claudeTools: false, ensureClaudePrefix: true },
    );
    // The body was rewritten, so the original length no longer describes it.
    delete prepared.outHeaders["content-length"];

    const rewritten = new Request(prepared.finalUrl, {
      method,
      headers: prepared.outHeaders,
      body: prepared.body,
      signal,
    });
    event.request = rewritten;
    pending.set(
      rewritten,
      label ? { kind: "pool", label, prepared, method, signal, sentAt: Date.now() } : { kind: "single" },
    );
  };

  function replaceResponse(event: V2HttpRequestEvent, build: () => Response): void {
    pending.set(event.request, { kind: "replace", build });
  }

  const onResponse = async (event: V2HttpResponseEvent): Promise<void> => {
    const entry = pending.get(event.request);
    if (!entry) return;
    pending.delete(event.request);

    if (entry.kind === "replace") {
      await event.response.body?.cancel();
      event.response = entry.build();
      return;
    }
    if (entry.kind !== "pool") return;

    const { prepared, method, signal, sentAt } = entry;
    event.response = await settlePoolResponse({
      pool,
      toast,
      response: event.response,
      activeLabel: entry.label,
      outHeaders: prepared.outHeaders,
      body: prepared.body,
      ownsUserId: prepared.ownsUserId,
      send: (headers, body) => globalThis.fetch(prepared.finalUrl, { method, headers, body, signal }),
      signal,
      sessionId,
      deviceId,
      sentAt,
    });
  };

  await ctx.session.hook("http.request", onRequest, { providerID: PROVIDER_ID });
  await ctx.session.hook("http.response", onResponse, { providerID: PROVIDER_ID });
}

const plugin = { id: "opencode-claude-bridge", setup };

export default plugin;
