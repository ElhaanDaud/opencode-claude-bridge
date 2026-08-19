import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classify, DEFAULT_UNKNOWN_COOLDOWN_MS } from "./classifier.js";
import type { ClassifyInput, RotationDecision } from "./types.js";

const NOW = Date.parse("2026-10-21T05:28:00Z");

function input(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    status: 429,
    headers: {},
    now: NOW,
    ...overrides,
  };
}

describe("classify", () => {
  it("retries the same account for a 30-second retry-after", () => {
    const decision = classify(input({ headers: { "retry-after": "30" } }));

    assert.equal(decision.action, "RETRY_SAME");
    assert.equal(decision.backoffMs, 30_000);
    assert.equal(decision.source, "retry-after");
  });

  it("rotates for a one-hour retry-after", () => {
    const decision = classify(input({ headers: { "retry-after": "3600" } }));

    assert.equal(decision.action, "ROTATE_COOLDOWN");
    assert.equal(decision.until, NOW + 3_600_000);
    assert.equal(decision.source, "retry-after");
  });

  it("retries at the 60-second boundary", () => {
    const decision = classify(input({ headers: { "retry-after": "60" } }));

    assert.equal(decision.action, "RETRY_SAME");
    assert.equal(decision.backoffMs, 60_000);
  });

  it("rotates above the 60-second boundary", () => {
    const decision = classify(input({ headers: { "retry-after": "61" } }));

    assert.equal(decision.action, "ROTATE_COOLDOWN");
    assert.equal(decision.until, NOW + 61_000);
  });

  it("uses an RFC 3339 unified reset header", () => {
    const decision = classify(
      input({
        headers: { "anthropic-ratelimit-unified-reset": "2026-10-21T07:28:00Z" },
      }),
    );

    assert.equal(decision.action, "ROTATE_COOLDOWN");
    assert.equal(decision.until, NOW + 2 * 60 * 60 * 1000);
    assert.equal(decision.source, "unified-reset");
  });

  it("uses the later of the input and output token resets", () => {
    const decision = classify(
      input({
        headers: {
          "anthropic-ratelimit-input-tokens-reset": "2026-10-21T05:58:00Z",
          "anthropic-ratelimit-output-tokens-reset": "2026-10-21T06:58:00Z",
        },
      }),
    );

    assert.equal(decision.action, "ROTATE_COOLDOWN");
    assert.equal(decision.until, NOW + 90 * 60 * 1000);
    assert.equal(decision.source, "token-reset");
  });

  it("conservatively rotates when a 429 has no reset hint", () => {
    const decision = classify(input());

    assert.equal(decision.action, "ROTATE_COOLDOWN");
    assert.equal(decision.until, NOW + DEFAULT_UNKNOWN_COOLDOWN_MS);
    assert.equal(decision.source, "default");
  });

  it("parses retry-after as an HTTP-date", () => {
    const decision = classify(
      input({ headers: { "retry-after": "Wed, 21 Oct 2026 05:28:45 GMT" } }),
    );

    assert.equal(decision.action, "RETRY_SAME");
    assert.equal(decision.backoffMs, 45_000);
    assert.equal(decision.source, "retry-after");
  });

  it("permanently disables an account suspended by a 403", () => {
    const decision = classify(input({ status: 403, bodyText: "Account SUSPENDED by policy" }));

    assert.equal(decision.action, "ROTATE_DISABLE");
    assert.equal(decision.source, "body-hint");
  });

  it("temporarily cools down a generic 403", () => {
    const decision = classify(input({ status: 403, bodyText: "forbidden" }));

    assert.equal(decision.action, "ROTATE_COOLDOWN");
    assert.equal(decision.until, NOW + DEFAULT_UNKNOWN_COOLDOWN_MS);
    assert.equal(decision.source, "default");
  });

  it("passes a 401 through", () => {
    const decision = classify(input({ status: 401 }));

    assert.equal(decision.action, "PASS_THROUGH");
    assert.equal(decision.source, "status");
  });

  it("passes a 2xx response through without inspecting its body", () => {
    const decision = classify(input({ status: 200, bodyText: "account suspended" }));

    assert.equal(decision.action, "PASS_THROUGH");
    assert.equal(decision.source, "status");
  });

  it("retries a 529 up to the transient-attempt limit", () => {
    const first = classify(input({ status: 529, attempt: 0 }));
    const exhausted = classify(input({ status: 529, attempt: 3 }));

    assert.equal(first.action, "RETRY_SAME");
    assert.equal(first.backoffMs, 1_000);
    assert.equal(first.source, "status");
    assert.equal(exhausted.action, "PASS_THROUGH");
    assert.equal(exhausted.source, "status");
  });

  it("does not throw on malformed headers and malformed JSON", () => {
    let decision: RotationDecision | undefined;

    assert.doesNotThrow(() => {
      decision = classify(
        input({ headers: { "retry-after": "banana" }, bodyText: "{not-json" }),
      );
    });
    assert.equal(decision?.action, "ROTATE_COOLDOWN");
    assert.equal(decision?.until, NOW + DEFAULT_UNKNOWN_COOLDOWN_MS);
    assert.equal(decision?.source, "default");
  });

  it("gives retry-after precedence over every later ladder rung", () => {
    const decision = classify(
      input({
        headers: {
          "retry-after": "30",
          "anthropic-ratelimit-unified-reset": "2026-10-21T07:28:00Z",
          "anthropic-ratelimit-input-tokens-reset": "2026-10-21T08:28:00Z",
          "anthropic-ratelimit-output-tokens-reset": "2026-10-21T09:28:00Z",
        },
      }),
    );

    assert.equal(decision.action, "RETRY_SAME");
    assert.equal(decision.backoffMs, 30_000);
    assert.equal(decision.source, "retry-after");
  });

  it("uses a duration from a JSON error message as a body hint", () => {
    const decision = classify(
      input({ bodyText: JSON.stringify({ error: { message: "Usage resets in 2 hours" } }) }),
    );

    assert.equal(decision.action, "ROTATE_COOLDOWN");
    assert.equal(decision.until, NOW + 2 * 60 * 60 * 1000);
    assert.equal(decision.source, "body-hint");
  });
});
