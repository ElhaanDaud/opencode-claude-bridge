/**
 * Classifier calibration against REAL Anthropic OAuth subscription headers,
 * captured live from api.anthropic.com on 2026-08-19 (request-id
 * req_011CeCjRtFES4r1ZffHDTjvs). These header names and value formats are not
 * publicly documented, so these fixtures are the only thing pinning them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classify } from "./classifier.js";

// Verbatim from the live 200 response.
const LIVE_ALLOWED_HEADERS: Record<string, string> = {
  "anthropic-ratelimit-unified-5h-reset": "1787172000",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.52",
  "anthropic-ratelimit-unified-7d-reset": "1787486400",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.57",
  "anthropic-ratelimit-unified-fallback": "available",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-reset": "1787172000",
  "anthropic-ratelimit-unified-status": "allowed",
};

// 1787172000 = 2026-08-20T02:00:00Z, the 5h window reset observed live.
const FIVE_HOUR_RESET_S = 1_787_172_000;
const SEVEN_DAY_RESET_S = 1_787_486_400;
const NOW = (FIVE_HOUR_RESET_S - 3_600) * 1000;

describe("live header calibration: epoch-seconds reset values", () => {
  it("reads the unified reset as epoch seconds, not RFC 3339", () => {
    const decision = classify({
      status: 429,
      headers: { ...LIVE_ALLOWED_HEADERS, "anthropic-ratelimit-unified-status": "rejected" },
      now: NOW,
    });

    assert.equal(decision.action, "ROTATE_COOLDOWN");
    // One hour out. Misreading epoch seconds as milliseconds would put this
    // ~56 years in the past and permanently strand the account.
    assert.equal(decision.until, FIVE_HOUR_RESET_S * 1000);
  });
});

describe("live header calibration: account-level status outranks retry-after", () => {
  it("rotates on a rejected window even when retry-after is short", () => {
    const decision = classify({
      status: 429,
      headers: {
        ...LIVE_ALLOWED_HEADERS,
        "anthropic-ratelimit-unified-status": "rejected",
        "retry-after": "5",
      },
      now: NOW,
    });

    // A 5-second retry-after would otherwise mean RETRY_SAME, hammering an
    // account whose 5-hour quota is already spent.
    assert.equal(decision.action, "ROTATE_COOLDOWN");
    assert.match(decision.reason, /usage window rejected/i);
  });

  it("still honours a short retry-after while the window is allowed", () => {
    const decision = classify({
      status: 429,
      headers: { ...LIVE_ALLOWED_HEADERS, "retry-after": "5" },
      now: NOW,
      attempt: 0,
    });

    assert.equal(decision.action, "RETRY_SAME");
  });
});

describe("live header calibration: representative-claim selects the binding window", () => {
  it("uses the 7-day reset when the weekly quota is the binding claim", () => {
    const decision = classify({
      status: 429,
      headers: {
        ...LIVE_ALLOWED_HEADERS,
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-representative-claim": "seven_day",
      },
      now: NOW,
    });

    // Weekly exhaustion must not be treated as a 5-hour cooldown, or the
    // account is returned to the pool days early and fails every request.
    assert.equal(decision.until, SEVEN_DAY_RESET_S * 1000);
  });

  it("uses the 5-hour reset when that is the binding claim", () => {
    const decision = classify({
      status: 429,
      headers: { ...LIVE_ALLOWED_HEADERS, "anthropic-ratelimit-unified-status": "rejected" },
      now: NOW,
    });

    assert.equal(decision.until, FIVE_HOUR_RESET_S * 1000);
  });
});

describe("live header calibration: healthy responses are untouched", () => {
  it("passes through a 200 carrying the full unified header set", () => {
    const decision = classify({ status: 200, headers: LIVE_ALLOWED_HEADERS, now: NOW });
    assert.equal(decision.action, "PASS_THROUGH");
  });
});
