import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EnrollmentError,
  parseClaudeCredentials,
  toAccountRecord,
  enrollFromClaudeCli,
} from "./enroll.js";
import { createAccountStore } from "./secret-store.js";
import type { SecretBackend } from "./types.js";

const NOW = 1_000_000;

const VALID_CLI_JSON = JSON.stringify({
  claudeAiOauth: {
    accessToken: "sk-ant-oat01-abc",
    refreshToken: "sk-ant-ort01-xyz",
    expiresAt: NOW + 3_600_000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  },
});

function memoryBackend(): SecretBackend {
  const map = new Map<string, string>();
  return {
    async get(label) {
      return map.get(label) ?? null;
    },
    async set(label, value) {
      map.set(label, value);
    },
    async remove(label) {
      map.delete(label);
    },
    async list() {
      return [...map.keys()];
    },
  };
}

describe("claude cli credential parsing", () => {
  it("accepts the real CLI keychain shape", () => {
    const creds = parseClaudeCredentials(VALID_CLI_JSON);
    assert.equal(creds.claudeAiOauth.accessToken, "sk-ant-oat01-abc");
  });

  it("rejects non-JSON", () => {
    assert.throws(() => parseClaudeCredentials("{nope"), EnrollmentError);
  });

  it("rejects JSON missing the claudeAiOauth block", () => {
    assert.throws(
      () => parseClaudeCredentials(JSON.stringify({ other: true })),
      EnrollmentError,
    );
  });

  it("rejects a partial oauth block", () => {
    assert.throws(
      () =>
        parseClaudeCredentials(
          JSON.stringify({ claudeAiOauth: { accessToken: "a" } }),
        ),
      EnrollmentError,
    );
  });
});

describe("cli credentials to account record", () => {
  it("maps the CLI schema onto the pool schema", () => {
    const record = toAccountRecord(
      "alice",
      parseClaudeCredentials(VALID_CLI_JSON),
      NOW,
      "alice@example.com",
    );

    assert.deepEqual(record, {
      label: "alice",
      oauth: {
        access: "sk-ant-oat01-abc",
        refresh: "sk-ant-ort01-xyz",
        expires: NOW + 3_600_000,
      },
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      scopes: ["user:inference", "user:profile"],
      email: "alice@example.com",
      enrolledAt: NOW,
    });
  });

  it("produces a record the account store can read back", async () => {
    const store = createAccountStore(memoryBackend());
    const record = toAccountRecord(
      "alice",
      parseClaudeCredentials(VALID_CLI_JSON),
      NOW,
    );

    await store.putAccount(record);

    // Guards the exact bug that raw CLI-format entries caused: stored records
    // that list() finds but the typed store refuses to parse.
    assert.deepEqual(await store.getAccount("alice"), record);
    assert.equal((await store.listAccounts()).length, 1);
  });
});

describe("duplicate enrollment", () => {
  it("refuses to enroll the same account under a second label", async () => {
    const store = createAccountStore(memoryBackend());
    await store.putAccount(
      toAccountRecord("alice", parseClaudeCredentials(VALID_CLI_JSON), NOW),
    );

    await assert.rejects(
      enrollFromClaudeCli({
        accounts: store,
        label: "bob",
        clock: () => NOW,
        resolveEmail: false,
        readCredentials: () => VALID_CLI_JSON,
      }),
      (err: Error) =>
        err instanceof EnrollmentError && /already enrolled as "alice"/.test(err.message),
    );
  });

  it("re-enrolls the same account under its existing label", async () => {
    const store = createAccountStore(memoryBackend());
    await store.putAccount(
      toAccountRecord("alice", parseClaudeCredentials(VALID_CLI_JSON), NOW - 5000),
    );

    const record = await enrollFromClaudeCli({
      accounts: store,
      label: "alice",
      clock: () => NOW,
      resolveEmail: false,
      readCredentials: () => VALID_CLI_JSON,
    });

    assert.equal(record.enrolledAt, NOW);
    assert.equal((await store.listAccounts()).length, 1);
  });
});
