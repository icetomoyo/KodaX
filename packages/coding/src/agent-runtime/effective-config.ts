/**
 * FEATURE_247 (R4) — effective managed-task configuration snapshot.
 *
 * Both managed-task entry paths (SA via `dispatchManagedTask`, AMA via
 * `runManagedTaskViaRunner`) call `emitEffectiveTaskConfig` once at run start so
 * an SDK embedder subscribed to `KodaXEvents.onEffectiveConfig` can confirm the
 * intended profile entered the pipeline and inspect its tool scope + verification
 * requirements. Children (raw `runKodaX`) never reach these entry points, so the
 * event fires once per top-level managed task.
 */

import type {
  KodaXAgentMode,
  KodaXEffectiveTaskConfig,
  KodaXOptions,
  KodaXTaskVerificationContract,
} from '../types.js';

export function resolveEffectiveVerification(
  options: KodaXOptions,
): KodaXTaskVerificationContract | undefined {
  const profile = options.context?.agentProfile;
  const profileDefault = profile?.verification;
  const perTask = options.context?.taskVerification;
  if (!profileDefault && !perTask) return undefined;
  const merged = { ...profileDefault, ...perTask };
  // Guard the documented shallow-merge footgun: an explicitly-empty per-task
  // `criteria: []` would REPLACE (not element-merge) the profile's criteria,
  // silently disabling every profile-level verification criterion. Treat an
  // empty per-task array as "unset" so the profile default survives.
  if (
    Array.isArray(perTask?.criteria) &&
    perTask.criteria.length === 0 &&
    Array.isArray(profileDefault?.criteria) &&
    profileDefault.criteria.length > 0
  ) {
    return { ...merged, criteria: profileDefault.criteria };
  }
  return merged;
}

/**
 * Emit the effective-config snapshot if the caller subscribed. The observer
 * callback is defensively wrapped — a throwing subscriber must never abort the
 * managed-task run.
 */
export function emitEffectiveTaskConfig(
  options: KodaXOptions,
  args: {
    readonly agentMode: KodaXAgentMode;
    readonly toolScope: readonly string[];
  },
): void {
  const cb = options.events?.onEffectiveConfig;
  if (!cb) return;
  const config: KodaXEffectiveTaskConfig = {
    agentMode: args.agentMode,
    agentProfile: options.context?.agentProfile,
    toolScope: args.toolScope,
    verification: resolveEffectiveVerification(options),
  };
  try {
    cb(config);
  } catch {
    // Observer must not break the run.
  }
}
