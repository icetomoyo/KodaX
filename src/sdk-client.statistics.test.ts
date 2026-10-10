import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearRuntimeModelProviders, registerModelProvider, KodaXBaseProvider,
  type KodaXProviderConfig, type KodaXMessage, type KodaXStreamResult, type KodaXProviderStreamOptions } from '@kodax-ai/llm';
import { registerTool } from '@kodax-ai/coding';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

let homeDir: string;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let client: Awaited<ReturnType<typeof connectKodaXClient>>;
let unregister: () => void;
let executions: string[];
let finishOperation: () => void;
let operationEntered: Promise<void>;
let enterOperation: () => void;
beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-statistics-regression-'));
  executions = [];
  operationEntered = new Promise<void>(resolve => { enterOperation = resolve; });
  const operation = new Promise<void>(resolve => { finishOperation = resolve; });
  vi.stubEnv('KODAX_STATS_FIXTURE', 'fixture');
  class Provider extends KodaXBaseProvider {
    readonly name = 'statistics-http'; readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_STATS_FIXTURE', model: 'fixture', supportsThinking: false };
    async stream(messages: KodaXMessage[], _tools?: unknown, _system?: unknown, _reasoning?: unknown, options?: KodaXProviderStreamOptions): Promise<KodaXStreamResult> {
      const probe = JSON.stringify(messages);
      if (probe.includes('HOLD-OPERATION-ONLY')) { enterOperation(); await operation; }
      const results = messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : []);
      if (probe.includes('ROOT-SPAWN-PROBE') && !probe.includes('CHILD-FACT-PROBE') && results.length === 0) {
        return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{ type: 'tool_use', id: 'spawn', name: 'spawn_agent',
          input: { task_name: 'audit-child', objective: 'CHILD-FACT-PROBE' } }] };
      }
      const toolCall = !messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'))
        && (probe.includes('CHILD-FACT-PROBE') || probe.includes('DUPLICATE-FACT-PROBE') || probe.includes('BRIDGE-FACT-PROBE'));
      return { textBlocks: toolCall ? [] : [{ type: 'text', text: 'Evidence complete.' }], thinkingBlocks: [],
        toolBlocks: toolCall ? probe.includes('BRIDGE-FACT-PROBE') ? [{ type: 'tool_use', id: 'bridge', name: 'tool_call', input: { name: 'statistics_fixture', input: { label: 'bridge' } } }]
          : (probe.includes('DUPLICATE-FACT-PROBE') ? ['one', 'two'] : ['child']).map(label => ({
            type: 'tool_use', id: 'reused-provider-id', name: 'statistics_fixture', input: { label, artifact: probe.includes('ARTIFACT-FACT-PROBE') } })) : [],
        stopReason: toolCall ? 'tool_use' : 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
    }
  }
  registerModelProvider('statistics-http', () => new Provider());
  unregister = registerTool({ name: 'statistics_fixture', description: 'Read offline fixture evidence.', sideEffect: 'readonly',
    toClassifierInput: input => JSON.stringify(input),
    input_schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
    handler: async (input, ctx) => { executions.push(String(input.label));
      if (input.artifact === true) {
        const outputPath = path.join(homeDir, `${String(input.label)}-output.txt`);
        await writeFile(outputPath, String(input.label));
        ctx.recordToolResultArtifact?.(ctx.toolCallId!, outputPath);
      }
      if (input.label === 'two') ctx.reportToolSandboxObservation?.({ version: 1, state: 'fallback', reason: 'not_ready', execution: 'normal_permission_policy' });
      else ctx.reportToolSandboxObservation?.({ version: 1, state: 'not_selected' });
      return String(input.label); } });
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'statistics-http' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Missing statistics fixture Host lock.');
  const endpoint = { kind: process.platform === 'win32' ? 'pipe' as const : 'unix' as const,
    path: process.platform === 'win32' ? `\\\\.\\pipe\\kodax-statistics-${randomUUID()}` : path.join(homeDir, 'host.sock') };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
});
afterEach(async () => {
  finishOperation?.();
  await client?.disconnect(); await host?.close(); await runtime?.close(); unregister?.();
  clearRuntimeModelProviders(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('attributes an ordinary ambient child request, tool and budget to its actual Actor turn', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { provider: 'statistics-http', agentMode: 'ama', permissionMode: 'full-access' });
  const root = await client.inputs.submit({ sessionId: session.id, inputId: 'root', text: 'ROOT-SPAWN-PROBE' });
  const outcome = await client.runs.await(root.runId!);
  expect(outcome.phase, JSON.stringify(outcome)).toBe('completed');
  const tree = await client.agents.tree(session.id);
  const actor = tree.actors.find(row => row.path.includes('audit-child'))!;
  expect(actor, JSON.stringify(tree)).toBeDefined();
  const target = { kind: 'actor_turn', actorPath: actor.path, turnId: actor.turnIds.at(-1), parentRunId: root.runId };
  const requests = (await client.statistics.readRequests(session.id)).items.filter(row => row.purpose === 'primary' && row.attribution?.kind === 'actor_turn');
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(requests.every(row => JSON.stringify(row.target) === JSON.stringify(target))).toBe(true);
  const tools = (await client.statistics.readTools(session.id)).items.filter(row => row.name === 'statistics_fixture');
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ target, state: 'completed', result: 'succeeded' });
  const child = (await client.statistics.read(session.id)).contexts.find(row => row.contextKind === 'child' && row.agentId === actor.path);
  expect(child).toMatchObject({ turnId: target.turnId, target });
});

it('retains actual Sandbox observations reported by an ordinary child tool', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { provider: 'statistics-http', agentMode: 'ama', permissionMode: 'full-access' });
  const root = await client.inputs.submit({ sessionId: session.id, inputId: 'sandbox-child', text: 'ROOT-SPAWN-PROBE' });
  expect((await client.runs.await(root.runId!)).phase).toBe('completed');
  expect(executions).toContain('child');
  const tool = (await client.statistics.readTools(session.id)).items.find(row => row.name === 'statistics_fixture');
  expect(tool!.sandbox).toEqual([{ version: 1, state: 'not_selected' }]);
});

it('keeps parallel calls sharing a Provider toolId complete with their own Sandbox observations', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { provider: 'statistics-http', agentMode: 'sa', permissionMode: 'full-access' });
  const root = await client.inputs.submit({ sessionId: session.id, inputId: 'duplicates', text: 'DUPLICATE-FACT-PROBE' });
  expect((await client.runs.await(root.runId!)).phase).toBe('completed');
  expect(executions.sort()).toEqual(['one', 'two']);
  const tools = (await client.statistics.readTools(session.id)).items.filter(row => row.name === 'statistics_fixture');
  expect(tools).toHaveLength(2);
  expect(new Set(tools.map(row => row.id)).size).toBe(2);
  for (const row of tools) expect(row).toMatchObject({ toolId: 'reused-provider-id', state: 'completed', result: 'succeeded' });
  expect(tools.map(row => row.sandbox.map(observation => observation.state))).toEqual([['not_selected'], ['fallback']]);
});

it('reports partial physical coverage while an operation-only adapter is still executing', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { provider: 'statistics-http', agentMode: 'sa', permissionMode: 'full-access' });
  const root = await client.inputs.submit({ sessionId: session.id, inputId: 'operation-only', text: 'HOLD-OPERATION-ONLY' });
  let readinessTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operationEntered,
      client.runs.await(root.runId!).then(outcome => { throw new Error(`Fixture Run ended before Provider entry: ${outcome.phase}`); }),
      new Promise<never>((_, reject) => {
        readinessTimer = setTimeout(() => reject(new Error('Fixture Provider did not enter.')), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(readinessTimer);
  }
  expect(await client.statistics.read(session.id)).toMatchObject({ coverage: 'partial', operationCount: 1, physicalRequestCount: 0 });
  expect((await client.statistics.read(session.id)).issues.length).toBeGreaterThan(0);
  finishOperation(); expect((await client.runs.await(root.runId!)).phase).toBe('completed');
});

it('keeps a bridge target and its Sandbox sequence in one completed execution fact', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { provider: 'statistics-http', agentMode: 'sa', permissionMode: 'full-access' });
  const root = await client.inputs.submit({ sessionId: session.id, inputId: 'bridge', text: 'BRIDGE-FACT-PROBE' });
  expect((await client.runs.await(root.runId!)).phase).toBe('completed');
  expect(executions).toEqual(['bridge']);
  const facts = (await client.statistics.readTools(session.id)).items;
  const targets = facts.filter(row => row.name === 'statistics_fixture');
  expect(targets).toHaveLength(1);
  expect(targets[0]).toMatchObject({ state: 'completed', sandbox: [{ version: 1, state: 'not_selected' }] });
  expect(facts.some(row => row.state === 'prepared' || row.state === 'executing')).toBe(false);
});

it('retains the separate recovery artifact of each call sharing a Provider toolId', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { provider: 'statistics-http', agentMode: 'sa', permissionMode: 'full-access' });
  const root = await client.inputs.submit({ sessionId: session.id, inputId: 'artifacts', text: 'DUPLICATE-FACT-PROBE ARTIFACT-FACT-PROBE' });
  const result = await runtime.runs.await(root.runId!);
  expect(result.phase).toBe('completed');
  const tools = result.result!.messages.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(block => block.type === 'tool_result') : []);
  expect(tools.map(block => block.metadata?.outputPath)).toEqual([path.join(homeDir, 'one-output.txt'), path.join(homeDir, 'two-output.txt')]);
});
