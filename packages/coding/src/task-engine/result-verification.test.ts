import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider,
  clearRuntimeModelProviders,
  registerModelProvider,
  createCustomProvider,
  type KodaXMessage,
  type KodaXProviderConfig,
  type KodaXProviderStreamOptions,
  type KodaXStreamResult,
  type KodaXToolDefinition,
} from '@kodax-ai/llm';
import { runManagedTaskViaRunner } from './runner-driven.js';
import { runKodaX } from '../agent.js';
import { KodaXExtensionRuntime, setActiveExtensionRuntime } from '../extensions/runtime.js';

const requests: string[] = [];
const directories: string[] = [];

class ResultProvider extends KodaXBaseProvider {
  readonly name = 'result-verification-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_RESULT_VERIFICATION_TEST_KEY',
    model: 'result-test',
    supportsThinking: false,
  };

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _system: string,
    _thinking: boolean,
    options?: KodaXProviderStreamOptions,
  ): Promise<KodaXStreamResult> {
    requests.push(options?.forcedToolName ?? 'primary');
    return {
      textBlocks: [{ type: 'text', text: 'Current evidence is recorded.' }],
      thinkingBlocks: [],
      toolBlocks: options?.forcedToolName ? [{
        type: 'tool_use', id: 'legacy-judge', name: options.forcedToolName,
        input: { verdict: 'accept', reason: 'legacy verdict' },
      }] : [],
      stopReason: 'end_turn',
    };
  }
}

afterEach(async () => {
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  requests.length = 0;
  await Promise.all(directories.splice(0).map(directory => rm(directory, {
    recursive: true, force: true, maxRetries: 3, retryDelay: 100,
  })));
});

describe('managed result verification', () => {
  it.each([undefined, 'intersect'] as const)('keeps an explicit SA System prompt exact and sends profile requirements as request-only context (%s)', async workModePolicy => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-profile-review-'));
    directories.push(directory);
    const provider = new ResultProvider();
    const stream = vi.spyOn(provider, 'stream');
    registerModelProvider('result-verification-test', () => provider);
    vi.stubEnv('KODAX_RESULT_VERIFICATION_TEST_KEY', 'test-only');
    const result = await runKodaX({ provider: 'result-verification-test', reasoningMode: 'off', workMode: 'agent',
      context: { executionCwd: directory, gitRoot: directory, repoIntelligenceMode: 'off',
        workModePolicy, toolVisibilityPolicy: ({ name }) => !['bash', 'write', 'edit', 'spawn_agent'].includes(name),
        systemPromptOverride: 'EXACT_PROFILE_SYSTEM', agentProfile: { verification: {
          requiredChecks: ['Inspect the current rendered chart.'],
        } }, taskVerification: { summary: 'Compare current results with the brief.' },
      },
    }, 'Review the current chart.');
    const request = stream.mock.calls.find(call => call[2] === 'EXACT_PROFILE_SYSTEM');
    expect(request).toBeDefined();
    expect(JSON.stringify(request![0])).toContain('Inspect the current rendered chart.');
    expect(JSON.stringify(request![0])).toContain('Compare current results with the brief.');
    expect(result.messages.some(message => message._source === 'managed-run-context')).toBe(false);
  });
  it('sends actual current image evidence through the production provider wire after each read', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-visual-wire-'));
    directories.push(directory);
    vi.stubEnv('KODAX_VISUAL_WIRE_KEY', 'test-only');
    const imagePath = path.join(directory, 'result.png');
    const first = await readFile('tests/fixtures/images/valid-png.png');
    const repaired = await readFile('tests/fixtures/images/alpha.png');
    await writeFile(imagePath, first);
    const provider = createCustomProvider({ name: 'visual-wire-test', protocol: 'openai', model: 'vision',
      baseUrl: 'https://provider.invalid', apiKeyEnv: 'KODAX_VISUAL_WIRE_KEY', imageInput: true });
    const wireRequests: string[] = [];
    let turn = 0;
    const create = vi.fn(async (request: { messages: unknown[] }) => {
      wireRequests.push(JSON.stringify(request.messages));
      const current = ++turn;
      if (current === 2) await writeFile(imagePath, repaired);
      return (async function* () {
        yield { choices: [{ delta: current <= 2 ? {
          tool_calls: [{ index: 0, id: `capture-${current}`, type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ path: imagePath }) } }],
        } : { content: 'The revised visual evidence was inspected.' }, finish_reason: current <= 2 ? 'tool_calls' : 'stop' }] };
      })();
    });
    Reflect.set(provider, '_client', { chat: { completions: { create } } });
    registerModelProvider('visual-wire-test', () => provider);
    const result = await runManagedTaskViaRunner({ provider: 'visual-wire-test', reasoningMode: 'off',
      context: { executionCwd: directory, gitRoot: directory,
        managedTaskWorkspaceDir: directory, repoIntelligenceMode: 'off' },
    }, 'Review the actual image, then check the revised result.');
    expect(result.success).toBe(true);
    expect(wireRequests).toHaveLength(3);
    expect(wireRequests[1]).toContain(first.toString('base64'));
    expect(wireRequests[2]).toContain(repaired.toString('base64'));
    expect(result.managedTask?.runtime).not.toHaveProperty('scorecard');
    expect(result.managedTask?.runtime).not.toHaveProperty('completionContractStatus');
    expect(result.managedProtocolPayload).toBeUndefined();
  });
  it('offers budget extension at the normal tool boundary without a verifier revision', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-result-budget-'));
    directories.push(directory);
    const askUser = vi.fn(async () => 'continue');
    let calls = 0;
    const result = await runManagedTaskViaRunner({
      provider: 'anthropic',
      events: { askUser },
      context: { executionCwd: directory, gitRoot: directory,
        managedTaskWorkspaceDir: directory, repoIntelligenceMode: 'off' },
    }, 'Check the result.', async () => ++calls === 1 ? {
      textBlocks: [], toolBlocks: Array.from({ length: 180 }, (_, i) => ({
        type: 'tool_use' as const, id: `budget-${i}`, name: 'todo_list', input: {},
      })),
    } : { textBlocks: [{ type: 'text', text: 'Checks finished.' }], toolBlocks: [] });
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(400);
  });
  it('finishes through the worker without a second completion judge or an unfinished managed verdict', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-result-verification-'));
    directories.push(directory);
    registerModelProvider('result-verification-test', () => new ResultProvider());
    vi.stubEnv('KODAX_RESULT_VERIFICATION_TEST_KEY', 'test-only');
    const result = await runManagedTaskViaRunner({
      provider: 'result-verification-test',
      context: {
        executionCwd: directory,
        gitRoot: directory,
        managedTaskWorkspaceDir: directory,
        repoIntelligenceMode: 'off',
      },
    }, 'Review the visible result against the request.', async () => ({
      textBlocks: [{ type: 'text', text: 'The requested review is complete.' }],
      toolBlocks: [],
    }));

    expect(requests).not.toContain('emit_sidecar_verdict');
    expect(result.success).toBe(true);
    expect(result.managedTask?.verdict.status).toBe('completed');
  });

  it('preserves an extension stop as a blocked result after retiring the completion judge', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-result-stop-'));
    directories.push(directory);
    const extension = new KodaXExtensionRuntime();
    extension.registerHook('turn:complete', () => ({ abort: true, reason: 'Required check is unavailable.' }));
    setActiveExtensionRuntime(extension);
    try {
      const result = await runManagedTaskViaRunner({
        provider: 'anthropic',
        session: { id: 'result-stop' },
        context: {
          executionCwd: directory, gitRoot: directory,
          managedTaskWorkspaceDir: directory, repoIntelligenceMode: 'off',
        },
      }, 'Check the result.', async () => ({
        textBlocks: [{ type: 'text', text: 'Candidate result.' }], toolBlocks: [],
      }));
      expect(result.success).toBe(false);
      expect(result.signal).toBe('BLOCKED');
      expect(result.signalReason).toBe('Required check is unavailable.');
    } finally {
      setActiveExtensionRuntime(null);
      await extension.dispose();
    }
  });
});
