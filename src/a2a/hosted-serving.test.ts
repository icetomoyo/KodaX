import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

import type { AgentDispatchContext } from '@kodax-ai/agent';
import { registerCustomProviders } from '@kodax-ai/llm';

import { createKodaXRuntime, type KodaXRuntime } from '../sdk-runtime.js';
import type { RuntimeAgentBindingService } from '../runtime-agent-binding.js';
import { realmA2APrincipalKey } from './principal-key.js';
import { prepareKodaXA2AServer } from './server.js';

const STRICT_POLICY = {
  workspace: 'read',
  process: 'deny',
  network: { mode: 'deny' },
  tools: [],
  mcp: {},
  skillScripts: {},
  subagents: 'deny',
} as const;

// 1x1 transparent PNG — the inbound data part must survive as a real image
// artifact the provider can consume.
const PNG_BASE64
  = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function sseFrames(frames: readonly unknown[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function chunk(delta: unknown, finishReason: string | null): unknown {
  return {
    id: 'chatcmpl-hosted', object: 'chat.completion.chunk', created: 1, model: 'hosted-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function textCompletion(text: string): string {
  return sseFrames([
    chunk({ role: 'assistant', content: text }, null),
    chunk({}, 'stop'),
  ]);
}

function bashToolCall(): string {
  const command = JSON.stringify(
    { command: 'echo tool-ran > policy-escape-marker.txt' },
  );
  return sseFrames([
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-hosted', type: 'function', function: { name: 'bash', arguments: '' } }] }, null),
    chunk({ tool_calls: [{ index: 0, function: { arguments: command } }] }, null),
    chunk({}, 'tool_calls'),
  ]);
}

interface A2ATaskView {
  readonly status?: { readonly state?: string };
}

async function sendAndGetTaskId(
  server: Awaited<ReturnType<typeof prepareKodaXA2AServer>>,
  input: {
    readonly messageId: string;
    readonly contextId: string;
    readonly parts: readonly unknown[];
  },
): Promise<string> {
  const response = await server.handle(new Request('http://127.0.0.1:1/a2a', {
    method: 'POST',
    headers: {
      authorization: 'Bearer hosted-token',
      'content-type': 'application/json',
      'a2a-version': '1.0',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: `send-${input.messageId}`, method: 'SendMessage',
      params: {
        message: {
          messageId: input.messageId, contextId: input.contextId,
          role: 'ROLE_USER', parts: input.parts,
        },
        configuration: { returnImmediately: true },
      },
    }),
  }));
  expect(response.status).toBe(200);
  const body = await response.json() as {
    readonly result?: { readonly task?: { readonly id?: string } };
  };
  const taskId = body.result?.task?.id;
  if (!taskId) throw new Error('SendMessage did not admit a task.');
  return taskId;
}

async function pollTaskTerminal(
  server: Awaited<ReturnType<typeof prepareKodaXA2AServer>>,
  taskId: string,
  deadlineMs = 30_000,
): Promise<A2ATaskView & { readonly body: string }> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const response = await server.handle(new Request('http://127.0.0.1:1/a2a', {
      method: 'POST',
      headers: {
        authorization: 'Bearer hosted-token',
        'content-type': 'application/json',
        'a2a-version': '1.0',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: `get-${taskId}`, method: 'GetTask', params: { id: taskId } }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { readonly result?: A2ATaskView };
    const state = body.result?.status?.state;
    if (state === 'TASK_STATE_COMPLETED' || state === 'TASK_STATE_FAILED' || state === 'TASK_STATE_CANCELED') {
      return { ...body.result, body: JSON.stringify(body.result) };
    }
    if (Date.now() > deadline) throw new Error(`Task ${taskId} did not reach a terminal state: ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

it('serves A2A through the Host binding contract: allowed work succeeds, out-of-policy tools are refused, identity and workspaces stay attributed (T21)', async () => {
  const requestBodies: string[] = [];
  const providerServer = createServer((request, response) => {
    response.socket?.on('error', () => undefined);
    if (!request.url?.includes('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      requestBodies.push(body);
      const wantsDeniedTool = body.includes('Outside-range work')
        && !body.includes('Blocked by guardrail');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(wantsDeniedTool ? bashToolCall() : textCompletion('Hosted A2A completed.'));
    });
  });
  await new Promise<void>((resolve) => { providerServer.listen(0, '127.0.0.1', resolve); });
  const address = providerServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not bind the hosted serving provider.');
  }
  vi.stubEnv('KODAX_HOSTED_TEST_KEY', 'test-only');

  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-a2a-hosted-'));
  await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({
    customProviders: [{
      name: 'hosted-test',
      protocol: 'openai',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKeyEnv: 'KODAX_HOSTED_TEST_KEY',
      model: 'hosted-model',
      imageInput: true,
    }],
  }), 'utf8');
  const dataDir = path.join(homeDir, 'a2a-data');

  let runtime: KodaXRuntime | undefined;
  let server: Awaited<ReturnType<typeof prepareKodaXA2AServer>> | undefined;
  try {
    runtime = await createKodaXRuntime({
      homeDir,
      defaultProvider: 'hosted-test',
      defaultModel: 'hosted-model',
    });
    // Observe the Host→binder seam while keeping the REAL binding service
    // in charge of policy enforcement and run execution.
    const realExecution = runtime.agents.execution;
    if (!realExecution) throw new Error('Host runtime does not own an agent binding service.');
    const observedDispatch: AgentDispatchContext[] = [];
    let observedBind: Parameters<RuntimeAgentBindingService['bindDefault']>[0] | undefined;
    const instrumented = Object.create(realExecution) as RuntimeAgentBindingService;
    instrumented.bindDefault = async (input) => {
      observedBind = input;
      return realExecution.bindDefault(input);
    };
    instrumented.startDefault = async (input) => {
      if (input.agentContext) observedDispatch.push(input.agentContext);
      return realExecution.startDefault(input);
    };
    (runtime.agents as { execution?: RuntimeAgentBindingService }).execution = instrumented;

    server = await prepareKodaXA2AServer({
      runtime,
      dataDir,
      agent: {
        name: 'Hosted KodaX Agent',
        description: 'Served by the Host binding contract.',
        version: '1.0.0',
        publicBaseUrl: 'http://127.0.0.1:1',
        skills: [],
        inputModes: ['text/plain', 'image/png'],
        outputModes: ['text/plain'],
      },
      execution: {
        kind: 'runtime-default',
        workspace: { mode: 'managed' },
        toolPolicy: STRICT_POLICY,
      },
      limits: {
        maxRequestBytes: 64 * 1024,
        maxPartBytes: 32 * 1024,
        maxConcurrentTasks: 4,
        maxTaskWaitMs: 500,
        maxWorkspaceBytesPerContext: 8 * 1024 * 1024,
      },
      authentication: {
        securityRealm: 'test:realm',
        securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
        securityRequirements: [{ schemes: { bearer: { list: [] } } }],
        async authenticate(request: Request) {
          return request.headers.get('authorization') === 'Bearer hosted-token'
            ? { subject: 'caller-1', scopes: ['a2a'] }
            : null;
        },
      },
      authorize: async () => true,
    });

    // The declared policy reaches the real binder unchanged.
    expect(observedBind?.workspace).toEqual({ mode: 'managed' });
    expect(observedBind?.toolPolicy).toEqual(STRICT_POLICY);

    // Allowed range: the run completes through the Host binding.
    const allowedTask = await pollTaskTerminal(server, await sendAndGetTaskId(server, {
      messageId: 'allowed-1', contextId: 'ctx-a', parts: [{ text: 'Allowed hosted work' }],
    }));
    expect(allowedTask.status?.state).toBe('TASK_STATE_COMPLETED');
    expect(allowedTask.body).toContain('Hosted A2A completed.');

    // Out-of-policy tool: `bash` is outside the read-only bound surface, so
    // the guardrail refuses it before execution and the marker never lands.
    const deniedTask = await pollTaskTerminal(server, await sendAndGetTaskId(server, {
      messageId: 'denied-1', contextId: 'ctx-a', parts: [{ text: 'Outside-range work' }],
    }));
    expect(deniedTask.status?.state).toBe('TASK_STATE_COMPLETED');
    expect(requestBodies.some((body) => body.includes('Blocked by guardrail')
      && body.includes('Tool is outside the bound surface'))).toBe(true);

    // Workspace isolation: a second context gets its own prepared root, and
    // inbound data parts materialize inside that boundary.
    const isolatedTaskId = await sendAndGetTaskId(server, {
      messageId: 'isolated-1',
      contextId: 'ctx-b',
      parts: [
        { text: 'Isolated context work' },
        { raw: PNG_BASE64, mediaType: 'image/png', filename: 'attachment.png' },
      ],
    });
    const isolatedTask = await pollTaskTerminal(server, isolatedTaskId);
    expect(isolatedTask.status?.state).toBe('TASK_STATE_COMPLETED');

    const persisted = JSON.parse(await readFile(path.join(dataDir, 'tasks.json'), 'utf8')) as ReadonlyArray<{
      readonly taskId: string;
      readonly contextId: string;
      readonly workspaceRoot?: string;
      readonly principalKey: string;
    }>;
    expect(persisted.length).toBe(3);
    const contextA = persisted.filter((record) => record.contextId === 'ctx-a');
    expect(new Set(contextA.map((record) => record.workspaceRoot)).size).toBe(1);
    const rootA = contextA[0]?.workspaceRoot;
    const recordB = persisted.find((record) => record.contextId === 'ctx-b');
    const rootB = recordB?.workspaceRoot;
    expect(rootA).toBeDefined();
    expect(rootB).toBeDefined();
    expect(rootB).not.toBe(rootA);
    for (const root of [rootA!, rootB!]) {
      expect(existsSync(root)).toBe(true);
      expect(path.resolve(root).startsWith(path.resolve(homeDir))).toBe(true);
    }
    // The refused command never executed anywhere inside the boundary.
    expect(existsSync(path.join(rootA!, 'policy-escape-marker.txt'))).toBe(false);
    const walkFiles = (directory: string): string[] => {
      const found: string[] = [];
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) found.push(...walkFiles(full));
        else found.push(full);
      }
      return found;
    };
    const inboxFiles = walkFiles(path.join(rootB!, 'inbox'));
    expect(inboxFiles.length).toBe(1);
    expect(inboxFiles[0].endsWith('attachment.png')).toBe(true);
    // The attachment reached the provider wire as real image content from
    // inside the isolated workspace.
    expect(requestBodies.some((body) => body.includes(PNG_BASE64))).toBe(true);

    // Identity attribution: every Host-side run carries the authenticated
    // A2A principal, not a caller-supplied identity.
    const expectedPrincipal = realmA2APrincipalKey({
      securityRealm: 'test:realm',
      subject: 'caller-1',
    });
    expect(new Set(persisted.map((record) => record.principalKey))).toEqual(
      new Set([expectedPrincipal]),
    );
    expect(observedDispatch.length).toBe(3);
    for (const context of observedDispatch) {
      expect(context.actorId).toBe(`a2a:${expectedPrincipal.slice(0, 16)}`);
    }
  } finally {
    await server?.close();
    await runtime?.close();
    registerCustomProviders([]);
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => {
      providerServer.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90_000);
