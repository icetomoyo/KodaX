import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
  type KodaXToolDefinition, type KodaXReasoningRequest, type KodaXProviderStreamOptions,
} from '@kodax-ai/llm';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import {
  createLearningCenterService, LearnedAreaStore, commitLearnedSkillRevision,
  createLearnedCapabilityScope, resolveProjectLearnedAreaRoot,
} from '@kodax-ai/agent';
import { getActiveExtensionRuntime } from '@kodax-ai/coding';
import { createKodaXRuntime } from './sdk-runtime.js';
import { createReplRuntimeAutoModeControl } from './kodax_cli.js';
import { createRuntimeDaemonDispatcher } from './runtime-daemon/server.js';
import { createRuntimeDaemonRequest } from './runtime-daemon/protocol.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

let requests: KodaXMessage[][] = [];
let requestOptions: { system: string; model?: string; sidecar: boolean }[] = [];
let onProviderRequest: ((messages: KodaXMessage[]) => Promise<void>) | undefined;
class DomainProvider extends KodaXBaseProvider {
  readonly name = 'product-domains-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_DOMAINS_TEST_KEY', model: 'product-domains-test', supportsThinking: false,
  };
  async stream(messages: KodaXMessage[], _tools: KodaXToolDefinition[], system: string, _reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions): Promise<KodaXStreamResult> {
    requests.push(structuredClone(messages));
    const sidecar = _tools.some(tool => tool.name === 'emit_sidecar_verdict');
    requestOptions.push({ system, model: options?.modelOverride, sidecar });
    if (sidecar) return { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: 'sidecar-accept', name: 'emit_sidecar_verdict', input: { verdict: 'accept' } }], stopReason: 'tool_use' };
    await onProviderRequest?.(messages);
    return { textBlocks: [{ type: 'text', text: 'The user is preparing a release. Preserve the release gate decisions and the supplied evidence. Run the agreed checks before shipping and retain any unresolved verification requirements.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  }
}

let homeDir: string;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let first: Awaited<ReturnType<typeof connectKodaXClient>>;
let second: Awaited<ReturnType<typeof connectKodaXClient>>;
let endpointPath: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-domains-'));
  requests = [];
  requestOptions = [];
  onProviderRequest = undefined;
  registerModelProvider('product-domains-test', () => new DomainProvider());
  vi.stubEnv('KODAX_PRODUCT_DOMAINS_TEST_KEY', 'test-only');
  vi.stubEnv('KODAX_HOME', path.join(homeDir, '.kodax'));
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-domains-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated domains Host.');
  endpointPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\kodax-domains-${randomUUID()}`
    : path.join(homeDir, 'host.sock');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: endpointPath }
    : { kind: 'unix' as const, path: endpointPath };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  first = await connectKodaXClient({ homeDir, endpoint: endpointPath, clientInfo: { name: 'domain-test', instanceId: 'first' } });
  second = await connectKodaXClient({ homeDir, endpoint: endpointPath, clientInfo: { name: 'domain-test', instanceId: 'second' } });
});

afterEach(async () => {
  await Promise.all([first?.disconnect(), second?.disconnect()]);
  await host?.close();
  await runtime?.close();
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 30_000);

it('reads the same active Auto diagnostics through Product and the CLI control', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  const control = createReplRuntimeAutoModeControl(second);
  expect(await control.getStats(session.id)).toBeUndefined();
  expect(await control.syncSettings?.(session.id, 'auto', {})).toMatchObject({ classifierHealth: 'healthy' });
  expect(await first.sessions.getSettings(session.id)).toMatchObject({ permissionMode: 'auto' });
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let markEntered = () => {};
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  onProviderRequest = () => { markEntered(); return held; };
  try {
    const accepted = await first.inputs.submit({ sessionId: session.id, inputId: 'auto-diagnostic', text: 'Wait for diagnostic inspection.' });
    await entered;
    expect(requests.length).toBeGreaterThan(0);
    expect(await first.sessions.getAutoModeStats(session.id)).toMatchObject({
      classifierHealth: 'healthy', denials: { consecutive: 0, cumulative: 0 }, breaker: { timestamps: [] },
    });
    expect(await control.getStats(session.id)).toEqual(await first.sessions.getAutoModeStats(session.id));
    release?.();
    await first.runs.await(accepted.runId!);
    expect(await control.syncSettings?.(session.id, 'plan', {})).toBeUndefined();
  } finally { release?.(); }
});

it('compacts through the product client with custom instructions and shared committed lineage', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { provider: 'product-domains-test', agentMode: 'sa', permissionMode: 'full-access' });
  expect(await first.sessions.compact(session.id)).toMatchObject({ compacted: false, reason: 'no compaction needed' });
  for (let index = 0; index < 3; index += 1) {
    const accepted = await first.inputs.submit({ sessionId: session.id, inputId: `warmup-${index}`, text: `Release decision ${index}. ` + 'Evidence for the release. '.repeat(600) });
    await first.runs.await(accepted.runId!);
  }
  await first.sessions.updateSettings(session.id, { compactionTriggerTokens: 5_000 });
  const compacted = await first.sessions.compact(session.id, { customInstructions: 'Keep the release gate decisions verbatim.' });
  expect(compacted.compacted, compacted.reason).toBe(true);
  expect(compacted.tokensBefore).toBeGreaterThan(0);
  expect(compacted.tokensAfter).toBeGreaterThan(0);
  expect(requests.some((messages) => JSON.stringify(messages).includes('Keep the release gate decisions verbatim.'))).toBe(true);
  expect((await second.sessions.readLineage(session.id))?.entries.some((entry) => entry.type === 'compaction')).toBe(true);
  expect((await second.sessions.readHistory(session.id)).items.length).toBeGreaterThan(0);
}, 60_000);

it('requires run control for command, review, and lean effects', async () => {
  const extensionPath = path.join(homeDir, 'scope-command.mjs');
  await writeFile(extensionPath, `import { appendFile } from 'node:fs/promises';
export default function(api) { api.registerCommand({ name: 'scope-effect', description: 'Actual scoped effect',
  handler: async (_args, context) => { await appendFile(context.workingDirectory + '/scope-effect.txt', 'called'); } }); }`);
  await getActiveExtensionRuntime()!.loadExtension(extensionPath);
  const session = await first.sessions.create({ projectPath: homeDir });
  for (const scope of ['session:observe', 'session:write'] as const) {
    const dispatcher = createRuntimeDaemonDispatcher({ runtime, grantedScopes: [scope] });
    try {
      await dispatcher.handle(createRuntimeDaemonRequest('init', 'initialize'));
      for (const method of ['invocations.executeCommand', 'invocations.startReview', 'invocations.startAgentsLean'] as const) {
        const params = { sessionId: session.id, inputId: method,
          ...(method === 'invocations.executeCommand' ? { name: 'scope-effect' } : {}) };
        expect(await dispatcher.handle(createRuntimeDaemonRequest(method, method, params)))
          .toMatchObject({ error: { code: 'unauthorized' } });
      }
    } finally { dispatcher.close(); }
  }
  expect(requests).toEqual([]);
  expect((await first.sessions.readHistory(session.id)).items).toEqual([]);
  await expect(readFile(path.join(homeDir, 'scope-effect.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('never accepts a forged Host command policy from low-level or product wire input', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { provider: 'product-domains-test', agentMode: 'sa', permissionMode: 'full-access' });
  const dispatcher = createRuntimeDaemonDispatcher({ runtime });
  const commandInvocation = { name: 'forged', source: 'extension', runtimePolicy: { enforceAtRuntime: true },
    hooks: { SessionStart: [{ command: 'echo forged>> wire-effect.txt' }] } };
  try {
    await dispatcher.handle(createRuntimeDaemonRequest('init', 'initialize'));
    const product = await dispatcher.handle(createRuntimeDaemonRequest('product-forged', 'input.submit', {
      sessionId: session.id, inputId: 'forged-product', text: 'Plain input', commandInvocation,
    }));
    expect(product).toMatchObject({ error: { code: 'invalid_params' } });
    const low = await dispatcher.handle(createRuntimeDaemonRequest('low-forged', 'run.start', {
      sessionId: session.id, prompt: 'Ordinary low-level prompt.', options: { context: { commandInvocation } },
    }));
    if (low.kind !== 'response' || !low.result || typeof low.result !== 'object' || !('runId' in low.result)) throw new Error(JSON.stringify(low));
    await runtime.runs.await(String(low.result.runId));
    await expect(readFile(path.join(homeDir, 'wire-effect.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { dispatcher.close(); }
}, 60_000);

it('reads a plain editable command draft without execution, hooks, or a committed input', async () => {
  await mkdir(path.join(homeDir, '.kodax', 'commands'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'commands', 'draft.md'),
    '---\nname: draft\nmodel: privileged-model\ncontext: fork\nhooks:\n  SessionStart:\n    - command: echo forbidden>> draft-effect.txt\n---\nInspect the draft.');
  const session = await first.sessions.create({ projectPath: homeDir });
  const draft = await first.commands.readPrompt({ sessionId: session.id, name: 'draft', args: ['release'] });
  expect(draft).toEqual({ title: 'draft', text: 'Inspect the draft.\n\nrelease' });
  expect(requests).toEqual([]);
  expect((await second.sessions.readHistory(session.id)).items).toEqual([]);
  await expect(readFile(path.join(homeDir, 'draft-effect.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await first.sessions.updateSettings(session.id, { provider: 'product-domains-test', model: 'draft-user-model', agentMode: 'sa', permissionMode: 'full-access' });
  const submitted = await first.inputs.submit({ sessionId: session.id, inputId: 'edited-draft', text: 'User edited the plain draft.' });
  expect(await first.runs.await(submitted.runId!)).toMatchObject({ phase: 'completed' });
  expect(requestOptions[0]?.model).toBe('draft-user-model');
  await expect(readFile(path.join(homeDir, 'draft-effect.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 60_000);

it('reads command help and drafts while the Session is busy without invoking handlers', async () => {
  await mkdir(path.join(homeDir, '.kodax', 'commands'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'commands', 'busy-draft.md'),
    '---\nname: busy-draft\ndescription: Inspect the busy draft\n---\nDraft remains editable.');
  const extensionPath = path.join(homeDir, 'busy-help.mjs');
  await writeFile(extensionPath, `export default api => api.registerCommand({
    name: 'busy-help', aliases: ['bh'], description: 'Help remains readable',
    handler: () => { throw new Error('Help must not execute its handler'); }
  });`);
  await getActiveExtensionRuntime()!.loadExtension(extensionPath);
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { provider: 'product-domains-test', agentMode: 'sa', permissionMode: 'full-access' });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  onProviderRequest = () => held;
  const accepted = await first.inputs.submit({ sessionId: session.id, inputId: 'busy-help-run', text: 'Keep this Run active.' });
  try {
    await vi.waitFor(async () => expect(await first.runs.read(accepted.runId!)).toMatchObject({ phase: 'running' }));
    await expect(second.commands.execute({ sessionId: session.id, inputId: 'help-only', name: 'bh', args: ['--help'] }))
      .resolves.toMatchObject({ kind: 'completed', success: true, message: expect.stringContaining('Help remains readable') });
    await expect(second.commands.execute({ sessionId: session.id, inputId: 'prompt-help', name: 'busy-draft', args: ['help'] }))
      .resolves.toMatchObject({ kind: 'completed', success: true, message: expect.stringContaining('Inspect the busy draft') });
    await expect(second.commands.readPrompt({ sessionId: session.id, name: 'busy-draft' }))
      .resolves.toEqual({ title: 'busy-draft', text: 'Draft remains editable.' });
    expect(await first.runs.read(accepted.runId!)).toMatchObject({ phase: 'running' });
    expect((await first.sessions.readHistory(session.id)).items.filter(item => item.type === 'user').map(item => item.text))
      .toEqual(['Keep this Run active.']);
  } finally { release(); await first.runs.await(accepted.runId!); }
}, 60_000);

it('admits managed extension commands with isolated scopes and stops only the selected Session', async () => {
  const extensionPath = path.join(homeDir, 'managed-scope.mjs');
  await writeFile(extensionPath, `import { writeFile } from 'node:fs/promises';
export default api => api.registerCommand({ name: 'scoped-wait', aliases: ['sw'], description: 'Wait in an admitted scope',
  handler: async (args, context) => {
    const scope = api.getExecutionScope();
    if (!scope || scope !== context.extensionExecution) throw new Error('Missing admitted command scope');
    api.runtime.setSessionState('label', args[0]);
    const content = await scope.invokeTool('read', { path: context.workingDirectory + '/scope-input.txt' });
    await writeFile(context.workingDirectory + '/' + args[0] + '-started.json', JSON.stringify({
      sessionId: scope.sessionId, runId: scope.runId, content }));
    await new Promise(resolve => scope.signal.aborted ? resolve() : scope.signal.addEventListener('abort', resolve, { once: true }));
    await writeFile(context.workingDirectory + '/' + args[0] + '-stopped.txt', api.runtime.getSessionState('label'));
    return { message: 'Stopped ' + args[0] };
  }
});`);
  await writeFile(path.join(homeDir, 'scope-input.txt'), 'Scoped nested read');
  await getActiveExtensionRuntime()!.loadExtension(extensionPath);
  const sessions = await Promise.all([first.sessions.create({ projectPath: homeDir }), second.sessions.create({ projectPath: homeDir })]);
  await Promise.all(sessions.map(session => first.sessions.updateSettings(session.id, { provider: 'product-domains-test', permissionMode: 'full-access', agentMode: 'sa' })));
  const started: { sessionId: string; runId: string }[] = [];
  try {
    for (const [index, session] of sessions.entries()) {
      const result = await first.commands.execute({ sessionId: session.id, inputId: `scope-${index}`, name: 'sw', args: [String(index)] });
      if (result.kind !== 'started') throw new Error(JSON.stringify(result));
      started.push({ sessionId: session.id, runId: result.runId });
    }
    for (const [index, run] of started.entries()) {
      await vi.waitFor(async () => expect(JSON.parse(await readFile(path.join(homeDir, `${index}-started.json`), 'utf8')))
        .toMatchObject({ ...run, content: expect.stringContaining('Scoped nested read') }), { timeout: 10_000 });
    }
    await first.sessions.cancel({ sessionId: started[0]!.sessionId, expectedRunId: started[0]!.runId, requestId: 'stop-scope-zero' });
    expect(await first.runs.await(started[0]!.runId)).toMatchObject({ phase: 'interrupted' });
    expect(await readFile(path.join(homeDir, '0-stopped.txt'), 'utf8')).toBe('0');
    expect(await second.runs.read(started[1]!.runId)).toMatchObject({ phase: 'running' });
    await expect(readFile(path.join(homeDir, '1-stopped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(requests).toEqual([]);
  } finally {
    await Promise.all(started.map(async run => { await first.runs.stop(run.runId); await first.runs.await(run.runId); }));
  }
  expect(await readFile(path.join(homeDir, '1-stopped.txt'), 'utf8')).toBe('1');
}, 60_000);

it('starts ordinary review and agents lean using Host-owned project contents', async () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: homeDir, windowsHide: true });
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(path.join(homeDir, 'release.ts'), 'export const gate = false;\n');
  git('add', 'release.ts'); git('commit', '-m', 'fixture');
  await writeFile(path.join(homeDir, 'release.ts'), 'export const gate = true;\n');
  await writeFile(path.join(homeDir, 'AGENTS.md'), 'Prefer small functions and preserve release evidence.');
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { provider: 'product-domains-test', agentMode: 'sa', permissionMode: 'full-access' });
  const review = await first.review.start({ sessionId: session.id, inputId: 'review', args: ['--lean', 'check', 'release'] });
  if (review.kind !== 'started') throw new Error(JSON.stringify(review));
  expect(await first.runs.await(review.runId)).toMatchObject({ phase: 'completed' });
  expect(requestOptions.some(request => request.system.includes('gate = true') && request.system.includes('check release'))).toBe(true);
  const lean = await second.agents.reviewLean({ sessionId: session.id, inputId: 'agents-lean' });
  if (lean.kind !== 'started') throw new Error(JSON.stringify(lean));
  expect(await second.runs.await(lean.runId)).toMatchObject({ phase: 'completed' });
  expect(requestOptions.some(request => request.system.includes('Prefer small functions and preserve release evidence.'))).toBe(true);
}, 60_000);

it('distinguishes a missing AGENTS file from a failed read without starting a Run', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  expect(await first.agents.reviewLean({ sessionId: session.id, inputId: 'missing-agents' }))
    .toMatchObject({ kind: 'completed', success: false, message: expect.stringContaining('does not exist') });
  await mkdir(path.join(homeDir, 'AGENTS.md'));
  await expect(first.agents.reviewLean({ sessionId: session.id, inputId: 'unreadable-agents' })).rejects.toThrow();
  expect(requests).toEqual([]);
  expect((await second.sessions.readHistory(session.id)).items).toEqual([]);
});

it('runs registered prompt hooks under Host policy and preserves fork history', async () => {
  const commandDir = path.join(homeDir, '.kodax', 'commands');
  await mkdir(commandDir, { recursive: true });
  await writeFile(path.join(commandDir, 'fork-review.md'), [
    '---', 'name: fork-review', 'context: fork', 'allowed-tools: Bash, Read', 'hooks:',
    '  SessionStart:', '    - command: echo started>> command-hooks.txt',
    '  SubagentStop:', `    - command: ${JSON.stringify(`node -e "require('fs').appendFileSync('command-hooks.txt','stopping ');setTimeout(()=>require('fs').appendFileSync('command-hooks.txt','stopped'),700)"`)}`,
    '---', 'Inspect the release independently.',
  ].join('\n'));
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { provider: 'product-domains-test', permissionMode: 'full-access', agentMode: 'sa' });
  const firstRun = await first.inputs.submit({ sessionId: session.id, inputId: 'parent-history', text: 'Parent secret context must not enter the fork.' });
  await first.runs.await(firstRun.runId!);
  requests = []; requestOptions = [];
  const result = await first.commands.execute({ sessionId: session.id, inputId: 'fork-command', name: 'fork-review', args: ['auth'] });
  if (result.kind !== 'started') throw new Error('Expected a fork Run.');
  let settled = false;
  const done = first.runs.await(result.runId).then(outcome => { settled = true; return outcome; });
  await vi.waitFor(async () => expect(await readFile(path.join(homeDir, 'command-hooks.txt'), 'utf8')).toContain('stopping'), { timeout: 15_000, interval: 10 });
  expect(settled).toBe(false);
  await expect(second.inputs.submit({ sessionId: session.id, inputId: 'during-stop-hook', text: 'Do not enter until hooks settle.' }))
    .rejects.toMatchObject({ code: 'conflict' });
  const outcome = await done;
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ phase: 'completed' });
  expect(await readFile(path.join(homeDir, 'command-hooks.txt'), 'utf8')).toMatch(/started[\s\S]*stopped/);
  const forkRequests = requests.filter((_messages, index) => requestOptions[index]?.system.includes('Inspect the release independently.'));
  expect(forkRequests.length).toBeGreaterThan(0);
  expect(forkRequests.some((messages) => JSON.stringify(messages).includes('Parent secret context')), JSON.stringify(forkRequests)).toBe(false);
  const history = await second.sessions.readHistory(session.id);
  expect(history.items.some((item) => item.text.includes('Parent secret context'))).toBe(true);
  expect(history.items.filter((item) => item.type === 'assistant'), JSON.stringify(history)).toHaveLength(2);
}, 60_000);

it('executes the Host registered prompt with original arguments and model selection', async () => {
  const commandDir = path.join(homeDir, '.kodax', 'commands');
  await mkdir(commandDir, { recursive: true });
  await writeFile(path.join(commandDir, 'release.md'), '---\nname: release\nmodel: release-model\n---\nCheck the actual release gate.');
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { provider: 'product-domains-test', model: 'session-model', permissionMode: 'full-access', agentMode: 'sa' });
  const started = await first.commands.execute({ sessionId: session.id, inputId: 'release-input', name: 'release', args: ['focus', 'on', 'auth'] });
  if (started.kind !== 'started') throw new Error('Expected a registered prompt Run.');
  expect(await first.runs.await(started.runId)).toMatchObject({ phase: 'completed' });
  expect(requestOptions.some((request) => request.system.includes('Check the actual release gate.') && request.model === 'release-model')).toBe(true);
  expect(requests.some((messages) => JSON.stringify(messages).includes('/release focus on auth'))).toBe(true);
  expect((await second.sessions.readHistory(session.id)).items.some((item) => item.type === 'user' && item.text === '/release focus on auth')).toBe(true);
}, 60_000);

it.each([
  { agentMode: 'sa' as const, disconnect: false },
  { agentMode: 'sa' as const, disconnect: true },
  { agentMode: 'ama' as const, disconnect: false },
  { agentMode: 'ama' as const, disconnect: true },
])('keeps handler admission atomic in $agentMode and never replays effects after caller disconnect=$disconnect', async ({ agentMode, disconnect }) => {
  const extensionPath = path.join(homeDir, 'atomic-command.mjs');
  await writeFile(extensionPath, `import { appendFile, access } from 'node:fs/promises';
export default function(api) {
  api.registerCommand({ name: 'atomic-release', description: 'Prepare an explicit release',
    handler: async (args, context) => {
      await appendFile(context.workingDirectory + '/entered.txt', args.join(' ') + '\\n');
      for (;;) { try { await access(context.workingDirectory + '/release-handler'); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 10)); } }
      return { invocation: { prompt: 'Review the atomic release.', displayName: 'atomic-release', source: 'extension' } };
    }
  });
}`);
  await getActiveExtensionRuntime()!.loadExtension(extensionPath);
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { provider: 'product-domains-test', agentMode, permissionMode: 'full-access' });
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
  onProviderRequest = async () => providerGate;
  try {
    const started = await first.commands.execute({ sessionId: session.id, inputId: 'atomic-command', name: 'atomic-release', args: ['first'] });
    if (started.kind !== 'started') throw new Error(JSON.stringify(started));
    await vi.waitFor(async () => expect(await readFile(path.join(homeDir, 'entered.txt'), 'utf8')).toBe('first\n'));
    if (disconnect) await first.disconnect();
    const competing = second.inputs.submit({ sessionId: session.id, inputId: 'competing-input', text: 'Competing turn.' });
    const rejected = expect(competing).rejects.toMatchObject({ code: 'conflict' });
    await writeFile(path.join(homeDir, 'release-handler'), 'continue');
    await rejected;
    if (disconnect) {
      const accepted = await second.inputs.read(session.id, 'atomic-command');
      expect(accepted?.runId).toBe(started.runId);
      releaseProvider();
      expect(await second.runs.await(accepted!.runId!)).toMatchObject({ phase: 'completed' });
      first = await connectKodaXClient({ homeDir, endpoint: endpointPath });
      const observation = await first.sessions.observe(session.id, () => undefined);
      observation.close();
      expect(await readFile(path.join(homeDir, 'entered.txt'), 'utf8')).toBe('first\n');
      expect(requestOptions.filter(request => !request.sidecar)).toHaveLength(1);
      expect(requestOptions.filter(request => request.sidecar)).toHaveLength(agentMode === 'ama' ? 1 : 0);
      expect((await second.sessions.readHistory(session.id)).items.filter(item => item.type === 'user').map(item => item.text)).toEqual(['/atomic-release first']);
      return;
    }
    await expect(second.commands.execute({ sessionId: session.id, inputId: 'busy-command', name: 'atomic-release', args: ['second'] }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(await readFile(path.join(homeDir, 'entered.txt'), 'utf8')).toBe('first\n');
    releaseProvider();
    expect(await first.runs.await(started.runId)).toMatchObject({ phase: 'completed' });
    expect(requestOptions.filter(request => !request.sidecar)).toHaveLength(1);
    expect(requestOptions.filter(request => request.sidecar)).toHaveLength(agentMode === 'ama' ? 1 : 0);
    expect((await second.sessions.readHistory(session.id)).items.filter(item => item.type === 'user').map(item => item.text)).toEqual(['/atomic-release first']);
  } finally {
    releaseProvider();
    await writeFile(path.join(homeDir, 'release-handler'), 'continue');
  }
}, 60_000);

it.each(['sa', 'ama'] as const)('pins command contributions across handler reload and %s continuation', async (agentMode) => {
  const extensionPath = path.join(homeDir, 'pinned-command.mjs');
  const source = (version: string) => `import { existsSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    export default api => api.registerCommand({ name: 'pinned-command', description: '${version}',
      handler: async (_args, context) => {
        writeFileSync(path.join(context.workingDirectory, 'handler-entered'), 'yes');
        while (!existsSync(path.join(context.workingDirectory, 'handler-release'))) await new Promise(resolve => setTimeout(resolve, 10));
        return { invocation: { prompt: 'Continue the admitted command.' } };
      } });`;
  const extensions = getActiveExtensionRuntime()!;
  await writeFile(extensionPath, source('old-contribution'));
  await extensions.loadExtension(extensionPath);
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { agentMode, permissionMode: 'full-access' });
  const observed: string[] = [];
  onProviderRequest = async (messages) => {
    if (messages.some(message => message.role === 'user' && message.content === '/pinned-command')) {
      observed.push(extensions.getCommand('pinned-command')!.description);
    }
  };
  const started = await first.commands.execute({ sessionId: session.id, inputId: 'pinned-command', name: 'pinned-command' });
  if (started.kind !== 'started') throw new Error(JSON.stringify(started));
  try {
    await vi.waitFor(async () => expect(await readFile(path.join(homeDir, 'handler-entered'), 'utf8')).toBe('yes'));
    await writeFile(extensionPath, source('new-contribution'));
    await extensions.loadExtension(extensionPath);
    await writeFile(path.join(homeDir, 'handler-release'), 'continue');
    expect(await first.runs.await(started.runId)).toMatchObject({ phase: 'completed' });
    expect(observed).toEqual(['old-contribution']);
    const next = await first.commands.execute({ sessionId: session.id, inputId: 'next-command', name: 'pinned-command' });
    if (next.kind !== 'started') throw new Error(JSON.stringify(next));
    expect(await first.runs.await(next.runId)).toMatchObject({ phase: 'completed' });
    expect(observed).toEqual(['old-contribution', 'new-contribution']);
  } finally {
    await writeFile(path.join(homeDir, 'handler-release'), 'continue');
  }
}, 60_000);

it('starts scoped review on the existing Host workflow service with original input identity', async () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: homeDir, windowsHide: true });
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(path.join(homeDir, 'gate.ts'), 'export const ready = false;\n');
  git('add', 'gate.ts'); git('commit', '-m', 'fixture');
  await writeFile(path.join(homeDir, 'gate.ts'), 'export const ready = true;\n');
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { provider: 'product-domains-test', agentMode: 'sa', permissionMode: 'full-access' });
  let releaseProvider!: () => void;
  const gate = new Promise<void>(resolve => { releaseProvider = resolve; });
  onProviderRequest = async () => gate;
  const started = await first.review.start({ sessionId: session.id, inputId: 'review-workflow', args: ['--workflow', '--lean', 'release'] });
  if (started.kind !== 'started') throw new Error(JSON.stringify(started));
  try {
    expect(await second.workflows.get(started.runId)).toMatchObject({ runId: started.runId });
    expect((await second.sessions.readHistory(session.id)).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'user', inputId: 'review-workflow', text: '/review --workflow --lean release' }),
    ]));
    await first.runs.stop(started.runId);
  } finally { releaseProvider(); }
  expect(await first.runs.await(started.runId)).toMatchObject({ phase: 'interrupted' });
}, 60_000);

it('executes a registered extension with arguments and no output without inventing an LLM turn', async () => {
  const extensionPath = path.join(homeDir, 'product-command.mjs');
  await writeFile(extensionPath, `import { appendFile } from 'node:fs/promises';
export default function(api) {
  api.registerCommand({ name: 'product-note', aliases: ['pn'], description: 'Write an explicit note',
    handler: async (args, context) => {
      await appendFile(context.workingDirectory + '/notes.txt', args.join(' ') + '\\n');
      return args[0] === 'silent' ? undefined : { success: true, message: 'Saved ' + args.join(' ') };
    }
  });
}`);
  await getActiveExtensionRuntime()!.loadExtension(extensionPath);
  const session = await first.sessions.create({ projectPath: homeDir });
  const help = await first.commands.execute({ sessionId: session.id, inputId: 'note-help', name: 'pn', args: ['--help'] });
  expect(help).toMatchObject({ kind: 'completed', success: true, message: expect.stringContaining('Write an explicit note') });
  await expect(readFile(path.join(homeDir, 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await first.sessions.updateSettings(session.id, { provider: 'product-domains-test', agentMode: 'sa', permissionMode: 'full-access' });
  for (const [inputId, name, args] of [
    ['note-one', 'pn', ['release', 'gate']], ['note-two', 'product-note', ['silent']],
  ] as const) {
    const result = await first.commands.execute({ sessionId: session.id, inputId, name, args: [...args] });
    if (result.kind !== 'started') throw new Error(JSON.stringify(result));
    expect(await first.runs.await(result.runId)).toMatchObject({ phase: 'completed', result: { success: true } });
  }
  expect(await readFile(path.join(homeDir, 'notes.txt'), 'utf8')).toBe('release gate\nsilent\n');
  expect((await first.sessions.readHistory(session.id)).items.filter(item => item.type === 'user').map(item => item.text))
    .toEqual(['/pn release gate', '/product-note silent']);
  expect(requests).toEqual([]);
}, 60_000);

it('keeps compact exclusive while it runs and returns an honest provider failure', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { provider: 'product-domains-test', agentMode: 'sa', permissionMode: 'full-access' });
  for (let index = 0; index < 3; index += 1) {
    const accepted = await first.inputs.submit({ sessionId: session.id, inputId: `busy-${index}`, text: `Decision ${index}. ` + 'Release evidence. '.repeat(600) });
    await first.runs.await(accepted.runId!);
  }
  await first.sessions.updateSettings(session.id, { compactionTriggerTokens: 5_000 });
  onProviderRequest = async (messages) => {
    if (JSON.stringify(messages).includes('Fail this compact request.')) throw new Error('Summary provider unavailable');
  };
  expect(await first.sessions.compact(session.id, { customInstructions: 'Fail this compact request.' }))
    .toMatchObject({ compacted: false, reason: expect.stringContaining('Summary provider unavailable') });
  let summaryEntered = false;
  let releaseSummary: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { releaseSummary = resolve; });
  onProviderRequest = async (messages) => {
    if (JSON.stringify(messages).includes('Hold this compact request.')) { summaryEntered = true; await gate; }
  };
  const compacting = first.sessions.compact(session.id, { customInstructions: 'Hold this compact request.' });
  try {
    await expect.poll(() => summaryEntered).toBe(true);
    await expect(second.sessions.compact(session.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(second.inputs.submit({ sessionId: session.id, inputId: 'blocked-input', text: 'Do not start.' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await second.inputs.read(session.id, 'blocked-input')).toBeNull();
  } finally { releaseSummary(); }
  expect(await compacting).toMatchObject({ compacted: true });
  expect(await second.sessions.read(session.id)).toMatchObject({ id: session.id });
}, 60_000);

it('promotes the exact learned Skill through the product client with no broader scope', async () => {
  const identity = { tenantId: 'tenant-product', projectId: 'project-product' };
  const learnedRoot = resolveProjectLearnedAreaRoot(path.join(homeDir, '.kodax'), identity);
  const store = new LearnedAreaStore(learnedRoot);
  await store.initialize();
  const seeded = await commitLearnedSkillRevision(store, {
    scope: createLearnedCapabilityScope(learnedRoot, identity),
    spec: {
      name: 'product-release-skill', description: 'Use when verifying a release.',
      purpose: 'Verify the release from reproducible evidence.', triggers: ['Release needs verification.'],
      steps: ['Run the exact release verification suite.'], verification: ['Require a passing check artifact.'],
      pitfalls: ['Do not treat model self-report as verification.'],
    },
    disposition: 'ready', operation: 'create',
    provenance: { jobId: 'job-product-promote', inputHash: 'a'.repeat(64), decisionId: 'decision-product-promote', actionId: 'action-product-promote' },
  });
  await expect(first.learning.promote(seeded.capabilityId, 'project' as unknown as 'user')).rejects.toThrow();
  expect(await second.learning.get(seeded.capabilityId)).toMatchObject({ lifecycle: 'ready' });
  await first.learning.promote(seeded.capabilityId, 'user');
  expect(await second.learning.get(seeded.capabilityId)).toMatchObject({ lifecycle: 'promoted_user', slug: seeded.slug });
  expect(await readFile(path.join(homeDir, '.kodax', 'skills', seeded.slug, 'SKILL.md'), 'utf8'))
    .toContain('Run the exact release verification suite.');
}, 60_000);

it('keeps Learning notices client scoped while governance and subscriptions share Host facts', async () => {
  const seed = createLearningCenterService({ rootDir: path.join(homeDir, '.kodax', 'learned'), clientIdentity: 'seed' });
  await seed.record({
    schemaVersion: 1, capabilityId: 'lc_product_test', displayName: 'Release Skill', slug: 'release-skill',
    carrier: 'skill', lifecycle: 'ready', revision: 1,
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
    source: { kind: 'learning_controller' },
  });
  expect((await first.learning.list({ lifecycle: 'ready' })).items.map((item) => item.capabilityId)).toEqual(['lc_product_test']);
  expect((await first.learning.getSnapshot()).ready).toBe(1);
  expect((await second.learning.getSnapshot()).ready).toBe(1);
  await first.learning.acknowledge('lc_product_test');
  expect((await first.learning.getSnapshot()).ready).toBe(0);
  expect((await second.learning.getSnapshot()).ready).toBe(1);
  await first.disconnect();
  first = await connectKodaXClient({ homeDir, endpoint: endpointPath, clientInfo: { name: 'domain-test', instanceId: 'first' } });
  expect((await first.learning.getSnapshot()).ready).toBe(0);
  await second.learning.snooze('lc_product_test', '2099-01-01T00:00:00.000Z');
  expect((await second.learning.getSnapshot()).ready).toBe(0);
  const snapshot = await first.learning.getSnapshot();
  const iterator = first.learning.subscribe({ afterRevision: snapshot.revision })[Symbol.asyncIterator]();
  const next = iterator.next();
  try {
    await second.learning.disable('lc_product_test');
    expect((await next).value).toMatchObject({ capabilityId: 'lc_product_test', lifecycle: 'archived' });
    expect(await first.learning.get('lc_product_test')).toMatchObject({ lifecycle: 'archived' });
    expect((await second.learning.events(snapshot.revision)).some((event) => event.lifecycle === 'archived')).toBe(true);
  } finally {
    await iterator.return?.();
  }
}, 60_000);

it('manages project Memory through both clients and rejects stale approval and forget previews', async () => {
  const plane = await first.memory.forProject(homeDir);
  const other = await second.memory.forProject(homeDir);
  expect(await plane.rebuild()).toMatchObject({ status: 'missing-dir' });
  expect(await plane.listReviews()).toEqual([]);
  expect(typeof plane.reviewerProviderConfigured()).toBe('boolean');
  await plane.controller.remember({ statement: 'Deploy on Fridays.', claimKind: 'policy', claimKey: 'deploy.window' });
  const refs = await other.controller.listRefs({ kinds: ['memdir'], lifecycles: ['active', 'trusted'] });
  expect(refs).toHaveLength(1);
  const before = await other.controller.readRef(refs[0]!);
  expect(before.body).toContain('Deploy on Fridays.');
  // Incoming client paths are hints: Host resolves the exact identity again.
  expect(await other.controller.readRef({ ...refs[0]!, storageUri: path.join(homeDir, 'unrelated.txt') }))
    .toMatchObject({ body: before.body, bodyFingerprint: before.bodyFingerprint });
  await plane.controller.remember({ statement: 'Never deploy on Fridays.', claimKind: 'policy', claimKey: 'deploy.window' });
  const inbox = await other.controller.listInbox();
  expect(inbox).toHaveLength(1);
  const preview = await other.controller.showProposal(inbox[0]!.id);
  if (!preview) throw new Error('Expected a conflicting Memory proposal.');
  const target = preview.targetRefs.find((ref) => ref.storageUri !== undefined)?.storageUri;
  if (!target) throw new Error('Expected proposal target file.');
  // An editor can change the file after either UI has shown the preview.
  await appendFile(target, '\nEdited after preview.');
  expect(await plane.controller.approveProposal(preview.id, preview.expectedFingerprints, preview.revision)).toMatchObject({ applied: false });
  expect(await plane.controller.forgetRef(refs[0]!.id, before.bodyFingerprint)).toMatchObject({ acknowledged: false });
  const current = await other.controller.showProposal(preview.id);
  if (!current) throw new Error('Expected pending proposal after stale approval.');
  expect(await other.controller.rejectProposal(current.id, 'Keep the edited policy.', current.revision)).toMatchObject({ rejected: true });
  const latest = await other.controller.readRef(refs[0]!);
  await plane.controller.forgetRef(refs[0]!.id, latest.bodyFingerprint);
  expect(await other.controller.listRefs({ kinds: ['memdir'], lifecycles: ['active', 'trusted'] })).toEqual([]);
  const topic = path.join(plane.memoryRoot, 'release.md');
  const topicBody = '---\nname: Release\ndescription: Release policy\ntype: policy\n---\nRun checks.';
  await writeFile(topic, topicBody);
  expect(await plane.rebuild()).toMatchObject({ status: 'rebuilt', entryCount: 1 });
  expect(await readFile(topic, 'utf8')).toBe(topicBody);
  expect(await plane.ensureOpenTarget(plane.entrypointPath)).toBe(plane.entrypointPath);
  await expect(plane.ensureOpenTarget(homeDir)).rejects.toThrow(/escapes the project memory root/);
}, 60_000);
