# opencode-claude-bridge

Use your Claude Pro/Max subscription in [OpenCode](https://opencode.ai). If you're logged into the Claude CLI, it just works — no extra setup.

## Install

This fork is installed from source. The `opencode-claude-bridge` package on
npm is the upstream project and does not include the account pool.

### Install with AI

Copy this one line into your AI coding agent (OpenCode, Claude Code, Cursor and so on):

```
Follow the instructions at https://raw.githubusercontent.com/ElhaanDaud/opencode-claude-pool/main/INSTALL-AI.md to install opencode-claude-pool on this machine.
```

The agent checks your OpenCode version and installs the matching build: `main`
for OpenCode 1, `feat/opencode-2` for OpenCode 2. It edits your OpenCode config
in place after backing it up. Logging accounts in (`claude login`) stays with
you, because each login is interactive. The full instructions it follows are in
[INSTALL-AI.md](INSTALL-AI.md).

### OpenCode 1 (manual)

Check your version with `opencode --version`. For `1.x`:

**1. Clone and build**

```bash
git clone https://github.com/ElhaanDaud/opencode-claude-pool.git ~/src/opencode-claude-bridge
cd ~/src/opencode-claude-bridge && npm ci && npm run build
```

**2. Create a wrapper**

Don't point OpenCode at `dist/index.js` directly. The loader calls every named
export as a plugin factory, and this module exports helpers, so loading fails
with `modelId.match is not a function`. A wrapper that re-exports only the
default avoids that:

```bash
echo "export { default } from \"$HOME/src/opencode-claude-bridge/dist/index.js\";" \
  > ~/.config/opencode/claude-bridge-wrapper.mjs
```

**3. Register it** in `~/.config/opencode/opencode.json` (use your absolute home path):

```json
{
  "plugin": ["file:///Users/YOU/.config/opencode/claude-bridge-wrapper.mjs"]
}
```

Restart OpenCode. If you're logged into the Claude CLI (`claude login`), the plugin auto-syncs your credentials — just select an Anthropic model and start chatting. If not, you'll be prompted to authenticate via browser OAuth or enter an API key.

**Upgrade:**

```bash
cd ~/src/opencode-claude-bridge && git pull && npm ci && npm run build
```

Then restart OpenCode. Full walkthrough, Linux notes and troubleshooting: [SETUP.md](SETUP.md).

### OpenCode 2 (manual)

OpenCode 2 has a new plugin API and cannot load the V1 plugin. Its support
lives on the `feat/opencode-2` branch for now. For `opencode --version` `2.x`:

**1. Clone the V2 branch and build**

```bash
git clone -b feat/opencode-2 https://github.com/ElhaanDaud/opencode-claude-pool.git ~/src/opencode-claude-bridge
cd ~/src/opencode-claude-bridge && npm ci && npm run build
```

If you already have a checkout of `main`, switch it instead:
`git checkout feat/opencode-2 && git pull && npm ci && npm run build`.

**2. Register the build directory** in `~/.config/opencode/opencode.json`. V2
uses the `plugins` key (plural) and only loads a local plugin from a directory,
so no wrapper is needed:

```json
{
  "plugins": ["file:///Users/YOU/src/opencode-claude-bridge/dist/opencode2"]
}
```

V1 and V2 read the same config file. Don't keep a V1 `plugin` entry for the
wrapper there: V2 migrates it and fails to load it.

**3. Restart OpenCode and check** that `opencode plugin list` shows
`opencode-claude-bridge` with a source ending in `dist/opencode2/server.js`.

Enrollment, `claude-pool` and the pool itself are shared with V1, so
[Multi-account rotation](#multi-account-rotation) applies unchanged. What
differs on V2:

- Tool schemas are sent as V2 defines them. The Claude Code tool mapping is not applied yet.
- Pool events are logged rather than shown as toasts, since V2's plugin API has no toast call.
- Without enrolled accounts it uses the Claude CLI login as-is and never refreshes it. Run `claude` to refresh it, or enroll the account.
- An Anthropic API key you configure in V2 itself takes precedence, and the bridge leaves those requests alone.

**Upgrade:** `cd ~/src/opencode-claude-bridge && git pull && npm ci && npm run build`, then restart OpenCode.

## How the bridge works

The plugin sits between OpenCode and the Anthropic API:

> **OpenCode** -> **opencode-claude-bridge** -> **Anthropic API**

### Authentication

Supports both OAuth and API key auth:

- **OAuth (Pro/Max)** — Auto-reads your Claude CLI's OAuth tokens from macOS Keychain (or `~/.claude/.credentials.json` on Linux). No browser flow needed. If Claude CLI isn't available, falls back to browser-based OAuth PKCE.
- **API key** — Works alongside a standard `provider` entry in your OpenCode config with an `apiKey`. The plugin only activates its OAuth handling for the built-in `anthropic` provider; custom API key providers pass through unchanged.
- **Token refresh** — When tokens expire, three layers are tried: re-read from Keychain, refresh via stored token, refresh via CLI's token.

### Wire-level request matching

Every outbound OAuth request is rewritten to match what Claude Code sends on the wire:

- **Headers** — `user-agent`, `anthropic-beta`, `anthropic-version`, `x-stainless-*`, `x-claude-code-version`, `x-claude-code-session-id`, and all billing metadata (`cc_version`, `cc_entrypoint`, `cch`).
- **Body fields** — `thinking` (with effort and `clear_thinking`), `context_management`, `output_config`, `metadata` (session ID, billing info), and `?beta=true` URL parameter.
- **System prompt** — Claude Code's real system prompt is captured via the validator and cached at `~/.cache/opencode-claude-bridge/claude-system-prompt.json`. The bridge puts it first in every request's system prompt; OpenCode's own system blocks (agent prompt, AGENTS.md, instructions) follow it.
- **MCP tool prefixing** — OpenCode's MCP tools are prefixed with `mcp_` to match Claude Code's convention.

### Tool wire-matching (v1.9.0)

Claude Code sends 26 captured core tools (plus user-specific MCP tools). OpenCode has 10. These differ in names, descriptions, schemas, parameter names, required fields, and sort order.

The bridge resolves this by:

1. **Replacing active OpenCode shared core tool definitions only for Claude-compatible targets** with Claude Code's exact wire-captured definitions — matching descriptions, JSON schemas, parameter names, and required fields.
2. **Preserving active OpenCode custom/MCP tool definitions** so project-specific MCP servers remain available to Claude models.
3. **Selecting Claude-only alias/stub schemas only when the matching OpenCode tool is active** (for example `question` → `AskUserQuestion`, `plan_enter` → `EnterPlanMode`).
4. **Ordering Claude core tools first, then custom/MCP tools**, each group alphabetical, to match Claude Code's ordering and keep the request prefix byte-stable for prompt caching.

Three of the stubs have OpenCode equivalents and are routed to them: `AskUserQuestion` -> `question`, `EnterPlanMode` -> `plan_enter`, `ExitPlanMode` -> `plan_exit`. If the model calls any other stub, OpenCode's built-in error handling catches it and tells the model the tool is unavailable, and the model adapts on the next turn.

The bridge now selects tool schemas by target/model:

- **Anthropic direct** -> Claude wire schemas
- **OpenRouter Claude models** -> Claude wire schemas
- **Everything else** -> OpenCode's default tool schemas

### Bidirectional parameter translation

Claude Code and OpenCode use different parameter naming conventions. The bridge translates in both directions on the fly:

**Inbound (API response -> OpenCode)** — translated on assembled SSE `input_json_delta` payloads after buffering per-tool fragments, so chunk boundary splits do not corrupt name or argument mapping:

| Claude Code sends | OpenCode expects |
|---|---|
| `file_path` | `filePath` |
| `old_string` | `oldString` |
| `new_string` | `newString` |
| `replace_all` | `replaceAll` |
| `glob` (in Grep) | `include` |
| `activeForm` (in TodoWrite) | `priority` |

**Outbound (OpenCode -> API request)** — translated in historical `tool_use` message blocks:

| OpenCode sends | Bridge converts to |
|---|---|
| `filePath` | `file_path` |
| `oldString` | `old_string` |
| `newString` | `new_string` |
| `replaceAll` | `replace_all` |
| `include` (in Grep) | `glob` |
| `priority` (in TodoWrite) | `activeForm` |

Additional shared-tool bridging handled by the bridge:

- `Agent` / `task` — defaults missing `subagent_type` to `general`, strips unsupported Claude-only fields inbound, and strips OpenCode-only history fields outbound
- `AskUserQuestion` / `question` — maps `multiSelect` <-> `multiple`
- `Skill` — maps `skill` <-> `name`
- `WebFetch` — best-effort bridge between Claude's `prompt` and OpenCode's `format` by using `markdown` inbound and synthesizing a Claude prompt outbound

### Agent type translation

Claude Code uses different agent/subagent types than OpenCode:

| Claude Code | OpenCode |
|---|---|
| `general-purpose` | `general` |
| `Explore` | `explore` |
| `Plan` | `plan` |
| `statusline-setup` | `build` |

These are mapped in both directions — inbound responses and outbound historical messages.

### TodoWrite status mapping

Claude Code has 3 todo statuses; OpenCode has 4. The outbound direction maps `cancelled` -> `completed` since Claude Code doesn't have a cancelled state.

`activeForm` <-> `priority` is a carrier mapping, not a semantic one. OpenCode types `priority` as a free string, so it holds Claude's `activeForm` text ("Running tests") on the way in and gives it back unchanged on the way out.

### Model handling

The bridge ships a fallback catalog, used only for model IDs that OpenCode's own list is missing: Fable 5.1, Opus 5.5 / 4.6 / 4.5, Sonnet 5.5 / 5 / 4.6 / 4.5, Haiku 5.5 / 4.5. It also normalizes `thinking` for models that reject some modes:

- **Sonnet 5.5** rejects both `{type:"enabled", budget_tokens}` and `{type:"disabled"}`. `enabled` is rewritten to `adaptive`.
- **Haiku 5.5** rejects `{type:"enabled"}`, which is rewritten to `adaptive`.
- `temperature` is forced to `1` whenever thinking is enabled or adaptive, which the API requires.

### Dynamic fingerprint computation

The `cc_version` billing metadata suffix (a 3-character hex string like `df0` or `e0a`) is computed dynamically per request using the same algorithm as Claude Code:

```
SHA256(salt + text[4] + text[7] + text[20] + CLI_VERSION).slice(0, 3)
```

`text` is the first user message's text. Any index past the end of the text contributes `"0"`. The salt is hardcoded in Claude Code's source. The value changes per conversation because the first message changes.

## Multi-account rotation

> Setup (macOS and Linux), enrollment order and troubleshooting: **[SETUP.md](SETUP.md)**

A single Claude subscription has a rolling 5-hour window and a rolling 7-day
quota. When either is spent, every request fails until it resets. The account
pool lets you enroll several subscriptions and rotate to the next one
automatically when the active account's window is exhausted.

The pool is **opt-in**: with no accounts enrolled the plugin behaves exactly as
it did before.

### Enrolling accounts

Both the Claude CLI keychain and OpenCode's `auth.json` hold exactly one Claude
credential, so `claude login` overwrites whichever account was there before.
Enrollment captures the current account into the pool first, which makes the
sequence repeatable:

```bash
claude login          # as the first account
claude-pool enroll    # label is derived from the account's email

claude login          # as the second account
claude-pool enroll

claude-pool list      # confirm both are present
```

Pass a label explicitly to override the derived one: `claude-pool enroll work`.

### Automatic enrollment

Once at least one account is pooled, the plugin adopts newly logged-in accounts
on startup. For instant adoption without restarting OpenCode, install a shell
hook so `claude login` enrolls as it completes:

```bash
node scripts/claude-pool.mjs install-hook >> ~/.zshrc && source ~/.zshrc
```

Accounts are matched by refresh token, then by email, so re-logging into a
pooled account refreshes its entry instead of duplicating it. Set
`CLAUDE_POOL_AUTO_ENROLL=0` to disable.

### Commands

| Command | Purpose |
| --- | --- |
| `claude-pool enroll [label] [--replace]` | Add the account Claude CLI is logged into |
| `claude-pool auto` | Enroll the logged-in account only if the pool has not seen it |
| `claude-pool install-hook` | Print a shell function that runs `auto` after `claude login` |
| `claude-pool whoami` | Show which account Claude CLI is logged into, and whether it is pooled |
| `claude-pool list` | Every enrolled account with its status and token expiry |
| `claude-pool status` | Active account and what rotation would pick next |
| `claude-pool dashboard` | Interactive manager (prints the status when not in a terminal) |
| `claude-pool enable <label>` | Re-enable one account (clears its cooldown or disabled flag) |
| `claude-pool remove <label>` | Drop an account |
| `claude-pool clear-cooldowns` | Re-enable every account (clears all cooldowns and disabled flags) |
| `claude-pool help` | Show usage |

`claude-pool` is declared as a `bin` in `package.json`. From a source checkout,
either run `node scripts/claude-pool.mjs <command>` or install the shell hook
above, which defines a `claude-pool` function.

### Notifications

Pool events appear as OpenCode toasts: an account switch, an account added by
auto-enrollment, an account disabled (with the re-login hint), and every
account cooling down (with the earliest reset). Identical toasts are shown at
most once per minute.

### When rotation happens

Every failed response is classified before the response body is read:

| Signal | Action |
| --- | --- |
| `429` with a reset of 60s or less | Back off, retry the **same** account (up to 3 attempts, then rotate) |
| `429` with a longer reset, or `anthropic-ratelimit-unified-status` not `allowed` | Cool the account down until its reset, switch accounts |
| `429` with no determinable reset | Cool down for 1 hour, switch |
| `403` whose body says suspended / disabled / banned | Disable the account, switch |
| Other `403` | Cool down for 1 hour, switch |
| `401` | Credential rejected even after refresh — disable, switch |
| `5xx` | Retry the same account with exponential backoff (1s, 2s, 4s), then pass through |
| Every account cooling | Fail fast as `429`, naming each account and the earliest reset |

A 401/403 penalty is only applied once **another account succeeds** with the
same request. If the next account fails identically, the request is blamed and
neither account is penalised. If no other account is available, or the next
one is merely rate-limited, the error passes through unpenalised.

Reset windows are read from `retry-after`, then Anthropic's
`anthropic-ratelimit-unified-*` headers (epoch seconds), preferring whichever
window `representative-claim` reports as binding. When no reset can be
determined the account is cooled rather than retried, because retrying a truly
exhausted account is worse than briefly parking a healthy one.

Rotation only occurs **before** the response body is read. Once SSE streaming
has begun a second stream cannot be spliced into the first, so mid-stream
errors are passed through untouched.

### Where credentials live

Accounts are stored one per macOS Keychain item under the service
`opencode-claude-bridge` (a `0600` file per account on other platforms). The
pool is the source of truth; OpenCode's single `anthropic` slot in `auth.json`
is a mirror of whichever account is currently active.

Rotation bookkeeping — active account, cooldowns, failure counts — lives
separately in `~/.local/share/opencode-claude-bridge/rotation-state.json` and
contains no secrets. It is written atomically and guarded by a cross-process
lock, so several OpenCode processes can share one pool safely.

### Refresh tokens rotate

Anthropic issues a **new** refresh token on every refresh and invalidates the
old one immediately, with no grace window. Losing the replacement permanently
locks you out of that account.

Refreshes therefore journal the new tokens to disk before committing them to
the keychain, and any journal found at startup is replayed. Concurrent
refreshes of one account collapse into a single call, since two parallel
refreshes would spend the same token twice. Across processes, refreshes are
serialised by the rotation lock. A stale lock is reclaimed only once its holder
is provably gone (same host: the PID no longer exists; other host: older than
3 minutes).

A refresh the token endpoint rejects disables the account. A network error or
5xx cools it down for 60 seconds instead, so a brief outage can't disable every
account in turn.

The practical consequence: **after the pool refreshes an account, the Claude
CLI's own stored copy of that credential is stale.** That is expected. Run
`claude-pool list` rather than trusting the CLI's view.

## Requirements

- [OpenCode](https://opencode.ai) v1.2+, or v2 via the `feat/opencode-2` branch (tested on 2.0.32; see [OpenCode 2](#opencode-2-manual))
- For OAuth: [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (`claude login`)
- macOS (Keychain) or Linux (`~/.claude/.credentials.json` fallback)
- For API key: just configure a `provider` with `apiKey` in your OpenCode config as usual

## Environment overrides

All OAuth and header parameters can be overridden via environment variables:

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_CLIENT_ID` | `9d1c250a-...` | OAuth client ID |
| `ANTHROPIC_TOKEN_URL` | `https://platform.claude.com/v1/oauth/token` | Token endpoint |
| `ANTHROPIC_AUTHORIZE_URL` | `https://claude.ai/oauth/authorize` | Authorization endpoint |
| `ANTHROPIC_CLI_VERSION` | Auto-detected from `claude --version` or `2.1.98` | Claude CLI version string |
| `ANTHROPIC_CLI_BUILD_ID` | `835` | Build ID for headers |
| `ANTHROPIC_ENTRYPOINT` | `sdk-cli` | Entrypoint value for billing |
| `ANTHROPIC_SDK_VERSION` | `0.94.0` | Stainless SDK version |
| `ANTHROPIC_BETA_FLAGS` | Current Claude Code beta flags | Comma-separated beta feature flags |
| `ANTHROPIC_BILLING_CCH` | (computed) | Client attestation hash override |
| `ANTHROPIC_SYSTEM_PROMPT_PATH` | `~/.cache/opencode-claude-bridge/claude-system-prompt.json` | Path to cached system prompt |
| `ANTHROPIC_DEFAULT_EFFORT` | `medium` | Thinking effort level |
| `ANTHROPIC_SESSION_ID` | (generated) | Override session ID |
| `ANTHROPIC_USER_AGENT` | `claude-cli/<version> (external, <entrypoint>)` | Full user-agent override |
| `ANTHROPIC_PROFILE_URL` | `https://api.anthropic.com/api/oauth/profile` | Account profile endpoint (email lookup) |
| `ANTHROPIC_USAGE_URL` | `https://api.anthropic.com/api/oauth/usage` | Usage endpoint (dashboard) |
| `ANTHROPIC_MANUAL_REDIRECT_URL` | `https://platform.claude.com/oauth/code/callback` | Redirect for copy-paste OAuth |
| `ANTHROPIC_SCOPES` | Claude CLI's full scope set | OAuth scopes |
| `ANTHROPIC_CLEAR_THINKING_TYPE` | `clear_thinking_20251015` | `context_management` edit type |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where the Claude CLI credential file lives (Linux) |
| `CLAUDE_POOL_AUTO_ENROLL` | enabled | Set to `0` to disable auto-enrollment on startup |
| `CLAUDE_POOL_STATE_PATH` | `~/.local/share/opencode-claude-bridge/rotation-state.json` | Rotation state file (the lock stays at the default path) |

Most users won't need to change these. The bridge detects the installed Claude CLI version, re-checks it every 10 minutes since Claude Code auto-updates, and uses matching defaults.

## Local validation

To validate how local OpenCode traffic is being classified and how closely it matches Claude Code on the wire:

```bash
npm run validate:oauth -- --model claude-sonnet-4-6 --prompt "Reply with exactly VALIDATE."
```

The validator will:

- Query the OAuth usage endpoint before and after each run
- Capture an official Claude Code request through a local proxy
- Capture an OpenCode request using this repo's local `dist/index.js`
- Write Claude Code's captured system prompt to `~/.cache/opencode-claude-bridge/claude-system-prompt.json`
- Save request and response artifacts under `tmp/validate-*`
- Write a `report.json` with request diffs, body hashes, and usage snapshots

After the first successful validator run, the bridge will automatically reuse that cached Claude Code system prompt. This is currently the key step that makes OpenCode traffic behave like standard Claude Code usage.

If OpenCode is being treated as an OAuth app / extra-usage flow, the report will usually show it in one of two ways:

- The OpenCode run fails with an extra-usage style API error
- The usage buckets diverge from the Claude Code run even when the headers look similar

## Updating for new Claude CLI versions

When Claude Code updates, the required headers or body fields may change. To capture exactly what the latest Claude CLI sends:

```bash
./scripts/intercept-claude.sh claude-sonnet-4-6
```

This starts a local proxy, runs Claude CLI through it with OAuth, and saves the full request headers and body to `/tmp/claude-intercept-*`. Compare against the plugin's constants and fetch wrapper to spot differences.

Key things that have changed across versions:

- `anthropic-beta` flags (required set changes)
- Body fields (`thinking`, `metadata`, `context_management`)
- `user-agent` version string
- `x-stainless-package-version`
- `x-claude-code-session-id`
- Billing header shape (`cc_version`, `cc_entrypoint`, `cch`)
- Tool definitions and parameter schemas

## Architecture

```
src/
  index.ts           — Plugin entry: model catalog, tool replacement, request/response
                       transformation, thinking normalization, pool rotation loop
  claude-tools.ts    — 26 Claude Code tool definitions (10 shared + 16 stubs),
                       fingerprint computation, parameter translation
  stream.ts          — SSE rewriting: buffers tool_use input per block, translates names/args
  constants.ts       — CLI version detection, URLs, env overrides, header values
  keychain.ts        — Claude CLI credential read (macOS Keychain / credentials file)
  oauth.ts           — OAuth PKCE flow and token refresh
  pool/
    manager.ts       — Account acquisition, refresh with journal + in-flight dedupe
    rotation-state.ts — Rotation state file and cross-process lock
    classifier.ts    — Maps failed responses to retry / cooldown / disable decisions
    selection.ts     — Picks the next usable account
    secret-store.ts  — Per-account credential storage (Keychain or 0600 files)
    enroll.ts        — Enrollment and auto-adoption of new logins
    bridge.ts        — Wires the pool into the plugin (mirror into auth.json)
    usage.ts         — OAuth usage endpoint client
    notify.ts        — Deduplicated OpenCode toasts
    dashboard.ts, tui.ts — `claude-pool dashboard` interactive manager
    types.ts         — Shared pool types

scripts/
  claude-pool.mjs             — `claude-pool` CLI (bin entry)
  qa-rotation.mjs             — End-to-end rotation scenarios (real API + local fake upstream)
  validate-opencode-oauth.js  — Side-by-side wire comparison tool
  intercept-claude.sh         — mitmproxy-based Claude CLI request capture
```

Tests live next to their sources (`*.test.ts`) and run with `npm test`, which
builds first and runs everything under `dist/` with `node --test`.

## Important limitation

Anthropic's own Claude Code docs say third-party integrations should use API key authentication. This bridge can make OAuth requests look much closer to current Claude Code traffic, but Anthropic may still apply server-side classification that a bridge cannot fully control.

## Credits

Combines approaches from [shahidshabbir-se/opencode-anthropic-oauth](https://github.com/shahidshabbir-se/opencode-anthropic-oauth), [ex-machina-co/opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth), [vinzabe/PERMANENT-opencode-anthropic-oauth-fix](https://github.com/vinzabe/PERMANENT-opencode-anthropic-oauth-fix), and [lehdqlsl/opencode-claude-auth-sync](https://github.com/lehdqlsl/opencode-claude-auth-sync).

## License

MIT
