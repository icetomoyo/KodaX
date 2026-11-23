import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLearningCenterService, createMcpTestServerFixture, createReferenceAgentExecutorFactory } from '@kodax-ai/agent';
import { awaitLatestCodingMemoryReviewDrain, getActiveExtensionRuntime } from '@kodax-ai/coding';
import {
  KodaXBaseProvider, registerModelProvider, type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { FileSessionStorage } from '@kodax-ai/repl';

import { createKodaXRuntime } from '../../tests/runtime-fixture.js';
import { connectHostRpc, type HostRpcClient } from '../host-protocol/client.js';
import type { HostCloseReason } from '../host-protocol/close.js';
import { HostProtocolError } from '../host-protocol/codec.js';
import { createKodaXHostClient } from '../host-protocol/host-client.js';
import { HOST_METHODS, type HostMethodSpec } from '../host-protocol/methods.js';
import { createHostCredentialService } from '../host-credentials.js';
import { bindRequestCredentials } from '../request-credential-binding.js';
import type { KodaXRuntime } from '../sdk-runtime.js';
import type { RuntimeConnectionRole } from './access.js';
import type { RuntimeClientLifecycleController } from './client-lifecycle.js';
import {
  createRuntimeDaemonHostRpcPeer, hostErrorFromV1, type HostCredential, type RuntimeDaemonHostRpcPeerOptions,
} from './host-rpc.js';
import * as hostRpcProtocol from './host-rpc-protocol.js';
import { openHostDeviceRegistry } from '../host-server/devices.js';
import type { RuntimeDaemonManagementController } from './management.js';
import { createHostBlobStore } from './host-blobs.js';
import { createRuntimeDaemonReverseBridgeHub } from './reverse-bridge.js';
import { createHostWorkspace, type HostWorkspace } from './workspace.js';

const HOME = '/home/someone/.kodax';

/** The services these tests reach. Anything else a handler touched would throw. */
function fakeRuntime(): KodaXRuntime {
  const catalog: Partial<KodaXRuntime['catalog']> = {
    providers: async () => [{
      name: 'anthropic',
      model: 'claude-sonnet',
      models: ['claude-sonnet', 'claude-opus'],
      configured: true,
      source: 'builtin',
      reasoningCapability: 'native-effort',
      capabilityProfile: { transport: 'native-api', conversationSemantics: 'full-history', mcpSupport: 'native' },
    }],
    commands: async projectRoot => [{
      name: 'review',
      description: `Review ${projectRoot ?? 'everything'}`,
      source: 'prompt',
      location: 'user',
      path: `${HOME}/commands/review.md`,
      userInvocable: true,
    }],
    skills: async filter => [{
      name: 'deploy',
      description: `Deploy ${filter?.projectRoot ?? 'everything'}`,
      userInvocable: true,
      path: `${HOME}/skills/deploy`,
      source: 'user',
      disableModelInvocation: false,
    }],
    describeSkill: async ({ name, projectRoot }) => (name !== 'deploy' ? null : {
      name: 'deploy',
      description: `Deploy ${projectRoot ?? 'everything'}`,
      userInvocable: true,
      path: `${HOME}/skills/deploy`,
      source: 'user',
      disableModelInvocation: false,
      content: 'Ship it.',
      skillFilePath: `${HOME}/skills/deploy/SKILL.md`,
      scripts: [{ name: 'run.sh', relativePath: 'run.sh', path: `${HOME}/skills/deploy/scripts/run.sh` }],
    }),
    reasoningEfforts: async ({ provider, model }) => ['auto', 'off', `${provider}/${model ?? 'default'}`],
  };
  return {
    identity: { runtimeId: 'runtime-test', mode: 'embedded', profile: 'default', startedAt: '2026-11-21T00:00:00.000Z', version: '0.0.0-test' },
    capabilities: {},
    agents: { enabled: false },
    catalog,
  } as unknown as KodaXRuntime;
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  // Newest first: a connection closes before the runtime it uses, and that before its files go.
  for (const task of cleanup.splice(0).reverse()) await task();
});

/** A v2 client wired straight to the bridge a Host puts on its local endpoint. */
async function connect(
  role: RuntimeConnectionRole,
  runtime: KodaXRuntime = fakeRuntime(),
  workspace?: HostWorkspace,
  /** What the Host process adds to the runtime, such as its management and its log. */
  host: Partial<RuntimeDaemonHostRpcPeerOptions['dispatcher']> = {},
  /** Proves a reconnect is the same client instance, so it keeps that instance's leases. */
  instanceSecret?: string,
  /** What the Host's network listener adds, such as its paired devices. */
  network: Pick<RuntimeDaemonHostRpcPeerOptions, 'devices' | 'blobs'> = {},
): Promise<HostRpcClient> {
  const client = await connectHostRpc(async (events) => {
    let open = true;
    const end = (): void => {
      if (!open) return;
      open = false;
      peer.close();
      events.end();
    };
    const peer = createRuntimeDaemonHostRpcPeer({
      protocol: hostRpcProtocol,
      dispatcher: { ...host, role, runtime, authToken: 'secret', ...(role === 'service' ? { tokenSubject: 'backend' } : {}) },
      limits: { maxFrameBytes: 1024 * 1024 },
      ...(workspace !== undefined ? { workspace } : {}),
      ...network,
      send: frame => queueMicrotask(() => { if (open) events.frame(frame); }),
      disconnect: () => queueMicrotask(end),
      congested: () => false,
    });
    return { send: frame => queueMicrotask(() => { if (open) peer.receive(frame); }), close: end };
  }, {
    client: { name: 'test', version: '1.0.0', instanceId: `instance-${role}`, ...(instanceSecret !== undefined ? { instanceSecret } : {}) },
    auth: { scheme: 'ipc', token: 'secret' },
  });
  cleanup.push(() => client.close());
  return recordingResends(client, `${hostIds.get(runtime) ?? hostIds.set(runtime, hostIds.size).size - 1} ${role}`);
}

/** Each command answered, by the Host and role it went to and what was sent; and the commands answered again when sent again. */
const hostIds = new Map<KodaXRuntime, number>();
const answered = new Set<string>();
const answeredAgain = new Set<string>();

function recordingResends(client: HostRpcClient, sender: string): HostRpcClient {
  const request: HostRpcClient['request'] = async (method, params, options) => {
    const answer = await client.request(method, params, options);
    if (typeof params?.requestId === 'string') {
      const sent = `${sender} ${method} ${JSON.stringify(params)}`;
      if (answered.has(sent)) answeredAgain.add(method);
      answered.add(sent);
    }
    return answer;
  };
  return Object.assign(Object.create(client) as HostRpcClient, { request });
}

describe('v2 catalogs served by the v1 implementation', () => {
  it('lists providers', async () => {
    const owner = await connect('owner');
    expect(await owner.request('provider.list')).toEqual({
      items: [{
        name: 'anthropic',
        model: 'claude-sonnet',
        models: ['claude-sonnet', 'claude-opus'],
        configured: true,
        source: 'builtin',
        reasoningCapability: 'native-effort',
        capabilityProfile: { transport: 'native-api', conversationSemantics: 'full-history', mcpSupport: 'native' },
      }],
    });
  });

  it('lists commands and Skills with their paths for the owner', async () => {
    const owner = await connect('owner');
    expect(await owner.request('command.list', { projectRoot: '/work/app' })).toEqual({
      items: [{
        name: 'review', description: 'Review /work/app', source: 'prompt', location: 'user',
        path: `${HOME}/commands/review.md`, userInvocable: true,
      }],
    });
    expect(await owner.request('skill.list')).toEqual({
      items: [{
        name: 'deploy', description: 'Deploy everything', source: 'user',
        path: `${HOME}/skills/deploy`, disableModelInvocation: false,
      }],
    });
  });

  it.each(['user', 'service'] as const)('sends a %s no Host path and accepts none from it', async (role) => {
    const client = await connect(role);
    for (const method of ['provider.list', 'command.list', 'skill.list']) {
      expect(JSON.stringify(await client.request(method))).not.toContain(HOME);
    }
    expect(await client.request('skill.list')).toEqual({
      items: [{ name: 'deploy', description: 'Deploy everything', source: 'user', disableModelInvocation: false }],
    });
    await expect(client.request('command.list', { projectRoot: '/work/app' })).rejects.toMatchObject({
      kodaxCode: 'forbidden', reason: 'param_not_allowed',
    });
  });

  it('reports a v1 failure in v2 terms and keeps the v1 code as the reason', async () => {
    const runtime = fakeRuntime();
    (runtime.catalog as { providers: unknown }).providers = async () => {
      throw Object.assign(new Error('The provider catalog is being rebuilt.'), { code: 'overloaded' });
    };
    const owner = await connect('owner', runtime);
    await expect(owner.request('provider.list')).rejects.toMatchObject({ kodaxCode: 'overloaded', reason: 'overloaded', retryable: true });
  });
});

interface TestHost {
  readonly homeDir: string;
  readonly workspaceRoot: string;
  readonly workspace: HostWorkspace;
  /** Starts a runtime on this home. Call it again after closing one to restart the Host. */
  start(options?: TestHostOptions): Promise<KodaXRuntime>;
}

interface TestHostOptions {
  readonly defaultProvider?: string;
  readonly hostToolCeiling?: () => readonly string[] | undefined;
}

/** A Host home with a workspace that holds the project `app`. */
async function makeHost(): Promise<TestHost> {
  const homeDir = await realpath(await mkdtemp(path.join(tmpdir(), 'kodax-host-rpc-')));
  // Windows may hold a file just written for a moment after its writer let go.
  cleanup.push(() => rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const workspaceRoot = path.join(homeDir, 'workspace');
  await mkdir(path.join(workspaceRoot, 'app'), { recursive: true });
  return {
    homeDir,
    workspaceRoot,
    workspace: createHostWorkspace(workspaceRoot),
    start: async (options = {}) => {
      // As the Host starts it: interactions wait for an attached client instead of being refused.
      const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, ...options });
      cleanup.push(() => runtime.close());
      return runtime;
    },
  };
}

type SessionFacts = { readonly id: string; readonly [field: string]: unknown };
type SessionAnswer = { readonly session: SessionFacts };
type SessionPage = { readonly items: readonly SessionFacts[]; readonly nextCursor?: string };

describe('v2 Sessions served by the v1 implementation', () => {
  it('lets the owner create a Session at a Host path and read it back', async () => {
    const host = await makeHost();
    const owner = await connect('owner', await host.start(), host.workspace);
    const projectRoot = path.join(host.workspaceRoot, 'app');

    const { session } = await owner.request('session.create', { requestId: 'create-1', title: 'Report', projectRoot }) as SessionAnswer;
    expect(session).toMatchObject({
      title: 'Report', archived: false, project: 'app', workspaceRoot: projectRoot, messageCount: 0,
    });
    expect(session.createdAt).toEqual(expect.any(Number));

    expect(await owner.request('session.get', { sessionId: session.id })).toMatchObject({
      session: { id: session.id, title: 'Report', project: 'app', workspaceRoot: projectRoot, revision: expect.any(String) },
      phase: 'idle',
    });
  });

  it('keeps a draft Session off disk until it has a conversation, and answers a repeat with the same draft', async () => {
    const host = await makeHost();
    const owner = await connect('owner', await host.start(), host.workspace);
    const params = { requestId: 'draft-1', title: 'Scratch', projectRoot: host.workspaceRoot, draft: true };

    const { session } = await owner.request('session.create', params) as SessionAnswer;
    expect(await owner.request('session.create', params)).toMatchObject({ session: { id: session.id } });
    expect(await owner.request('session.get', { sessionId: session.id })).toMatchObject({
      session: { id: session.id, title: 'Scratch', messageCount: 0 }, phase: 'idle',
    });
    const configHome = path.join(host.homeDir, '.kodax');
    expect(await new FileSessionStorage({ sessionsDir: path.join(configHome, 'sessions'), configHome }).load(session.id))
      .toBeNull();
  });

  it.each(['user', 'service'] as const)('lets a %s name a project inside the workspace and sends it no Host path', async (role) => {
    const host = await makeHost();
    const runtime = await host.start();
    const client = await connect(role, runtime, host.workspace);

    const created = await client.request('session.create', { requestId: 'create-1', title: 'Remote', project: 'app' }) as SessionAnswer;
    expect(created.session).toMatchObject({ title: 'Remote', project: 'app' });
    const atRoot = await client.request('session.create', { requestId: 'create-2' }) as SessionAnswer;
    expect(atRoot.session.project).toBe('.');

    const inProject = await client.request('session.list', { project: 'app' }) as SessionPage;
    expect(inProject.items.map(item => item.id)).toEqual([created.session.id]);
    const answers = [
      created,
      atRoot,
      inProject,
      await client.request('session.get', { sessionId: created.session.id }),
      await client.request('session.list'),
    ];
    // The home's own name appears in every Host path and in nothing else.
    for (const answer of answers) expect(JSON.stringify(answer)).not.toContain(path.basename(host.homeDir));

    // The Session really works where the project is.
    expect(await runtime.sessions.load(created.session.id)).toMatchObject({ workspaceRoot: path.join(host.workspaceRoot, 'app') });
  });

  it('refuses a user what would reach outside the workspace', async () => {
    const host = await makeHost();
    const runtime = await host.start();
    const user = await connect('user', runtime, host.workspace);

    await expect(user.request('session.create', { requestId: 'a', projectRoot: host.homeDir }))
      .rejects.toMatchObject({ kodaxCode: 'forbidden', reason: 'param_not_allowed' });
    await expect(user.request('session.list', { projectRoot: host.homeDir }))
      .rejects.toMatchObject({ kodaxCode: 'forbidden', reason: 'param_not_allowed' });
    await expect(user.request('session.create', { requestId: 'b', project: '../outside' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(user.request('session.create', { requestId: 'c', project: 'missing' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'project_not_found' });
    expect(await runtime.sessions.list()).toEqual([]);
  });

  it('lets only the owner create a Session on a Host without a workspace', async () => {
    const host = await makeHost();
    const runtime = await host.start();
    const user = await connect('user', runtime);
    const owner = await connect('owner', runtime);

    await expect(user.request('session.create', { requestId: 'a' }))
      .rejects.toMatchObject({ kodaxCode: 'forbidden', reason: 'workspace_not_configured' });
    await expect(user.request('session.create', { requestId: 'b', project: 'app' }))
      .rejects.toMatchObject({ kodaxCode: 'forbidden', reason: 'workspace_not_configured' });
    const { session } = await owner.request('session.create', { requestId: 'c', projectRoot: host.workspaceRoot }) as SessionAnswer;
    expect(session).toMatchObject({ workspaceRoot: host.workspaceRoot });
    expect(session.project).toBeUndefined();
  });

  it('refuses a project named both ways', async () => {
    const host = await makeHost();
    const owner = await connect('owner', await host.start(), host.workspace);
    await expect(owner.request('session.create', { requestId: 'a', project: 'app', projectRoot: host.workspaceRoot }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'project_named_twice' });
  });

  it('creates one Session per requestId and subject, also across a Host restart', async () => {
    const host = await makeHost();
    const first = await host.start();
    const request = { requestId: 'create-1', title: 'Once', project: 'app' };

    const user = await connect('user', first, host.workspace);
    const { session } = await user.request('session.create', request) as SessionAnswer;
    expect((await user.request('session.create', request) as SessionAnswer).session.id).toBe(session.id);
    await expect(user.request('session.create', { ...request, title: 'Twice' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });

    // The owner is the same person; a service is someone else who happens to use the same id.
    const owner = await connect('owner', first, host.workspace);
    expect((await owner.request('session.create', request) as SessionAnswer).session.id).toBe(session.id);
    const service = await connect('service', first, host.workspace);
    expect((await service.request('session.create', request) as SessionAnswer).session.id).not.toBe(session.id);

    for (const client of [user, owner, service]) client.close();
    await first.close();
    const restarted = await connect('user', await host.start(), host.workspace);
    expect((await restarted.request('session.create', request) as SessionAnswer).session.id).toBe(session.id);
    expect((await restarted.request('session.list') as SessionPage).items).toHaveLength(2);
  });

  it('pages through Sessions', async () => {
    const host = await makeHost();
    const user = await connect('user', await host.start(), host.workspace);
    const created: string[] = [];
    for (const requestId of ['a', 'b', 'c']) {
      created.push((await user.request('session.create', { requestId, title: requestId }) as SessionAnswer).session.id);
    }

    const first = await user.request('session.list', { limit: 2 }) as SessionPage;
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await user.request('session.list', { limit: 2, cursor: first.nextCursor }) as SessionPage;
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect([...first.items, ...second.items].map(item => item.id).sort()).toEqual([...created].sort());
  });

  it('archives, restores and deletes, each safe to repeat', async () => {
    const host = await makeHost();
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', title: 'Old' }) as SessionAnswer;
    const target = { sessionId: session.id };

    expect(await user.request('session.archive', { requestId: 'archive-1', ...target })).toEqual({});
    expect(await user.request('session.archive', { requestId: 'archive-1', ...target })).toEqual({});
    expect((await user.request('session.list') as SessionPage).items).toEqual([]);
    expect((await user.request('session.list', { includeArchived: true }) as SessionPage).items)
      .toMatchObject([{ id: session.id, archived: true }]);
    expect(await user.request('session.get', target)).toMatchObject({ session: { archived: true } });

    expect(await user.request('session.unarchive', { requestId: 'unarchive-1', ...target })).toEqual({});
    expect(await user.request('session.unarchive', { requestId: 'unarchive-1', ...target })).toEqual({});
    expect(await user.request('session.get', target)).toMatchObject({ session: { archived: false } });

    expect(await user.request('session.delete', { requestId: 'delete-1', ...target })).toEqual({});
    expect(await user.request('session.delete', { requestId: 'delete-1', ...target })).toEqual({});
    await expect(user.request('session.get', target)).rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'not_found' });
    await expect(user.request('session.archive', { requestId: 'archive-2', ...target }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
  });

  it('refuses a command without a requestId', async () => {
    const host = await makeHost();
    const user = await connect('user', await host.start(), host.workspace);
    await expect(user.request('session.create', { title: 'No id' })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
  });

  it('promotes a Session once, for a trusted caller, and says why another promotion is refused', async () => {
    const host = await makeHost();
    const runtime = await host.start();
    const owner = await connect('owner', runtime, host.workspace);
    const { session } = await owner.request('session.create', { requestId: 'create-1', tag: 'quick-ask', project: 'app' }) as SessionAnswer;
    const { session: read } = await owner.request('session.get', { sessionId: session.id }) as SessionAnswer;
    const promote = { requestId: 'promote-1', sessionId: session.id, ifRevision: read.revision, tag: 'coder' };

    await expect(owner.request('session.promote', { ...promote, ifRevision: 'f'.repeat(64) }))
      .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'revision_mismatch' });
    await expect(owner.request('session.promotion.get', { sessionId: session.id, promotionId: 'promote-1' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'promotion_not_found' });

    const { session: promoted } = await owner.request('session.promote', promote) as SessionAnswer;
    expect(promoted).toMatchObject({ id: session.id, tag: 'coder', project: 'app', messageCount: 0 });
    expect(promoted.revision).not.toBe(read.revision);
    // A service reaches the trusted plane: a lost answer is read back, or the same request sent again.
    const service = await connect('service', runtime, host.workspace);
    expect(await service.request('session.promotion.get', { sessionId: session.id, promotionId: 'promote-1' }))
      .toEqual({ session: { ...promoted, workspaceRoot: undefined, gitRoot: undefined, executionCwd: undefined } });
    expect(await owner.request('session.promote', promote)).toEqual({ session: promoted });
    await expect(service.request('session.promote', { ...promote, requestId: 'promote-2', tag: 'partner' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'already_promoted' });

    const user = await connect('user', runtime, host.workspace);
    await expect(user.request('session.promote', { ...promote, requestId: 'promote-3' }))
      .rejects.toMatchObject({ kodaxCode: 'method_not_found' });
  });
});

interface ViewFrame {
  readonly subscriptionId: string;
  readonly epoch: string;
  readonly seq: number;
  readonly snapshot?: { readonly items: readonly { readonly id: string; readonly text: string; readonly textTotal?: number }[] };
  readonly ops?: readonly { readonly op: string; readonly item?: { readonly id: string; readonly text: string } }[];
  readonly reason?: string;
}

/** Everything the Host sends this client on its own, in order. */
function notifications(client: HostRpcClient): Array<{ readonly method: string; readonly params: ViewFrame }> {
  const received: Array<{ readonly method: string; readonly params: ViewFrame }> = [];
  client.onNotification((method, params) => received.push({ method, params: params as unknown as ViewFrame }));
  return received;
}

describe('v2 view subscriptions served by the v1 implementation', () => {
  it('answers with the view, sends what changes, and stops when unsubscribed', async () => {
    const host = await makeHost();
    const runtime = await host.start();
    const user = await connect('user', runtime, host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sent = notifications(user);

    const answer = await user.request('view.subscribe', {
      subscriptionId: 'main', target: { kind: 'session', sessionId: session.id },
    }) as unknown as ViewFrame;
    expect(answer).toMatchObject({ subscriptionId: 'main', epoch: expect.any(String), seq: 0, snapshot: { items: [], runs: [], queue: [] } });

    await runtime.sessions.appendNotice({ sessionId: session.id, content: 'The build finished.' });
    await expect.poll(() => sent.length, { timeout: 5000 }).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({ method: 'view.patch', params: { subscriptionId: 'main', epoch: answer.epoch, seq: 1 } });
    expect(sent[0]!.params.ops!.map(op => [op.op, op.item?.text])).toEqual([['item.put', 'The build finished.']]);
    expect(JSON.stringify([answer, sent])).not.toContain(path.basename(host.homeDir));

    expect(await user.request('view.unsubscribe', { subscriptionId: 'main' })).toEqual({});
    expect(await user.request('view.unsubscribe', { subscriptionId: 'main' })).toEqual({});
    const before = sent.length;
    await runtime.sessions.appendNotice({ sessionId: session.id, content: 'Nobody is watching.' });
    // A second subscription sees the notice, so by then the first would have been sent it too.
    const again = await user.request('view.subscribe', {
      subscriptionId: 'again', target: { kind: 'session', sessionId: session.id },
    }) as unknown as ViewFrame;
    await expect.poll(async () => {
      const view = await user.request('view.subscribe', {
        subscriptionId: 'again', target: { kind: 'session', sessionId: session.id },
      }) as unknown as ViewFrame;
      return view.snapshot!.items.length;
    }, { timeout: 5000 }).toBe(2);
    expect(again.seq).toBe(0);
    expect(sent.slice(before).filter(frame => frame.params.subscriptionId === 'main')).toEqual([]);
  });

  it('pages through an item too long for the view', async () => {
    const host = await makeHost();
    const runtime = await host.start();
    const user = await connect('user', runtime, host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const content = Array.from({ length: 15_000 }, (_, index) => `line ${index}`).join('\n');
    await runtime.sessions.appendNotice({ sessionId: session.id, content });

    const { snapshot } = await user.request('view.subscribe', {
      subscriptionId: 'main', target: { kind: 'session', sessionId: session.id },
    }) as unknown as ViewFrame;
    const [item] = snapshot!.items;
    expect(item!.textTotal).toBe(content.length);
    expect(item!.text.length).toBeLessThanOrEqual(6144);
    expect(content.endsWith(item!.text)).toBe(true);

    let read = '';
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await user.request('item.read', {
        sessionId: session.id, itemId: item!.id, ...(cursor !== undefined ? { cursor } : {}),
      }) as { readonly text: string; readonly total: number; readonly nextCursor?: string };
      expect(page.total).toBe(content.length);
      read += page.text;
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined);
    expect(read).toBe(content);
    expect(pages).toBeGreaterThan(1);

    await expect(user.request('item.read', { sessionId: session.id, itemId: item!.id, cursor: '65536.7' }))
      .rejects.toMatchObject({ kodaxCode: 'resync_required', reason: 'item_changed' });
    await expect(user.request('item.read', { sessionId: session.id, itemId: item!.id, cursor: 'next' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'invalid_cursor' });
    await expect(user.request('item.read', { sessionId: session.id, itemId: 'no-such-item' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'item_not_found' });
  });

  it('tells a subscriber when its Session is deleted', async () => {
    const host = await makeHost();
    const runtime = await host.start();
    const user = await connect('user', runtime, host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sent = notifications(user);
    await user.request('view.subscribe', { subscriptionId: 'main', target: { kind: 'session', sessionId: session.id } });

    await user.request('session.delete', { requestId: 'delete-1', sessionId: session.id });
    await expect.poll(() => sent.map(frame => frame.method), { timeout: 5000 }).toContain('view.closed');
    expect(sent.find(frame => frame.method === 'view.closed')!.params).toEqual({ subscriptionId: 'main', reason: 'unavailable' });
  });

  it('refuses to show a Session that does not exist', async () => {
    const host = await makeHost();
    const user = await connect('user', await host.start(), host.workspace);
    await expect(user.request('view.subscribe', { subscriptionId: 'main', target: { kind: 'session', sessionId: 'missing' } }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
    // Nothing is left behind under the id.
    expect(await user.request('view.unsubscribe', { subscriptionId: 'main' })).toEqual({});
  });
});

const MODEL = 'host-rpc-test-provider';

interface RunFacts {
  readonly id: string;
  readonly phase: string;
  readonly inputId?: string;
  readonly outcome?: {
    readonly status: string; readonly effects: string; readonly code: string;
    readonly finalText?: string; readonly finalTextTruncated?: boolean; readonly usage?: unknown;
  };
  readonly stop?: { readonly confirmed: boolean };
}
type RunAnswer = { readonly run: RunFacts };
type InputAnswer = { readonly input: { readonly id: string; readonly state: string; readonly runId?: string } };

/** What the model sends for the conversation so far. Without one it answers `done`. */
type ModelTurn = (messages: readonly KodaXMessage[]) => KodaXStreamResult | undefined;

/** A Host whose model answers `done`, at once or, after `hold()`, only when released. */
async function makeModelHost(turn?: ModelTurn) {
  const host = await makeHost();
  let calls = 0;
  const requests: Array<{ readonly tools: readonly string[]; readonly text: string; readonly apiKey: string }> = [];
  let gate: Promise<void> = Promise.resolve();
  let release = (): void => undefined;
  let entered = (): void => undefined;
  class TestProvider extends KodaXBaseProvider {
    readonly name = MODEL;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_HOST_RPC_TEST_KEY', model: 'host-rpc-test', supportsThinking: false,
    };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      calls += 1;
      requests.push({ tools: args[1].map(tool => tool.name), text: JSON.stringify([args[2], args[0]]), apiKey: this.getApiKey() });
      entered();
      // As a real provider does, a held call ends when it is aborted, so nothing of it runs on after the test.
      const signal = args[5];
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(signal!.reason);
        if (signal?.aborted) return aborted();
        signal?.addEventListener('abort', aborted, { once: true });
        void gate.then(() => {
          signal?.removeEventListener('abort', aborted);
          resolve();
        });
      });
      signal?.throwIfAborted();
      return turn?.(args[0]) ?? { textBlocks: [{ type: 'text', text: 'done' }], toolBlocks: [], thinkingBlocks: [] };
    }
  }
  vi.stubEnv('KODAX_HOST_RPC_TEST_KEY', 'offline-test');
  vi.stubEnv('KODAX_HOME', path.join(host.homeDir, '.kodax'));
  const unregister = registerModelProvider(MODEL, () => new TestProvider());
  // Runs after the runtimes closed and before the home is removed.
  cleanup.splice(1, 0, async () => {
    release();
    await awaitLatestCodingMemoryReviewDrain(5_000);
    unregister();
    vi.unstubAllEnvs();
  });
  return {
    ...host,
    start: (options: TestHostOptions = {}) => host.start({ defaultProvider: MODEL, ...options }),
    calls: () => calls,
    /** What the model was last asked: the tools it was offered, and its instructions and conversation as one text. */
    lastRequest: () => requests.at(-1)!,
    /** The last request of a Run: the memory review a finished Run starts asks the model too. */
    lastRunRequest: () => [...requests].reverse().find(request => !request.tools.includes('commit_episode_learning_review'))!,
    /** Makes the model wait. Resolves `called` when the model is next asked. */
    hold(): { readonly called: Promise<void>; readonly release: () => void } {
      gate = new Promise<void>((resolve) => { release = resolve; });
      return { called: new Promise<void>((resolve) => { entered = resolve; }), release: () => release() };
    },
  };
}

describe('v2 inputs and Runs served by the v1 implementation', () => {
  it('starts one Run for an input and reports how it ended', async () => {
    const host = await makeModelHost();
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const submit = { requestId: 'input-1', sessionId: session.id, text: 'Say done.' };

    const { input } = await user.request('input.submit', submit) as InputAnswer;
    expect(input).toEqual({ id: 'input-1', state: 'submitted', runId: expect.any(String) });
    const { run } = await user.request('run.wait', { runId: input.runId }) as RunAnswer;
    expect(run).toMatchObject({
      id: input.runId, sessionId: session.id, phase: 'completed', inputId: 'input-1', provider: MODEL,
      startedAt: expect.any(Number), endedAt: expect.any(Number),
      outcome: { status: 'completed', code: 'completed' },
    });
    expect(['none', 'known']).toContain(run.outcome!.effects);

    // Asked again, every one of these answers the same and nothing more runs.
    const modelCalls = host.calls();
    expect(await user.request('input.submit', submit)).toEqual({ input });
    expect(await user.request('input.get', { sessionId: session.id, inputId: 'input-1' })).toEqual({ input });
    expect(await user.request('run.get', { runId: input.runId })).toEqual({ run });
    const { finalText: _answer, ...listed } = run.outcome!;
    expect(await user.request('run.list', { sessionId: session.id })).toEqual({ items: [{ ...run, outcome: listed }] });
    expect(host.calls()).toBe(modelCalls);
    await expect(user.request('input.submit', { ...submit, text: 'Say something else.' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });
    expect(JSON.stringify(run)).not.toContain(path.basename(host.homeDir));
  });

  it('keeps an input to one Run across a Host restart', async () => {
    const host = await makeModelHost();
    const first = await host.start();
    const before = await connect('user', first, host.workspace);
    const { session } = await before.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const submit = { requestId: 'input-1', sessionId: session.id, text: 'Say done.' };
    const { input } = await before.request('input.submit', submit) as InputAnswer;
    await before.request('run.wait', { runId: input.runId });
    const modelCalls = host.calls();
    before.close();
    await first.close();

    const after = await connect('user', await host.start(), host.workspace);
    expect(await after.request('input.get', { sessionId: session.id, inputId: 'input-1' })).toEqual({ input });
    expect(await after.request('input.submit', submit)).toEqual({ input });
    expect((await after.request('run.list', { sessionId: session.id }) as { items: RunFacts[] }).items.map(run => run.id))
      .toEqual([input.runId]);
    expect(host.calls()).toBe(modelCalls);
  });

  it('gives up waiting at the limit while the Run goes on, and stops the Run when asked', async () => {
    const host = await makeModelHost();
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const held = host.hold();
    const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Wait.' }) as InputAnswer;
    await held.called;

    await expect(user.request('run.wait', { runId: input.runId, timeoutMs: 50 }))
      .rejects.toMatchObject({ kodaxCode: 'timeout', reason: 'run_in_progress' });
    expect((await user.request('run.get', { runId: input.runId }) as RunAnswer).run.outcome).toBeUndefined();

    expect(await user.request('run.stop', { requestId: 'stop-1', runId: input.runId })).toEqual({});
    expect(await user.request('run.stop', { requestId: 'stop-1', runId: input.runId })).toEqual({});
    const { run } = await user.request('run.wait', { runId: input.runId }) as RunAnswer;
    // Stopped part-way: what it had already changed is for the client to look at.
    expect(run.outcome).toEqual({
      status: 'interrupted', effects: 'unknown', code: 'interrupted', message: expect.any(String),
    });
    expect(run.stop).toEqual({ requestedAt: expect.any(Number), confirmed: true });
  });

  it('answers a wait with no time to spare when the Run already ended', async () => {
    const host = await makeModelHost();
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Say done.' }) as InputAnswer;
    await user.request('run.wait', { runId: input.runId });
    expect((await user.request('run.wait', { runId: input.runId, timeoutMs: 0 }) as RunAnswer).run.outcome)
      .toMatchObject({ status: 'completed' });
  });

  it('queues an input behind a Run and gives it back when withdrawn', async () => {
    const host = await makeModelHost();
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const held = host.hold();
    const first = await user.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Wait.' }) as InputAnswer;
    await held.called;

    const later = { requestId: 'input-2', sessionId: session.id, text: 'Then this.', delivery: 'after_turn' };
    expect(await user.request('input.submit', later)).toEqual({ input: { id: 'input-2', state: 'queued' } });
    expect(await user.request('input.submit', later)).toEqual({ input: { id: 'input-2', state: 'queued' } });
    expect(await user.request('input.get', { sessionId: session.id, inputId: 'input-2' }))
      .toEqual({ input: { id: 'input-2', state: 'queued' } });

    const withdraw = { requestId: 'withdraw-1', sessionId: session.id, inputId: 'input-2' };
    const withdrawn = { input: { id: 'input-2', text: 'Then this.', delivery: 'after_turn' } };
    expect(await user.request('input.withdraw', withdraw)).toEqual(withdrawn);
    expect(await user.request('input.withdraw', withdraw)).toEqual(withdrawn);
    expect(await user.request('input.get', { sessionId: session.id, inputId: 'input-2' }))
      .toEqual({ input: { id: 'input-2', state: 'withdrawn' } });

    held.release();
    await user.request('run.wait', { runId: first.input.runId });
    expect((await user.request('run.list', { sessionId: session.id }) as { items: RunFacts[] }).items).toHaveLength(1);
  });

  it('says what a finished Run answered and used, across a Host restart', async () => {
    const answer = 'The release is on Friday.';
    const host = await makeModelHost(() => ({
      textBlocks: [{ type: 'text', text: answer }], toolBlocks: [], thinkingBlocks: [],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }));
    const first = await host.start();
    const before = await connect('user', first, host.workspace);
    const { session } = await before.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const { input } = await before.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'When?' }) as InputAnswer;
    const { run } = await before.request('run.wait', { runId: input.runId }) as RunAnswer;
    expect(run.outcome).toMatchObject({
      status: 'completed', signal: 'complete', finalText: answer, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    expect(run.outcome).not.toHaveProperty('limitReached');
    // A list stays small: the answer is read from the Run itself.
    const [listed] = (await before.request('run.list', { sessionId: session.id }) as { items: RunFacts[] }).items;
    expect(listed!.outcome).not.toHaveProperty('finalText');
    expect(listed!.outcome).toMatchObject({ usage: run.outcome!.usage });
    before.close();
    await first.close();

    const after = await connect('user', await host.start(), host.workspace);
    expect(await after.request('run.get', { runId: input.runId })).toEqual({ run });
  });

  it('cuts a long answer short and says so', async () => {
    const answer = 'a'.repeat(70_000);
    const host = await makeModelHost(() => ({ textBlocks: [{ type: 'text', text: answer }], toolBlocks: [], thinkingBlocks: [] }));
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Talk.' }) as InputAnswer;
    const { outcome } = (await user.request('run.wait', { runId: input.runId }) as RunAnswer).run;
    expect(outcome!.finalText).toBe(answer.slice(0, 64_000));
    expect(outcome!.finalTextTruncated).toBe(true);
  });

  it('says when a Run stopped at its turn limit', async () => {
    // A model that never stops asking for the file.
    const host = await makeModelHost(messages => ({
      textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
      toolBlocks: [{ type: 'tool_use', id: `call-${messages.length}`, name: 'read', input: { path: 'notes.txt' } }],
    }));
    const user = await connect('user', await host.start(), host.workspace);
    await writeFile(path.join(host.workspaceRoot, 'app', 'notes.txt'), 'The release is on Friday.');
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    await user.request('session.settings.update', { requestId: 'set-1', sessionId: session.id, patch: { maxIter: 1 } });
    const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Read it.' }) as InputAnswer;
    expect((await user.request('run.wait', { runId: input.runId }) as RunAnswer).run.outcome)
      .toMatchObject({ status: 'completed', limitReached: true });
  }, 60_000);

  it('stops what a Session is doing only while the named Run is its current one', async () => {
    const host = await makeModelHost();
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const held = host.hold();
    const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Wait.' }) as InputAnswer;
    await held.called;

    const cancel = { requestId: 'cancel-1', sessionId: session.id, ifRunId: input.runId };
    expect(await user.request('session.cancel', cancel)).toEqual({});
    expect(await user.request('session.cancel', cancel)).toEqual({});
    expect((await user.request('run.wait', { runId: input.runId }) as RunAnswer).run.outcome).toMatchObject({ status: 'interrupted' });
    // The Run ended, so a new Stop that still names it has nothing to stop.
    await expect(user.request('session.cancel', { ...cancel, requestId: 'cancel-2' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });
  });

  it('pages through the Runs of a Session, the newest first', async () => {
    const host = await makeModelHost();
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const runIds: string[] = [];
    for (const requestId of ['input-1', 'input-2', 'input-3']) {
      const { input } = await user.request('input.submit', { requestId, sessionId: session.id, text: 'Say done.' }) as InputAnswer;
      await user.request('run.wait', { runId: input.runId });
      runIds.unshift(input.runId!);
    }
    type RunPage = { readonly items: readonly RunFacts[]; readonly nextCursor?: string };
    const first = await user.request('run.list', { sessionId: session.id, limit: 2 }) as RunPage;
    expect(first.items.map(run => run.id)).toEqual(runIds.slice(0, 2));
    const rest = await user.request('run.list', { sessionId: session.id, limit: 2, cursor: first.nextCursor }) as RunPage;
    expect(rest.items.map(run => run.id)).toEqual(runIds.slice(2));
    expect(rest.nextCursor).toBeUndefined();
    await expect(user.request('run.list', { sessionId: session.id, cursor: 'no-such-run' }))
      .rejects.toMatchObject({ kodaxCode: 'resync_required', reason: 'cursor_expired' });
  });

  it('refuses what names nothing, and what only the owner may send', async () => {
    const host = await makeModelHost();
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;

    await expect(user.request('input.get', { sessionId: session.id, inputId: 'never-sent' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'input_not_found' });
    await expect(user.request('run.get', { runId: 'no-such-run' })).rejects.toMatchObject({ kodaxCode: 'not_found' });
    await expect(user.request('run.wait', { runId: 'no-such-run' })).rejects.toMatchObject({ kodaxCode: 'not_found' });
    await expect(user.request('run.stop', { requestId: 'stop-1', runId: 'no-such-run' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
    await expect(user.request('input.submit', { requestId: 'input-1', sessionId: 'missing', text: 'Hello.' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
    await expect(user.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: '   ' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(user.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Faster.', delivery: 'steer' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'target_run_required' });
    await expect(user.request('input.submit', {
      requestId: 'input-1', sessionId: session.id, text: 'Look at this.',
      localAttachments: [{ kind: 'file', path: path.join(host.homeDir, 'notes.txt') }],
    })).rejects.toMatchObject({ kodaxCode: 'forbidden' });
    expect(host.calls()).toBe(0);
  });
});

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
type BlobAnswer = { readonly blobId: string; readonly received: number };
type BlobRead = { readonly data: string; readonly mediaType: string; readonly byteLength: number; readonly sha256: string; readonly nextCursor?: string };
type BlobFacts = { readonly blobId: string; readonly mediaType: string; readonly byteLength: number; readonly sha256: string };
type ViewItemFacts = { readonly type: string; readonly attachments?: readonly { readonly blobId: string; readonly path?: string }[] };

/** Uploads bytes to a Session the way a client does: begin, write in one chunk, commit. */
async function uploadBlob(client: HostRpcClient, sessionId: string, bytes: Buffer, mediaType = 'image/png'): Promise<BlobFacts> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const { blobId } = await client.request('blob.begin', {
    requestId: `begin-${sha256.slice(0, 8)}`, sessionId, mediaType, byteLength: bytes.length, sha256,
  }) as BlobAnswer;
  await client.request('blob.write', { requestId: `write-${sha256.slice(0, 8)}`, sessionId, blobId, offset: 0, data: bytes.toString('base64') });
  return (await client.request('blob.commit', { requestId: `commit-${sha256.slice(0, 8)}`, sessionId, blobId }) as { blob: BlobFacts }).blob;
}

describe('v2 blobs', () => {
  it('takes an image as a blob, hands it to the Run, and gives it back as the attachment of the item', async () => {
    const host = await makeModelHost();
    const blobs = createHostBlobStore({ sessionsDir: path.join(host.homeDir, '.kodax', 'sessions') });
    const user = await connect('user', await host.start(), host.workspace, {}, undefined, { blobs });
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;

    const blob = await uploadBlob(user, session.id, ONE_PIXEL_PNG);
    expect(blob).toEqual({
      blobId: expect.any(String), mediaType: 'image/png', byteLength: ONE_PIXEL_PNG.length,
      sha256: createHash('sha256').update(ONE_PIXEL_PNG).digest('hex'),
    });
    const { input } = await user.request('input.submit', {
      requestId: 'input-1', sessionId: session.id, text: 'What is in this picture?', attachments: [{ blobId: blob.blobId }],
    }) as InputAnswer;
    await user.request('run.wait', { runId: input.runId });
    expect(host.lastRunRequest().text).toContain('"type":"image"');

    const view = await user.request('view.subscribe', {
      subscriptionId: 'main', target: { kind: 'session', sessionId: session.id },
    }) as unknown as { readonly snapshot: { readonly items: readonly ViewItemFacts[] } };
    const attachment = view.snapshot.items.find(item => item.attachments !== undefined)!.attachments![0]!;
    expect(attachment.path).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain(host.homeDir.replaceAll('\\', '\\\\'));
    const read = await user.request('blob.read', { sessionId: session.id, blobId: attachment.blobId }) as BlobRead;
    expect(read).toEqual({ data: ONE_PIXEL_PNG.toString('base64'), mediaType: 'image/png', byteLength: blob.byteLength, sha256: blob.sha256 });
    expect(await user.request('blob.read', { sessionId: session.id, blobId: blob.blobId })).toEqual(read);

    // The blobs go with their Session.
    await user.request('session.delete', { requestId: 'delete-1', sessionId: session.id });
    await expect(user.request('blob.read', { sessionId: session.id, blobId: blob.blobId }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'blob_not_found' });
  }, 30_000);

  it('reads a blob in chunks, and asks for a fresh read when the bytes behind a cursor changed', async () => {
    const host = await makeHost();
    const blobs = createHostBlobStore({
      sessionsDir: path.join(host.homeDir, '.kodax', 'sessions'), limits: { blobChunkBytes: 32, maxBlobBytes: 1024, blobQuotaBytes: 4096 },
    });
    const user = await connect('user', await host.start(), host.workspace, {}, undefined, { blobs });
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const begin = {
      requestId: 'begin-1', sessionId: session.id, mediaType: 'image/png', byteLength: ONE_PIXEL_PNG.length,
      sha256: createHash('sha256').update(ONE_PIXEL_PNG).digest('hex'),
    };
    const { blobId } = await user.request('blob.begin', begin) as BlobAnswer;
    // Each step sent again, as after a lost answer, answers as it did.
    expect(await user.request('blob.begin', begin)).toEqual({ blobId, received: 0 });
    for (let offset = 0; offset < ONE_PIXEL_PNG.length; offset += 32) {
      const write = {
        requestId: `write-${offset}`, sessionId: session.id, blobId, offset, data: ONE_PIXEL_PNG.subarray(offset, offset + 32).toString('base64'),
      };
      const written = await user.request('blob.write', write);
      expect(await user.request('blob.write', write)).toEqual(written);
    }
    const committed = await user.request('blob.commit', { requestId: 'commit-1', sessionId: session.id, blobId });
    expect(await user.request('blob.commit', { requestId: 'commit-1', sessionId: session.id, blobId })).toEqual(committed);

    const chunks: Buffer[] = [];
    let cursor: string | undefined;
    do {
      const page = await user.request('blob.read', { sessionId: session.id, blobId, ...(cursor !== undefined ? { cursor } : {}) }) as BlobRead;
      chunks.push(Buffer.from(page.data, 'base64'));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(Buffer.concat(chunks)).toEqual(ONE_PIXEL_PNG);
    const first = await user.request('blob.read', { sessionId: session.id, blobId }) as BlobRead;
    await expect(user.request('blob.read', { sessionId: session.id, blobId, cursor: first.nextCursor!.replace(/\.[a-f0-9]+$/, `.${'0'.repeat(64)}`) }))
      .rejects.toMatchObject({ kodaxCode: 'resync_required', reason: 'blob_changed' });
    await expect(user.request('blob.read', { sessionId: session.id, blobId, cursor: 'nonsense' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'invalid_cursor' });
  });

  it('refuses an attachment that is not an image, one never uploaded, and a blob for a Session that does not exist', async () => {
    const host = await makeModelHost();
    const blobs = createHostBlobStore({ sessionsDir: path.join(host.homeDir, '.kodax', 'sessions') });
    const user = await connect('user', await host.start(), host.workspace, {}, undefined, { blobs });
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const notes = await uploadBlob(user, session.id, Buffer.from('plain words'), 'text/plain');

    await expect(user.request('input.submit', {
      requestId: 'input-1', sessionId: session.id, text: 'Read this.', attachments: [{ blobId: notes.blobId }],
    })).rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'attachment_not_image' });
    await expect(user.request('input.submit', {
      requestId: 'input-2', sessionId: session.id, text: 'Look.', attachments: [{ blobId: `b_${'0'.repeat(64)}` }],
    })).rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'blob_not_found' });
    await expect(user.request('blob.begin', {
      requestId: 'begin-x', sessionId: 'no-such-session', mediaType: 'image/png', byteLength: 4, sha256: '0'.repeat(64),
    })).rejects.toMatchObject({ kodaxCode: 'not_found' });
    expect(host.calls()).toBe(0);
  });

  it('says blobs are not kept when the Host has no store for them', async () => {
    const host = await makeHost();
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    await expect(user.request('blob.begin', {
      requestId: 'begin-1', sessionId: session.id, mediaType: 'image/png', byteLength: 4, sha256: '0'.repeat(64),
    })).rejects.toMatchObject({ kodaxCode: 'invalid_state', reason: 'blobs_unavailable' });
  });
});

/** A model that calls one tool and, once it has the result, answers `done`. */
function callsToolOnce(name: string, input: Record<string, unknown>): ModelTurn {
  return (messages) => {
    const last = messages.at(-1)?.content;
    if (Array.isArray(last) && last.some(block => block.type === 'tool_result')) return undefined;
    return {
      textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
      toolBlocks: [{ type: 'tool_use', id: 'call-1', name, input }],
    };
  };
}

interface InteractionFacts {
  readonly id: string;
  readonly kind: string;
  readonly request: {
    readonly executionCwd?: string;
    readonly grantSuggestions?: readonly { readonly id: string; readonly kind: string }[];
    readonly [field: string]: unknown;
  };
}
type InteractionPage = { readonly items: readonly InteractionFacts[] };
type GrantPage = { readonly revision: string; readonly items: readonly { readonly id: string; readonly [field: string]: unknown }[] };

/** The one interaction the Session is waiting on, once it is. */
function pendingInteraction(client: HostRpcClient, sessionId: string): Promise<InteractionFacts> {
  return vi.waitFor(async () => {
    const { items } = await client.request('interaction.list', { sessionId }) as InteractionPage;
    if (items.length !== 1) throw new Error(`Waiting for one interaction, there are ${items.length}.`);
    return items[0]!;
  }, { timeout: 10_000, interval: 20 });
}

/** The latest value a subscribed client was sent for one key of the view. */
function shown(sent: ReturnType<typeof notifications>, key: string): unknown {
  const sets = sent.flatMap(frame => (frame.params.ops ?? []) as readonly { op: string; key?: string; value?: unknown }[])
    .filter(op => op.op === 'set' && op.key === key);
  return sets.at(-1)?.value;
}

describe('v2 interactions served by the v1 implementation', () => {
  const QUESTION = {
    question: 'Which colour?',
    options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }],
  };

  it('shows a question to those attached and settles it with the first valid answer', async () => {
    const host = await makeModelHost(callsToolOnce('ask_user_question', QUESTION));
    const runtime = await host.start();
    const user = await connect('user', runtime, host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sent = notifications(user);
    const view = await user.request('view.subscribe', {
      subscriptionId: 'main', target: { kind: 'session', sessionId: session.id },
    }) as unknown as { snapshot: { interactions: unknown[] } };
    expect(view.snapshot.interactions).toEqual([]);

    const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Ask me.' }) as InputAnswer;
    const pending = await pendingInteraction(user, session.id);
    expect(pending).toEqual({
      id: expect.any(String), sessionId: session.id, runId: input.runId, createdAt: expect.any(Number),
      kind: 'question', request: expect.objectContaining(QUESTION),
    });
    await expect.poll(() => shown(sent, 'interactions'), { timeout: 5000 }).toEqual([pending]);
    expect(await user.request('interaction.list')).toEqual({ items: [pending] });

    const answer = { requestId: 'answer-1', interactionId: pending.id, response: { kind: 'question', answer: 'red' } };
    // An answer of another kind settles nothing, and neither does one from a service.
    await expect(user.request('interaction.respond', { ...answer, response: { kind: 'question_input', text: 'red' } }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    const service = await connect('service', runtime, host.workspace);
    await expect(service.request('interaction.respond', answer)).rejects.toMatchObject({ kodaxCode: 'forbidden' });

    expect(await user.request('interaction.respond', answer)).toEqual({ status: 'answered' });
    expect(await user.request('interaction.respond', answer)).toEqual({ status: 'already_resolved' });
    expect((await user.request('run.wait', { runId: input.runId }) as RunAnswer).run.outcome).toMatchObject({ status: 'completed' });
    expect(await user.request('interaction.list', { sessionId: session.id })).toEqual({ items: [] });
    await expect.poll(() => shown(sent, 'interactions'), { timeout: 5000 }).toEqual([]);
  });

  it('lets a person close a question without answering it', async () => {
    const host = await makeModelHost(callsToolOnce('ask_user_question', QUESTION));
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Ask me.' }) as InputAnswer;
    const pending = await pendingInteraction(user, session.id);

    expect(await user.request('interaction.respond', {
      requestId: 'answer-1', interactionId: pending.id, response: { kind: 'dismiss' },
    })).toEqual({ status: 'unanswered' });
    expect((await user.request('run.wait', { runId: input.runId }) as RunAnswer).run.outcome).toMatchObject({ status: 'completed' });
    expect(await user.request('interaction.respond', {
      requestId: 'answer-2', interactionId: 'never-asked', response: { kind: 'skip' },
    })).toEqual({ status: 'already_resolved' });
  });

  // Writing a project's own KodaX configuration always needs a person's answer.
  const WRITE = { path: '.kodax/note.txt', content: 'note' };

  async function hostThatWrites() {
    const host = await makeModelHost(callsToolOnce('write', WRITE));
    const runtime = await host.start();
    const user = await connect('user', runtime, host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const projectRoot = path.join(host.workspaceRoot, 'app');
    return {
      host, runtime, user, projectRoot, sessionId: session.id,
      written: () => existsSync(path.join(projectRoot, WRITE.path)),
      write: async (requestId: string): Promise<string> => {
        const { input } = await user.request('input.submit', { requestId, sessionId: session.id, text: 'Take a note.' }) as InputAnswer;
        return input.runId!;
      },
    };
  }

  const permission = (interactionId: string, requestId: string, decision: Record<string, unknown>) => (
    { requestId, interactionId, response: { kind: 'permission', decision } }
  );

  it('asks before a tool acts and tells only the owner where it would act', async () => {
    const { host, runtime, user, projectRoot, sessionId, written, write } = await hostThatWrites();
    const owner = await connect('owner', runtime, host.workspace);

    const runId = await write('input-1');
    const pending = await pendingInteraction(user, sessionId);
    expect(pending).toMatchObject({ sessionId, runId, kind: 'permission', request: { toolName: 'write' } });
    expect(pending.request).not.toHaveProperty('executionCwd');
    // The person sees what the tool would write, with the file named by its place in the workspace.
    expect(pending.request.diff).toEqual({ path: 'app/.kodax/note.txt', added: 1, removed: 0, unified: '@@ -0,0 +1,1 @@\n+note' });
    const ownerView = await pendingInteraction(owner, sessionId);
    expect(ownerView.request.executionCwd).toBe(projectRoot);
    expect(ownerView.request.diff).toMatchObject({ path: 'app/.kodax/note.txt', hostPath: path.join(projectRoot, WRITE.path) });
    expect(written()).toBe(false);

    // Only a question can be left unanswered. A permission is allowed or refused.
    await expect(user.request('interaction.respond', { requestId: 'answer-0', interactionId: pending.id, response: { kind: 'skip' } }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    expect(await user.request('interaction.respond', permission(pending.id, 'answer-1', { type: 'reject', reason: 'Not now.' })))
      .toEqual({ status: 'answered' });
    expect((await user.request('run.wait', { runId }) as RunAnswer).run.outcome).toMatchObject({ status: 'completed' });
    expect(written()).toBe(false);
  });

  it('refuses the tool when a person closes the request, and runs it when they allow it', async () => {
    const { user, sessionId, written, write } = await hostThatWrites();

    const closed = await write('input-1');
    expect(await user.request('interaction.respond', {
      requestId: 'answer-1', interactionId: (await pendingInteraction(user, sessionId)).id, response: { kind: 'dismiss' },
    })).toEqual({ status: 'dismissed' });
    await user.request('run.wait', { runId: closed });
    expect(written()).toBe(false);

    const allowed = await write('input-2');
    const pending = await pendingInteraction(user, sessionId);
    expect(await user.request('interaction.respond', permission(pending.id, 'answer-2', { type: 'allow_once' })))
      .toEqual({ status: 'answered' });
    await user.request('run.wait', { runId: allowed });
    expect(written()).toBe(true);
  });

  it('keeps a wider answer as a grant until it is revoked', async () => {
    const { user, projectRoot, sessionId, written, write } = await hostThatWrites();
    const empty = await user.request('permission.grant.list') as GrantPage;
    expect(empty.items).toEqual([]);

    const first = await write('input-1');
    const pending = await pendingInteraction(user, sessionId);
    const offered = pending.request.grantSuggestions?.find(suggestion => suggestion.kind === 'session');
    if (offered === undefined) throw new Error('The Host offered no grant for the Session.');
    // The Host gives out the suggestions; a client cannot make one up.
    await expect(user.request('interaction.respond', permission(pending.id, 'answer-0', { type: 'allow_session', suggestionId: 'made-up' })))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    expect(await user.request('interaction.respond', permission(pending.id, 'answer-1', { type: 'allow_session', suggestionId: offered.id })))
      .toEqual({ status: 'answered' });
    await user.request('run.wait', { runId: first });
    expect(written()).toBe(true);

    const granted = await user.request('permission.grant.list') as GrantPage;
    expect(granted.items).toEqual([expect.objectContaining({ id: expect.any(String), sessionId, toolName: 'write', persistence: 'session' })]);
    expect(granted.revision).not.toBe(empty.revision);

    // With the grant, the same call runs without asking.
    await rm(path.join(projectRoot, WRITE.path));
    await user.request('run.wait', { runId: await write('input-2') });
    expect(written()).toBe(true);

    const revoke = { grantId: granted.items[0]!.id };
    await expect(user.request('permission.grant.revoke', { ...revoke, requestId: 'revoke-0', ifRevision: empty.revision }))
      .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'revision_mismatch' });
    await expect(user.request('permission.grant.revoke', { ...revoke, requestId: 'revoke-0', ifRevision: 'not-a-revision' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'revision_mismatch' });
    expect(await user.request('permission.grant.revoke', { ...revoke, requestId: 'revoke-1', ifRevision: granted.revision })).toEqual({});
    // The grant is gone either way, so asking again succeeds, on the old revision too.
    expect(await user.request('permission.grant.revoke', { ...revoke, requestId: 'revoke-1', ifRevision: granted.revision })).toEqual({});
    expect(await user.request('permission.grant.revoke', { ...revoke, requestId: 'revoke-2' })).toEqual({});
    expect((await user.request('permission.grant.list') as GrantPage).items).toEqual([]);

    // Without it the Host asks again.
    const asked = await write('input-3');
    const again = await pendingInteraction(user, sessionId);
    expect(again.kind).toBe('permission');
    await user.request('interaction.respond', { requestId: 'answer-3', interactionId: again.id, response: { kind: 'dismiss' } });
    await user.request('run.wait', { runId: asked });
  });
});

interface SettingsAnswer {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly revision: string;
  readonly workModeLocked: boolean;
}

describe('v2 Session settings served by the v1 implementation', () => {
  async function sessionWithSettings(role: RuntimeConnectionRole = 'user') {
    const host = await makeHost();
    const runtime = await host.start();
    const client = await connect(role, runtime, host.workspace);
    const { session } = await client.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;
    return {
      host, runtime, client, sessionId,
      read: async () => await client.request('session.settings.get', { sessionId }) as unknown as SettingsAnswer,
      change: async (requestId: string, patch: Record<string, unknown>, ifRevision?: string) => await client.request(
        'session.settings.update', { requestId, sessionId, patch, ...(ifRevision === undefined ? {} : { ifRevision }) },
      ) as unknown as SettingsAnswer,
      watch: async () => (await client.request('view.subscribe', {
        subscriptionId: 'main', target: { kind: 'session', sessionId },
      }) as unknown as { snapshot: { settings: Readonly<Record<string, unknown>> } }).snapshot.settings,
    };
  }

  it('changes what was chosen for a Session and clears a choice with null', async () => {
    const { read, change } = await sessionWithSettings();
    const before = await read();
    expect(before).toEqual({ settings: expect.any(Object), revision: expect.any(String), workModeLocked: false });

    const changed = await change('set-1', { permissionMode: 'plan', effort: 'high', maxIter: 12 });
    expect(changed.settings).toMatchObject({ permissionMode: 'plan', effort: 'high', maxIter: 12 });
    expect(changed.revision).not.toBe(before.revision);
    expect(await read()).toEqual(changed);

    const cleared = await change('set-2', { maxIter: null });
    expect(cleared.settings).toMatchObject({ permissionMode: 'plan', effort: 'high' });
    expect(cleared.settings).not.toHaveProperty('maxIter');
  });

  it('writes nothing when the settings changed since the revision a client read', async () => {
    const { read, change } = await sessionWithSettings();
    const before = await read();
    const first = await change('set-1', { effort: 'high' }, before.revision);
    expect(first.settings).toMatchObject({ effort: 'high' });

    for (const stale of [before.revision, 'not-a-revision', '007']) {
      await expect(change('set-2', { effort: 'low' }, stale))
        .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'revision_mismatch' });
    }
    expect(await read()).toEqual(first);
    expect((await change('set-3', { effort: 'low' }, first.revision)).settings).toMatchObject({ effort: 'low' });
  });

  it('answers a change sent again with the settings as they now stand', async () => {
    const { read, change } = await sessionWithSettings();
    const before = await read();
    const first = await change('set-1', { effort: 'high', maxIter: 12 }, before.revision);
    expect(await change('set-1', { effort: 'high', maxIter: 12 }, before.revision)).toEqual(first);

    const cleared = await change('set-2', { maxIter: null }, first.revision);
    expect(await change('set-2', { maxIter: null }, first.revision)).toEqual(cleared);
    expect(await read()).toEqual(cleared);
  });

  it('refuses a setting the contract does not name', async () => {
    const { host, client, read, change } = await sessionWithSettings();
    const before = await read();
    for (const patch of [
      { executionCwd: host.workspaceRoot }, { agentMode: 'sa' }, { permissionMode: 'anything' }, { maxIter: 0 }, { effort: '' },
    ]) {
      await expect(change('set-1', patch)).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    }
    expect(await read()).toEqual(before);
    await expect(client.request('session.settings.get', { sessionId: 'no-such-session' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
    await expect(client.request('session.settings.update', { requestId: 'set-2', sessionId: 'no-such-session', patch: {} }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
  });

  it.each(['owner', 'user'] as const)('sends a %s no Host path the Session was given', async (role) => {
    const { host, runtime, sessionId, read, watch } = await sessionWithSettings(role);
    await runtime.sessions.updateSettings(sessionId, { executionCwd: path.join(host.workspaceRoot, 'app'), effort: 'high' });

    const sent = [(await read()).settings, await watch()];
    expect(sent).toEqual([expect.objectContaining({ effort: 'high' }), expect.objectContaining({ effort: 'high' })]);
    expect(JSON.stringify(sent).toLowerCase()).not.toContain(path.basename(host.homeDir).toLowerCase());
    expect(JSON.stringify(sent)).not.toContain('executionCwd');
  });

  it('shows in the Session view what is in effect, and sends a change to those subscribed', async () => {
    const { client, read, change, watch } = await sessionWithSettings();
    const sent = notifications(client);
    // The Session chose nothing yet, so the view shows the Host's default.
    expect((await read()).settings).not.toHaveProperty('permissionMode');
    expect(await watch()).toMatchObject({ permissionMode: 'accept-edits' });

    await change('set-1', { permissionMode: 'plan' });
    await expect.poll(() => shown(sent, 'settings'), { timeout: 5000 }).toMatchObject({ permissionMode: 'plan' });
    await change('set-2', { permissionMode: null });
    await expect.poll(() => shown(sent, 'settings'), { timeout: 5000 }).toMatchObject({ permissionMode: 'accept-edits' });
  });
});

interface HistoryPage {
  readonly items: readonly { readonly id: string; readonly type: string; readonly state: string; readonly text: string; readonly textTotal?: number }[];
  readonly status: string;
  readonly issues: readonly unknown[];
  readonly nextCursor?: string;
  readonly newerCursor?: string;
  readonly locatedItemId?: string;
}
interface SearchAnswer {
  readonly items: readonly { readonly itemId: string; readonly role: string; readonly at?: number; readonly snippet: string }[];
}

describe('v2 history served by the v1 implementation', () => {
  const LONG = `start ${'0123456789'.repeat(2000)} end`;

  /** A Session that was asked each of `questions` in turn. The model answers `re: ` and the question, or `LONG` when asked for it. */
  async function sessionThatTalked(questions: readonly string[]) {
    const host = await makeModelHost((messages) => {
      const asked = JSON.stringify(messages.filter(message => message.role === 'user').at(-1)?.content ?? '');
      const question = questions.filter(candidate => asked.includes(candidate)).at(-1);
      const text = question === undefined ? 'done' : question.includes('long') ? LONG : `re: ${question}`;
      return { textBlocks: [{ type: 'text', text }], toolBlocks: [], thinkingBlocks: [] };
    });
    const runtime = await host.start();
    const client = await connect('user', runtime, host.workspace);
    const { session } = await client.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;
    let asked = 0;
    const ask = async (text: string): Promise<void> => {
      asked += 1;
      const { input } = await client.request('input.submit', { requestId: `ask-${asked}`, sessionId, text }) as InputAnswer;
      await client.request('run.wait', { runId: input.runId });
    };
    for (const question of questions) await ask(question);
    const read = async (params: Readonly<Record<string, unknown>> = {}, from = client): Promise<HistoryPage> => (
      await from.request('history.read', { sessionId, ...params }) as unknown as HistoryPage
    );
    return { host, runtime, client, sessionId, ask, read };
  }

  const said = (page: HistoryPage): string[] => page.items.map(item => `${item.type}: ${item.text}`);

  it('reads the saved conversation a page at a time, oldest first', async () => {
    const { host, runtime, read } = await sessionThatTalked(['one', 'two', 'three']);

    const newest = await read({ limit: 2 });
    expect(said(newest)).toEqual(['user: three', 'assistant: re: three']);
    expect(newest).toMatchObject({ status: 'resolved', issues: [], nextCursor: expect.any(String) });
    expect(newest.newerCursor).toBeUndefined();
    expect(newest.items.map(item => item.state)).toEqual(['settled', 'settled']);

    const middle = await read({ limit: 2, cursor: newest.nextCursor });
    const oldest = await read({ limit: 2, cursor: middle.nextCursor });
    expect([oldest, middle].flatMap(said)).toEqual(['user: one', 'assistant: re: one', 'user: two', 'assistant: re: two']);
    expect(oldest.nextCursor).toBeUndefined();
    // A cursor reads in either direction, and both ends of the conversation say so.
    expect(said(await read({ limit: 2, cursor: oldest.newerCursor }))).toEqual(said(middle));
    expect(new Set([newest, middle, oldest].flatMap(page => page.items.map(item => item.id))).size).toBe(6);

    const owner = await connect('owner', runtime, host.workspace);
    expect(said(await read({}, owner))).toEqual([oldest, middle, newest].flatMap(said));
    expect(JSON.stringify([newest, middle, oldest]).toLowerCase()).not.toContain(path.basename(host.homeDir).toLowerCase());
  });

  it('sends the end of a long text and the whole of it when asked by id', async () => {
    const { client, sessionId, read } = await sessionThatTalked(['a long answer please']);
    const answer = (await read()).items.find(item => item.type === 'assistant')!;
    expect(answer.textTotal).toBe(LONG.length);
    expect(answer.text.length).toBeLessThan(LONG.length);
    expect(LONG.endsWith(answer.text)).toBe(true);

    let whole = '';
    let cursor: string | undefined;
    do {
      const part = await client.request('item.read', { sessionId, itemId: answer.id, ...(cursor === undefined ? {} : { cursor }) }) as
        { text: string; total: number; nextCursor?: string };
      expect(part.total).toBe(LONG.length);
      whole += part.text;
      cursor = part.nextCursor;
    } while (cursor !== undefined);
    expect(whole).toBe(LONG);
  });

  it('finds what was said and reads the page around it', async () => {
    const { client, sessionId, read } = await sessionThatTalked(['one', 'the zebra crossing', 'three', 'four']);
    const { items } = await client.request('history.search', { sessionId, query: 'zebra', role: 'user' }) as unknown as SearchAnswer;
    expect(items).toEqual([{ itemId: expect.any(String), role: 'user', at: expect.any(Number), snippet: expect.stringContaining('zebra') }]);

    const found = await client.request('item.read', { sessionId, itemId: items[0]!.itemId }) as { text: string };
    expect(found.text).toBe('the zebra crossing');

    const around = await read({ limit: 2, around: { itemId: items[0]!.itemId } });
    expect(around.items.find(item => item.id === around.locatedItemId)).toMatchObject({ type: 'user', text: 'the zebra crossing' });
    expect(around).toMatchObject({ nextCursor: expect.any(String), newerCursor: expect.any(String) });
    expect((await client.request('history.search', { sessionId, query: 'giraffe' }) as unknown as SearchAnswer).items).toEqual([]);
  });

  it('refuses a place in the conversation it cannot read from', async () => {
    const { client, read } = await sessionThatTalked(['one', 'two']);
    const newest = await read({ limit: 2 });
    await expect(read({ cursor: newest.nextCursor, around: { itemId: newest.items[0]!.id } }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(read({ cursor: 'no-such-cursor' })).rejects.toMatchObject({ kodaxCode: 'resync_required' });
    await expect(read({ around: { itemId: newest.items[0]!.id } })).rejects.toMatchObject({ kodaxCode: 'resync_required' });
    await expect(client.request('history.read', { sessionId: 'no-such-session' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
    await expect(client.request('history.search', { sessionId: 'no-such-session', query: 'one' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });

  });

  it('keeps reading the conversation a cursor came from while the Session goes on', async () => {
    const { ask, read } = await sessionThatTalked(['one', 'two']);
    const newest = await read({ limit: 2 });
    await ask('three');

    expect(said(await read({ limit: 2, cursor: newest.nextCursor }))).toEqual(['user: one', 'assistant: re: one']);
    expect(said(await read({ limit: 2 }))).toEqual(['user: three', 'assistant: done']);
  });

  it('names each message the way the view does, for as long as the message lasts', async () => {
    const host = await makeModelHost((messages) => {
      const last = JSON.stringify(messages.at(-1)?.content ?? '');
      if (last.includes('tool_result')) return { textBlocks: [{ type: 'text', text: 'It is on Friday.' }], toolBlocks: [], thinkingBlocks: [] };
      return {
        textBlocks: [{ type: 'text', text: 'Let me look.' }], thinkingBlocks: [], stopReason: 'tool_use',
        toolBlocks: [{ type: 'tool_use', id: `call-${messages.length}`, name: 'read', input: { path: 'notes.txt' } }],
      };
    });
    const runtime = await host.start();
    const user = await connect('user', runtime, host.workspace);
    await writeFile(path.join(host.workspaceRoot, 'app', 'notes.txt'), 'The release is on Friday.');
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;
    const ask = async (requestId: string, text: string): Promise<void> => {
      const { input } = await user.request('input.submit', { requestId, sessionId, text }) as InputAnswer;
      await user.request('run.wait', { runId: input.runId });
    };
    const read = async (): Promise<HistoryPage> => await user.request('history.read', { sessionId }) as unknown as HistoryPage;
    await ask('ask-1', 'When is the release?');

    const first = await read();
    expect(first.items.map(item => item.type)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const { snapshot } = await user.request('view.subscribe', {
      subscriptionId: 'main', target: { kind: 'session', sessionId },
    }) as unknown as { readonly snapshot: Pick<HistoryPage, 'items'> };
    expect(first.items.map(item => item.id)).toEqual(first.items.map(item =>
      snapshot.items.find(shown => shown.type === item.type && shown.text === item.text)?.id));
    expect(first.items.map(item => item.id.slice(sessionId.length + 1).split(':', 1)[0]))
      .toEqual(['input', 'output', 'output', 'output']);

    // Saving the next turn rewrites the conversation; what was already said keeps its name.
    await ask('ask-2', 'And the one after?');
    expect((await read()).items.slice(0, 4).map(item => item.id)).toEqual(first.items.map(item => item.id));

    const tool = first.items[2]!;
    expect(await user.request('item.read', { sessionId, itemId: tool.id })).toMatchObject({ text: expect.stringContaining('Friday') });
    expect(await user.request('history.resolveTurn', { sessionId, turn: { kind: 'item', itemId: tool.id } }))
      .toMatchObject({ turn: { index: 0, excerpt: 'When is the release?' } });
    // An id in the same shape names nothing unless the saved conversation has that message.
    expect(await user.request('history.resolveTurn', { sessionId, turn: { kind: 'item', itemId: `${sessionId}:input:never-sent` } }))
      .toEqual({ unavailable: expect.any(String) });
    await expect(user.request('item.read', { sessionId, itemId: `${sessionId}:input:never-sent` }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
  }, 60_000);
});

interface CompactAnswer {
  readonly compacted: boolean;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

describe('v2 compaction served by the v1 implementation', () => {
  /** A Session with enough said in it that compacting it summarises something. `fail()` makes the model refuse until `recover()`. */
  async function sessionWorthCompacting() {
    let failing = false;
    const summaries: string[] = [];
    const host = await makeModelHost((messages) => {
      const asked = JSON.stringify(messages);
      // Only the request for a summary carries the instructions.
      if (!asked.includes('Keep the decisions.')) return undefined;
      if (failing) throw new Error('Summary provider unavailable');
      summaries.push(asked);
      const text = 'The user is preparing a release. Keep the release decisions and the evidence given for them.';
      return { textBlocks: [{ type: 'text', text }], toolBlocks: [], thinkingBlocks: [] };
    });
    const runtime = await host.start();
    const client = await connect('user', runtime, host.workspace);
    const { session } = await client.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;
    const compact = (requestId: string, from = client): Promise<CompactAnswer> => (
      from.request('session.compact', { requestId, sessionId, instructions: 'Keep the decisions.' }) as unknown as Promise<CompactAnswer>
    );
    const talk = async (): Promise<void> => {
      for (let turn = 0; turn < 3; turn += 1) {
        const { input } = await client.request('input.submit', {
          requestId: `talk-${turn}`, sessionId, text: `Release decision ${turn}. ${'Evidence for the release. '.repeat(600)}`,
        }) as InputAnswer;
        await client.request('run.wait', { runId: input.runId });
      }
      await client.request('session.settings.update', { requestId: 'settings-1', sessionId, patch: { compactionTriggerTokens: 5_000 } });
    };
    return {
      host, runtime, client, sessionId, compact, talk, summaries,
      fail: () => { failing = true; },
      recover: () => { failing = false; },
    };
  }

  it('summarises the conversation once for a request, however often it is sent', async () => {
    const { host, runtime, client, sessionId, compact, talk, summaries } = await sessionWorthCompacting();
    // Nothing was said yet, so there is nothing to summarise.
    expect(await compact('compact-0')).toEqual({ compacted: false, tokensBefore: expect.any(Number), tokensAfter: expect.any(Number) });
    await talk();

    const first = await compact('compact-1');
    // The answer says what happened and carries none of the conversation.
    expect(first).toEqual({ compacted: true, tokensBefore: expect.any(Number), tokensAfter: expect.any(Number) });
    expect(first.tokensAfter).toBeGreaterThan(0);
    expect(first.tokensBefore).toBeGreaterThan(0);
    expect(summaries).toHaveLength(1);

    const asked = host.calls();
    expect(await compact('compact-1')).toEqual(first);
    // The owner is the same person, so it is the same request.
    expect(await compact('compact-1', await connect('owner', runtime, host.workspace))).toEqual(first);
    expect(host.calls()).toBe(asked);

    client.close();
    await runtime.close();
    const restarted = await connect('user', await host.start(), host.workspace);
    expect(await compact('compact-1', restarted)).toEqual(first);
    expect(host.calls()).toBe(asked);
    // What was said can still be read.
    const { items } = await restarted.request('history.read', { sessionId }) as unknown as HistoryPage;
    expect(items.length).toBeGreaterThan(0);
  }, 60_000);

  it('answers the same request while it is still at work and refuses any other', async () => {
    const { host, client, sessionId, compact, talk } = await sessionWorthCompacting();
    await talk();
    const asked = host.calls();
    const held = host.hold();
    const first = compact('compact-1');
    await held.called;

    const again = compact('compact-1');
    await expect(compact('compact-2')).rejects.toMatchObject({ kodaxCode: 'conflict' });
    await expect(client.request('input.submit', { requestId: 'talk-late', sessionId, text: 'Do not start.' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });
    held.release();

    expect(await first).toMatchObject({ compacted: true });
    expect(await again).toEqual(await first);
    expect(host.calls() - asked).toBe(1);
  }, 60_000);

  it('reports a summary that could not be made as a failure, and the request can be sent again', async () => {
    const { client, compact, talk, fail, recover } = await sessionWorthCompacting();
    await talk();
    fail();
    await expect(compact('compact-1')).rejects.toMatchObject({
      kodaxCode: 'unavailable', reason: 'compaction_failed', message: expect.stringContaining('Summary provider unavailable'),
    });
    recover();
    expect(await compact('compact-1')).toMatchObject({ compacted: true });

    await expect(client.request('session.compact', { requestId: 'compact-9', sessionId: 'no-such-session' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
    await expect(client.request('session.compact', { requestId: 'compact-9', sessionId: 'any', instructions: '  ' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
  }, 60_000);
});

describe('v2 named tools and Run recovery served by the v1 implementation', () => {
  it('runs a tool a person named once per request, without the model', async () => {
    const host = await makeModelHost();
    const first = await host.start();
    const user = await connect('user', first, host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    await writeFile(path.join(host.workspaceRoot, 'app', 'notes.txt'), 'The release is on Friday.');
    const start = { requestId: 'tool-1', sessionId: session.id, tool: 'read', input: { path: 'notes.txt' }, text: 'read notes.txt' };

    const started = await user.request('run.startTool', start) as RunAnswer;
    expect(started.run).toMatchObject({ sessionId: session.id, inputId: 'tool-1' });
    const { run } = await user.request('run.wait', { runId: started.run.id }) as RunAnswer;
    expect(run.outcome).toMatchObject({ status: 'completed' });
    // What the tool read is in the conversation, under what the person typed.
    const { items } = await user.request('history.read', { sessionId: session.id }) as unknown as HistoryPage;
    expect(JSON.stringify(items)).toContain('read notes.txt');
    expect(JSON.stringify(items)).toContain('The release is on Friday.');

    expect(await user.request('run.startTool', start)).toEqual({ run });
    await expect(user.request('run.startTool', { ...start, input: { path: 'other.txt' } }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });
    user.close();
    await first.close();
    const after = await connect('user', await host.start(), host.workspace);
    expect(await after.request('run.startTool', start)).toEqual({ run });
    expect((await after.request('run.list', { sessionId: session.id }) as { items: RunFacts[] }).items).toHaveLength(1);
    expect(host.calls()).toBe(0);

    // A tool the Host does not have is a Run that failed, not a request that was refused.
    const unknown = await after.request('run.startTool', { ...start, requestId: 'tool-3', tool: 'no-such-tool' }) as RunAnswer;
    expect((await after.request('run.wait', { runId: unknown.run.id }) as RunAnswer).run.outcome).toMatchObject({ status: 'failed' });

    await expect(after.request('run.startTool', { ...start, requestId: 'tool-2', tool: ' ' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(after.request('run.startTool', { ...start, requestId: 'tool-2', input: 'notes.txt' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(after.request('run.startTool', { ...start, requestId: 'tool-2', sessionId: 'no-such-session' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
  }, 60_000);

  /**
   * A Session that talked once, and on disk two Runs of it the way a Host that
   * shut down part-way leaves one: stopped where the conversation stands now.
   */
  async function sessionWithRunsLeftWaiting() {
    const host = await makeModelHost();
    const first = await host.start();
    const before = await connect('user', first, host.workspace);
    const { session } = await before.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const { input } = await before.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Say done.' }) as InputAnswer;
    await before.request('run.wait', { runId: input.runId });
    before.close();
    await first.close();

    const configHome = path.join(host.homeDir, '.kodax');
    const saved = await new FileSessionStorage({ sessionsDir: path.join(configHome, 'sessions'), configHome }).load(session.id);
    if (saved?.lineage === undefined) throw new Error('Expected the Session to be saved with its lineage.');
    const endedStatus = (await readdir(host.homeDir, { recursive: true }))
      .find(file => file.endsWith(path.join('runs', input.runId!, 'status.json')));
    if (endedStatus === undefined) throw new Error('Expected the ended Run on disk.');
    const runsDir = path.join(host.homeDir, path.dirname(path.dirname(endedStatus)));
    const checkpoint = {
      version: 1, sessionId: session.id, turnId: 'turn-left-waiting', activeEntryId: saved.lineage.activeEntryId,
      messagesDigest: createHash('sha256').update(JSON.stringify(saved.messages)).digest('hex'),
    };
    const stoppedAt = '2026-11-21T00:00:00.000Z';
    for (const runId of ['run-left-waiting', 'run-left-behind']) {
      await mkdir(path.join(runsDir, runId), { recursive: true });
      await writeFile(path.join(runsDir, runId, 'status.json'), JSON.stringify({
        runId, sessionId: session.id, phase: 'recovering', provider: MODEL, model: 'host-rpc-test', startedAt: stoppedAt,
        origin: { principalId: 'a-client-that-is-gone', subject: 'person' },
        contextRecovery: { waitingSince: stoppedAt, checkpoint },
        _runtime: { revision: 1, owner: { ownerId: 'stopped-owner', runtimeId: 'stopped-runtime', pid: 2147483647, startedAt: stoppedAt } },
      }));
      await writeFile(path.join(runsDir, runId, 'generation-recovery.json'), JSON.stringify({
        version: 1, checkpoint, start: { prompt: 'Say done.', options: { provider: MODEL }, requiredBindings: [] },
        requiresCredential: false, requiresHostTools: false, actorTurnBaseline: [],
      }));
    }
    const runtime = await host.start();
    return { host, runtime, sessionId: session.id, endedRunId: input.runId! };
  }

  it('continues a Run a Host left waiting, for who started it, however often it is asked', async () => {
    const { host, runtime, endedRunId } = await sessionWithRunsLeftWaiting();
    const user = await connect('user', runtime, host.workspace);
    const waiting = await user.request('run.get', { runId: 'run-left-waiting' }) as RunAnswer;
    expect(waiting.run).toMatchObject({ phase: 'recovering' });
    expect(waiting.run.outcome).toBeUndefined();
    const asked = host.calls();

    // A service did not start it.
    await expect((await connect('service', runtime, host.workspace)).request('run.recover', { requestId: 'recover-1', runId: 'run-left-waiting' }))
      .rejects.toMatchObject({ kodaxCode: 'forbidden' });
    expect(host.calls()).toBe(asked);

    const { run } = await user.request('run.recover', { requestId: 'recover-1', runId: 'run-left-waiting' }) as RunAnswer;
    expect(run.id).toBe('run-left-waiting');
    const ended = await user.request('run.wait', { runId: 'run-left-waiting' }) as RunAnswer;
    expect(ended.run.outcome).toMatchObject({ status: 'completed' });
    expect(host.calls() - asked).toBe(1);

    // Asked again, by the same person from another client, it is answered as it stands.
    expect(await user.request('run.recover', { requestId: 'recover-1', runId: 'run-left-waiting' })).toEqual(ended);
    const owner = await connect('owner', runtime, host.workspace);
    expect(await owner.request('run.recover', { requestId: 'recover-2', runId: 'run-left-waiting' })).toEqual(ended);
    expect(await owner.request('run.recover', { requestId: 'recover-3', runId: endedRunId }))
      .toMatchObject({ run: { id: endedRunId, outcome: { status: 'completed' } } });
    expect(host.calls() - asked).toBe(1);

    // The conversation moved on, so the other Run cannot go on from where it stopped.
    await expect(user.request('run.recover', { requestId: 'recover-4', runId: 'run-left-behind' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });
    expect(host.calls() - asked).toBe(1);
    await expect(user.request('run.recover', { requestId: 'recover-5', runId: 'no-such-run' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
  }, 60_000);
});

type PolicyAnswer = { readonly policy: Record<string, unknown> };

describe('v2 Session policy served by the v1 implementation', () => {
  const POLICY = {
    tools: ['read'],
    budget: { maxIter: 2 },
    agentProfile: { name: 'Clerk', instructions: 'You are the release clerk.' },
    prompt: { context: [{ key: 'tone', kind: 'rule', text: 'Answer in one sentence.' }] },
    interactions: 'reject',
  };

  it('binds every Run of a Session to what its creator fixed, whoever submits it', async () => {
    let turns = 0;
    // A model that never stops asking for the file.
    const host = await makeModelHost(() => ({
      textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
      toolBlocks: [{ type: 'tool_use', id: `call-${turns += 1}`, name: 'read', input: { path: 'notes.txt' } }],
    }));
    const runtime = await host.start();
    const service = await connect('service', runtime, host.workspace);
    const user = await connect('user', runtime, host.workspace);
    await writeFile(path.join(host.workspaceRoot, 'app', 'notes.txt'), 'The release is on Friday.');

    const { session } = await service.request('session.create', { requestId: 'create-1', project: 'app', policy: POLICY }) as SessionAnswer;
    expect(await service.request('session.policy.get', { sessionId: session.id })).toEqual({ policy: POLICY });
    expect(await user.request('session.policy.get', { sessionId: session.id })).toEqual({ policy: POLICY });

    const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'When is the release?' }) as InputAnswer;
    await user.request('run.wait', { runId: input.runId });
    const asked = host.lastRequest();
    expect(asked.tools).toEqual(['read']);
    expect(asked.text).toContain('You are the release clerk.');
    expect(asked.text).toContain('Answer in one sentence.');
    expect(host.calls()).toBe(2);

    // A person naming a tool is held to the same list.
    const write = await user.request('run.startTool', {
      requestId: 'tool-1', sessionId: session.id, tool: 'write', input: { path: 'made.txt', content: 'x' }, text: 'write made.txt',
    }) as RunAnswer;
    expect((await user.request('run.wait', { runId: write.run.id }) as RunAnswer).run.outcome).toMatchObject({ status: 'failed' });
    expect(existsSync(path.join(host.workspaceRoot, 'app', 'made.txt'))).toBe(false);
    // It failed because the Session does not have the tool, not for want of an approval.
    expect(JSON.stringify(await user.request('history.read', { sessionId: session.id }))).toContain('write: Tool is not active');
    const read = await user.request('run.startTool', {
      requestId: 'tool-2', sessionId: session.id, tool: 'read', input: { path: 'notes.txt' }, text: 'read notes.txt',
    }) as RunAnswer;
    expect((await user.request('run.wait', { runId: read.run.id }) as RunAnswer).run.outcome).toMatchObject({ status: 'completed' });
  }, 60_000);

  it('takes a policy only from who may fix one, and only what the Host enforces', async () => {
    const host = await makeHost();
    const runtime = await host.start();
    const service = await connect('service', runtime, host.workspace);
    const user = await connect('user', runtime, host.workspace);

    await expect(user.request('session.create', { requestId: 'create-1', project: 'app', policy: { tools: ['read'] } }))
      .rejects.toMatchObject({ kodaxCode: 'forbidden', reason: 'param_not_allowed' });
    for (const policy of [
      { budget: { tokenBudget: 1000 } },
      { agentProfile: { name: 'Clerk', verification: {} } },
      { leases: [] },
      { prompt: { context: [{ key: 'Tone', kind: 'rule', text: 'x' }] } },
    ]) {
      await expect(service.request('session.create', { requestId: 'create-2', project: 'app', policy }))
        .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    }
    // Two entries under one key pass the shape and are refused by the Host that would apply them.
    const twice = { key: 'tone', kind: 'rule', text: 'Answer in one sentence.' };
    await expect(service.request('session.create', { requestId: 'create-2', project: 'app', policy: { prompt: { context: [twice, twice] } } }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });

    const create = { requestId: 'create-3', project: 'app', policy: POLICY };
    const { session } = await service.request('session.create', create) as SessionAnswer;
    expect(await service.request('session.create', create)).toMatchObject({ session: { id: session.id } });
    await expect(service.request('session.create', { ...create, policy: { ...POLICY, tools: ['read', 'bash'] } }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });

    // A Session nobody fixed anything for has the empty policy.
    const plain = await user.request('session.create', { requestId: 'create-4', project: 'app' }) as SessionAnswer;
    expect(await user.request('session.policy.get', { sessionId: plain.session.id })).toEqual({ policy: {} });
    await expect(user.request('session.policy.get', { sessionId: 'no-such-session' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
  });

  it('keeps the policy through Runs, a Host restart and a fork', async () => {
    const host = await makeModelHost();
    const first = await host.start();
    const service = await connect('service', first, host.workspace);
    const { session } = await service.request('session.create', { requestId: 'create-1', project: 'app', policy: POLICY }) as SessionAnswer;
    const { input } = await service.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Say done.' }) as InputAnswer;
    await service.request('run.wait', { runId: input.runId });
    service.close();
    await first.close();

    const second = await host.start();
    const user = await connect('user', second, host.workspace);
    expect(await user.request('session.policy.get', { sessionId: session.id })).toEqual({ policy: POLICY });
    const again = await user.request('input.submit', { requestId: 'input-2', sessionId: session.id, text: 'Say done again.' }) as InputAnswer;
    await user.request('run.wait', { runId: again.input.runId });
    expect(host.lastRequest().tools).toEqual(['read']);
    expect(host.lastRequest().text).toContain('You are the release clerk.');

    const fork = await user.request('session.fork', { requestId: 'fork-1', sessionId: session.id }) as SessionAnswer;
    expect(await user.request('session.policy.get', { sessionId: fork.session.id })).toEqual({ policy: POLICY });
    const recovered = await user.request('session.recover', { requestId: 'recover-1', sessionId: session.id }) as SessionAnswer;
    expect(await user.request('session.policy.get', { sessionId: recovered.session.id })).toEqual({ policy: POLICY });
  }, 60_000);
});

describe('the tool limit of the Host, served by the v1 implementation', () => {
  it('holds every Run and every named tool to the tools the Host allows, and follows a change for the next Run', async () => {
    let ceiling: readonly string[] | undefined = ['read', 'grep'];
    const host = await makeModelHost();
    const runtime = await host.start({ hostToolCeiling: () => ceiling });
    const service = await connect('service', runtime, host.workspace);
    const user = await connect('user', runtime, host.workspace);
    const offered = async (sessionId: string, requestId: string): Promise<string[]> => {
      const { input } = await user.request('input.submit', { requestId, sessionId, text: 'What is in the notes?' }) as InputAnswer;
      await user.request('run.wait', { runId: input.runId });
      return [...host.lastRunRequest().tools].sort();
    };

    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    expect(await offered(session.id, 'input-1')).toEqual(['grep', 'read']);
    const bash = await user.request('run.startTool', {
      requestId: 'tool-1', sessionId: session.id, tool: 'bash', input: { command: 'echo made > made.txt' }, text: 'run it',
    }) as RunAnswer;
    expect((await user.request('run.wait', { runId: bash.run.id }) as RunAnswer).run.outcome).toMatchObject({ status: 'failed' });
    expect(existsSync(path.join(host.workspaceRoot, 'app', 'made.txt'))).toBe(false);
    // Refused because the Host does not have the tool, not for want of an approval.
    expect(JSON.stringify(await user.request('history.read', { sessionId: session.id }))).toContain('bash: Tool is not active');

    // A Session policy narrows inside the Host limit and widens nothing.
    const fixed = await service.request('session.create', { requestId: 'create-2', project: 'app', policy: { tools: ['grep', 'bash'] } }) as SessionAnswer;
    expect(await offered(fixed.session.id, 'input-2')).toEqual(['grep']);

    ceiling = undefined;
    expect(await offered(session.id, 'input-3')).toContain('bash');
  }, 60_000);
});

describe('v2 limits and options of one Run served by the v1 implementation', () => {
  const TIME_LIMIT = { status: 'interrupted', effects: 'unknown', code: 'time_limit', message: 'The Run reached its time limit.' };

  /** Waits for a queued input to be given its Run. */
  async function runOf(client: HostRpcClient, sessionId: string, inputId: string): Promise<string> {
    return vi.waitFor(async () => {
      const { input } = await client.request('input.get', { sessionId, inputId }) as InputAnswer;
      if (input.runId === undefined) throw new Error(`Input ${inputId} has no Run yet.`);
      return input.runId;
    }, { timeout: 20_000, interval: 25 });
  }

  it('stops a Run that reaches the time limit of its Session or its own', async () => {
    const host = await makeModelHost();
    const runtime = await host.start();
    const service = await connect('service', runtime, host.workspace);
    const user = await connect('user', runtime, host.workspace);
    const roomy = await service.request('session.create', {
      requestId: 'create-1', project: 'app', policy: { budget: { maxDurationMs: 60_000 } },
    }) as SessionAnswer;
    const tight = await service.request('session.create', {
      requestId: 'create-2', project: 'app', policy: { budget: { maxDurationMs: 250 } },
    }) as SessionAnswer;
    const open = await service.request('session.create', { requestId: 'create-3', project: 'app' }) as SessionAnswer;

    // A Run that ends within its limit is not touched.
    const quick = await user.request('input.submit', { requestId: 'input-1', sessionId: roomy.session.id, text: 'Say done.' }) as InputAnswer;
    expect((await user.request('run.wait', { runId: quick.input.runId }) as RunAnswer).run.outcome).toMatchObject({ status: 'completed' });

    host.hold();
    // Whoever submits it, the limit of the Session holds.
    const slow = await user.request('input.submit', { requestId: 'input-2', sessionId: tight.session.id, text: 'Wait.' }) as InputAnswer;
    const stopped = await user.request('run.wait', { runId: slow.input.runId }) as RunAnswer;
    expect(stopped.run.outcome).toEqual(TIME_LIMIT);
    expect(stopped.run.stop).toEqual({ requestedAt: expect.any(Number), confirmed: true });

    // A service gives one Run a limit of its own, and the shorter of the two holds.
    const own = await service.request('input.submit', {
      requestId: 'input-3', sessionId: open.session.id, text: 'Wait.', budget: { maxDurationMs: 250 },
    }) as InputAnswer;
    expect((await service.request('run.wait', { runId: own.input.runId }) as RunAnswer).run.outcome).toEqual(TIME_LIMIT);
    const shorter = await service.request('input.submit', {
      requestId: 'input-4', sessionId: roomy.session.id, text: 'Wait.', budget: { maxDurationMs: 250 },
    }) as InputAnswer;
    expect((await service.request('run.wait', { runId: shorter.input.runId }) as RunAnswer).run.outcome).toEqual(TIME_LIMIT);
  }, 60_000);

  it('lets a service narrow one Run and never widen what the Session fixed', async () => {
    let turns = 0;
    // A model that never stops asking for the file.
    const host = await makeModelHost(() => ({
      textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
      toolBlocks: [{ type: 'tool_use', id: `call-${turns += 1}`, name: 'read', input: { path: 'notes.txt' } }],
    }));
    const runtime = await host.start();
    const service = await connect('service', runtime, host.workspace);
    const user = await connect('user', runtime, host.workspace);
    await writeFile(path.join(host.workspaceRoot, 'app', 'notes.txt'), 'The release is on Friday.');
    const tone = { key: 'tone', kind: 'rule', text: 'Answer in one sentence.' };
    const order = { key: 'order', kind: 'reference', text: 'Order 42 shipped on Friday.' };
    const format = { key: 'format', kind: 'rule', text: 'Give the date as a weekday.' };
    const { session } = await service.request('session.create', {
      requestId: 'create-1', project: 'app', policy: { budget: { maxIter: 2 }, prompt: { context: [tone] } },
    }) as SessionAnswer;

    const modelTurns = async (requestId: string, options: Record<string, unknown>): Promise<number> => {
      const before = host.calls();
      const { input } = await service.request('input.submit', { requestId, sessionId: session.id, text: 'When is the release?', ...options }) as InputAnswer;
      await service.request('run.wait', { runId: input.runId });
      return host.calls() - before;
    };
    expect(await modelTurns('input-1', { budget: { maxIter: 1 } })).toBe(1);
    expect(await modelTurns('input-2', {})).toBe(2);
    expect(await modelTurns('input-3', { budget: { maxIter: 5 } })).toBe(2);

    // What the Run adds is read after what the Session fixed.
    await modelTurns('input-4', { budget: { maxIter: 1 }, prompt: { context: [format, order] } });
    const asked = host.lastRequest().text;
    expect(asked.indexOf(tone.text)).toBeGreaterThan(-1);
    expect(asked.indexOf(format.text)).toBeGreaterThan(asked.indexOf(tone.text));
    expect(asked).toContain(order.text);
    // The next Run is not given them again: it is told that they no longer hold. What the Session fixed is said once.
    await modelTurns('input-5', { budget: { maxIter: 1 } });
    const next = host.lastRequest().text;
    const times = (text: string, part: string): number => text.split(part).length - 1;
    expect(times(next, format.text)).toBe(times(asked, format.text));
    expect(times(next, order.text)).toBe(times(asked, order.text));
    expect(times(next, tone.text)).toBe(1);
    expect(asked).not.toContain('No longer available');
    expect(next).toMatch(/No longer available: application rule format\b/);
    expect(next).toMatch(/No longer available: application reference order\b/);

    // Sent again it is the same input; with other options it is another intent under the same id.
    const again = { requestId: 'input-1', sessionId: session.id, text: 'When is the release?' };
    const calls = host.calls();
    expect(await service.request('input.submit', { ...again, budget: { maxIter: 1 } }))
      .toMatchObject({ input: { id: 'input-1', state: 'submitted' } });
    await expect(service.request('input.submit', { ...again, budget: { maxIter: 2 } })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    await expect(service.request('input.submit', again)).rejects.toMatchObject({ kodaxCode: 'conflict' });

    // A Run may not restate an entry of the Session.
    await expect(service.request('input.submit', {
      requestId: 'input-6', sessionId: session.id, text: 'When?', prompt: { context: [{ ...tone, text: 'Answer at length.' }] },
    })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    // Somebody using the Session does not set what its Runs are held to.
    for (const options of [{ budget: { maxIter: 1 } }, { prompt: { context: [order] } }]) {
      await expect(user.request('input.submit', { requestId: 'input-7', sessionId: session.id, text: 'When?', ...options }))
        .rejects.toMatchObject({ kodaxCode: 'forbidden', reason: 'param_not_allowed' });
    }
    await expect(service.request('input.submit', {
      requestId: 'input-8', sessionId: session.id, text: 'Hurry.', delivery: 'steer', targetRunId: 'some-run', budget: { maxIter: 1 },
    })).rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'run_options_not_allowed' });
    expect(host.calls()).toBe(calls);
  }, 60_000);

  it('gives a waiting input with options a Run of its own', async () => {
    const host = await makeModelHost();
    const runtime = await host.start();
    const service = await connect('service', runtime, host.workspace);
    const { session } = await service.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const held = host.hold();
    const first = await service.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Wait.' }) as InputAnswer;
    await held.called;

    const later = { sessionId: session.id, delivery: 'after_turn' };
    const second = { ...later, requestId: 'input-2', text: 'Then this.', budget: { maxIter: 1 } };
    expect(await service.request('input.submit', second)).toEqual({ input: { id: 'input-2', state: 'queued' } });
    expect(await service.request('input.submit', second)).toEqual({ input: { id: 'input-2', state: 'queued' } });
    await expect(service.request('input.submit', { ...second, budget: { maxIter: 2 } })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    await service.request('input.submit', { ...later, requestId: 'input-3', text: 'And this.' });
    await service.request('input.submit', { ...later, requestId: 'input-4', text: 'And that.' });

    held.release();
    await service.request('run.wait', { runId: first.input.runId });
    const own = await runOf(service, session.id, 'input-2');
    const shared = await runOf(service, session.id, 'input-3');
    expect(await runOf(service, session.id, 'input-4')).toBe(shared);
    expect(own).not.toBe(first.input.runId);
    // What was asked for the Run of one input does not bind the inputs behind it.
    expect(shared).not.toBe(own);
    await service.request('run.wait', { runId: shared });
    expect((await service.request('run.list', { sessionId: session.id }) as { items: RunFacts[] }).items).toHaveLength(3);
  }, 60_000);
});

describe('v2 Sessions that do not wait for a person, served by the v1 implementation', () => {
  const QUESTION = {
    question: 'Which colour?',
    options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }],
  };
  // Writing a project's own KodaX configuration always needs a person's answer.
  const WRITE = { path: '.kodax/note.txt', content: 'note' };
  const policyOf = (client: HostRpcClient, sessionId: string): Promise<unknown> => client.request('session.policy.get', { sessionId });

  it('answers a question and an approval at once in a Session a service created', async () => {
    let turn = callsToolOnce('ask_user_question', QUESTION);
    const host = await makeModelHost(messages => turn(messages));
    const runtime = await host.start();
    const service = await connect('service', runtime, host.workspace);
    const user = await connect('user', runtime, host.workspace);
    const create = { requestId: 'create-1', project: 'app' };
    const { session } = await service.request('session.create', create) as SessionAnswer;
    expect(await policyOf(user, session.id)).toEqual({ policy: { interactions: 'reject' } });
    expect(await service.request('session.create', create)).toMatchObject({ session: { id: session.id } });
    const sent = notifications(user);
    await user.request('view.subscribe', { subscriptionId: 'main', target: { kind: 'session', sessionId: session.id } });

    // Whoever submits the input. The model is told that nobody is there to ask, and goes on.
    const asked = await user.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Ask me.' }) as InputAnswer;
    expect((await user.request('run.wait', { runId: asked.input.runId }) as RunAnswer).run.outcome).toMatchObject({ status: 'completed' });
    expect(host.lastRequest().text).toContain('non_interactive');

    turn = callsToolOnce('write', WRITE);
    const wrote = await user.request('input.submit', { requestId: 'input-2', sessionId: session.id, text: 'Take a note.' }) as InputAnswer;
    expect((await user.request('run.wait', { runId: wrote.input.runId }) as RunAnswer).run.outcome).toMatchObject({ status: 'completed' });
    expect(existsSync(path.join(host.workspaceRoot, 'app', WRITE.path))).toBe(false);
    expect(host.lastRequest().text).toContain('needs a person');

    // Nothing was put in front of a person at any time.
    const shownToAPerson = sent.flatMap(frame => (frame.params.ops ?? []) as readonly { key?: string; value?: unknown }[])
      .filter(op => op.key === 'interactions' && Array.isArray(op.value) && op.value.length > 0);
    expect(shownToAPerson).toEqual([]);
    expect(await user.request('interaction.list', { sessionId: session.id })).toEqual({ items: [] });
  }, 60_000);

  it('waits where the creator said so and where a person created the Session', async () => {
    const host = await makeModelHost(callsToolOnce('ask_user_question', QUESTION));
    const runtime = await host.start();
    const service = await connect('service', runtime, host.workspace);
    const user = await connect('user', runtime, host.workspace);
    const answerRed = (interactionId: string, requestId: string) => user.request('interaction.respond', {
      requestId, interactionId, response: { kind: 'question', answer: 'red' },
    });

    const waiting = await service.request('session.create', {
      requestId: 'create-1', project: 'app', policy: { interactions: 'wait' },
    }) as SessionAnswer;
    expect(await policyOf(user, waiting.session.id)).toEqual({ policy: { interactions: 'wait' } });
    const first = await service.request('input.submit', { requestId: 'input-1', sessionId: waiting.session.id, text: 'Ask me.' }) as InputAnswer;
    expect(await answerRed((await pendingInteraction(user, waiting.session.id)).id, 'answer-1')).toEqual({ status: 'answered' });
    expect((await user.request('run.wait', { runId: first.input.runId }) as RunAnswer).run.outcome).toMatchObject({ status: 'completed' });

    const own = await user.request('session.create', { requestId: 'create-2', project: 'app' }) as SessionAnswer;
    expect(await policyOf(user, own.session.id)).toEqual({ policy: {} });
    const second = await user.request('input.submit', { requestId: 'input-2', sessionId: own.session.id, text: 'Ask me.' }) as InputAnswer;
    expect(await answerRed((await pendingInteraction(user, own.session.id)).id, 'answer-2')).toEqual({ status: 'answered' });
    expect((await user.request('run.wait', { runId: second.input.runId }) as RunAnswer).run.outcome).toMatchObject({ status: 'completed' });

    // The owner may say that its Session does not wait either.
    const owner = await connect('owner', runtime, host.workspace);
    const quiet = await owner.request('session.create', {
      requestId: 'create-3', project: 'app', policy: { interactions: 'reject' },
    }) as SessionAnswer;
    const third = await owner.request('input.submit', { requestId: 'input-3', sessionId: quiet.session.id, text: 'Ask me.' }) as InputAnswer;
    expect((await owner.request('run.wait', { runId: third.input.runId }) as RunAnswer).run.outcome).toMatchObject({ status: 'completed' });
    expect(host.lastRequest().text).toContain('non_interactive');

    await expect(service.request('session.create', { requestId: 'create-4', project: 'app', policy: { interactions: 'ask' } }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
  }, 60_000);
});

describe('v2 Sessions created as an installed Agent, served by the v1 implementation', () => {
  const CLERK = { name: 'clerk', instructions: 'You are the release clerk.' };

  async function installAgent(host: TestHost, name: string, frontmatter: readonly string[], instructions: string): Promise<void> {
    const directory = path.join(host.homeDir, '.kodax', 'agents');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${name}.md`), [
      '---', `name: ${name}`, `description: The ${name}`, ...frontmatter, '---', instructions,
    ].join('\n'));
  }

  it('lists the Agents a Session can be created as', async () => {
    const host = await makeHost();
    await installAgent(host, 'clerk', ['tools: [read, grep]', 'model: host-rpc-test', 'effort: high'], CLERK.instructions);
    await installAgent(host, 'scribe', [], 'You are the scribe.');
    const runtime = await host.start();

    for (const role of ['owner', 'user', 'service'] as const) {
      const answer = await (await connect(role, runtime, host.workspace)).request('agent.list') as {
        readonly items: ReadonlyArray<{ readonly name: string }>;
      };
      expect([...answer.items].sort((left, right) => left.name.localeCompare(right.name))).toEqual([
        { name: 'clerk', description: 'The clerk', tools: ['read', 'grep'], model: 'host-rpc-test', effort: 'high' },
        { name: 'scribe', description: 'The scribe' },
      ]);
    }
  });

  it('gives every Run the persona, the tools and the model of the Agent it was created as', async () => {
    const host = await makeModelHost();
    await installAgent(host, 'clerk', ['tools: [read, grep]', 'model: host-rpc-test', 'effort: high'], CLERK.instructions);
    const first = await host.start();
    const user = await connect('user', first, host.workspace);
    const create = { requestId: 'create-1', project: 'app', agent: 'clerk' };

    // A person may choose an Agent: it is one the owner of the Host installed.
    const { session } = await user.request('session.create', create) as SessionAnswer;
    expect(await user.request('session.policy.get', { sessionId: session.id })).toEqual({
      policy: { tools: ['read', 'grep'], agentProfile: CLERK },
    });
    const { settings } = await user.request('session.settings.get', { sessionId: session.id }) as unknown as SettingsAnswer;
    expect(settings).toMatchObject({ model: 'host-rpc-test', effort: 'high' });

    const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Say done.' }) as InputAnswer;
    expect((await user.request('run.wait', { runId: input.runId }) as RunAnswer).run.outcome).toMatchObject({ status: 'completed' });
    expect([...host.lastRequest().tools].sort()).toEqual(['grep', 'read']);
    expect(host.lastRequest().text).toContain(CLERK.instructions);

    // The Session keeps the Agent it was created as, whatever becomes of the Agent's file.
    await installAgent(host, 'clerk', ['tools: [read, grep, bash]'], 'You are somebody else.');
    await installAgent(host, 'scribe', [], 'You are the scribe.');
    expect(await user.request('session.create', create)).toMatchObject({ session: { id: session.id } });
    await expect(user.request('session.create', { ...create, agent: 'scribe' })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    user.close();
    await first.close();

    const second = await host.start();
    const again = await connect('user', second, host.workspace);
    expect(await again.request('session.policy.get', { sessionId: session.id })).toEqual({
      policy: { tools: ['read', 'grep'], agentProfile: CLERK },
    });
    const next = await again.request('input.submit', { requestId: 'input-2', sessionId: session.id, text: 'Say done again.' }) as InputAnswer;
    await again.request('run.wait', { runId: next.input.runId });
    expect([...host.lastRequest().tools].sort()).toEqual(['grep', 'read']);
    expect(host.lastRequest().text).toContain(CLERK.instructions);
    expect(host.lastRequest().text).not.toContain('You are somebody else.');
  }, 60_000);

  it('lets the Agent narrow what the creator fixed and widen none of it', async () => {
    const host = await makeHost();
    await installAgent(host, 'clerk', ['tools: [read, grep]'], CLERK.instructions);
    const runtime = await host.start();
    const service = await connect('service', runtime, host.workspace);
    const user = await connect('user', runtime, host.workspace);

    const { session } = await service.request('session.create', {
      requestId: 'create-1', project: 'app', agent: 'clerk', policy: { tools: ['grep', 'bash'], budget: { maxIter: 3 } },
    }) as SessionAnswer;
    expect(await user.request('session.policy.get', { sessionId: session.id })).toEqual({
      policy: { tools: ['grep'], budget: { maxIter: 3 }, agentProfile: CLERK, interactions: 'reject' },
    });

    await expect(service.request('session.create', {
      requestId: 'create-2', project: 'app', agent: 'clerk', policy: { agentProfile: { name: 'Other' } },
    })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(user.request('session.create', { requestId: 'create-3', project: 'app', agent: 'nobody' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
    // Neither refusal left a Session behind: the same requests are free to succeed later.
    expect(await user.request('session.create', { requestId: 'create-3', project: 'app', agent: 'clerk' }))
      .toMatchObject({ session: { id: expect.any(String) } });
  });
});

describe('v2 commands a person runs by name, served by the v1 implementation', () => {
  type CommandAnswer = { readonly run?: RunFacts; readonly success?: boolean; readonly message?: string };

  it('starts one Run for a command, however often it is sent', async () => {
    const host = await makeModelHost();
    const commands = path.join(host.homeDir, '.kodax', 'commands');
    await mkdir(commands, { recursive: true });
    await writeFile(path.join(commands, 'release.md'), [
      '---', 'name: release', 'description: Check the release', '---', 'Check the actual release gate.',
    ].join('\n'));
    const first = await host.start();
    const user = await connect('user', first, host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const execute = { requestId: 'command-1', sessionId: session.id, name: 'release', args: ['auth'] };

    const held = host.hold();
    const started = await user.request('command.execute', execute) as CommandAnswer;
    expect(started).toEqual({ run: expect.objectContaining({ sessionId: session.id, inputId: 'command-1' }) });
    await held.called;
    // Sent again while its Run is at work, the command is answered with that Run, not refused because the Session is busy.
    expect((await user.request('command.execute', execute) as CommandAnswer).run?.id).toBe(started.run!.id);
    await expect(user.request('command.execute', { ...execute, args: ['billing'] })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    // Any other command waits for the Session, except one that only asks what a command is for.
    await expect(user.request('command.execute', { ...execute, requestId: 'command-2' })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    expect(await user.request('command.execute', { ...execute, requestId: 'command-3', args: ['--help'] })).toEqual({
      success: true, message: expect.stringContaining('Check the release'),
    });
    held.release();

    const { run } = await user.request('run.wait', { runId: started.run!.id }) as RunAnswer;
    expect(run.outcome).toMatchObject({ status: 'completed' });
    // The model was given the command's instructions; the conversation shows what the person typed.
    expect(host.lastRequest().text).toContain('Check the actual release gate.');
    const { items } = await user.request('history.read', { sessionId: session.id }) as unknown as HistoryPage;
    expect(JSON.stringify(items)).toContain('/release auth');

    const modelCalls = host.calls();
    expect(await user.request('command.execute', execute)).toEqual({ run });
    user.close();
    await first.close();
    const after = await connect('user', await host.start(), host.workspace);
    expect(await after.request('command.execute', execute)).toEqual({ run });
    await expect(after.request('command.execute', { ...execute, args: ['billing'] })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    expect((await after.request('run.list', { sessionId: session.id }) as { items: RunFacts[] }).items).toHaveLength(1);
    expect(host.calls()).toBe(modelCalls);

    await expect(after.request('command.execute', { ...execute, requestId: 'command-4', name: 'no-such-command' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
    await expect(after.request('command.execute', { ...execute, requestId: 'command-4', name: ' ' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(after.request('command.execute', { ...execute, requestId: 'command-4', sessionId: 'no-such-session' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
  }, 60_000);

  it('runs a command the Host finishes itself once per request', async () => {
    const host = await makeHost();
    const runtime = await host.start();
    const extension = path.join(host.homeDir, 'note-command.mjs');
    await writeFile(extension, [
      "import { appendFile } from 'node:fs/promises';",
      'export default api => api.registerCommand({',
      "  name: 'note', description: 'Writes a note', execution: 'configuration',",
      '  handler: async (args, context) => {',
      "    await appendFile(context.workingDirectory + '/noted.txt', args.join(' ') + ';');",
      "    return { message: 'Noted ' + args.join(' ') };",
      '  },',
      '});',
    ].join('\n'));
    await getActiveExtensionRuntime()!.loadExtension(extension);
    const user = await connect('user', runtime, host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const execute = { requestId: 'command-1', sessionId: session.id, name: 'note', args: ['first'] };
    const noted = (): Promise<string> => readFile(path.join(host.workspaceRoot, 'app', 'noted.txt'), 'utf8');

    const answer = await user.request('command.execute', execute);
    expect(answer).toEqual({ success: true, message: 'Noted first' });
    expect(await user.request('command.execute', execute)).toEqual(answer);
    expect(await noted()).toBe('first;');

    await expect(user.request('command.execute', { ...execute, args: ['second'] })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    expect(await user.request('command.execute', { ...execute, requestId: 'command-2', args: ['second'] }))
      .toEqual({ success: true, message: 'Noted second' });
    expect(await user.request('command.execute', { ...execute, requestId: 'command-3', args: ['help'] }))
      .toEqual({ success: true, message: expect.stringContaining('Writes a note') });
    expect(await noted()).toBe('first;second;');
  });
});

describe('v2 Session goals served by the v1 implementation', () => {
  type GoalAnswer = { readonly goal?: { readonly id: string; readonly status: string; readonly [field: string]: unknown } };

  it('sets, pauses, resumes and clears the goal of a Session, each safe to repeat', async () => {
    const host = await makeModelHost();
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;
    const create = { requestId: 'goal-1', sessionId, objective: 'Ship the release', tokenBudget: 50_000 };

    expect(await user.request('session.goal.get', { sessionId })).toEqual({});
    // A goal is set on a conversation, and this Session has none yet.
    await expect(user.request('session.goal.create', create)).rejects.toMatchObject({ kodaxCode: 'conflict' });
    const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId, text: 'Say done.' }) as InputAnswer;
    await user.request('run.wait', { runId: input.runId });

    const { goal } = await user.request('session.goal.create', create) as GoalAnswer;
    expect(goal).toEqual({
      id: expect.any(String), objective: 'Ship the release', status: 'active', tokenBudget: 50_000,
      tokensUsed: expect.any(Number), timeUsedSeconds: expect.any(Number),
      createdAt: expect.any(Number), updatedAt: expect.any(Number),
    });
    expect(await user.request('session.goal.create', create)).toEqual({ goal });
    expect(await user.request('session.goal.get', { sessionId })).toEqual({ goal });
    // One goal at a time: another one is refused while this one stands.
    await expect(user.request('session.goal.create', { ...create, requestId: 'goal-2', objective: 'Write the notes' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });
    await expect(user.request('session.goal.create', { ...create, requestId: 'goal-2', tokenBudget: 60_000 }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });

    const paused = await user.request('session.goal.pause', { requestId: 'pause-1', sessionId }) as GoalAnswer;
    expect(paused.goal).toMatchObject({ id: goal!.id, status: 'paused' });
    expect(await user.request('session.goal.pause', { requestId: 'pause-1', sessionId })).toEqual(paused);
    const resumed = await user.request('session.goal.resume', { requestId: 'resume-1', sessionId }) as GoalAnswer;
    expect(resumed.goal).toMatchObject({ id: goal!.id, status: 'active' });
    expect(await user.request('session.goal.resume', { requestId: 'resume-1', sessionId })).toEqual(resumed);

    expect(await user.request('session.goal.clear', { requestId: 'clear-1', sessionId })).toEqual({});
    expect(await user.request('session.goal.clear', { requestId: 'clear-1', sessionId })).toEqual({});
    expect(await user.request('session.goal.get', { sessionId })).toEqual({});
    // With no goal there is nothing to pause or resume.
    await expect(user.request('session.goal.pause', { requestId: 'pause-2', sessionId })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    await expect(user.request('session.goal.resume', { requestId: 'resume-2', sessionId })).rejects.toMatchObject({ kodaxCode: 'conflict' });

    await expect(user.request('session.goal.create', { ...create, requestId: 'goal-3', objective: ' ' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(user.request('session.goal.create', { ...create, requestId: 'goal-3', tokenBudget: 0 }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(user.request('session.goal.get', { sessionId: 'no-such-session' })).rejects.toMatchObject({ kodaxCode: 'not_found' });
  }, 60_000);
});

describe('v2 conversation tree served by the v1 implementation', () => {
  type TreeEntry = {
    readonly id: string; readonly type: string; readonly parentId?: string; readonly role?: string;
    readonly preview?: string; readonly targetId?: string; readonly label?: string; readonly createdAt?: number;
  };
  type Tree = { readonly activeEntryId?: string; readonly items: readonly TreeEntry[]; readonly nextCursor?: string };

  async function conversation() {
    const host = await makeModelHost();
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;
    expect(await user.request('session.lineage.get', { sessionId })).toEqual({ items: [] });
    for (const [index, text] of ['First.', 'Second.'].entries()) {
      const { input } = await user.request('input.submit', { requestId: `input-${index}`, sessionId, text }) as InputAnswer;
      await user.request('run.wait', { runId: input.runId });
    }
    const tree = (): Promise<Tree> => user.request('session.lineage.get', { sessionId }) as Promise<Tree>;
    const messages = (await tree()).items.filter(entry => entry.type === 'message');
    return { host, user, sessionId, tree, messages };
  }

  it('reads the tree a page at a time and labels an entry', async () => {
    const { user, sessionId, tree, messages } = await conversation();

    expect(messages.map(entry => entry.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[0]).toEqual({ id: expect.any(String), type: 'message', role: 'user', preview: 'First.', createdAt: expect.any(Number) });
    expect(messages[1]!.parentId).toBe(messages[0]!.id);
    expect((await tree()).activeEntryId).toBe(messages[3]!.id);

    const all = (await tree()).items;
    const first = await user.request('session.lineage.get', { sessionId, limit: 1 }) as Tree;
    expect(first).toEqual({ activeEntryId: messages[3]!.id, items: [all[0]], nextCursor: all[0]!.id });
    const rest = await user.request('session.lineage.get', { sessionId, cursor: first.nextCursor }) as Tree;
    expect(rest.items).toEqual(all.slice(1));
    expect(rest.nextCursor).toBeUndefined();
    await expect(user.request('session.lineage.get', { sessionId, cursor: 'no-such-entry' }))
      .rejects.toMatchObject({ kodaxCode: 'resync_required' });

    const labelled = await user.request('session.lineage.label', {
      requestId: 'label-1', sessionId, entry: messages[1]!.id, label: 'checkpoint',
    }) as { readonly entry: TreeEntry };
    expect(labelled.entry).toMatchObject({ type: 'label', targetId: messages[1]!.id, label: 'checkpoint' });
    expect((await tree()).items.at(-1)).toEqual(labelled.entry);
    // Sent again, it answers with the entry that recorded the label and records nothing more.
    const entries = (await tree()).items.length;
    expect(await user.request('session.lineage.label', {
      requestId: 'label-1', sessionId, entry: messages[1]!.id, label: 'checkpoint',
    })).toEqual(labelled);
    expect((await tree()).items).toHaveLength(entries);
    // An entry is named by its id or by its label.
    const removal = { requestId: 'label-2', sessionId, entry: 'checkpoint' };
    const removed = await user.request('session.lineage.label', removal) as { readonly entry: TreeEntry };
    expect(removed.entry).toMatchObject({ type: 'label', targetId: messages[1]!.id });
    expect(removed.entry.label).toBeUndefined();
    expect(await user.request('session.lineage.label', { ...removal, entry: messages[1]!.id })).toEqual(removed);
    expect((await tree()).items).toHaveLength(entries + 1);

    await expect(user.request('session.lineage.label', { requestId: 'label-3', sessionId, entry: 'no-such-entry', label: 'x' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });
    await expect(user.request('session.lineage.label', { requestId: 'label-3', sessionId, entry: messages[1]!.id, label: ' ' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(user.request('session.lineage.get', { sessionId: 'no-such-session' })).rejects.toMatchObject({ kodaxCode: 'not_found' });
  }, 60_000);

  it('moves the conversation to another entry, once however often it is asked', async () => {
    const { host, user, sessionId, tree, messages } = await conversation();

    const first = { requestId: 'select-1', sessionId, entry: messages[1]!.id, ifActiveEntryId: messages[3]!.id };
    const moved = await user.request('session.branch.select', first) as SessionAnswer;
    expect(moved.session).toMatchObject({ id: sessionId, messageCount: 2 });
    expect((await tree()).activeEntryId).toBe(messages[1]!.id);
    expect(await user.request('session.branch.select', first)).toEqual(moved);

    // Leaving a branch with a summary hangs the summary under the entry gone to.
    await user.request('session.branch.select', {
      requestId: 'select-2', sessionId, entry: messages[3]!.id, ifActiveEntryId: messages[1]!.id,
    });
    const third = { requestId: 'select-3', sessionId, entry: messages[1]!.id, summarize: true, ifActiveEntryId: messages[3]!.id };
    await user.request('session.branch.select', third);
    const summarized = await tree();
    const summary = summarized.items.at(-1)!;
    expect(summary).toMatchObject({ type: 'branch_summary', parentId: messages[1]!.id });
    expect(summarized.activeEntryId).toBe(summary.id);
    await user.request('session.branch.select', third);
    expect(await tree()).toEqual(summarized);
    // The conversation has moved on since the first switch was asked for, so sent again late it is refused.
    await expect(user.request('session.branch.select', first)).rejects.toMatchObject({ kodaxCode: 'resync_required' });
    expect(await tree()).toEqual(summarized);

    await expect(user.request('session.branch.select', {
      requestId: 'select-4', sessionId, entry: 'no-such-entry', ifActiveEntryId: summary.id,
    })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    // The conversation stays where it is while a Run works on it.
    const held = host.hold();
    const { input } = await user.request('input.submit', { requestId: 'input-held', sessionId, text: 'Go on.' }) as InputAnswer;
    await held.called;
    await expect(user.request('session.branch.select', {
      requestId: 'select-5', sessionId, entry: messages[1]!.id, ifActiveEntryId: summary.id,
    })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    await expect(user.request('session.notice.append', { requestId: 'notice-held', sessionId, text: 'Later.' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });
    held.release();
    await user.request('run.wait', { runId: input.runId });
  }, 60_000);

  it('adds a notice to the conversation once per request', async () => {
    const { user, sessionId, tree } = await conversation();
    const notice = { requestId: 'notice-1', sessionId, text: 'Doctor: all good.', source: 'doctor' };

    const added = await user.request('session.notice.append', notice) as { readonly itemId: string };
    expect(added).toEqual({ itemId: expect.any(String) });
    expect(await user.request('session.notice.append', notice)).toEqual(added);
    const other = await user.request('session.notice.append', { ...notice, requestId: 'notice-2' }) as { readonly itemId: string };
    expect(other.itemId).not.toBe(added.itemId);
    expect((await tree()).items.filter(entry => entry.type === 'client_notice').map(entry => entry.id))
      .toEqual([added.itemId, other.itemId]);
    const { snapshot } = await user.request('view.subscribe', {
      subscriptionId: 'main', target: { kind: 'session', sessionId },
    }) as unknown as ViewFrame;
    expect(snapshot!.items).toContainEqual(expect.objectContaining({ id: added.itemId, type: 'info', text: 'Doctor: all good.' }));
    // The model never reads a notice, so the conversation it sees is as long as before.
    expect((await user.request('session.get', { sessionId }) as SessionAnswer).session.messageCount).toBe(4);

    await expect(user.request('session.notice.append', { ...notice, requestId: 'notice-3', text: ' ' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(user.request('session.notice.append', { ...notice, sessionId: 'no-such-session' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
  }, 60_000);
});

describe('v2 turns, forks and rewinds served by the v1 implementation', () => {
  type Turn = { readonly ref: string; readonly index: number; readonly excerpt: string; readonly hasLaterTurn: boolean };
  type TurnAnswer = { readonly turn?: Turn; readonly unavailable?: string };
  type Tree = {
    readonly activeEntryId?: string;
    readonly items: readonly { readonly id: string; readonly type: string; readonly targetId?: string }[];
  };
  type Shown = { readonly snapshot: Pick<HistoryPage, 'items'> };

  /** A Session that was told `First.` and then `Second.`, one turn each. */
  async function conversation() {
    const host = await makeModelHost();
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;
    let said = 0;
    const say = async (text: string): Promise<void> => {
      const { input } = await user.request('input.submit', { requestId: `input-${said += 1}`, sessionId, text }) as InputAnswer;
      await user.request('run.wait', { runId: input.runId });
    };
    await say('First.');
    await say('Second.');
    const turn = (select?: Readonly<Record<string, unknown>>): Promise<TurnAnswer> => user.request(
      'history.resolveTurn', select === undefined ? { sessionId } : { sessionId, turn: select },
    ) as Promise<TurnAnswer>;
    const tree = (): Promise<Tree> => user.request('session.lineage.get', { sessionId }) as Promise<Tree>;
    return { host, user, sessionId, say, turn, tree };
  }

  it('names a turn by where it is or by an item in it', async () => {
    const { user, sessionId, turn } = await conversation();

    const latest = await turn();
    expect(latest).toEqual({ turn: { ref: expect.any(String), index: 1, excerpt: 'Second.', hasLaterTurn: false } });
    const previous = await turn({ kind: 'previous' });
    expect(previous.turn).toMatchObject({ index: 0, excerpt: 'First.', hasLaterTurn: true });
    expect(await turn({ kind: 'index', index: 0 })).toEqual(previous);
    expect(await turn({ kind: 'index', index: 9 })).toEqual({ unavailable: 'turn_not_found' });

    // An item names the turn it belongs to, whether a history page or a view showed it.
    const page = await user.request('history.read', { sessionId }) as unknown as HistoryPage;
    expect(await turn({ kind: 'item', itemId: page.items.find(item => item.type === 'assistant')!.id })).toEqual(previous);
    const { snapshot } = await user.request('view.subscribe', {
      subscriptionId: 'main', target: { kind: 'session', sessionId },
    }) as unknown as Shown;
    expect(await turn({ kind: 'item', itemId: snapshot.items.find(item => item.type === 'user' && item.text === 'Second.')!.id }))
      .toEqual(latest);
    expect(await turn({ kind: 'item', itemId: snapshot.items.find(item => item.type === 'assistant')!.id })).toEqual(previous);
    expect(await turn({ kind: 'item', itemId: 'no-such-item' })).toEqual({ unavailable: expect.any(String) });

    const empty = await user.request('session.create', { requestId: 'create-2', project: 'app' }) as SessionAnswer;
    expect(await user.request('history.resolveTurn', { sessionId: empty.session.id })).toEqual({ unavailable: 'no_turns' });
    await expect(user.request('history.resolveTurn', { sessionId: 'no-such-session' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
  }, 60_000);

  it('forks a Session once per request, whole, up to a turn or up to an entry', async () => {
    const { host, user, sessionId, say, turn, tree } = await conversation();
    const first = (await turn({ kind: 'previous' })).turn!;
    const second = (await turn()).turn!;
    const fork = (requestId: string, params: Readonly<Record<string, unknown>> = {}): Promise<SessionAnswer> => (
      user.request('session.fork', { requestId, sessionId, ...params }) as Promise<SessionAnswer>
    );

    const whole = await fork('fork-1', { title: 'Copy' });
    expect(whole.session).toMatchObject({ title: 'Copy', messageCount: 4 });
    expect(await fork('fork-1', { title: 'Copy' })).toMatchObject({ session: { id: whole.session.id, title: 'Copy', messageCount: 4 } });
    await expect(fork('fork-1', { title: 'Another' })).rejects.toMatchObject({ kodaxCode: 'conflict' });

    const upTo = await fork('fork-2', { turn: first.ref });
    expect(upTo.session.messageCount).toBe(2);
    const before = await fork('fork-3', { turn: second.ref, before: true });
    expect(before.session.messageCount).toBe(2);
    const answer = (await tree()).items.filter(entry => entry.type === 'message')[1]!;
    const atEntry = await fork('fork-4', { entry: answer.id });
    expect(atEntry.session.messageCount).toBe(2);
    expect(new Set([sessionId, whole.session.id, upTo.session.id, before.session.id, atEntry.session.id]).size).toBe(5);
    // The source is as it was.
    expect((await user.request('session.get', { sessionId }) as SessionAnswer).session.messageCount).toBe(4);

    await expect(fork('fork-5', { before: true })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(fork('fork-5', { turn: 'not-a-turn' })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(fork('fork-5', { turn: first.ref, entry: answer.id })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(fork('fork-5', { entry: 'no-such-entry' })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    await expect(user.request('session.fork', { requestId: 'fork-5', sessionId: 'no-such-session' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });

    // A turn stands for the conversation as it was read. The request that already forked from it still has its answer.
    await say('Third.');
    await expect(fork('fork-6', { turn: first.ref })).rejects.toMatchObject({ kodaxCode: 'resync_required', reason: 'source_changed' });
    // A turn belongs to the Session it was named in.
    await expect(user.request('session.fork', { requestId: 'fork-8', sessionId: whole.session.id, turn: first.ref }))
      .rejects.toMatchObject({ kodaxCode: 'resync_required' });
    expect(await fork('fork-2', { turn: first.ref })).toMatchObject({ session: { id: upTo.session.id } });

    const held = host.hold();
    const { input } = await user.request('input.submit', { requestId: 'input-held', sessionId, text: 'Go on.' }) as InputAnswer;
    await held.called;
    await expect(fork('fork-7')).rejects.toMatchObject({ kodaxCode: 'conflict' });
    held.release();
    await user.request('run.wait', { runId: input.runId });
  }, 90_000);

  it('goes back in the conversation, once however often it is asked', async () => {
    const { user, sessionId, say, turn, tree } = await conversation();
    const first = (await turn({ kind: 'previous' })).turn!;
    const second = (await turn()).turn!;
    const rewind = (requestId: string, params: Readonly<Record<string, unknown>>): Promise<SessionAnswer> => (
      user.request('session.rewind', { requestId, sessionId, ...params }) as Promise<SessionAnswer>
    );

    const rewound = await rewind('rewind-1', { turn: first.ref });
    expect(rewound.session).toMatchObject({ id: sessionId, messageCount: 2 });
    const after = await tree();
    expect(after.items.filter(entry => entry.type === 'rewind_marker')).toHaveLength(1);
    expect(await rewind('rewind-1', { turn: first.ref })).toMatchObject({ session: { id: sessionId, messageCount: 2 } });
    expect(await tree()).toEqual(after);
    expect((await turn()).turn).toMatchObject({ index: 0, excerpt: 'First.', hasLaterTurn: false });
    // A turn named before the conversation changed is refused.
    await expect(rewind('rewind-2', { turn: second.ref })).rejects.toMatchObject({ kodaxCode: 'resync_required', reason: 'head_changed' });

    // An entry of the tree names where to go back to as well.
    await say('Third.');
    const grown = await tree();
    const answer = grown.items.filter(entry => entry.type === 'message')[1]!;
    await expect(rewind('rewind-3', { entry: answer.id, ifActiveEntryId: 'elsewhere' }))
      .rejects.toMatchObject({ kodaxCode: 'resync_required', reason: 'head_changed' });
    const back = await rewind('rewind-4', { entry: answer.id, ifActiveEntryId: grown.activeEntryId });
    expect(back.session.messageCount).toBe(2);
    const settled = await tree();
    expect(settled.activeEntryId).toBe(answer.id);
    expect(await rewind('rewind-4', { entry: answer.id, ifActiveEntryId: grown.activeEntryId }))
      .toMatchObject({ session: { id: sessionId, messageCount: 2 } });
    expect(await tree()).toEqual(settled);

    await expect(rewind('rewind-5', { turn: first.ref, entry: answer.id })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(rewind('rewind-5', { turn: 'not-a-turn' })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    // Going back names where to: a rewind that chose the place itself would go further each time it was sent again.
    await expect(rewind('rewind-5', {})).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(rewind('rewind-5', { entry: answer.id })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(rewind('rewind-5', { turn: first.ref, ifActiveEntryId: answer.id })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(rewind('rewind-5', { entry: 'no-such-entry', ifActiveEntryId: answer.id })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    await expect(user.request('session.rewind', {
      requestId: 'rewind-5', sessionId: 'no-such-session', entry: answer.id, ifActiveEntryId: answer.id,
    })).rejects.toMatchObject({ kodaxCode: 'not_found' });
  }, 90_000);

  it('starts a Session from what another learned, and opens one side chat for a branch', async () => {
    const { user, sessionId } = await conversation();

    const recover = { requestId: 'recover-1', sessionId, reason: 'The context was full.' };
    const recovered = await user.request('session.recover', recover) as SessionAnswer;
    expect(recovered.session.id).not.toBe(sessionId);
    expect(recovered.session.messageCount).toBeGreaterThan(0);
    expect(await user.request('session.recover', recover)).toMatchObject({ session: { id: recovered.session.id } });
    await expect(user.request('session.recover', { ...recover, title: 'Another' })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    const empty = await user.request('session.create', { requestId: 'create-2', project: 'app' }) as SessionAnswer;
    await expect(user.request('session.recover', { requestId: 'recover-2', sessionId: empty.session.id }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });
    await expect(user.request('session.recover', { requestId: 'recover-3', sessionId: 'no-such-session' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });

    const side = await user.request('session.side.open', { requestId: 'side-1', sessionId }) as SessionAnswer;
    expect(side.session.id).not.toBe(sessionId);
    for (const requestId of ['side-1', 'side-2']) {
      expect(await user.request('session.side.open', { requestId, sessionId })).toMatchObject({ session: { id: side.session.id } });
    }
    // A side chat is a leaf: nothing opens or forks from it.
    await expect(user.request('session.side.open', { requestId: 'side-3', sessionId: side.session.id }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });
    await expect(user.request('session.fork', { requestId: 'fork-1', sessionId: side.session.id }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });
    await expect(user.request('session.side.open', { requestId: 'side-4', sessionId: 'no-such-session' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
  }, 60_000);
});

describe('v2 read-only catalogs and statistics served by the v1 implementation', () => {
  type Named = { readonly items: readonly { readonly name: string; readonly [field: string]: unknown }[] };
  type FactPage = { readonly items: readonly Readonly<Record<string, unknown>>[]; readonly nextCursor?: string; readonly revision: number };

  it('reads one Skill, and sends its Host paths to the owner only', async () => {
    const owner = await connect('owner');
    expect(await owner.request('skill.get', { name: 'deploy', projectRoot: '/work/app' })).toEqual({
      skill: {
        name: 'deploy', description: 'Deploy /work/app', source: 'user', disableModelInvocation: false,
        content: 'Ship it.', path: `${HOME}/skills/deploy`, skillFilePath: `${HOME}/skills/deploy/SKILL.md`,
        scripts: [{ name: 'run.sh', relativePath: 'run.sh', path: `${HOME}/skills/deploy/scripts/run.sh` }],
      },
    });

    const user = await connect('user');
    const read = await user.request('skill.get', { name: 'deploy' });
    expect(read).toEqual({
      skill: {
        name: 'deploy', description: 'Deploy everything', source: 'user', disableModelInvocation: false,
        content: 'Ship it.', scripts: [{ name: 'run.sh', relativePath: 'run.sh' }],
      },
    });
    expect(JSON.stringify(read)).not.toContain(HOME);
    expect(await user.request('skill.get', { name: 'no-such-skill' })).toEqual({});
    await expect(user.request('skill.get', { name: 'deploy', projectRoot: '/work/app' }))
      .rejects.toMatchObject({ kodaxCode: 'forbidden', reason: 'param_not_allowed' });
  });

  it('lists the reasoning efforts a model takes', async () => {
    const user = await connect('user');
    expect(await user.request('provider.reasoning.efforts', { provider: 'anthropic', model: 'claude-opus' }))
      .toEqual({ items: ['auto', 'off', 'anthropic/claude-opus'] });
    expect(await user.request('provider.reasoning.efforts', { provider: 'anthropic' }))
      .toEqual({ items: ['auto', 'off', 'anthropic/default'] });
    await expect(user.request('provider.reasoning.efforts', {})).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
  });

  it('shows a client that names a project what the project adds', async () => {
    const host = await makeModelHost();
    const kodax = path.join(host.workspaceRoot, 'app', '.kodax');
    await mkdir(path.join(kodax, 'commands'), { recursive: true });
    await writeFile(path.join(kodax, 'commands', 'greet.md'), '---\ndescription: Greets someone\n---\nSay hello to the person named below.\n');
    await mkdir(path.join(kodax, 'skills', 'ship'), { recursive: true });
    await writeFile(path.join(kodax, 'skills', 'ship', 'SKILL.md'), '---\nname: ship\ndescription: Ships the release\n---\nRun the release steps.\n');
    const user = await connect('user', await host.start(), host.workspace);
    const names = async (method: string, params?: Readonly<Record<string, unknown>>): Promise<readonly string[]> => (
      (await user.request(method, params) as Named).items.map(item => item.name)
    );

    expect(await names('command.list', { project: 'app' })).toContain('greet');
    expect(await names('skill.list', { project: 'app' })).toContain('ship');
    // Without a project, a Host with a workspace lists what a Session created without one would have: the workspace root's.
    expect(await names('command.list')).not.toContain('greet');
    expect(await names('skill.list')).not.toContain('ship');
    const skill = await user.request('skill.get', { name: 'ship', project: 'app' });
    expect(skill).toMatchObject({
      skill: { name: 'ship', description: 'Ships the release', source: 'project', content: expect.stringContaining('Run the release steps.') },
    });
    expect(await user.request('skill.get', { name: 'ship' })).toEqual({});
    expect(JSON.stringify([skill, await user.request('command.list', { project: 'app' })])).not.toContain(path.basename(host.homeDir));
    await expect(user.request('skill.list', { project: 'no-such-project' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'project_not_found' });
    await expect(user.request('command.list', { project: '../elsewhere' })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });

    // A Session reads the text of a prompt command of its own project, and the tools its Runs have.
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    expect(await user.request('command.readPrompt', { sessionId: session.id, name: 'greet', args: ['Ada', 'Lovelace'] }))
      .toEqual({ prompt: { title: 'greet', text: 'Say hello to the person named below.\n\nAda Lovelace' } });
    expect(await user.request('command.readPrompt', { sessionId: session.id, name: 'no-such-command' })).toEqual({});
    // A command the Host carries out itself has no text to read.
    expect(await user.request('command.readPrompt', { sessionId: session.id, name: 'help' })).toEqual({});
    await expect(user.request('command.readPrompt', { sessionId: 'no-such-session', name: 'greet' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });

    const tools = await user.request('tool.list', { sessionId: session.id }) as Named;
    expect(tools.items).toContainEqual({ name: 'read', sideEffect: 'readonly', planModeAllowed: expect.any(Boolean) });
    expect(tools.items.find(tool => tool.name === 'write')).toMatchObject({ sideEffect: 'mutates-fs' });
    await expect(user.request('tool.list', { sessionId: 'no-such-session' })).rejects.toMatchObject({ kodaxCode: 'not_found' });
  }, 60_000);

  it('counts what a Session asked of its model and of its tools', async () => {
    const host = await makeModelHost(callsToolOnce('read', { path: 'notes.txt' }));
    await writeFile(path.join(host.workspaceRoot, 'app', 'notes.txt'), 'A note.');
    const runtime = await host.start();
    const user = await connect('user', runtime, host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;
    expect(await user.request('stats.get', { sessionId })).toMatchObject({ stats: { requestCount: 0, contexts: [] } });

    const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId, text: 'Read the note.' }) as InputAnswer;
    await user.request('run.wait', { runId: input.runId });
    const ofRun = { kind: 'run', runId: input.runId };

    const { stats } = await user.request('stats.get', { sessionId }) as { readonly stats: Readonly<Record<string, unknown>> };
    expect(stats).toMatchObject({
      revision: expect.any(Number), coverage: expect.any(String), issues: expect.any(Array), requestCount: expect.any(Number),
      usage: {
        inputTokens: expect.any(Number), outputTokens: expect.any(Number), totalTokens: expect.any(Number),
        cacheReadTokens: expect.any(Number), cacheWriteTokens: expect.any(Number), thoughtTokens: expect.any(Number),
      },
    });
    expect(stats.contexts).toEqual([expect.objectContaining({
      target: ofRun, createdAt: expect.any(Number), usedTokens: expect.any(Number), contextWindow: expect.any(Number),
    })]);

    // The Run asked twice: once to get the tool call, once with the tool's answer. What the Host asks on its
    // own after a Run, such as a look at what to remember, is counted for the Run too and has another purpose.
    const requests = await user.request('stats.requests', { sessionId }) as FactPage;
    expect(requests.items.filter(request => request.purpose === 'primary')).toHaveLength(2);
    expect(requests.items[0]).toMatchObject({
      id: expect.any(String), logicalId: expect.any(String), provider: MODEL, purpose: 'primary', state: 'succeeded',
      startedAt: expect.any(Number), endedAt: expect.any(Number), target: ofRun,
    });
    // Oldest first, a page at a time.
    const first = await user.request('stats.requests', { sessionId, limit: 1 }) as FactPage;
    expect(first).toMatchObject({ items: [requests.items[0]], nextCursor: expect.any(String) });
    const second = await user.request('stats.requests', { sessionId, limit: 1, cursor: first.nextCursor }) as FactPage;
    expect(second.items).toEqual([requests.items[1]]);
    await expect(user.request('stats.requests', { sessionId, cursor: 'not-a-cursor' })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(user.request('stats.requests', { sessionId, limit: 0 })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });

    const tools = await user.request('stats.tools', { sessionId }) as FactPage;
    expect(tools.items).toEqual([expect.objectContaining({
      id: expect.any(String), name: 'read', state: 'completed', result: 'succeeded', updatedAt: expect.any(Number),
      target: ofRun, sandbox: expect.any(Array),
    })]);
    expect((await user.request('stats.tools', { sessionId, limit: 1 }) as FactPage).nextCursor).toBeUndefined();

    const sent = JSON.stringify([stats, requests, tools]);
    expect(sent).not.toContain(path.basename(host.homeDir));
    expect(sent).not.toContain('runtimeId');
    for (const method of ['stats.get', 'stats.requests', 'stats.tools']) {
      await expect(user.request(method, { sessionId: 'no-such-session' })).rejects.toMatchObject({ kodaxCode: 'not_found' });
    }

    // The counts outlive the Host that made them. A cursor does not: it says to start again from the first page.
    user.close();
    await runtime.close();
    const after = await connect('user', await host.start(), host.workspace);
    expect((await after.request('stats.requests', { sessionId }) as FactPage).items.slice(0, 2)).toEqual(requests.items.slice(0, 2));
    await expect(after.request('stats.requests', { sessionId, limit: 1, cursor: first.nextCursor }))
      .rejects.toMatchObject({ kodaxCode: 'resync_required', reason: 'cursor_expired' });
  }, 90_000);
});

describe('v2 child Agents served by the v1 implementation', () => {
  interface ActorFacts {
    readonly path: string;
    readonly state: string;
    readonly turnIds: readonly string[];
    readonly currentTurnId?: string;
    readonly latestTurn?: { readonly state: string };
    readonly [field: string]: unknown;
  }
  type Tree = { readonly items: readonly ActorFacts[]; readonly [field: string]: unknown };
  type Detail = {
    readonly actor: ActorFacts;
    readonly turns: ReadonlyArray<Readonly<Record<string, unknown>>>;
    readonly mailbox: ReadonlyArray<{ readonly text: string; readonly [field: string]: unknown }>;
  };
  type Waited = { readonly event?: { readonly sequence: number; readonly kind: string; readonly [field: string]: unknown } };
  const CHILD = '/root/audit-child';

  /** The root asks for one child, which answers `Child report.`. `asking` runs as the root asks. */
  function spawnsChild(asking: () => void = () => undefined): ModelTurn {
    return (messages) => {
      const asked = JSON.stringify(messages);
      const answered = messages.some(message => Array.isArray(message.content)
        && message.content.some(block => block.type === 'tool_result'));
      if (asked.includes('SPAWN-NOW') && !asked.includes('CHILD-WORK') && !answered) {
        asking();
        return {
          textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
          toolBlocks: [{ type: 'tool_use', id: 'spawn-1', name: 'spawn_agent', input: { task_name: 'audit-child', objective: 'CHILD-WORK' } }],
        };
      }
      if (asked.includes('CHILD-WORK') && !answered) {
        return { textBlocks: [{ type: 'text', text: 'Child report.' }], toolBlocks: [], thinkingBlocks: [] };
      }
      return undefined;
    };
  }

  async function child(client: HostRpcClient, sessionId: string): Promise<ActorFacts | undefined> {
    return (await client.request('actor.tree', { sessionId }) as Tree).items.find(actor => actor.path === CHILD);
  }

  it('reads the child Agents of a Session, what they did and what they answered', async () => {
    const host = await makeModelHost(spawnsChild());
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;
    expect(await user.request('actor.tree', { sessionId })).toMatchObject({ items: [{ path: '/root' }], activeNonRootTurns: 0 });

    const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId, text: 'SPAWN-NOW' }) as InputAnswer;
    await user.request('run.wait', { runId: input.runId });
    await expect.poll(async () => (await child(user, sessionId))?.latestTurn?.state, { timeout: 15_000 }).toBe('completed');

    const tree = await user.request('actor.tree', { sessionId }) as Tree;
    expect(tree).toMatchObject({
      activeNonRootTurns: 0, maxConcurrentThreads: expect.any(Number), revision: expect.any(Number),
    });
    const actor = tree.items.find(item => item.path === CHILD)!;
    const turnId = actor.turnIds[0]!;
    expect(actor).toMatchObject({
      path: CHILD, taskName: 'audit-child', parentPath: '/root', kind: 'native', state: 'idle', turnIds: [turnId],
      capabilities: { tools: expect.any(Array), filesystem: expect.any(String) },
      createdAt: expect.any(Number), updatedAt: expect.any(Number), revision: expect.any(Number),
      latestTurn: { turnId, state: 'completed', summary: expect.any(String), recentActivity: expect.any(Array) },
    });
    expect(actor).not.toHaveProperty('currentTurnId');

    const detail = await user.request('actor.get', { sessionId, actorPath: CHILD }) as Detail;
    expect(detail.actor).toMatchObject({ path: CHILD, state: 'idle', createdAt: expect.any(Number) });
    expect(detail.turns).toEqual([expect.objectContaining({
      turnId, actorPath: CHILD, sequence: 1, state: 'completed', objective: 'CHILD-WORK', output: 'Child report.',
      createdAt: expect.any(Number), startedAt: expect.any(Number), completedAt: expect.any(Number), revision: expect.any(Number),
    })]);
    // What the executor keeps to go on from is its own.
    expect(detail.turns[0]).not.toHaveProperty('checkpoint');

    const output = await user.request('actor.output', { sessionId, actorPath: CHILD });
    expect(output).toMatchObject({ actorPath: CHILD, turnId, state: 'completed', output: 'Child report.', progress: expect.any(Array) });
    expect(await user.request('actor.output', { sessionId, actorPath: CHILD, turnId })).toEqual(output);
    await expect(user.request('actor.output', { sessionId, actorPath: CHILD, turnId: 'turn_never' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'turn_not_found' });

    // What a child wrote is named by Host paths, which only the owner is sent.
    const sent = JSON.stringify([tree, detail, output]);
    expect(sent).not.toContain(path.basename(host.homeDir));
    expect(sent).not.toContain('"artifacts":[');
    expect(sent).not.toContain('artifactDetails');
    expect(sent).not.toContain('runtimeId');

    for (const [method, params] of [
      ['actor.get', {}], ['actor.output', {}],
      ['actor.send', { requestId: 'send-0', text: 'Anyone?' }],
      ['actor.interrupt', { requestId: 'stop-0', turnId }],
    ] as const) {
      await expect(user.request(method, { ...params, sessionId, actorPath: '/root/nobody' }))
        .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'actor_not_found' });
      await expect(user.request(method, { ...params, sessionId: 'no-such-session', actorPath: CHILD }))
        .rejects.toMatchObject({ kodaxCode: 'not_found' });
    }
    for (const method of ['actor.tree', 'actor.wait']) {
      await expect(user.request(method, { sessionId: 'no-such-session' })).rejects.toMatchObject({ kodaxCode: 'not_found' });
    }

    // An archived Session runs nothing, and says so instead of failing without a reason.
    await user.request('session.archive', { requestId: 'archive-1', sessionId });
    await expect(user.request('actor.tree', { sessionId })).rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'session_archived' });
  }, 90_000);

  it('tells a waiting client that the Agents of a Session changed, within a bounded wait', async () => {
    const host = await makeModelHost(spawnsChild());
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;

    // Nothing happened yet: the wait ends empty at its limit.
    const waiting = user.request('actor.wait', { sessionId, timeoutMs: 20_000 }) as Promise<Waited>;
    expect(await user.request('actor.wait', { sessionId, timeoutMs: 0 })).toEqual({});
    const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId, text: 'SPAWN-NOW' }) as InputAnswer;
    const first = (await waiting).event!;
    expect(first).toEqual({
      sequence: expect.any(Number), kind: 'actor_spawned', actorPath: CHILD, turnId: expect.any(String), parentPath: '/root',
      createdAt: expect.any(Number),
    });

    // Each answer names where to wait from next.
    const kinds = [first.kind];
    for (let after = first.sequence; kinds.at(-1) !== 'turn_completed' && kinds.length < 50;) {
      const { event } = await user.request('actor.wait', { sessionId, afterSequence: after, timeoutMs: 10_000 }) as Waited;
      if (event === undefined) break;
      kinds.push(event.kind);
      after = event.sequence;
    }
    expect(kinds).toContain('turn_started');
    expect(kinds.at(-1)).toBe('turn_completed');

    await expect(user.request('actor.wait', { sessionId, timeoutMs: 60_001 })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(user.request('actor.wait', { sessionId, afterSequence: -1 })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await user.request('run.wait', { runId: input.runId });
  }, 90_000);

  it('delivers a message once per request and interrupts only the turn it names', async () => {
    let held: { readonly called: Promise<void>; readonly release: () => void } | undefined;
    // The root's first request passes. Everything asked after it waits, so the child stays in its turn.
    const host = await makeModelHost(spawnsChild(() => { held = host.hold(); }));
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;

    const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId, text: 'SPAWN-NOW' }) as InputAnswer;
    await expect.poll(async () => (await child(user, sessionId))?.currentTurnId, { timeout: 15_000 }).toEqual(expect.any(String));
    const running = (await child(user, sessionId))!;
    const turnId = running.currentTurnId!;
    expect(running).toMatchObject({ state: 'running', latestTurn: { turnId } });
    expect(await user.request('actor.tree', { sessionId })).toMatchObject({ activeNonRootTurns: 1 });

    // The same request sent again delivers nothing more. Another request does.
    const message = { sessionId, actorPath: CHILD, text: 'Also check the tests.' };
    expect(await user.request('actor.send', { requestId: 'send-1', ...message })).toEqual({});
    expect(await user.request('actor.send', { requestId: 'send-1', ...message })).toEqual({});
    expect(await user.request('actor.send', { requestId: 'send-2', ...message, classification: 'sensitive' })).toEqual({});
    const { mailbox } = await user.request('actor.get', { sessionId, actorPath: CHILD }) as Detail;
    const delivered = mailbox.filter(item => item.text === message.text);
    expect(delivered).toEqual([
      {
        messageId: expect.any(String), sequence: expect.any(Number), senderPath: '/root', recipientPath: CHILD,
        kind: 'message', classification: 'internal', lineage: ['/root'], text: message.text, createdAt: expect.any(Number),
      },
      expect.objectContaining({ classification: 'sensitive' }),
    ]);
    await expect(user.request('actor.send', { requestId: 'send-3', ...message, text: '' })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    await expect(user.request('actor.send', { requestId: 'send-3', ...message, classification: 'secret' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });

    // A turn the Agent never had is refused, and the running turn goes on.
    const stop = { sessionId, actorPath: CHILD };
    await expect(user.request('actor.interrupt', { requestId: 'stop-1', ...stop, turnId: 'turn_never' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'turn_not_found' });
    expect((await child(user, sessionId))!.currentTurnId).toBe(turnId);

    const interrupt = { requestId: 'stop-2', ...stop, turnId, reason: 'No longer needed.' };
    expect(await user.request('actor.interrupt', interrupt)).toEqual({});
    const stopped = (await child(user, sessionId))!;
    expect(stopped).toMatchObject({ state: 'idle', latestTurn: { turnId, state: 'interrupted' } });
    expect(stopped).not.toHaveProperty('currentTurnId');
    expect(await user.request('actor.output', { sessionId, actorPath: CHILD, turnId }))
      .toMatchObject({ state: 'interrupted', error: 'No longer needed.' });
    // The turn has ended, so asking again changes nothing and does not fail.
    expect(await user.request('actor.interrupt', interrupt)).toEqual({});
    expect(await user.request('actor.interrupt', { requestId: 'stop-3', ...stop, turnId })).toEqual({});
    expect(await child(user, sessionId)).toMatchObject({ state: 'idle', turnIds: [turnId], latestTurn: { turnId, state: 'interrupted' } });

    held!.release();
    await user.request('run.wait', { runId: input.runId });
  }, 90_000);

  /** Answers the key requests of a client with `key`. */
  function lendKey(client: HostRpcClient, key: string): void {
    client.onNotification((method, params) => {
      const request = params as { readonly kind: string; readonly callId: string };
      if (method !== 'lease.request' || request.kind !== 'credential') return;
      void client.request('lease.complete', { requestId: `complete-${request.callId}`, kind: 'credential', callId: request.callId, credential: key });
    });
  }

  it('starts a child and gives it a new objective once per request, with the key the client lends', async () => {
    const host = await makeModelHost();
    const owner = await connect('owner', await host.start(), host.workspace);
    await owner.request('lease.register', { requestId: 'key-1', kind: 'credential', providers: [MODEL] });
    lendKey(owner, 'leased-key');
    const { session } = await owner.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;

    const spawn = { requestId: 'spawn-1', sessionId, taskName: 'audit-child', objective: 'CHILD-WORK', leases: { credential: 'key-1' } };
    const started = await owner.request('actor.spawn', spawn) as { readonly turnId: string };
    expect(started).toEqual({ actorPath: CHILD, turnId: expect.any(String) });
    // Sent again, the same answer, and no second child or turn.
    expect(await owner.request('actor.spawn', spawn)).toEqual(started);
    await expect.poll(async () => (await child(owner, sessionId))?.latestTurn?.state, { timeout: 15_000 }).toBe('completed');
    expect(host.lastRunRequest().apiKey).toBe('leased-key');
    expect(await owner.request('actor.spawn', spawn)).toEqual(started);
    expect((await child(owner, sessionId))!.turnIds).toEqual([started.turnId]);
    // Another request for a name in use is refused.
    await expect(owner.request('actor.spawn', { ...spawn, requestId: 'spawn-2' })).rejects.toMatchObject({ kodaxCode: 'conflict' });

    // An idle child starts a new turn for the new objective.
    const followup = { requestId: 'follow-1', sessionId, actorPath: CHILD, objective: 'Check the tests too.', leases: { credential: 'key-1' } };
    const next = await owner.request('actor.followup', followup) as { readonly turnId: string };
    expect(next).toEqual({ delivery: 'started_turn', turnId: expect.any(String) });
    expect(next.turnId).not.toBe(started.turnId);
    expect(await owner.request('actor.followup', followup)).toEqual(next);
    await expect.poll(async () => (await child(owner, sessionId))?.latestTurn?.state, { timeout: 15_000 }).toBe('completed');
    expect(await owner.request('actor.followup', followup)).toEqual(next);
    expect((await child(owner, sessionId))!.turnIds).toEqual([started.turnId, next.turnId]);
    // The request names stay with the Host.
    expect(JSON.stringify(await owner.request('actor.get', { sessionId, actorPath: CHILD }))).not.toContain('spawn-1');

    // A client that lends no key runs the turn on the Host's own, as a Run does.
    const own = await owner.request('actor.followup', { ...followup, requestId: 'follow-2', leases: undefined }) as { readonly turnId: string };
    expect(own).toEqual({ delivery: 'started_turn', turnId: expect.any(String) });
    await expect.poll(async () => (await child(owner, sessionId))?.latestTurn?.state, { timeout: 15_000 }).toBe('completed');
    expect(host.lastRunRequest().apiKey).toBe('offline-test');
  }, 90_000);

  it('holds a child a person starts to the key, tools and time limit of the Session and the Host', async () => {
    const host = await makeModelHost();
    const runtime = await host.start({ hostToolCeiling: () => ['read', 'grep'] });
    const reverseBridgeHub = createRuntimeDaemonReverseBridgeHub();
    cleanup.push(() => reverseBridgeHub.close());
    const backend = await connect('service', runtime, host.workspace, { reverseBridgeHub }, 's'.repeat(32));
    const user = await connect('user', runtime, host.workspace, { reverseBridgeHub });
    await backend.request('lease.register', { requestId: 'key-1', kind: 'credential', providers: [MODEL] });
    lendKey(backend, 'session-key');
    const { session } = await backend.request('session.create', {
      requestId: 'create-1', project: 'app', policy: { tools: ['grep', 'bash'], leases: { credential: 'key-1' } },
    }) as SessionAnswer;

    // A person lends no key, and the Session's runs the child.
    await expect(user.request('actor.spawn', {
      requestId: 'spawn-0', sessionId: session.id, taskName: 'audit-child', objective: 'CHILD-WORK', leases: { credential: 'key-1' },
    })).rejects.toMatchObject({ kodaxCode: 'forbidden', reason: 'param_not_allowed' });
    await user.request('actor.spawn', { requestId: 'spawn-1', sessionId: session.id, taskName: 'audit-child', objective: 'CHILD-WORK' });
    await expect.poll(async () => (await child(user, session.id))?.latestTurn?.state, { timeout: 15_000 }).toBe('completed');
    const asked = host.lastRunRequest();
    expect(asked.apiKey).toBe('session-key');
    // Only what both the Session and the Host allow.
    expect(asked.tools).toContain('grep');
    expect(asked.tools).not.toContain('read');
    expect(asked.tools).not.toContain('bash');

    // A Session that lends no key runs a child on the Host's own key, still within the Host's tools.
    const { session: open } = await user.request('session.create', { requestId: 'create-2', project: 'app' }) as SessionAnswer;
    await user.request('actor.spawn', { requestId: 'spawn-2', sessionId: open.id, taskName: 'audit-child', objective: 'CHILD-WORK' });
    await expect.poll(async () => (await child(user, open.id))?.latestTurn?.state, { timeout: 15_000 }).toBe('completed');
    expect(host.lastRunRequest().apiKey).toBe('offline-test');
    expect(host.lastRunRequest().tools).not.toContain('bash');

    // A child turn ends at the time limit of its Session. A follow-up while it works joins that turn.
    const { session: tight } = await backend.request('session.create', {
      requestId: 'create-3', project: 'app', policy: { budget: { maxDurationMs: 300 }, leases: { credential: 'key-1' } },
    }) as SessionAnswer;
    const held = host.hold();
    const { turnId } = await user.request('actor.spawn', {
      requestId: 'spawn-3', sessionId: tight.id, taskName: 'audit-child', objective: 'CHILD-WORK',
    }) as { readonly turnId: string };
    await held.called;
    const followup = { requestId: 'follow-1', sessionId: tight.id, actorPath: CHILD, objective: 'Also check the tests.' };
    expect(await user.request('actor.followup', followup)).toEqual({ delivery: 'current_turn', turnId });
    await expect.poll(async () => (await child(user, tight.id))?.latestTurn?.state, { timeout: 15_000 }).toBe('interrupted');
    expect(await user.request('actor.followup', followup)).toEqual({ delivery: 'current_turn', turnId });
    expect((await child(user, tight.id))!.turnIds).toEqual([turnId]);
    held.release();
  }, 90_000);

  it('sends the owner the Host paths of what a child wrote', async () => {
    const runtime = fakeRuntime();
    const turn = {
      turnId: 'turn_1', actorPath: CHILD, sequence: 1, state: 'completed', objective: 'Write it.', forkTurns: 'all',
      createdAt: '2026-11-21T08:00:00.000Z', completedAt: '2026-11-21T08:00:05.000Z', revision: 3,
      artifacts: ['/work/app/report.md'], artifactDetails: [{ name: 'report.md', uri: 'file:///work/app/report.md' }],
      checkpoint: { step: 4 },
    };
    (runtime as { agents: unknown }).agents = {
      detail: async () => ({
        actor: {
          path: CHILD, taskName: 'audit-child', parentPath: '/root', kind: 'native', state: 'idle',
          capabilities: { tools: [], filesystem: 'write', network: false, providers: [], canAskUser: false },
          turnIds: ['turn_1'], mailboxCursor: 0, createdAt: turn.createdAt, updatedAt: turn.completedAt, revision: 4,
        },
        turns: [turn],
        mailbox: [],
      }),
      output: async () => ({
        actorPath: CHILD, turnId: 'turn_1', state: 'completed', output: 'Written.', progress: [],
        artifacts: turn.artifacts, artifactDetails: turn.artifactDetails,
      }),
    };
    const target = { sessionId: 'session-1', actorPath: CHILD };
    const paths = { artifacts: turn.artifacts, artifactDetails: turn.artifactDetails };

    const owner = await connect('owner', runtime);
    const local = await owner.request('actor.get', target) as Detail;
    expect(local.turns[0]).toMatchObject({ ...paths, createdAt: Date.parse(turn.createdAt), completedAt: Date.parse(turn.completedAt) });
    expect(local.turns[0]).not.toHaveProperty('checkpoint');
    expect(await owner.request('actor.output', target)).toMatchObject(paths);

    for (const role of ['user', 'service'] as const) {
      const client = await connect(role, runtime);
      const sent = JSON.stringify([await client.request('actor.get', target), await client.request('actor.output', target)]);
      expect(sent).not.toContain('/work/app');
      expect(sent).toContain('Written.');
    }
  });
});

describe('v2 workflows served by the v1 implementation', () => {
  type WorkflowFacts = { readonly id: string; readonly status: string; readonly [field: string]: unknown };
  type WorkflowAnswer = { readonly workflow: WorkflowFacts };
  type WorkflowPage = { readonly items: readonly WorkflowFacts[]; readonly nextCursor?: string };
  type Started = { readonly workflowId: string; readonly runId: string };
  // One Agent, so the workflow keeps running for as long as the model is held.
  const SCRIPT = {
    manifest: {
      name: 'v2-audit', description: 'Audit one part', readOnly: true, maxAgents: 1, maxConcurrency: 1,
      phases: ['audit'], patterns: ['fan-out-and-synthesize'],
    },
    source: 'async function run(wf) { const result = await wf.runAgent({ name: "audit", '
      + 'prompt: "Audit the part.", readOnly: true }); return { synthesis: result.finalText }; }',
  };

  it('starts a workflow once per request and shows it only through its Session', async () => {
    const host = await makeModelHost();
    const runtime = await host.start();
    const owner = await connect('owner', runtime, host.workspace);
    const user = await connect('user', runtime, host.workspace);
    const { session } = await owner.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const { session: other } = await owner.request('session.create', { requestId: 'create-2', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;
    const held = host.hold();

    const start = { requestId: 'wf-1', sessionId, script: SCRIPT };
    const started = await owner.request('workflow.start', start) as Started;
    expect(started).toEqual({ workflowId: expect.any(String), runId: expect.any(String) });
    // The same request again starts nothing more, while the first is running and after.
    expect(await owner.request('workflow.start', start)).toEqual(started);
    await held.called;
    expect(await owner.request('workflow.start', start)).toEqual(started);
    await expect(owner.request('workflow.start', { requestId: 'wf-1', sessionId, name: 'parallel-investigation' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });

    const { items } = await user.request('workflow.list', { sessionId }) as WorkflowPage;
    expect(items).toEqual([{
      id: started.workflowId, name: 'v2-audit', displayName: 'v2-audit', status: 'running', spawnedAgents: expect.any(Number),
      startedAt: expect.any(Number), updatedAt: expect.any(Number),
    }]);
    expect(await user.request('workflow.list', { sessionId: other.id })).toEqual({ items: [] });

    const target = { sessionId, workflowId: started.workflowId };
    const { workflow } = await user.request('workflow.get', target) as WorkflowAnswer;
    expect(workflow).toMatchObject({
      id: started.workflowId, runId: started.runId, name: 'v2-audit', status: 'running',
      items: expect.any(Array), counts: { running: expect.any(Number) }, progress: { spawnedAgents: expect.any(Number) },
    });
    // Where the workflow keeps its files is a Host path: only the owner is sent it.
    expect(JSON.stringify(workflow)).not.toContain(path.basename(host.homeDir));
    expect(workflow).not.toHaveProperty('runDir');
    expect((await owner.request('workflow.get', target) as WorkflowAnswer).workflow)
      .toMatchObject({ runDir: expect.stringContaining('workflow-runs') });

    // Through another Session the workflow does not exist.
    const elsewhereTarget = { sessionId: other.id, workflowId: started.workflowId };
    await expect(user.request('workflow.get', elsewhereTarget))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'workflow_not_found' });
    for (const method of ['workflow.pause', 'workflow.resume', 'workflow.stop']) {
      await expect(user.request(method, { requestId: 'other-1', ...elsewhereTarget }))
        .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'workflow_not_found' });
    }
    // Another Host in the process may hold a Session of the same id. It does not see this Host's workflows.
    const elsewhere = await makeHost();
    const stranger = await connect('owner', await elsewhere.start({ defaultProvider: MODEL }), elsewhere.workspace);
    const { session: twin } = await stranger.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    expect(twin.id).toBe(sessionId);
    expect(await stranger.request('workflow.list', { sessionId })).toEqual({ items: [] });
    await expect(stranger.request('workflow.get', target)).rejects.toMatchObject({ kodaxCode: 'not_found' });

    expect((await user.request('workflow.get', target) as WorkflowAnswer).workflow.status).toBe('running');
    held.release();
    await user.request('run.wait', { runId: started.runId });
    expect((await user.request('workflow.get', target) as WorkflowAnswer).workflow.status).toBe('completed');
  }, 90_000);

  it('pauses, resumes and stops a workflow, and leaves one that ended as it is', async () => {
    const host = await makeModelHost();
    const runtime = await host.start();
    const owner = await connect('owner', runtime, host.workspace);
    const user = await connect('user', runtime, host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;
    const held = host.hold();
    // The Host runs a script without a sandbox, so the user may not send one of its own.
    await expect(user.request('workflow.start', { requestId: 'wf-0', sessionId, script: SCRIPT }))
      .rejects.toMatchObject({ kodaxCode: 'forbidden', reason: 'param_not_allowed' });
    const started = await owner.request('workflow.start', { requestId: 'wf-1', sessionId, script: SCRIPT }) as Started;
    await held.called;
    const target = { sessionId, workflowId: started.workflowId };
    const status = async () => (await user.request('workflow.get', target) as WorkflowAnswer).workflow;

    // Each command asked again answers as the first did.
    expect(await user.request('workflow.pause', { requestId: 'pause-1', ...target })).toEqual({});
    expect(await status()).toMatchObject({ status: 'paused' });
    expect(await user.request('workflow.pause', { requestId: 'pause-1', ...target })).toEqual({});
    expect(await user.request('workflow.pause', { requestId: 'pause-2', ...target })).toEqual({});
    expect(await user.request('workflow.resume', { requestId: 'resume-1', ...target })).toEqual({});
    expect(await status()).toMatchObject({ status: 'running' });
    expect(await user.request('workflow.resume', { requestId: 'resume-1', ...target })).toEqual({});
    expect(await user.request('workflow.resume', { requestId: 'resume-2', ...target })).toEqual({});

    expect(await user.request('workflow.stop', { requestId: 'stop-1', ...target })).toEqual({});
    await expect.poll(async () => (await status()).status, { timeout: 15_000 }).toBe('stopped');
    await user.request('run.wait', { runId: started.runId });
    expect(await user.request('workflow.stop', { requestId: 'stop-1', ...target })).toEqual({});
    expect(await user.request('workflow.stop', { requestId: 'stop-2', ...target })).toEqual({});
    for (const method of ['workflow.pause', 'workflow.resume']) {
      await expect(user.request(method, { requestId: `${method.slice('workflow.'.length)}-ended`, ...target }))
        .rejects.toMatchObject({ kodaxCode: 'invalid_state', reason: 'workflow_ended' });
    }
    expect(await user.request('workflow.list', { sessionId, activeOnly: true })).toEqual({ items: [] });
    expect(await user.request('workflow.list', { sessionId, limit: 1 })).toEqual({ items: [expect.objectContaining({ id: started.workflowId })] });
    await expect(user.request('workflow.list', { sessionId, cursor: 'no-such-workflow' }))
      .rejects.toMatchObject({ kodaxCode: 'resync_required', reason: 'cursor_expired' });
  }, 90_000);

  it('refuses a start that names no workflow it can run', async () => {
    const host = await makeModelHost();
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const sessionId = session.id;

    await expect(user.request('workflow.start', { requestId: 'wf-1', sessionId, name: 'no-such-workflow' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'workflow_declined' });
    for (const sources of [{}, { name: 'review', request: 'Review the change.' }]) {
      await expect(user.request('workflow.start', { requestId: 'wf-2', sessionId, ...sources }))
        .rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'workflow_source_required' });
    }
    expect(await user.request('workflow.list', { sessionId })).toEqual({ items: [] });
    expect(host.calls()).toBe(0);
  }, 30_000);
});

/** The management a daemon Host process adds. Only what a test overrides does anything. */
function fakeManagement(overrides: Partial<RuntimeDaemonManagementController> = {}): RuntimeDaemonManagementController {
  return {
    lifecycle: 'interactive',
    retention: undefined,
    armOrphanExitAfterReady: () => undefined,
    attachClient: () => undefined,
    detachClient: () => undefined,
    runMutation: (_method, effect) => effect(),
    preflight: async () => { throw new Error('This test does not read the preflight.'); },
    inspect: async () => { throw new Error('This test does not inspect the Host.'); },
    integrations: () => ({ state: 'healthy', domains: [] }),
    stop: async () => ({ ok: true }),
    close: () => undefined,
    ...overrides,
  };
}

const EXIT_RECEIPT = {
  requestId: 'exit-1',
  clientId: 'instance-owner',
  runtimeId: 'runtime-test',
  accepted: true,
  requestedAt: '2026-11-21T00:00:01.000Z',
  updatedAt: '2026-11-21T00:00:02.000Z',
  recovery: { state: 'pending', checkedAt: '2026-11-21T00:00:03.000Z', reason: 'client_cleanup_pending', nextAction: 'retry_exit' },
  cleanup: {
    actorTurns: [{ actorPath: '/root/helper', turnId: 'turn-1' }],
    operationIds: [],
    state: 'pending',
    runIds: ['run-1'],
    withdrawnInputs: [{ sessionId: 'session-1', inputId: 'input-1' }],
    issues: ['Run run-1 is still stopping.'],
  },
  host: { requested: true, state: 'pending', owner: { runtimeId: 'runtime-test', pid: 4242, kind: 'daemon', processStartIdentity: 'start-1' } },
} as const;

const EXIT_ANSWER = {
  id: 'exit-1',
  runtimeId: 'runtime-test',
  requestedAt: Date.parse('2026-11-21T00:00:01.000Z'),
  updatedAt: Date.parse('2026-11-21T00:00:02.000Z'),
  recovery: { state: 'pending', checkedAt: Date.parse('2026-11-21T00:00:03.000Z'), reason: 'client_cleanup_pending', nextAction: 'retry_exit' },
  cleanup: {
    state: 'pending',
    runIds: ['run-1'],
    actorTurns: [{ actorPath: '/root/helper', turnId: 'turn-1' }],
    withdrawnInputs: [{ sessionId: 'session-1', inputId: 'input-1' }],
    operationIds: [],
    issues: ['Run run-1 is still stopping.'],
  },
  host: { requested: true, state: 'pending' },
};

describe('a v1 failure in v2 terms', () => {
  it('names a quarantined Session by the state its recovery reports', () => {
    const refused = (conflict: string) => hostErrorFromV1({ code: 'conflict', message: 'refused', data: { conflict } });
    expect(refused('actor_settlement_not_persisted')).toMatchObject({ kodaxCode: 'invalid_state', reason: 'session_recovering' });
    expect(refused('recovery_stalled')).toMatchObject({ kodaxCode: 'invalid_state', reason: 'recovery_stalled' });
    expect(refused('revision_conflict')).toMatchObject({ kodaxCode: 'conflict', reason: 'revision_mismatch' });
  });
});

describe('v2 paired devices, served by the peer itself', () => {
  it('lets the owner pair, list and revoke devices', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kodax-host-rpc-devices-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const devices = openHostDeviceRegistry({ file: path.join(dir, 'devices.json') });
    const owner = await connect('owner', undefined, undefined, {}, undefined, { devices: () => devices });

    const { code, expiresAt } = await owner.request('device.pair', { requestId: 'pair-1', name: ' Phone ' }) as
      { code: string; expiresAt: number };
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(await owner.request('device.pair', { requestId: 'pair-1', name: ' Phone ' })).toEqual({ code, expiresAt });
    const { device } = devices.redeem(code, 'https://laptop.example.test')!;
    expect(device.name).toBe('Phone');
    expect(await owner.request('device.list')).toEqual({ items: [device] });

    expect(await owner.request('device.revoke', { requestId: 'revoke-1', deviceId: device.id })).toEqual({});
    expect(await owner.request('device.revoke', { requestId: 'revoke-1', deviceId: device.id })).toEqual({});
    expect(await owner.request('device.list')).toEqual({ items: [] });
  });

  it('says there is nothing to pair when the Host does not listen on the network', async () => {
    const owner = await connect('owner', undefined, undefined, {}, undefined, { devices: () => undefined });
    await expect(owner.request('device.list')).rejects.toMatchObject({ kodaxCode: 'invalid_state', reason: 'not_listening' });
  });

  it('keeps devices from every role but the owner', async () => {
    const user = await connect('user');
    expect(user.handshake.methods.filter(method => method.startsWith('device.'))).toEqual([]);
    await expect(user.request('device.list')).rejects.toMatchObject({ kodaxCode: 'method_not_found' });
  });
});

describe('v2 local management served by the v1 implementation', () => {
  it('tells the owner what the Host is running and how its integrations are', async () => {
    const host = await makeModelHost();
    const runtime = await host.start();
    const management = fakeManagement({
      integrations: () => ({
        state: 'degraded',
        domains: [{
          domain: 'mcp', path: `${HOME}/mcp.json`, source: 'user', watching: true,
          diagnostic: { code: 'invalid-config', message: 'mcp.json is not JSON.', time: '2026-11-21T00:00:04.000Z' },
        }],
      }),
    });
    const owner = await connect('owner', runtime, host.workspace, { management });
    const { session } = await owner.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const held = host.hold();
    await owner.request('input.submit', { requestId: 'ask-1', sessionId: session.id, text: 'Hello.' });
    await held.called;

    expect(await owner.request('host.get')).toEqual({
      host: {
        id: runtime.identity.runtimeId, version: runtime.identity.version, mode: runtime.identity.mode,
        profile: runtime.identity.profile, startedAt: Date.parse(runtime.identity.startedAt),
      },
      // Workflows are counted for the whole process, and other tests in this file left some.
      counts: { sessions: 1, runs: 1, activeRuns: 1, queuedRuns: 0, workflows: expect.any(Number) },
      integrations: {
        state: 'degraded',
        domains: [{
          domain: 'mcp', path: `${HOME}/mcp.json`, source: 'user', watching: true,
          diagnostic: { code: 'invalid-config', message: 'mcp.json is not JSON.', at: Date.parse('2026-11-21T00:00:04.000Z') },
        }],
      },
    });
    held.release();

    const bare = await connect('owner', runtime, host.workspace);
    expect(await bare.request('host.get')).not.toHaveProperty('integrations');
  }, 30_000);

  it('says what keeps the Host from stopping and which process to wait for', async () => {
    const run = { runId: 'run-1', sessionId: 'session-1', phase: 'running' };
    const management = fakeManagement({
      inspect: async () => ({
        runtimeId: 'runtime-test',
        revision: 7,
        ownerPolicy: { mode: 'daemon', revision: 1, updatedAt: '2026-11-21T00:00:00.000Z' },
        owner: { runtimeId: 'runtime-test', pid: 4242, createdAt: '2026-11-21T00:00:00.500Z', kind: 'daemon', processStartIdentity: 'start-1' },
        preflight: {
          runtimeId: 'runtime-test',
          clientCount: 1,
          clients: [{
            daemonConnectionId: 'connection-1', principalId: 'instance-other', name: 'space', title: 'KodaX Space',
            version: '2.0.0', clientType: 'desktop', connectedAt: '2026-11-21T00:00:05.000Z',
          }],
          activeRuns: [run],
          queuedRuns: [{ ...run, runId: 'run-2', phase: 'queued' }],
          activeWorkflows: [{ runId: 'workflow-1' }],
          activeAgentTurns: [{ sessionId: 'session-1', actorPath: '/root/helper', turnId: 'turn-1', kind: 'task' }],
          activeAgentTasks: [{ sessionId: 'session-1', actorPath: '/root/helper', turnId: 'turn-1', kind: 'task' }],
          pendingPermissions: [{ requestId: 'permission-1' }],
          pendingUserInputs: [{ requestId: 'question-1' }],
          pendingBackgroundWork: 2,
          blockers: [
            'connected_clients', 'active_runs', 'queued_runs', 'active_workflows', 'active_agent_turns', 'active_agent_tasks',
            'pending_interactions',
          ],
          canStop: false,
        },
      }) as unknown as Awaited<ReturnType<RuntimeDaemonManagementController['inspect']>>,
    });
    const owner = await connect('owner', fakeRuntime(), undefined, { management });

    expect(await owner.request('host.preflight')).toEqual({
      canStop: false,
      blockers: ['connected_clients', 'active_runs', 'queued_runs', 'active_workflows', 'active_agent_turns', 'pending_interactions'],
      clients: [{ name: 'space', title: 'KodaX Space', version: '2.0.0', type: 'desktop', connectedAt: Date.parse('2026-11-21T00:00:05.000Z') }],
      activeRunIds: ['run-1'],
      queuedRunIds: ['run-2'],
      activeWorkflowIds: ['workflow-1'],
      activeAgentTurns: [{ sessionId: 'session-1', actorPath: '/root/helper', turnId: 'turn-1', kind: 'task' }],
      pendingInteractions: 2,
      pendingBackgroundWork: 2,
      owner: { pid: 4242, createdAt: Date.parse('2026-11-21T00:00:00.500Z'), processStartIdentity: 'start-1' },
    });
  });

  it('stops the Host, refuses while work would be lost, and shows its log', async () => {
    const stop = vi.fn(async () => ({ ok: true as const }));
    const management = fakeManagement({ stop });
    const logs = () => ({
      logFile: `${HOME}/daemon.log`,
      entries: [{ time: '2026-11-21T00:00:06.000Z', level: 'info', message: 'Runtime daemon starting.', data: { pid: 4242 } }],
    });
    const owner = await connect('owner', fakeRuntime(), undefined, { management, logs });

    expect(await owner.request('host.logs')).toEqual({
      logFile: `${HOME}/daemon.log`,
      entries: [{ at: Date.parse('2026-11-21T00:00:06.000Z'), level: 'info', message: 'Runtime daemon starting.', data: { pid: 4242 } }],
    });
    expect(await owner.request('host.stop', { requestId: 'stop-1' })).toEqual({});
    expect(stop).toHaveBeenCalledTimes(1);

    stop.mockRejectedValueOnce(Object.assign(new Error('Runtime daemon cannot stop safely: active_runs.'), { code: 'conflict' }));
    await expect(owner.request('host.stop', { requestId: 'stop-2' })).rejects.toMatchObject({ kodaxCode: 'conflict' });
  });

  it('keeps each client instance to its own exits', async () => {
    const lifecycle = {
      admit: (_principal: string, action: () => Promise<unknown>) => action(),
      assertAdmission: () => undefined,
      hostCleanup: () => undefined,
      request: vi.fn(async () => EXIT_RECEIPT),
      read: vi.fn(async (_principal: string, requestId: string) => (requestId === 'exit-1' ? EXIT_RECEIPT : null)),
      pending: vi.fn(async () => [EXIT_RECEIPT]),
    };
    const owner = await connect('owner', fakeRuntime(), undefined, {
      management: fakeManagement(), clientLifecycle: lifecycle as unknown as RuntimeClientLifecycleController,
    });

    expect(await owner.request('client.exit.request', { requestId: 'exit-1', shutdownHost: true })).toEqual({ exit: EXIT_ANSWER });
    expect(lifecycle.request).toHaveBeenCalledWith('instance-owner', { requestId: 'exit-1', shutdownHost: true });
    expect(await owner.request('client.exit.get', { exitId: 'exit-1' })).toEqual({ exit: EXIT_ANSWER });
    expect(lifecycle.read).toHaveBeenCalledWith('instance-owner', 'exit-1');
    await expect(owner.request('client.exit.get', { exitId: 'exit-2' })).rejects.toMatchObject({
      kodaxCode: 'not_found', reason: 'exit_not_found',
    });
    expect(await owner.request('client.exit.list')).toEqual({ items: [EXIT_ANSWER] });
    expect(lifecycle.pending).toHaveBeenCalledWith('instance-owner');
  });

  it('captures a support bundle and the code index state of a Session', async () => {
    const host = await makeHost();
    const runtime = await host.start();
    const owner = await connect('owner', runtime, host.workspace);
    const { session } = await owner.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;

    const { diagnostics } = await owner.request('session.diagnostics', { sessionId: session.id }) as {
      readonly diagnostics: { readonly [field: string]: unknown };
    };
    expect(diagnostics).toMatchObject({ schemaVersion: 1, sessionId: session.id, runtimeId: runtime.identity.runtimeId });
    expect(diagnostics.run).toMatchObject({ errors: expect.any(Array) });

    const index = await owner.request('repo.intelligence.inspect', { sessionId: session.id });
    expect(index).toEqual({
      configuredMode: expect.any(String), requestedMode: expect.any(String), effectiveEngine: expect.any(String),
      status: expect.any(String), initialized: expect.any(Boolean), warnings: expect.any(Array),
      workspaceRoot: path.join(host.workspaceRoot, 'app'),
    });
    for (let sent = 0; sent < 2; sent += 1) {
      expect(await owner.request('repo.intelligence.prewarm', { requestId: 'warm-1', sessionId: session.id }))
        .toMatchObject({ workspaceRoot: path.join(host.workspaceRoot, 'app') });
    }
  }, 60_000);

  it.each(['user', 'service'] as const)('offers a %s none of it', async (role) => {
    const client = await connect(role, fakeRuntime(), undefined, { management: fakeManagement() });
    for (const method of ['host.get', 'host.preflight', 'host.logs', 'client.exit.list']) {
      await expect(client.request(method)).rejects.toMatchObject({ kodaxCode: 'method_not_found' });
    }
  });
});

describe('v2 reviews served by the v1 implementation', () => {
  type CommandAnswer = { readonly run?: RunFacts; readonly success?: boolean; readonly message?: string };

  /** A project under git with one commit, where `price.ts` has a change not yet committed. */
  async function projectWithChange(projectRoot: string): Promise<(...args: string[]) => void> {
    const git = (...args: string[]) => {
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
        cwd: projectRoot, windowsHide: true, stdio: 'ignore',
      });
    };
    git('init');
    await writeFile(path.join(projectRoot, 'price.ts'), 'export const price = 1;\n');
    git('add', '.');
    git('commit', '-m', 'Start');
    await writeFile(path.join(projectRoot, 'price.ts'), 'export const price = 2; // reviewed-line\n');
    return git;
  }

  it('starts one Run for a review, however often it is sent, and finds it after the changes are gone', async () => {
    const host = await makeModelHost();
    const git = await projectWithChange(path.join(host.workspaceRoot, 'app'));
    const first = await host.start();
    const user = await connect('user', first, host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const review = { requestId: 'review-1', sessionId: session.id, args: ['--lean'] };

    const held = host.hold();
    const started = await user.request('review.start', review) as CommandAnswer;
    expect(started).toEqual({ run: expect.objectContaining({ sessionId: session.id, inputId: 'review-1' }) });
    await held.called;
    expect((await user.request('review.start', review) as CommandAnswer).run?.id).toBe(started.run!.id);
    await expect(user.request('review.start', { ...review, args: [] })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    await expect(user.request('review.start', { ...review, requestId: 'review-2' })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    held.release();

    const { run } = await user.request('run.wait', { runId: started.run!.id }) as RunAnswer;
    expect(run.outcome).toMatchObject({ status: 'completed' });
    // The model was shown the change; the conversation shows what the person typed.
    expect(host.lastRequest().text).toContain('reviewed-line');
    const { items } = await user.request('history.read', { sessionId: session.id }) as unknown as HistoryPage;
    expect(JSON.stringify(items)).toContain('/review --lean');

    // The change is committed and the Host restarts: the review sent again is still the Run it started.
    git('commit', '-am', 'Raise the price');
    const modelCalls = host.calls();
    user.close();
    await first.close();
    const after = await connect('user', await host.start(), host.workspace);
    expect(await after.request('review.start', review)).toEqual({ run });
    await expect(after.request('review.start', { ...review, args: [] })).rejects.toMatchObject({ kodaxCode: 'conflict' });
    expect(host.calls()).toBe(modelCalls);
    // A new review looks at what is there now.
    expect(await after.request('review.start', { ...review, requestId: 'review-3' }))
      .toEqual({ success: true, message: 'No changes to review.' });
  }, 60_000);

  it('adds the guidance to AGENTS.md in a Run, and says so when there is no AGENTS.md', async () => {
    const host = await makeModelHost();
    const projectRoot = path.join(host.workspaceRoot, 'app');
    const user = await connect('user', await host.start(), host.workspace);
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;

    expect(await user.request('agent.reviewLean', { requestId: 'lean-1', sessionId: session.id })).toEqual({
      success: false, message: expect.stringContaining('AGENTS.md does not exist'),
    });
    await writeFile(path.join(projectRoot, 'AGENTS.md'), '# Rules\n\n- Keep it small.\n');
    const { run } = await user.request('agent.reviewLean', { requestId: 'lean-2', sessionId: session.id }) as CommandAnswer;
    expect(run).toMatchObject({ sessionId: session.id, inputId: 'lean-2' });
    expect((await user.request('run.wait', { runId: run!.id }) as RunAnswer).run.outcome).toMatchObject({ status: 'completed' });
    expect(host.lastRequest().text).toContain('Keep it small.');
    expect(await user.request('agent.reviewLean', { requestId: 'lean-2', sessionId: session.id })).toEqual({
      run: expect.objectContaining({ id: run!.id }),
    });
  }, 60_000);
});

describe('v2 user settings served by the v1 implementation', () => {
  type SavedConfig = { readonly config: Record<string, unknown>; readonly revision: string };

  it('reads and changes the saved configuration, and refuses a change made on a stale read', async () => {
    const host = await makeHost();
    const owner = await connect('owner', await host.start(), host.workspace);

    const first = await owner.request('config.get') as SavedConfig & { readonly effective: Record<string, unknown> };
    expect(first).toEqual({
      config: {}, revision: expect.any(String),
      effective: { persisted: 'missing', entries: expect.any(Object), credentials: expect.any(Object), application: expect.any(Object) },
    });

    const updated = await owner.request('config.update', {
      requestId: 'update-1', patch: { model: 'model-one', maxOutputTokens: 1234 }, ifRevision: first.revision,
    }) as SavedConfig;
    expect(updated.config).toEqual({ model: 'model-one', maxOutputTokens: 1234 });
    expect(updated.revision).not.toBe(first.revision);
    expect(await owner.request('config.get')).toMatchObject({ ...updated, effective: { persisted: 'loaded' } });
    const saved = JSON.parse(await readFile(path.join(host.homeDir, '.kodax', 'config.json'), 'utf8')) as unknown;
    expect(saved).toEqual({ model: 'model-one', maxOutputTokens: 1234 });

    // Sent again, on the revision it was made from or on none, it answers with the configuration it left.
    for (const resent of [{ ifRevision: first.revision }, {}]) {
      expect(await owner.request('config.update', { requestId: 'update-1', patch: { model: 'model-one', maxOutputTokens: 1234 }, ...resent }))
        .toEqual(updated);
    }
    // Any other change on the old revision is refused.
    await expect(owner.request('config.update', { requestId: 'update-2', patch: { model: 'model-two' }, ifRevision: first.revision }))
      .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'revision_mismatch' });
    expect((await owner.request('config.get') as SavedConfig).config).toMatchObject({ model: 'model-one' });

    const cleared = { requestId: 'update-3', patch: { model: null }, ifRevision: updated.revision };
    expect((await owner.request('config.update', cleared) as SavedConfig).config).toEqual({ maxOutputTokens: 1234 });
    expect((await owner.request('config.update', cleared) as SavedConfig).config).toEqual({ maxOutputTokens: 1234 });
    for (const patch of [{ agentMode: 'ama' }, { model: 5 }, { maxOutputTokens: -1 }, { workflow: { maxConcurrency: 2, other: 1 } }]) {
      await expect(owner.request('config.update', { requestId: 'update-4', patch })).rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    }

    // Changed behind the Host's back, the file is read again on request.
    await writeFile(path.join(host.homeDir, '.kodax', 'config.json'), JSON.stringify({ model: 'model-nine' }));
    const reloaded = await owner.request('config.reload', { requestId: 'reload-1' }) as SavedConfig;
    expect(reloaded.config).toEqual({ model: 'model-nine' });
    expect(await owner.request('config.reload', { requestId: 'reload-1' })).toEqual(reloaded);
    expect(await owner.request('config.get')).toMatchObject(reloaded);
  });

  it('keeps the providers a person added, and forgets one safely twice', async () => {
    const host = await makeHost();
    const owner = await connect('owner', await host.start(), host.workspace);
    const provider = { name: 'local-llm', protocol: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'LOCAL_LLM_KEY', model: 'small' };

    expect(await owner.request('provider.custom.list')).toEqual({ items: [] });
    expect(await owner.request('provider.custom.upsert', { requestId: 'add-1', provider })).toEqual({ provider });
    expect(await owner.request('provider.custom.list')).toEqual({ items: [provider] });
    const larger = { ...provider, model: 'large' };
    expect(await owner.request('provider.custom.upsert', { requestId: 'add-2', provider: larger })).toEqual({ provider: larger });
    expect(await owner.request('provider.custom.upsert', { requestId: 'add-2', provider: larger })).toEqual({ provider: larger });
    expect(await owner.request('provider.custom.list')).toEqual({ items: [larger] });
    await expect(owner.request('provider.custom.upsert', { requestId: 'add-3', provider: { name: 'broken' } }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });

    expect(await owner.request('provider.custom.remove', { requestId: 'remove-1', name: 'local-llm' })).toEqual({});
    expect(await owner.request('provider.custom.remove', { requestId: 'remove-1', name: 'local-llm' })).toEqual({});
    expect(await owner.request('provider.custom.list')).toEqual({ items: [] });
  });

  it('asks a provider which efforts a model takes, and forgets the answers', async () => {
    const host = await makeModelHost();
    const owner = await connect('owner', await host.start(), host.workspace);

    expect(await owner.request('provider.reasoning.probe', { requestId: 'probe-1', provider: MODEL, efforts: ['low', 'high'] })).toEqual({
      items: [{ effort: 'low', status: expect.any(String) }, { effort: 'high', status: expect.any(String) }],
    });
    expect(await owner.request('provider.reasoning.forget', { requestId: 'forget-1', provider: MODEL })).toEqual({});
    expect(await owner.request('provider.reasoning.forget', { requestId: 'forget-1', provider: MODEL })).toEqual({});
    expect(await owner.request('provider.reasoning.forget', { requestId: 'forget-2' })).toEqual({});
  });

  it.each(['user', 'service'] as const)('offers a %s none of it until a platform opens it', async (role) => {
    const client = await connect(role, fakeRuntime());
    for (const method of ['config.get', 'provider.custom.list']) {
      await expect(client.request(method)).rejects.toMatchObject({ kodaxCode: 'method_not_found' });
    }
  });
});

describe('v2 MCP servers served by the v1 implementation', () => {
  type Server = { readonly name: string; readonly status: string; readonly stale: boolean; readonly config: Record<string, unknown> };

  it('saves a server, connects to it on reload, and lists its tools while another cannot be reached', async () => {
    const host = await makeHost();
    const fixture = await createMcpTestServerFixture(host.homeDir);
    const owner = await connect('owner', await host.start(), host.workspace);
    const config = fixture.servers[fixture.serverId]!;
    const broken = { command: path.join(host.homeDir, 'no-such-command'), startupTimeoutMs: 2_000 };

    expect(await owner.request('mcp.server.list')).toEqual({ items: [] });
    expect(await owner.request('mcp.server.validate', { name: 'echo', config: { type: 'carrier-pigeon' } }))
      .toMatchObject({ ok: false, error: expect.any(String) });
    expect(await owner.request('mcp.server.validate', { name: 'echo', config })).toEqual({ ok: true, config });
    await expect(owner.request('mcp.server.upsert', { requestId: 'add-0', name: 'echo', config: { type: 'carrier-pigeon' } }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });

    expect(await owner.request('mcp.server.upsert', { requestId: 'add-1', name: fixture.serverId, config })).toEqual({ config });
    expect(await owner.request('mcp.server.upsert', { requestId: 'add-1', name: fixture.serverId, config })).toEqual({ config });
    expect(await owner.request('mcp.server.upsert', { requestId: 'add-2', name: 'broken', config: broken })).toEqual({ config: broken });
    expect(await owner.request('mcp.server.get', { name: fixture.serverId })).toEqual({ config });
    await expect(owner.request('mcp.server.get', { name: 'absent' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'mcp_server_not_found' });

    const reloaded = await owner.request('mcp.server.reload', { requestId: 'reload-1' }) as { readonly items: readonly Server[] };
    expect(reloaded.items.map(({ name }) => name)).toEqual([fixture.serverId, 'broken']);
    expect((await owner.request('mcp.server.list') as { readonly items: readonly Server[] }).items[0])
      .toMatchObject({ name: fixture.serverId, config, connect: 'prewarm', status: 'ready', stale: false });

    const tools = await owner.request('mcp.tool.list') as { readonly items: readonly Record<string, unknown>[] };
    expect(tools.items).toEqual([
      { server: fixture.serverId, tools: [expect.objectContaining({ id: fixture.toolId, name: 'echo_tool' })], cachedAt: expect.any(String) },
      { server: 'broken', error: expect.any(String) },
    ]);
    for (let sent = 0; sent < 2; sent += 1) {
      expect(await owner.request('mcp.tool.refresh', { requestId: 'refresh-1', server: fixture.serverId }))
        .toEqual({ items: [tools.items[0]!].map((item) => ({ ...item, cachedAt: expect.any(String) })) });
    }
    await expect(owner.request('mcp.tool.list', { server: 'absent' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'mcp_server_not_found' });

    expect(await owner.request('mcp.server.remove', { requestId: 'remove-1', name: 'broken' })).toEqual({});
    expect(await owner.request('mcp.server.remove', { requestId: 'remove-1', name: 'broken' })).toEqual({});
    expect((await owner.request('mcp.server.list') as { readonly items: readonly Server[] }).items.map(({ name }) => name))
      .toEqual([fixture.serverId]);
  });

  it.each(['user', 'service'] as const)('offers a %s none of it until a platform opens it', async (role) => {
    const client = await connect(role, fakeRuntime());
    await expect(client.request('mcp.server.list')).rejects.toMatchObject({ kodaxCode: 'method_not_found' });
  });
});

describe('v2 extensions and external Agents served by the v1 implementation', () => {
  it('lists the extensions the Host loaded and the ones that failed, again after a reload', async () => {
    const host = await makeHost();
    const good = path.join(host.homeDir, 'good.mjs');
    const broken = path.join(host.homeDir, 'broken.mjs');
    await writeFile(good, 'export default function () {}');
    await writeFile(broken, 'throw new Error("broken on load");');
    await mkdir(path.join(host.homeDir, '.kodax'), { recursive: true });
    await writeFile(path.join(host.homeDir, '.kodax', 'config.json'), JSON.stringify({ extensions: [good, broken] }));
    const owner = await connect('owner', await host.start(), host.workspace);

    const listed = await owner.request('extension.list');
    expect(listed).toEqual({
      active: true,
      extensions: [{ path: good, label: expect.any(String), loadSource: 'config' }],
      failures: [expect.objectContaining({ stage: 'load', message: expect.stringContaining('broken on load') })],
    });
    // A reload reads the loaded modules again; the one that failed waits for a restart.
    await writeFile(broken, 'export default function () {}');
    expect(await owner.request('extension.reload', { requestId: 'reload-1' })).toMatchObject({
      active: true, extensions: [{ path: good, loadSource: 'config' }],
    });
  });

  it('registers an external Agent under the conditions a manager sets', async () => {
    const host = await makeHost();
    const runtime = await createKodaXRuntime({
      homeDir: host.homeDir,
      sharedDaemonHost: true,
      externalAgents: {
        factories: [createReferenceAgentExecutorFactory({ executorId: 'reference-http', protocol: 'http' })],
        policy: async () => ({ allowed: true }),
        defaultContext: { actorId: 'runtime-host' },
      },
    });
    cleanup.push(() => runtime.close());
    const owner = await connect('owner', runtime, host.workspace, { allowAgentRegistrationAdmin: true });
    const registration = {
      agentId: 'external:partner', displayName: 'Partner', enabled: true, executorId: 'reference-http', protocol: 'http',
      configurationRevision: 'rev-1', endpointIdentityHash: 'sha256:partner', executorConfig: { output: 'ok' },
      capabilities: { streaming: 'supported', durableTasks: 'supported', inputRequired: 'supported', cancellation: 'supported', artifacts: 'supported' },
      effects: { remote: 'read', workspace: 'proposal' },
    };

    expect(await owner.request('agent.registration.list')).toEqual({ items: [] });
    const { registration: saved } = await owner.request('agent.registration.upsert', {
      requestId: 'add-1', registration, ifRevision: null, ifOwner: null,
    }) as { readonly registration: Record<string, unknown> };
    expect(saved).toMatchObject({ agentId: 'external:partner', configurationRevision: 'rev-1', credentialConfigured: false, diagnostics: [] });
    expect(saved).not.toHaveProperty('executorConfig');
    // Sent again, with its conditions or without, it is answered with what it saved; other content insisting nothing is there is refused.
    expect(await owner.request('agent.registration.upsert', { requestId: 'add-1', registration, ifRevision: null, ifOwner: null }))
      .toEqual({ registration: saved });
    expect(await owner.request('agent.registration.upsert', { requestId: 'add-1', registration })).toEqual({ registration: saved });
    await expect(owner.request('agent.registration.upsert', {
      requestId: 'add-2', registration: { ...registration, displayName: 'Other' }, ifRevision: null,
    })).rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'external_agent_registration_conflict' });

    const claim = { requestId: 'claim-1', agentId: 'external:partner', enabled: false, claimOwner: 'platform', ifRevision: 'rev-1', ifOwner: null };
    const claimed = await owner.request('agent.registration.setEnabled', claim);
    expect(claimed).toMatchObject({ registration: { enabled: false, managementOwner: 'platform' } });
    expect(await owner.request('agent.registration.setEnabled', claim)).toEqual(claimed);
    await expect(owner.request('agent.registration.setEnabled', { requestId: 'enable-1', agentId: 'external:partner', enabled: true, ifOwner: 'someone-else' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'external_agent_registration_conflict' });
    await expect(owner.request('agent.registration.setEnabled', { requestId: 'claim-2', agentId: 'external:absent', enabled: true }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'agent_not_found' });
    await expect(owner.request('agent.registration.remove', { requestId: 'remove-0', agentId: 'external:partner', ifOwner: 'someone-else' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'external_agent_registration_conflict' });
    expect((await owner.request('agent.registration.list') as { readonly items: readonly unknown[] }).items).toHaveLength(1);

    const remove = { requestId: 'remove-1', agentId: 'external:partner', ifOwner: 'platform' };
    expect(await owner.request('agent.registration.remove', remove)).toEqual({});
    expect(await owner.request('agent.registration.remove', remove)).toEqual({});
    expect(await owner.request('agent.registration.list')).toEqual({ items: [] });
  });

  it('says a Host started without external Agents has no registrations to manage', async () => {
    const host = await makeHost();
    const owner = await connect('owner', await host.start(), host.workspace, { allowAgentRegistrationAdmin: true });
    await expect(owner.request('agent.registration.list')).rejects.toMatchObject({ kodaxCode: 'method_not_found' });
  });

  it.each(['user', 'service'] as const)('offers a %s none of it until a platform opens it', async (role) => {
    const client = await connect(role, fakeRuntime());
    for (const method of ['extension.list', 'agent.registration.list']) {
      await expect(client.request(method)).rejects.toMatchObject({ kodaxCode: 'method_not_found' });
    }
  });
});

describe('v2 Learning served by the v1 implementation', () => {
  type Learning = { readonly id: string; readonly lifecycle: string; readonly revision: number; readonly [field: string]: unknown };

  it('lets the owner read and decide on what the Host learned, and says why a decision is refused', async () => {
    const host = await makeHost();
    await createLearningCenterService({ rootDir: path.join(host.homeDir, '.kodax', 'learned'), clientIdentity: 'seed' }).record({
      schemaVersion: 1,
      capabilityId: 'lc_host_rpc',
      displayName: 'Release check',
      slug: 'release-check',
      carrier: 'skill',
      lifecycle: 'ready',
      revision: 1,
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
      source: { kind: 'learning_controller' },
    });
    const runtime = await host.start();
    const owner = await connect('owner', runtime, host.workspace);
    const created = Date.parse('2026-07-17T00:00:00.000Z');

    // The Host's bookkeeping, such as where the capability came from, stays inside.
    expect(await owner.request('learning.list', { lifecycle: 'ready' })).toEqual({
      items: [{
        id: 'lc_host_rpc', name: 'Release check', slug: 'release-check', carrier: 'skill', lifecycle: 'ready',
        revision: 1, createdAt: created, updatedAt: created,
      }],
      revision: 1,
    });
    expect(await owner.request('learning.snapshot')).toMatchObject({ ready: 1, revision: 1 });
    expect(await owner.request('learning.events', { afterRevision: 0 })).toEqual({
      items: [expect.objectContaining({ sequence: 1, kind: 'ready', capabilityId: 'lc_host_rpc', name: 'Release check', createdAt: expect.any(Number) })],
    });
    expect(await owner.request('learning.snooze', { requestId: 'snooze-1', nameOrSlug: 'release-check', until: Date.now() + 86_400_000 }))
      .toEqual({});
    expect(await owner.request('learning.snapshot')).toMatchObject({ ready: 0 });

    expect(await owner.request('learning.reject', { requestId: 'reject-1', nameOrSlug: 'Release check' })).toEqual({});
    const { capability } = await owner.request('learning.get', { nameOrSlug: 'lc_host_rpc' }) as { capability: Learning };
    expect(capability).toMatchObject({ lifecycle: 'rejected', revision: 2 });
    // Sent again after it took effect, the decision is refused; the capability says where it stands.
    await expect(owner.request('learning.reject', { requestId: 'reject-1', nameOrSlug: 'release-check' }))
      .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'invalid_transition' });
    await expect(owner.request('learning.get', { nameOrSlug: 'missing' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'capability_not_found' });
    await expect(owner.request('learning.promote', { requestId: 'promote-1', nameOrSlug: 'release-check', scope: 'project' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });

    for (const role of ['user', 'service'] as const) {
      const client = await connect(role, runtime, host.workspace);
      await expect(client.request('learning.list', {})).rejects.toMatchObject({ kodaxCode: 'method_not_found' });
    }
  });
});

describe('v2 credential leases served by the v1 reverse bridge', () => {
  type LeaseRequest = { readonly callId: string; readonly [field: string]: unknown };

  /** Answers every `lease.request` with `answer`, and keeps what the Host asked. */
  function lend(client: HostRpcClient, answer: { readonly credential: string } | { readonly error: string }): LeaseRequest[] {
    const asked: LeaseRequest[] = [];
    client.onNotification((method, params) => {
      if (method !== 'lease.request') return;
      const request = params as LeaseRequest;
      asked.push(request);
      void client.request('lease.complete', { requestId: `complete-${request.callId}`, kind: 'credential', callId: request.callId, ...answer });
    });
    return asked;
  }

  it('hands a Run the provider key the client lends, and keeps the key off the Host', async () => {
    const host = await makeModelHost();
    const owner = await connect('owner', await host.start(), host.workspace);
    const register = { requestId: 'lease-1', kind: 'credential', providers: [MODEL] };
    const lease = { id: 'lease-1', kind: 'credential', providers: [MODEL] };
    expect(await owner.request('lease.register', register)).toEqual({ lease });
    // Sent again, the same lease answers; another intent under the id is refused.
    expect(await owner.request('lease.register', register)).toEqual({ lease });
    await expect(owner.request('lease.register', { ...register, providers: ['other'] }))
      .rejects.toMatchObject({ kodaxCode: 'conflict' });
    expect(await owner.request('lease.resume', { kind: 'credential', leaseId: 'lease-1' })).toEqual({ lease });
    const asked = lend(owner, { credential: 'leased-key' });

    const { session } = await owner.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const { input } = await owner.request('input.submit', {
      requestId: 'input-1', sessionId: session.id, text: 'Say done.', leases: { credential: 'lease-1' },
    }) as InputAnswer;
    const { run } = await owner.request('run.wait', { runId: input.runId }) as RunAnswer;
    expect(run.outcome).toMatchObject({ status: 'completed' });
    expect(host.lastRequest().apiKey).toBe('leased-key');
    expect(asked[0]).toEqual({
      callId: expect.any(String), kind: 'credential', leaseId: 'lease-1', provider: MODEL, sessionId: session.id,
      target: { kind: 'run', runId: input.runId }, purpose: expect.any(String),
      connectionFingerprint: expect.any(String), credentialContextVersion: expect.any(Number),
    });
    // The request was answered once; a late answer learns that, as does the same answer sent again.
    const late = { requestId: 'late-1', kind: 'credential', callId: asked[0]!.callId, credential: 'again' };
    expect(await owner.request('lease.complete', late)).toEqual({ status: 'already_settled' });
    expect(await owner.request('lease.complete', late)).toEqual({ status: 'already_settled' });
    expect(JSON.stringify(await owner.request('lease.resume', { kind: 'credential', leaseId: 'lease-1' }))).not.toContain('leased-key');

    // Without the lease, the Run uses what the Host has.
    const { input: plain } = await owner.request('input.submit', { requestId: 'input-2', sessionId: session.id, text: 'Again.' }) as InputAnswer;
    await owner.request('run.wait', { runId: plain.runId });
    expect(host.lastRequest().apiKey).toBe('offline-test');
  });

  it('fails the Run when the client has no key to lend', async () => {
    const host = await makeModelHost();
    const owner = await connect('owner', await host.start(), host.workspace);
    await owner.request('lease.register', { requestId: 'lease-1', kind: 'credential', providers: [MODEL] });
    lend(owner, { error: 'no key here' });
    const { session } = await owner.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const { input } = await owner.request('input.submit', {
      requestId: 'input-1', sessionId: session.id, text: 'Say done.', leases: { credential: 'lease-1' },
    }) as InputAnswer;
    const { run } = await owner.request('run.wait', { runId: input.runId }) as RunAnswer;
    expect(run.outcome).toMatchObject({ status: 'failed' });
    expect(host.calls()).toBe(0);
  });

  it('refuses a lease it does not hold, and one that was revoked', async () => {
    const host = await makeModelHost();
    const owner = await connect('owner', await host.start(), host.workspace);
    const { session } = await owner.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    await expect(owner.request('input.submit', {
      requestId: 'input-1', sessionId: session.id, text: 'Say done.', leases: { credential: 'missing' },
    })).rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'lease_not_found' });
    await expect(owner.request('lease.resume', { kind: 'credential', leaseId: 'missing' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'lease_not_found' });

    await owner.request('lease.register', { requestId: 'lease-1', kind: 'credential', providers: [MODEL] });
    expect(await owner.request('lease.revoke', { requestId: 'revoke-1', kind: 'credential', leaseId: 'lease-1' })).toEqual({});
    expect(await owner.request('lease.revoke', { requestId: 'revoke-1', kind: 'credential', leaseId: 'lease-1' })).toEqual({});
    await expect(owner.request('lease.resume', { kind: 'credential', leaseId: 'lease-1' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
    await expect(owner.request('lease.complete', { requestId: 'complete-1', kind: 'credential', callId: 'never-asked', credential: 'k', error: 'e' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });
    expect(host.calls()).toBe(0);
  });

  it('keeps a lease for the same client instance across a reconnect, and for no other', async () => {
    const host = await makeModelHost();
    const runtime = await host.start();
    const reverseBridgeHub = createRuntimeDaemonReverseBridgeHub();
    cleanup.push(() => reverseBridgeHub.close());
    const secret = 's'.repeat(32);
    const first = await connect('owner', runtime, host.workspace, { reverseBridgeHub }, secret);
    await first.request('lease.register', { requestId: 'lease-1', kind: 'credential', providers: [MODEL] });

    // The same instance takes over: the old connection is closed and the lease answers on the new one.
    const second = await connect('owner', runtime, host.workspace, { reverseBridgeHub }, secret);
    await first.closed;
    expect(await second.request('lease.resume', { kind: 'credential', leaseId: 'lease-1' }))
      .toEqual({ lease: { id: 'lease-1', kind: 'credential', providers: [MODEL] } });
    lend(second, { credential: 'leased-key' });
    const { session } = await second.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const { input } = await second.request('input.submit', {
      requestId: 'input-1', sessionId: session.id, text: 'Say done.', leases: { credential: 'lease-1' },
    }) as InputAnswer;
    expect((await second.request('run.wait', { runId: input.runId }) as RunAnswer).run.outcome).toMatchObject({ status: 'completed' });
    expect(host.lastRequest().apiKey).toBe('leased-key');

    // Another instance of the same person holds leases of its own.
    const other = await connect('owner', runtime, host.workspace, { reverseBridgeHub }, 't'.repeat(32));
    await expect(other.request('lease.resume', { kind: 'credential', leaseId: 'lease-1' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
  });

  it('lends nothing for a role that cannot', async () => {
    const host = await makeModelHost();
    const runtime = await host.start();
    const user = await connect('user', runtime, host.workspace);
    await expect(user.request('lease.register', { requestId: 'lease-1', kind: 'credential', providers: [MODEL] }))
      .rejects.toMatchObject({ kodaxCode: 'method_not_found' });
    const { session } = await user.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    await expect(user.request('input.submit', {
      requestId: 'input-1', sessionId: session.id, text: 'Say done.', leases: { credential: 'lease-1' },
    })).rejects.toMatchObject({ kodaxCode: 'forbidden', reason: 'param_not_allowed' });

    // A backend lends keys as the owner does.
    const service = await connect('service', runtime, host.workspace);
    expect(await service.request('lease.register', { requestId: 'lease-1', kind: 'credential', providers: [MODEL] }))
      .toMatchObject({ lease: { id: 'lease-1' } });
  });
});

describe('v2 Host Tool leases served by the v1 reverse bridge', () => {
  type ToolCall = { readonly callId: string; readonly kind: string; readonly input: Record<string, unknown>; readonly [field: string]: unknown };
  const LOOKUP = {
    name: 'lookup_order', description: 'Finds an order by its id.', sideEffect: 'none',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  };

  /** A model that calls `lookup_order` once, then answers with what it read. */
  function orderModel() {
    return makeModelHost((messages) => (JSON.stringify(messages).includes('tool_result')
      ? { textBlocks: [{ type: 'text', text: 'done' }], toolBlocks: [], thinkingBlocks: [] }
      : { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
        toolBlocks: [{ type: 'tool_use', id: 'call-1', name: 'lookup_order', input: { id: 'A1' } }] }));
  }

  /** Keeps every tool call the Host sends, and answers it with `answer` when one is given. */
  function serve(client: HostRpcClient, answer?: (call: ToolCall) => Record<string, unknown>): ToolCall[] {
    const calls: ToolCall[] = [];
    client.onNotification((method, params) => {
      const call = params as ToolCall;
      if (method !== 'lease.request' || call.kind !== 'host_tool') return;
      calls.push(call);
      if (answer !== undefined) {
        void client.request('lease.complete', { requestId: `complete-${call.callId}`, kind: 'host_tool', callId: call.callId, ...answer(call) });
      }
    });
    return calls;
  }

  it('lets a Run call the tools the client lends, and gives the model what the client answered', async () => {
    const host = await orderModel();
    const owner = await connect('owner', await host.start(), host.workspace);
    const register = { requestId: 'tools-1', kind: 'host_tool', tools: [LOOKUP] };
    const lease = { id: 'tools-1', kind: 'host_tool', tools: [LOOKUP] };
    expect(await owner.request('lease.register', register)).toEqual({ lease });
    // Sent again, the same lease answers; other tools under the id are refused.
    expect(await owner.request('lease.register', register)).toEqual({ lease });
    await expect(owner.request('lease.register', { ...register, tools: [{ ...LOOKUP, description: 'Another.' }] }))
      .rejects.toMatchObject({ kodaxCode: 'conflict', reason: 'request_id_reused' });
    expect(await owner.request('lease.resume', { kind: 'host_tool', leaseId: 'tools-1' })).toEqual({ lease });
    const calls = serve(owner, () => ({ result: { content: 'Order A1 ships on Friday.', structuredContent: { ships: 'Friday' } } }));

    const { session } = await owner.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const { input } = await owner.request('input.submit', {
      requestId: 'input-1', sessionId: session.id, text: 'When does A1 ship?', leases: { hostTools: 'tools-1' },
    }) as InputAnswer;
    const { run } = await owner.request('run.wait', { runId: input.runId }) as RunAnswer;
    expect(run.outcome).toMatchObject({ status: 'completed' });
    expect(calls).toEqual([{
      callId: expect.any(String), kind: 'host_tool', leaseId: 'tools-1', sessionId: session.id, runId: input.runId,
      tool: 'lookup_order', input: { id: 'A1' }, sideEffect: 'none',
    }]);
    expect(host.lastRunRequest().text).toContain('Order A1 ships on Friday.');
    expect(await owner.request('lease.call.get', { callId: calls[0]!.callId })).toEqual({ call: {
      callId: calls[0]!.callId, leaseId: 'tools-1', tool: 'lookup_order', sessionId: session.id, runId: input.runId,
      state: 'completed', updatedAt: expect.any(Number),
    } });
    // The call was answered once; a late answer learns that.
    expect(await owner.request('lease.complete', {
      requestId: 'late-1', kind: 'host_tool', callId: calls[0]!.callId, result: { content: 'again' },
    })).toEqual({ status: 'already_settled' });
    await expect(owner.request('lease.complete', { requestId: 'complete-2', kind: 'host_tool', callId: calls[0]!.callId }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });

    // A Run without the lease is not offered the tool.
    const { input: plain } = await owner.request('input.submit', { requestId: 'input-2', sessionId: session.id, text: 'Again.' }) as InputAnswer;
    await owner.request('run.wait', { runId: plain.runId });
    expect(host.lastRunRequest().tools).not.toContain('lookup_order');
  });

  it('tells the model and the client that a call the client was handling when it went away has an unknown outcome', async () => {
    const host = await orderModel();
    const runtime = await host.start();
    const reverseBridgeHub = createRuntimeDaemonReverseBridgeHub();
    cleanup.push(() => reverseBridgeHub.close());
    const secret = 's'.repeat(32);
    const first = await connect('service', runtime, host.workspace, { reverseBridgeHub }, secret);
    await first.request('lease.register', { requestId: 'tools-1', kind: 'host_tool', tools: [LOOKUP] });
    const calls = serve(first);
    const { session } = await first.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    const { input } = await first.request('input.submit', {
      requestId: 'input-1', sessionId: session.id, text: 'When does A1 ship?', leases: { hostTools: 'tools-1' },
    }) as InputAnswer;
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    // The same instance comes back on a new connection, and the call it was handling is gone with the old one.
    const second = await connect('service', runtime, host.workspace, { reverseBridgeHub }, secret);
    await first.closed;
    const { run } = await second.request('run.wait', { runId: input.runId }) as RunAnswer;
    expect(run.outcome).toMatchObject({ status: 'completed' });
    expect(host.lastRunRequest().text).toContain('outcome is unknown');
    expect(await second.request('lease.call.get', { callId: calls[0]!.callId }))
      .toMatchObject({ call: { state: 'unknown', tool: 'lookup_order' } });
    expect(await second.request('lease.complete', {
      requestId: 'late-1', kind: 'host_tool', callId: calls[0]!.callId, result: { content: 'Order A1 ships on Friday.' },
    })).toEqual({ status: 'already_settled' });
    await expect(second.request('lease.call.get', { callId: 'never-made' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'call_not_found' });
  });

  it('refuses a lease it does not hold, a revoked one, and tools where only a key fits', async () => {
    const host = await orderModel();
    const runtime = await host.start();
    const owner = await connect('owner', runtime, host.workspace);
    const { session } = await owner.request('session.create', { requestId: 'create-1', project: 'app' }) as SessionAnswer;
    await expect(owner.request('input.submit', {
      requestId: 'input-1', sessionId: session.id, text: 'Hi.', leases: { hostTools: 'missing' },
    })).rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'lease_not_found' });
    await expect(owner.request('lease.resume', { kind: 'host_tool', leaseId: 'missing' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'lease_not_found' });
    // A compaction starts no Run, so it has no tools to borrow.
    await expect(owner.request('session.compact', { requestId: 'compact-1', sessionId: session.id, leases: { hostTools: 'tools-1' } }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_params' });

    await owner.request('lease.register', { requestId: 'tools-1', kind: 'host_tool', tools: [LOOKUP] });
    // A credential lease and a tool lease are kept apart.
    await expect(owner.request('lease.resume', { kind: 'credential', leaseId: 'tools-1' }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
    expect(await owner.request('lease.revoke', { requestId: 'revoke-1', kind: 'host_tool', leaseId: 'tools-1' })).toEqual({});
    expect(await owner.request('lease.revoke', { requestId: 'revoke-1', kind: 'host_tool', leaseId: 'tools-1' })).toEqual({});
    await expect(owner.request('input.submit', {
      requestId: 'input-2', sessionId: session.id, text: 'Hi.', leases: { hostTools: 'tools-1' },
    })).rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'lease_not_found' });
    expect(host.calls()).toBe(0);

    const user = await connect('user', runtime, host.workspace);
    await expect(user.request('lease.call.get', { callId: 'any' })).rejects.toMatchObject({ kodaxCode: 'method_not_found' });
  });

  describe('bound to a Session', () => {
    /** A service, and a person on the same Host. The service is one client instance that can come back. */
    async function threeParties(model = orderModel()) {
      const host = await model;
      const runtime = await host.start();
      const reverseBridgeHub = createRuntimeDaemonReverseBridgeHub();
      cleanup.push(() => reverseBridgeHub.close());
      const service = () => connect('service', runtime, host.workspace, { reverseBridgeHub }, 's'.repeat(32));
      const backend = await service();
      const user = await connect('user', runtime, host.workspace, { reverseBridgeHub });
      return { host, runtime, reverseBridgeHub, service, backend, user };
    }

    /** Answers the key requests of a client with `key`. */
    function lendKey(client: HostRpcClient, key: string): void {
      client.onNotification((method, params) => {
        const request = params as { readonly kind: string; readonly callId: string };
        if (method !== 'lease.request' || request.kind !== 'credential') return;
        void client.request('lease.complete', { requestId: `complete-${request.callId}`, kind: 'credential', callId: request.callId, credential: key });
      });
    }

    it('serves the tools a service bound to a Session to a Run a person submits there, within the policy', async () => {
      const { host, backend, user } = await threeParties();
      await backend.request('lease.register', { requestId: 'tools-1', kind: 'host_tool', tools: [LOOKUP] });
      const calls = serve(backend, () => ({ result: { content: 'Order A1 ships on Friday.' } }));
      const policy = { tools: ['lookup_order'], leases: { hostTools: 'tools-1' } };
      const { session } = await backend.request('session.create', { requestId: 'create-1', project: 'app', policy }) as SessionAnswer;
      // Everyone reads which leases are bound; nobody reads which client instance holds them.
      expect(await user.request('session.policy.get', { sessionId: session.id })).toEqual({ policy: { ...policy, interactions: 'reject' } });

      const { input } = await user.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'When does A1 ship?' }) as InputAnswer;
      const { run } = await user.request('run.wait', { runId: input.runId }) as RunAnswer;
      expect(run.outcome).toMatchObject({ status: 'completed' });
      expect(calls).toEqual([expect.objectContaining({ leaseId: 'tools-1', sessionId: session.id, runId: input.runId, tool: 'lookup_order' })]);
      expect(host.lastRunRequest().text).toContain('Order A1 ships on Friday.');
      expect(host.lastRunRequest().tools).toEqual(['lookup_order']);

      // A Run there brings no leases of its own: the Session decides where its calls go.
      await backend.request('lease.register', { requestId: 'tools-2', kind: 'host_tool', tools: [{ ...LOOKUP, name: 'other_tool' }] });
      await expect(backend.request('input.submit', {
        requestId: 'input-2', sessionId: session.id, text: 'Hi.', leases: { hostTools: 'tools-2' },
      })).rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'lease_bound_by_session' });

      // An update replaces the policy for later Runs; without the lease the tool is gone.
      for (let sent = 0; sent < 2; sent += 1) {
        expect(await backend.request('session.policy.update', { requestId: 'update-1', sessionId: session.id, policy: {} }))
          .toEqual({ policy: { interactions: 'reject' } });
      }
      const { input: later } = await user.request('input.submit', { requestId: 'input-3', sessionId: session.id, text: 'Again.' }) as InputAnswer;
      await user.request('run.wait', { runId: later.runId });
      expect(host.lastRunRequest().tools).toContain('read');
      expect(host.lastRunRequest().tools).not.toContain('lookup_order');
      await expect(user.request('session.policy.update', { requestId: 'update-2', sessionId: session.id, policy: {} }))
        .rejects.toMatchObject({ kodaxCode: 'method_not_found' });
    });

    it('holds a tool call while the service is away, and refuses a Run that needs its key', async () => {
      const { host, service, backend, user } = await threeParties();
      await backend.request('lease.register', { requestId: 'tools-1', kind: 'host_tool', tools: [LOOKUP] });
      await backend.request('lease.register', { requestId: 'key-1', kind: 'credential', providers: [MODEL] });
      const { session: tools } = await backend.request('session.create', {
        requestId: 'create-1', project: 'app', policy: { leases: { hostTools: 'tools-1' } },
      }) as SessionAnswer;
      const { session: keyed } = await backend.request('session.create', {
        requestId: 'create-2', project: 'app', policy: { leases: { credential: 'key-1' } },
      }) as SessionAnswer;
      backend.close();
      await backend.closed;

      await expect(user.request('input.submit', { requestId: 'input-1', sessionId: keyed.id, text: 'Hi.' }))
        .rejects.toMatchObject({ kodaxCode: 'unavailable', reason: 'lease_holder_away' });
      const { input } = await user.request('input.submit', { requestId: 'input-2', sessionId: tools.id, text: 'When does A1 ship?' }) as InputAnswer;

      // The service comes back, asks for its lease, and the call that waited goes out.
      const back = await service();
      const calls = serve(back, () => ({ result: { content: 'Order A1 ships on Friday.' } }));
      lendKey(back, 'leased-key');
      await back.request('lease.resume', { kind: 'host_tool', leaseId: 'tools-1' });
      const { run } = await user.request('run.wait', { runId: input.runId }) as RunAnswer;
      expect(run.outcome).toMatchObject({ status: 'completed' });
      expect(calls).toHaveLength(1);
      expect(host.lastRunRequest().text).toContain('Order A1 ships on Friday.');

      // Back online, the Session's key serves a Run a person submits.
      const { input: keyedInput } = await user.request('input.submit', { requestId: 'input-3', sessionId: keyed.id, text: 'Hi.' }) as InputAnswer;
      expect((await user.request('run.wait', { runId: keyedInput.runId }) as RunAnswer).run.outcome).toMatchObject({ status: 'completed' });
      expect(host.lastRunRequest().apiKey).toBe('leased-key');
    });

    it('binds only leases the creator holds, as a client instance that can come back', async () => {
      const { runtime, host, reverseBridgeHub, backend } = await threeParties();
      await expect(backend.request('session.create', {
        requestId: 'create-1', project: 'app', policy: { leases: { hostTools: 'missing' } },
      })).rejects.toMatchObject({ kodaxCode: 'not_found', reason: 'lease_not_found' });
      // A connection without an instance secret is gone for good once closed, and so would be the binding.
      const owner = await connect('owner', runtime, host.workspace, { reverseBridgeHub });
      await owner.request('lease.register', { requestId: 'tools-1', kind: 'host_tool', tools: [LOOKUP] });
      await expect(owner.request('session.create', {
        requestId: 'create-2', project: 'app', policy: { leases: { hostTools: 'tools-1' } },
      })).rejects.toMatchObject({ kodaxCode: 'invalid_params', reason: 'instance_identity_required' });
      await expect(backend.request('session.policy.update', { requestId: 'update-1', sessionId: 'no-such-session', policy: {} }))
        .rejects.toMatchObject({ kodaxCode: 'not_found' });
    });
  });
});

describe('the CLI credential binding over a v2 Host client', () => {
  it('lends the key an authorizer acquires to a Run, and revokes the lease when the binding closes', async () => {
    const host = await makeModelHost();
    const rpc = await connect('owner', await host.start(), host.workspace);
    const onError = vi.fn();
    const client = await createKodaXHostClient({ open: async () => rpc, onError });
    cleanup.push(() => client.close());
    const acquire = vi.fn(async () => 'acquired-key');
    const binding = await bindRequestCredentials({ credentials: createHostCredentialService(client), providers: [MODEL], acquire });

    const { session } = await client.call('session.create', { requestId: 'create-1', project: 'app' });
    const { input } = await client.call('input.submit', {
      requestId: 'input-1', sessionId: session.id, text: 'Say done.', leases: { credential: binding.credential.leaseId },
    });
    const { run } = await client.call('run.wait', { runId: input.runId! });
    expect(run.outcome).toMatchObject({ status: 'completed' });
    expect(host.lastRequest().apiKey).toBe('acquired-key');
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
      requestId: expect.any(String), leaseId: binding.credential.leaseId, provider: MODEL, sessionId: session.id,
      target: { kind: 'run', runId: input.runId },
    }), expect.any(AbortSignal));

    await binding.close();
    await expect(client.call('lease.resume', { kind: 'credential', leaseId: binding.credential.leaseId }))
      .rejects.toMatchObject({ kodaxCode: 'not_found' });
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('v2 connections from the network, admitted by their credential', () => {
  /** Tokens the test issuer knows, and the credential each stands for. */
  const issued = new Map<string, HostCredential>();
  /** Without `auth`, the transport already proved who the client is, as a paired browser's cookie does. */
  const authenticate = async (auth: { readonly token: string } | undefined): Promise<HostCredential> => {
    const credential = issued.get(auth?.token ?? 'by-transport');
    if (credential === undefined) throw new HostProtocolError('unauthorized', 'The token is not good.', { reason: 'invalid_credential' });
    return credential;
  };
  afterEach(() => issued.clear());

  /** A client reaching the bridge as a network transport would carry it, with the reasons the Host gave for hanging up. */
  async function connectOverNetwork(token: string | undefined, scheme: 'jwt' | 'ipc' = 'jwt') {
    const reasons: HostCloseReason[] = [];
    let created: ReturnType<typeof createRuntimeDaemonHostRpcPeer> | undefined;
    const client = await connectHostRpc(async (events) => {
      let open = true;
      const end = (): void => {
        if (!open) return;
        open = false;
        peer.close();
        events.end();
      };
      const peer = createRuntimeDaemonHostRpcPeer({
        protocol: hostRpcProtocol,
        // A network endpoint has no shared secret: the credential alone admits the client.
        dispatcher: { role: 'owner', runtime: fakeRuntime() },
        authenticate,
        limits: { maxFrameBytes: 1024 * 1024 },
        send: frame => queueMicrotask(() => { if (open) events.frame(frame); }),
        disconnect: (reason) => { reasons.push(reason); queueMicrotask(end); },
        congested: () => false,
      });
      created = peer;
      return { send: frame => queueMicrotask(() => { if (open) peer.receive(frame); }), close: end };
    }, { client: { name: 'web', version: '1.0.0', instanceId: 'browser-1' }, ...(token !== undefined ? { auth: { scheme, token } } : {}) });
    cleanup.push(() => client.close());
    return { client, reasons, peer: created! };
  }

  it('admits a client its transport already proved, such as a paired browser, without auth, and has nothing for it to renew', async () => {
    issued.set('by-transport', { role: 'user', subject: 'dev_0123456789ab' });
    const { client } = await connectOverNetwork(undefined);
    expect(client.handshake).toMatchObject({ role: 'user', subject: 'person' });
    expect(client.handshake.expiresAt).toBeUndefined();
    await expect(client.request('auth.renew', { token: 'anything' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_state', reason: 'credential_does_not_expire' });
  });

  it('refuses a client with no credential at all', async () => {
    await expect(connectOverNetwork(undefined)).rejects.toMatchObject({ kodaxCode: 'unauthorized' });
  });

  it('tells an admitted client that the Host is draining, and keeps the connection', async () => {
    issued.set('owner-token', { role: 'user', subject: 'user-42' });
    const { client, peer, reasons } = await connectOverNetwork('owner-token');
    const notices: string[] = [];
    client.onNotification(method => notices.push(method));
    peer.draining();
    await vi.waitFor(() => expect(notices).toEqual(['host.draining']));
    await expect(client.request('ping')).resolves.toEqual({});
    expect(reasons).toEqual([]);
  });

  it('admits the owner as user and a backend as that service, whatever role the endpoint was built with', async () => {
    issued.set('owner-token', { role: 'user', subject: 'user-42', expiresAt: Date.now() + 60_000 });
    issued.set('backend-token', { role: 'service', subject: 'backend' });

    const { client: user } = await connectOverNetwork('owner-token');
    expect(user.handshake).toMatchObject({ role: 'user', subject: 'person' });
    expect(user.handshake.methods).not.toContain('host.stop');
    await expect(user.request('ping')).resolves.toEqual({});

    const { client: service } = await connectOverNetwork('backend-token');
    expect(service.handshake).toMatchObject({ role: 'service', subject: 'service:backend' });
    expect(service.handshake.expiresAt).toBeUndefined();
  });

  it('refuses a token the issuer did not sign and hangs up so the client fetches a new one', async () => {
    await expect(connectOverNetwork('forged')).rejects.toMatchObject({ kodaxCode: 'unauthorized', reason: 'invalid_credential' });
  });

  it('refuses the local credential over the network', async () => {
    issued.set('owner-token', { role: 'user', subject: 'user-42' });
    await expect(connectOverNetwork('owner-token', 'ipc'))
      .rejects.toMatchObject({ kodaxCode: 'unauthorized', reason: 'unsupported_auth_scheme' });
  });

  it('tells the client when its credential ends, and hangs up then', async () => {
    const expiresAt = Date.now() + 150;
    issued.set('owner-token', { role: 'user', subject: 'user-42', expiresAt });
    const { client, reasons } = await connectOverNetwork('owner-token');
    expect(client.handshake.expiresAt).toBe(expiresAt);
    await vi.waitFor(() => expect(reasons).toEqual(['credential']), { timeout: 2_000 });
  });

  it('keeps a connection that renewed its credential past the first expiry', async () => {
    issued.set('owner-token', { role: 'user', subject: 'user-42', expiresAt: Date.now() + 150 });
    const later = Date.now() + 60_000;
    issued.set('owner-token-2', { role: 'user', subject: 'user-42', expiresAt: later });
    const { client, reasons } = await connectOverNetwork('owner-token');

    await expect(client.request('auth.renew', { token: 'owner-token-2' })).resolves.toEqual({ expiresAt: later });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(reasons).toEqual([]);
    await expect(client.request('ping')).resolves.toEqual({});
  });

  it('keeps the connection when a renewal token is not good, since the current one still is', async () => {
    issued.set('owner-token', { role: 'user', subject: 'user-42', expiresAt: Date.now() + 60_000 });
    const { client, reasons } = await connectOverNetwork('owner-token');
    await expect(client.request('auth.renew', { token: 'forged' })).rejects.toMatchObject({ kodaxCode: 'unauthorized' });
    await expect(client.request('ping')).resolves.toEqual({});
    expect(reasons).toEqual([]);
  });

  it('refuses a renewal that would change who the connection speaks for, and hangs up', async () => {
    issued.set('owner-token', { role: 'user', subject: 'user-42', expiresAt: Date.now() + 60_000 });
    issued.set('backend-token', { role: 'service', subject: 'backend', expiresAt: Date.now() + 60_000 });
    const { client, reasons } = await connectOverNetwork('owner-token');
    await expect(client.request('auth.renew', { token: 'backend-token' }))
      .rejects.toMatchObject({ kodaxCode: 'unauthorized', reason: 'subject_changed' });
    await vi.waitFor(() => expect(reasons).toEqual(['credential']));
  });

  it('refuses a renewal on the local endpoint, whose credential does not expire', async () => {
    const owner = await connect('owner');
    await expect(owner.request('auth.renew', { token: 'secret' }))
      .rejects.toMatchObject({ kodaxCode: 'invalid_state', reason: 'credential_does_not_expire' });
  });
});

// Runs after every test above, which send through `connect`. Each test checks what its resend answers.
describe('commands the SDK sends again', () => {
  it('has a test send each of them again unchanged', () => {
    const specs: Array<[string, HostMethodSpec]> = Object.entries(HOST_METHODS);
    const auto = specs.filter(([, spec]) => spec.resend === 'auto').map(([name]) => name);
    expect(auto.filter(name => !answeredAgain.has(name))).toEqual([]);
  });
});
