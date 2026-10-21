import { randomBytes, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { RETRYABLE_STATUSES, getTokenRetryDelayMs } from "./retry.js";
import {
  CLIENT_ID,
  TOKEN_URL,
  AUTHORIZE_URL,
  MANUAL_REDIRECT_URL,
  SCOPES,
  getUserAgent,
} from "./constants.js";

export interface OAuthTokens {
  access: string;
  refresh: string;
  expires: number;
}

export interface OAuthCallbackServer {
  /** The URL the user should open to authorize. */
  url: string;
  /** A manual-flow URL the user can paste a code from if localhost redirect doesn't work. */
  manualUrl: string;
  /** The PKCE code verifier (needed for token exchange). */
  verifier: string;
  /** The state parameter (used for CSRF validation). */
  state: string;
  /** The port the local server is listening on. */
  port: number;
  /** Wait for the authorization code to arrive via localhost redirect. Resolves with the code. */
  waitForCode: () => Promise<string>;
  /** Stop the callback server. */
  close: () => void;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url").replace(/=+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long one curl run may take before it is killed. */
const CURL_TIMEOUT_MS = 30_000;
/** Largest reply read from curl, per output stream. */
const CURL_MAX_OUTPUT_BYTES = 1024 * 1024;

// Payload (tokens, PKCE verifier) goes over stdin: argv is visible to `ps`.
// --max-time is a backstop to runCurl's own timeout: curl runs in its own
// process group, so it outlives a parent that dies mid-request.
export function buildTokenCurlArgs(): string[] {
  return [
    "-sS",
    "-w",
    "\n__HTTP_STATUS__%{http_code}",
    "--max-time",
    String(CURL_TIMEOUT_MS / 1000 + 5),
    "-X",
    "POST",
    TOKEN_URL,
    "-H",
    "Content-Type: application/json",
    "-H",
    `User-Agent: ${getUserAgent()}`,
    "--data-binary",
    "@-",
  ];
}

// A child-process error can carry the command line; never rethrow it raw.
function describeCurlFailure(err: unknown): string {
  const e = err as { code?: string | number; killed?: boolean; signal?: string | null; stderr?: unknown };
  if (e.code === "ENOENT") return "curl is not installed or not on PATH";
  if (e.killed) return "request timed out";
  if (e.signal) return `curl was killed by ${e.signal}`;
  const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
  if (typeof e.code === "number") return `curl exited ${e.code}${stderr ? `: ${stderr}` : ""}`;
  return typeof e.code === "string" ? e.code : "unknown curl failure";
}

// curl exits that end the attempt before any of the request is sent: the host
// did not resolve (6), the connection failed (7), the TLS handshake failed (35).
// Anything else, including a timeout (28, or runCurl killing curl), an empty
// reply (52) or a send or receive error (55, 56), may come after the server
// has read the request and spent the single-use refresh token or code.
const UNSENT_CURL_EXITS = new Set([6, 7, 35]);

/** True only when curl provably never sent the request, so resending it cannot spend a token twice. */
export function curlFailedBeforeSending(err: unknown): boolean {
  const e = err as { code?: unknown; killed?: boolean };
  return !e.killed && typeof e.code === "number" && UNSENT_CURL_EXITS.has(e.code);
}

/** How long a payload whose send may have reached the server is held back from every caller. */
export const UNCERTAIN_SEND_HOLD_MS = 10_000;

// Payloads whose last send may have reached the server, with the failure it
// got. Another caller holding the same token (V1 sends a title request beside
// the prompt) gets that failure instead of spending the token again. After the
// hold it may be sent once more: the server may never have read it.
const uncertainSends = new Map<string, { message: string; until: number }>();

// Async on purpose: a synchronous child process blocks the event loop, which
// stalls every stream in the long-lived opencode server for the whole refresh.
// `detached` puts curl in its own process group: closing the terminal (SIGHUP)
// or Ctrl-C (SIGINT) signals the terminal's whole foreground group, and a curl
// killed after sending loses the reply carrying the rotated refresh token,
// even when its caller (the pool dashboard) survives the signal to wait for it.
// execFile ignores `detached`, so spawn is used and its timeout rebuilt here.
function runCurl(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", buildTokenCurlArgs(), { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    // Why runCurl killed curl. Neither is an exit curlFailedBeforeSending
    // trusts, so the request counts as possibly sent and is never resent.
    let failure: Error | undefined;
    const stop = (err: Error) => {
      if (failure) return;
      failure = err;
      child.kill();
    };
    const timer = setTimeout(
      () => stop(Object.assign(new Error("curl timed out"), { killed: true })),
      CURL_TIMEOUT_MS,
    );
    // ENOENT when curl is missing; 'close' follows, and the promise is already settled.
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(Object.assign(new Error("curl failed"), { code, signal, stderr: Buffer.concat(stderr).toString("utf8") }));
    });
    const collect = (stream: NodeJS.ReadableStream | null, chunks: Buffer[]) => {
      let size = 0;
      stream?.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= CURL_MAX_OUTPUT_BYTES) chunks.push(chunk);
        else stop(Object.assign(new Error("curl output too large"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
      });
    };
    collect(child.stdout, stdout);
    collect(child.stderr, stderr);
    // curl can exit (DNS/TLS failure) before reading stdin; an unhandled EPIPE
    // would crash the whole opencode process. The close handler reports it.
    child.stdin?.on("error", () => {});
    child.stdin?.end(payload);
  });
}

/**
 * curl-based token exchange to avoid Bun/runtime fetch injecting
 * forbidden headers (Origin, Referer, Sec-Fetch-*) that trigger 429s.
 *
 * Refresh tokens and authorization codes are single-use, so a request is sent
 * again only after the server answered 429/529 or curl never sent it, and one
 * that may have reached the server is held back from other callers too.
 */
async function curlPost(
  body: Record<string, string>,
  retries = 3,
  wait = sleep,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  const now = Date.now();
  for (const [key, { until }] of uncertainSends) if (until <= now) uncertainSends.delete(key);
  const held = uncertainSends.get(payload);
  if (held) throw new Error(held.message);

  for (let attempt = 0; ; attempt++) {
    let retryDelayMs: number;
    try {
      const result = await runCurl(payload);

      const parts = result.split("\n__HTTP_STATUS__");
      const status = parseInt(parts[parts.length - 1], 10);
      const responseBody = parts.slice(0, -1).join("\n__HTTP_STATUS__");

      if (!RETRYABLE_STATUSES.has(status) || attempt === retries - 1) {
        return { status, body: responseBody };
      }
      const delayMs = getTokenRetryDelayMs(status, responseBody, attempt);
      // Too long to wait inside a request: report the endpoint's real answer.
      if (delayMs === null) return { status, body: responseBody };
      retryDelayMs = delayMs;

      console.error(
        `[opencode-oauth] Token endpoint ${status} (attempt ${attempt + 1}/${retries}), retrying...`,
      );
    } catch (err) {
      const unsent = curlFailedBeforeSending(err);
      if (attempt === retries - 1 || !unsent) {
        const message = `Token endpoint unreachable: ${describeCurlFailure(err)}`;
        if (!unsent) uncertainSends.set(payload, { message, until: Date.now() + UNCERTAIN_SEND_HOLD_MS });
        throw new Error(message);
      }
      retryDelayMs = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
    }
    await wait(retryDelayMs);
  }
}

/** The OAuth server's error text, or null for a non-JSON (proxy/firewall) body, which is never quoted. */
export function extractOAuthErrorDetail(body: string): string | null {
  let parsed: {
    error?: { message?: string; type?: string } | string;
    error_description?: string;
    message?: string;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const pick = (): string => {
    if (typeof parsed?.error === "string" && parsed.error.trim()) return parsed.error.trim();
    if (parsed?.error && typeof parsed.error === "object" && parsed.error.message?.trim()) {
      return parsed.error.message.trim();
    }
    if (parsed?.error_description?.trim()) return parsed.error_description.trim();
    if (parsed?.message?.trim()) return parsed.message.trim();
    return "unrecognised error body";
  };
  return pick().slice(0, 300);
}

function pageTitle(body: string): string {
  const title = body.match(/<title[^>]*>([^<]{1,80})/i)?.[1]?.trim();
  return title ? ` ("${title}")` : "";
}

/** Used when a response carries valid tokens but no usable lifetime: refresh again soon rather than lose them. */
export const FALLBACK_TOKEN_LIFETIME_MS = 5 * 60_000;

export function parseTokenResponse(status: number, body: string, label: string): OAuthTokens {
  if (status !== 200) {
    const detail = extractOAuthErrorDetail(body);
    if (detail === null) {
      // Deliberately not "<label> failed (NNN)": that prefix marks a rejected
      // credential, and a page that never reached the token server is not one.
      throw new Error(
        `${label}: HTTP ${status} with a non-JSON body${pageTitle(body)}, likely blocked before reaching the token server`,
      );
    }
    throw new Error(`${label} failed (${status}): ${detail}`);
  }
  // Errors here must not quote the body: a 200 body is where the tokens are.
  let data: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`${label} returned a malformed response (HTTP 200, ${body.length} bytes)`);
  }
  const { access_token: access, refresh_token: refresh, expires_in: expiresIn } = data ?? {};
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) {
    throw new Error(`${label} returned HTTP 200 without an access and refresh token`);
  }
  const hasLifetime = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0;
  if (!hasLifetime) {
    console.error(`[opencode-oauth] ${label} response has no valid expires_in; treating the token as valid for 5 minutes`);
  }
  const lifetimeMs = hasLifetime ? expiresIn * 1000 : FALLBACK_TOKEN_LIFETIME_MS;
  return { access, refresh, expires: Date.now() + lifetimeMs };
}

/**
 * Build PKCE challenge and state, then construct both automatic (localhost
 * redirect) and manual (platform.claude.com redirect) authorization URLs.
 */
function buildAuthUrls(
  port: number,
): { automaticUrl: string; manualUrl: string; verifier: string; state: string } {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));

  const automaticRedirectUri = `http://localhost:${port}/callback`;

  const buildUrl = (redirectUri: string): string => {
    const params = new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
    return `${AUTHORIZE_URL}?${params}`;
  };

  return {
    automaticUrl: buildUrl(automaticRedirectUri),
    manualUrl: buildUrl(MANUAL_REDIRECT_URL),
    verifier,
    state,
  };
}

/**
 * Start a local HTTP server to receive the OAuth callback redirect.
 * Returns a server handle with the authorization URLs, a promise that
 * resolves when the auth code arrives, and a close() method.
 *
 * This matches Claude Code's approach: an ephemeral port on localhost
 * captures the redirect. The redirect_uri includes the real port.
 */
export function startOAuthCallbackServer(): Promise<OAuthCallbackServer> {
  return new Promise((resolve, reject) => {
    let codeResolve: ((code: string) => void) | null = null;
    let codeReject: ((err: Error) => void) | null = null;
    const codePromise = new Promise<string>((res, rej) => {
      codeResolve = res;
      codeReject = rej;
    });

    const escapeHtml = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    let expectedState: string | null = null;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://localhost`);

      if (url.pathname === "/callback") {
        // Ignore (don't reject): a forged hit must not consume the one-shot promise.
        if (expectedState === null || url.searchParams.get("state") !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("State mismatch");
          return;
        }
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          const desc = url.searchParams.get("error_description") || error;
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><body><h2>Authorization failed</h2><p>${escapeHtml(desc)}</p><p>You can close this window.</p></body></html>`);
          codeReject?.(new Error(`OAuth error: ${desc}`));
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><body><h2>Authorization successful</h2><p>You can close this window and return to OpenCode.</p></body></html>`);
          codeResolve?.(code);
          return;
        }

        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing authorization code");
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    // Timeout: close the server after 5 minutes if no code arrives
    const timeout = setTimeout(() => {
      codeReject?.(new Error("OAuth callback timed out after 5 minutes"));
      server.close();
    }, 5 * 60 * 1000);

    // Listen on port 0 = OS assigns an ephemeral port
    server.listen(0, "localhost", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }

      const port = addr.port;
      const { automaticUrl, manualUrl, verifier, state } = buildAuthUrls(port);
      expectedState = state;

      resolve({
        url: automaticUrl,
        manualUrl,
        verifier,
        state,
        port,
        waitForCode: () => codePromise,
        close: () => {
          clearTimeout(timeout);
          server.close();
        },
      });
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Legacy createAuthorizationRequest for backward compatibility.
 * Uses MANUAL_REDIRECT_URL since there's no local server.
 */
export function createAuthorizationRequest(
  redirectUri?: string,
): { url: string; verifier: string; state: string } {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));

  const params = new URLSearchParams({
    code: "true",
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri || MANUAL_REDIRECT_URL,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  return { url: `${AUTHORIZE_URL}?${params}`, verifier, state };
}

export function parseAuthCode(raw: string): string {
  let code = raw.trim();

  if (code.includes("#")) {
    code = code.split("#")[0];
  }

  if (code.includes("?")) {
    try {
      const url = new URL(code);
      code = url.searchParams.get("code") || code;
    } catch {
      const match = code.match(/[?&]code=([^&#]+)/);
      if (match) code = match[1];
    }
  }

  return code.trim();
}

/** The state carried by a pasted `code#state` or callback URL, if any. */
export function parsePastedState(raw: string): string | null {
  const text = raw.trim();
  const query = text.match(/[?&]state=([^&#]+)/);
  if (query) return decodeURIComponent(query[1]!);
  const hash = text.indexOf("#");
  if (hash === -1) return null;
  return text.slice(hash + 1).trim() || null;
}

export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  redirectUri?: string,
): Promise<OAuthTokens> {
  const { status, body } = await curlPost({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: redirectUri || MANUAL_REDIRECT_URL,
  });
  return parseTokenResponse(status, body, "Token exchange");
}

/** `retries` caps the attempts; curlPost never resends a request that may have spent the token. */
export async function refreshTokens(
  refreshToken: string,
  retries?: number,
  wait?: (ms: number) => Promise<void>,
): Promise<OAuthTokens> {
  const { status, body } = await curlPost({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  }, retries, wait);
  return parseTokenResponse(status, body, "Token refresh");
}
