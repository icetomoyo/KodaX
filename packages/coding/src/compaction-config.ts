/**
 * @kodax-ai/coding Compaction Config
 *
 * Automatic large compaction is always enabled. Its percentage trigger
 * defaults to 75% and is clamped to 15-90; an optional absolute threshold can
 * trigger earlier. Physical provider-envelope capacity remains authoritative.
 *
 * User config can override via `~/.kodax/config.json`:
 *   { "compaction": { "triggerPercent": 80 } }
 */

import { readFile } from 'fs/promises';
import {
  DEFAULT_COMPACTION_TRIGGER_PERCENT,
  getAgentConfigPath,
  normalizeCompactionConfig,
} from '@kodax-ai/agent';
import type { CompactionConfig } from '@kodax-ai/agent';

/**
 * Resolve the default automatic trigger. The context-window argument remains
 * for public API compatibility; the default no longer varies by window.
 */
export function adaptiveTriggerPercent(contextWindow: number | undefined): number {
  void contextWindow;
  return DEFAULT_COMPACTION_TRIGGER_PERCENT;
}

const BASE_CONFIG: Pick<CompactionConfig, 'enabled'> = {
  enabled: true,
};

/**
 * SDK-consumer compaction override. Mirrors the subset of `CompactionConfig`
 * an in-process caller (`KodaXOptions.compaction`) is allowed to pin.
 */
export type CompactionConfigOverride = Partial<
  Pick<CompactionConfig, 'contextWindow' | 'triggerPercent' | 'triggerTokens' | 'enabled' | 'reasoning'>
>;

/**
 * Load compaction config. Resolution precedence for every field
 * (highest to lowest):
 *
 *   1. SDK override (`overrides` arg — in-process `KodaXOptions.compaction`)
 *   2. user config (`~/.kodax/config.json` → `compaction.*`)
 *   3. 75% base default
 *
 * Percentage inputs are clamped to 15-90. `triggerTokens` is inactive when
 * absent or zero; otherwise the smaller active threshold wins.
 *
 * @param contextWindow retained for compatibility; it does not change the default.
 * @param overrides in-process overrides that win over the user config file.
 */
export async function loadCompactionConfig(
  contextWindow?: number,
  overrides?: CompactionConfigOverride,
): Promise<CompactionConfig> {
  const userConfigPath = getAgentConfigPath('config.json');
  let userOverrides: Partial<CompactionConfig> | undefined;
  try {
    const userConfig = await readConfigFile(userConfigPath);
    if (userConfig?.compaction) {
      userOverrides = userConfig.compaction as Partial<CompactionConfig>;
    }
  } catch {
    // ignore — fall through to default
  }

  const merged: CompactionConfig = {
    ...BASE_CONFIG,
    ...userOverrides,
    // triggerPercent is recomputed below; this satisfies the required field
    // during the spread when userOverrides omits it.
    triggerPercent: DEFAULT_COMPACTION_TRIGGER_PERCENT,
  };

  // SDK overrides win over the user config file — only for fields the
  // caller actually set.
  if (overrides?.enabled !== undefined) merged.enabled = overrides.enabled;
  if (overrides?.reasoning !== undefined) merged.reasoning = overrides.reasoning;
  if (overrides?.contextWindow !== undefined) {
    merged.contextWindow = overrides.contextWindow;
  }

  // Retain the effective-window call shape for compatibility; the default is
  // stable across model windows.
  const bucketWindow = merged.contextWindow ?? contextWindow;
  merged.triggerPercent =
    typeof overrides?.triggerPercent === 'number'
      ? overrides.triggerPercent
      : typeof userOverrides?.triggerPercent === 'number'
        ? userOverrides.triggerPercent
        : adaptiveTriggerPercent(bucketWindow);

  if (overrides?.triggerTokens !== undefined) {
    merged.triggerTokens = overrides.triggerTokens;
  }

  return normalizeCompactionConfig(merged);
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
