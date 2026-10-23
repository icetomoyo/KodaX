import { expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { KodaXProviderError } from '@kodax-ai/llm';
import { buildRunnerAgentChain } from '../packages/coding/src/task-engine/runner-driven.js';
import { getToolDefinition, registerTool } from '../packages/coding/src/tools/index.js';
import { projectDeferredRepoLspInput, DEFERRED_REPO_LSP_NAMES, resolveDeferredEvidenceRoot, isAuxiliaryLocalPreflight } from './deferred-repo-lsp-support.js';
import type { FrozenInput } from './first-turn-eval-support.js';

function fullInput(): FrozenInput {
  const worker = buildRunnerAgentChain({ backups: new Map(), executionCwd: process.cwd() }).worker;
  return { system: 'Unchanged AMA instructions.', messages: [{ role: 'user', content: 'Review this repository.' }],
    tools: (worker.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })) };
}

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

it('keeps same-name extension contracts native', () => {
  const unregister = registerTool({ name: 'lsp_references', description: 'Independent extension references.',
    input_schema: { type: 'object', properties: { extension_target: { type: 'string' } }, required: ['extension_target'] },
    sideEffect: 'readonly', handler: async () => 'extension evidence',
  }, { source: { kind: 'extension', id: 'deferred-contract-test' } });
  try {
    const projected = projectDeferredRepoLspInput(fullInput(), true);
    expect(projected.tools.find(tool => tool.name === 'lsp_references')).toMatchObject({ description: 'Independent extension references.' });
    expect(projected.tools.find(tool => tool.name === 'tool_search')!.description).not.toContain('lsp_references,');
  } finally { unregister(); }
});
