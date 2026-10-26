import { expect, it } from 'vitest';
import { buildWorkerStableInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import { compactManagedWorkerInput } from './first-turn-compact-candidate.js';
import type { FrozenInput } from './first-turn-eval-support.js';

const full = ['todo_create', 'todo_update', 'todo_list', 'spawn_agent', 'wait_agent', 'send_message', 'followup_task', 'list_agents', 'agent_output', 'interrupt_agent'];
function input(names?: string[]): FrozenInput {
  return { system: buildWorkerStableInstructions(names), tools: [{ name: 'sdk_extension', description: 'Unchanged extension', input_schema: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: 'Task unchanged' }] };
}

it('compacts only ordinary managed root policy and leaves tool contracts, task and other rules intact', () => {
  const before = input(full); const after = compactManagedWorkerInput(before, true);
  expect(after.system.length).toBeLessThan(before.system.length);
  expect(after.tools).toBe(before.tools); expect(after.messages).toBe(before.messages);
  expect(after.system).toContain('if this run has no current plan');
  expect(after.system).toContain('run resumed or continued');
  expect(after.system.slice(0, after.system.indexOf('PLAN-FIRST'))).toBe(before.system.slice(0, before.system.indexOf('PLAN-FIRST')));
  expect(after.system.slice(after.system.indexOf('SCOPE COMMITMENT'), after.system.indexOf('AGENT COLLABORATION')))
    .toBe(before.system.slice(before.system.indexOf('SCOPE COMMITMENT'), before.system.indexOf('AGENT COLLABORATION')));
});

it.each([[], ['read'], ['spawn_agent'], ...full.map(omitted => full.filter(name => name !== omitted))].map(names => ({ names })))('preserves partial SDK capability contracts: $names', ({ names }) => {
  const before = input(names); expect(compactManagedWorkerInput(before, true)).toBe(before);
});

it('rejects repeated full policy boundaries and preserves user text containing policy headings', () => {
  const before = input(full);
  expect(() => compactManagedWorkerInput({ ...before, system: before.system + '\n\n' + before.system }, true)).toThrow('Ambiguous');
  const messages = [{ role: 'user' as const, content: before.system }];
  expect(compactManagedWorkerInput({ ...before, messages }, true).messages).toBe(messages);
});

it.each([['multi_edit', 'change_bundle'], ['edit', 'changed_diff', 'relationship_scan'], ['lsp_hover', 'lsp_definition']])('preserves optional executable guidance: %j', (...names) => {
  const before = input([...full, ...names]); const after = compactManagedWorkerInput(before, true);
  expect(after.system.slice(after.system.indexOf('MUTATION DISCIPLINE:'), after.system.indexOf('AGENT COLLABORATION')))
    .toBe(before.system.slice(before.system.indexOf('MUTATION DISCIPLINE:'), before.system.indexOf('AGENT COLLABORATION')));
});

it('leaves SDK, specialist, child and auxiliary prompts untouched without managed-root eligibility', () => {
  const before = input(); expect(compactManagedWorkerInput(before, false)).toBe(before);
});

it('preserves legacy reader priority and optional routing/workflow language contracts', () => {
  const without = compactManagedWorkerInput(input(full), true).system;
  expect(without).not.toContain('registered specialist'); expect(without).not.toContain('run_workflow');
  const withAll = compactManagedWorkerInput(input([...full, 'todo_get', 'run_workflow', 'list_dispatchable_agents']), true).system;
  expect(withAll).toContain('`todo_get(id)`'); expect(withAll).toContain('registered specialist'); expect(withAll).toContain('run_workflow child prompts');
});

it('preserves coding and script executable-inventory guidance and outer host instructions byte-for-byte', () => {
  const original = input(); const suffix = '\n\nHOST RULES:\nNever replace the host contract.';
  const before = { ...original, system: original.system + suffix };
  const after = compactManagedWorkerInput(before, true);
  for (const [start, end] of [['MUTATION DISCIPLINE:', 'AGENT COLLABORATION'], ['EXECUTION GUIDANCE', 'TERMINATION:']]) {
    expect(after.system.slice(after.system.indexOf(start!), after.system.indexOf(end!))).toBe(before.system.slice(before.system.indexOf(start!), before.system.indexOf(end!)));
  }
  expect(after.system.endsWith(suffix)).toBe(true);
});
