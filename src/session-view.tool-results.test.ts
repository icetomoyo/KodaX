import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64'));
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
