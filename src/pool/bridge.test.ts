import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildPoolBusyResponse, createPool } from "./bridge.js";
import { createAccountStore, createSecretBackend } from "./secret-store.js";

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

describe("pool mirror into auth.json", () => {
  it("writes again after the SDK reports a failed auth.set", async (t) => {
    const saved = {
      HOME: process.env.HOME,
      CLAUDE_POOL_ACCOUNTS_DIR: process.env.CLAUDE_POOL_ACCOUNTS_DIR,
      CLAUDE_POOL_STATE_PATH: process.env.CLAUDE_POOL_STATE_PATH,
    };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pool-bridge-"));
    process.env.HOME = home;
    process.env.CLAUDE_POOL_ACCOUNTS_DIR = path.join(home, "accounts");
    process.env.CLAUDE_POOL_STATE_PATH = path.join(home, "rotation-state.json");
    const originalError = console.error;
    console.error = () => {};
    t.after(() => {
      console.error = originalError;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true });
    });

    await createAccountStore(createSecretBackend()).putAccount({
      label: "alice",
      oauth: { access: "access-alice", refresh: "refresh-alice", expires: Date.now() + 3_600_000 },
      enrolledAt: Date.now(),
    });
    const writes: string[] = [];
    let reply: unknown = { error: { name: "UnknownError" } };
    const pool = createPool({
      auth: {
        async set(input) {
          writes.push(input.body.access);
          return reply;
        },
      },
    });

    await pool.acquire();
    reply = { data: true };
    await pool.acquire();
    await pool.acquire();

    assert.deepEqual(writes, ["access-alice", "access-alice"]);
  });
});
