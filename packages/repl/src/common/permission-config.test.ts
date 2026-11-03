/**
 * Tests for `loadAutoModeSettings` — FEATURE_092 phase 2b.7b slice C.
 *
 * The function reads `~/.kodax/config.json` for the `autoMode` block, then
 * applies env overrides from the `KODAX_AUTO_MODE_*` family. We mock the
 * file read by stubbing `fs.existsSync` / `fs.readFileSync` so the test is
 * hermetic and doesn't depend on the developer's actual config file.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fsSync from 'fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

import {
  loadAutoModeSettings,
  resolveAutoModeSettings,
} from './permission-config.js';

const writeFakeConfig = (autoMode: Record<string, unknown> | undefined): void => {
  const json = JSON.stringify(autoMode === undefined ? {} : { autoMode });
  vi.spyOn(fsSync, 'existsSync').mockReturnValue(true);
  vi.spyOn(fsSync, 'readFileSync').mockReturnValue(json);
};

describe('loadAutoModeSettings — FEATURE_092 phase 2b.7b slice C', () => {
  beforeEach(() => {
    // Default to "no config file present" — tests opt in by calling writeFakeConfig.
    vi.spyOn(fsSync, 'existsSync').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns sensible defaults when no config and no env are set', () => {
    const r = loadAutoModeSettings({});
    expect(r).not.toHaveProperty('engine');
    expect(r.classifierModel).toBeUndefined();
    expect(r.classifierModelEnv).toBeUndefined();
    expect(r).not.toHaveProperty('timeoutMs');
  });

  it('KODAX_AUTO_MODE_CLASSIFIER_MODEL env is surfaced separately so the resolver can see env-vs-settings layer ordering', () => {
    writeFakeConfig({ classifierModel: 'from-settings' });
    const r = loadAutoModeSettings({ KODAX_AUTO_MODE_CLASSIFIER_MODEL: 'from-env' });
    expect(r.classifierModel).toBe('from-settings');
    expect(r.classifierModelEnv).toBe('from-env');
  });

  it('whitespace-only / empty classifierModel string is treated as unset', () => {
    writeFakeConfig({ classifierModel: '   ' });
    const r = loadAutoModeSettings({});
    expect(r.classifierModel).toBeUndefined();
  });

  it('settings file with no autoMode block returns optional settings as undefined', () => {
    writeFakeConfig(undefined);
    const r = loadAutoModeSettings({});
    expect(r).not.toHaveProperty('engine');
    expect(r.classifierModel).toBeUndefined();
    expect(r).not.toHaveProperty('timeoutMs');
  });

});

describe('permission mode compatibility boundary — FEATURE_297', () => {
  let home: string;
  let file: string;
  let modes: typeof import('./permission-config.js');
  beforeEach(async () => {
    home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'kodax-permission-config-'));
    file = path.join(home, 'config.json');
    vi.stubEnv('KODAX_HOME', home);
    vi.resetModules();
    modes = await import('./permission-config.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    fsSync.rmSync(home, { recursive: true, force: true });
  });

  it('loads auto-in-project as canonical Auto[LLM]', () => {
    fsSync.writeFileSync(file, JSON.stringify({
      permissionMode: 'auto-in-project',
    }));

    expect(modes.loadPermissionMode()).toBe('auto');
  });

  it('writes only the canonical mode when a legacy alias reaches the save boundary', () => {
    fsSync.writeFileSync(file, JSON.stringify({
      permissionMode: 'accept-edits',
    }));

    modes.savePermissionModeUser('auto-in-project');
    expect(JSON.parse(fsSync.readFileSync(file, 'utf8')))
      .toMatchObject({ permissionMode: 'auto' });
  });

  it('round-trips Full Access without rewriting it', () => {
    fsSync.writeFileSync(file, JSON.stringify({
      permissionMode: 'full-access',
    }));

    expect(modes.loadPermissionMode()).toBe('full-access');
  });

  it('retains credentials on failed permission-mode publication and refuses a busy shared lock', () => {
    const raw = JSON.stringify({ permissionMode: 'full-access', apiKeys: { anthropic: 'fixture-permission-account' } });
    fsSync.writeFileSync(file, raw);
    const write = fsSync.writeFileSync;
    const fault = vi.spyOn(fsSync, 'writeFileSync').mockImplementation((target, data, options) => {
      if (typeof data === 'string' && data.includes('fixture-permission-account')) {
        write(target, data.slice(0, 17), options); throw new Error('Fixture disk full');
      }
      write(target, data, options);
    });
    syncBuiltinESMExports();
    expect(() => modes.savePermissionModeUser('auto')).toThrow('Fixture disk full');
    expect(fsSync.readFileSync(file, 'utf8')).toBe(raw);
    fault.mockRestore(); syncBuiltinESMExports();
    fsSync.writeFileSync(`${file}.write.lock`, JSON.stringify({ version: 1, pid: process.pid, nonce: 'live' }));
    expect(() => modes.savePermissionModeUser('auto')).toThrow(/configuration lock/i);
    expect(fsSync.readFileSync(file, 'utf8')).toBe(raw);
  });

  it('does not clear malformed core configuration during an explicit permission save', () => {
    const raw = '{"apiKeys":{"anthropic":"fixture-permission-account"},';
    fsSync.writeFileSync(file, raw);
    expect(() => modes.savePermissionModeUser('auto')).toThrow(/core configuration/i);
    expect(fsSync.readFileSync(file, 'utf8')).toBe(raw);
  });
});

describe('resolveAutoModeSettings — FEATURE_271 SDK contract', () => {
  it('does not read process.env when the caller omits env', () => {
    vi.stubEnv('KODAX_AUTO_MODE_CLASSIFIER_MODEL', 'from-process');

    expect(resolveAutoModeSettings({ settings: { classifierModel: 'from-settings' } }))
      .toMatchObject({ classifierModel: 'from-settings', classifierModelEnv: undefined });
  });

  it('resolves caller-supplied settings without reading the filesystem', () => {
    const exists = vi.spyOn(fsSync, 'existsSync');

    const resolved = resolveAutoModeSettings({
      settings: {
        classifierModel: 'zai-coding:glm-5.2',
      },
      env: {},
    });

    expect(resolved).toEqual({
      classifierModel: 'zai-coding:glm-5.2',
      classifierModelEnv: undefined,
      reviewPolicy: undefined,
    });
    expect(exists).not.toHaveBeenCalled();
  });

  it('applies the same environment precedence as the file-loading wrapper', () => {
    const resolved = resolveAutoModeSettings({
      settings: {
        classifierModel: 'from-settings',
      },
      env: {
        KODAX_AUTO_MODE_CLASSIFIER_MODEL: 'from-env',
      },
    });

    expect(resolved).toEqual({
      classifierModel: 'from-settings',
      classifierModelEnv: 'from-env',
      reviewPolicy: undefined,
    });
  });

  it('reads and trims the optional fixed autoReview policy without an env override', () => {
    const resolved = resolveAutoModeSettings({
      settings: {},
      autoReview: { policy: '  Never publish packages from this machine.  ' },
      env: {},
    });

    expect(resolved.reviewPolicy).toBe('Never publish packages from this machine.');
  });
});
