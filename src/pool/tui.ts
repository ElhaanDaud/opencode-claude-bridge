/**
 * Full-screen terminal UI for managing the Claude account pool.
 *
 * Built on Node built-ins only (raw stdin + ANSI escapes). This package has no
 * runtime dependencies and keeping it that way is deliberate — a credential
 * manager should not pull a widget toolkit into its trust boundary.
 *
 * Rendering strategy: draw the whole frame into one string and write it in a
 * single syscall. Incremental cursor updates flicker badly over SSH and are not
 * worth the complexity for a list this small.
 */

import { formatDashboard } from "./dashboard.js";
import { LabelConflictError } from "./enroll.js";
import { renderBar, type AccountUsage } from "./usage.js";
import type { PoolSnapshot, PoolSnapshotRow, RotationManager } from "./manager.js";
import type { RotationStateStore } from "./rotation-state.js";
import type { createAccountStore } from "./secret-store.js";

type AccountStore = ReturnType<typeof createAccountStore>;

const ESC = "\u001b[";
const ALT_SCREEN_ON = `${ESC}?1049h`;
const ALT_SCREEN_OFF = `${ESC}?1049l`;
const CURSOR_HIDE = `${ESC}?25l`;
const CURSOR_SHOW = `${ESC}?25h`;
const CLEAR = `${ESC}2J${ESC}H`;
/** Home the cursor without clearing; each line erases its own tail instead. */
const HOME = `${ESC}H`;
/** Erase from cursor to end of line — prevents ghosts from longer prior frames. */
const EOL = `${ESC}K`;
/** Erase from cursor to end of screen, for when the frame shrinks. */
const EOS = `${ESC}J`;

/**
 * Styling is resolved once, honouring NO_COLOR and dumb terminals. Emitting
 * escapes into a pipe or a CI log is the difference between a readable record
 * and a wall of control characters.
 */
const COLOR =
  !process.env.NO_COLOR && process.env.TERM !== "dumb";
const style = (code: string): string => (COLOR ? code : "");

const DIM = style(`${ESC}2m`);
const BOLD = style(`${ESC}1m`);
const RESET = style(`${ESC}0m`);
const INVERT = style(`${ESC}7m`);
const GREEN = style(`${ESC}32m`);
const YELLOW = style(`${ESC}33m`);
const RED = style(`${ESC}31m`);
const CYAN = style(`${ESC}36m`);

const STATUS_STYLE: Record<PoolSnapshotRow["status"], { icon: string; color: string }> = {
  ready: { icon: "●", color: GREEN },
  cooling: { icon: "◐", color: YELLOW },
  disabled: { icon: "○", color: RED },
};

export interface TuiDeps {
  pool: RotationManager;
  accounts: AccountStore;
  state: RotationStateStore;
  /** Enroll whichever account the Claude CLI is currently logged into. */
  enroll: (label?: string, options?: { replace?: boolean }) => Promise<string>;
  /** Email the Claude CLI is currently logged in as, for the header hint. */
  whoami?: () => Promise<string | null>;
  /**
   * Fetch subscription usage for one account. Network call; used lazily.
   * `allowRefresh` permits rotating an expired OAuth token first, which is a
   * side effect, so it is only ever set from an explicit user action.
   */
  fetchUsage?: (label: string, allowRefresh: boolean) => Promise<AccountUsage>;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

interface Confirm {
  prompt: string;
  run: () => Promise<string>;
}

function relative(target: number, now: number): string {
  const delta = target - now;
  const mins = Math.round(Math.abs(delta) / 60_000);
  const rest = mins % 60;
  const text = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${rest ? `${rest}m` : ""}`;
  return delta >= 0 ? `in ${text}` : `${text} ago`;
}

/**
 * Labels that share an email with a healthier sibling.
 *
 * Every `claude login` mints a fresh refresh token, so re-logging in as the
 * same person enrols a NEW account (`name-2`, `name-3`, …) while the previous
 * entry dies with invalid_grant. Flagging the redundant ones makes that
 * accumulation visible instead of something discovered much later.
 */
export function findRedundant(accounts: PoolSnapshotRow[]): Set<string> {
  const byEmail = new Map<string, PoolSnapshotRow[]>();
  for (const account of accounts) {
    if (!account.email) continue;
    const list = byEmail.get(account.email) ?? [];
    list.push(account);
    byEmail.set(account.email, list);
  }
  const redundant = new Set<string>();
  for (const group of byEmail.values()) {
    if (group.length < 2) continue;
    const keep =
      group.find((a) => a.active) ??
      group.find((a) => a.status === "ready") ??
      group.find((a) => a.status === "cooling") ??
      group[0];
    for (const account of group) {
      if (account.label !== keep.label) redundant.add(account.label);
    }
  }
  return redundant;
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

/**
 * Truncate without padding, for lines that span the terminal.
 *
 * Writing exactly `columns` characters makes the terminal wrap to the next row,
 * so a padded full-width line consumes two rows and the frame drifts — which
 * showed up as a duplicated footer and stale text bleeding through. Trailing
 * space is cleared by the per-line erase instead.
 */
/** Visible length, ignoring escape sequences. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/**
 * Clip every line of a rendered frame to `width` VISIBLE characters, leaving
 * escape sequences intact so colours and the per-line erase still apply.
 */
export function clipFrame(frame: string, width: number, height?: number): string {
  const clipped = frame
    .split("\n")
    .map((line) => {
      let visible = 0;
      let out = "";
      let i = 0;
      while (i < line.length) {
        const escape = line.slice(i).match(/^\u001b\[[0-9;?]*[A-Za-z]/);
        if (escape) {
          out += escape[0];
          i += escape[0].length;
          continue;
        }
        if (visible >= width) {
          // Drop the visible remainder but keep any trailing escapes, so the
          // erase-to-end-of-line still runs.
          const tail = line.slice(i).match(/\u001b\[[0-9;?]*[A-Za-z]/g);
          if (tail) out += tail.join("");
          break;
        }
        out += line[i];
        visible += 1;
        i += 1;
      }
      // Guarantee every line erases its own tail. Requiring each call site to
      // append EOL was fragile: two detail-pane templates contained nested
      // backticks, a bulk edit silently skipped them, and those lines then
      // showed fragments of the longer content they overwrote.
      return out.endsWith(`${ESC}K`) ? out : `${out}${ESC}K`;
    });

  if (height === undefined) return clipped.join("\n");

  // Emit EXACTLY one line per terminal row.
  //
  // Frames change height (expanding a detail pane, a message appearing), and
  // relying on erase-to-end-of-screen left the tail of a taller previous frame
  // on screen — which read as a duplicated footer and stale text merged into
  // the detail pane. A constant-height frame makes leftovers impossible.
  const trailingNewline = clipped.length > 0 && clipped[clipped.length - 1] === "";
  const body = trailingNewline ? clipped.slice(0, -1) : clipped;
  const fitted = body.slice(0, height);
  while (fitted.length < height) fitted.push(`${ESC}K`);
  return `${fitted.join("\n")}\n`;
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

export function createPoolTui(deps: TuiDeps) {
  const stdout = deps.stdout ?? process.stdout;
  const stdin = deps.stdin ?? process.stdin;

  let snapshot: PoolSnapshot = { activeLabel: null, now: Date.now(), accounts: [] };
  let cursor = 0;
  let message = "";
  let confirm: Confirm | null = null;
  let busy = false;
  let running = false;
  let expanded = false;
  let cliEmail: string | null = null;
  let redundant = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let exitResolve: (() => void) | null = null;
  /**
   * label -> usage | null (fetch failed) | "expired" (needs an explicit
   * refresh). Absent means "not fetched yet".
   */
  const usage = new Map<string, AccountUsage | null | "expired">();
  let pendingEscape = "";
  let scroll = 0;
  let lastFrameLines = 0;
  let needsFullClear = true;

  /** Terminal geometry, with sane fallbacks for pipes and odd hosts. */
  function dims(): { cols: number; rows: number } {
    return {
      cols: Math.max(60, stdout.columns ?? 100),
      rows: Math.max(10, stdout.rows ?? 24),
    };
  }

  async function reload(): Promise<void> {
    const next = await deps.pool.snapshot();
    // Rows re-sort by status, so the cursor follows the account, not the index.
    const selectedLabel = selected()?.label;
    snapshot = next;
    redundant = findRedundant(snapshot.accounts);
    const kept = snapshot.accounts.findIndex((a) => a.label === selectedLabel);
    if (kept !== -1) cursor = kept;
    else if (cursor >= snapshot.accounts.length) cursor = Math.max(0, snapshot.accounts.length - 1);
  }

  function render(): void {
    // An action still in flight when the user quits (e.g. `s`) finishes later;
    // drawing then would paint the dashboard over the restored shell.
    if (!running) return;
    const { accounts, now, activeLabel } = snapshot;
    const { cols, rows } = dims();

    // Chrome = title + cli line + optional journal warning + blank + header
    // + blank + footer. Keep a floor so a tiny terminal still shows one row.
    const chrome = 7 + (expanded ? 4 : 0);
    const capacity = Math.max(1, rows - chrome);

    // Keep the cursor inside the viewport, scrolling only as far as needed.
    if (cursor < scroll) scroll = cursor;
    if (cursor >= scroll + capacity) scroll = cursor - capacity + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, accounts.length - capacity)));

    // Widths adapt to the terminal instead of assuming 100+ columns.
    const labelW = Math.min(24, Math.max(12, Math.floor(cols * 0.22)));
    const emailW = Math.min(32, Math.max(14, Math.floor(cols * 0.3)));
    const detailW = Math.max(12, cols - labelW - emailW - 18);
    const ready = accounts.filter((a) => a.status === "ready").length;
    const cooling = accounts.filter((a) => a.status === "cooling").length;
    const disabled = accounts.filter((a) => a.status === "disabled").length;

    const out: string[] = [needsFullClear ? CLEAR : HOME];
    needsFullClear = false;
    let lines = 0;
    /** Push one frame line, erasing any leftover tail from a previous frame. */
    const line = (text: string): void => {
      out.push(`${text}${EOL}${EOL}\n`);
      lines += 1;
    };
    out.push(
      `${BOLD}${CYAN} claude-pool ${RESET}${DIM} ${accounts.length} enrolled · ${RESET}` +
        `${GREEN}${ready} ready${RESET}${DIM} · ${RESET}${YELLOW}${cooling} cooling${RESET}` +
        `${DIM} · ${RESET}${RED}${disabled} disabled${RESET}\n`,
    );
    if (cliEmail) {
      const alreadyIn = accounts.some((a) => a.email === cliEmail);
      out.push(
        `${DIM} claude cli: ${RESET}${cliEmail}` +
          (alreadyIn ? `${DIM} (already enrolled)${RESET}` : `${GREEN} — press e to enroll${RESET}`) +
          "\n",
      );
    }
    const pending = deps.pool.pendingRefreshLabel();
    if (pending) {
      out.push(`${YELLOW} ⚠ pending refresh journal for "${pending}" — a refresh died mid-flight; it replays on next use${RESET}${EOL}\n`,
      );
    }
    out.push("\n");

    if (accounts.length === 0) {
      out.push(`${DIM}  No accounts enrolled.${RESET}\n${EOL}\n`);
      out.push(`  Log in with the Claude CLI, then press ${BOLD}e${RESET} to enroll it.${EOL}\n`);
    } else {
      out.push(`${DIM}   ${pad("LABEL", labelW)} ${pad("EMAIL", emailW)} ${pad("TIER", 5)} DETAIL${RESET}${EOL}\n`,
      );
      accounts.slice(scroll, scroll + capacity).forEach((account, offset) => {
        const index = scroll + offset;
        const style = STATUS_STYLE[account.status];
        const selected = index === cursor;
        const activeMark = account.label === activeLabel ? `${CYAN}▸${RESET}` : " ";

        let detail: string;
        if (account.status === "cooling" && account.cooldownUntil !== null) {
          detail = `back ${relative(account.cooldownUntil, now)}`;
        } else if (account.status === "disabled") {
          detail = account.reason ?? "needs re-login";
        } else {
          detail = `token ${relative(account.tokenExpires, now)}`;
        }

        const dupe = redundant.has(account.label) ? `${YELLOW}⧉${RESET}` : " ";
        const row =
          `${activeMark}${style.color}${style.icon}${RESET}${dupe}` +
          `${pad(account.label, labelW)} ${pad(account.email ?? "—", emailW)} ` +
          `${pad(account.tier ?? "—", 5)} ${DIM}${pad(detail, detailW)}${RESET}`;
        out.push(selected ? `${INVERT}${row}${RESET}\n` : `${row}\n`);

        if (selected && expanded) {
          const win = (at: number | null, name: string): string =>
            at === null ? `${name} —` : `${name} resets ${relative(at, now)}`;
          const bind = account.bindingWindow
            ? ` ${DIM}(binding: ${account.bindingWindow})${RESET}`
            : "";
          // Usage bars, when the /usage data is available. The header-derived
          // reset times are the fallback: they are all we know before an
          // account has been throttled.
          const u = usage.get(account.label);
          const barW = Math.max(10, Math.min(24, Math.floor(cols / 5)));
          const meter = (name: string, w: { utilization: number; resetsAt: number | null } | null) => {
            if (!w) return null;
            const pct = `${w.utilization.toFixed(0)}%`.padStart(4);
            const colour = w.utilization >= 90 ? RED : w.utilization >= 70 ? YELLOW : GREEN;
            const when = w.resetsAt !== null ? ` resets ${relative(w.resetsAt, now)}` : "";
            return `${name} ${colour}${renderBar(w.utilization, barW)}${RESET} ${pct}${DIM}${when}${RESET}`;
          };
          if (u && u !== "expired") {
            const five = meter("5h", u.fiveHour);
            const seven = meter("7d", u.sevenDay);
            if (five) out.push(`${DIM}     ${RESET}${five}\n`);
            if (seven) out.push(`${DIM}     ${RESET}${seven}\n`);
            if (u.sevenDayOpus) {
              const opus = meter("7d opus", u.sevenDayOpus);
              if (opus) out.push(`${DIM}     ${RESET}${opus}\n`);
            }
          } else if (u === "expired") {
            out.push(
              `${DIM}     token expired — press ${RESET}${BOLD}s${RESET}${DIM} to refresh and load usage${RESET}\n`,
            );
          } else if (u === null) {
            out.push(`${DIM}     usage unavailable${RESET}\n`);
          } else if (deps.fetchUsage) {
            out.push(`${DIM}     loading usage…${RESET}\n`);
          } else {
            out.push(
              `${DIM}     ${win(account.fiveHourReset, "5h")}   ` +
                `${win(account.sevenDayReset, "7d")}${RESET}${bind}\n`,
            );
          }
          out.push(
            `${DIM}     tier ${account.rateLimitTier ?? "—"}   ` +
              `failures ${account.failureCount}   ` +
              `enrolled ${relative(account.enrolledAt, now)}${RESET}\n`,
          );
          if (account.scopes?.length) {
            out.push(
              `${DIM}     ${clip(`scopes ${account.scopes.join(" ")}`, cols - 7)}${RESET}${EOL}\n`,
            );
          }
          if (account.reason) {
            out.push(
              `${DIM}     ${clip(`last: ${account.reason}`, cols - 7)}${RESET}${EOL}\n`,
            );
          }
        }
      });
    }

    out.push("\n");
    if (confirm) {
      out.push(`${YELLOW}${confirm.prompt}${RESET}  ${DIM}[y/N]${RESET}${EOL}\n`);
    } else if (busy) {
      out.push(`${DIM}working…${RESET}${EOL}\n`);
    } else if (message) {
      out.push(`${message}${EOL}\n`);
    } else {
      // Two short rows beat one truncated row on a narrow terminal.
      out.push(`${DIM}${clip(" ↑/↓ move  ⏎ details  g/G top/bottom", cols - 1)}${RESET}${EOL}\n`);
      out.push(
        `${DIM}${clip(
          " e enroll  u re-enable  f token  s usage  a activate  x remove  c clear-all  p prune  r reload  q quit",
          cols - 1,
        )}${RESET}${EOL}\n`,
      );
    }
    const { rows: frameRows } = dims();
    if (accounts.length > capacity) {
      const shown = `${scroll + 1}-${Math.min(scroll + capacity, accounts.length)}`;
      out.push(
        `${DIM} showing ${shown} of ${accounts.length}  ` +
          `${scroll > 0 ? "↑" : " "}${scroll + capacity < accounts.length ? "↓" : " "}${RESET}${EOL}\n`,
      );
    }
    lastFrameLines = Math.max(lines, frameRows);

    // Single choke point: guarantee no emitted line reaches the terminal width.
    // A line of exactly `cols` characters wraps, so the frame drifts and stale
    // content from the previous frame shows through — which looked like
    // duplicated footers and merged text. Enforcing it here rather than at each
    // push means a future caller cannot reintroduce the bug.
    stdout.write(clipFrame(out.join(""), cols - 1, rows - 1));
  }

  /** Run a mutating action, keeping the UI responsive and errors on-screen. */
  async function act(label: string, run: () => Promise<string>): Promise<void> {
    busy = true;
    message = "";
    render();
    try {
      message = `${GREEN}${await run()}${RESET}`;
    } catch (err) {
      message = `${RED}${label} failed: ${err instanceof Error ? err.message : String(err)}${RESET}`;
    } finally {
      busy = false;
      await reload();
      render();
    }
  }

  /**
   * Populate the usage cache for one label. Failures are cached as null so a
   * dead token does not retrigger a request on every keystroke.
   */
  async function loadUsage(label: string | undefined, force = false): Promise<void> {
    if (!label || !deps.fetchUsage) return;
    if (!force && usage.has(label)) return;

    // Refreshing an expired token rotates the refresh token, so never do it as
    // a side effect of merely looking at a row. Flag it and wait for `U`.
    const row = snapshot.accounts.find((a) => a.label === label);
    if (!force && row && row.tokenExpires <= Date.now() + 60_000) {
      usage.set(label, "expired");
      if (running) render();
      return;
    }

    try {
      usage.set(label, await deps.fetchUsage(label, force));
    } catch {
      usage.set(label, null);
    }
    if (running) render();
  }

  /**
   * Redraw after the cursor moves, and load usage for the newly selected row
   * when the detail pane is open. Without this the pane showed "loading usage…"
   * forever, because nothing ever requested the new selection's data.
   */
  async function afterMove(): Promise<void> {
    render();
    if (expanded) await loadUsage(selected()?.label);
  }

  function selected(): PoolSnapshotRow | undefined {
    return snapshot.accounts[cursor];
  }

  /**
   * Split a raw stdin chunk into discrete keys.
   *
   * A single read can batch several keypresses (fast typing, paste, or a held
   * arrow key), and CSI sequences can be split across reads. Comparing the
   * whole chunk to "\u001b[A" therefore drops input under load.
   */
  function decodeKeys(chunk: string): string[] {
    const keys: string[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (chunk[i] === "\u001b") {
        const rest = chunk.slice(i);
        const csi = rest.match(/^\u001b\[[0-9;]*[A-Za-z~]/);
        if (csi) {
          keys.push(csi[0]);
          i += csi[0].length;
          continue;
        }
        // A bare ESC, or a sequence truncated at the chunk boundary: hold it
        // so the next chunk can complete it.
        pendingEscape = rest;
        return keys;
      }
      keys.push(chunk[i]!);
      i += 1;
    }
    return keys;
  }

  async function onKey(key: string): Promise<void> {
    if (confirm) {
      const pending = confirm;
      confirm = null;
      if (key === "y" || key === "Y") await act(pending.prompt, pending.run);
      else {
        message = `${DIM}cancelled${RESET}`;
        render();
      }
      return;
    }

    // ctrl-c and q both exit; escape sequences arrive as a single chunk.
    if (key === "q" || key === "\u0003") return stop();
    if (key === "\u001b[A" || key === "k") {
      cursor = Math.max(0, cursor - 1);
      message = "";
      return afterMove();
    }
    if (key === "\u001b[B" || key === "j") {
      cursor = Math.min(Math.max(0, snapshot.accounts.length - 1), cursor + 1);
      message = "";
      return afterMove();
    }
    if (key === "\u001b[5~" || key === "\u0002") {
      cursor = Math.max(0, cursor - Math.max(1, dims().rows - 8));
      message = "";
      return afterMove();
    }
    if (key === "\u001b[6~" || key === "\u0006") {
      cursor = Math.min(
        Math.max(0, snapshot.accounts.length - 1),
        cursor + Math.max(1, dims().rows - 8),
      );
      message = "";
      return afterMove();
    }
    if (key === "g" || key === "\u001b[H") {
      cursor = 0;
      message = "";
      return afterMove();
    }
    if (key === "G" || key === "\u001b[F") {
      cursor = Math.max(0, snapshot.accounts.length - 1);
      message = "";
      return afterMove();
    }
    // Keys arrive concurrently with an in-flight action, which could otherwise
    // replace a pending confirm prompt with one for a different account.
    if (busy) return;
    if (key === "r") return act("reload", async () => "reloaded");
    if (key === "\r" || key === "\n") {
      expanded = !expanded;
      message = "";
      render();
      // Fetch on demand rather than for every account on every frame: it is a
      // network round trip per account and would stall the UI.
      if (expanded) await loadUsage(selected()?.label);
      return;
    }
    if (key === "s") {
      // Usage/stats refresh. Deliberately NOT "U": distinguishing it from "u"
      // (re-enable) by case alone invites a mis-hit on an adjacent action.
      const target = selected();
      if (!target) return;
      usage.delete(target.label);
      return act("usage", async () => {
        await loadUsage(target.label, true);
        return `usage refreshed for "${target.label}"`;
      });
    }
    if (key === "u") {
      const target = selected();
      if (!target) return;
      if (target.status === "ready") {
        message = `${DIM}"${target.label}" is already ready${RESET}`;
        return render();
      }
      // Clears LOCAL health only. If the server-side window is genuinely spent
      // the next request will simply cool it again, which is the honest outcome.
      return act("re-enable", async () => {
        await deps.state.resetHealth(target.label);
        return `re-enabled "${target.label}" (local state only)`;
      });
    }
    if (key === "f") {
      const target = selected();
      if (!target) return;
      return act("token refresh", async () => {
        const tokens = await deps.pool.refreshLabel(target.label);
        return `refreshed "${target.label}" — token now valid ${relative(tokens.expires, Date.now())}`;
      });
    }
    if (key === "p") {
      const stale = snapshot.accounts.filter((a) => redundant.has(a.label));
      if (stale.length === 0) {
        message = `${DIM}no redundant duplicates${RESET}`;
        return render();
      }
      confirm = {
        prompt: `Remove ${stale.length} redundant duplicate${stale.length === 1 ? "" : "s"} (${stale
          .map((a) => a.label)
          .join(", ")})?`,
        run: async () => {
          for (const account of stale) {
            await deps.accounts.removeAccount(account.label);
            await deps.state.forget(account.label);
          }
          return `pruned ${stale.length} duplicate${stale.length === 1 ? "" : "s"}`;
        },
      };
      return render();
    }
    if (key === "e") {
      return act("enroll", async () => {
        try {
          return `enrolled "${await deps.enroll()}"`;
        } catch (err) {
          // A label held by a known different email is resolved by enroll itself;
          // an unknown owner may be this same account, so let the user decide.
          if (!(err instanceof LabelConflictError) || err.existingEmail) throw err;
          const { label } = err;
          confirm = {
            prompt: `"${label}" belongs to an account with no known email. Replace it with the Claude CLI login?`,
            run: async () => `replaced "${await deps.enroll(label, { replace: true })}"`,
          };
          return `"${label}" is already taken`;
        }
      });
    }
    if (key === "c") {
      return act("clear cooldowns", async () => {
        let cleared = 0;
        for (const account of snapshot.accounts) {
          if (account.status !== "ready") {
            await deps.state.resetHealth(account.label);
            cleared += 1;
          }
        }
        return `cleared ${cleared} cooldown${cleared === 1 ? "" : "s"}`;
      });
    }
    if (key === "a") {
      const target = selected();
      if (!target) return;
      return act("set active", async () => {
        await deps.state.setActive(target.label);
        return `active account is now "${target.label}"`;
      });
    }
    if (key === "x") {
      const target = selected();
      if (!target) return;
      // Removal deletes credential material, so it is the one action gated
      // behind a confirmation.
      confirm = {
        prompt: `Remove "${target.label}" and delete its stored credentials?`,
        run: async () => {
          await deps.accounts.removeAccount(target.label);
          await deps.state.forget(target.label);
          return `removed "${target.label}"`;
        },
      };
      return render();
    }
  }

  function stop(): void {
    if (!running) return;
    running = false;
    exitResolve?.();
    exitResolve = null;
    if (timer) clearInterval(timer);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    stdout.write(`${CURSOR_SHOW}${ALT_SCREEN_OFF}`);
    // Not force-exited: the action may be a token refresh, and killing it
    // mid-request can lose the only valid refresh token.
    if (busy) stdout.write("claude-pool: finishing the current action before exiting…\n");
  }

  async function start(): Promise<void> {
    // Without a TTY (CI, pipes) an interactive UI is meaningless, so fall back
    // to printing the static dashboard.
    if (!stdin.isTTY || !stdout.isTTY) {
      await reload();
      stdout.write(`${formatDashboard(snapshot)}\n`);
      return;
    }

    running = true;
    await reload();
    // Best-effort: a missing/expired CLI login must not stop the UI opening.
    try {
      cliEmail = (await deps.whoami?.()) ?? null;
    } catch {
      cliEmail = null;
    }
    stdout.write(`${ALT_SCREEN_ON}${CURSOR_HIDE}`);
    render();

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", (raw: string) => {
      const chunk = pendingEscape + raw;
      pendingEscape = "";
      void (async () => {
        for (const key of decodeKeys(chunk)) {
          if (!running) break;
          await onKey(key);
        }
      })().catch((err) => {
        message = `${RED}${err instanceof Error ? err.message : String(err)}${RESET}`;
        render();
      });
    });

    // Re-render on resize: widths and the viewport are both derived from the
    // terminal size, so a stale frame would be mis-aligned and truncated.
    stdout.on("resize", () => {
      needsFullClear = true;
      if (running) render();
    });

    // Restore the terminal on every exit path. Without this, a SIGINT leaves
    // the user in the alt screen with a hidden cursor and no echo.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        stop();
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    }

    // Cooldowns are time-based, so the countdown must tick without input.
    timer = setInterval(() => {
      if (!busy && !confirm) void reload().then(render);
    }, 30_000);

    process.once("exit", stop);
    // Resolved by stop(); polling for it burned CPU for no reason.
    await new Promise<void>((resolve) => {
      exitResolve = resolve;
    });
  }

  return { start, stop, render, reload, onKey, get snapshot() { return snapshot; } };
}
