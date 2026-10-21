import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import tui, { diffPoolSnapshots, parsePoolSnapshot, watchPoolState } from "./tui.js";
import type { PoolAccountSnapshot, PoolSnapshot } from "./tui.js";

const NOW = 1_000_000;
const ok = (): PoolAccountSnapshot => ({ cooldownUntil: null, disabled: false, lastReason: null });
const snap = (activeLabel: string | null, accounts: Record<string, Partial<PoolAccountSnapshot>>): PoolSnapshot => ({
  activeLabel,
  accounts: Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, { ...ok(), ...v }])),
});

test("initial snapshot produces no events", () => {
  assert.deepEqual(diffPoolSnapshots(null, snap("a", { a: {}, b: { disabled: true } }), NOW), []);
});

test("active switch", () => {
  const events = diffPoolSnapshots(snap("a", { a: {}, b: {} }), snap("b", { a: {}, b: {} }), NOW);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.variant, "info");
  assert.equal(events[0]!.message, 'Switched from "a" to "b"');
});

test("no switch toast when there was no previous active account", () => {
  assert.deepEqual(diffPoolSnapshots(snap(null, { a: {} }), snap("a", { a: {} }), NOW), []);
});

test("newly disabled account carries reason and re-login hint, once", () => {
  const before = snap("a", { a: {}, b: {} });
  const after = snap("a", { a: {}, b: { disabled: true, lastReason: "revoked".repeat(30) } });
  const events = diffPoolSnapshots(before, after, NOW);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.variant, "error");
  assert.match(events[0]!.message, /^"b" disabled \(revoked/);
  assert.match(events[0]!.message, /…\); re-login, then claude-pool enroll$/);
  assert.deepEqual(diffPoolSnapshots(after, after, NOW), []);
});

test("added account", () => {
  const events = diffPoolSnapshots(snap("a", { a: {} }), snap("a", { a: {}, b: {} }), NOW);
  assert.deepEqual(events.map((e) => [e.variant, e.message]), [["success", 'Added "b" to the pool']]);
});

test("pool exhausted fires on transition only, with earliest reset", () => {
  const before = snap("a", { a: {}, b: {} });
  const after = snap("a", {
    a: { cooldownUntil: NOW + 30 * 60_000 },
    b: { cooldownUntil: NOW + 90 * 60_000 },
  });
  const events = diffPoolSnapshots(before, after, NOW);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.variant, "warning");
  assert.equal(events[0]!.message, "Claude pool exhausted — next account free in 30m (a)");
  assert.equal(events[0]!.dedupeKey, `exhausted:${NOW + 30 * 60_000}`);
  assert.deepEqual(diffPoolSnapshots(after, after, NOW), []);
});

test("exhausted with disabled accounts mixed in; expired cooldown is available", () => {
  const before = snap("a", { a: {}, b: {} });
  const mixed = snap("a", { a: { cooldownUntil: NOW + 60_000 }, b: { disabled: true } });
  assert.match(diffPoolSnapshots(before, mixed, NOW).at(-1)!.message, /free in 1m \(a\); 1 disabled/);
  const expired = snap("a", { a: { cooldownUntil: NOW - 1 }, b: { disabled: true } });
  assert.deepEqual(diffPoolSnapshots(before, expired, NOW).filter((e) => e.variant === "warning"), []);
});

test("all disabled is exhausted", () => {
  const events = diffPoolSnapshots(snap("a", { a: {} }), snap("a", { a: { disabled: true } }), NOW);
  assert.deepEqual(events.map((e) => e.variant), ["error", "warning"]);
  assert.match(events[1]!.message, /"a" disabled; re-login/);
});

test("parsePoolSnapshot tolerates garbage", () => {
  assert.equal(parsePoolSnapshot("{nope"), null);
  assert.equal(parsePoolSnapshot("null"), null);
  assert.equal(parsePoolSnapshot("{}"), null);
  const s = parsePoolSnapshot('{"activeLabel":3,"accounts":{"a":{"disabled":true},"b":5}}');
  assert.deepEqual(s, { activeLabel: null, accounts: { a: { cooldownUntil: null, disabled: true, lastReason: null } } });
});

test("watchPoolState: missing file is silent, later changes are reported, cleanup stops", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-tui-"));
  const file = path.join(dir, "state.json");
  const write = (state: object) => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
    fs.renameSync(`${file}.tmp`, file);
  };
  const seen: string[] = [];
  const stop = watchPoolState({ statePath: file, onEvents: (e) => seen.push(...e.map((x) => x.message)) });
  try {
    write({ activeLabel: "a", accounts: { a: {}, b: {} } });
    await new Promise((r) => setTimeout(r, 400));
    fs.writeFileSync(file, "{corrupt");
    await new Promise((r) => setTimeout(r, 400));
    write({ activeLabel: "b", accounts: { a: {}, b: {} } });
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(seen, ['Switched from "a" to "b"']);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setup toasts through context.ui.toast, deduped, and never throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocb-tui-"));
  const file = path.join(dir, "state.json");
  const prevEnv = process.env.CLAUDE_POOL_STATE_PATH;
  process.env.CLAUDE_POOL_STATE_PATH = file;
  const shown: string[] = [];
  const cleanup = tui.setup({ ui: { toast: { show: (o) => void shown.push(o.message) } } });
  try {
    assert.equal(typeof cleanup, "function");
    fs.writeFileSync(file, JSON.stringify({ activeLabel: "a", accounts: { a: {} } }));
    await new Promise((r) => setTimeout(r, 400));
    fs.writeFileSync(file, JSON.stringify({ activeLabel: "a", accounts: { a: {}, b: {} } }));
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(shown, ['Added "b" to the pool']);
    assert.equal(tui.id, "opencode-claude-bridge");
  } finally {
    if (typeof cleanup === "function") cleanup();
    if (prevEnv === undefined) delete process.env.CLAUDE_POOL_STATE_PATH;
    else process.env.CLAUDE_POOL_STATE_PATH = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
