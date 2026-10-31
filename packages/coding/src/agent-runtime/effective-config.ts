/** Effective configuration emitted at actual tool assembly/model request boundaries.
 * Each snapshot replaces the previous one; live tool projection may change between requests.
 */

import type {
  KodaXAgentMode,
  KodaXEffectiveTaskConfig,
  KodaXOptions,
  KodaXTaskVerificationContract,
} from '../types.js';
import { resolveWorkMode } from '../work-mode.js';

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
    readonly modelToolScope?: readonly string[];
  },
): void {
  const cb = options.events?.onEffectiveConfig;
  if (!cb) return;
  const verification = resolveEffectiveVerification(options);
  const config: KodaXEffectiveTaskConfig = {
    agentMode: args.agentMode,
    workMode: resolveWorkMode(options),
    ...(options.context?.agentProfile === undefined ? {} : { agentProfile: options.context.agentProfile }),
    toolScope: args.toolScope,
    ...(args.modelToolScope === undefined ? {} : { modelToolScope: args.modelToolScope }),
    ...(verification === undefined ? {} : { verification }),
  };
  try {
    cb(config);
  } catch {
    // Observer must not break the run.
  }
}
