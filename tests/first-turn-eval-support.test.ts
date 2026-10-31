import { describe, expect, it } from 'vitest';
import { FirstTurnBudget, FIRST_TURN_LIMITS, comparisonInputs, inputHash, observeFirstTurn, type BudgetSnapshot, type FrozenCase } from './first-turn-eval-support.js';

describe('first-turn bounded eval safeguards', () => {
  it('rejects incomplete persisted budgets and fractional call counters before dispatch', () => {
    const valid: BudgetSnapshot = { calls: 1, chargedTokens: 100, reservedTokens: 0,
      chargedUsd: 0.1, reservedUsd: 0, unknownUsageCalls: 0 };
    for (const key of Object.keys(valid)) {
      const incomplete = Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));
      expect(() => new FirstTurnBudget(JSON.parse(JSON.stringify(incomplete)) as BudgetSnapshot)).toThrow('Invalid persisted budget');
    }
    expect(() => new FirstTurnBudget({ ...valid, calls: 1.5 })).toThrow('Invalid persisted budget');
    expect(() => new FirstTurnBudget({ ...valid, unknownUsageCalls: 0.5 })).toThrow('Invalid persisted budget');
  });
  it('does not reset a persisted null ledger to a fresh budget', () => {
    expect(() => new FirstTurnBudget(JSON.parse('null') as BudgetSnapshot)).toThrow('Invalid persisted budget');
  });
  it('normalizes only fully settled floating-point dollar residue and preserves the saved ledger', () => {
    const saved: BudgetSnapshot = { calls: 2, chargedTokens: 20, reservedTokens: 0,
      chargedUsd: 0.58, reservedUsd: -Number.EPSILON / 4, unknownUsageCalls: 0 };
    const resumed = new FirstTurnBudget(saved);
    expect(resumed.state.reservedUsd).toBe(0);
    expect(resumed.state.calls).toBe(2);
    expect(saved.reservedUsd).toBe(-Number.EPSILON / 4);
    expect(() => new FirstTurnBudget({ ...saved, reservedUsd: -0.001 })).toThrow('Invalid persisted budget');
    expect(() => new FirstTurnBudget({ ...saved, reservedTokens: 1 })).toThrow('Invalid persisted budget');
    const budget = new FirstTurnBudget();
    budget.reserve(10, 0.17); budget.reserve(10, 0.41);
    budget.settle(10, 0.17); budget.settle(10, 0.41);
    expect(budget.state.reservedUsd).toBe(0);
  });
  it('reserves concurrent calls before dispatch and charges unknown usage instead of zero', () => {
    const budget = new FirstTurnBudget();
    budget.reserve(700_000, 1);
    expect(() => budget.reserve(700_000, 1)).toThrow('Token budget exhausted');
    budget.settle(700_000, 1);
    expect(budget.state.chargedTokens).toBe(700_000);
    expect(budget.state.chargedUsd).toBe(1);
    expect(budget.state.unknownUsageCalls).toBe(1);
  });
  it('never opens a thirty-third call or overspends the frozen cost ceiling', () => {
    const budget = new FirstTurnBudget();
    for (let n = 0; n < FIRST_TURN_LIMITS.maxProviderCalls; n++) { budget.reserve(1, 0); budget.settle(1, 0); }
    expect(() => budget.reserve(1, 0)).toThrow('Call budget exhausted');
    expect(() => new FirstTurnBudget().reserve(1, 3.01)).toThrow('Cost budget exhausted');
  });
  it('does not convert invalid provider cost data into an unbounded budget', () => {
    const budget = new FirstTurnBudget();
    budget.reserve(100, 0.1);
    budget.settle(100, 0.1, { inputTokens: 10, outputTokens: 1, totalTokens: 11 }, Number.NaN);
    expect(budget.state.chargedTokens).toBe(100);
    expect(budget.state.chargedUsd).toBe(0.1);
    expect(budget.state.unknownUsageCalls).toBe(1);
  });
  it('keeps historical calls when allocating the separate three-call smoke ceiling', () => {
    const budget = new FirstTurnBudget({ calls: 32, chargedTokens: 755942, reservedTokens: 0,
      chargedUsd: 0.05, reservedUsd: 0, unknownUsageCalls: 1 }, 35);
    for (let n = 0; n < 3; n++) { budget.reserve(100, 0.01); budget.settle(100, 0.01); }
    expect(budget.state.calls).toBe(35);
    expect(budget.state.chargedTokens).toBe(756242);
    expect(() => budget.reserve(1, 0)).toThrow('Call budget exhausted');
  });
  it('isolates todo production bytes without introducing synthetic tool descriptions', () => {
    const baseInput = { system: 'base', messages: [], tools: [{ name: 'todo_update', description: 'before', input_schema: { type: 'object' as const, properties: {} } }, { name: 'read', description: 'read-original', input_schema: { type: 'object' as const, properties: {} } }] };
    const nextInput = { ...baseInput, system: 'next', tools: [{ ...baseInput.tools[0]!, description: 'after' }, { ...baseInput.tools[1]!, description: 'unrelated change' }] };
    const fixture = (input: typeof baseInput): FrozenCase => ({ id: 'x', phase: 'pilot', task: 'task', rubric: '', input, hash: inputHash(input) });
    const [left, right] = comparisonInputs(fixture(baseInput), fixture(nextInput), 'todo-tools');
    expect(left.system).toBe(right.system);
    expect(right.tools[0]).toBe(nextInput.tools[0]);
    expect(right.tools[1]).toBe(baseInput.tools[1]);
    expect(() => comparisonInputs({ ...fixture(baseInput), hash: 'changed' }, fixture(nextInput), 'todo-tools')).toThrow('hash mismatch');
  });
  it('uses structured calls for negative observations, never a text mention regex', () => {
    expect(observeFirstTurn('trivial_answer', []).trivialExtraWork).toBe(false);
    expect(observeFirstTurn('resume_existing_plan', [{ name: 'todo_update', input: { op: 'init' } }]).legacyInit).toBe(true);
  });
});
