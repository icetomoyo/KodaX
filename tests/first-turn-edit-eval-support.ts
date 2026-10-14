import { createHash } from 'node:crypto';
import type { KodaXTokenUsage, KodaXStreamResult } from '../packages/llm/src/types.js';
import type { CostRate } from '../packages/llm/src/cost-rates.js';
import type { ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { FirstTurnBudget, inputHash, type BudgetSnapshot } from './first-turn-eval-support.js';

export const EDIT_LIMITS = Object.freeze({ maxProviderCalls: 18, plannedLayer2Calls: 8, plannedSmokeCalls: 8,
  maxCallsPerLayer2Cell: 1, maxRoundsPerLayer2Cell: 1, maxSmokeCalls: 4, maxSmokeRounds: 4,
  maxSmokeToolCalls: 3, maxSmokeCases: 2, maxChildren: 0, maxOutputTokens: 2048,
  maxTotalTokens: 600000, maxExternalSpendUsd: 1, timeoutMs: 120000, smokeTimeoutMs: 300000 });

export interface EditRoute { id: string; provider: string; model: string; env: string; rate: CostRate; reasoning: { enabled: boolean; effort: string }; billing: 'coding-plan-reference-only' }
export interface CallEvidence {
  inputHash: string; result?: KodaXStreamResult; text: string; toolCalls: readonly { name: string; input: unknown }[];
  usage: KodaXStreamResult['usage'] | null; estimatedUsd: number | null; error: string | null;
  physicalRequestObservations: readonly ProviderRequestObservation[]; physicalAttempts: number; durationMs: number;
}

export class EditRevisionBudget extends FirstTurnBudget {
  constructor(initial?: BudgetSnapshot) { super(initial, EDIT_LIMITS.maxProviderCalls); }
  override reserve(tokens: number, usd: number): void {
    if (this.state.chargedTokens + this.state.reservedTokens + tokens > EDIT_LIMITS.maxTotalTokens) throw new Error('Token budget exhausted');
    if (this.state.chargedUsd + this.state.reservedUsd + usd > EDIT_LIMITS.maxExternalSpendUsd) throw new Error('Cost budget exhausted');
    super.reserve(tokens, usd);
  }
  override settle(tokens: number, usd: number, usage?: KodaXTokenUsage, cost?: number): void {
    super.settle(tokens, usd, usage, cost);
    // Concurrent lanes may leave roundoff after adding/subtracting dollars.
    if (Math.abs(this.state.reservedUsd) < 1e-12) this.state.reservedUsd = 0;
  }
}

export interface EditLedger {
  revision: 'first-turn-edit-v2';
  limits: typeof EDIT_LIMITS;
  prior: { path: string; sha256: string; snapshot: BudgetSnapshot };
  budget: BudgetSnapshot;
}
export function createEditLedger(priorPath: string, priorText: string): EditLedger {
  const prior = JSON.parse(priorText) as BudgetSnapshot;
  new FirstTurnBudget(prior, 35);
  if (prior.calls !== 35 || prior.reservedTokens !== 0 || Math.abs(prior.reservedUsd) > 1e-12) throw new Error('Expected exhausted v1 ledger, without active reservations');
  return { revision: 'first-turn-edit-v2', limits: EDIT_LIMITS,
    prior: { path: priorPath, sha256: createHash('sha256').update(priorText).digest('hex'), snapshot: prior },
    budget: new EditRevisionBudget().state };
}
export function assertEditLedger(value: unknown): asserts value is EditLedger {
  if (!value || typeof value !== 'object' || !('revision' in value) || value.revision !== 'first-turn-edit-v2'
    || !('limits' in value) || inputHash(value.limits) !== inputHash(EDIT_LIMITS)) throw new Error('Changed revision or limits');
  if (!('prior' in value) || !value.prior || typeof value.prior !== 'object'
    || !('path' in value.prior) || typeof value.prior.path !== 'string'
    || !('sha256' in value.prior) || typeof value.prior.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.prior.sha256)
    || !('snapshot' in value.prior)) throw new Error('Missing prior ledger history');
  const prior = value.prior.snapshot as BudgetSnapshot;
  new FirstTurnBudget(prior, 35);
  if (prior.calls !== 35) throw new Error('Changed prior ledger history');
  new EditRevisionBudget(('budget' in value ? value.budget : null) as BudgetSnapshot);
}
