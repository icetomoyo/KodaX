import type { KodaXReasoningProfile } from './types.js';

export type CapabilityCacheSource = 'observed' | 'probed';

export interface CapabilityCacheEntry {
  /** Efforts this provider/model rejected; removed from the effective ladder. */
  readonly rejected: readonly string[];
  /** How the rejection was learned. */
  readonly source: CapabilityCacheSource;
  /** ISO timestamp of the last update. */
  readonly updatedAt: string;
}

/** Keyed by `provider/model`. */
export type CapabilityCache = Record<string, CapabilityCacheEntry>;

export function capabilityCacheKey(
  provider: string,
  model: string | undefined,
  scope?: string,
): string {
  return `${provider}/${model ?? ''}${scope === undefined ? '' : `#${scope}`}`;
}

/**
 * Narrow a reasoning profile by learned hard rejections.
 *
 * Learning only removes rungs. Provider acceptance is not proof that an effort
 * is semantically distinct, but a hard rejection is ground truth that the rung
 * should not be sent again for this provider/model.
 */
export function narrowReasoningProfile(
  profile: KodaXReasoningProfile,
  rejected: readonly string[],
): KodaXReasoningProfile {
  if (rejected.length === 0) {
    return profile;
  }
  const rejectedSet = new Set(rejected);
  const defaultRejected = profile.defaultEffort !== undefined
    && rejectedSet.has(profile.defaultEffort);
  return {
    ...profile,
    ...(defaultRejected ? { defaultEffort: undefined } : {}),
    supportedEfforts: profile.supportedEfforts?.filter(
      (preset) => !rejectedSet.has(preset.value),
    ),
    localRejectEfforts: Array.from(
      new Set([...(profile.localRejectEfforts ?? []), ...rejected]),
    ),
  };
}

export function getRejectedEfforts(
  cache: CapabilityCache,
  provider: string,
  model: string | undefined,
  scope?: string,
): readonly string[] {
  return cache[capabilityCacheKey(provider, model, scope)]?.rejected ?? [];
}

export function addRejectedEffort(
  cache: CapabilityCache,
  provider: string,
  model: string | undefined,
  effort: string,
  source: CapabilityCacheSource,
  updatedAt: string,
  scope?: string,
): CapabilityCache {
  const key = capabilityCacheKey(provider, model, scope);
  const prior = cache[key];
  const rejected = prior?.rejected.includes(effort)
    ? prior.rejected
    : [...(prior?.rejected ?? []), effort];
  return { ...cache, [key]: { rejected, source, updatedAt } };
}

export function removeCacheEntry(
  cache: CapabilityCache,
  provider?: string,
  model?: string,
): CapabilityCache {
  if (!provider) {
    return {};
  }
  const next = { ...cache };
  delete next[capabilityCacheKey(provider, model)];
  for (const key of Object.keys(next)) {
    if (key.startsWith(`${capabilityCacheKey(provider, model)}#`)) delete next[key];
  }
  return next;
}

export function sanitizeCapabilityCache(raw: unknown): CapabilityCache {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: CapabilityCache = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const rejected = Array.isArray(entry.rejected)
      ? entry.rejected.filter((effort): effort is string => typeof effort === 'string')
      : [];
    const source: CapabilityCacheSource = entry.source === 'probed' ? 'probed' : 'observed';
    const updatedAt = typeof entry.updatedAt === 'string' ? entry.updatedAt : '';
    out[key] = { rejected, source, updatedAt };
  }
  return out;
}
