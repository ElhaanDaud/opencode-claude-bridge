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

// `security -i` writes a TRUNCATED secret for lines over 4095 chars, then fails.
const SECURITY_MAX_LINE = 4000;

function quoteForSecurity(value: string): string {
  if (/["\\\r\n]/.test(value)) {
    throw new Error(`Unsupported character in keychain name "${value}"`);
  }
  return `"${value}"`;
}

/** Runs one `security` command read from stdin, keeping secrets out of argv. */
function runSecurityCommand(line: string): Promise<void> {
  if (line.length > SECURITY_MAX_LINE) {
    return Promise.reject(new Error("keychain command exceeds the safe line length"));
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      "security",
      ["-i"],
      { timeout: SECURITY_TIMEOUT_MS, encoding: "utf8" },
      (error) => (error ? reject(error) : resolve()),
    );
    child.stdin?.on("error", () => {}); // see runCurl: an early exit must not crash the process
    child.stdin?.end(`${line}\n`);
  });
}

function decodeDumpValue(value: string): string | null {
  try {
    return JSON.parse(value) as string;
  } catch {
    return null;
  }
}

/**
 * Decode the hex form `dump-keychain` uses when a value is not printable-ASCII
 * safe, e.g. `0x796100  "ya\000"`. Matching only the quoted form made such
 * items invisible to {@link parseKeychainLabels}, which silently dropped the
 * account: never selected, then disabled as "credentials missing".
 */
function decodeDumpHex(hex: string): string | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  try {
    const text = Buffer.from(hex, "hex").toString("utf8");
    // A lone replacement char means the bytes were not valid UTF-8, so the
    // decode is untrustworthy and a wrong label is worse than none.
    return text.includes("\uFFFD") ? null : text;
  } catch {
    return null;
  }
}

/**
 * Read one `"<name>"<blob>=` attribute, accepting both emitted forms.
 * The hex form may be followed by an escaped rendering, which is ignored.
 */
function readDumpAttribute(block: string, name: string): string | null {
  const quoted = block.match(
    new RegExp(`^\\s*"${name}"<blob>=("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m"),
  );
  if (quoted) return decodeDumpValue(quoted[1]);

  const hex = block.match(new RegExp(`^\\s*"${name}"<blob>=0x([0-9a-fA-F]+)`, "m"));
  if (hex) return decodeDumpHex(hex[1]);

  return null;
}

export function parseKeychainLabels(output: string, service: string): string[] {
  const labels = new Set<string>();

  // `dump-keychain` emits one item per `keychain:` block. Generic-password
  // attributes are lines such as `"svce"<blob>="..."` and
  // `"acct"<blob>="..."`; matching by attribute name avoids depending on order.
  for (const block of output.split(/(?=^keychain:)/m)) {
    const itemService = readDumpAttribute(block, "svce");
    const account = readDumpAttribute(block, "acct");
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
        const output = await runSecurity([
          "find-generic-password",
          "-s",
          service,
          "-a",
          label,
          "-w",
        ]);
        return output.endsWith("\n") ? output.slice(0, -1) : output;
      } catch (error) {
        // A locked keychain or timeout is not "missing": missing gets an account disabled.
        if (isMissingKeychainItem(error)) return null;
        throw new Error(`Failed to read keychain account "${label}"`);
      }
    },

    async set(label: string, value: string): Promise<void> {
      try {
        const hex = Buffer.from(value, "utf8").toString("hex");
        await runSecurityCommand(
          `add-generic-password -U -s ${quoteForSecurity(service)} -a ${quoteForSecurity(label)}`
            + ` -l ${quoteForSecurity(`${service}:${label}`)} -D "Claude account pool entry" -X ${hex}`,
        );
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
  // Created on first write, not here: this runs while the plugin loads, and an
  // unwritable home must leave the pool inactive rather than fail the load.
  const ensureDir = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  };

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
      ensureDir();
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
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
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
        try {
          const account = await getAccount(label);
          if (account !== null) accounts.push(account);
        } catch (error) {
          console.error(`[claude-pool] skipping "${label}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return accounts;
    },
  };
}
