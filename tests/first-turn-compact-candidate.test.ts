import { expect, it } from 'vitest';
import { buildWorkerStableInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import { compactManagedWorkerInput } from './first-turn-compact-candidate.js';
import type { FrozenInput } from './first-turn-eval-support.js';

const full = ['todo_create', 'todo_update', 'todo_list', 'spawn_agent', 'wait_agent', 'send_message', 'followup_task', 'list_agents', 'agent_output', 'interrupt_agent'];
function input(names?: string[]): FrozenInput {
  return { system: buildWorkerStableInstructions(names), tools: [{ name: 'sdk_extension', description: 'Unchanged extension', input_schema: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: 'Task unchanged' }] };
}

it.each([[], ['read'], ['spawn_agent'], ...full.map(omitted => full.filter(name => name !== omitted))].map(names => ({ names })))('preserves partial SDK capability contracts: $names', ({ names }) => {
  const before = input(names); expect(compactManagedWorkerInput(before, true)).toBe(before);
});

it.each([['multi_edit', 'change_bundle'], ['edit', 'changed_diff', 'relationship_scan'], ['lsp_hover', 'lsp_definition']])('preserves optional executable guidance: %j', (...names) => {
  const before = input([...full, ...names]); const after = compactManagedWorkerInput(before, true);
  expect(after.system.slice(after.system.indexOf('MUTATION DISCIPLINE:'), after.system.indexOf('AGENT COLLABORATION')))
    .toBe(before.system.slice(before.system.indexOf('MUTATION DISCIPLINE:'), before.system.indexOf('AGENT COLLABORATION')));
});

it('leaves SDK, specialist, child and auxiliary prompts untouched without managed-root eligibility', () => {
  const before = input(); expect(compactManagedWorkerInput(before, false)).toBe(before);
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
