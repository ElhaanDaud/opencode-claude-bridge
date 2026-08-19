# macOS setup guide

End-to-end setup for running this fork with multi-account rotation on macOS.

Everything below was verified on macOS (Apple Silicon), Node v26, OpenCode
1.18.x, Claude CLI 2.x. Where a step exists because of a non-obvious failure
mode, the reason is stated — those are the steps people skip and then spend an
hour debugging.

---

## 1. Prerequisites

| Requirement | Why | Check |
| --- | --- | --- |
| macOS | Credentials are stored in the login Keychain via `security(1)` | `sw_vers -productName` |
| Node 20+ | The plugin is ESM and the test runner uses glob patterns | `node --version` |
| OpenCode | The host application | `opencode --version` |
| Claude CLI | Source of OAuth credentials for enrollment | `claude --version` |
| An active Claude Pro/Max subscription | OAuth subscription traffic | — |

You need **two or more Claude accounts** for rotation to do anything. With one
account enrolled the pool works but has nowhere to rotate to.

---

## 2. Clone and build

```bash
git clone https://github.com/<you>/opencode-claude-bridge.git ~/src/opencode-claude-bridge
cd ~/src/opencode-claude-bridge
npm ci
npm run build
```

Verify the build before wiring anything up:

```bash
npm run typecheck   # must be silent
npm test            # all tests must pass
```

`npm run build` produces `dist/`. OpenCode loads `dist/index.js`, so **you must
re-run `npm run build` after every source change**, then restart OpenCode.

---

## 3. Register the plugin

### 3.1 Create the wrapper

Do not point OpenCode at `dist/index.js` directly.

OpenCode's plugin loader calls **every named export** of a plugin module as if
it were a plugin factory. This module exports helper functions alongside its
default factory, so the loader invokes one with the plugin-input object, it
throws `modelId.match is not a function`, and the entire plugin fails to load.

A wrapper that re-exports only the default hides the helpers:

```bash
cat > ~/.config/opencode/claude-bridge-wrapper.mjs <<'EOF'
export { default } from "/Users/YOUR_USERNAME/src/opencode-claude-bridge/dist/index.js";
EOF
```

Use an absolute path — `~` is not expanded inside the module specifier.

Confirm the wrapper exposes exactly one export:

```bash
node -e "import('$HOME/.config/opencode/claude-bridge-wrapper.mjs').then(m=>console.log(Object.keys(m)))"
# expected: [ 'default' ]
```

If you see anything besides `default`, OpenCode will crash on load.

### 3.2 Reference it from your config

In `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///Users/YOUR_USERNAME/.config/opencode/claude-bridge-wrapper.mjs"
  ]
}
```

The `file://` prefix and an absolute path are both required.

Do **not** add an `anthropic` provider block. The bridge registers that
provider itself and owns the transport; a manual block competes with it.

---

## 4. Enroll your accounts

### Why the order matters

Both the Claude CLI keychain and OpenCode's `auth.json` hold exactly **one**
Claude credential. Running `claude login` for a second account **destroys the
first account's credentials**. Enrollment copies the current account into the
pool first, which makes the cycle repeatable.

Losing a credential this way is unrecoverable — the account must be logged in
again from scratch.

### The cycle

```bash
alias claude-pool='node ~/src/opencode-claude-bridge/scripts/claude-pool.mjs'

claude login          # account #1
claude-pool enroll    # label derived from its email

claude login          # account #2 — safe, #1 is already captured
claude-pool enroll

claude-pool list      # both should appear
```

Repeat for as many accounts as you like. To choose the label yourself:

```bash
claude-pool enroll work
```

### Expected output

```
LABEL     EMAIL                      TIER   STATUS   TOKEN EXPIRES
 alice    alice@example.com          max    ready    2026-08-20T02:23:10.552Z
*bob      bob@example.com            max    ready    2026-08-20T03:54:35.726Z

* = active account (mirrored into opencode's anthropic slot)
```

The first Keychain write may prompt for your login password. Choose **Always
Allow** if you do not want to be prompted on every rotation.

---

## 5. Verify

Restart OpenCode so it reloads the plugin, then:

```bash
opencode run -m anthropic/claude-haiku-4-5-20251001 "Reply with exactly: OK"
```

Check which account served it:

```bash
claude-pool status
```

Optionally run the full end-to-end scenarios. The first hits the real API; the
rest use a local upstream to simulate rate limits, and the harness restores your
live rotation state on exit:

```bash
cd ~/src/opencode-claude-bridge
node scripts/qa-rotation.mjs
# expected: 6/6 scenarios passed
```

---

## 6. Where everything lives

| Path | Contents | Mode |
| --- | --- | --- |
| Keychain service `opencode-claude-bridge` | One item per enrolled account (the pool; source of truth) | OS-encrypted |
| Keychain service `Claude Code-credentials` | The Claude CLI's own single credential | OS-encrypted |
| `~/.local/share/opencode/auth.json` | OpenCode's single `anthropic` slot — a mirror of the active account | `0600` |
| `~/.local/share/opencode-claude-bridge/rotation-state.json` | Active account, cooldowns, failure counts. No secrets | `0600` |
| `~/.local/share/opencode-claude-bridge/refresh-journal.json` | Transient; exists only mid-refresh | `0600` |

Inspect the pool without exposing secrets:

```bash
security find-generic-password -s opencode-claude-bridge -a <label> | grep acct
cat ~/.local/share/opencode-claude-bridge/rotation-state.json
```

---

## 7. Troubleshooting

### `modelId.match is not a function` on startup

Your config points at `dist/index.js` instead of the wrapper. See §3.1.

### Claude models missing from OpenCode

The plugin failed to load. Check the log:

```bash
grep -i "failed to load plugin" ~/.local/share/opencode/log/opencode.log | tail -5
```

Usually a stale build (`npm run build`) or a wrong wrapper path.

### `OAuth access token has been revoked`

That account's refresh token was consumed elsewhere — commonly by logging into
the same account from another tool, or by any script calling the OAuth refresh
endpoint directly and discarding the replacement.

Anthropic issues a new refresh token on every refresh and invalidates the old
one immediately. **There is no grace window.** The replacement must be
persisted or the account is locked out.

The pool now disables such an account and rotates automatically. To restore it:

```bash
claude login          # as that account
claude-pool enroll    # clears the disabled flag
```

Never call the token endpoint by hand against a stored refresh token.

### `claude-pool whoami` says the credential is superseded

Expected after a rotation. The pool refreshes tokens independently, which makes
the Claude CLI's own copy stale. `claude-pool list` is authoritative.

### Everything is cooling down

```bash
claude-pool status   # shows the earliest reset
```

Requests fail fast as `429` with `retry-after` rather than hanging. If you
believe a cooldown is wrong:

```bash
claude-pool clear-cooldowns
```

### Rotation never happens

```bash
claude-pool list
```

With fewer than two usable accounts there is nowhere to rotate. Accounts marked
`DISABLED` are excluded until re-enrolled.

### Keychain prompts on every rotation

Open **Keychain Access**, find the `opencode-claude-bridge` items, and set
Access Control to always allow `security`.

---

## 8. Updating

```bash
cd ~/src/opencode-claude-bridge
git pull
npm ci && npm run build
```

Restart OpenCode. Enrolled accounts survive upgrades — they live in the
Keychain, not in the repo.

---

## 9. Uninstalling

```bash
# Remove enrolled accounts
claude-pool list
claude-pool remove <label>        # repeat per account

# Remove rotation state
rm -rf ~/.local/share/opencode-claude-bridge

# Unregister the plugin: delete the wrapper entry from opencode.json, then
rm ~/.config/opencode/claude-bridge-wrapper.mjs
```

Removing accounts from the pool does **not** log you out of Claude. The Claude
CLI keeps its own credential, and `~/.local/share/opencode/auth.json` keeps
whichever account was last mirrored — delete its `anthropic` entry if you want
OpenCode to forget it too.

---

## 10. Safety notes

- The pool stores live refresh tokens. Treat a Keychain export as equivalent to
  full account access.
- Do not commit `auth.json`, `rotation-state.json`, or any credential snapshot.
- Avoid keeping plaintext copies of credentials; the Keychain already holds them
  encrypted at rest.
- Rotation only reads a failed response body before streaming begins, so no
  request content is buffered or logged. Tokens are never written to logs.
