/**
 * OpenCode 2 entrypoint.
 *
 * V2 sends Anthropic requests through its own HTTP client, so instead of the
 * V1 custom fetch this plugin rewrites each request in `http.request` and does
 * pool rotation in `http.response` by re-sending the request itself and
 * replacing the response. V2's tools are swapped for Claude Code's definitions
 * and the model's tool calls translated back (tools.ts).
 *
 * Credentials, in order: the pool, the connection created by this plugin's
 * "Claude Pro / Max (OAuth)" login (V2 stores and refreshes it), then the
 * Claude CLI login read-only. A key or token the user configured is left alone.
 */

import { randomUUID } from "node:crypto";
import { SESSION_ID } from "../constants.js";
import { getClaudeTokens, readClaudeCredentials } from "../keychain.js";
import { getStableDeviceId, prepareRequest, settlePoolResponse, startPool } from "../index.js";
import type { PreparedRequest } from "../index.js";
import {
  createAuthorizationRequest,
  exchangeCodeForTokens,
  parseAuthCode,
  parsePastedState,
  refreshTokens,
  startOAuthCallbackServer,
} from "../oauth.js";
import type { OAuthCallbackServer, OAuthTokens } from "../oauth.js";
import { buildPoolBusyResponse, buildPoolExhaustedResponse } from "../pool/bridge.js";
import { createToaster } from "../pool/notify.js";
import { applyClaudeToolsForV2, wrapV2Response } from "./tools.js";
import { LockTimeoutError } from "../pool/rotation-state.js";

const PROVIDER_ID = "anthropic";
const METHOD_ID = "claude-pro-max";
const METHOD_LABEL = "Claude Pro / Max (OAuth)";
const EXPIRY_BUFFER_MS = 60_000;
const V1_PLACEHOLDER_KEY = "oauth-placeholder";
/** Marks the synthetic 429 so the `retry` hook can tell it from a real Anthropic rate limit. */
const POOL_EXHAUSTED_FIELD = "claude_pool_exhausted";
/** A successful refresh stays available to callers still holding the spent token. */
const REFRESH_RETENTION_MS = 60_000;
const PENDING_MAX_AGE_MS = 10 * 60_000;
/** Never fetched: a request pointed here fails nowhere near the network and its response is swapped. */
const INERT_URL = "data:text/plain,claude-pool";

interface V2ModelRef {
  readonly providerID: string;
}

export interface V2HttpRequestEvent {
  readonly sessionID: string;
  readonly kind: string;
  readonly model: V2ModelRef;
  request: Request;
}

export interface V2HttpResponseEvent {
  readonly sessionID: string;
  readonly kind: string;
  readonly model: V2ModelRef;
  readonly request: Request;
  response: Response;
}

export interface V2RetryEvent {
  readonly model: V2ModelRef;
  readonly error: {
    readonly type: string;
    readonly message: string;
    readonly status?: number;
    readonly response?: { readonly body: string };
  };
  readonly attempt: number;
  decision: { retry: false } | { retry: true; delay: number };
}

export interface V2OAuthCredential {
  readonly type: "oauth";
  readonly methodID: string;
  readonly refresh: string;
  readonly access: string;
  readonly expires: number;
  readonly metadata?: Record<string, unknown>;
}

export type V2Credential =
  | V2OAuthCredential
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "external"; readonly methodID: string };

export type V2Connection =
  | { readonly type: "credential"; readonly id: string; readonly method: "key" | "oauth" | "external" }
  | { readonly type: "env"; readonly name: string };

export type V2OAuthAuthorization = {
  readonly url: string;
  readonly instructions: string;
  readonly expiresAt?: number;
} & (
  | { readonly mode: "auto"; readonly callback: Promise<V2OAuthCredential> }
  | { readonly mode: "code"; readonly callback: (code: string) => Promise<V2OAuthCredential> }
);

export interface V2IntegrationEditor {
  readonly method: {
    update(input: {
      readonly integrationID: string;
      readonly method: { readonly id: string; readonly type: "oauth"; readonly label: string };
      readonly authorize: (answer: Record<string, unknown>) => Promise<V2OAuthAuthorization>;
      readonly refresh?: (credential: V2OAuthCredential) => Promise<V2OAuthCredential>;
    }): void;
  };
}

export interface V2ProviderEditor {
  get(providerID: string): { readonly provider: { readonly activation: string } } | undefined;
  update(providerID: string, update: (provider: { activation: string }) => void): void;
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
    hook(
      name: "retry",
      callback: (event: V2RetryEvent) => Promise<void> | void,
      options?: HookOptions,
    ): Promise<unknown>;
  };
  readonly integration: {
    transform(callback: (editor: V2IntegrationEditor) => void): Promise<unknown>;
    readonly connection: {
      active(integrationID: string): Promise<V2Connection | undefined>;
      resolve(connection: V2Connection): Promise<V2Credential | undefined>;
    };
  };
  readonly provider: {
    transform(callback: (editor: V2ProviderEditor) => void): Promise<unknown>;
  };
}

type ToolNames = Record<string, string>;

type Pending =
  | {
      kind: "pool";
      label: string;
      prepared: PreparedRequest;
      method: string;
      signal: AbortSignal | null;
      sentAt: number;
      inboundToolNameMap: ToolNames;
    }
  | { kind: "single"; inboundToolNameMap: ToolNames }
  | { kind: "replace"; build: () => Response };

interface PendingEntry {
  readonly request: Request;
  readonly value: Pending;
  readonly at: number;
}

/**
 * Requests between `http.request` and `http.response`. They are matched by the
 * Request object we handed back; if another plugin replaced it after us, the
 * session and request kind (which both events carry) identify it instead, but
 * only while a single request of that kind is outstanding: with concurrent
 * ones, guessing would feed one request's response to another's rotation.
 */
class PendingRequests {
  private readonly byKey = new Map<string, PendingEntry[]>();

  add(event: V2HttpRequestEvent, value: Pending): void {
    const key = keyOf(event);
    const now = Date.now();
    const live = (this.byKey.get(key) ?? []).filter((entry) => now - entry.at < PENDING_MAX_AGE_MS);
    const entry: PendingEntry = { request: event.request, value, at: now };
    this.byKey.set(key, [...live, entry]);
    // A request that never gets a response (cancelled, transport error) would otherwise linger.
    event.request.signal.addEventListener("abort", () => this.remove(key, entry), { once: true });
  }

  take(event: V2HttpResponseEvent): Pending | undefined {
    const key = keyOf(event);
    const entries = this.byKey.get(key) ?? [];
    const exact = entries.find((entry) => entry.request === event.request);
    const match = exact ?? (entries.length === 1 ? entries[0] : undefined);
    if (!match) {
      if (entries.length > 1) {
        console.error(
          "[opencode-claude-bridge] another plugin replaced the request and several are in flight; skipping pool rotation for one response",
        );
      }
      return undefined;
    }
    this.remove(key, match);
    return match.value;
  }

  private remove(key: string, entry: PendingEntry): void {
    const rest = (this.byKey.get(key) ?? []).filter((candidate) => candidate !== entry);
    if (rest.length > 0) this.byKey.set(key, rest);
    else this.byKey.delete(key);
  }
}

function keyOf(event: { readonly sessionID: string; readonly kind: string }): string {
  return `${event.sessionID}\0${event.kind}`;
}

function toCredential(tokens: OAuthTokens, metadata?: Record<string, unknown>): V2OAuthCredential {
  return {
    type: "oauth",
    methodID: METHOD_ID,
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * Refresh tokens are single-use, so concurrent callers share one request, and
 * a late caller still holding the spent token gets that result rather than
 * sending it again. The request itself is sent once (`retries: 1`): after one
 * that may have reached the server, a resend can only hit a spent token.
 */
function createRefresher(): (credential: V2OAuthCredential) => Promise<V2OAuthCredential> {
  const flights = new Map<string, Promise<V2OAuthCredential>>();
  return (credential) => {
    const existing = flights.get(credential.refresh);
    if (existing) return existing;
    const flight = refreshTokens(credential.refresh, 1).then((tokens) => toCredential(tokens, credential.metadata));
    flights.set(credential.refresh, flight);
    const forget = (retain: number) => setTimeout(() => flights.delete(credential.refresh), retain).unref();
    flight.then(() => forget(REFRESH_RETENTION_MS), () => forget(10_000));
    return flight;
  };
}

/** Manual flow for when the local callback server cannot start. */
export function authorizeByPaste(): V2OAuthAuthorization {
  const { url, verifier, state } = createAuthorizationRequest();
  return {
    mode: "code",
    url,
    instructions: "Sign in to Claude, then paste the code shown on the final page.",
    callback: async (input) => {
      const pastedState = parsePastedState(input);
      if (pastedState !== null && pastedState !== state) {
        throw new Error("That code belongs to a different login attempt (state mismatch); start the login again.");
      }
      const code = parseAuthCode(input);
      if (!code) throw new Error("No authorization code found in the pasted text.");
      return toCredential(await exchangeCodeForTokens(code, verifier));
    },
  };
}

/** The pool's 429 with a marker field, so a real Anthropic rate limit is never mistaken for it. */
async function markExhausted(response: Response): Promise<Response> {
  const body = (await response.json()) as Record<string, unknown>;
  const headers = new Headers(response.headers);
  return new Response(JSON.stringify({ ...body, [POOL_EXHAUSTED_FIELD]: true }), {
    status: response.status,
    headers,
  });
}

function isPoolExhausted(error: V2RetryEvent["error"]): boolean {
  if (error.status !== 429 || !error.response) return false;
  try {
    const body: unknown = JSON.parse(error.response.body);
    return typeof body === "object" && body !== null && (body as Record<string, unknown>)[POOL_EXHAUSTED_FIELD] === true;
  } catch {
    return false;
  }
}

// V2 has no auth.json slot to mirror the active account into: the bearer is
// injected per request below.
const noMirrorClient = { auth: { set: async () => undefined } };

async function setup(ctx: V2Context): Promise<() => void> {
  const sessionId = SESSION_ID || randomUUID();
  const deviceId = getStableDeviceId();
  // V2's plugin context has no toast API; pool events are logged instead.
  const toast = createToaster({});
  const { currentPoolActive, pool } = await startPool(noMirrorClient, toast);
  const pending = new PendingRequests();
  const callbackServers = new Set<OAuthCallbackServer>();
  const refresh = createRefresher();
  let warnedNoCredential = false;

  // V2 lists a provider only once it has a credential. The pool and the CLI
  // login are ours, so without this the models stay hidden until the user adds
  // a key they do not need. A user's own key still wins at request time.
  const serveable = (await currentPoolActive()) || readClaudeCredentials()?.claudeAiOauth !== undefined;
  await ctx.provider.transform((providers) => {
    if (serveable && providers.get(PROVIDER_ID)?.provider.activation === "auto") {
      providers.update(PROVIDER_ID, (provider) => {
        provider.activation = "enabled";
      });
    }
  });

  await ctx.integration.transform((integrations) => {
    integrations.method.update({
      integrationID: PROVIDER_ID,
      method: { id: METHOD_ID, type: "oauth", label: METHOD_LABEL },
      authorize,
      refresh,
    });
  });

  // Not the Claude CLI's login: V2 and the CLI would share one refresh-token
  // chain and whichever refreshed first would log the other out.
  async function authorize(): Promise<V2OAuthAuthorization> {
    let server: OAuthCallbackServer | undefined;
    try {
      server = await startOAuthCallbackServer();
    } catch (err) {
      console.error(`[opencode-claude-bridge] could not start the OAuth callback server: ${err}`);
    }
    if (!server) return authorizeByPaste();

    const listening = server;
    callbackServers.add(listening);
    const redirectUri = `http://localhost:${listening.port}/callback`;
    const callback = (async () => {
      try {
        const code = await listening.waitForCode();
        return toCredential(await exchangeCodeForTokens(code, listening.verifier, redirectUri));
      } finally {
        callbackServers.delete(listening);
        listening.close();
      }
    })();
    // The caller owns the failure; this only keeps an unobserved rejection from crashing the process.
    callback.catch(() => undefined);
    return {
      mode: "auto",
      url: listening.url,
      instructions: "Sign in to Claude in the browser; this window continues once you approve.",
      expiresAt: Date.now() + 5 * 60_000,
      callback,
    };
  }

  /** The active connection's credential when it is this plugin's login. */
  async function ownCredential(): Promise<V2OAuthCredential | undefined> {
    try {
      const connection = await ctx.integration.connection.active(PROVIDER_ID);
      if (connection?.type !== "credential" || connection.method !== "oauth") return undefined;
      const credential = await ctx.integration.connection.resolve(connection);
      return credential?.type === "oauth" && credential.methodID === METHOD_ID ? credential : undefined;
    } catch {
      return undefined;
    }
  }

  const onRequest = async (event: V2HttpRequestEvent): Promise<void> => {
    if (event.model.providerID !== PROVIDER_ID) return;
    const original = event.request;
    // A credential the user configured in V2 (API key or token) wins. The V1
    // bridge exports ANTHROPIC_API_KEY=oauth-placeholder into its process, so a
    // V2 launched from inside V1 inherits it; that value is never a real key.
    const apiKey = original.headers.get("x-api-key");
    if (apiKey && apiKey !== V1_PLACEHOLDER_KEY) return;
    // V2 attaches our own login as a bearer itself, so that header only marks a
    // user's credential when it is not the one this plugin's connection holds.
    const bearer = original.headers.get("authorization");
    let own: V2OAuthCredential | undefined;
    if (bearer) {
      own = await ownCredential();
      if (!own || bearer !== `Bearer ${own.access}`) return;
    }

    let accessToken: string;
    let label: string | null = null;
    if (await currentPoolActive()) {
      let acquired: Awaited<ReturnType<typeof pool.acquire>>;
      try {
        acquired = await pool.acquire();
      } catch (err) {
        if (!(err instanceof LockTimeoutError)) throw err;
        console.error(`[claude-pool] ${err.message}`);
        await stashResponse(event, buildPoolBusyResponse());
        return;
      }
      if (acquired.kind === "exhausted") {
        const message = pool.describeExhaustion(acquired.info);
        console.error(`[claude-pool] ${message}`);
        await stashResponse(
          event,
          await markExhausted(buildPoolExhaustedResponse(message, acquired.info.earliestReset, Date.now())),
        );
        return;
      }
      label = acquired.label;
      accessToken = acquired.accessToken;
    } else if (own) {
      // V2 persists and refreshes this credential (see `refresh` above).
      accessToken = own.access;
    } else {
      // Last resort: the Claude CLI login, read-only and never refreshed
      // (refresh tokens rotate, and that one is Claude Code's).
      const tokens = getClaudeTokens();
      if (!tokens || tokens.expires < Date.now() + EXPIRY_BUFFER_MS) {
        if (!warnedNoCredential) {
          warnedNoCredential = true;
          console.error(
            "[opencode-claude-bridge] no fresh Claude CLI login and no pooled account; run `claude` once to refresh it, connect with the Claude Pro / Max (OAuth) method, or enroll accounts with `claude-pool enroll`",
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
    // Rotation re-sends prepared.body, so it must carry Claude's tool definitions too.
    let inboundToolNameMap: ToolNames = {};
    if (typeof prepared.body === "string") {
      const tools = applyClaudeToolsForV2(prepared.body);
      prepared.body = tools.body;
      inboundToolNameMap = tools.inboundToolNameMap;
    }

    event.request = new Request(prepared.finalUrl, {
      method,
      headers: prepared.outHeaders,
      body: prepared.body,
      signal,
    });
    pending.add(
      event,
      label
        ? { kind: "pool", label, prepared, method, signal, sentAt: Date.now(), inboundToolNameMap }
        : { kind: "single", inboundToolNameMap },
    );
  };

  // Rotation needs no request to reach Anthropic, so the request is pointed at
  // a data: URL (answered in-process, never on the network) and `http.response`
  // swaps in the pool's answer. Throwing from the hook would surface as a crash
  // rather than the pool's message.
  async function stashResponse(event: V2HttpRequestEvent, response: Response): Promise<void> {
    const text = await response.text();
    const { status, headers } = response;
    event.request = new Request(INERT_URL, { signal: event.request.signal });
    pending.add(event, { kind: "replace", build: () => new Response(text, { status, headers }) });
  }

  const onResponse = async (event: V2HttpResponseEvent): Promise<void> => {
    const entry = pending.take(event);
    if (!entry) return;

    if (entry.kind === "replace") {
      await event.response.body?.cancel();
      event.response = entry.build();
      return;
    }

    if (entry.kind === "single") {
      event.response = wrapV2Response(event.response, entry.inboundToolNameMap);
      return;
    }

    const { prepared, method, signal, sentAt, inboundToolNameMap } = entry;
    const settled = await settlePoolResponse({
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
    event.response = wrapV2Response(settled, inboundToolNameMap);
  };

  // V2 retries a 429 by default; an exhausted pool only recovers when an
  // account's cooldown ends, so retrying just repeats the same answer.
  const onRetry = (event: V2RetryEvent): void => {
    if (isPoolExhausted(event.error)) event.decision = { retry: false };
  };

  await ctx.session.hook("http.request", onRequest, { providerID: PROVIDER_ID });
  await ctx.session.hook("http.response", onResponse, { providerID: PROVIDER_ID });
  await ctx.session.hook("retry", onRetry, { providerID: PROVIDER_ID });

  return () => {
    for (const server of callbackServers) server.close();
    callbackServers.clear();
  };
}

const plugin = { id: "opencode-claude-bridge", setup };

export default plugin;
