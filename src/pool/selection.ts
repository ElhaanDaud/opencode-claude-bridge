import type { AccountState, RotationState, SelectionResult } from "./types.js";

export function isAvailable(state: AccountState, now: number): boolean {
  return (
    !state.disabled &&
    (state.cooldownUntil === null || state.cooldownUntil <= now)
  );
}

function compareLabels(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function selectNext(state: RotationState, now: number): SelectionResult {
  const activeLabel = state.activeLabel;
  if (activeLabel !== null) {
    const active = state.accounts[activeLabel];
    if (active !== undefined && isAvailable(active, now)) {
      return { kind: "selected", label: activeLabel };
    }
  }

  const entries = Object.entries(state.accounts);
  const available = entries
    .filter(([, account]) => isAvailable(account, now))
    .sort(([leftLabel, left], [rightLabel, right]) => {
      return (
        left.failureCount - right.failureCount ||
        left.updatedAt - right.updatedAt ||
        compareLabels(leftLabel, rightLabel)
      );
    });

  if (available.length > 0) {
    return { kind: "selected", label: available[0][0] };
  }

  const cooling = entries
    .filter(
      ([, account]) =>
        !account.disabled &&
        account.cooldownUntil !== null &&
        account.cooldownUntil > now,
    )
    .map(([label, account]) => ({
      label,
      until: account.cooldownUntil as number,
    }))
    .sort((left, right) => left.until - right.until);

  const disabled = entries
    .filter(([, account]) => account.disabled)
    .map(([label]) => label)
    .sort(compareLabels);

  return {
    kind: "exhausted",
    earliestReset: cooling[0]?.until ?? null,
    cooling,
    disabled,
  };
}
