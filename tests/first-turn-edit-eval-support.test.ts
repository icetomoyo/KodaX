import { expect, it } from 'vitest';
import { EditRevisionBudget, createEditLedger, assertEditLedger, EDIT_LIMITS } from './first-turn-edit-eval-support.js';
import type { BudgetSnapshot } from './first-turn-eval-support.js';

it('keeps exhausted v1 charges as immutable provenance instead of resetting or reusing its budget', () => {
  const prior: BudgetSnapshot = { calls: 35, chargedTokens: 768196, reservedTokens: 0, chargedUsd: 0.050298718, reservedUsd: 0, unknownUsageCalls: 1 };
  const text = JSON.stringify(prior);
  const ledger = createEditLedger('historical-v1.json', text);
  expect(ledger.prior.snapshot).toEqual(prior);
  expect(ledger.budget.calls).toBe(0);
  new EditRevisionBudget(ledger.budget).reserve(100, 0.01);
  expect(ledger.prior.snapshot.calls).toBe(35);
  expect(JSON.stringify(prior)).toBe(text);
  expect(() => createEditLedger('historical-v1.json', 'null')).toThrow('Invalid persisted budget');
  expect(() => createEditLedger('historical-v1.json', JSON.stringify({ ...prior, calls: 0 }))).toThrow('exhausted v1');
});

it('enforces the independent 600k token and one-dollar reference ceilings before dispatch', () => {
  expect(() => new EditRevisionBudget().reserve(600001, 0)).toThrow('Token budget exhausted');
  expect(() => new EditRevisionBudget().reserve(1, 1.01)).toThrow('Cost budget exhausted');
  const budget = new EditRevisionBudget();
  budget.reserve(400000, 0.6);
  expect(() => budget.reserve(200001, 0.1)).toThrow('Token budget exhausted');
  budget.settle(400000, 0.6);
  expect(budget.state.unknownUsageCalls).toBe(1);
  expect(budget.state.chargedTokens).toBe(400000);
});

it('never opens a nineteenth call and rejects a changed revision or missing history', () => {
  const budget = new EditRevisionBudget();
  for (let count = 0; count < EDIT_LIMITS.maxProviderCalls; count++) { budget.reserve(1, 0); budget.settle(1, 0); }
  expect(() => budget.reserve(1, 0)).toThrow('Call budget exhausted');
  const prior = { calls: 35, chargedTokens: 768196, reservedTokens: 0, chargedUsd: 0.05, reservedUsd: 0, unknownUsageCalls: 1 };
  const ledger = createEditLedger('v1.json', JSON.stringify(prior));
  expect(() => assertEditLedger({ ...ledger, revision: 'first-turn-v1' })).toThrow('revision');
  expect(() => assertEditLedger({ ...ledger, prior: undefined })).toThrow('history');
  expect(() => assertEditLedger({ ...ledger, budget: null })).toThrow('Invalid persisted budget');
});
