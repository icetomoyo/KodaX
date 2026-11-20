import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Runner, setAgentConfigHome } from '@kodax-ai/agent';
import {
  KodaXBaseProvider, KodaXProviderError, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXProviderStreamOptions, type KodaXStreamResult,
} from '@kodax-ai/llm';
import {
  KodaXClient, createDefaultCodingAgent, createKodaXTaskRunner, runKodaX, runManagedTask, startKodaX,
} from '../index.js';
import type { KodaXOptions, KodaXResult } from '../types.js';

// Expected outcomes of a root Run settle as a result on every public entry, so
// callers keep the session and history. Hosts that classify failures call
// runManagedTask, which still throws.

const PROVIDER = 'root-failure-contract-test';
const CREDENTIAL = 'root-failure-credential-value';
const REASON = 'model "missing-model" does not exist';
let directory = '';
let requests: KodaXMessage[][] = [];
let reply: (call: number, signal?: AbortSignal) => Promise<KodaXStreamResult>;

class ContractProvider extends KodaXBaseProvider {
  readonly name = PROVIDER;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_ROOT_FAILURE_CONTRACT_KEY', model: PROVIDER, supportsThinking: false,
  };
  async stream(
    messages: KodaXMessage[], _tools: unknown, _system: unknown, _reasoning: unknown,
    _options?: KodaXProviderStreamOptions, signal?: AbortSignal,
  ): Promise<KodaXStreamResult> {
    requests.push(structuredClone(messages));
    return reply(requests.length, signal);
  }
}

const rejected = async (): Promise<KodaXStreamResult> => {
  throw new KodaXProviderError(`404 ${REASON} (key ${CREDENTIAL})`, PROVIDER,
    { stage: 'transport', httpStatus: 404, retryable: false, upstreamCode: 'model_not_found' });
};
const answered = async (): Promise<KodaXStreamResult> => ({
  textBlocks: [{ type: 'text', text: 'done' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
});
const waitForAbort = (_call: number, signal?: AbortSignal): Promise<KodaXStreamResult> =>
  new Promise((_resolve, reject) => {
    const abort = () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); };
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
  });

function baseOptions(overrides: Partial<KodaXOptions> = {}): KodaXOptions {
  return {
    provider: PROVIDER, reasoningMode: 'off', lsp: false,
    context: { configHome: directory, executionCwd: directory, gitRoot: directory, skillsPrompt: '', repoIntelligenceMode: 'off' },
    ...overrides,
  };
}

function expectSettledProviderFailure(result: KodaXResult): void {
  expect(result.success).toBe(false);
  expect(result.sessionId).toEqual(expect.any(String));
  expect(result.sessionId).not.toBe('');
  expect(result.failure).toMatchObject({
    source: 'provider', safeMessage: 'Configured Provider resource was not found.', httpStatus: 404,
    upstreamCode: 'model_not_found', detail: expect.stringContaining(REASON),
  });
  expect(result.errorMetadata?.lastError).toContain(REASON);
  expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-root-failure-contract-'));
  requests = [];
  reply = rejected;
  registerModelProvider(PROVIDER, () => new ContractProvider());
  setAgentConfigHome(directory);
  vi.stubEnv('KODAX_HOME', directory);
  vi.stubEnv('KODAX_ROOT_FAILURE_CONTRACT_KEY', CREDENTIAL);
});

afterEach(async () => {
  clearRuntimeModelProviders(); setAgentConfigHome(undefined); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('root Run failure contract', { timeout: 60_000 }, () => {
  it('runKodaX resolves a final Provider failure with the real cause and the session', async () => {
    expectSettledProviderFailure(await runKodaX(baseOptions(), 'Use the missing model.'));
  });

  it('runManagedTask keeps throwing for Hosts that classify the error', async () => {
    await expect(runManagedTask(baseOptions(), 'Use the missing model.')).rejects.toThrow(REASON);
  });

  it('KodaXClient continues the same session after a failed first turn', async () => {
    const client = new KodaXClient(baseOptions());
    const failed = await client.send('First question.');
    expectSettledProviderFailure(failed);
    expect(client.getSessionId()).toBe(failed.sessionId);
    reply = answered;
    const retried = await client.send('First question, again.');
    expect(retried.success).toBe(true);
    expect(retried.sessionId).toBe(failed.sessionId);
  });

  it('startKodaX resolves a stop as interrupted with the handle session', async () => {
    reply = waitForAbort;
    const handle = startKodaX(baseOptions(), 'Work until stopped.');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    handle.abort();
    const result = await handle.result;
    expect(result).toMatchObject({ success: true, interrupted: true, sessionId: handle.id });
    expect(result.failure).toBeUndefined();
  });

  it('startKodaX resolves a final Provider failure', async () => {
    expectSettledProviderFailure(await startKodaX(baseOptions(), 'Use the missing model.').result);
  });

  it('the default coding preset resolves a final Provider failure', async () => {
    const run = await Runner.run<KodaXResult>(createDefaultCodingAgent(), 'Use the missing model.',
      { presetOptions: baseOptions() });
    expectSettledProviderFailure(run.data as KodaXResult);
  });

  it('the task runner reports the real cause as the worker error', async () => {
    const runner = createKodaXTaskRunner({ baseOptions: baseOptions() });
    const outcome = await runner({ id: 'task-1', title: 'Task', description: 'Use the missing model.' }, {
      runId: 'run-1', workspaceDir: directory, taskDir: directory, dependencyResults: [],
      emit: async () => undefined,
    } as unknown as Parameters<typeof runner>[1]);
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain(REASON);
    expect(outcome.error).not.toContain(CREDENTIAL);
  });

  it('invalid input still throws', async () => {
    await expect(runKodaX(baseOptions({
      context: { ...baseOptions().context, prompt: { kodaxGuidance: 'drop' } as never },
    }), 'Hello.')).rejects.toThrow(/kodaxGuidance/);
  });
});
