import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { KodaXEvents } from '@kodax-ai/coding';
import type { KodaXToolUseBlock } from '@kodax-ai/llm';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { runManagedTaskViaRunner } from '../packages/coding/src/task-engine/runner-driven.js';
import { applyPostToolProcessing, runToolDispatch } from '../packages/coding/src/agent-runtime/tool-dispatch.js';
import { buildRuntimeSessionState } from '../packages/coding/src/agent-runtime/runtime-session-state.js';
import { checkPreToolAbort } from '../packages/coding/src/agent-runtime/tool-cancellation.js';
import { SessionViewOwner, restoreSessionViewItems } from './session-view.js';

function createViewOwner() {
  return new SessionViewOwner(async () => ({ session: { id: 'session', title: 'Tools' },
    settings: {}, queue: [], interactions: [], runs: [], items: [] }), async () => {});
}

it('reads the saved full MCP result through SDK item paging, live and after history restoration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-view-full-result-'));
  const content = JSON.stringify({ payload: '中😀'.repeat(30_000), tail: 'MCP_TAIL_EVIDENCE' });
  const outputPath = path.join(directory, 'original.txt');
  await writeFile(outputPath, content);
  const toolResult = { type: 'tool_result' as const, tool_use_id: 'mcp-result',
    content: '[KODAX_RESULT_INCOMPLETE. Full output saved to the original artifact.]',
    metadata: { truncated: true, outputPath } };
  const owner = createViewOwner();
  const restored = new SessionViewOwner(async () => ({ session: { id: 'session', title: 'Tools' },
    settings: {}, queue: [], interactions: [], runs: [], items: restoreSessionViewItems('session', {
      title: 'Tools', gitRoot: '', messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'mcp-result', name: 'mcp_call', input: { id: 'remote' } }] },
        { role: 'user', content: [toolResult] },
      ],
    }) }), async () => undefined);
  try {
    const events = owner.events('session', 'run');
    events.onToolUseStart?.({ id: 'mcp-result', name: 'mcp_call', input: { id: 'remote' } });
    events.onToolResult?.({ id: 'mcp-result', name: 'mcp_call', content: toolResult.content, toolResult });
    for (const [reader, id] of [[owner, 'run:tool:mcp-result'], [restored, 'tool:mcp-result']] as const) {
      expect(await reader.readItem('session', id)).toMatchObject({ text: toolResult.content, totalLength: toolResult.content.length });
      const first = await reader.readItem('session', id, { part: 'original' });
      expect(first?.totalLength).toBe(content.length);
      expect(first?.text).toBe(content.slice(0, 65_536));
      expect(first?.nextOffset).toBe(65_536);
      const last = await reader.readItem('session', id, { offset: first!.nextOffset, part: 'original' });
      expect(first!.text + last!.text).toBe(content);
      expect(last?.nextOffset).toBeUndefined();
      expect(await reader.readItem('session', id, { part: 'input' })).toMatchObject({ text: '{"id":"remote"}' });
    }
    await rm(outputPath);
    await expect(owner.readItem('session', 'run:tool:mcp-result', { part: 'original' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await owner.readItem('session', 'run:tool:mcp-result')).toMatchObject({ text: toolResult.content });
  } finally {
    await owner.close(); await restored.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps request-only input capabilities out of persisted tool-original file reads', async () => {
  const owner = createViewOwner();
  try {
    owner.events('session', 'run').onToolResult?.({ id: 'page', name: 'read', content: 'One original input page',
      toolResult: { type: 'tool_result', tool_use_id: 'page', content: 'One original input page',
        metadata: { truncated: true, outputPath: 'kodax-transient://text/request-only' } } });
    expect(await owner.readItem('session', 'run:tool:page')).toMatchObject({ text: 'One original input page' });
  } finally { await owner.close(); }
});

it('keeps an actual pre-dispatch cancellation consistent between the Host event and resumed history', async () => {
  const owner = createViewOwner();
  const events = owner.events('session', 'run');
  const toolBlocks: KodaXToolUseBlock[] = [{ type: 'tool_use', id: 'cancelled', name: 'read', input: {} }];
  let received: Parameters<NonNullable<KodaXEvents['onToolResult']>>[0] | undefined;
  try {
    const results = await checkPreToolAbort({ toolBlocks, abortSignal: AbortSignal.abort(),
      events: { ...events, onToolResult: (result, meta) => { received = result; events.onToolResult?.(result, meta); } },
      emitActiveExtensionEvent: async () => undefined });
    expect(received?.toolResult?.metadata?.cancelled).toBe(true);
    const views: ClientSessionView[] = [];
    const observation = await owner.observe('session', view => views.push(view));
    expect(views.at(-1)?.items[0]?.tool?.status).toBe('cancelled');
    expect(restoreSessionViewItems('session', { title: 'Tools', gitRoot: '', messages: [
      { role: 'assistant', content: toolBlocks }, { role: 'user', content: results ?? [] },
    ] })[0]?.tool?.status).toBe('cancelled');
    observation.close();
  } finally { await owner.close(); }
});

it('delivers real SA image results without flattening the event and projects success in the Host', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-view-image-'));
  const imagePath = path.join(directory, 'pixel.png');
  await writeFile(imagePath, await readFile('tests/fixtures/images/valid-png.png'));
  const owner = createViewOwner();
  const hostEvents = owner.events('session', 'run');
  const received: Parameters<NonNullable<KodaXEvents['onToolResult']>>[0][] = [];
  const events: KodaXEvents = { ...hostEvents,
    onToolResult: (result, meta) => { received.push(result); hostEvents.onToolResult?.(result, meta); } };
  const toolBlocks: KodaXToolUseBlock[] = [{ type: 'tool_use', id: 'image', name: 'read', input: { path: imagePath } }];
  const ctx = { executionCwd: directory, backups: new Map<string, string>() };
  const runtimeSessionState = buildRuntimeSessionState({ activeTools: ['read'], modelSelection: {} });
  try {
    const resultMap = await runToolDispatch({ toolBlocks, events, ctx, runtimeSessionState, activeToolNames: ['read'], abortSignal: undefined });
    const processed = await applyPostToolProcessing({ toolBlocks, resultMap, events, ctx, runtimeSessionState,
      emitActiveExtensionEvent: async () => undefined });
    expect(received[0]?.toolResult).toEqual(processed.toolResults[0]);
    expect(processed.toolResults[0]?.is_error).toBe(false);
    expect(received[0]?.toolResult?.content).toContainEqual({ type: 'image', path: imagePath, mediaType: 'image/png' });
    const views: ClientSessionView[] = [];
    const observation = await owner.observe('session', view => views.push(view));
    expect(views.at(-1)?.items[0]?.tool?.status).toBe('success');
    expect(views.at(-1)?.items[0]?.text).not.toContain('[object Object]');
    observation.close();
  } finally { await owner.close(); await rm(directory, { recursive: true, force: true }); }
});

it('delivers managed runner failure facts with ordinary error text to the Host view', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-view-result-'));
  const owner = createViewOwner();
  const events = owner.events('session', 'run');
  const received: Parameters<NonNullable<KodaXEvents['onToolResult']>>[0][] = [];
  let turn = 0;
  try {
    await runManagedTaskViaRunner({ provider: 'anthropic', context: { executionCwd: directory,
      gitRoot: directory, managedTaskWorkspaceDir: directory, repoIntelligenceMode: 'off' },
    events: { ...events, beforeToolExecute: async () => 'Permission denied',
      onToolResult: (result, meta) => { received.push(result); events.onToolResult?.(result, meta); } } },
    'Call the tool', async () => ++turn === 1
      ? { textBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'missing', name: 'read', input: { path: 'missing.txt' } }] }
      : { textBlocks: [{ text: 'Finished.' }], toolBlocks: [] });
    expect(received[0]?.toolResult).toMatchObject({ is_error: true });
    expect(received[0]?.content).toBe('Permission denied');
    const views: ClientSessionView[] = [];
    const observation = await owner.observe('session', view => views.push(view));
    expect(views.at(-1)?.items.find(item => item.type === 'tool')?.tool?.status).toBe('error');
    observation.close();
  } finally { await owner.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

it('persists explicit managed success even when the successful output mentions error', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-view-success-'));
  await writeFile(path.join(directory, 'result.txt'), '[Error] is a literal example; no error occurred.');
  const owner = createViewOwner();
  let turn = 0;
  try {
    const result = await runManagedTaskViaRunner({ provider: 'anthropic', context: { executionCwd: directory,
      gitRoot: directory, managedTaskWorkspaceDir: directory, repoIntelligenceMode: 'off' },
    events: owner.events('session', 'run') }, 'Read result.txt', async () => ++turn === 1
      ? { textBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'success', name: 'read', input: { path: 'result.txt' } }] }
      : { textBlocks: [{ text: 'Finished.' }], toolBlocks: [] });
    const toolResult = result.messages.flatMap(message => typeof message.content === 'string' ? [] : message.content)
      .find(block => block.type === 'tool_result');
    expect(toolResult).toMatchObject({ is_error: false });
    const views: ClientSessionView[] = [];
    const observation = await owner.observe('session', view => views.push(view));
    expect(views.at(-1)?.items.find(item => item.type === 'tool')).toMatchObject({ text: expect.stringContaining('error'), tool: { status: 'success' } });
    expect(restoreSessionViewItems('session', { title: 'Tools', gitRoot: '', messages: result.messages })
      .find(item => item.type === 'tool')?.tool?.status).toBe('success');
    observation.close();
  } finally { await owner.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

it('preserves managed cancellation through the same event and canonical history as SA', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-view-cancel-'));
  const owner = createViewOwner();
  let turn = 0;
  try {
    const events = owner.events('session', 'run');
    const result = await runManagedTaskViaRunner({ provider: 'anthropic', context: { executionCwd: directory,
      gitRoot: directory, managedTaskWorkspaceDir: directory, repoIntelligenceMode: 'off' },
    events: { ...events, beforeToolExecute: async () => '[Cancelled] Operation cancelled by user' } },
    'Read a file', async () => ++turn === 1
      ? { textBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'cancelled', name: 'read', input: { path: 'missing.txt' } }] }
      : { textBlocks: [{ text: 'Stopped.' }], toolBlocks: [] });
    expect(result.messages.flatMap(message => typeof message.content === 'string' ? [] : message.content)
      .find(block => block.type === 'tool_result')).toMatchObject({ content: '[Cancelled] Operation cancelled by user', metadata: { cancelled: true } });
    const views: ClientSessionView[] = [];
    const observation = await owner.observe('session', view => views.push(view));
    expect(views.at(-1)?.items.find(item => item.type === 'tool')?.tool?.status).toBe('cancelled');
    expect(restoreSessionViewItems('session', { title: 'Tools', gitRoot: '', messages: result.messages })
      .find(item => item.type === 'tool')?.tool?.status).toBe('cancelled');
    observation.close();
  } finally { await owner.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
