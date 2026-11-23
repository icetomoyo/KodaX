import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { KodaXSessionData } from '@kodax-ai/agent';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { createExtensionRuntime } from '../packages/coding/src/extensions/runtime.js';
import { runManagedTaskViaRunner } from '../packages/coding/src/task-engine/runner-driven.js';
import { SessionViewOwner, persistSessionViewItems, restoreSessionViewItems } from './session-view.js';
import { deriveInterruptedRunEvidence } from './runtime-interrupted-run-recovery.js';

function createViewOwner() {
  return new SessionViewOwner(async () => ({ session: { id: 'session', title: 'Tools' },
    settings: {}, queue: [], interactions: [], runs: [], items: [] }), async () => {});
}

async function readView(owner: SessionViewOwner): Promise<ClientSessionView> {
  const views: ClientSessionView[] = [];
  const observation = await owner.observe('session', view => views.push(view));
  observation.close();
  return views.at(-1)!;
}

it('keeps an extension tool\'s internal calls out of the view and reports its progress on the model-issued call', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-view-nested-'));
  const runtime = createExtensionRuntime();
  const extensionPath = path.join(directory, 'nested.mjs');
  await writeFile(extensionPath, `export default api => {
    api.registerTool({ name: 'nested_probe', description: 'probe', sideEffect: 'mutates-shell',
      input_schema: { type: 'object', properties: {} }, handler: async () => {
        const scope = api.getExecutionScope();
        scope.reportProgress({ message: 'probing' });
        const written = await scope.invokeTool('write', { path: 'nested.txt', content: 'inner' });
        const read = await scope.invokeTool('read', { path: 'nested.txt' });
        return JSON.stringify({ written: typeof written, read: typeof read });
      } });
  }`);
  const owner = createViewOwner();
  const events = owner.events('session', 'run');
  const started: string[] = [];
  const progress: string[] = [];
  let turn = 0;
  try {
    await runtime.loadExtension(extensionPath);
    await runManagedTaskViaRunner({ provider: 'anthropic', extensionRuntime: runtime,
      context: { executionCwd: directory, gitRoot: directory, managedTaskWorkspaceDir: directory, repoIntelligenceMode: 'off' },
      // The embedder approves: with no approval callback only reading tools run.
      events: { ...events, beforeToolExecute: async () => true,
        onToolUseStart: (tool, meta) => { started.push(tool.id); events.onToolUseStart?.(tool, meta); },
        onToolProgress: (update, meta) => { progress.push(update.id); events.onToolProgress?.(update, meta); } } },
    'Probe', async () => ++turn === 1
      ? { textBlocks: [], toolBlocks: [
        { type: 'tool_use', id: 'call_direct', name: 'nested_probe', input: {} },
        { type: 'tool_use', id: 'call_bridge', name: 'tool_call', input: { name: 'nested_probe', input: {} } },
      ] }
      : { textBlocks: [{ text: 'Finished.' }], toolBlocks: [] });
    expect(started.sort()).toEqual(['call_bridge', 'call_direct']);
    expect([...new Set(progress)].sort()).toEqual(['call_bridge', 'call_direct']);
    const tools = (await readView(owner)).items.filter(item => item.type === 'tool');
    expect(tools.map(item => [item.tool?.callId, item.tool?.status, item.tool?.resultRecorded]).sort())
      .toEqual([['call_bridge', 'success', true], ['call_direct', 'success', true]]);
    expect(persistSessionViewItems(tools).flatMap(item => item.type === 'tool_group' ? item.tools : [])
      .map(tool => tool.status)).toEqual(['success', 'success']);
  } finally {
    await owner.close(); await runtime.dispose();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

it('settles only the ending Run\'s unfinished tool items, in memory and on disk', async () => {
  const owner = createViewOwner();
  try {
    owner.events('session', 'other').onToolUseStart?.({ id: 'still-running', name: 'bash' });
    const events = owner.events('session', 'run');
    events.onToolUseStart?.({ id: 'done', name: 'read' });
    events.onToolResult?.({ id: 'done', name: 'read', content: 'ok' });
    events.onToolUseStart?.({ id: 'left', name: 'write' });
    owner.settleRun('session', 'run');
    const tools = (await readView(owner)).items.filter(item => item.type === 'tool');
    expect(Object.fromEntries(tools.map(item => [item.tool?.callId, item.tool?.status])))
      .toEqual({ 'still-running': 'running', done: 'success', left: 'cancelled' });
    expect(tools.find(item => item.tool?.callId === 'left')?.tool?.endedAt).toEqual(expect.any(Number));
    expect(persistSessionViewItems([{ id: 'approval', type: 'tool', text: '',
      tool: { callId: 'approval', name: 'bash', status: 'awaiting_approval' } }])[0])
      .toMatchObject({ tools: [{ status: 'cancelled' }] });
  } finally { await owner.close(); }
});

const orphanSession: KodaXSessionData = { title: 'Legacy', gitRoot: '', messages: [
  { role: 'user', content: 'render', inputId: 'input' },
  { role: 'assistant', outputId: 'output_1', content: [{ type: 'tool_use', id: 'call_parent', name: 'nested_probe', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_parent', content: 'rendered' }] },
], uiHistory: [{ type: 'tool_group', sourceRunId: 'run', afterInputId: 'input', tools: [
  { assistantOutputId: 'output_1', executionBegan: true, resultRecorded: true, id: 'call_parent', name: 'nested_probe', status: 'success', output: 'rendered' },
  { assistantOutputId: 'output_1', executionBegan: true, id: '02bc0a65-0498-45cb-8a40-6c2409445f8f', name: 'write', status: 'cancelled', output: '' },
  { assistantOutputId: 'output_unsaved', executionBegan: true, id: 'call_interrupted', name: 'bash', status: 'cancelled', output: '' },
] }] };

it('drops saved internal-call records that lineage proves were never model tool calls', () => {
  const tools = restoreSessionViewItems('session', orphanSession, orphanSession.messages)
    .filter(item => item.type === 'tool').map(item => item.tool?.callId);
  expect(tools).toEqual(['call_parent', 'call_interrupted']);
});

it('does not report saved internal-call records as interrupted operations', () => {
  const evidence = deriveInterruptedRunEvidence(orphanSession, { runId: 'run', sessionId: 'session',
    productInput: { inputId: 'input' }, terminal: { kind: 'interrupted', code: 'daemon_crashed' } });
  expect(evidence?.operations.map(operation => operation.toolUseId)).toEqual(['call_parent', 'call_interrupted']);
});
