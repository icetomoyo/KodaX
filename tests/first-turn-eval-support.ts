import { createHash } from 'node:crypto';
import type { KodaXMessage, KodaXToolDefinition, KodaXTokenUsage } from '../packages/llm/src/types.js';

export const FIRST_TURN_LIMITS = Object.freeze({ maxProviderCalls: 32, maxCallsPerCell: 1, maxRoundsPerCell: 1, maxOutputTokens: 2048, maxTotalTokens: 1_200_000, maxExternalSpendUsd: 3, timeoutMs: 120_000 });
export interface FrozenInput { readonly system: string; readonly messages: readonly KodaXMessage[]; readonly tools: readonly KodaXToolDefinition[] }
export interface FrozenCase { readonly id: string; readonly phase: 'pilot' | 'followup'; readonly task: string; readonly rubric: string; readonly input: FrozenInput; readonly hash: string }
export interface FrozenCapture { readonly source: string; readonly stage: string; readonly cases: readonly FrozenCase[] }
export type ComparisonAxis = 'todo-tools' | 'worker-prompt' | 'combined';
export const inputHash = (input: unknown): string => createHash('sha256').update(JSON.stringify(input)).digest('hex');
export const firstTurnReasoningFor = (provider: string) => provider === 'kimi-code'
  ? { enabled: true, effort: 'low' }
  : { enabled: false, effort: 'none' };

export function comparisonInputs(base: FrozenCase, candidate: FrozenCase, axis: ComparisonAxis): readonly [FrozenInput, FrozenInput] {
  if (base.id !== candidate.id || base.task !== candidate.task) throw new Error('Cases changed; freeze a new experiment revision');
  if (inputHash(base.input) !== base.hash || inputHash(candidate.input) !== candidate.hash) throw new Error('Frozen input hash mismatch');
  if (axis === 'combined') return [base.input, candidate.input];
  if (axis === 'worker-prompt') return [{ ...base.input, tools: candidate.input.tools }, candidate.input];
  const candidates = new Map(candidate.input.tools.map(t => [t.name, t]));
  const tools = base.input.tools.map(t => {
    if (!t.name.startsWith('todo_')) return t;
    const replacement = candidates.get(t.name);
    if (!replacement) throw new Error(`Candidate lost ${t.name}`);
    return replacement;
  });
  return [base.input, { ...base.input, tools }];
}

export interface BudgetSnapshot { calls: number; chargedTokens: number; reservedTokens: number; chargedUsd: number; reservedUsd: number; unknownUsageCalls: number }
export class FirstTurnBudget {
  readonly state: BudgetSnapshot;
  constructor(initial?: BudgetSnapshot, private readonly callLimit: number = FIRST_TURN_LIMITS.maxProviderCalls) {
    if (!Number.isInteger(callLimit) || callLimit < 1 || callLimit > 35) throw new Error('Invalid call limit');
    this.state = initial === undefined ? { calls: 0, chargedTokens: 0, reservedTokens: 0, chargedUsd: 0, reservedUsd: 0, unknownUsageCalls: 0 } : initial;
    const requiredKeys: readonly (keyof BudgetSnapshot)[] = ['calls', 'chargedTokens', 'reservedTokens', 'chargedUsd', 'reservedUsd', 'unknownUsageCalls'];
    if (!this.state || typeof this.state !== 'object'
      || requiredKeys.some(key => !Number.isFinite(this.state[key]) || this.state[key] < 0)
      || !Number.isInteger(this.state.calls) || !Number.isInteger(this.state.unknownUsageCalls)) throw new Error('Invalid persisted budget');
  }
  reserve(tokens: number, usd: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(usd) || usd < 0) throw new Error('Invalid call reservation');
    if (this.state.calls >= this.callLimit) throw new Error('Call budget exhausted');
    if (this.state.chargedTokens + this.state.reservedTokens + tokens > FIRST_TURN_LIMITS.maxTotalTokens) throw new Error('Token budget exhausted');
    if (this.state.chargedUsd + this.state.reservedUsd + usd > FIRST_TURN_LIMITS.maxExternalSpendUsd) throw new Error('Cost budget exhausted');
    this.state.calls += 1; this.state.reservedTokens += tokens; this.state.reservedUsd += usd;
  }
  settle(reservedTokens: number, reservedUsd: number, usage?: KodaXTokenUsage, actualUsd?: number): void {
    this.state.reservedTokens -= reservedTokens; this.state.reservedUsd -= reservedUsd;
    const known = usage !== undefined && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0 && actualUsd !== undefined && Number.isFinite(actualUsd) && actualUsd >= 0;
    this.state.chargedTokens += known ? usage.totalTokens : reservedTokens;
    this.state.chargedUsd += known ? actualUsd : reservedUsd;
    if (!known) this.state.unknownUsageCalls += 1;
  }
}

export function observeFirstTurn(caseId: string, toolCalls: readonly { name: string; input: unknown }[]) {
  const names = toolCalls.map(t => t.name);
  const legacyInit = toolCalls.some(t => t.name === 'todo_update' && typeof t.input === 'object' && t.input !== null && 'op' in t.input && t.input.op === 'init');
  return { toolNames: names, legacyInit, todoCalls: names.filter(n => n.startsWith('todo_')).length,
    trivialExtraWork: caseId === 'trivial_answer' && names.length > 0,
    wholeFileRecovery: caseId === 'edit_recovery' && names.includes('write'),
    duplicatePlanCreation: caseId === 'resume_existing_plan' && names.includes('todo_create'),
    note: 'Diagnostic observations only. Plan/recon/spawn order and material value require blind main-session review.' };
}
