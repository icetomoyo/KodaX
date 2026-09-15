import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { createKodaXRuntime } from '../sdk-runtime.js';
import { prepareKodaXA2AServer } from './server.js';
import type { A2AServerOptions, A2ATask } from './types.js';

const providerName = 'a2a-file-output-test';
class FileOutputProvider extends KodaXBaseProvider {
  static calls = 0;
  readonly name = providerName;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_A2A_FILE_TEST_KEY', model: 'test', supportsThinking: false,
  };
  async stream(_messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    const first = FileOutputProvider.calls++ === 0;
    return { thinkingBlocks: [], stopReason: first ? 'tool_use' : 'end_turn',
      textBlocks: first ? [] : [{ type: 'text', text: 'Report ready.' }],
      toolBlocks: first ? [{ type: 'tool_use', id: 'report-write', name: 'write', input: {
        path: '.kodax-a2a-staging/report.html', content: '<p>A2A report</p>',
      } }] : [],
    };
  }
}

const roots: string[] = [];
afterEach(async () => {
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function request(method: string, params: Record<string, unknown>): Request {
  return new Request('http://127.0.0.1:1/a2a', { method: 'POST', headers: {
    'content-type': 'application/json', 'a2a-version': '1.0', authorization: 'Bearer test',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }) });
}

it.each(['runtime-default', 'local-agent'] as const)('returns actual written bytes through prepared %s execution and retained tasks', async (kind) => {
  const root = mkdtempSync(path.join(tmpdir(), 'kodax-a2a-file-output-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  const agentDir = path.join(root, '.kodax', 'agents');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(root, '.kodax', 'config.json'), JSON.stringify({ permissionMode: 'full-access' }));
  writeFileSync(path.join(agentDir, 'reporter.md'), '---\nname: reporter\ndescription: Write reports\ntools: [write]\nskills: []\n---\nCreate the requested report.');
  vi.stubEnv('KODAX_A2A_FILE_TEST_KEY', 'test');
  registerModelProvider(providerName, () => new FileOutputProvider());
  FileOutputProvider.calls = 0;
  const runtime = await createKodaXRuntime({ mode: 'embedded', isolation: 'inline', homeDir: root,
    defaultProvider: providerName, defaultModel: 'test', permissionTimeoutMs: 1_000,
  });
  const options: A2AServerOptions = {
    runtime, dataDir: path.join(root, 'a2a'),
    agent: { name: 'Report', description: 'Report', version: 'test', publicBaseUrl: 'http://127.0.0.1:1',
      skills: [], inputModes: ['text/plain'], outputModes: ['text/plain', 'text/html'], projectPath: workspace },
    execution: { ...(kind === 'local-agent' ? { kind, agentRef: { source: 'markdown:user' as const, name: 'reporter' } } : { kind }),
      workspace: { mode: 'fixed', root: workspace }, toolPolicy: {
        workspace: 'write', process: 'deny', network: { mode: 'deny' }, tools: [], mcp: {}, skillScripts: {}, subagents: 'deny',
      } },
    limits: { maxRequestBytes: 64 * 1024, maxPartBytes: 32 * 1024, maxConcurrentTasks: 2, maxTasksPerPrincipal: 4, maxTaskWaitMs: 10_000 },
    authentication: { securityRealm: 'test', securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      async authenticate(req) { return req.headers.get('authorization') === 'Bearer test' ? { subject: 'test', scopes: [] } : null; } },
    async authorize() { return true; },
  };
  let server: Awaited<ReturnType<typeof prepareKodaXA2AServer>> | undefined;
  try {
    server = await prepareKodaXA2AServer(options);
    const response = await server.handle(request('SendMessage', {
      message: { messageId: 'report', role: 'ROLE_USER', parts: [{ text: 'Create an HTML report in .kodax-a2a-staging/report.html.' }] },
    }));
    const body = await response.json() as { result: { task: A2ATask } };
    expect(body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
    const file = body.result.task.artifacts?.flatMap((artifact) => artifact.parts).find((part) => part.raw !== undefined);
    expect(file).toMatchObject({ filename: 'report.html', mediaType: 'text/html', raw: Buffer.from('<p>A2A report</p>').toString('base64') });
    expect(Buffer.from(file!.raw!, 'base64')).toEqual(readFileSync(path.join(workspace, '.kodax-a2a-staging/report.html')));
    await server.close();
    server = await prepareKodaXA2AServer(options);
    const restored = await server.handle(request('GetTask', { id: body.result.task.id }));
    expect((await restored.json() as { result: A2ATask }).result.artifacts).toEqual(body.result.task.artifacts);
  } finally {
    await server?.close();
    await runtime.close();
  }
});
