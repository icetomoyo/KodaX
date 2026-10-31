import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilityCache } from '@kodax-ai/llm';
import { createCustomProvider } from '@kodax-ai/llm';
import { setAgentConfigHome } from './agent-home.js';
import {
  clearCapabilityCache,
  getCachedRejectedEfforts,
  getProviderReasoningCacheOptions,
  getCapabilityCacheFile,
  loadCapabilityCache,
  recordRejectedEffort,
  resetCapabilityCacheMemoForTesting,
} from './capability-cache.js';

describe('agent capability cache store', () => {
  let tempHome = '';
  let cacheFile = '';

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'kodax-agent-cap-cache-'));
    setAgentConfigHome(tempHome);
    resetCapabilityCacheMemoForTesting();
    cacheFile = join(tempHome, 'capability-cache.json');
  });

  afterEach(() => {
    resetCapabilityCacheMemoForTesting();
    setAgentConfigHome(undefined);
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
      tempHome = '';
    }
  });

  it('resolves under the active agent config home', () => {
    expect(getCapabilityCacheFile()).toBe(cacheFile);
  });

  it('persists scoped Responses evidence without inheriting legacy or another identity and clears all model scopes', () => {
    const provider = createCustomProvider({ name: 'p', protocol: 'openai', api: 'responses', model: 'm', baseUrl: 'https://cache.test/v1', apiKeyEnv: 'UNUSED' });
    recordRejectedEffort('p', 'm', '*', 'observed', 'old', tempHome);
    recordRejectedEffort('p', 'm', 'high', 'observed', 'new', tempHome, 'identity-a');
    resetCapabilityCacheMemoForTesting();
    const options = getProviderReasoningCacheOptions(provider, 'm', tempHome);
    expect(options.rejectedReasoningEfforts).toEqual([]);
    expect(options.resolveRejectedReasoningEfforts?.('identity-a')).toEqual(['high']);
    expect(options.resolveRejectedReasoningEfforts?.('identity-b')).toEqual([]);
    clearCapabilityCache('p', 'm', tempHome);
    expect(options.resolveRejectedReasoningEfforts?.('identity-a')).toEqual([]);
    expect(getCachedRejectedEfforts('p', 'm', tempHome)).toEqual([]);
  });

  it('resets to an empty cache when the on-disk JSON is corrupt', () => {
    writeFileSync(cacheFile, '{not json', 'utf8');
    expect(loadCapabilityCache()).toEqual({});
  });

  it('sanitizes on-disk entries before exposing them', () => {
    writeFileSync(
      cacheFile,
      JSON.stringify({
        'p/m': {
          rejected: ['max', 42, 'xhigh'],
          source: 'unknown',
          updatedAt: 123,
        },
      }),
      'utf8',
    );

    expect(loadCapabilityCache()['p/m']).toEqual({
      rejected: ['max', 'xhigh'],
      source: 'observed',
      updatedAt: '',
    });
  });

  it('memoizes reads until the test hook resets the memo', () => {
    writeFileSync(
      cacheFile,
      JSON.stringify({ 'p/m': { rejected: ['low'], source: 'observed', updatedAt: 'T0' } }),
      'utf8',
    );
    expect(getCachedRejectedEfforts('p', 'm')).toEqual(['low']);

    writeFileSync(
      cacheFile,
      JSON.stringify({ 'p/m': { rejected: ['high'], source: 'observed', updatedAt: 'T1' } }),
      'utf8',
    );
    expect(getCachedRejectedEfforts('p', 'm')).toEqual(['low']);

    resetCapabilityCacheMemoForTesting();
    expect(getCachedRejectedEfforts('p', 'm')).toEqual(['high']);
  });

  it('does not reuse memoized entries after the active config home changes', () => {
    writeFileSync(
      cacheFile,
      JSON.stringify({ 'p/m': { rejected: ['low'], source: 'observed', updatedAt: 'T0' } }),
      'utf8',
    );
    expect(getCachedRejectedEfforts('p', 'm')).toEqual(['low']);

    const otherHome = mkdtempSync(join(tmpdir(), 'kodax-agent-cap-cache-other-'));
    try {
      setAgentConfigHome(otherHome);
      recordRejectedEffort('p', 'm', 'high', 'observed', 'T1');

      const otherCacheFile = join(otherHome, 'capability-cache.json');
      const otherRaw = JSON.parse(readFileSync(otherCacheFile, 'utf8')) as CapabilityCache;
      expect(otherRaw['p/m']?.rejected).toEqual(['high']);
      expect(getCachedRejectedEfforts('p', 'm')).toEqual(['high']);

      const originalRaw = JSON.parse(readFileSync(cacheFile, 'utf8')) as CapabilityCache;
      expect(originalRaw['p/m']?.rejected).toEqual(['low']);
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
      setAgentConfigHome(tempHome);
    }
  });

  it('writes through to the active config home and clears entries', () => {
    recordRejectedEffort('p', 'm', 'max', 'observed', 'T0');

    expect(existsSync(cacheFile)).toBe(true);
    const raw = JSON.parse(readFileSync(cacheFile, 'utf8')) as CapabilityCache;
    expect(raw['p/m']?.rejected).toEqual(['max']);

    clearCapabilityCache('p', 'm');
    const cleared = JSON.parse(readFileSync(cacheFile, 'utf8')) as CapabilityCache;
    expect(cleared['p/m']).toBeUndefined();
  });
});
