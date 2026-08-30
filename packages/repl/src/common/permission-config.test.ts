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

  it('ignores a legacy Rules engine in settings without exposing engine state', () => {
    writeFakeConfig({
      engine: 'rules',
      classifierModel: 'kimi-code:kimi-for-coding',
      timeoutMs: 5000,
    });
    const r = loadAutoModeSettings({});
    expect(r).not.toHaveProperty('engine');
    expect(r.classifierModel).toBe('kimi-code:kimi-for-coding');
    expect(r).not.toHaveProperty('timeoutMs');
  });

  it('ignores legacy KODAX_AUTO_MODE_ENGINE=rules without exposing engine state', () => {
    writeFakeConfig({ engine: 'llm' });
    const r = loadAutoModeSettings({ KODAX_AUTO_MODE_ENGINE: 'rules' });
    expect(r).not.toHaveProperty('engine');
  });

  it('KODAX_AUTO_MODE_CLASSIFIER_MODEL env is surfaced separately so the resolver can see env-vs-settings layer ordering', () => {
    writeFakeConfig({ classifierModel: 'from-settings' });
    const r = loadAutoModeSettings({ KODAX_AUTO_MODE_CLASSIFIER_MODEL: 'from-env' });
    expect(r.classifierModel).toBe('from-settings');
    expect(r.classifierModelEnv).toBe('from-env');
  });

  it('ignores legacy timeout config and environment inputs', () => {
    writeFakeConfig({ timeoutMs: 1000 });
    const r = loadAutoModeSettings({ KODAX_AUTO_MODE_TIMEOUT_MS: '7500' });
    expect(r).not.toHaveProperty('timeoutMs');
  });

  it('invalid env engine remains an inert legacy input', () => {
    writeFakeConfig({ engine: 'rules' });
    const r = loadAutoModeSettings({ KODAX_AUTO_MODE_ENGINE: 'YOLO' });
    expect(r).not.toHaveProperty('engine');
  });

  it('keeps legacy timeout inputs inert regardless of their value', () => {
    writeFakeConfig({ timeoutMs: 1000 });
    const cases = ['NaN', '-1', '0', 'fast', ''];
    for (const v of cases) {
      const r = loadAutoModeSettings({ KODAX_AUTO_MODE_TIMEOUT_MS: v });
      expect(r).not.toHaveProperty('timeoutMs');
    }
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

  it('does not normalize or expose legacy timeout settings', () => {
    writeFakeConfig({ timeoutMs: 3000.7 });
    const r = loadAutoModeSettings({});
    expect(r).not.toHaveProperty('timeoutMs');
  });

  // Legacy speculative-window inputs remain readable but inert.

  it('omits speculativeWindowMs by default', () => {
    const r = loadAutoModeSettings({});
    expect(r).not.toHaveProperty('speculativeWindowMs');
  });

  it('ignores speculativeWindowMs from the settings file', () => {
    writeFakeConfig({ speculativeWindowMs: 1500 });
    const r = loadAutoModeSettings({});
    expect(r).not.toHaveProperty('speculativeWindowMs');
  });

  it('keeps zero speculativeWindowMs inert', () => {
    writeFakeConfig({ speculativeWindowMs: 0 });
    const r = loadAutoModeSettings({});
    expect(r).not.toHaveProperty('speculativeWindowMs');
  });

  it('ignores the legacy speculative-window environment variable', () => {
    writeFakeConfig({ speculativeWindowMs: 500 });
    const r = loadAutoModeSettings({ KODAX_AUTO_SPECULATIVE_WINDOW_MS: '2000' });
    expect(r).not.toHaveProperty('speculativeWindowMs');
  });

  it('does not revive speculative routing for a zero environment value', () => {
    writeFakeConfig({ speculativeWindowMs: 500 });
    const r = loadAutoModeSettings({ KODAX_AUTO_SPECULATIVE_WINDOW_MS: '0' });
    expect(r).not.toHaveProperty('speculativeWindowMs');
  });

  it('does not normalize negative legacy speculative-window settings', () => {
    writeFakeConfig({ speculativeWindowMs: -100 });
    const r = loadAutoModeSettings({});
    expect(r).not.toHaveProperty('speculativeWindowMs');
  });

  it('keeps all legacy speculative-window environment forms inert', () => {
    writeFakeConfig({ speculativeWindowMs: 750 });
    for (const v of ['fast', '', 'NaN']) {
      const r = loadAutoModeSettings({ KODAX_AUTO_SPECULATIVE_WINDOW_MS: v });
      expect(r).not.toHaveProperty('speculativeWindowMs');
    }
  });

  it('does not normalize float legacy speculative-window settings', () => {
    writeFakeConfig({ speculativeWindowMs: 480.9 });
    const r = loadAutoModeSettings({});
    expect(r).not.toHaveProperty('speculativeWindowMs');
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
    vi.stubEnv('KODAX_AUTO_MODE_ENGINE', 'rules');

    expect(resolveAutoModeSettings({ settings: { engine: 'rules' } }))
      .not.toHaveProperty('engine');
  });

  it('resolves caller-supplied settings without reading the filesystem', () => {
    const exists = vi.spyOn(fsSync, 'existsSync');

    const resolved = resolveAutoModeSettings({
      settings: {
        engine: 'rules',
        classifierModel: 'zai-coding:glm-5.2',
        timeoutMs: 20_000.9,
        speculativeWindowMs: 0,
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
        engine: 'rules',
        classifierModel: 'from-settings',
        timeoutMs: 8_000,
        speculativeWindowMs: 500,
      },
      env: {
        KODAX_AUTO_MODE_ENGINE: 'llm',
        KODAX_AUTO_MODE_CLASSIFIER_MODEL: 'from-env',
        KODAX_AUTO_MODE_TIMEOUT_MS: '20000',
        KODAX_AUTO_SPECULATIVE_WINDOW_MS: '1200',
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
