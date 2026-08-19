import { execFile } from "node:child_process";
import { constants, promises as fs, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  POOL_KEYCHAIN_SERVICE,
  type AccountRecord,
  type PoolOAuthTokens,
  type SecretBackend,
} from "./types.js";

const execFileAsync = promisify(execFile);
const SECURITY_TIMEOUT_MS = 10_000;
const FILE_SUFFIX = ".json";
let temporaryFileCounter = 0;

interface CommandError {
  stderr?: string;
}

function isMissingKeychainItem(error: unknown): boolean {
  const stderr = (error as CommandError).stderr;
  return typeof stderr === "string" && /could not be found/i.test(stderr);
}

async function runSecurity(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("security", args, {
    timeout: SECURITY_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

function decodeDumpValue(value: string): string | null {
  try {
    return JSON.parse(value) as string;
  } catch {
    return null;
  }
}

function parseKeychainLabels(output: string, service: string): string[] {
  const labels = new Set<string>();

  // `dump-keychain` emits one item per `keychain:` block. Generic-password
  // attributes are lines such as `"svce"<blob>="..."` and
  // `"acct"<blob>="..."`; matching by attribute name avoids depending on order.
  for (const block of output.split(/(?=^keychain:)/m)) {
    const serviceMatch = block.match(/^\s*"svce"<blob>=("(?:[^"\\]|\\.)*")\s*$/m);
    const accountMatch = block.match(/^\s*"acct"<blob>=("(?:[^"\\]|\\.)*")\s*$/m);
    if (!serviceMatch || !accountMatch) continue;

    const itemService = decodeDumpValue(serviceMatch[1]);
    const account = decodeDumpValue(accountMatch[1]);
    if (itemService === service && account !== null) labels.add(account);
  }

  return [...labels].sort();
}

export function createKeychainBackend(
  service = POOL_KEYCHAIN_SERVICE,
): SecretBackend {
  return {
    async get(label: string): Promise<string | null> {
      try {
        return await runSecurity([
          "find-generic-password",
          "-s",
          service,
          "-a",
          label,
          "-w",
        ]);
      } catch {
        return null;
      }
    },

    async set(label: string, value: string): Promise<void> {
      try {
        await runSecurity([
          "add-generic-password",
          "-U",
          "-s",
          service,
          "-a",
          label,
          "-l",
          `${service}:${label}`,
          "-D",
          "Claude account pool entry",
          "-w",
          value,
        ]);
      } catch {
        throw new Error(`Failed to store keychain account "${label}"`);
      }
    },

    async remove(label: string): Promise<void> {
      try {
        await runSecurity([
          "delete-generic-password",
          "-s",
          service,
          "-a",
          label,
        ]);
      } catch (error) {
        if (!isMissingKeychainItem(error)) {
          throw new Error(`Failed to remove keychain account "${label}"`);
        }
      }
    },

    async list(): Promise<string[]> {
      try {
        return parseKeychainLabels(await runSecurity(["dump-keychain"]), service);
      } catch {
        throw new Error(`Failed to list keychain service "${service}"`);
      }
    },
  };
}

function validateLabel(label: string): void {
  if (
    label.length === 0
    || label === "."
    || label === ".."
    || label.includes("/")
    || label.includes("\\")
    || label.includes("\0")
  ) {
    throw new Error(`Invalid account label "${label}"`);
  }
}

function fileNameForLabel(label: string): string {
  validateLabel(label);
  return `${encodeURIComponent(label)}${FILE_SUFFIX}`;
}

function labelFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(FILE_SUFFIX)) return null;

  try {
    const label = decodeURIComponent(fileName.slice(0, -FILE_SUFFIX.length));
    validateLabel(label);
    return label;
  } catch {
    return null;
  }
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createFileBackend(dir: string): SecretBackend {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  return {
    async get(label: string): Promise<string | null> {
      const path = join(dir, fileNameForLabel(label));
      try {
        return await fs.readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error(`Failed to read account "${label}"`);
      }
    },

    async set(label: string, value: string): Promise<void> {
      const target = join(dir, fileNameForLabel(label));
      const temporary = join(
        dir,
        `.${encodeURIComponent(label)}.${process.pid}.${temporaryFileCounter++}.tmp`,
      );
      let handle: fs.FileHandle | undefined;

      try {
        handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        await handle.writeFile(value, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(temporary, target);
        await syncDirectory(dir);
      } catch {
        throw new Error(`Failed to store account "${label}"`);
      } finally {
        await handle?.close().catch(() => undefined);
        await fs.unlink(temporary).catch(() => undefined);
      }
    },

    async remove(label: string): Promise<void> {
      const path = join(dir, fileNameForLabel(label));
      try {
        await fs.unlink(path);
        await syncDirectory(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(`Failed to remove account "${label}"`);
        }
      }
    },

    async list(): Promise<string[]> {
      const entries = await fs.readdir(dir);
      return entries
        .map(labelFromFileName)
        .filter((label): label is string => label !== null)
        .sort();
    },
  };
}

export function createSecretBackend(): SecretBackend {
  if (process.platform === "darwin") return createKeychainBackend();
  return createFileBackend(join(
    homedir(),
    ".local",
    "share",
    "opencode-claude-bridge",
    "accounts",
  ));
}

function isAccountRecord(value: unknown): value is AccountRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<AccountRecord>;
  const oauth = record.oauth as Partial<PoolOAuthTokens> | undefined;

  return typeof record.label === "string"
    && typeof record.enrolledAt === "number"
    && typeof oauth === "object"
    && oauth !== null
    && typeof oauth.access === "string"
    && typeof oauth.refresh === "string"
    && typeof oauth.expires === "number"
    && (record.subscriptionType === undefined || typeof record.subscriptionType === "string")
    && (record.rateLimitTier === undefined || typeof record.rateLimitTier === "string")
    && (record.scopes === undefined
      || (Array.isArray(record.scopes) && record.scopes.every((scope) => typeof scope === "string")));
}

export function createAccountStore(backend: SecretBackend) {
  async function getAccount(label: string): Promise<AccountRecord | null> {
    const serialized = await backend.get(label);
    if (serialized === null) return null;

    try {
      const parsed: unknown = JSON.parse(serialized);
      if (isAccountRecord(parsed)) return parsed;
    } catch {
      // Report only the lookup key: JSON parse errors can include secret input.
    }

    console.error(`Failed to parse account record "${label}"`);
    return null;
  }

  return {
    getAccount,

    async putAccount(record: AccountRecord): Promise<void> {
      await backend.set(record.label, JSON.stringify(record));
    },

    async updateTokens(label: string, tokens: PoolOAuthTokens): Promise<AccountRecord> {
      const existing = await getAccount(label);
      if (existing === null) throw new Error(`Account "${label}" does not exist`);

      const updated: AccountRecord = { ...existing, oauth: { ...tokens } };
      await backend.set(label, JSON.stringify(updated));
      return updated;
    },

    async removeAccount(label: string): Promise<void> {
      await backend.remove(label);
    },

    async listAccounts(): Promise<AccountRecord[]> {
      const accounts: AccountRecord[] = [];
      for (const label of await backend.list()) {
        const account = await getAccount(label);
        if (account !== null) accounts.push(account);
      }
      return accounts;
    },
  };
}
