import { expect, it } from 'vitest';
import { buildWorkerStableInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import { compactContractInput } from './first-turn-compact-contract.js';
import type { FrozenInput } from './first-turn-eval-support.js';
import { getToolDefinition } from '../packages/coding/src/tools/index.js';
import { projectModelToolDefinition } from '../packages/coding/src/tools/model-tool-definition.js';
import { buildMemoryRulesSection } from '../packages/coding/src/prompts/memory-rules.js';
import { compactToolText } from './first-turn-compact-contract-tools.js';

const names = ['read', 'edit', 'write', 'bash', 'grep', 'glob', 'todo_create', 'todo_update', 'todo_list',
  'spawn_agent', 'wait_agent', 'send_message', 'followup_task', 'list_agents', 'agent_output', 'interrupt_agent'];
const task = '请继续，保留已有测试与进度。';
function withoutAnnotations(value: unknown, propertyMap = false): unknown {
  if (Array.isArray(value)) return value.map(item => withoutAnnotations(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'description' || propertyMap)
    .map(([key, item]) => [key, withoutAnnotations(item, key === 'properties')]));
  return value;
}
function fixture(): FrozenInput {
  return { system: `Host-owned prefix\n${buildWorkerStableInstructions(names)}\nUser-owned suffix`,
    tools: names.map(name => ({ name, description: 'Host-owned custom contract', input_schema: { type: 'object', properties: {} } })),
    messages: [{ role: 'user', content: task }] };
}

it('makes the eligible root teaching shorter without changing messages or host tool contracts', () => {
  const before = fixture(); const after = compactContractInput(before, true);
  expect(after.system.length).toBeLessThan(before.system.length);
  expect(after.system.startsWith('Host-owned prefix\n')).toBe(true);
  expect(after.system.endsWith('\nUser-owned suffix')).toBe(true);
  expect(after.tools).toEqual(before.tools);
  expect(after.messages).toBe(before.messages);
  expect(after.system).toContain('resumed/continued');
  expect(after.system).toContain('same assistant response');
  expect(after.system).toContain('unresolved ownership');
  expect(after.system).toContain('do not pursue the prohibited effect through another command, shell or tool');
});

it('leaves SDK, child, specialist, partial, Script and custom-system consumers untouched', () => {
  const full = fixture();
  expect(compactContractInput(full, false)).toBe(full);
  for (const name of ['wait_agent', 'todo_update', 'spawn_agent']) {
    const tools = full.tools.filter(tool => tool.name !== name);
    const partial = { ...full, tools, system: buildWorkerStableInstructions(tools.map(tool => tool.name)) };
    expect(compactContractInput(partial, true)).toBe(partial);
  }
  const custom = { ...full, system: 'Custom role without KodaX Worker teaching' };
  expect(compactContractInput(custom, true)).toBe(custom);
  const script: FrozenInput = { ...full, tools: [...full.tools, { name: 'script_exec', description: 'Script', input_schema: { type: 'object', properties: {} } }] };
  expect(compactContractInput(script, true)).toBe(script);
});

it('refuses ambiguous Worker replacement instead of stripping unknown instructions', () => {
  const before = fixture();
  expect(() => compactContractInput({ ...before, system: before.system + before.system }, true)).toThrow('Ambiguous');
});

it('shortens the audited builtin without dropping a business description parameter or changing SDK input', () => {
  const raw = getToolDefinition('todo_update')!;
  const native = projectModelToolDefinition(raw, { kind: 'builtin' });
  const before = fixture();
  const input = { ...before, tools: before.tools.map(tool => tool.name === native.name ? native : tool) };
  const sdk = JSON.stringify(raw);
  const output = compactContractInput(input, true).tools.find(tool => tool.name === native.name)!;
  expect(output.description.length).toBeLessThan(native.description.length);
  expect(output.input_schema.properties.description).toHaveProperty('type', 'string');
  expect(output.input_schema.required).toEqual(native.input_schema.required);
  expect(JSON.stringify(raw)).toBe(sdk);
  const override = { ...native, description: native.description + ' Host-specific obligation.' };
  const custom = { ...input, tools: input.tools.map(tool => tool.name === native.name ? override : tool) };
  expect(compactContractInput(custom, true).tools.find(tool => tool.name === native.name)).toBe(override);
});

it('relocates duplicate Memory teaching only alongside the complete audited operation contract', () => {
  const tools = [...fixture().tools, getToolDefinition('memory_intent')!, getToolDefinition('memory_recall')!];
  const memory = buildMemoryRulesSection('.');
  const input = { ...fixture(), tools, system: memory + '\n\n' + buildWorkerStableInstructions(tools.map(tool => tool.name)) };
  const after = compactContractInput(input, true);
  expect(after.system).not.toContain(memory);
  expect(after.system).toContain('needs_clarification: no mutation');
  expect(after.tools.find(tool => tool.name === 'memory_intent')?.description).toContain('exact claim span');
  const overridden = { ...input, tools: tools.map(tool => tool.name === 'memory_intent' ? { ...tool, description: 'Host Memory rules' } : tool) };
  expect(compactContractInput(overridden, true).system).toContain(memory);
});

it('preserves the selected legacy Todo reader when the host exposes todo_get', () => {
  const tools: FrozenInput['tools'] = [...fixture().tools, { name: 'todo_get', description: 'Host reader', input_schema: { type: 'object', properties: {} } }];
  const input = { ...fixture(), tools, system: buildWorkerStableInstructions(tools.map(tool => tool.name)) };
  expect(compactContractInput(input, true).system).toContain('todo_get(id)');
  expect(compactContractInput(input, true).system).not.toContain('Refresh with todo_list({id})');
});

it('preserves the complete executable schema and tool order for every audited builtin projection', () => {
  const tools = Object.keys(compactToolText).map(name => {
    const definition = getToolDefinition(name);
    if (!definition) throw new Error(`Missing builtin ${name}`);
    return projectModelToolDefinition(definition, { kind: 'builtin' });
  });
  const input: FrozenInput = { ...fixture(), tools, system: buildWorkerStableInstructions(tools.map(tool => tool.name)) };
  const before = JSON.stringify(tools);
  const candidate = compactContractInput(input, true);
  expect(candidate.tools.map(tool => tool.name)).toEqual(tools.map(tool => tool.name));
  expect(withoutAnnotations(candidate.tools)).toEqual(withoutAnnotations(tools));
  expect(JSON.stringify(tools)).toBe(before);
  expect(candidate.tools.filter((tool, index) => tool !== tools[index])).toHaveLength(32);
  // Evolved activation/default semantics remain outside the frozen audit.
  expect(candidate.tools.filter((tool, index) => tool === tools[index]).map(tool => tool.name))
    .toEqual(['ask_user_question', 'todo_create']);
});
