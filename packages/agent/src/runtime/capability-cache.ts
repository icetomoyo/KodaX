import fsSync from 'node:fs';
import path from 'node:path';
import {
  addRejectedEffort,
  getRejectedEfforts,
  removeCacheEntry,
  sanitizeCapabilityCache,
  type CapabilityCache,
  type CapabilityCacheSource,
} from '@kodax-ai/llm';
import { getAgentConfigPath } from './agent-home.js';

export const CAPABILITY_CACHE_FILENAME = 'capability-cache.json';

export function getCapabilityCacheFile(configHome?: string): string {
  return configHome === undefined ? getAgentConfigPath(CAPABILITY_CACHE_FILENAME) : path.join(configHome, CAPABILITY_CACHE_FILENAME);
}

let memo: CapabilityCache | null = null;
let memoPath: string | null = null;

export function loadCapabilityCache(configHome?: string): CapabilityCache {
  const cacheFile = getCapabilityCacheFile(configHome);
  if (memo && memoPath === cacheFile) {
    return memo;
  }
  try {
    memo = fsSync.existsSync(cacheFile)
      ? sanitizeCapabilityCache(JSON.parse(fsSync.readFileSync(cacheFile, 'utf-8')))
      : {};
    memoPath = cacheFile;
  } catch {
    // Disposable cache: corrupt or unreadable files are reset, not migrated.
    memo = {};
    memoPath = cacheFile;
  }
  return memo;
}

function persistCapabilityCache(cache: CapabilityCache, configHome?: string): void {
  const cacheFile = getCapabilityCacheFile(configHome);
  memo = cache;
  memoPath = cacheFile;
  fsSync.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fsSync.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

export function getCachedRejectedEfforts(
  provider: string,
  model: string | undefined,
  configHome?: string,
): readonly string[] {
  return getRejectedEfforts(loadCapabilityCache(configHome), provider, model);
}

export function recordRejectedEffort(
  provider: string,
  model: string | undefined,
  effort: string,
  source: CapabilityCacheSource,
  updatedAt: string,
  configHome?: string,
): void {
  persistCapabilityCache(
    addRejectedEffort(loadCapabilityCache(configHome), provider, model, effort, source, updatedAt),
    configHome,
  );
}

export function clearCapabilityCache(provider?: string, model?: string, configHome?: string): void {
  persistCapabilityCache(removeCacheEntry(loadCapabilityCache(configHome), provider, model), configHome);
}

export function resetCapabilityCacheMemoForTesting(): void {
  memo = null;
  memoPath = null;
}
