import { expect, it } from 'vitest';
import { isRunnableTool } from '@kodax-ai/agent';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { KodaXProviderError } from '@kodax-ai/llm';
import { buildRunnerAgentChain } from '../packages/coding/src/task-engine/runner-driven.js';
import { getToolDefinition, registerTool } from '../packages/coding/src/tools/index.js';
import { projectDeferredRepoLspInput, DEFERRED_REPO_LSP_NAMES, resolveDeferredEvidenceRoot, isAuxiliaryLocalPreflight, isRejectOnlyBridgeCall, projectBridgeTeachingInput, projectLocalSearchInput } from './deferred-repo-lsp-support.js';
import type { FrozenInput } from './first-turn-eval-support.js';
import { buildWorkerStableInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import type { ManagedTaskBudgetController } from '../packages/coding/src/task-engine/_internal/managed-task/budget.js';

function fullInput(): FrozenInput {
  const worker = buildRunnerAgentChain({ backups: new Map(), executionCwd: process.cwd() }).worker;
  return { system: 'Unchanged AMA instructions.', messages: [{ role: 'user', content: 'Review this repository.' }],
    tools: (worker.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })) };
}

it('omits only the builtin local-search schema after policy assembly, without discovery teaching or child changes', () => {
  const assembled = fullInput();
  const input = { ...assembled, system: buildWorkerStableInstructions() };
  const before = JSON.stringify(input);
  const candidate = projectLocalSearchInput(input, true);
  expect(candidate.tools.map(tool => tool.name)).toEqual(input.tools.map(tool => tool.name).filter(name => name !== 'code_search'));
  expect(candidate.system).toBe(input.system);
  expect(candidate.messages).toBe(input.messages);
  for (const tool of candidate.tools) expect(tool).toBe(input.tools.find(original => original.name === tool.name));
  for (const obligation of ['todo_create', 'spawn_agent', 'wait_agent', 'agent_output']) expect(candidate.system).toContain(obligation);
  expect(JSON.stringify(input)).toBe(before);
  expect(projectLocalSearchInput(input, false)).toBe(input);
  const noGrep = { ...input, tools: input.tools.filter(tool => tool.name !== 'grep') };
  expect(projectLocalSearchInput(noGrep, true)).toBe(noGrep);
  expect(fullInput().tools.some(tool => tool.name === 'code_search')).toBe(true);
  expect(projectLocalSearchInput(candidate, true)).toBe(candidate);
});

it('does not change extension-owned search or bridge contracts in the experiments', () => {
  for (const name of ['code_search', 'tool_call']) {
    const unregister = registerTool({ name, description: 'Extension-owned contract.',
      input_schema: { type: 'object', properties: {} }, sideEffect: 'readonly',
      toClassifierInput: () => '', handler: async () => 'extension result',
    }, { source: { kind: 'extension', id: 'projection-contract-test' } });
    try {
      const input = fullInput();
      const projected = name === 'code_search' ? projectLocalSearchInput(input, true) : projectBridgeTeachingInput(input, true);
      expect(projected).toBe(input);
    } finally { unregister(); }
  }
});

it.each(['grep', 'glob', 'read', 'tool_search', 'tool_call'])('keeps local search when its builtin replacement or compatibility path is missing: %s', name => {
  const input = fullInput();
  const missing = { ...input, tools: input.tools.filter(tool => tool.name !== name) };
  expect(projectLocalSearchInput(missing, true)).toBe(missing);
  const unregister = registerTool({ name, description: 'Independent contract, not a builtin substitute.',
    input_schema: { type: 'object', properties: {} }, sideEffect: 'readonly',
    toClassifierInput: () => '', handler: async () => 'independent',
  }, { source: { kind: 'extension', id: 'search-substitute-contract' } });
  try {
    const overridden = fullInput();
    expect(projectLocalSearchInput(overridden, true)).toBe(overridden);
  } finally { unregister(); }
});

it('locates and reads a local file through the same three direct calls under either menu, with no discovery charge', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-direct-search-'));
  try {
    await fs.mkdir(path.join(workspace, '源 码'));
    await fs.writeFile(path.join(workspace, '源 码', 'cache-store.ts'), 'export const literal = "clock() >= insertedAt + ttlMs";\r\n');
    const receipts: unknown[][] = [];
    for (const projected of [false, true]) {
      const budget: ManagedTaskBudgetController = { totalBudget: 10, spentBudget: 0, currentHarness: 'H2_PLAN_EXECUTE_EVAL' };
      const agent = buildRunnerAgentChain({ backups: new Map(), executionCwd: workspace }, undefined, budget).worker;
      const input: FrozenInput = { system: buildWorkerStableInstructions(), messages: [], tools: agent.tools ?? [] };
      const menu = projectLocalSearchInput(input, projected);
      expect(menu.tools.some(tool => tool.name === 'code_search')).toBe(!projected);
      const observed = [];
      for (const call of [
        { name: 'grep', input: { pattern: 'clock\\(\\)', path: '源 码' } },
        { name: 'glob', input: { pattern: '**/*cache-store*' } },
        { name: 'read', input: { path: '源 码/cache-store.ts' } },
      ]) {
        expect(menu.tools.some(tool => tool.name === call.name)).toBe(true);
        const tool = agent.tools?.filter(isRunnableTool).find(tool => tool.name === call.name);
        if (!tool) throw new Error(`Missing ${call.name}`);
        const result = await tool.execute(call.input, { agent, toolCallId: call.name });
        expect(result.isError).not.toBe(true);
        expect(String(result.content)).toContain(call.name === 'glob' ? 'cache-store.ts' : 'insertedAt + ttlMs');
        observed.push(result.content);
      }
      expect(budget.spentBudget).toBe(3);
      receipts.push(observed);
    }
    expect(receipts[0]).toEqual(receipts[1]);
  } finally {
    if (path.dirname(workspace) !== path.resolve(os.tmpdir()) || !path.basename(workspace).startsWith('kodax-direct-search-')) throw new Error('Unsafe fixture path');
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

it('adds only a sibling-field bridge example to the root model view', () => {
  const input = fullInput();
  const before = JSON.stringify(input);
  const candidate = projectBridgeTeachingInput(input, true);
  expect(candidate.system).toBe(input.system);
  expect(candidate.messages).toBe(input.messages);
  expect(candidate.tools.map(tool => tool.name)).toEqual(input.tools.map(tool => tool.name));
  for (const tool of candidate.tools) {
    const original = input.tools.find(item => item.name === tool.name)!;
    expect(tool.input_schema).toBe(original.input_schema);
    if (tool.name !== 'tool_call') expect(tool).toBe(original);
    else {
      expect(tool.description).toContain('sibling top-level fields');
      expect(tool.description).toContain('{"name":"read","input":{"path":"README.md"}}');
    }
  }
  expect(JSON.stringify(input)).toBe(before);
  expect(projectBridgeTeachingInput(input, false)).toBe(input);
});

it('returns the actual bridge missing-name error without executing a nested target or repairing model arguments', async () => {
  const agent = buildRunnerAgentChain({ backups: new Map() }).worker;
  const bridge = agent.tools!.filter(isRunnableTool).find(tool => tool.name === 'tool_call')!;
  for (const input of [{ input: { name: 'kodax_manual', input: { topic: 'extensions' } } },
    { input: { name: 'write', input: { path: '../never-write', content: 'forbidden' } } }]) {
    const call = { id: 'missing-name', name: 'tool_call', input };
    const original = structuredClone(call);
    expect(isRejectOnlyBridgeCall(call)).toBe(true);
    expect(await bridge.execute(input, { agent, toolCallId: call.id })).toMatchObject({
      isError: true, content: '[Tool Error] tool_call: `name` is required.',
    });
    expect(call).toEqual(original);
  }
  // A concrete target (even with invalid/missing input) must still pass the scope gate.
  expect(isRejectOnlyBridgeCall({ id: 'write', name: 'tool_call', input: { name: 'write' } })).toBe(false);
  expect(isRejectOnlyBridgeCall({ id: 'read', name: 'read', input: {} })).toBe(false);
});

it('returns the production recursion rejection without dispatching the nested write', async () => {
  const agent = buildRunnerAgentChain({ backups: new Map() }).worker;
  const bridge = agent.tools!.filter(isRunnableTool).find(tool => tool.name === 'tool_call')!;
  const call = { id: 'recursive', name: 'tool_call', input: {
    name: 'tool_call', input: { name: 'write', input: { path: '../never-write', content: 'forbidden' } },
  } };
  expect(isRejectOnlyBridgeCall(call)).toBe(true);
  expect(await bridge.execute(call.input, { agent, toolCallId: call.id })).toMatchObject({
    isError: true, content: '[Tool Error] tool_call: bridge meta-tools cannot be called through tool_call.',
  });
});

it('experiments with only the manual schema after AMA policy assembly', () => {
  const assembled = fullInput();
  const input = { ...assembled, system: buildWorkerStableInstructions(assembled.tools.map(tool => tool.name)) };
  const before = JSON.stringify(input);
  const projected = projectDeferredRepoLspInput(input, true, 'manual');
  expect(projected.tools.map(tool => tool.name)).toEqual(input.tools.map(tool => tool.name).filter(name => name !== 'kodax_manual'));
  expect(projected.system).toBe(input.system);
  expect(projected.messages).toBe(input.messages);
  expect(projected.system).toContain('todo_create');
  // A restricted SDK inventory must keep its restricted policy; projection cannot grant actors.
  expect(projected.system).not.toContain('spawn_agent');
  const fullPolicy = { ...input, system: buildWorkerStableInstructions() };
  const projectedFullPolicy = projectDeferredRepoLspInput(fullPolicy, true, 'manual');
  expect(projectedFullPolicy.system).toBe(fullPolicy.system);
  for (const obligation of ['todo_create', 'spawn_agent', 'wait_agent', 'agent_output']) expect(projectedFullPolicy.system).toContain(obligation);
  expect(projected.tools.find(tool => tool.name === 'tool_search')!.description).toContain('kodax_manual');
  expect(JSON.stringify(input)).toBe(before);
  expect(projectDeferredRepoLspInput(input, false, 'manual')).toBe(input);
  const unavailable = { ...input, tools: input.tools.filter(tool => tool.name !== 'kodax_manual') };
  expect(projectDeferredRepoLspInput(unavailable, true, 'manual')).toBe(unavailable);
  const noBridge = { ...input, tools: input.tools.filter(tool => tool.name !== 'tool_call') };
  expect(projectDeferredRepoLspInput(noBridge, true, 'manual')).toBe(noBridge);
});

it('discovers the manual and preserves SDK topics, unknown-topic recovery and one-charge execution', async () => {
  const outputs: unknown[][] = [];
  for (const bridged of [false, true]) {
    const budget: ManagedTaskBudgetController = { totalBudget: 100, spentBudget: 0, currentHarness: 'H2_PLAN_EXECUTE_EVAL' };
    const agent = buildRunnerAgentChain({ backups: new Map(), selfManual: {
      productName: 'FixtureDesk', baseTopics: [], topics: [
        { id: 'restore', title: 'Restore policy', summary: 'Restore an archived item', body: 'Use Restore from the Archive panel; revision fixture-20261024.' },
      ],
    } }, undefined, budget).worker;
    const search = agent.tools!.filter(isRunnableTool).find(tool => tool.name === 'tool_search')!;
    const discovered = await search.execute({ query: 'select:kodax_manual' }, { agent, toolCallId: 'discover' });
    expect(String(discovered.content)).toContain('FixtureDesk');
    expect(String(discovered.content)).toContain('topic');
    const spentBefore = budget.spentBudget;
    const observed = [];
    for (const topic of ['missing', 'restore']) {
      const input = bridged ? { name: 'kodax_manual', input: { topic } } : { topic };
      const original = structuredClone(input);
      const result = await agent.tools!.filter(isRunnableTool).find(tool => tool.name === (bridged ? 'tool_call' : 'kodax_manual'))!
        .execute(input, { agent, toolCallId: topic });
      observed.push({ content: result.content, isError: result.isError === true });
      expect(input).toEqual(original);
    }
    expect(budget.spentBudget - spentBefore).toBe(2);
    expect(JSON.stringify(observed[0])).toContain('restore');
    expect(JSON.stringify(observed[1])).toContain('fixture-20261024');
    outputs.push(observed);
  }
  expect(outputs[0]).toEqual(outputs[1]);
});

it('does not reintroduce a manual denied by visibility policy through discovery or bridge', async () => {
  const agent = buildRunnerAgentChain({ backups: new Map(), toolVisibilityPolicy: tool => tool.name !== 'kodax_manual' }).worker;
  expect(agent.tools!.some(tool => tool.name === 'kodax_manual')).toBe(false);
  const discovered = await agent.tools!.filter(isRunnableTool).find(tool => tool.name === 'tool_search')!
    .execute({ query: 'select:kodax_manual' }, { agent, toolCallId: 'search-denied' });
  expect(String(discovered.content)).not.toContain('"name":"kodax_manual"');
  const denied = await agent.tools!.filter(isRunnableTool).find(tool => tool.name === 'tool_call')!
    .execute({ name: 'kodax_manual', input: {} }, { agent, toolCallId: 'call-denied' });
  expect(denied.isError).toBe(true);
});

it('keeps raw evidence beneath OS Temp and rejects worktree or parent paths', () => {
  const valid = path.join(os.tmpdir(), 'kodax-eval-dumps', 'deferred-unit');
  expect(resolveDeferredEvidenceRoot(valid)).toBe(path.resolve(valid));
  expect(() => resolveDeferredEvidenceRoot(process.cwd())).toThrow('OS Temp');
  expect(() => resolveDeferredEvidenceRoot(path.resolve(os.tmpdir(), '..'))).toThrow('OS Temp');
  expect(() => resolveDeferredEvidenceRoot(os.tmpdir())).toThrow('OS Temp');
});

it('preserves the existing auxiliary fallback only for proven local request-build rejection', () => {
  const rejection = new KodaXProviderError('Unsupported local reasoning choice', 'fixture',
    { failureCode: 'request_build_failed', stage: 'request_build' });
  expect(isAuxiliaryLocalPreflight(rejection, [], ['report_stall_judgment'])).toBe(true);
  expect(isAuxiliaryLocalPreflight(rejection, [], ['read'])).toBe(false);
  expect(isAuxiliaryLocalPreflight(new Error('Network failure'), [], ['report_stall_judgment'])).toBe(false);
  expect(isAuxiliaryLocalPreflight(rejection, [{ boundary: 'physical_attempt' }], ['report_stall_judgment'])).toBe(false);
});

it('defers exactly twelve builtin root schemas without changing other contracts or mutating inputs', () => {
  const input = fullInput();
  const original = JSON.stringify(input);
  const projected = projectDeferredRepoLspInput(input, true);
  expect(DEFERRED_REPO_LSP_NAMES).toHaveLength(12);
  expect(input.tools.filter(tool => DEFERRED_REPO_LSP_NAMES.includes(tool.name))).toHaveLength(12);
  expect(projected.tools).toHaveLength(input.tools.length - 12);
  expect(projected.system).toBe(input.system);
  expect(projected.messages).toBe(input.messages);
  expect(JSON.stringify(input)).toBe(original);
  expect(projected.tools.map(tool => tool.name)).toEqual(input.tools.map(tool => tool.name).filter(name => !DEFERRED_REPO_LSP_NAMES.includes(name)));
  for (const tool of projected.tools) {
    if (tool.name !== 'tool_search') expect(tool).toEqual(input.tools.find(candidate => candidate.name === tool.name));
  }
  const guide = projected.tools.find(tool => tool.name === 'tool_search')!.description;
  for (const name of DEFERRED_REPO_LSP_NAMES) {
    expect(guide).toContain(name);
    expect(getToolDefinition(name)).toBeDefined();
  }
  expect(guide).toContain('tool_call');
  expect(guide).toContain('select:NAME[,NAME...]');
  expect(projected.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['relationship_scan', 'code_search', 'repo_overview', 'read', 'edit', 'todo_update', 'ask_user_question']));
});

it('leaves child/specialist and auxiliary inputs unchanged', () => {
  const input = fullInput();
  expect(projectDeferredRepoLspInput(input, false)).toBe(input);
  const auxiliary = { ...input, tools: [getToolDefinition('get_goal')!] };
  expect(projectDeferredRepoLspInput(auxiliary, true)).toBe(auxiliary);
});

it('can test LSP-only deferral while all four detailed Repo contracts stay native', () => {
  const input = fullInput();
  const projected = projectDeferredRepoLspInput(input, true, 'lsp');
  expect(projected.tools).toHaveLength(input.tools.length - 8);
  expect(projected.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
    'module_context', 'symbol_context', 'process_context', 'impact_estimate',
  ]));
  expect(projected.system).toBe(input.system);
  expect(projected.messages).toBe(input.messages);
  expect(projectDeferredRepoLspInput(input, false, 'lsp')).toBe(input);
});

it('can test Repo-only deferral while all eight compiler contracts stay native', () => {
  const input = fullInput();
  const original = JSON.stringify(input);
  const projected = projectDeferredRepoLspInput(input, true, 'repo');
  expect(projected.tools).toHaveLength(input.tools.length - 4);
  expect(projected.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(
    DEFERRED_REPO_LSP_NAMES.filter(name => name.startsWith('lsp_'))));
  for (const name of ['module_context', 'symbol_context', 'process_context', 'impact_estimate']) {
    expect(projected.tools.some(tool => tool.name === name)).toBe(false);
    expect(getToolDefinition(name)).toBeDefined();
  }
  expect(JSON.stringify(input)).toBe(original);
  expect(projectDeferredRepoLspInput(input, false, 'repo')).toBe(input);
});

it.each(['lsp_references', 'kodax_manual'])('keeps same-name extension contracts native: %s', name => {
  const unregister = registerTool({ name, description: 'Independent extension references.',
    input_schema: { type: 'object', properties: { extension_target: { type: 'string' } }, required: ['extension_target'] },
    sideEffect: 'readonly', toClassifierInput: () => '', handler: async () => 'extension evidence',
  }, { source: { kind: 'extension', id: 'deferred-contract-test' } });
  try {
    const projected = projectDeferredRepoLspInput(fullInput(), true, name === 'kodax_manual' ? 'manual' : 'all');
    expect(projected.tools.find(tool => tool.name === name)).toMatchObject({ description: 'Independent extension references.' });
    expect(projected.tools.find(tool => tool.name === 'tool_search')!.description).not.toContain(name + ',');
  } finally { unregister(); }
});
