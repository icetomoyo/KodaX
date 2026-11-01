import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./windows-text-transaction.js', () => ({
  probeTrustedTextNativeBinding: () => ({ ready: true, protocol: 4 }),
}));

import { runDoctor } from './kodax_doctor.js';

describe('kodax doctor trusted text diagnostic', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('reports an explicitly requested native binding load and protocol check', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      output.push(String(value));
    });

    await runDoctor('test', true, { nativeText: true });

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      version: 'test',
      trustedTextNative: { ready: true, protocol: 4 },
    });
  });

  it('does not load or report native state during the default read-only doctor', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      output.push(String(value));
    });

    await runDoctor('test', true);

    expect(JSON.parse(output[0]!)).not.toHaveProperty('trustedTextNative');
  });

  it('diagnoses corrupt config and historical locks without revealing content or mutating them', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-doctor-retained-'));
    vi.stubEnv('KODAX_HOME', home);
    const config = path.join(home, 'config.json');
    const lock = `${config}.write.lock`;
    const owner = path.join(home, 'runtime', 'daemon', 'default', 'owner-policy.lock');
    const migration = path.join(home, 'sessions', '.migration-lock');
    const oauth = path.join(home, 'provider-oauth', `${'a'.repeat(64)}.sealed.lock`);
    fs.mkdirSync(path.dirname(owner), { recursive: true });
    fs.mkdirSync(migration, { recursive: true });
    fs.mkdirSync(oauth, { recursive: true });
    fs.writeFileSync(config, '{"apiKey":"NEVER_PRINT_CREDENTIAL",}');
    fs.writeFileSync(lock, '');
    fs.writeFileSync(owner, '{');
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => { output.push(String(value)); });
    try {
      await runDoctor('test', true);
      const report = JSON.parse(output[0]!) as { coreConfig: { state: string; path: string; offset: number }; locks: { items: { path: string }[] } };
      expect(report.coreConfig).toMatchObject({ state: 'invalid', path: config, offset: expect.any(Number) });
      expect(report.locks.items.map(item => item.path)).toEqual(expect.arrayContaining([lock, owner, migration, oauth]));
      expect(output[0]).not.toContain('NEVER_PRINT_CREDENTIAL');
      expect(fs.readFileSync(config, 'utf8')).toBe('{"apiKey":"NEVER_PRINT_CREDENTIAL",}');
      expect(fs.readFileSync(lock, 'utf8')).toBe('');
      expect(fs.readFileSync(owner, 'utf8')).toBe('{');
      expect(fs.existsSync(migration)).toBe(true);
      expect(fs.existsSync(oauth)).toBe(true);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('does not traverse a directory alias while inspecting retained locks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-doctor-alias-'));
    const home = path.join(root, 'home');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(outside, 'daemon', 'default'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'daemon', 'default', 'owner-policy.lock'), 'private');
    fs.symlinkSync(outside, path.join(home, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir');
    vi.stubEnv('KODAX_HOME', home);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => { output.push(String(value)); });
    try {
      await runDoctor('test', true);
      expect(output[0]).not.toContain('owner-policy.lock');
      expect(JSON.parse(output[0]!).locks.items).toContainEqual({ path: path.join(home, 'runtime'), state: 'alias' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('never treats digits in a parser excerpt as an offset', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-doctor-excerpt-'));
    vi.stubEnv('KODAX_HOME', home);
    fs.writeFileSync(path.join(home, 'config.json'), '{"key": position 123456789}');
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => { output.push(String(value)); });
    try {
      await runDoctor('test', true);
      // Older Node parsers may report the true syntax position instead of an excerpt.
      expect([undefined, 8]).toContain(JSON.parse(output[0]!).coreConfig.offset);
      expect(output[0]).not.toContain('123456789');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
