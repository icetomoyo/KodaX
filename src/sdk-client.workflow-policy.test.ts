import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  KodaXProviderError, KodaXContextOverflowError, type KodaXProviderConfig,
} from '@kodax-ai/llm';
import { LEARNING_REVIEW_TOOL } from '@kodax-ai/coding';
import { connectKodaXClient, type KodaXClientWorkflowHostPolicy } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

let homeDir: string;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let client: Awaited<ReturnType<typeof connectKodaXClient>>;
let endpoint: string;
let policy: KodaXClientWorkflowHostPolicy | undefined;
let childRequests: number;
let activeChildren: number;
let peakChildren: number;
let outputTokens: number;
let failAfterToolRound: boolean;
let releaseHold: () => void;
let holdEntered: Promise<void>;

const manifest = { name: 'product-policy-fixture', description: 'Inspect fixture evidence.', readOnly: true,
  maxAgents: 8, maxConcurrency: 8, tokenBudget: 1000, phases: ['inspect'], patterns: ['fan-out-and-synthesize'] };
const sequentialSource = `async function run(wf) {
  const first = await wf.runAgent({ name: "one", prompt: "CHILD-WORKFLOW-PROBE one", readOnly: true });
  const second = await wf.runAgent({ name: "two", prompt: "CHILD-WORKFLOW-PROBE two", readOnly: true });
  return { synthesis: first.finalText + second.finalText };
}`;
const parallelSource = `async function run(wf) {
  const results = await wf.parallel(wf.args.names.map(name =>
    async () => await wf.runAgent({ name, prompt: "CHILD-WORKFLOW-PROBE " + name, readOnly: true })
  ));
  return { synthesis: results.filter(Boolean).map(result => result.finalText).join("\\n") };
}`;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-workflow-policy-'));
  policy = undefined; childRequests = 0; activeChildren = 0; peakChildren = 0;
  outputTokens = 2;
  failAfterToolRound = false;
  const hold = new Promise<void>(resolve => { releaseHold = resolve; });
  let entered: () => void;
  holdEntered = new Promise<void>(resolve => { entered = resolve; });
  class Provider extends KodaXBaseProvider {
    readonly name = 'workflow-policy-fixture';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_WORKFLOW_POLICY_FIXTURE', model: 'fixture', supportsThinking: false,
    };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>) {
      if (args[1].some(tool => tool.name === LEARNING_REVIEW_TOOL.name)) return {
        textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use' as const,
        toolBlocks: [{ type: 'tool_use' as const, id: 'memory-review', name: LEARNING_REVIEW_TOOL.name,
          input: { memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard' } } }],
      };
      const probe = JSON.stringify(args[0]);
      const reversedIndex = [...args[0]].reverse().findIndex(message => message.role === 'user'
        && (typeof message.content === 'string' || !message.content.some(block => block.type === 'tool_result')));
      const index = reversedIndex === -1 ? -1 : args[0].length - 1 - reversedIndex;
      const latest = args[0][index];
      const results = args[0].slice(index + 1).flatMap(message => Array.isArray(message.content)
        ? message.content.filter(block => block.type === 'tool_result') : []);
      if (JSON.stringify(latest).includes('HOST-HOLD-PROBE')) { entered(); await hold; }
      if (JSON.stringify(latest).includes('ROOT-WORKFLOW-PROBE') || latest?.inputId?.startsWith('workflow-')) {
        const name = results.length === 0 ? 'tool_search' : 'run_workflow';
        if (results.length < 2 && args[1].some(tool => tool.name === name)) return {
          textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use' as const,
          toolBlocks: [{ type: 'tool_use' as const, id: `workflow-tool-${results.length}`, name,
            input: name === 'tool_search' ? { query: 'run_workflow' } : { manifest, source: sequentialSource } }],
        };
      } else if (probe.includes('CHILD-WORKFLOW-PROBE') && args[1].some(tool => tool.name === 'read')) {
        // Tool-free digest calls may overlap after a child settles; they are not active Workflow agents.
        childRequests += 1; activeChildren += 1; peakChildren = Math.max(peakChildren, activeChildren);
        if (failAfterToolRound) {
          activeChildren -= 1;
          if (results.length === 0) return {
            textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use' as const,
            toolBlocks: [{ type: 'tool_use' as const, id: 'charged-read', name: 'read',
              input: { path: 'fixture.txt' } }],
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          };
          throw new KodaXProviderError('Unavailable after a charged tool round', this.name, { httpStatus: 503 });
        }
        try { await new Promise(resolve => setTimeout(resolve, 30)); }
        finally { activeChildren -= 1; }
      }
      return { textBlocks: [{ type: 'text' as const, text: 'Fixture evidence checked.' }], thinkingBlocks: [], toolBlocks: [],
        stopReason: 'end_turn' as const, usage: { inputTokens: 10, outputTokens, totalTokens: 10 + outputTokens } };
    }
  }
  vi.stubEnv('KODAX_WORKFLOW_POLICY_FIXTURE', 'fixture');
  vi.stubEnv('KODAX_WORKFLOW_MAX_CONCURRENCY', undefined);
  registerModelProvider('workflow-policy-fixture', () => new Provider());
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'workflow-policy-fixture' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated Workflow Host.');
  endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\kodax-workflow-policy-${randomUUID()}` : path.join(homeDir, 'host.sock');
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint: {
    kind: process.platform === 'win32' ? 'pipe' : 'unix', path: endpoint,
  } });
  client = await connectKodaXClient({ homeDir, endpoint,
    async authorizeExecution() { return policy === undefined ? undefined : { workflowHostPolicy: policy }; },
  });
});

afterEach(async () => {
  releaseHold?.();
  await client?.disconnect(); await host?.close(); await runtime?.close();
  clearRuntimeModelProviders(); vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('makes explicitly requested Workflow available on the Product AMA path with a Host-owned run directory', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { agentMode: 'ama', permissionMode: 'full-access' });
  const input = { sessionId: session.id, inputId: 'workflow-intent', text: 'ROOT-WORKFLOW-PROBE: run a Workflow to inspect evidence.' };
  const accepted = await client.inputs.submit(input);
  const outcome = await client.runs.await(accepted.runId!);
  expect(outcome.phase, JSON.stringify(outcome)).toBe('completed');
  expect((await client.statistics.readTools(session.id)).items).toContainEqual(expect.objectContaining({ name: 'run_workflow', state: 'completed' }));
  const runs = await client.workflows.list();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ status: 'completed', totalSpawned: 2 });
  expect(runs[0]!.runDir.startsWith(path.join(homeDir, '.kodax', 'workflow-runs') + path.sep)).toBe(true);
  const history = await client.sessions.readHistory(session.id);
  expect(history.items.filter(item => item.type === 'user').map(item => item.text)).toEqual([input.text]);
});

it('enforces the trusted Main maxAgents ceiling on a declarative Product Workflow', async () => {
  policy = { maxAgents: 1 };
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
  const start = await client.workflows.start({ sessionId: session.id, projectRoot: homeDir,
    source: { kind: 'inline', manifest, source: sequentialSource } });
  if (start.kind !== 'started') throw new Error(start.reason);
  const result = await client.runs.await(start.runId);
  expect(result.phase, JSON.stringify(result)).toBe('failed');
  expect((await client.workflows.list({ runId: start.runId }))[0]).toMatchObject({
    status: 'failed', totalSpawned: 1, error: expect.stringContaining('maxAgents lifetime cap (1)'),
  });
  expect(childRequests).toBeGreaterThan(0);
});

it('reserves maxAgents capacity before parallel child admissions can race', async () => {
  policy = { maxAgents: 1 };
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
  const start = await client.workflows.start({ sessionId: session.id, projectRoot: homeDir, args: { names: ['one', 'two'] },
    source: { kind: 'inline', manifest, source: parallelSource } });
  if (start.kind !== 'started') throw new Error(start.reason);
  await client.runs.await(start.runId);
  expect((await client.workflows.list({ runId: start.runId }))[0]?.totalSpawned).toBe(1);
  expect(childRequests).toBe(1);
});

it('stops new Workflow work when the trusted output-token budget is exhausted', async () => {
  policy = { tokenBudget: 1 };
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
  const start = await client.workflows.start({ sessionId: session.id, projectRoot: homeDir,
    source: { kind: 'inline', manifest, source: sequentialSource } });
  if (start.kind !== 'started') throw new Error(start.reason);
  const result = await client.runs.await(start.runId);
  expect(result.phase, JSON.stringify(result)).toBe('failed');
  expect((await client.workflows.list({ runId: start.runId }))[0]).toMatchObject({
    status: 'failed', totalSpawned: 1, error: expect.stringContaining('tokenBudget cap (1)'),
  });
});

it.each(['known', 'unknown', 'throw', 'charged-throw', 'truncated-throw'] as const)('charges failed Provider rounds with fallback result=%s', async (mode) => {
  failAfterToolRound = true;
  const budget = mode === 'charged-throw' || mode === 'truncated-throw' ? 40 : 10;
  policy = { tokenBudget: budget };
  class FallbackProvider extends KodaXBaseProvider {
    readonly name = 'workflow-fallback-fixture';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_WORKFLOW_POLICY_FIXTURE', model: 'fixture', supportsThinking: false,
    };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>) {
      if (mode === 'truncated-throw' && args[1].some(tool => tool.name === 'read')
        && !JSON.stringify(args[0]).includes('Fallback truncated evidence')) return {
        textBlocks: [{ type: 'text' as const, text: 'Fallback truncated evidence' }],
        thinkingBlocks: [], toolBlocks: [], stopReason: 'max_tokens' as const,
        usage: { inputTokens: 10, outputTokens: 50, totalTokens: 60 },
      };
      if (mode === 'charged-throw' && args[1].some(tool => tool.name === 'read')
        && !JSON.stringify(args[0]).includes('fallback-charged-read')) return {
        textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use' as const,
        toolBlocks: [{ type: 'tool_use' as const, id: 'fallback-charged-read', name: 'read',
          input: { path: 'fixture.txt' } }],
        usage: { inputTokens: 10, outputTokens: 50, totalTokens: 60 },
      };
      if (mode === 'throw' || mode === 'charged-throw' || mode === 'truncated-throw') throw new KodaXContextOverflowError({
        contextWindow: 128_000, inputTokensKind: 'unknown',
      }, this.name);
      return { textBlocks: [{ type: 'text' as const, text: 'Fallback evidence checked.' }],
        thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' as const,
        ...(mode === 'known' ? { usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } } : {}) };
    }
  }
  registerModelProvider('workflow-fallback-fixture', () => new FallbackProvider());
  vi.stubEnv('KODAX_FALLBACK_PROVIDERS', 'workflow-fallback-fixture');
  await writeFile(path.join(homeDir, 'fixture.txt'), 'evidence');
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
  const start = await client.workflows.start({ sessionId: session.id, projectRoot: homeDir,
    source: { kind: 'inline', manifest, source: sequentialSource } });
  if (start.kind !== 'started') throw new Error(start.reason);

  const result = await client.runs.await(start.runId);

  expect(result.phase).toBe('failed');
  expect((await client.workflows.list({ runId: start.runId }))[0]).toMatchObject({
    status: 'failed', totalSpawned: 1, error: expect.stringContaining(`tokenBudget cap (${budget})`),
  });
  const requests = (await client.statistics.readRequests(session.id)).items;
  expect(requests).toEqual(expect.arrayContaining([
    expect.objectContaining({ usage: expect.objectContaining({ outputTokens: 20 }) }),
  ]));
  if (mode === 'known') expect(requests).toEqual(expect.arrayContaining([
    expect.objectContaining({ usage: expect.objectContaining({ outputTokens: 1 }) }),
  ]));
  if (mode === 'charged-throw' || mode === 'truncated-throw') expect(requests).toEqual(expect.arrayContaining([
    expect.objectContaining({ usage: expect.objectContaining({ outputTokens: 50 }) }),
  ]));
});

it('preserves known zero output usage instead of spending input tokens against the output budget', async () => {
  policy = { tokenBudget: 1 }; outputTokens = 0;
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
  const start = await client.workflows.start({ sessionId: session.id, projectRoot: homeDir,
    source: { kind: 'inline', manifest, source: sequentialSource } });
  if (start.kind !== 'started') throw new Error(start.reason);
  const result = await client.runs.await(start.runId);
  expect(result.phase, JSON.stringify({ result, workflows: await client.workflows.list({ runId: start.runId }),
    requests: (await client.statistics.readRequests(session.id)).items.map(request => ({ target: request.target, usage: request.usage })) })).toBe('completed');
  expect((await client.workflows.list({ runId: start.runId }))[0]?.totalSpawned).toBe(2);
});

it('supports a policy-only Workflow start when the Host creates the temporary Session', async () => {
  policy = { maxAgents: 1 };
  const start = await client.workflows.start({ projectRoot: homeDir,
    source: { kind: 'inline', manifest, source: sequentialSource } });
  if (start.kind !== 'started') throw new Error(start.reason);
  await client.runs.await(start.runId);
  expect((await client.workflows.list({ runId: start.runId }))[0]).toMatchObject({ status: 'failed', totalSpawned: 1 });
});

it.each([{ maxAgents: 0 }, { tokenBudget: -1 }, { tokenBudget: 1.5 }, { maxConcurrency: 1 }, { promptOverlay: 'extra' }])
  ('rejects malformed or unsupported Main Workflow policy %j before dispatch', async invalid => {
    policy = invalid as unknown as KodaXClientWorkflowHostPolicy;
    const session = await client.sessions.create({ projectPath: homeDir });
    await expect(client.workflows.start({ sessionId: session.id, projectRoot: homeDir,
      source: { kind: 'inline', manifest, source: sequentialSource } })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(childRequests).toBe(0);
  });

it('uses the existing Host concurrency config for declarative Workflows', async () => {
  await client.config.patch({ workflow: { maxConcurrency: 1 } });
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { provider: 'workflow-policy-fixture', permissionMode: 'full-access' });
  const start = await client.workflows.start({ sessionId: session.id, projectRoot: homeDir, args: { names: ['one', 'two'] },
    source: { kind: 'inline', manifest, source: parallelSource } });
  if (start.kind !== 'started') throw new Error(start.reason);
  const result = await client.runs.await(start.runId);
  expect(result.phase, JSON.stringify(result)).toBe('completed');
  expect((await client.workflows.list({ runId: start.runId }))[0]).toMatchObject({ totalSpawned: 2 });
  expect(peakChildren).toBe(1);
});

it('captures queued policy, preserves input identity and prevents different policies from entering the active Run', async () => {
  policy = { maxAgents: 3 };
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { agentMode: 'ama', permissionMode: 'full-access' });
  const active = await client.inputs.submit({ sessionId: session.id, inputId: 'holding', text: 'HOST-HOLD-PROBE: inspect later.' });
  await holdEntered;
  const queuedPolicy = { maxAgents: 1 };
  policy = queuedPolicy;
  const input = { sessionId: session.id, inputId: 'workflow-queued', text: 'Run a Workflow next.', delivery: 'after_turn' as const };
  expect(await client.inputs.submit(input)).toMatchObject({ state: 'queued' });
  expect(await client.inputs.submit(input)).toMatchObject({ state: 'queued' });
  await expect(client.inputs.submit({ ...input, inputId: 'steer-policy', delivery: 'steer', targetRunId: active.runId }))
    .rejects.toMatchObject({ code: 'conflict' });
  queuedPolicy.maxAgents = 3;
  await expect(client.inputs.submit(input)).rejects.toMatchObject({ code: 'conflict' });
  releaseHold();
  expect((await client.runs.await(active.runId!)).phase).toBe('completed');
  await expect.poll(async () => (await client.inputs.read(session.id, input.inputId))?.runId).toBeTruthy();
  const queued = (await client.inputs.read(session.id, input.inputId))!;
  expect(queued.runId).not.toBe(active.runId);
  await client.runs.await(queued.runId!);
  const own = (await client.workflows.list()).filter(run => run.runDir.startsWith(path.join(homeDir, '.kodax') + path.sep));
  expect(own).toMatchObject([{ status: 'failed', totalSpawned: 1, error: expect.stringContaining('maxAgents lifetime cap (1)') }]);
  const history = await client.sessions.readHistory(session.id);
  expect(history.items.filter(item => item.type === 'user').map(item => [item.inputId, item.text]))
    .toEqual([['holding', 'HOST-HOLD-PROBE: inspect later.'], [input.inputId, input.text]]);
});

it('ignores Renderer policy forgery and keeps a Main policy local to its execution', async () => {
  policy = { maxAgents: 1 };
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
  const input = { sessionId: session.id, projectRoot: homeDir,
    source: { kind: 'inline' as const, manifest, source: sequentialSource } };
  const start = await client.workflows.start({ ...input,
    ...{ authorization: { workflowHostPolicy: { maxAgents: 8 } }, workflowHostPolicy: { maxAgents: 8 } },
  });
  if (start.kind !== 'started') throw new Error(start.reason);
  await client.runs.await(start.runId);
  expect((await client.workflows.list({ runId: start.runId }))[0]).toMatchObject({ status: 'failed', totalSpawned: 1 });
  const peer = await connectKodaXClient({ homeDir, endpoint });
  try {
    const independent = await peer.workflows.start(input);
    if (independent.kind !== 'started') throw new Error(independent.reason);
    expect((await peer.runs.await(independent.runId)).phase).toBe('completed');
    expect((await peer.workflows.list({ runId: independent.runId }))[0]).toMatchObject({ totalSpawned: 2 });
  } finally { await peer.disconnect(); }
});

it.each(['skill', 'command', 'review'] as const)('retains Workflow ceilings through %s preparation', async kind => {
  policy = { maxAgents: 1 };
  await mkdir(path.join(homeDir, '.kodax', 'skills', 'bounded-workflow'), { recursive: true });
  await mkdir(path.join(homeDir, '.kodax', 'commands'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'skills', 'bounded-workflow', 'SKILL.md'),
    '---\nname: bounded-workflow\ndescription: Inspect with a Workflow\n---\nUse a Workflow to inspect fixture evidence.');
  await writeFile(path.join(homeDir, '.kodax', 'commands', 'bounded-workflow.md'),
    '---\ndescription: Inspect with a Workflow\n---\nUse a Workflow to inspect fixture evidence.');
  if (kind === 'review') {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: homeDir, windowsHide: true, stdio: 'ignore' });
    git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(path.join(homeDir, 'fixture.ts'), 'export const value = false;\n');
    git('add', 'fixture.ts'); git('commit', '-m', 'fixture');
    await writeFile(path.join(homeDir, 'fixture.ts'), 'export const value = true;\n');
  }
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { agentMode: 'ama', permissionMode: 'full-access' });
  const inputId = `workflow-${kind}`;
  const started = kind === 'skill' ? await client.inputs.submit({ sessionId: session.id, inputId, text: '/skill:bounded-workflow inspect' })
    : kind === 'command' ? await client.commands.execute({ sessionId: session.id, inputId, name: 'bounded-workflow' })
    : await client.review.start({ sessionId: session.id, inputId, args: ['--lean', 'Workflow'] });
  if (!('runId' in started) || !started.runId) throw new Error(JSON.stringify(started));
  await client.runs.await(started.runId);
  const own = (await client.workflows.list()).filter(run => run.runDir.startsWith(path.join(homeDir, '.kodax') + path.sep));
  expect(own).toMatchObject([{ status: 'failed', totalSpawned: 1, error: expect.stringContaining('maxAgents lifetime cap (1)') }]);
  expect((await client.sessions.readHistory(session.id)).items.filter(item => item.type === 'user'))
    .toMatchObject([{ inputId }]);
});
