import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Runner } from '@kodax-ai/agent';
import { buildRunnerAgentChain } from '../packages/coding/src/task-engine/runner-driven.js';
import { getToolExecutionOverride } from '../packages/coding/src/agent-runtime/permission-gate.js';
import { LspService } from '../packages/coding/src/lsp/service.js';
import { getModuleContext } from '../packages/coding/src/repo-intelligence/runtime.js';
import type { KodaXEvents, KodaXToolExecutionContext } from '../packages/coding/src/types.js';
import type { ManagedTaskBudgetController } from '../packages/coding/src/task-engine/_internal/managed-task/budget.js';
import { DEFERRED_REPO_LSP_NAMES, projectDeferredRepoLspInput } from './deferred-repo-lsp-support.js';

async function fixture() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-deferred-repo-lsp-'));
  await fs.writeFile(path.join(workspace, 'package.json'), '{"name":"fixture-module","type":"module"}');
  await fs.writeFile(path.join(workspace, 'index.ts'), 'export const x = 1;\nexport function readX() { return x; }\nreadX();\n');
  await fs.writeFile(path.join(workspace, 'README.md'), 'Fixture module documentation.');
  const lsp = new LspService({ servers: [{ id: 'offline-wire-fixture', languageIds: ['typescript'],
    rootMarkers: ['package.json'], installGuidance: 'Test fixture needs no install.',
    discover: () => ({ command: process.execPath, args: [fileURLToPath(new URL('../packages/coding/src/lsp/fake-lsp-server.fixture.mjs', import.meta.url))] }),
  }] });
  const context: KodaXToolExecutionContext = { backups: new Map(), executionCwd: workspace,
    gitRoot: workspace, repoIntelligenceMode: 'full', lspService: lsp };
  return { workspace, context, close: async () => {
    await lsp.shutdownAll();
    if (path.dirname(workspace) !== path.resolve(os.tmpdir()) || !path.basename(workspace).startsWith('kodax-deferred-repo-lsp-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  } };
}

it('keeps all twelve real handlers and native/bridge outputs and work charges equivalent', async () => {
  const { context, close } = await fixture();
  const args: Record<string, Record<string, unknown>> = {
    module_context: { target_path: 'index.ts' }, symbol_context: { symbol: 'readX', target_path: 'index.ts' },
    process_context: { entry: 'readX', target_path: 'index.ts' }, impact_estimate: { symbol: 'x', target_path: 'index.ts' },
    lsp_workspace_symbols: { query: 'x' }, lsp_document_symbols: { path: 'index.ts' },
  };
  const budget: ManagedTaskBudgetController = { totalBudget: 100, spentBudget: 0 };
  const agent = buildRunnerAgentChain(context, undefined, budget).worker;
  const expected: Readonly<Record<string, readonly string[]>> = {
    module_context: ['Module context for', 'Docs: README.md', 'Top symbols: readX'],
    symbol_context: ['Symbol context for readX', 'Signature:', 'Definition: index.ts:2'],
    process_context: ['Process context for', 'Entry: index.ts', 'Steps:'],
    impact_estimate: ['Impact estimate for x', 'Possible callers:', 'Changed-scope overlap:'],
    lsp_definition: ['index.ts:1:1'], lsp_references: ['index.ts:1:1', 'index.ts:3:1'],
    lsp_hover: ['const x: number'], lsp_document_symbols: ['Variable x (1)'],
    lsp_incoming_calls: ['Function entry', 'calls at 1:1'], lsp_outgoing_calls: ['Function save', 'called at 1:1'],
    lsp_implementation: ['No implementation found at that position.'],
    lsp_workspace_symbols: ['No workspace symbols found for that query.'],
  };
  try {
    const warmed = await getModuleContext(context, { targetPath: 'index.ts', maxWaitMs: 15_000 });
    expect(warmed.module.sourceFileCount).toBe(1);
    const lookup = await agent.tools!.find(tool => tool.name === 'tool_search')!.execute({ query: `select:${DEFERRED_REPO_LSP_NAMES.join(',')}` }, { agent });
    expect(String(lookup.content).match(/<function>/g)).toHaveLength(12);
    expect(budget.spentBudget).toBe(1);
    for (const name of DEFERRED_REPO_LSP_NAMES) {
      const input = args[name] ?? { path: 'index.ts', line: 1, character: 14 };
      const original = structuredClone(input);
      const native = await agent.tools!.find(tool => tool.name === name)!.execute(input, { agent, toolCallId: `native-${name}` });
      const bridged = await agent.tools!.find(tool => tool.name === 'tool_call')!.execute({ name, input }, { agent, toolCallId: `bridge-${name}` });
      expect(bridged.content, name).toEqual(native.content);
      expect(bridged.isError === true, name).toBe(native.isError === true);
      expect(String(native.content), name).not.toContain('[Tool Error]');
      for (const evidence of expected[name]!) expect(String(native.content), name).toContain(evidence);
      expect(input).toEqual(original);
    }
    expect(budget.spentBudget).toBe(25);
  } finally { await close(); }
}, 60_000);

it.each(['all', 'lsp'] as const)('recovers from an actual target permission refusal with %s schemas deferred', async family => {
  const { context, close } = await fixture();
  const budget: ManagedTaskBudgetController = { totalBudget: 100, spentBudget: 0 };
  const seen: Array<{ name: string; input: Record<string, unknown> }> = [];
  const events: KodaXEvents = { beforeToolExecute: async (name, input) => {
    seen.push({ name, input: structuredClone(input) });
    return name === 'lsp_references' && input.path === '../outside.ts' ? '[Tool Error] Path leaves the fixture workspace.' : true;
  } };
  const base = buildRunnerAgentChain(context, undefined, budget, undefined, undefined, events).worker;
  const view = projectDeferredRepoLspInput({ system: '', messages: [], tools: base.tools! }, true, family);
  const agent = { ...base, tools: base.tools!.filter(tool => view.tools.some(visible => visible.name === tool.name))
    .map(tool => ({ ...tool, description: view.tools.find(visible => visible.name === tool.name)!.description })) };
  let round = 0;
  try {
    const result = await Runner.run(agent, 'Find references, recover from a refused path, and report only observed evidence.', {
      tracer: null,
      toolObserver: { beforeTool: async call => (await getToolExecutionOverride(events, call.name, call.input, call.id)) ?? true },
      llm: async messages => {
        expect(agent.tools.map(tool => tool.name)).not.toContain('lsp_references');
        if (round === 1) {
          expect(JSON.stringify(messages.at(-1))).toContain('lsp_references');
          expect(JSON.stringify(messages.at(-1))).toContain('parameters');
        }
        if (round === 2) {
          expect(JSON.stringify(messages)).toContain('Path leaves the fixture workspace');
          expect(budget.spentBudget).toBe(1);
        }
        if (round === 3) expect(JSON.stringify(messages)).toContain('index.ts:3:1');
        const call = [
          { name: 'tool_search', input: { query: '+lsp references', max_results: 1 } },
          { name: 'tool_call', input: { name: 'lsp_references', input: { path: '../outside.ts', line: 1 } } },
          { name: 'tool_call', input: { name: 'lsp_references', input: { path: 'index.ts', line: 1 } } },
        ][round++];
        return call ? { text: '', toolCalls: [{ id: `step-${round}`, ...call }] } : { text: 'The refused path was not executed; references were returned at index.ts:1:1 and index.ts:3:1.' };
      },
    });
    expect(result.output).toContain('index.ts:3:1');
    expect(round).toBe(4);
    expect(budget.spentBudget).toBe(2);
    expect(seen.filter(call => call.name === 'lsp_references').map(call => call.input.path)).toEqual(['../outside.ts', 'index.ts']);
  } finally { await close(); }
}, 60_000);
