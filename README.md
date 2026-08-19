# opencode-claude-bridge

Use your Claude Pro/Max subscription in [OpenCode](https://opencode.ai). If you're logged into the Claude CLI, it just works — no extra setup.

## Install

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-claude-bridge"]
}
```

OpenCode auto-installs the plugin from npm on next launch.

If you're logged into the Claude CLI (`claude login`), the plugin auto-syncs your credentials — just select an Anthropic model and start chatting. If not, you'll be prompted to authenticate via browser OAuth or enter an API key.

**Upgrade:**

OpenCode pins the installed version. To upgrade to the latest:

```bash
cd ~/.cache/opencode && npm install opencode-claude-bridge@latest
```

Then restart OpenCode.

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/dotCipher/opencode-claude-bridge.git ~/opencode-claude-bridge
cd ~/opencode-claude-bridge && npm install && npm run build
```

Then reference the full path in your config:

```json
{
  "plugin": ["/Users/YOU/opencode-claude-bridge/dist/index.js"]
}
```
</details>

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
- **System prompt** — Claude Code's real system prompt is captured via the validator and cached at `~/.cache/opencode-claude-bridge/claude-system-prompt.json`. The bridge injects this as the system prompt for all requests. OpenCode's default system prompt is sanitized out.
- **MCP tool prefixing** — OpenCode's MCP tools are prefixed with `mcp_` to match Claude Code's convention.

### Tool wire-matching (v1.9.0)

Claude Code sends 26 captured core tools (plus user-specific MCP tools). OpenCode has 10. These differ in names, descriptions, schemas, parameter names, required fields, and sort order.

The bridge resolves this by:

1. **Replacing OpenCode's tool definitions only for Claude-compatible targets** with Claude Code's exact wire-captured definitions — matching descriptions, JSON schemas, parameter names, and required fields.
2. **Adding 16 Claude-only stub tools**: `AskUserQuestion`, `CronCreate`, `CronDelete`, `CronList`, `EnterPlanMode`, `EnterWorktree`, `ExitPlanMode`, `ExitWorktree`, `Monitor`, `NotebookEdit`, `PushNotification`, `RemoteTrigger`, `ScheduleWakeup`, `TaskOutput`, `TaskStop`, `WebSearch`.
3. **Sorting all 26 tools alphabetically** to match Claude Code's ordering.

If the model calls a stub tool, OpenCode's built-in error handling catches it, tells the model the tool is unavailable, and the model adapts on the next turn.

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

### Dynamic fingerprint computation

The `cc_version` billing metadata suffix (a 3-character hex string like `df0` or `e0a`) is computed dynamically per request using the same algorithm as Claude Code:

```
SHA256(salt + message[4] + message[7] + message[20] + CLI_VERSION).slice(0, 3)
```

The salt is hardcoded in Claude Code's source. This changes per conversation because the user's message text changes.

## Multi-account rotation

> macOS setup, enrollment order and troubleshooting: **[SETUP.md](SETUP.md)**

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

Accounts are matched by refresh token, so re-logging into a pooled account is
never duplicated. Set `CLAUDE_POOL_AUTO_ENROLL=0` to disable.

### Commands

| Command | Purpose |
| --- | --- |
| `claude-pool enroll [label] [--replace]` | Add the account Claude CLI is logged into |
| `claude-pool whoami` | Show which account Claude CLI is logged into, and whether it is pooled |
| `claude-pool list` | Every enrolled account with its status and token expiry |
| `claude-pool status` | Active account and what rotation would pick next |
| `claude-pool remove <label>` | Drop an account |
| `claude-pool clear-cooldowns` | Re-enable everything after a rate-limit storm |

Run these as `node scripts/claude-pool.mjs <command>`.

### When rotation happens

Every failed response is classified before the response body is read:

| Signal | Action |
| --- | --- |
| `429` with a reset under 60s | Back off, retry the **same** account |
| `429` with a longer reset, or `anthropic-ratelimit-unified-status` not `allowed` | Cool the account down until its reset, switch accounts |
| `403` naming suspension | Disable the account permanently, switch |
| `401` | Credential rejected even after refresh — disable, switch |
| Every account cooling | Fail fast as `429`, naming each account and the earliest reset |

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
refreshes would spend the same token twice.

The practical consequence: **after the pool refreshes an account, the Claude
CLI's own stored copy of that credential is stale.** That is expected. Run
`claude-pool list` rather than trusting the CLI's view.

## Requirements

- [OpenCode](https://opencode.ai) v1.2+
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

Most users won't need to change these — the bridge auto-detects the installed Claude CLI version and uses matching defaults.

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
  index.ts          — Main plugin entry point: tool replacement, request/response
                      transformation, bidirectional parameter translation (~886 lines)
  claude-tools.ts   — 24 Claude Code tool definitions, fingerprint computation,
                      parameter translation maps (~757 lines)
  constants.ts      — Version strings, URLs, env overrides, header values (117 lines)
  keychain.ts       — macOS Keychain access for OAuth tokens
  oauth.ts          — OAuth PKCE flow with local callback server

scripts/
  validate-opencode-oauth.js  — Side-by-side wire comparison tool
  intercept-claude.sh         — mitmproxy-based Claude CLI request capture
```

## Important limitation

Anthropic's own Claude Code docs say third-party integrations should use API key authentication. This bridge can make OAuth requests look much closer to current Claude Code traffic, but Anthropic may still apply server-side classification that a bridge cannot fully control.

## Credits

Combines approaches from [shahidshabbir-se/opencode-anthropic-oauth](https://github.com/shahidshabbir-se/opencode-anthropic-oauth), [ex-machina-co/opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth), [vinzabe/PERMANENT-opencode-anthropic-oauth-fix](https://github.com/vinzabe/PERMANENT-opencode-anthropic-oauth-fix), and [lehdqlsl/opencode-claude-auth-sync](https://github.com/lehdqlsl/opencode-claude-auth-sync).

## License

MIT
