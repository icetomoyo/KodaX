/**
 * v0.7.42 — Custom provider CRUD tests (closes gap 7 reported by KodaX
 * Space). Each test uses a per-case `KODAX_HOME` override pointing at a
 * fresh temp dir so the real `~/.kodax/config.json` is never touched.
 */

import fs, {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setAgentConfigHome } from '@kodax-ai/coding';

import {
  getCustomProviderConfig,
  listCustomProviders,
  removeCustomProvider,
  upsertCustomProvider,
} from './custom-providers.js';
import { CoreConfigWriteConflictError } from './core-config-lock.js';

let tmpHome: string;
let configPath: string;

beforeEach(() => {
  setAgentConfigHome(undefined);
  tmpHome = mkdtempSync(join(tmpdir(), 'kodax-cp-crud-test-'));
  setAgentConfigHome(tmpHome);
  mkdirSync(tmpHome, { recursive: true });
  configPath = join(tmpHome, 'config.json');
});

afterEach(() => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  setAgentConfigHome(undefined);
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeConfig(content: unknown): void {
  writeFileSync(configPath, JSON.stringify(content, null, 2), 'utf-8');
}

it.each(['{"apiKeys":{"anthropic":"fixture-preserve"},', '[]', 'null', 'fixture-preserve'])
  ('retains damaged core configuration instead of publishing an empty replacement (%#)', raw => {
    writeFileSync(configPath, raw);
    for (const action of [() => listCustomProviders(), () => getCustomProviderConfig('alpha'),
      () => upsertCustomProvider(makeProvider('alpha')), () => removeCustomProvider('alpha')]) {
      expect(action).toThrow(/core configuration/i);
      try { action(); } catch (error: unknown) { expect(String(error)).not.toContain('fixture-preserve'); }
      expect(readFileSync(configPath, 'utf8')).toBe(raw);
    }
  });

it('retains old credentials and unrelated fields when a partial disk write fails before publication', () => {
  const original = JSON.stringify({ apiKeys: { anthropic: 'fixture-preserve-account' }, unknown: { retain: true },
    customProviders: [makeProvider('alpha')] });
  writeFileSync(configPath, original);
  const write = fs.writeFileSync;
  const fault = vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
    if (typeof data === 'string' && data.includes('fixture-preserve-account')) {
      write(target, data.slice(0, 17), options);
      throw Object.assign(new Error('Fixture disk full'), { code: 'ENOSPC' });
    }
    write(target, data, options);
  });
  syncBuiltinESMExports();
  expect(() => upsertCustomProvider(makeProvider('beta'))).toThrow('Fixture disk full');
  expect(readFileSync(configPath, 'utf8')).toBe(original);
  fault.mockRestore(); syncBuiltinESMExports();
  upsertCustomProvider(makeProvider('beta'));
  expect(readConfig()).toMatchObject({ apiKeys: { anthropic: 'fixture-preserve-account' }, unknown: { retain: true } });
  expect(listCustomProviders().map(provider => provider.name)).toEqual(['alpha', 'beta']);
});

it('does not replace an unreadable original or expose IO diagnostics containing configuration bytes', () => {
  const raw = JSON.stringify({ apiKeys: { anthropic: 'fixture-unreadable-account' } });
  writeFileSync(configPath, raw);
  const read = fs.readFileSync;
  const fault = vi.spyOn(fs, 'readFileSync').mockImplementation((target, options) => {
    if (target === configPath) throw Object.assign(new Error('PRIVATE_CONFIGURATION_BYTES'), { code: 'EACCES' });
    return read(target, options);
  });
  syncBuiltinESMExports();
  for (const action of [() => listCustomProviders(), () => upsertCustomProvider(makeProvider('alpha'))]) {
    expect(action).toThrow(/core configuration/i);
    try { action(); } catch (error: unknown) { expect(String(error)).not.toContain('PRIVATE_CONFIGURATION_BYTES'); }
  }
  fault.mockRestore(); syncBuiltinESMExports();
  expect(readFileSync(configPath, 'utf8')).toBe(raw);
});

it.each([{}, null, [null], [{ name: 'incomplete', apiKey: 'fixture-original-key' }], [makeProvider('duplicate'), makeProvider('duplicate')]])
  ('retains malformed provider collections rather than deleting original credential bindings (%#)', customProviders => {
    const raw = JSON.stringify({ customProviders, apiKeys: { anthropic: 'fixture-original-key' } });
    writeFileSync(configPath, raw);
    expect(() => upsertCustomProvider(makeProvider('beta'))).toThrow(/core configuration/i);
    expect(readFileSync(configPath, 'utf8')).toBe(raw);
  });

function readConfig(): { customProviders?: Array<{ name: string }> } {
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, 'utf-8')) as {
    customProviders?: Array<{ name: string }>;
  };
}

// Minimal valid OpenAI-protocol custom provider. The validator requires
// name + protocol ('anthropic' | 'openai') + baseUrl + apiKeyEnv + model.
function makeProvider(name: string, model: string = 'fake-model'): import('@kodax-ai/coding').KodaXCustomProviderConfig {
  return {
    name,
    protocol: 'openai',
    baseUrl: 'https://example.local/v1',
    apiKeyEnv: 'FAKE_API_KEY',
    model,
  };
}

describe('listCustomProviders', () => {
  it('returns empty array when no config exists', () => {
    expect(listCustomProviders()).toEqual([]);
  });

  it('returns empty array when config has no customProviders field', () => {
    writeConfig({ provider: 'anthropic' });
    expect(listCustomProviders()).toEqual([]);
  });

  it('returns deep-cloned snapshots — mutating result does NOT affect on-disk config', () => {
    writeConfig({ customProviders: [makeProvider('alpha')] });

    const list = listCustomProviders();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('alpha');

    // Mutate the returned array + entry.
    list.length = 0;
    const list2 = listCustomProviders();
    expect(list2).toHaveLength(1);
    expect(list2[0]?.name).toBe('alpha');
  });

  it('preserves file order (insertion order)', () => {
    writeConfig({
      customProviders: [makeProvider('beta'), makeProvider('alpha'), makeProvider('gamma')],
    });
    expect(listCustomProviders().map((p) => p.name)).toEqual(['beta', 'alpha', 'gamma']);
  });
});

describe('getCustomProviderConfig', () => {
  it('returns undefined when nothing is configured', () => {
    expect(getCustomProviderConfig('alpha')).toBeUndefined();
  });

  it('returns undefined for unknown name', () => {
    writeConfig({ customProviders: [makeProvider('alpha')] });
    expect(getCustomProviderConfig('beta')).toBeUndefined();
  });

  it('returns deep-cloned match by name', () => {
    writeConfig({
      customProviders: [makeProvider('alpha', 'm1'), makeProvider('beta', 'm2')],
    });

    const beta = getCustomProviderConfig('beta');
    expect(beta?.name).toBe('beta');
    expect(beta?.model).toBe('m2');
  });

  it('returns undefined for empty / non-string input (defensive)', () => {
    writeConfig({ customProviders: [makeProvider('alpha')] });
    expect(getCustomProviderConfig('')).toBeUndefined();
    // @ts-expect-error — runtime validation test
    expect(getCustomProviderConfig(undefined)).toBeUndefined();
  });
});

describe('upsertCustomProvider — insert', () => {
  it('creates config.json + customProviders array when none exists', () => {
    expect(existsSync(configPath)).toBe(false);
    upsertCustomProvider(makeProvider('alpha'));

    expect(existsSync(configPath)).toBe(true);
    const persisted = readConfig().customProviders ?? [];
    expect(persisted.map((p) => p.name)).toEqual(['alpha']);
  });

  it('appends a new entry to existing customProviders', () => {
    writeConfig({ customProviders: [makeProvider('alpha')] });
    upsertCustomProvider(makeProvider('beta'));

    const persisted = readConfig().customProviders ?? [];
    expect(persisted.map((p) => p.name)).toEqual(['alpha', 'beta']);
  });

  it('preserves other top-level config fields on insert', () => {
    writeConfig({ provider: 'anthropic', model: 'claude', customProviders: [] });
    upsertCustomProvider(makeProvider('alpha'));

    const persisted = readConfig() as { provider?: string; model?: string; customProviders?: unknown[] };
    expect(persisted.provider).toBe('anthropic');
    expect(persisted.model).toBe('claude');
    expect(persisted.customProviders).toHaveLength(1);
  });
});

describe('upsertCustomProvider — replace (same name)', () => {
  it('replaces in-place when name already exists (no append)', () => {
    writeConfig({
      customProviders: [makeProvider('alpha', 'old-model'), makeProvider('beta')],
    });
    upsertCustomProvider(makeProvider('alpha', 'new-model'));

    const persisted = readConfig().customProviders ?? [];
    expect(persisted.map((p) => p.name)).toEqual(['alpha', 'beta']);
    expect((persisted[0] as { model?: string }).model).toBe('new-model');
  });

  it('preserves position when replacing (no reorder)', () => {
    writeConfig({
      customProviders: [makeProvider('alpha'), makeProvider('beta'), makeProvider('gamma')],
    });
    upsertCustomProvider(makeProvider('beta', 'updated'));

    expect((readConfig().customProviders ?? []).map((p) => p.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });
});

describe('upsertCustomProvider — validation', () => {
  it('rejects malformed input — file untouched', () => {
    writeConfig({ customProviders: [makeProvider('alpha')] });

    expect(() =>
      upsertCustomProvider({
        // @ts-expect-error — testing validation
        name: 123,
        protocol: 'openai-compat',
        baseUrl: 'https://x',
        apiKeyEnv: 'K',
        transport: 'native-api',
        model: 'm',
      }),
    ).toThrow();

    // Config still has the original alpha, untouched.
    expect((readConfig().customProviders ?? []).map((p) => p.name)).toEqual(['alpha']);
  });
});

describe('removeCustomProvider', () => {
  it('removes a configured provider by name and returns true', () => {
    writeConfig({
      customProviders: [makeProvider('alpha'), makeProvider('beta')],
    });

    expect(removeCustomProvider('alpha')).toBe(true);
    expect((readConfig().customProviders ?? []).map((p) => p.name)).toEqual(['beta']);
  });

  it('returns false (no-op, file unchanged) for unknown name', () => {
    writeConfig({ customProviders: [makeProvider('alpha')] });
    const before = readFileSync(configPath, 'utf-8');

    expect(removeCustomProvider('not-there')).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('returns false for empty / non-string input', () => {
    writeConfig({ customProviders: [makeProvider('alpha')] });
    expect(removeCustomProvider('')).toBe(false);
    // @ts-expect-error — runtime validation test
    expect(removeCustomProvider(undefined)).toBe(false);
  });

  it('returns false when no customProviders array exists', () => {
    expect(removeCustomProvider('alpha')).toBe(false);
  });

  it('preserves other top-level config fields on remove', () => {
    writeConfig({
      provider: 'anthropic',
      customProviders: [makeProvider('alpha')],
    });
    expect(removeCustomProvider('alpha')).toBe(true);

    const persisted = readConfig() as { provider?: string; customProviders?: unknown[] };
    expect(persisted.provider).toBe('anthropic');
    expect(persisted.customProviders).toEqual([]);
  });
});

describe('round-trip — upsert + remove leaves config empty', () => {
  it('shares the core-config lock with the setup writer', () => {
    const lockPath = `${configPath}.write.lock`;
    const lock = openSync(lockPath, 'wx');
    try {
      expect(() => upsertCustomProvider(makeProvider('alpha')))
        .toThrow(CoreConfigWriteConflictError);
      expect(existsSync(configPath)).toBe(false);
    } finally {
      closeSync(lock);
      rmSync(lockPath, { force: true });
    }
  });

  it('add → remove returns to no-customProviders state', () => {
    upsertCustomProvider(makeProvider('alpha'));
    expect(listCustomProviders().map((p) => p.name)).toEqual(['alpha']);

    expect(removeCustomProvider('alpha')).toBe(true);
    expect(listCustomProviders()).toEqual([]);
  });

  it('upsert is idempotent — same value applied twice still has one entry', () => {
    upsertCustomProvider(makeProvider('alpha', 'm1'));
    upsertCustomProvider(makeProvider('alpha', 'm1'));
    expect(listCustomProviders()).toHaveLength(1);
  });
});
