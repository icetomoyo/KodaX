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

import {
  loadAutoModeSettings,
  loadPermissionMode,
  resolveAutoModeSettings,
  savePermissionModeUser,
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
  beforeEach(() => {
    vi.spyOn(fsSync, 'existsSync').mockReturnValue(true);
    vi.spyOn(fsSync, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fsSync, 'writeFileSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads auto-in-project as canonical Auto[LLM]', () => {
    vi.spyOn(fsSync, 'readFileSync').mockReturnValue(JSON.stringify({
      permissionMode: 'auto-in-project',
    }));

    expect(loadPermissionMode()).toBe('auto');
  });

  it('writes only the canonical mode when a legacy alias reaches the save boundary', () => {
    vi.spyOn(fsSync, 'readFileSync').mockReturnValue(JSON.stringify({
      permissionMode: 'accept-edits',
    }));

    savePermissionModeUser('auto-in-project');

    expect(fsSync.writeFileSync).toHaveBeenCalledOnce();
    const serialized = vi.mocked(fsSync.writeFileSync).mock.calls[0]?.[1];
    expect(typeof serialized === 'string' ? JSON.parse(serialized) : undefined)
      .toMatchObject({ permissionMode: 'auto' });
  });

  it('round-trips Full Access without rewriting it', () => {
    vi.spyOn(fsSync, 'readFileSync').mockReturnValue(JSON.stringify({
      permissionMode: 'full-access',
    }));

    expect(loadPermissionMode()).toBe('full-access');
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
