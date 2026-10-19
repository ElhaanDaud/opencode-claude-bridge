import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import {
  EnrollmentError,
  LabelConflictError,
  deriveLabelFromEmail,
  normalizeLabel,
  autoEnrollIfNew,
  parseClaudeCredentials,
  readClaudeCliCredentialsRaw,
  toAccountRecord,
  enrollFromClaudeCli,
  labelSharingClaudeCliLogin,
  sharedLoginWarning,
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

describe("label handling for arbitrary accounts", () => {
  it("derives a label from the account email", () => {
    assert.equal(deriveLabelFromEmail("alice@example.com"), "alice");
    assert.equal(deriveLabelFromEmail("bob.smith42@example.com"), "bob.smith42");
    assert.equal(deriveLabelFromEmail("Work.Account+tag@corp.io"), "work.account");
  });

  it("accepts ordinary labels unchanged", () => {
    for (const label of ["alice", "bob", "work-2", "team.lead", "acct_3"]) {
      assert.equal(normalizeLabel(label), label);
    }
  });

  it("rejects labels that could be read as a security(1) option", () => {
    // `security find-generic-password -a -D ...` would reinterpret the label
    // as a flag, so a leading dash must never reach the keychain backend.
    for (const label of ["-D", "--delete", "-a"]) {
      assert.throws(() => normalizeLabel(label), EnrollmentError);
    }
  });

  it("rejects labels that could escape a directory or break storage", () => {
    for (const label of ["../escape", "a/b", "", "   ", "a".repeat(200)]) {
      assert.throws(() => normalizeLabel(label), EnrollmentError);
    }
  });

  it("trims and lowercases so labels stay stable across enrollments", () => {
    assert.equal(normalizeLabel("  Alice  "), "alice");
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

describe("re-enrolling after a re-login", () => {
  const relogin = JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-new",
      refreshToken: "sk-ant-ort01-new",
      expiresAt: NOW + 3_600_000,
      subscriptionType: "max",
    },
  });

  it("refreshes the existing entry for the same email instead of refusing", async () => {
    const store = createAccountStore(memoryBackend());
    await store.putAccount(
      toAccountRecord("alice", parseClaudeCredentials(VALID_CLI_JSON), NOW - 5000, "alice@example.com"),
    );

    const record = await enrollFromClaudeCli({
      accounts: store,
      clock: () => NOW,
      resolveEmail: async () => "alice@example.com",
      readCredentials: () => relogin,
    });

    assert.equal(record.label, "alice");
    const accounts = await store.listAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.oauth.refresh, "sk-ant-ort01-new");
  });

  it("refuses a second label for an email that is already enrolled", async () => {
    const store = createAccountStore(memoryBackend());
    await store.putAccount(
      toAccountRecord("alice", parseClaudeCredentials(VALID_CLI_JSON), NOW, "alice@example.com"),
    );

    await assert.rejects(
      enrollFromClaudeCli({
        accounts: store,
        label: "work",
        clock: () => NOW,
        resolveEmail: async () => "alice@example.com",
        readCredentials: () => relogin,
      }),
      (err: Error) => err instanceof EnrollmentError && /already enrolled as "alice"/.test(err.message),
    );
    assert.equal((await store.listAccounts()).length, 1);
  });
});

describe("reading the Claude CLI login off macOS", () => {
  function onLinux(t: TestContext, credentials: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "claude-config-"));
    if (credentials !== null) writeFileSync(join(dir, ".credentials.json"), credentials);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    process.env.CLAUDE_CONFIG_DIR = dir;
    t.after(() => {
      Object.defineProperty(process, "platform", platform);
      if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = configDir;
      rmSync(dir, { recursive: true, force: true });
    });
    return dir;
  }

  it("reads the credentials file Claude Code writes on Linux", (t) => {
    onLinux(t, `${VALID_CLI_JSON}\n`);
    assert.equal(readClaudeCliCredentialsRaw(), VALID_CLI_JSON);
  });

  it("explains where it looked when there is no login", (t) => {
    const dir = onLinux(t, null);
    assert.throws(
      () => readClaudeCliCredentialsRaw(),
      (err: Error) => err instanceof EnrollmentError && err.message.includes(dir) && /claude login/.test(err.message),
    );
  });
});

describe("label collisions", () => {
  const other = JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-other",
      refreshToken: "sk-ant-ort01-other",
      expiresAt: NOW + 3_600_000,
    },
  });

  async function storeWithAlice(email?: string) {
    const store = createAccountStore(memoryBackend());
    await store.putAccount(toAccountRecord("alice", parseClaudeCredentials(VALID_CLI_JSON), NOW, email));
    return store;
  }

  it("gives a different person who derives the same label a free suffix", async () => {
    const store = await storeWithAlice("alice@work.io");

    const record = await enrollFromClaudeCli({
      accounts: store,
      clock: () => NOW,
      resolveEmail: async () => "alice@home.io",
      readCredentials: () => other,
    });

    assert.equal(record.label, "alice-2");
    assert.equal((await store.listAccounts()).length, 2);
  });

  it("asks before overwriting a label whose owner's email is unknown", async () => {
    const store = await storeWithAlice();

    await assert.rejects(
      enrollFromClaudeCli({
        accounts: store,
        clock: () => NOW,
        resolveEmail: async () => "alice@home.io",
        readCredentials: () => other,
      }),
      (err: Error) => err instanceof LabelConflictError && err.label === "alice" && err.existingEmail === null,
    );
    assert.equal((await store.listAccounts())[0]?.oauth.refresh, "sk-ant-ort01-xyz");
  });

  it("still refuses an explicit label that belongs to someone else", async () => {
    const store = await storeWithAlice("alice@work.io");

    await assert.rejects(
      enrollFromClaudeCli({
        accounts: store,
        label: "alice",
        clock: () => NOW,
        resolveEmail: async () => "alice@home.io",
        readCredentials: () => other,
      }),
      (err: Error) => err instanceof LabelConflictError && err.existingEmail === "alice@work.io",
    );
  });

  it("overwrites the conflicting label when replace is set", async () => {
    const store = await storeWithAlice();

    const record = await enrollFromClaudeCli({
      accounts: store,
      label: "alice",
      replace: true,
      clock: () => NOW,
      resolveEmail: async () => "alice@home.io",
      readCredentials: () => other,
    });

    assert.equal(record.label, "alice");
    const accounts = await store.listAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.oauth.refresh, "sk-ant-ort01-other");
  });
});

describe("automatic enrollment", () => {
  const cli = (refresh: string, expiresInMs = 3_600_000) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `access-${refresh}`,
        refreshToken: refresh,
        expiresAt: NOW + expiresInMs,
        subscriptionType: "max",
      },
    });

  it("adopts an account the CLI is logged into but the pool has not seen", async () => {
    const store = createAccountStore(memoryBackend());
    await store.putAccount(toAccountRecord("alice", parseClaudeCredentials(VALID_CLI_JSON), NOW));

    const result = await autoEnrollIfNew({
      accounts: store,
      clock: () => NOW,
      readCredentials: () => cli("sk-ant-ort01-fresh"),
      resolveEmail: async () => "bob@example.com",
    });

    assert.equal(result.status, "enrolled");
    assert.equal(result.label, "bob");
    assert.equal((await store.listAccounts()).length, 2);
  });

  it("does nothing when the CLI account is already pooled", async () => {
    const store = createAccountStore(memoryBackend());
    await store.putAccount(toAccountRecord("alice", parseClaudeCredentials(VALID_CLI_JSON), NOW));

    const result = await autoEnrollIfNew({
      accounts: store,
      clock: () => NOW,
      readCredentials: () => VALID_CLI_JSON,
      resolveEmail: async () => "alice@example.com",
    });

    assert.equal(result.status, "already-enrolled");
    assert.equal(result.label, "alice");
    assert.equal((await store.listAccounts()).length, 1);
  });

  it("refuses to adopt an expired credential", async () => {
    const store = createAccountStore(memoryBackend());

    const result = await autoEnrollIfNew({
      accounts: store,
      clock: () => NOW,
      readCredentials: () => cli("sk-ant-ort01-dead", -1_000),
      resolveEmail: async () => "bob@example.com",
    });

    // Enrolling a dead credential would add an account that can never serve a
    // request and must then be disabled on first use.
    assert.equal(result.status, "stale");
    assert.equal((await store.listAccounts()).length, 0);
  });

  it("does not disturb the pool when the CLI is logged out", async () => {
    const store = createAccountStore(memoryBackend());
    const result = await autoEnrollIfNew({
      accounts: store,
      clock: () => NOW,
      readCredentials: () => { throw new EnrollmentError("no credentials"); },
      resolveEmail: async () => undefined,
    });

    assert.equal(result.status, "unavailable");
    assert.equal((await store.listAccounts()).length, 0);
  });

  it("disambiguates when the derived label is taken by another account", async () => {
    const store = createAccountStore(memoryBackend());
    await store.putAccount(toAccountRecord("bob", parseClaudeCredentials(VALID_CLI_JSON), NOW));

    const result = await autoEnrollIfNew({
      accounts: store,
      clock: () => NOW,
      readCredentials: () => cli("sk-ant-ort01-other"),
      resolveEmail: async () => "bob@example.com",
    });

    assert.equal(result.status, "enrolled");
    assert.equal(result.label, "bob-2");
    assert.equal((await store.listAccounts()).length, 2);
  });

  it("recognises the same account by email after the tokens have diverged", async () => {
    const store = createAccountStore(memoryBackend());
    await store.putAccount(
      toAccountRecord("alice", parseClaudeCredentials(VALID_CLI_JSON), NOW, "Alice@Example.com"),
    );

    const result = await autoEnrollIfNew({
      accounts: store,
      clock: () => NOW,
      readCredentials: () => cli("sk-ant-ort01-rotated"),
      resolveEmail: async () => "alice@example.com",
    });

    assert.equal(result.status, "already-enrolled");
    assert.equal(result.label, "alice");
    assert.equal((await store.listAccounts()).length, 1);
  });

  it("skips accounts whose email cannot be resolved", async () => {
    const store = createAccountStore(memoryBackend());
    const result = await autoEnrollIfNew({
      accounts: store,
      clock: () => NOW,
      readCredentials: () => cli("sk-ant-ort01-anon"),
      resolveEmail: async () => undefined,
    });

    assert.equal(result.status, "no-label");
    assert.equal((await store.listAccounts()).length, 0);
  });
});

describe("shared login detection", () => {
  it("names the pooled account that holds Claude Code's current refresh token", async () => {
    const store = createAccountStore(memoryBackend());
    await store.putAccount(toAccountRecord("alice", parseClaudeCredentials(VALID_CLI_JSON), NOW));

    assert.equal(await labelSharingClaudeCliLogin(store, () => VALID_CLI_JSON), "alice");
  });

  it("reports nothing once Claude Code has its own login", async () => {
    const store = createAccountStore(memoryBackend());
    await store.putAccount(toAccountRecord("alice", parseClaudeCredentials(VALID_CLI_JSON), NOW));
    const separate = VALID_CLI_JSON.replace("sk-ant-ort01-xyz", "sk-ant-ort01-separate");

    assert.equal(await labelSharingClaudeCliLogin(store, () => separate), null);
  });

  it("reports nothing when Claude Code is not logged in", async () => {
    const store = createAccountStore(memoryBackend());
    const missing = () => {
      throw new EnrollmentError("no credentials");
    };
    assert.equal(await labelSharingClaudeCliLogin(store, missing), null);
  });

  it("never includes a token in the warning", () => {
    assert.ok(!sharedLoginWarning("alice").includes("sk-ant"));
  });
});
