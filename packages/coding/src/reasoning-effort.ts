import type { KodaXWireReasoningEffort } from '@kodax-ai/llm';
import { mapLegacyReasoningModeToEffortIntent } from '@kodax-ai/llm';
import type { AgentReasoningProfile } from '@kodax-ai/agent';

const EFFORT_RANK = new Map<string, number>([
  ['none', 0], ['minimal', 0], ['auto', 1], ['low', 2], ['medium', 3], ['high', 4], ['xhigh', 5], ['max', 6],
]);

/** Canonical policy order. Unknown custom efforts retain the historical medium rank. */
export function compareEfforts(a: KodaXWireReasoningEffort, b: KodaXWireReasoningEffort): -1 | 0 | 1 {
  const rankA = EFFORT_RANK.get(a) ?? 3;
  const rankB = EFFORT_RANK.get(b) ?? 3;
  return rankA < rankB ? -1 : rankA > rankB ? 1 : 0;
}

/** Clamp explicit specialist policy; built-in roots inherit Session effort. */
export function clampEffort(effort: KodaXWireReasoningEffort, ceiling: KodaXWireReasoningEffort): KodaXWireReasoningEffort {
  return compareEfforts(effort, ceiling) > 0 ? ceiling : effort;
}

/** Explicit specialist defaults/maxima; legacy SDK values normalize at intake. */
export function resolveRoleEffort(userCeiling: KodaXWireReasoningEffort, profile?: AgentReasoningProfile): KodaXWireReasoningEffort {
  if (userCeiling === 'none' || !profile) return userCeiling;
  const selected = profile.default ? mapLegacyReasoningModeToEffortIntent(profile.default) : userCeiling;
  return clampEffort(profile.max ? clampEffort(selected, mapLegacyReasoningModeToEffortIntent(profile.max)) : selected, userCeiling);
}
