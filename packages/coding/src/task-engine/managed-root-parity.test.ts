import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setAgentConfigHome, type KodaXSessionData, type KodaXSessionStorage } from '@kodax-ai/agent';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { runManagedTask, startKodaX } from '../index.js';
import type { KodaXOptions } from '../types.js';

// Managed root Runs must honor the root-run contract the direct engine had:
// an explicit maxIter bound with limitReached, and session.autoResume.

const PROVIDER = 'managed-root-parity-test';
let directory = '';
let requests: KodaXMessage[][] = [];
let reply: (call: number) => KodaXStreamResult;

class ParityProvider extends KodaXBaseProvider {
  readonly name = PROVIDER;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_MANAGED_ROOT_PARITY_KEY', model: PROVIDER, supportsThinking: false,
  };
  async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    requests.push(structuredClone(messages));
    return reply(requests.length);
  }
}

const toolTurn = (call: number): KodaXStreamResult => ({
  textBlocks: [{ type: 'text', text: `step ${call}` }],
  thinkingBlocks: [],
  toolBlocks: [{ type: 'tool_use', id: `read-${call}`, name: 'read', input: { path: 'evidence.txt' } }],
  stopReason: 'tool_use',
});

function baseOptions(overrides: Partial<KodaXOptions> = {}): KodaXOptions {
  return {
    provider: PROVIDER, reasoningMode: 'off', lsp: false,
    context: { configHome: directory, executionCwd: directory, gitRoot: directory, skillsPrompt: '', repoIntelligenceMode: 'off' },
    ...overrides,
  };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-managed-root-parity-'));
  await writeFile(path.join(directory, 'evidence.txt'), 'evidence\n');
  requests = [];
  reply = toolTurn;
  registerModelProvider(PROVIDER, () => new ParityProvider());
  setAgentConfigHome(directory);
  vi.stubEnv('KODAX_HOME', directory);
  vi.stubEnv('KODAX_MANAGED_ROOT_PARITY_KEY', 'test-only');
});

afterEach(async () => {
  clearRuntimeModelProviders(); setAgentConfigHome(undefined); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it.each(['direct', 'managed'] as const)('%s root stops at an explicit maxIter with limitReached', async (engine) => {
  const options = baseOptions({ maxIter: 2 });
  const result = engine === 'direct'
    ? await startKodaX(options, 'Keep reading evidence.').result
    : await runManagedTask(options, 'Keep reading evidence.');
  expect(requests).toHaveLength(2);
  expect(result.success).toBe(true);
  expect(result.limitReached).toBe(true);
  expect(result.lastText).toContain('step 2');
}, 60_000);

it('managed root without maxIter is not reported as limit-bound', async () => {
  reply = call => call < 3 ? toolTurn(call) : {
    textBlocks: [{ type: 'text', text: 'done' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
  };
  const result = await runManagedTask(baseOptions(), 'Read evidence, then finish.');
  expect(requests).toHaveLength(3);
  expect(result.success).toBe(true);
  expect(result.limitReached).not.toBe(true);
}, 60_000);

it('managed root autoResume continues the most recent persisted session', async () => {
  const saved = new Map<string, KodaXSessionData>([['prior-session', {
    messages: [
      { role: 'user', content: 'Remember the codeword lantern.' },
      { role: 'assistant', content: 'Noted: lantern.' },
    ],
    title: 'prior', gitRoot: directory,
  }]]);
  const storage: KodaXSessionStorage = {
    async save(id, data) { saved.set(id, data); },
    async load(id) { return saved.get(id) ?? null; },
    async list() { return [{ id: 'prior-session', title: 'prior', msgCount: 2 }]; },
  };
  reply = () => ({ textBlocks: [{ type: 'text', text: 'lantern' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' });
  const result = await runManagedTask(baseOptions({ session: { storage, autoResume: true } }), 'What was the codeword?');
  expect(result.sessionId).toBe('prior-session');
  expect(JSON.stringify(requests[0])).toContain('Remember the codeword lantern.');
}, 60_000);
