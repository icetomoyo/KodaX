import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult, type KodaXToolUseBlock, type KodaXToolDefinition,
} from '@kodax-ai/llm';
import type { ClientInteraction, ClientSessionView } from '@kodax-ai/coding/client-contract';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

/** First scripted Provider turn raises one tool call; later turns answer in plain text. */
class InteractionProvider extends KodaXBaseProvider {
  readonly name = 'product-interactions-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_INTERACTIONS_TEST_KEY', model: 'product-interactions-test', supportsThinking: false,
  };
  constructor(private readonly script: () => KodaXToolUseBlock[]) { super(); }
  async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
    exposedTools.push(tools.map(tool => tool.name));
    requests.push(structuredClone(messages));
    return requests.length === 1
      ? { textBlocks: [], thinkingBlocks: [], toolBlocks: this.script(), stopReason: 'tool_use' }
      : { textBlocks: [{ type: 'text', text: 'Follow-up complete.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  }
}

let homeDir: string;
let endpointPath: string;
let scriptedToolCall: () => KodaXToolUseBlock[] = () => [];
let requests: KodaXMessage[][] = [];
let exposedTools: string[][] = [];
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let first: Awaited<ReturnType<typeof connectKodaXClient>>;
let second: Awaited<ReturnType<typeof connectKodaXClient>>;
let reconnect: Awaited<ReturnType<typeof connectKodaXClient>> | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-interactions-'));
  requests = [];
  exposedTools = [];
  scriptedToolCall = () => [];
  registerModelProvider('product-interactions-test', () => new InteractionProvider(() => scriptedToolCall()));
  vi.stubEnv('KODAX_PRODUCT_INTERACTIONS_TEST_KEY', 'test-only');
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-interactions-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated interactions Host.');
  endpointPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\kodax-interactions-${randomUUID()}`
    : path.join(homeDir, 'host.sock');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: endpointPath }
    : { kind: 'unix' as const, path: endpointPath };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  first = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  second = await connectKodaXClient({ homeDir, endpoint: endpointPath });
});

afterEach(async () => {
  await reconnect?.disconnect();
  reconnect = undefined;
  await Promise.all([first.disconnect(), second.disconnect()]);
  await host.close();
  await runtime.close();
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 30_000);

function questionToolCall(): KodaXToolUseBlock {
  return {
    type: 'tool_use',
    id: 'call-question-1',
    name: 'ask_user_question',
    input: {
      question: 'Deploy the release now?',
      options: [{ label: 'Ship it', value: 'ship' }, { label: 'Hold', value: 'hold' }],
    },
  };
}

it('exposes the full plan through both Product clients and applies only the first approval on the Host', async () => {
  const plan = `Final plan\n${'Review the complete implementation and validation details.\n'.repeat(400)}END OF PLAN`;
  scriptedToolCall = () => [{ type: 'tool_use', id: 'exit-plan', name: 'exit_plan_mode', input: { plan } }];
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'plan' });
  const active = await first.inputs.submit({ sessionId: session.id, inputId: 'plan', text: 'Prepare the plan.' });
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
  expect(exposedTools[0]).toContain('exit_plan_mode');
  let approval: ClientInteraction | undefined;
  await expect.poll(async () => {
    approval = (await second.interactions.list({ sessionId: session.id })).find(item => item.kind === 'permission');
    return approval !== undefined;
  }, { timeout: 15_000 }).toBe(true);
  if (approval?.kind !== 'permission') throw new Error('Expected plan approval');
  expect(approval.options).toMatchObject({ toolName: 'exit_plan_mode', plan });
  expect((await first.interactions.list({ sessionId: session.id }))[0]).toEqual(approval);
  expect(await first.sessions.getSettings(session.id)).toMatchObject({ permissionMode: 'plan' });
  expect(await first.interactions.respond(approval.requestId, { kind: 'permission', decision: { type: 'allow_once' } }))
    .toMatchObject({ accepted: true });
  expect(await second.interactions.respond(approval.requestId, { kind: 'permission', decision: { type: 'reject' } }))
    .toMatchObject({ accepted: false, status: 'already_resolved' });
  await first.runs.await(active.runId!);
  expect(await second.sessions.getSettings(session.id)).toMatchObject({ permissionMode: 'accept-edits' });
  expect(JSON.stringify(requests[1])).toContain('User approved the plan');
});

it.each(['reject', 'cancel', 'stop'] as const)('keeps Host permission in plan mode after plan approval %s', async action => {
  scriptedToolCall = () => [{ type: 'tool_use', id: 'exit-plan', name: 'exit_plan_mode', input: { plan: 'Review this plan first.' } }];
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'plan' });
  const active = await first.inputs.submit({ sessionId: session.id, inputId: `plan-${action}`, text: 'Prepare the plan.' });
  let approval: ClientInteraction | undefined;
  await expect.poll(async () => {
    approval = (await second.interactions.list({ sessionId: session.id })).find(item => item.kind === 'permission');
    return approval !== undefined;
  }, { timeout: 15_000 }).toBe(true);
  if (approval?.kind !== 'permission') throw new Error('Expected plan approval');
  if (action === 'stop') await second.sessions.cancel({ sessionId: session.id, expectedRunId: active.runId!, requestId: 'stop-plan' });
  else await second.interactions.respond(approval.requestId, action === 'cancel' ? { kind: 'cancel' }
    : { kind: 'permission', decision: { type: 'reject' } });
  await first.runs.await(active.runId!);
  expect(await second.sessions.getSettings(session.id)).toMatchObject({ permissionMode: 'plan' });
  expect(await first.interactions.respond(approval.requestId, { kind: 'permission', decision: { type: 'allow_once' } }))
    .toMatchObject({ accepted: false });
});

it('invokes an explicit Product tool through IPC once without a model turn', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const file = path.join(homeDir, 'direct-read.txt');
  await writeFile(file, 'original tool content');
  const invocation = { sessionId: session.id, inputId: 'direct-read', name: 'read', input: { path: file }, rawInput: '!read direct-read.txt' };
  const started = await first.runs.startTool(invocation);
  expect(await second.runs.await(started.runId)).toMatchObject({ phase: 'completed', result: {
    success: true, lastText: expect.stringContaining('original tool content'),
  } });
  expect(await second.runs.startTool(invocation)).toEqual(started);
  expect(requests).toHaveLength(0);
  expect(await first.inputs.read(session.id, invocation.inputId)).toMatchObject({ state: 'submitted', runId: started.runId });
});

it('cancels an explicit tool at its permission boundary through Product Session Stop', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'accept-edits' });
  const marker = path.join(homeDir, '.kodax', 'direct-stop.txt');
  const started = await first.runs.startTool({ sessionId: session.id, inputId: 'direct-write', name: 'write',
    input: { path: marker, content: 'must not write' }, rawInput: '!write direct-stop.txt' });
  await expect.poll(async () => (await second.interactions.list({ sessionId: session.id })).some(item => item.kind === 'permission'))
    .toBe(true);
  const input = { sessionId: session.id, expectedRunId: started.runId, requestId: 'direct-stop' };
  const receipt = await second.sessions.cancel(input);
  expect(receipt).toMatchObject(input);
  expect(receipt.receipts.some(item => item.runId === started.runId)).toBe(true);
  expect(await first.runs.await(started.runId)).toMatchObject({ phase: 'interrupted' });
  await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(requests).toHaveLength(0);
});

function questionToolCallForRace(): KodaXToolUseBlock[] {
  return [{ ...questionToolCall(), id: 'call-question-race' }];
}

function pendingQuestion(views: readonly ClientSessionView[]): ClientInteraction | undefined {
  for (const view of views) {
    const found = view.interactions.find((item) => item.kind === 'question');
    if (found) return found;
  }
  return undefined;
}

it('shows the same pending question to both clients, accepts only the first answer, and reconnects to it', async () => {
  scriptedToolCall = () => [questionToolCall()];
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const firstViews: ClientSessionView[] = [];
  const secondViews: ClientSessionView[] = [];
  const firstObservation = await first.sessions.observe(session.id, (view) => firstViews.push(view));
  const secondObservation = await second.sessions.observe(session.id, (view) => secondViews.push(view));
  try {
    const active = await first.inputs.submit({ sessionId: session.id, inputId: 'ask', text: 'Ask me whether to deploy.' });
    await expect.poll(() => pendingQuestion(secondViews), { timeout: 15_000 }).toBeTruthy();

    // Both clients see the very same pending interaction identity.
    const question = pendingQuestion(secondViews)!;
    expect(pendingQuestion(firstViews)?.requestId).toBe(question.requestId);
    expect(question.sessionId).toBe(session.id);
    if (question.kind === 'question') {
      expect(question.options.question).toBe('Deploy the release now?');
      expect(question.options.options?.map((option) => option.value)).toEqual(['ship', 'hold']);
    } else {
      throw new Error(`Expected a question interaction, got ${question.kind}`);
    }
    const listed = await second.interactions.list({ sessionId: session.id });
    expect(listed.map((item) => item.requestId)).toContain(question.requestId);

    // A freshly connected client keeps seeing the unresolved question.
    reconnect = await connectKodaXClient({ homeDir, endpoint: endpointPath });
    const reconnectViews: ClientSessionView[] = [];
    const reconnectObservation = await reconnect.sessions.observe(session.id, (view) => reconnectViews.push(view));
    try {
      expect(reconnectViews[0]!.interactions.some((item) => item.requestId === question.requestId)).toBe(true);
    } finally { reconnectObservation.close(); }

    // A typed response for a different interaction kind cannot act on this request.
    await expect(second.interactions.respond(question.requestId, { kind: 'permission', decision: { type: 'allow_once' } }))
      .rejects.toMatchObject({ code: 'invalid_params' });

    // First valid answer is processed exactly once.
    const accepted = await first.interactions.respond(question.requestId, { kind: 'question', answer: 'ship' });
    expect(accepted).toMatchObject({ requestId: question.requestId, accepted: true, status: 'answered' });

    await runtime.runs.await(active.runId!);
    const settledRequests = requests.length;
    // The chosen answer entered the conversation exactly once.
    expect(JSON.stringify(requests.at(-1)!)).toContain('"ship"');

    // Late duplicate answers, and late cancels, are explicitly invalid and create no work.
    expect(await second.interactions.respond(question.requestId, { kind: 'question', answer: 'hold' }))
      .toMatchObject({ accepted: false, status: 'already_resolved' });
    expect(await second.interactions.respond(question.requestId, { kind: 'cancel' }))
      .toMatchObject({ accepted: false, status: 'already_resolved' });
    expect(requests.length).toBe(settledRequests);
    await expect.poll(() => secondViews.at(-1)!.interactions.length, { timeout: 15_000 }).toBe(0);
  } finally {
    firstObservation.close();
    secondObservation.close();
  }
}, 60_000);

it('returns multi-question answers with arrays, zero selections, and custom input intact', async () => {
  scriptedToolCall = () => [{
    type: 'tool_use',
    id: 'call-question-multi',
    name: 'ask_user_question',
    input: {
      // The tool schema requires `question` even in questions mode; the
      // questions array takes precedence at execution time.
      question: 'Deployment checklist',
      questions: [
        { question: 'Pick many', multi_select: true, options: [{ label: 'Red', value: 'red' }, { label: 'Green', value: 'green' }] },
        { question: 'Pick one', options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], allow_custom_input: true },
      ],
    },
  }];
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const views: ClientSessionView[] = [];
  const observation = await second.sessions.observe(session.id, (view) => views.push(view));
  try {
    const active = await first.inputs.submit({ sessionId: session.id, inputId: 'multi', text: 'Ask the batch.' });
    await expect.poll(() => views.some((view) => view.interactions.some((item) => item.kind === 'question_multi')), { timeout: 15_000 })
      .toBe(true);
    const interaction = views.flatMap((view) => view.interactions).find((item) => item.kind === 'question_multi')!;
    if (interaction.kind !== 'question_multi') throw new Error(`Expected question_multi, got ${interaction.kind}`);
    expect(interaction.options.questions.map((item) => item.question)).toEqual(['Pick many', 'Pick one']);

    const accepted = await first.interactions.respond(interaction.requestId, {
      kind: 'question_multi',
      answers: {
        'Pick many': [], // zero selections stay a valid answer
        'Pick one': { kind: 'customInput', value: 'free-form deployment note' },
      },
    });
    expect(accepted).toMatchObject({ accepted: true, status: 'answered' });
    expect(await second.interactions.respond(interaction.requestId, {
      kind: 'question_multi', answers: { 'Pick many': ['red'], 'Pick one': 'green' },
    })).toMatchObject({ accepted: false, status: 'already_resolved' });

    await runtime.runs.await(active.runId!);
    const followUp = JSON.stringify(requests.at(-1)!);
    expect(followUp).toContain('free-form deployment note');
    expect(followUp).toContain('Pick many');
  } finally { observation.close(); }
}, 60_000);

it('settles exactly one winner when both clients answer the same question concurrently', async () => {
  scriptedToolCall = questionToolCallForRace;
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const views: ClientSessionView[] = [];
  const observation = await second.sessions.observe(session.id, (view) => views.push(view));
  try {
    const active = await first.inputs.submit({ sessionId: session.id, inputId: 'race', text: 'Ask me the race question.' });
    await expect.poll(() => pendingQuestion(views), { timeout: 15_000 }).toBeTruthy();
    const question = pendingQuestion(views)!;

    const [fromFirst, fromSecond] = await Promise.all([
      first.interactions.respond(question.requestId, { kind: 'question', answer: 'ship' }),
      second.interactions.respond(question.requestId, { kind: 'question', answer: 'hold' }),
    ]);
    expect([fromFirst.accepted, fromSecond.accepted].filter(Boolean)).toHaveLength(1);
    expect([fromFirst, fromSecond].find((result) => result.accepted)?.status).toBe('answered');
    expect([fromFirst, fromSecond].find((result) => !result.accepted)?.status).toBe('already_resolved');

    await runtime.runs.await(active.runId!);
    await expect.poll(() => views.at(-1)!.interactions.length, { timeout: 15_000 }).toBe(0);
  } finally { observation.close(); }
}, 60_000);

it('cancels a pending question explicitly and keeps later answers invalid', async () => {
  scriptedToolCall = () => [questionToolCall()];  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const views: ClientSessionView[] = [];
  const observation = await second.sessions.observe(session.id, (view) => views.push(view));
  try {
    const active = await first.inputs.submit({ sessionId: session.id, inputId: 'cancel-me', text: 'Ask then I will cancel.' });
    await expect.poll(() => pendingQuestion(views), { timeout: 15_000 }).toBeTruthy();
    const question = pendingQuestion(views)!;

    const cancelled = await second.interactions.respond(question.requestId, { kind: 'cancel', reason: 'changed my mind' });
    expect(cancelled).toMatchObject({ requestId: question.requestId, accepted: true, status: 'dismissed' });
    expect(await first.interactions.respond(question.requestId, { kind: 'question', answer: 'ship' }))
      .toMatchObject({ accepted: false, status: 'already_resolved' });

    await runtime.runs.await(active.runId!);
    // The dismissed question created no follow-up Provider work.
    expect(requests.length).toBe(1);
    await expect.poll(() => views.at(-1)!.interactions.length, { timeout: 15_000 }).toBe(0);
  } finally { observation.close(); }
}, 60_000);

it('approves one pending permission once, executes the action once, and invalidates late answers', async () => {
  // A write into the project's .kodax/ config directory is an always-confirm
  // path, so accept-edits raises a real permission instead of sandboxing it.
  scriptedToolCall = () => [{
    type: 'tool_use',
    id: 'call-permission-1',
    name: 'write',
    input: { path: path.join(homeDir, '.kodax', 'perm-marker.txt'), content: 'perm-once' },
  }];
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'accept-edits' });
  const marker = path.join(homeDir, '.kodax', 'perm-marker.txt');
  const views: ClientSessionView[] = [];
  const observation = await second.sessions.observe(session.id, (view) => views.push(view));
  try {
    const active = await first.inputs.submit({ sessionId: session.id, inputId: 'bash-run', text: 'Write the marker file.' });
    await expect.poll(() => views.some((view) => view.interactions.some((item) => item.kind === 'permission')), { timeout: 15_000 })
      .toBe(true);
    const permission = views.flatMap((view) => view.interactions).find((item) => item.kind === 'permission')!;
    if (permission.kind !== 'permission') throw new Error(`Expected permission, got ${permission.kind}`);
    expect(permission.options.toolName).toBe('write');
    expect(permission.options.inputPreview).toContain('perm-marker.txt');

    // Question answers cannot act on a permission request.
    await expect(first.interactions.respond(permission.requestId, { kind: 'question', answer: 'ship' }))
      .rejects.toMatchObject({ code: 'invalid_params' });

    const approved = await first.interactions.respond(permission.requestId, {
      kind: 'permission', decision: { type: 'allow_once' },
    });
    expect(approved).toMatchObject({ requestId: permission.requestId, accepted: true, status: 'answered' });

    // The other client's duplicate approval is explicitly invalid.
    expect(await second.interactions.respond(permission.requestId, {
      kind: 'permission', decision: { type: 'allow_once' },
    })).toMatchObject({ accepted: false, status: 'already_resolved' });
    expect(await second.interactions.respond(permission.requestId, { kind: 'cancel' }))
      .toMatchObject({ accepted: false, status: 'already_resolved' });

    await runtime.runs.await(active.runId!);
    expect((await readFile(marker, 'utf8')).trim()).toBe('perm-once');
    await expect.poll(() => views.at(-1)!.interactions.length, { timeout: 15_000 }).toBe(0);
  } finally { observation.close(); }
}, 60_000);
