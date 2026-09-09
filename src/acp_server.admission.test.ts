import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { PromptResponse } from '@agentclientprotocol/sdk';
import type { KodaXProductClient } from '@kodax-ai/coding/client-contract';
import { KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderStreamOptions, type KodaXReasoningRequest,
  type KodaXStreamResult, type KodaXToolDefinition } from '@kodax-ai/llm';
import { createKodaXRuntime } from './sdk-runtime.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';

const launcher = vi.hoisted(() => ({ ensure: vi.fn<() => Promise<KodaXProductClient>>() }));
vi.mock('./sdk-client.js', () => ({ ensureKodaXClient: launcher.ensure }));
import { KodaXAcpServer } from './acp_server.js';

class HoldingProvider extends KodaXBaseProvider {
  readonly name = 'acp-admission';
  readonly supportsThinking = false;
  protected readonly config = { apiKeyEnv: 'KODAX_ACP_ADMISSION_KEY', model: 'fixture', supportsThinking: false };
  async stream(_messages: KodaXMessage[], _tools: KodaXToolDefinition[], _system: string,
    _reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions): Promise<KodaXStreamResult> {
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); clearRuntimeModelProviders(); launcher.ensure.mockReset(); });

it('leaves an omitted ACP homeDir to the shared launcher resolver', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-acp-home-'));
  const runtime = await createKodaXRuntime({ homeDir });
  launcher.ensure.mockResolvedValue(toKodaXProductClient(runtime));
  vi.stubEnv('KODAX_HOME', path.join(homeDir, 'custom-config-home'));
  const server = new KodaXAcpServer({ logLevel: 'off' });
  try {
    expect(launcher.ensure).toHaveBeenCalledWith(expect.objectContaining({ homeDir: undefined }));
  } finally {
    await server.dispose();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

it.each(['session', 'settings', 'observe', 'submit'] as const)('honors cancellation while %s admission is awaiting its Client reply', async stage => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-acp-cancel-'));
  vi.stubEnv('KODAX_ACP_ADMISSION_KEY', 'fixture-key');
  registerModelProvider('acp-admission', () => new HoldingProvider());
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'acp-admission' });
  const client = toKodaXProductClient(runtime);
  launcher.ensure.mockResolvedValue(client);
  let release: () => void = () => {};
  let reached = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const wait = async () => { reached = true; await gate; };
  if (stage === 'session') {
    const original = client.sessions.create.bind(client.sessions);
    vi.spyOn(client.sessions, 'create').mockImplementation(async input => { const result = await original(input); await wait(); return result; });
  } else if (stage === 'settings') {
    const original = client.sessions.updateSettings.bind(client.sessions);
    vi.spyOn(client.sessions, 'updateSettings').mockImplementation(async (id, patch) => { const result = await original(id, patch); if (patch.provider) await wait(); return result; });
  } else if (stage === 'observe') {
    const original = client.sessions.observe.bind(client.sessions);
    vi.spyOn(client.sessions, 'observe').mockImplementation(async (id, listener) => { const result = await original(id, listener); await wait(); return result; });
  } else {
    const original = client.inputs.submit.bind(client.inputs);
    vi.spyOn(client.inputs, 'submit').mockImplementation(async input => { const result = await original(input); await wait(); return result; });
  }
  const server = new KodaXAcpServer({ homeDir, provider: 'acp-admission', permissionMode: 'full-access', logLevel: 'off' });
  const session = await server.newSession({ cwd: homeDir, mcpServers: [] });
  let response: PromptResponse | undefined;
  const prompt = server.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Wait for cancellation' }] })
    .then(result => { response = result; });
  try {
    await expect.poll(() => reached).toBe(true);
    await server.cancel({ sessionId: session.sessionId });
    release();
    await expect.poll(() => response, { timeout: 2_000 }).toMatchObject({ stopReason: 'cancelled' });
    const runs = await runtime.runs.list({ sessionId: session.sessionId });
    if (stage === 'submit') expect(runs.every(run => ['cancelled', 'interrupted'].includes(run.phase))).toBe(true);
    else expect(runs).toHaveLength(0);
  } finally {
    release();
    for (const run of await runtime.runs.list({ sessionId: session.sessionId })) await runtime.runs.abort(run.runId);
    await prompt;
    await server.dispose();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 30_000);
