import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearReasoningOverride,
  loadReasoningOverride,
  resetReasoningOverrideCache,
  saveReasoningOverride,
} from './reasoning-overrides.js';

const TEST_CONFIG_FILE = path.join(
  os.tmpdir(),
  `kodax-reasoning-overrides-${Date.now()}.json`,
);

const TEST_PROVIDER = 'test-provider';
const TEST_CONFIG = {
  baseUrl: undefined,
  model: 'test-model',
};

describe('reasoning overrides cache', () => {
  beforeEach(() => {
    process.env.KODAX_CONFIG_FILE = TEST_CONFIG_FILE;
    fs.rmSync(TEST_CONFIG_FILE, { force: true });
    resetReasoningOverrideCache();
  });

  afterEach(() => {
    delete process.env.KODAX_CONFIG_FILE;
    fs.rmSync(TEST_CONFIG_FILE, { force: true });
    resetReasoningOverrideCache();
  });

  it('reuses the in-memory config after the first disk read', () => {
    saveReasoningOverride(TEST_PROVIDER, TEST_CONFIG, 'budget');
    resetReasoningOverrideCache();

    const readSpy = vi.spyOn(fs, 'readFileSync');

    expect(loadReasoningOverride(TEST_PROVIDER, TEST_CONFIG)).toBe('budget');
    expect(loadReasoningOverride(TEST_PROVIDER, TEST_CONFIG)).toBe('budget');
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('updates the cached config when overrides are saved or cleared', () => {
    saveReasoningOverride(TEST_PROVIDER, TEST_CONFIG, 'budget');
    expect(loadReasoningOverride(TEST_PROVIDER, TEST_CONFIG)).toBe('budget');

    clearReasoningOverride(TEST_PROVIDER, TEST_CONFIG);
    expect(loadReasoningOverride(TEST_PROVIDER, TEST_CONFIG)).toBeUndefined();
  });

  it('ignores malformed override payloads from disk', () => {
    fs.writeFileSync(
      TEST_CONFIG_FILE,
      JSON.stringify({
        providerReasoningOverrides: {
          broken: 'not-a-real-override',
        },
      }),
    );

    expect(loadReasoningOverride(TEST_PROVIDER, TEST_CONFIG)).toBeUndefined();
  });
});
