import type { KodaXProviderPolicyDecision } from '@kodax/coding';
import type { CurrentConfig } from '../commands/types.js';
import { getProviderPolicyDecision } from '../common/utils.js';

export type SessionTransitionGuardReporter = (
  status: 'warn' | 'block',
  headline: string,
  details: string[],
) => void;

export function evaluateSessionTransitionPolicy(
  currentConfig: Pick<CurrentConfig, 'provider' | 'model'>,
): KodaXProviderPolicyDecision | null {
  return getProviderPolicyDecision(
    currentConfig.provider,
    currentConfig.model,
    'off',
    { longRunning: true },
  );
}

export function formatSessionTransitionGuardMessage(
  action: string,
  decision: KodaXProviderPolicyDecision,
): string[] {
  const providerLabel = decision.snapshot.model
    ? `${decision.snapshot.provider}:${decision.snapshot.model}`
    : decision.snapshot.provider;
  const lines = [
    `[Provider Guardrail] ${action} on ${providerLabel}: ${decision.summary}`,
  ];

  const primaryIssue = decision.issues[0]?.detail;
  if (primaryIssue) {
    lines.push(`  ${primaryIssue}`);
  }

  if (decision.status === 'block') {
    lines.push('  Switch to a provider with durable full-history session semantics before continuing.');
  } else if (decision.status === 'warn') {
    lines.push('  Continuing with degraded session semantics.');
  }

  return lines;
}

export function enforceSessionTransitionGuard(
  currentConfig: Pick<CurrentConfig, 'provider' | 'model'>,
  action: string,
  report: SessionTransitionGuardReporter,
): boolean {
  const decision = evaluateSessionTransitionPolicy(currentConfig);
  if (!decision || decision.status === 'allow') {
    return true;
  }

  const [headline, ...details] = formatSessionTransitionGuardMessage(action, decision);
  report(decision.status, headline, details);
  return decision.status !== 'block';
}
