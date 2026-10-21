# Installing opencode-claude-pool (instructions for an AI agent)

You are installing the opencode-claude-pool plugin on the user's machine. Follow
these steps in order. Run commands yourself where marked, and stop and hand over
to the user where marked. Tell the user what you are about to change before you
edit any file outside the repository.

## Rules

- Supported platforms: macOS and Linux. On Windows, stop and tell the user it is not supported.
- Never print, copy or log OAuth tokens, `auth.json`, keychain items or files
  under `~/.local/share/opencode-claude-bridge/accounts/`.
- Never call the Anthropic OAuth token endpoint yourself. Refresh tokens rotate
  on every use, so spending one by hand locks the account out.
- Do not overwrite `~/.config/opencode/opencode.json`. Back it up, then edit it
  in place and keep every existing entry.
- If any step fails, show the user the error and stop. Do not improvise around it.

## 1. Check prerequisites

Run each of these and report what is missing:

```bash
uname -s
node --version     # needs v20 or newer
npm --version
git --version
claude --version   # Claude CLI, used to log accounts in
opencode --version
```

If `claude` is missing, tell the user to install the Claude CLI
(https://docs.anthropic.com/en/docs/claude-code) and stop. If `opencode` is
missing, tell the user to install OpenCode (https://opencode.ai) and stop.

## 2. Detect the OpenCode version

Take the first `X.Y.Z` in the `opencode --version` output (V1 prints `1.18.30`,
V2 prints `opencode v2.1.2`). Its major number picks the build:

| Major | Branch | Plugin config key | Entry to register |
| --- | --- | --- | --- |
| `1` | `main` | `plugin` | the wrapper file from step 4a |
| `2` | `feat/opencode-2` | `plugins` | the `dist/opencode2` directory |

Anything else: tell the user the version is not supported and stop. Tell the
user which version you detected and which branch you are installing.

## 3. Clone and build

`REPO` is `~/src/opencode-claude-bridge` and `BRANCH` is the branch from step 2.

If `REPO` does not exist:

```bash
git clone -b BRANCH https://github.com/ElhaanDaud/opencode-claude-pool.git ~/src/opencode-claude-bridge
```

If it already exists, check `git -C ~/src/opencode-claude-bridge status --short`.
If it has local changes, stop and ask the user what to do with them. Otherwise:

```bash
git -C ~/src/opencode-claude-bridge fetch origin
git -C ~/src/opencode-claude-bridge checkout BRANCH
git -C ~/src/opencode-claude-bridge pull --ff-only
```

Then build and test:

```bash
cd ~/src/opencode-claude-bridge && npm ci && npm run build && npm test
```

All tests must pass before you continue.

## 4. Register the plugin

Back up the config first if it exists:

```bash
cp ~/.config/opencode/opencode.json ~/.config/opencode/opencode.json.bak
```

The file may be JSONC (comments allowed). Edit it in place, and use the user's
real absolute home path, since `~` is not expanded in these URLs. If the user
has no `opencode.json`, create one containing only the key below.

Do not add an `anthropic` provider block, and do not register both versions:
V1 and V2 read the same config file.

### 4a. OpenCode 1.x

OpenCode 1 calls every named export of a plugin as a factory, so it must load a
wrapper that re-exports only the default:

```bash
mkdir -p ~/.config/opencode
echo "export { default } from \"$HOME/src/opencode-claude-bridge/dist/index.js\";" \
  > ~/.config/opencode/claude-bridge-wrapper.mjs
node -e "import('$HOME/.config/opencode/claude-bridge-wrapper.mjs').then(m=>console.log(Object.keys(m)))"
# must print: [ 'default' ]
```

Add the wrapper to the `plugin` array, keeping existing entries:

```json
"plugin": ["file:///ABSOLUTE/HOME/.config/opencode/claude-bridge-wrapper.mjs"]
```

### 4b. OpenCode 2.x

OpenCode 2 only loads a local plugin from a directory. Add the build's
`dist/opencode2` directory to the `plugins` array, keeping existing entries:

```json
"plugins": ["file:///ABSOLUTE/HOME/src/opencode-claude-bridge/dist/opencode2"]
```

If the file still has a V1 `plugin` entry pointing at `claude-bridge-wrapper.mjs`,
tell the user and remove it only if they agree: V2 migrates that key and fails to
load the wrapper.

## 5. Install the claude-pool command

This appends a shell function to the user's shell rc file. Ask before running it.

```bash
# zsh
node ~/src/opencode-claude-bridge/scripts/claude-pool.mjs install-hook >> ~/.zshrc
# bash
node ~/src/opencode-claude-bridge/scripts/claude-pool.mjs install-hook >> ~/.bashrc
```

Until the user opens a new shell, call it as
`node ~/src/opencode-claude-bridge/scripts/claude-pool.mjs <command>`.

## 6. Enroll accounts (hand over to the user)

Logging in is interactive and each login overwrites the Claude CLI's stored
credential, so the user must do this. Give them these steps verbatim:

```bash
claude login          # log in as account 1
claude-pool enroll

claude login          # log in as account 2; account 1 is already saved
claude-pool enroll

claude-pool dashboard # every account should show as ready
```

Rotation needs at least two accounts. Wait for the user to confirm, then run
`claude-pool dashboard` yourself (it prints a plain summary when not run in a
terminal) and check that no account shows `needs re-login` or `disabled`.

## 7. Verify

Ask the user to restart OpenCode, then run:

- OpenCode 2: `opencode run --standalone --print-logs -m anthropic/claude-haiku-4-5-20251001 "Reply with exactly: OK" 2>&1 | grep -c "dist/opencode2/server.js"`
  must print a number above 0. (`opencode plugin list` doesn't list directory
  plugins on 2.1.)
- Both versions:

  ```bash
  opencode run -m anthropic/claude-haiku-4-5-20251001 "Reply with exactly: OK"
  claude-pool status
  ```

  The reply should be `OK`, and `status` should name the account that served it.

Report the result to the user. If `opencode run` fails, show them the error and
point them to the troubleshooting section of
https://github.com/ElhaanDaud/opencode-claude-pool/blob/main/SETUP.md.
