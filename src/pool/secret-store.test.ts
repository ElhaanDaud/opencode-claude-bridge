import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createAccountStore,
  createFileBackend,
} from "./secret-store.js";
import type { AccountRecord, SecretBackend } from "./types.js";

class MemoryBackend implements SecretBackend {
  readonly values = new Map<string, string>();
  setCalls: Array<{ label: string; value: string }> = [];

  async get(label: string): Promise<string | null> {
    return this.values.get(label) ?? null;
  }

  async set(label: string, value: string): Promise<void> {
    this.setCalls.push({ label, value });
    this.values.set(label, value);
  }

  async remove(label: string): Promise<void> {
    this.values.delete(label);
  }

  async list(): Promise<string[]> {
    return [...this.values.keys()];
  }
}

const account: AccountRecord = {
  label: "primary",
  oauth: {
    access: "access-token",
    refresh: "refresh-token",
    expires: 1_800_000_000_000,
  },
  subscriptionType: "max",
  rateLimitTier: "default_claude_max_20x",
  scopes: ["user:inference", "user:profile"],
  enrolledAt: 1_700_000_000_000,
};

describe("account store", () => {
  it("round-trips every account field", async () => {
    const store = createAccountStore(new MemoryBackend());

    await store.putAccount(account);

    assert.deepEqual(await store.getAccount(account.label), account);
  });

  it("returns null for an unknown label", async () => {
    const store = createAccountStore(new MemoryBackend());

    assert.equal(await store.getAccount("missing"), null);
  });

  it("returns null and reports the label for malformed JSON", async () => {
    const backend = new MemoryBackend();
    backend.values.set("broken", "not-json-secret");
    const store = createAccountStore(backend);
    const messages: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => messages.push(args);

    try {
      assert.equal(await store.getAccount("broken"), null);
    } finally {
      console.error = originalError;
    }

    const output = messages.flat().map(String).join(" ");
    assert.match(output, /broken/);
    assert.doesNotMatch(output, /not-json-secret/);
  });

  it("updates all tokens while preserving account metadata", async () => {
    const backend = new MemoryBackend();
    const store = createAccountStore(backend);
    await store.putAccount(account);
    backend.setCalls.length = 0;

    const updated = await store.updateTokens("primary", {
      access: "new-access",
      refresh: "new-refresh",
      expires: 1_900_000_000_000,
    });

    assert.deepEqual(updated, {
      ...account,
      oauth: {
        access: "new-access",
        refresh: "new-refresh",
        expires: 1_900_000_000_000,
      },
    });
    assert.equal(backend.setCalls.length, 1);
    assert.deepEqual(JSON.parse(backend.setCalls[0].value), updated);
  });

  it("throws a clear error when updating a missing account", async () => {
    const store = createAccountStore(new MemoryBackend());

    await assert.rejects(
      store.updateTokens("missing", account.oauth),
      /Account "missing" does not exist/,
    );
  });

  it("removes an account", async () => {
    const store = createAccountStore(new MemoryBackend());
    await store.putAccount(account);

    await store.removeAccount(account.label);

    assert.equal(await store.getAccount(account.label), null);
  });

  it("lists all valid accounts and skips corrupt entries", async () => {
    const backend = new MemoryBackend();
    const store = createAccountStore(backend);
    const secondary: AccountRecord = {
      ...account,
      label: "secondary",
      oauth: { ...account.oauth, access: "secondary-access" },
    };
    await store.putAccount(account);
    await store.putAccount(secondary);
    backend.values.set("corrupt", "{broken");
    const originalError = console.error;
    console.error = () => undefined;

    try {
      assert.deepEqual(await store.listAccounts(), [account, secondary]);
    } finally {
      console.error = originalError;
    }
  });
});

describe("file backend", () => {
  it("round-trips values through a real temporary directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-store-roundtrip-"));

    try {
      const backend = createFileBackend(dir);
      await backend.set("primary", "secret-value");

      assert.equal(await backend.get("primary"), "secret-value");
      assert.deepEqual(await backend.list(), ["primary"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses 0700 for the directory and 0600 for record files", async () => {
    const parent = mkdtempSync(join(tmpdir(), "secret-store-modes-"));
    const dir = join(parent, "accounts");

    try {
      const backend = createFileBackend(dir);
      await backend.set("primary", "secret-value");
      const entries = readdirSync(dir);

      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(entries.length, 1);
      assert.equal(statSync(join(dir, entries[0])).mode & 0o777, 0o600);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects path traversal without writing outside the store", async () => {
    const parent = mkdtempSync(join(tmpdir(), "secret-store-traversal-"));
    const dir = join(parent, "accounts");
    const backend = createFileBackend(dir);

    try {
      await assert.rejects(backend.set("../escape", "secret"), /Invalid account label/);
      await assert.rejects(backend.set("a/b", "secret"), /Invalid account label/);
      assert.deepEqual(readdirSync(parent), ["accounts"]);
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("atomically replaces a record and removes temporary files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-store-atomic-"));
    const backend = createFileBackend(dir);

    try {
      await backend.set("primary", "old-value");
      await backend.set("primary", "new-value");
      const entries = readdirSync(dir);

      assert.equal(entries.length, 1);
      assert.equal(readFileSync(join(dir, entries[0]), "utf8"), "new-value");
      assert.equal(await backend.get("primary"), "new-value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
