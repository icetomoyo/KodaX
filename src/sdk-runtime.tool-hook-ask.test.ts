import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createExtensionRuntime, registerTool, type KodaXEvents, type ToolSideEffect } from '@kodax-ai/coding';
import {
  clearRuntimeModelProviders, KodaXBaseProvider, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';
import { listClientInteractions, toRuntimePermissionRequest } from './client-interactions.js';

// FEATURE_304 / ADR-071: an extension `tool:before` ask reaches a person through the Host.
const REASON = 'Extension "guard": Deletes build output.';
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
});

async function setup({ permissionTimeoutMs = 10_000, sideEffect = 'mutates-state' }: {
  permissionTimeoutMs?: number; sideEffect?: ToolSideEffect;
} = {}) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-tool-hook-ask-'));
  cleanups.push(() => rm(homeDir, { recursive: true, force: true }));
  const deleted: string[] = [];
  cleanups.push(registerTool({ name: 'ask_fixture', description: 'Controlled local deletion.', sideEffect,
    input_schema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    toClassifierInput: input => JSON.stringify(input),
    handler: async (input) => { deleted.push(String(input.target)); return 'deleted'; } }));
  vi.stubEnv('KODAX_ASK_FIXTURE', 'offline');
  let callNumber = 0;
  class Provider extends KodaXBaseProvider {
    readonly name = 'ask-fixture'; readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_ASK_FIXTURE', model: 'fixture', supportsThinking: false };
    async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
      const last = messages.at(-1)?.content;
      const answered = Array.isArray(last) && last.some(block => block.type === 'tool_result');
      if (!answered) return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
        toolBlocks: [{ type: 'tool_use', id: `call-ask-${++callNumber}`, name: 'ask_fixture', input: { target: 'build' } }] };
      return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('ask-fixture', () => new Provider());
  const extension = createExtensionRuntime();
  extension.registerHook('tool:before', ({ name }) => name === 'ask_fixture'
    ? { decision: 'ask', reason: 'Deletes build output.' } : undefined, { source: { kind: 'runtime', id: 'guard', label: 'guard' } });
  cleanups.push(() => extension.dispose());
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, permissionTimeoutMs,
    defaultProvider: 'ask-fixture', defaultModel: 'fixture' });
  cleanups.push(() => runtime.close());
  const session = await runtime.sessions.create({ projectPath: homeDir });
  const start = async (events?: KodaXEvents) => (await runtime.runs.start({ sessionId: session.id, prompt: 'Clean the build.',
    options: { extensionRuntime: extension, ...(events ? { events } : {}) } })).runId;
  const pendingFor = (runId: string) => vi.waitFor(async () => {
    const pending = await runtime.permissions.listPending({ runId });
    if (pending.length === 0) throw new Error('No permission request yet.');
    return pending;
  }, { timeout: 10_000, interval: 20 });
  return { runtime, session, deleted, start, pendingFor, extension };
}

it('advertises the toolHookAsk capability', async () => {
  const { runtime } = await setup();
  expect(runtime.capabilities).toMatchObject({ toolHookAsk: { version: 1 } });
});

it('preserves each extension ask through the client Interaction and permission adapter', async () => {
  const { runtime, session, start, pendingFor, extension } = await setup();
  extension.registerHook('tool:before', () => ({ decision: 'ask', reason: 'Requires a billing check.' }),
    { source: { kind: 'runtime', id: 'billing', label: 'Billing policy' } });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', workMode: 'coding', permissionMode: 'full-access' });
  const runId = await start();
  const [request] = await pendingFor(runId);
  const [interaction] = await listClientInteractions({ userInputs: runtime.userInputs, permissions: runtime.permissions }, { sessionId: session.id });
  expect(interaction?.kind).toBe('permission');
  if (interaction?.kind !== 'permission') throw new Error('Expected permission Interaction.');
  const extensionAsks = [{ extension: 'guard', reason: 'Deletes build output.' },
    { extension: 'Billing policy', reason: 'Requires a billing check.' }];
  expect(interaction.options).toMatchObject({ extensionAsks });
  expect(toRuntimePermissionRequest(interaction)).toMatchObject({ extensionAsks });
  expect(interaction.options.grantSuggestions).toBeUndefined();
  await runtime.permissions.respond(request!.id, { type: 'allow_once' });
  expect((await runtime.runs.await(runId)).phase).toBe('completed');
}, 30_000);

it('asks a person in Full Access with the reason, and the answer cannot become a grant', async () => {
  const { runtime, session, deleted, start, pendingFor } = await setup();
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', workMode: 'coding', permissionMode: 'full-access' });
  const runId = await start();
  const [request, ...others] = await pendingFor(runId);
  expect(others).toEqual([]);
  expect(request).toMatchObject({ toolName: 'ask_fixture', reason: REASON });
  expect(request!.grantSuggestions).toBeUndefined();
  expect(deleted).toEqual([]);
  await expect(runtime.permissions.respond(request!.id, { type: 'allow_always', suggestionId: 'scope_forged' }))
    .rejects.toThrow(/grant suggestion/i);
  expect(await runtime.permissions.respond(request!.id, { type: 'allow_once' })).toBe(true);
  expect((await runtime.runs.await(runId)).phase).toBe('completed');
  expect(deleted).toEqual(['build']);
  await expect(runtime.permissions.listGrants()).resolves.toMatchObject({ value: [] });
}, 30_000);

// A read-only tool passes admission in every mode, so only the extension asks.
it.each(['plan', 'accept-edits', 'auto', 'full-access'] as const)('asks a person in %s mode', async (permissionMode) => {
  const { runtime, session, deleted, start, pendingFor } = await setup({ sideEffect: 'readonly' });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', workMode: 'coding', permissionMode });
  const runId = await start();
  const [request, ...others] = await pendingFor(runId);
  expect(others).toEqual([]);
  expect(request).toMatchObject({ toolName: 'ask_fixture', reason: REASON });
  expect(deleted).toEqual([]);
  await runtime.permissions.respond(request!.id, { type: 'allow_once' });
  expect((await runtime.runs.await(runId)).phase).toBe('completed');
  expect(deleted).toEqual(['build']);
}, 30_000);

it('blocks the call when the person rejects it', async () => {
  const { runtime, session, deleted, start, pendingFor } = await setup();
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', workMode: 'coding', permissionMode: 'full-access' });
  const runId = await start();
  const [request] = await pendingFor(runId);
  await runtime.permissions.respond(request!.id, { type: 'reject', reason: 'Not now.' });
  expect((await runtime.runs.await(runId)).phase).toBe('completed');
  expect(deleted).toEqual([]);
}, 30_000);

it('asks once when the Host already asked, and a saved grant does not skip the ask', async () => {
  // A second, unanswered request would time out and block the call.
  const { runtime, session, deleted, start, pendingFor } = await setup({ permissionTimeoutMs: 3_000 });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', workMode: 'coding' });
  const first = await start();
  const [hostRequest, ...others] = await pendingFor(first);
  expect(others).toEqual([]);
  expect(hostRequest!.reason).toBeUndefined();
  const sessionGrant = hostRequest!.grantSuggestions?.find(suggestion => suggestion.kind === 'session');
  if (!sessionGrant) throw new Error('Expected a Runtime-issued session suggestion.');
  await runtime.permissions.respond(hostRequest!.id, { type: 'allow_session', suggestionId: sessionGrant.id });
  expect((await runtime.runs.await(first)).phase).toBe('completed');
  expect(deleted).toEqual(['build']);

  const second = await start();
  const [extensionRequest] = await pendingFor(second);
  expect(extensionRequest).toMatchObject({ toolName: 'ask_fixture', reason: REASON });
  await runtime.permissions.respond(extensionRequest!.id, { type: 'allow_once' });
  expect((await runtime.runs.await(second)).phase).toBe('completed');
  expect(deleted).toEqual(['build', 'build']);
}, 30_000);

it('lets an embedder answer the ask itself, and blocks when its events cannot ask', async () => {
  const { runtime, session, deleted, start } = await setup();
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', workMode: 'coding' });
  const requestToolApproval = vi.fn(async () => true);
  const answered = await start({ beforeToolExecute: async () => true, requestToolApproval });
  expect((await runtime.runs.await(answered)).phase).toBe('completed');
  expect(requestToolApproval).toHaveBeenCalledWith('ask_fixture', { target: 'build' }, REASON, expect.anything());
  expect(deleted).toEqual(['build']);

  const unanswerable = await start({ beforeToolExecute: async () => true });
  expect((await runtime.runs.await(unanswerable)).phase).toBe('completed');
  expect(await runtime.permissions.listPending({ runId: unanswerable })).toEqual([]);
  expect(deleted).toEqual(['build']);
}, 30_000);
