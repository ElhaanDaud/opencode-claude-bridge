import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isAvailable, selectNext } from "./selection.js";
import type { AccountState, RotationState } from "./types.js";

const NOW = 1_000;

function account(overrides: Partial<AccountState> = {}): AccountState {
  return {
    cooldownUntil: null,
    disabled: false,
    failureCount: 0,
    lastReason: null,
    updatedAt: 0,
    ...overrides,
  };
}

function state(
  accounts: Record<string, AccountState>,
  activeLabel: string | null = null,
): RotationState {
  return { version: 1, activeLabel, accounts };
}

describe("selectNext", () => {
  it("keeps the active account when it is available", () => {
    const result = selectNext(
      state(
        {
          rested: account({ failureCount: 0, updatedAt: 0 }),
          active: account({ failureCount: 4, updatedAt: 500 }),
        },
        "active",
      ),
      NOW,
    );

    assert.deepEqual(result, { kind: "selected", label: "active" });
  });

  it("selects another available account when the active account is cooling", () => {
    const result = selectNext(
      state(
        {
          active: account({ cooldownUntil: NOW + 100 }),
          backup: account(),
        },
        "active",
      ),
      NOW,
    );

    assert.deepEqual(result, { kind: "selected", label: "backup" });
  });

  it("reports all cooling accounts in reset order when none are available", () => {
    const result = selectNext(
      state({
        later: account({ cooldownUntil: NOW + 300 }),
        sooner: account({ cooldownUntil: NOW + 100 }),
        middle: account({ cooldownUntil: NOW + 200 }),
      }),
      NOW,
    );

    assert.deepEqual(result, {
      kind: "exhausted",
      earliestReset: NOW + 100,
      cooling: [
        { label: "sooner", until: NOW + 100 },
        { label: "middle", until: NOW + 200 },
        { label: "later", until: NOW + 300 },
      ],
      disabled: [],
    });
  });

  it("never selects disabled accounts and reports them on exhaustion", () => {
    const selected = selectNext(
      state({
        disabled: account({ disabled: true }),
        available: account(),
      }),
      NOW,
    );
    assert.deepEqual(selected, { kind: "selected", label: "available" });

    const exhausted = selectNext(
      state({
        zebra: account({ disabled: true }),
        alpha: account({ disabled: true }),
      }),
      NOW,
    );
    assert.deepEqual(exhausted, {
      kind: "exhausted",
      earliestReset: null,
      cooling: [],
      disabled: ["alpha", "zebra"],
    });
  });

  it("uses label order as a stable final tie-break", () => {
    const rotation = state({
      zebra: account({ failureCount: 2, updatedAt: 50 }),
      alpha: account({ failureCount: 2, updatedAt: 50 }),
    });

    for (let call = 0; call < 5; call += 1) {
      assert.deepEqual(selectNext(rotation, NOW), {
        kind: "selected",
        label: "alpha",
      });
    }
  });

  it("treats a cooldown timestamp in the past as available", () => {
    const result = selectNext(
      state({ recovered: account({ cooldownUntil: NOW - 1 }) }),
      NOW,
    );

    assert.deepEqual(result, { kind: "selected", label: "recovered" });
  });

  it("reports an empty pool as exhausted", () => {
    assert.deepEqual(selectNext(state({}), NOW), {
      kind: "exhausted",
      earliestReset: null,
      cooling: [],
      disabled: [],
    });
  });

  it("falls through when activeLabel is not present", () => {
    const rotation = state({ backup: account() }, "missing");

    assert.doesNotThrow(() => selectNext(rotation, NOW));
    assert.deepEqual(selectNext(rotation, NOW), {
      kind: "selected",
      label: "backup",
    });
  });

  it("prefers lower failureCount over earlier updatedAt", () => {
    const result = selectNext(
      state({
        olderButFailing: account({ failureCount: 2, updatedAt: 0 }),
        newerButHealthy: account({ failureCount: 1, updatedAt: 900 }),
      }),
      NOW,
    );

    assert.deepEqual(result, {
      kind: "selected",
      label: "newerButHealthy",
    });
  });
});

describe("isAvailable", () => {
  it("accepts a null cooldown", () => {
    assert.equal(isAvailable(account({ cooldownUntil: null }), NOW), true);
  });

  it("accepts a past cooldown", () => {
    assert.equal(isAvailable(account({ cooldownUntil: NOW - 1 }), NOW), true);
  });

  it("rejects a future cooldown", () => {
    assert.equal(isAvailable(account({ cooldownUntil: NOW + 1 }), NOW), false);
  });

  it("rejects a disabled account with no cooldown", () => {
    assert.equal(
      isAvailable(account({ disabled: true, cooldownUntil: null }), NOW),
      false,
    );
  });
});
