import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult, type KodaXToolUseBlock,
} from '@kodax-ai/llm';
import type { ClientInteraction, ClientSessionView } from '@kodax-ai/coding/client-contract';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

/** First scripted Provider turn raises one tool call; later turns answer in plain text. */
class PermissionsProvider extends KodaXBaseProvider {
  readonly name = 'product-permissions-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_PERMISSIONS_TEST_KEY', model: 'product-permissions-test', supportsThinking: false,
  };
  constructor(private readonly script: () => KodaXToolUseBlock[]) { super(); }
  async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    requests.push(structuredClone(messages));
    // One tool call per run: emit it until its own tool_result comes back.
    const callId = this.script()[0]?.id;
    const settled = messages.some((message) => Array.isArray(message.content)
      && message.content.some((block) => block.type === 'tool_result' && block.tool_use_id === callId));
    return settled
      ? { textBlocks: [{ type: 'text', text: 'Follow-up complete.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' }
      : { textBlocks: [], thinkingBlocks: [], toolBlocks: this.script(), stopReason: 'tool_use' };
  }
}

let homeDir: string;
let scriptedToolCall: () => KodaXToolUseBlock[] = () => [];
let requests: KodaXMessage[][] = [];
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let first: Awaited<ReturnType<typeof connectKodaXClient>>;
let second: Awaited<ReturnType<typeof connectKodaXClient>>;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-permissions-'));
  requests = [];
  scriptedToolCall = () => [];
  registerModelProvider('product-permissions-test', () => new PermissionsProvider(() => scriptedToolCall()));
  vi.stubEnv('KODAX_PRODUCT_PERMISSIONS_TEST_KEY', 'test-only');
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-permissions-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated permissions Host.');
  const endpointPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\kodax-permissions-' + randomUUID()
    : path.join(homeDir, 'host.sock');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: endpointPath }
    : { kind: 'unix' as const, path: endpointPath };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  first = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  second = await connectKodaXClient({ homeDir, endpoint: endpointPath });
});

afterEach(async () => {
  await Promise.allSettled([first?.disconnect(), second?.disconnect()]);
  await host?.close();
  await runtime?.close();
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 30_000);

/** A write into the project's .kodax/ directory is an always-confirm path. */
function writeMarkerCall(id: string, marker: string, content: string): KodaXToolUseBlock {
  return {
    type: 'tool_use',
    id,
    name: 'write',
    input: { path: path.join(homeDir, '.kodax', marker), content },
  };
}

function pendingPermission(views: readonly ClientSessionView[]): ClientInteraction | undefined {
  for (const view of views) {
    const found = view.interactions.find((item) => item.kind === 'permission');
    if (found) return found;
  }
  return undefined;
}

function sessionSuggestion(permission: ClientInteraction): { readonly id: string } {
  if (permission.kind !== 'permission') throw new Error(`Expected permission, got ${permission.kind}`);
  const suggestion = permission.options.grantSuggestions?.find((item) => item.kind === 'session');
  if (suggestion === undefined) throw new Error('Expected a session grant suggestion on the permission request.');
  return { id: suggestion.id };
}

async function submitAndView(sessionId: string, inputId: string): Promise<{
  readonly runId: string;
  readonly views: ClientSessionView[];
  readonly close: () => void;
}> {
  const views: ClientSessionView[] = [];
  const observation = await second.sessions.observe(sessionId, (view) => views.push(view));
  const accepted = await first.inputs.submit({ sessionId, inputId, text: 'Write the marker file.' });
  await expect.poll(() => pendingPermission(views), { timeout: 15_000 }).toBeTruthy();
  const permission = pendingPermission(views)!;
  if (permission.kind !== 'permission') throw new Error(`Expected permission, got ${permission.kind}`);
  // The request binds the exact action: tool identity and input preview.
  expect(permission.options.toolName).toBe('write');
  expect(permission.options.inputPreview).toContain('marker.txt');
  return { runId: accepted.runId!, views, close: () => observation.close() };
}

it('reject and cancel decide this execution once and late answers never restart it', async () => {
  // Rejection blocks exactly this action with its reason.
  scriptedToolCall = () => [writeMarkerCall('call-reject-1', 'reject-marker.txt', 'rejected')];
  const rejectSession = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(rejectSession.id, { agentMode: 'sa', permissionMode: 'accept-edits' });
  let context = await submitAndView(rejectSession.id, 'reject-run');
  try {
    const rejected = await first.interactions.respond(pendingPermission(context.views)!.requestId, {
      kind: 'permission', decision: { type: 'reject', reason: 'Not on this machine.' },
    });
    expect(rejected).toMatchObject({ accepted: true, status: 'answered' });
    await runtime.runs.await(context.runId);
    await expect(readFile(path.join(homeDir, '.kodax', 'reject-marker.txt'))).rejects.toThrow();
    await expect.poll(() => context.views.at(-1)!.interactions.length, { timeout: 15_000 }).toBe(0);
  } finally { context.close(); }

  // Cancellation dismisses the request; a late answer cannot restart the action.
  scriptedToolCall = () => [writeMarkerCall('call-cancel-1', 'cancel-marker.txt', 'cancelled')];
  const cancelSession = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(cancelSession.id, { agentMode: 'sa', permissionMode: 'accept-edits' });
  context = await submitAndView(cancelSession.id, 'cancel-run');
  try {
    const cancelTarget = pendingPermission(context.views)!;
    const cancelled = await second.interactions.respond(cancelTarget.requestId, { kind: 'cancel' });
    expect(cancelled).toMatchObject({ accepted: true, status: 'dismissed' });
    await runtime.runs.await(context.runId);
    await expect(readFile(path.join(homeDir, '.kodax', 'cancel-marker.txt'))).rejects.toThrow();
    const afterCancel = requests.length;
    expect(await first.interactions.respond(cancelTarget.requestId, {
      kind: 'permission', decision: { type: 'allow_once' },
    })).toMatchObject({ accepted: false, status: 'already_resolved' });
    expect(requests.length).toBe(afterCancel);
  } finally { context.close(); }
}, 90_000);

it('stopping the run during a pending permission invalidates it without restarting work', async () => {
  scriptedToolCall = () => [writeMarkerCall('call-stop-1', 'stop-marker.txt', 'stopped')];
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'accept-edits' });
  const context = await submitAndView(session.id, 'stop-run');
  try {
    const target = pendingPermission(context.views)!;
    await first.runs.stop(context.runId);
    await runtime.runs.await(context.runId);
    await expect(readFile(path.join(homeDir, '.kodax', 'stop-marker.txt'))).rejects.toThrow();
    const afterStop = requests.length;
    expect(await second.interactions.respond(target.requestId, {
      kind: 'permission', decision: { type: 'allow_once' },
    })).toMatchObject({ accepted: false, status: 'already_resolved' });
    expect(requests.length).toBe(afterStop);
  } finally { context.close(); }
}, 90_000);

it('keeps allowed work out of the reviewer and revokes grants by their own identity', async () => {
  scriptedToolCall = () => [writeMarkerCall('call-grant-1', 'grant-marker.txt', 'granted once')];
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'accept-edits' });
  let context = await submitAndView(session.id, 'grant-run');
  let marker: string;
  try {
    const permission = pendingPermission(context.views)!;
    const suggestion = sessionSuggestion(permission);
    const granted = await first.interactions.respond(permission.requestId, {
      kind: 'permission', decision: { type: 'allow_session', suggestionId: suggestion.id },
    });
    expect(granted).toMatchObject({ accepted: true, status: 'answered' });
    await runtime.runs.await(context.runId);
    marker = await readFile(path.join(homeDir, '.kodax', 'grant-marker.txt'), 'utf8');
    expect(marker.trim()).toBe('granted once');

    // The explicit grant is queryable by both clients under its domain identity.
    const listed = await first.permissions.listGrants();
    expect(listed.grants.length).toBe(1);
    expect(listed.grants[0]!.id).toBeTruthy();
    expect((await second.permissions.listGrants()).grants.map((item) => item.id))
      .toEqual(listed.grants.map((item) => item.id));

    // The identical call is already allowed: no second permission request.
    scriptedToolCall = () => [writeMarkerCall('call-grant-2', 'grant-marker.txt', 'granted twice')];
    const secondViews: ClientSessionView[] = [];
    const secondObservation = await second.sessions.observe(session.id, (view) => secondViews.push(view));
    try {
      const rerun = await first.inputs.submit({ sessionId: session.id, inputId: 'grant-rerun', text: 'Write the marker file again.' });
      await runtime.runs.await(rerun.runId!);
      expect(secondViews.flatMap((view) => view.interactions).some((item) => item.kind === 'permission')).toBe(false);
      expect((await readFile(path.join(homeDir, '.kodax', 'grant-marker.txt'), 'utf8')).trim()).toBe('granted twice');
    } finally { secondObservation.close(); }

    // Precise revocation by grant identity makes the next call ask again.
    expect(await second.permissions.revokeGrant(listed.grants[0]!.id, listed.revision)).toBe(true);
    const afterRevoke = await first.permissions.listGrants();
    expect(afterRevoke.grants).toHaveLength(0);

    scriptedToolCall = () => [writeMarkerCall('call-grant-3', 'grant-marker.txt', 'granted thrice')];
    context = await submitAndView(session.id, 'grant-again');
    try {
      expect(pendingPermission(context.views)).toBeTruthy();
      const again = pendingPermission(context.views)!;
      await first.interactions.respond(again.requestId, { kind: 'permission', decision: { type: 'allow_once' } });
      await runtime.runs.await(context.runId);
      expect((await readFile(path.join(homeDir, '.kodax', 'grant-marker.txt'), 'utf8')).trim()).toBe('granted thrice');
    } finally { context.close(); }
  } finally { context.close(); }
}, 120_000);
