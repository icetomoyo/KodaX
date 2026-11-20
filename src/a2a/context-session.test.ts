import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult, type KodaXToolDefinition,
} from '@kodax-ai/llm';
import { LEARNING_REVIEW_TOOL } from '@kodax-ai/coding';
import { createKodaXRuntime } from '../../tests/runtime-fixture.js';
import { prepareKodaXA2AServer } from './server.js';
import type { A2AServerOptions, A2ATask } from './types.js';

const providerName = 'a2a-context-session-test';
const seen: string[][] = [];
let firstCallGate: Promise<void> | undefined;
class RecordingProvider extends KodaXBaseProvider {
  readonly name = providerName;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_A2A_CONTEXT_TEST_KEY', model: 'test', supportsThinking: false,
  };
  async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
    // A finished Run queues a background learning review on the same provider;
    // it races the next task, so only conversation turns are recorded.
    if (tools.some((tool) => tool.name === LEARNING_REVIEW_TOOL.name)) {
      return { thinkingBlocks: [], stopReason: 'end_turn', toolBlocks: [], textBlocks: [] };
    }
    seen.push(messages.map((message) => JSON.stringify(message.content)));
    if (seen.length === 1) await firstCallGate;
    return { thinkingBlocks: [], stopReason: 'end_turn', toolBlocks: [],
      textBlocks: [{ type: 'text', text: `answer-${seen.length}` }] };
  }
}

const roots: string[] = [];
afterEach(async () => {
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  seen.length = 0;
  firstCallGate = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function rpc(token: string, id: string, method: string, params: Record<string, unknown>): Request {
  return new Request('http://127.0.0.1:1/a2a', { method: 'POST', headers: {
    'content-type': 'application/json', 'a2a-version': '1.0', authorization: `Bearer ${token}`,
  }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
}

function send(token: string, messageId: string, contextId: string, text: string, returnImmediately = false): Request {
  return rpc(token, messageId, 'SendMessage', {
    message: { messageId, contextId, role: 'ROLE_USER', parts: [{ text }] },
    ...(returnImmediately ? { configuration: { returnImmediately: true } } : {}),
  });
}

async function startServer() {
  const root = mkdtempSync(path.join(tmpdir(), 'kodax-a2a-context-session-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  vi.stubEnv('KODAX_A2A_CONTEXT_TEST_KEY', 'test');
  registerModelProvider(providerName, () => new RecordingProvider());
  const runtime = await createKodaXRuntime({ mode: 'embedded', homeDir: root,
    defaultProvider: providerName, defaultModel: 'test', permissionTimeoutMs: 1_000 });
  const dataDir = path.join(root, 'a2a');
  const options: A2AServerOptions = {
    runtime, dataDir,
    agent: { name: 'Chat', description: 'Chat', version: 'test', publicBaseUrl: 'http://127.0.0.1:1',
      skills: [], inputModes: ['text/plain'], outputModes: ['text/plain'], projectPath: workspace },
    execution: { kind: 'runtime-default', workspace: { mode: 'fixed', root: workspace }, toolPolicy: {
      workspace: 'read', process: 'deny', network: { mode: 'deny' }, tools: [], mcp: {}, skillScripts: {}, subagents: 'deny',
    } },
    limits: { maxRequestBytes: 64 * 1024, maxPartBytes: 32 * 1024, maxConcurrentTasks: 4, maxTasksPerPrincipal: 8, maxTaskWaitMs: 10_000 },
    authentication: { securityRealm: 'test', securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      async authenticate(request) {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
        return token ? { subject: token, scopes: [] } : null;
      } },
    async authorize() { return true; },
  };
  const server = await prepareKodaXA2AServer(options);
  const sessionIds = () => new Map((JSON.parse(readFileSync(path.join(dataDir, 'tasks.json'), 'utf8')) as Array<{
    readonly taskId: string; readonly sessionId: string;
  }>).map((record) => [record.taskId, record.sessionId]));
  return { server, runtime, sessionIds };
}

async function completed(response: Response): Promise<A2ATask> {
  const body = await response.json() as { readonly result: { readonly task: A2ATask } };
  expect(body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
  return body.result.task;
}

it('continues one Runtime Session for every task in a principal context', async () => {
  const { server, runtime, sessionIds } = await startServer();
  try {
    const first = await completed(await server.handle(send('alice', 'm1', 'trip-plan', 'first question')));
    const second = await completed(await server.handle(send('alice', 'm2', 'trip-plan', 'second question')));
    const ids = sessionIds();
    expect(ids.get(second.id)).toBe(ids.get(first.id));
    expect(ids.get(first.id)).toMatch(/^a2a-[0-9a-f]{64}$/);
    const secondRequest = seen.at(-1)!.join('\n');
    expect(secondRequest).toContain('first question');
    expect(secondRequest).toContain('answer-1');
  } finally {
    await server.close();
    await runtime.close();
  }
});

it('keeps separate Runtime Sessions for other contexts and other principals', async () => {
  const { server, runtime, sessionIds } = await startServer();
  try {
    const base = await completed(await server.handle(send('alice', 'm1', 'shared-name', 'alice context')));
    const otherContext = await completed(await server.handle(send('alice', 'm2', 'other-name', 'other context')));
    const otherPrincipal = await completed(await server.handle(send('bob', 'm3', 'shared-name', 'bob context')));
    const ids = sessionIds();
    expect(new Set([ids.get(base.id), ids.get(otherContext.id), ids.get(otherPrincipal.id)]).size).toBe(3);
    expect(seen.at(-1)!.join('\n')).not.toContain('alice context');
  } finally {
    await server.close();
    await runtime.close();
  }
});

it('runs an overlapping task in the same context after the active one', async () => {
  let release: () => void = () => undefined;
  firstCallGate = new Promise((resolve) => { release = resolve; });
  const { server, runtime } = await startServer();
  try {
    const started = await Promise.all(['m1', 'm2'].map(async (messageId, index) => {
      const response = await server.handle(send('alice', messageId, 'busy-context', `question-${index + 1}`, true));
      return (await response.json() as { readonly result: { readonly task: A2ATask } }).result.task.id;
    }));
    release();
    for (const taskId of started) {
      await expect.poll(async () => {
        const response = await server.handle(rpc('alice', `get-${taskId}`, 'GetTask', { id: taskId }));
        return (await response.json() as { readonly result: A2ATask }).result.status.state;
      }, { timeout: 10_000 }).toBe('TASK_STATE_COMPLETED');
    }
    expect(seen).toHaveLength(2);
    expect(seen[1]!.join('\n')).toContain('answer-1');
  } finally {
    await server.close();
    await runtime.close();
  }
});
