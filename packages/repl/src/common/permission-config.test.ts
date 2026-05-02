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

import { loadAutoModeSettings } from './permission-config.js';

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
  });

  it('returns sensible defaults when no config and no env are set', () => {
    const r = loadAutoModeSettings({});
    expect(r.engine).toBe('llm');
    expect(r.classifierModel).toBeUndefined();
    expect(r.classifierModelEnv).toBeUndefined();
    expect(r.timeoutMs).toBeUndefined();
  });

  it('reads engine / classifierModel / timeoutMs from settings file', () => {
    writeFakeConfig({
      engine: 'rules',
      classifierModel: 'kimi-code:kimi-for-coding',
      timeoutMs: 5000,
    });
    const r = loadAutoModeSettings({});
    expect(r.engine).toBe('rules');
    expect(r.classifierModel).toBe('kimi-code:kimi-for-coding');
    expect(r.timeoutMs).toBe(5000);
  });

  it('KODAX_AUTO_MODE_ENGINE env wins over settings.engine', () => {
    writeFakeConfig({ engine: 'llm' });
    const r = loadAutoModeSettings({ KODAX_AUTO_MODE_ENGINE: 'rules' });
    expect(r.engine).toBe('rules');
  });

  it('KODAX_AUTO_MODE_CLASSIFIER_MODEL env is surfaced separately so the resolver can see env-vs-settings layer ordering', () => {
    writeFakeConfig({ classifierModel: 'from-settings' });
    const r = loadAutoModeSettings({ KODAX_AUTO_MODE_CLASSIFIER_MODEL: 'from-env' });
    expect(r.classifierModel).toBe('from-settings');
    expect(r.classifierModelEnv).toBe('from-env');
  });

  it('KODAX_AUTO_MODE_TIMEOUT_MS env wins over settings.timeoutMs', () => {
    writeFakeConfig({ timeoutMs: 1000 });
    const r = loadAutoModeSettings({ KODAX_AUTO_MODE_TIMEOUT_MS: '7500' });
    expect(r.timeoutMs).toBe(7500);
  });

  it('invalid env engine falls through to settings (defensive: a typo must not silently disable classifier)', () => {
    writeFakeConfig({ engine: 'rules' });
    const r = loadAutoModeSettings({ KODAX_AUTO_MODE_ENGINE: 'YOLO' });
    expect(r.engine).toBe('rules');
  });

  it('invalid env timeout falls through to settings (NaN, negative, zero, non-numeric)', () => {
    writeFakeConfig({ timeoutMs: 1000 });
    const cases = ['NaN', '-1', '0', 'fast', ''];
    for (const v of cases) {
      const r = loadAutoModeSettings({ KODAX_AUTO_MODE_TIMEOUT_MS: v });
      expect(r.timeoutMs).toBe(1000);
    }
  });

  it('whitespace-only / empty classifierModel string is treated as unset', () => {
    writeFakeConfig({ classifierModel: '   ' });
    const r = loadAutoModeSettings({});
    expect(r.classifierModel).toBeUndefined();
  });

  it('settings file with no autoMode block returns engine=llm + everything else undefined', () => {
    writeFakeConfig(undefined);
    const r = loadAutoModeSettings({});
    expect(r.engine).toBe('llm');
    expect(r.classifierModel).toBeUndefined();
    expect(r.timeoutMs).toBeUndefined();
  });

  it('floats in timeoutMs are floored (settings)', () => {
    writeFakeConfig({ timeoutMs: 3000.7 });
    const r = loadAutoModeSettings({});
    expect(r.timeoutMs).toBe(3000);
  });
});
