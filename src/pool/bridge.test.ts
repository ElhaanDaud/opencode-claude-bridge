import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPoolBusyResponse } from "./bridge.js";

describe("pool busy response", () => {
  it("is a retryable 503 that names no lock path, pid or host", async () => {
    const response = buildPoolBusyResponse();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    const body = await response.text();
    assert.equal(JSON.parse(body).error.type, "overloaded_error");
    assert.ok(!/\.lock|pid|\//.test(body), body);
  });
});
