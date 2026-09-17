import type { KodaXReasoningProfile } from './types.js';

const DESCENDING_EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'];

/** Candidate wire values, not a claim that the endpoint implements these levels. */
export function buildReasoningEffortLadder(
  profile: KodaXReasoningProfile,
  requested = 'auto',
): (string | undefined)[] {
  if (profile.effortStrategy === 'none' || profile.effortStrategy === 'prompt-only') {
    return [undefined];
  }
  const alias = (value: string) => profile.effortAliases?.[value] ?? value;
  const declared = profile.supportedEfforts?.map(entry => alias(entry.value));
  const available = DESCENDING_EFFORTS.filter(value =>
    !profile.disabledEfforts?.includes(value) && (!declared || declared.includes(value)));
  const selected = requested === 'auto'
    ? profile.defaultEffort ?? profile.supportedEfforts?.find(entry => entry.isDefault)?.value ?? 'max'
    : requested;
  const start = alias(selected);
  const disabled = selected === 'none' || profile.disabledEfforts?.includes(selected);
  const candidates = disabled
    ? [...(profile.supportsDisabledThinking === false ? [] : ['none']), ...available.slice().reverse()]
    : [start, ...available.filter(value => DESCENDING_EFFORTS.indexOf(value) > DESCENDING_EFFORTS.indexOf(start))];
  return [...new Set(candidates.filter(value =>
    !profile.localRejectEfforts?.includes(value)
    && (value === 'none' || !declared || declared.includes(value) || profile.allowCustomEffort),
  )), undefined];
}

export function usesReasoningEffortLadder(profile: KodaXReasoningProfile | undefined): profile is KodaXReasoningProfile & {
  effortStrategy: 'openai-chat-effort' | 'openai-responses-effort';
} {
  return profile?.effortStrategy === 'openai-chat-effort'
    || profile?.effortStrategy === 'openai-responses-effort';
}
