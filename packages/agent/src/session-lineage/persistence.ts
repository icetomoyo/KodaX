/**
 * ../index.js Extension Persistence Store
 *
 * JSONL-backed key-value store scoped to a single extension identity.
 * Each store instance owns one `.jsonl` file inside the extension store
 * directory.  All I/O is async and safe for single-writer use.
 *
 * File format (one JSON object per line):
 *
 *   {"_type":"entry","key":"...","value":...,"version":"...","updatedAt":...}
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

import { getAgentConfigPath } from '../runtime/agent-home.js';
import type {
  KodaXExtensionStore,
  KodaXExtensionStoreEntry,
  KodaXJsonValue,
} from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultStoreDir(): string {
  return getAgentConfigPath('extension-store');
}

function isJsonValue(value: unknown): value is KodaXJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
}

function generateVersion(): string {
  return crypto.randomBytes(8).toString('hex');
}

function createAtomicWriteTempPath(filePath: string): string {
  const nonce = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${nonce}.tmp`);
}

interface PersistedEntry {
  _type: 'entry';
  key: string;
  value: KodaXJsonValue;
  version: string;
  updatedAt: number;
}

function toPersistedLine(entry: KodaXExtensionStoreEntry): string {
  const line: PersistedEntry = {
    _type: 'entry',
    key: entry.key,
    value: entry.value,
    version: entry.version,
    updatedAt: entry.updatedAt,
  };
  return JSON.stringify(line);
}

function fromPersistedLine(raw: string): KodaXExtensionStoreEntry | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object'
      && parsed !== null
      && (parsed as Record<string, unknown>)._type === 'entry'
      && typeof (parsed as Record<string, unknown>).key === 'string'
      && typeof (parsed as Record<string, unknown>).version === 'string'
      && typeof (parsed as Record<string, unknown>).updatedAt === 'number'
      && isJsonValue((parsed as Record<string, unknown>).value)
    ) {
      const p = parsed as PersistedEntry;
      return {
        key: p.key,
        value: p.value,
        version: p.version,
        updatedAt: p.updatedAt,
      };
    }
    return null;
  } catch (error) {
    // The caller rejects this unreadable baseline before any mutation.
    void error;
    return null;
  }
}

function ensureExtensionDir(namespaceId: string): string {
  // Sanitize the namespace to avoid path traversal.
  const sanitized = namespaceId.replace(/[\\/]/g, '_').replace(/\.\./g, '');
  return path.join(getDefaultStoreDir(), sanitized);
}

function ensureExtensionFile(namespaceId: string): string {
  return path.join(ensureExtensionDir(namespaceId), 'store.jsonl');
}

// ---------------------------------------------------------------------------
// FileExtensionStore
// ---------------------------------------------------------------------------

/**
 * JSONL-backed implementation of {@link KodaXExtensionStore}.
 *
 * All data for a single extension namespace lives in one JSONL file under
 * `~/.kodax/extension-store/<namespace>/store.jsonl`.  The file is rewritten
 * atomically on every mutation (replace-then-rename).
 */
export class FileExtensionStore implements KodaXExtensionStore {
  private readonly filePath: string;

  constructor(namespaceId: string) {
    this.filePath = ensureExtensionFile(namespaceId);
  }

  async get(key: string): Promise<KodaXExtensionStoreEntry | undefined> {
    const entries = await this.readAllEntries();
    return entries.get(key);
  }

  async put(
    key: string,
    value: KodaXJsonValue,
    options?: { expectedVersion?: string },
  ): Promise<KodaXExtensionStoreEntry | false> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error('Extension store key must be a non-empty string.');
    }

    const entries = await this.readAllEntries();
    const existing = entries.get(normalizedKey);

    if (options?.expectedVersion !== undefined) {
      if (!existing || existing.version !== options.expectedVersion) {
        return false;
      }
    }

    const now = Date.now();
    const newVersion = generateVersion();
    const entry: KodaXExtensionStoreEntry = {
      key: normalizedKey,
      value,
      version: newVersion,
      updatedAt: now,
    };

    entries.set(normalizedKey, entry);
    await this.writeAllEntries(entries);
    return entry;
  }

  async delete(key: string): Promise<boolean> {
    const entries = await this.readAllEntries();
    const existed = entries.delete(key.trim());
    if (existed) {
      await this.writeAllEntries(entries);
    }
    return existed;
  }

  async list(options?: { prefix?: string }): Promise<string[]> {
    const entries = await this.readAllEntries();
    const prefix = options?.prefix ?? '';
    const keys: string[] = [];
    for (const key of entries.keys()) {
      if (key.startsWith(prefix)) {
        keys.push(key);
      }
    }
    return keys.sort();
  }

  async clear(options?: { prefix?: string }): Promise<number> {
    const entries = await this.readAllEntries();
    const prefix = options?.prefix ?? '';
    let removed = 0;
    if (prefix) {
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) {
          entries.delete(key);
          removed++;
        }
      }
    } else {
      removed = entries.size;
      entries.clear();
    }
    if (removed > 0) {
      await this.writeAllEntries(entries);
    }
    return removed;
  }

  // -- internal -------------------------------------------------------------

  private async readAllEntries(): Promise<Map<string, KodaXExtensionStoreEntry>> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const trimmed = raw.trim();
      if (!trimmed) {
        return new Map();
      }

      const map = new Map<string, KodaXExtensionStoreEntry>();
      // Last-write-wins: later lines overwrite earlier ones for the same key.
      for (const line of trimmed.split('\n')) {
        const entry = fromPersistedLine(line);
        if (!line.trim()) continue;
        if (!entry) throw Object.assign(new Error('Corrupt extension store; retain the original file and repair it before retrying.'), { code: 'extension_store_corrupt' });
        map.set(entry.key, entry);
      }
      return map;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
  }

  private async writeAllEntries(entries: Map<string, KodaXExtensionStoreEntry>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    const lines: string[] = [];
    for (const entry of entries.values()) {
      lines.push(toPersistedLine(entry));
    }

    // Atomic write via per-process temp file + rename.
    const tmpPath = createAtomicWriteTempPath(this.filePath);
    try {
      await fs.writeFile(tmpPath, lines.join('\n'), { encoding: 'utf-8', mode: 0o600 });
      await fs.rename(tmpPath, this.filePath);
    } finally {
      await fs.rm(tmpPath, { force: true });
    }
  }
}

/**
 * Create a {@link FileExtensionStore} for the given extension namespace.
 *
 * The namespace is typically the `extensionId` (e.g. `cli:extension:/path/to/ext.mjs`).
 */
export function createExtensionStore(namespaceId: string): KodaXExtensionStore {
  return new FileExtensionStore(namespaceId);
}
