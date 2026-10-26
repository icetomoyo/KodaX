import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { prepareContractFixture } from './first-turn-compact-contract-fixture.js';
import { controlledActionKind } from './first-turn-compact-contract-cases.js';
import { continuation, assertFrozenCell, emptyResponse } from './first-turn-compact-contract.eval.js';

it('prepares real refusal, edit, failing-before/passing-after test and Todo receipts without a model', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-compact-contract-fixture-'));
  const prepared = await prepareContractFixture(directory);
  expect(prepared.originalTest.exitCode).toBe(1);
  expect(prepared.receipts.test).toContain('Exit code: 0');
  expect(prepared.receipts.refusedEdit).toContain('[Tool Error]');
  expect(JSON.parse(prepared.receipts.complete)).toEqual({ ok: true });
  expect(prepared.cases).toHaveLength(10);
  expect(prepared.cases.filter(item => item.pilot).map(item => item.id)).toEqual(['P02', 'P06']);
  expect(prepared.cases.find(item => item.id === 'P03')!.history).toHaveLength(2);
  const state = { caseId: 'C02', read: false, edited: false };
  const call = { type: 'tool_use' as const, id: 'step', name: 'bash', input: { command: 'node --test tests/equality.test.mjs' } };
  expect(() => continuation(state, [call], prepared)).toThrow('Unregistered');
  const read = continuation(state, [{ ...call, name: 'read', input: { path: 'packages/cache/store.js' } }], prepared);
  expect(JSON.stringify(read)).toContain('clock() > entry.expiresAt');
  const edit = continuation(state, [{ ...call, name: 'edit', input: { path: 'packages/cache/store.js', edits: [{ old_string: 'clock() > entry.expiresAt', new_string: 'clock() >= entry.expiresAt' }] } }], prepared);
  expect(JSON.stringify(edit)).toContain('step');
  expect(JSON.stringify(continuation(state, [call], prepared))).toContain('Exit code: 0');
  expect(() => continuation(state, [{ ...call, name: 'read', input: { path: '../outside' } }], prepared)).toThrow('Unregistered');
});

it('registers only bounded recovery actions without repairing model parameters', () => {
  const call = { type: 'tool_use' as const, id: 'r', name: 'read', input: { path: '../outside' } };
  expect(controlledActionKind('C02', call)).toBeUndefined();
  expect(call.input.path).toBe('../outside');
  expect(controlledActionKind('C02', { ...call, input: { path: 'packages/cache/store.js' } })).toBe('read');
  expect(controlledActionKind('C02', { ...call, name: 'write', input: { path: 'packages/cache/store.js' } })).toBeUndefined();
  expect(controlledActionKind('C01', { ...call, name: 'todo_update', input: { id: 'todo_2', status: 'completed' } })).toBe('todo-complete');
  expect(controlledActionKind('C01', { ...call, name: 'todo_update', input: { id: 'todo_2', status: 'completed', note: '已验证' } })).toBeUndefined();
  expect(controlledActionKind('C02', { ...call, name: 'bash', input: { command: 'node --test tests/equality.test.mjs', timeout: -1 } })).toBeUndefined();
  expect(controlledActionKind('C01', { ...call, name: 'todo_update', input: { id: 'todo_2', status: 'completed', subject: '扩大范围' } })).toBeUndefined();
});

it('rejects mutated frozen cells and never advances an empty provider response', () => {
  const frozen = { route: 'fixture', caseId: 'P02', input: { system: 'frozen' }, calls: 0 };
  expect(() => assertFrozenCell(frozen, structuredClone(frozen))).not.toThrow();
  expect(() => assertFrozenCell(frozen, { ...frozen, input: { system: 'changed' } })).toThrow('Frozen cell');
  expect(emptyResponse({ text: ' ', toolCalls: [] })).toBe(true);
  expect(emptyResponse({ text: 'final', toolCalls: [] })).toBe(false);
});
