/**
 * @kodax/coding Compaction Config
 *
 * Default trigger picks an adaptive percent based on the active provider's
 * context window. Short-window models compact earlier so the LLM doesn't
 * cross the attention-degradation zone (empirically ~120K based on
 * FEATURE_107 P6 eval, 2026-05-01).
 *
 * Mapping (chosen so the absolute trigger token count stays comparable
 * across windows — short-window models hit attention degradation at the
 * same absolute token count, not at the same percentage):
 *
 *   contextWindow ≤ 200K   →  60%   (~120K trigger)
 *   contextWindow ≤ 256K   →  65%   (~166K trigger)
 *   contextWindow ≤ 500K   →  70%   (~350K trigger)
 *   contextWindow > 500K   →  75%   (~750K @ 1M, prior default)
 *
 * User config can override via `~/.kodax/config.json`:
 *   { "compaction": { "triggerPercent": 80 } }
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { CompactionConfig } from '@kodax/agent';

const LEGACY_DEFAULT_TRIGGER_PERCENT = 75;

/**
 * Pick the trigger percent for a given context window. Exported so callers
 * (and tests) can resolve the same value the loader would.
 */
export function adaptiveTriggerPercent(contextWindow: number | undefined): number {
  if (typeof contextWindow !== 'number' || contextWindow <= 0) {
    return LEGACY_DEFAULT_TRIGGER_PERCENT;
  }
  if (contextWindow <= 200_000) return 60;
  if (contextWindow <= 256_000) return 65;
  if (contextWindow <= 500_000) return 70;
  return 75;
}

const BASE_CONFIG: Pick<CompactionConfig, 'enabled'> = {
  enabled: true,
};

/**
 * Load compaction config. Resolution order for `triggerPercent`:
 *
 *   1. user-config explicit value (`~/.kodax/config.json` →
 *      `compaction.triggerPercent`) — always wins
 *   2. adaptive default based on `contextWindow` argument
 *   3. legacy 75% when no context window is known
 *
 * @param contextWindow active provider's context window in tokens. Used
 *   only when user has not specified an explicit triggerPercent.
 */
export async function loadCompactionConfig(
  contextWindow?: number,
): Promise<CompactionConfig> {
  const userConfigPath = join(homedir(), '.kodax', 'config.json');
  let userOverrides: Partial<CompactionConfig> | undefined;
  try {
    const userConfig = await readConfigFile(userConfigPath);
    if (userConfig?.compaction) {
      userOverrides = userConfig.compaction as Partial<CompactionConfig>;
    }
  } catch {
    // ignore — fall through to default
  }

  const triggerPercent =
    typeof userOverrides?.triggerPercent === 'number'
      ? userOverrides.triggerPercent
      : adaptiveTriggerPercent(contextWindow);

  return {
    ...BASE_CONFIG,
    ...userOverrides,
    triggerPercent,
  };
}

async function readConfigFile(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}
