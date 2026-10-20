# Setup guide

End-to-end setup for running this fork with multi-account rotation on macOS
and Linux.

Everything below was verified on macOS (Apple Silicon), Node v26, OpenCode
1.18.x, Claude CLI 2.x. The Linux steps follow the same code paths the bridge
uses off-macOS — credentials in files instead of the login Keychain — but they
have not been through an end-to-end run for this document, so treat macOS as
the verified platform. Steps that differ by platform are marked **(macOS)** or
**(Linux)**; everything else is identical on both. Where a step exists because
of a non-obvious failure mode, the reason is stated — those are the steps
people skip and then spend an hour debugging.

---

## 1. Prerequisites

| Requirement | Why | Check |
| --- | --- | --- |
| macOS or Linux | Credential storage differs by platform: macOS uses the login Keychain via `security(1)`; Linux uses files (`~/.claude/.credentials.json` for the CLI, `~/.local/share/opencode-claude-bridge/accounts/` for the pool) | `uname -s` (Linux: `cat /etc/os-release`) |
| Node 20+ | The plugin is ESM and the test runner uses glob patterns | `node --version` |
| OpenCode | The host application | `opencode --version` |
| Claude CLI | Source of OAuth credentials for enrollment | `claude --version` |
| An active Claude Pro/Max subscription | OAuth subscription traffic | — |

You need **two or more Claude accounts** for rotation to do anything. With one
account enrolled the pool works but has nowhere to rotate to.

---

## 2. Clone and build

```bash
git clone https://github.com/ElhaanDaud/opencode-claude-pool.git ~/src/opencode-claude-bridge
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
Replace the placeholder with your home directory (`/Users/...` on macOS,
`/home/...` on Linux); `realpath dist/index.js` from the repo root prints the
correct form.

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

The `file://` prefix and an absolute path are both required (`file:///home/<you>/...`
on Linux — the JSON above shows the macOS form).

Do **not** add an `anthropic` provider block. The bridge registers that
provider itself and owns the transport; a manual block competes with it.

---

## 4. Enroll your accounts

### Why the order matters

Both the Claude CLI's stored credential (the login Keychain on macOS,
`~/.claude/.credentials.json` on Linux) and OpenCode's `auth.json` hold exactly
**one** Claude credential. Running `claude login` for a second account
**destroys the first account's credentials**. Enrollment copies the current
account into the pool first, which makes the cycle repeatable.

Losing a credential this way is unrecoverable — the account must be logged in
again from scratch.

### The cycle

Install the `claude-pool` command first (this also installs the auto-enroll
hook described in the next section):

```bash
# zsh
node ~/src/opencode-claude-bridge/scripts/claude-pool.mjs install-hook >> ~/.zshrc && source ~/.zshrc
# bash — the default on most Linux distros
node ~/src/opencode-claude-bridge/scripts/claude-pool.mjs install-hook >> ~/.bashrc && source ~/.bashrc
```

That defines a `claude-pool` shell function and wraps `claude`, so the full
path is only needed this once.

Then:

```bash
claude login          # account #1
claude-pool enroll    # label derived from its email

claude login          # account #2 — safe, #1 is already captured
claude-pool enroll

claude-pool dashboard # both should appear
```

Repeat for as many accounts as you like. To choose the label yourself:

```bash
claude-pool enroll work
```

### Automatic enrollment

Once the pool holds at least one account, new logins are adopted automatically.

**On OpenCode startup** — the plugin checks whether the Claude CLI is logged
into an account the pool has not seen, and adopts it. Nothing to run.

**Immediately after a login**, without restarting OpenCode: the shell hook you
installed above wraps the `claude` command, so a successful `claude login` is
pooled right away. From then on the whole cycle is just:

```bash
claude login   # done — the account is in the pool
```

You can also run it manually at any time:

```bash
claude-pool auto
```

Auto-enrollment deliberately does nothing when:

| Situation | Why |
| --- | --- |
| The pool is empty | Installing the plugin must never capture credentials from someone who has not opted in. Enroll one account by hand first. |
| The account is already pooled | Matched by refresh token, then by email, so a re-login of the same account refreshes its entry instead of duplicating it |
| The CLI credential is expired | It would enter the pool only to fail its first request and be disabled |
| The account email cannot be resolved | There is no basis for a label; use `claude-pool enroll <label>` |

Set `CLAUDE_POOL_AUTO_ENROLL=0` to disable the startup check.

### Expected output

```
Claude pool — 2 enrolled · 2 ready · 0 cooling · 0 disabled

  ● alice    alice@example.com  ready
▸ ● bob      bob@example.com    ready
```

**(macOS)** The first Keychain write may prompt for your login password.
Choose **Always Allow** if you do not want to be prompted on every rotation.

**(Linux)** There is no prompt: the pool creates
`~/.local/share/opencode-claude-bridge/accounts/` as `0700` with one `0600`
file per account. Those files hold live refresh tokens in plaintext, so home
directory encryption (LUKS, an encrypted home volume) is what protects them at
rest.

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
# expected: 10/10 scenarios passed
node scripts/qa-rotation.mjs s3   # run one scenario (s1–s10)
```

---

## 6. Where everything lives

| Path | Contents | Mode |
| --- | --- | --- |
| **(macOS)** Keychain service `opencode-claude-bridge` / **(Linux)** `~/.local/share/opencode-claude-bridge/accounts/<label>.json` | One item/file per enrolled account (the pool; source of truth) | OS-encrypted / `0600` in a `0700` dir |
| **(macOS)** Keychain service `Claude Code-credentials` / **(Linux)** `~/.claude/.credentials.json` | The Claude CLI's own single credential | OS-encrypted / written by the CLI |
| `~/.local/share/opencode/auth.json` | OpenCode's single `anthropic` slot — a mirror of the active account | `0600` |
| `~/.local/share/opencode-claude-bridge/rotation-state.json` | Active account, cooldowns, failure counts. No secrets | `0600` |
| `~/.local/share/opencode-claude-bridge/refresh-journal.json` | Transient; exists only mid-refresh | `0600` |

If `CLAUDE_CONFIG_DIR` is set, the Claude CLI credential lives at
`$CLAUDE_CONFIG_DIR/.credentials.json` instead of `~/.claude/` — the bridge
honors the variable on both platforms.

Inspect the pool without exposing secrets:

```bash
# macOS — labels only, no token material
security find-generic-password -s opencode-claude-bridge -a <label> | grep acct
# Linux — the account labels are the file names; do not cat them casually,
# each file contains live tokens
ls -l ~/.local/share/opencode-claude-bridge/accounts/

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
the Claude CLI's own copy stale. `claude-pool dashboard` is authoritative.

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
claude-pool dashboard
```

With fewer than two usable accounts there is nowhere to rotate. Accounts marked
`needs re-login` are excluded until re-enrolled, or until `claude-pool enable <label>`
if you know the credential is still good.

### Keychain prompts on every rotation (macOS)

Open **Keychain Access**, find the `opencode-claude-bridge` items, and set
Access Control to always allow `security`.

### `No Claude CLI credentials found at ~/.claude/.credentials.json` (Linux)

Enrollment reads the CLI's credential from that file off-macOS. Either
`claude login` has not been run, or `CLAUDE_CONFIG_DIR` points somewhere else —
when the variable is set, the bridge reads
`$CLAUDE_CONFIG_DIR/.credentials.json` instead.

---

## 8. Updating

```bash
cd ~/src/opencode-claude-bridge
git pull
npm ci && npm run build
```

Restart OpenCode. Enrolled accounts survive upgrades — they live in the
Keychain (macOS) or `~/.local/share/opencode-claude-bridge/accounts/` (Linux),
not in the repo.

---

## 9. Uninstalling

```bash
# Remove enrolled accounts
claude-pool dashboard            # shows the labels
claude-pool remove <label>        # repeat per account

# Remove rotation state
rm -rf ~/.local/share/opencode-claude-bridge

# Unregister the plugin: delete the wrapper entry from opencode.json, then
rm ~/.config/opencode/claude-bridge-wrapper.mjs
```

**(Linux)** the `rm -rf` above already removes the pool: enrolled accounts
live inside `~/.local/share/opencode-claude-bridge/accounts/`. On macOS they
live in the Keychain, which is why the `claude-pool remove` step matters there.

Removing accounts from the pool does **not** log you out of Claude. The Claude
CLI keeps its own credential, and `~/.local/share/opencode/auth.json` keeps
whichever account was last mirrored — delete its `anthropic` entry if you want
OpenCode to forget it too.

---

## 10. Safety notes

- The pool stores live refresh tokens. Treat a Keychain export (macOS) or a copy
  of `accounts/*.json` (Linux) as equivalent to full account access.
- Do not commit `auth.json`, `rotation-state.json`, `accounts/`, or any
  credential snapshot.
- Avoid keeping plaintext copies of credentials. On macOS the Keychain holds
  them encrypted at rest; on Linux the pool files are plaintext `0600`, so
  full-disk encryption is what protects them.
- Rotation only reads a failed response body before streaming begins, so no
  request content is buffered or logged. Tokens are never written to logs.
