import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { setAgentConfigHome } from '@kodax-ai/agent';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { startKodaX, runManagedTask } from '../index.js';
import type { KodaXOptions } from '../types.js';

it.each(['sa', 'ama'] as const)('%s resumes an accepted input after tool output without duplicating its query', async (agentMode) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-input-identity-'));
  const requests: KodaXMessage[][] = [];
  class IdentityProvider extends KodaXBaseProvider {
    readonly name = 'input-identity-test';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_INPUT_IDENTITY_TEST_KEY', model: 'input-identity-test', supportsThinking: false,
    };
    async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
      requests.push(structuredClone(messages));
      return { textBlocks: [{ type: 'text', text: 'Completed the accepted request.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  registerModelProvider('input-identity-test', () => new IdentityProvider());
  setAgentConfigHome(directory);
  vi.stubEnv('KODAX_HOME', directory);
  vi.stubEnv('KODAX_INPUT_IDENTITY_TEST_KEY', 'test-only');
  const prompt = '/review-existing-input';
  const accepted: KodaXMessage = { role: 'user', content: prompt, inputId: 'accepted-input', timestamp: 123 };
  const toolCall: KodaXMessage = { role: 'assistant', content: [{ type: 'tool_use', id: 'command-tool', name: 'read', input: { path: 'evidence.txt' } }] };
  const toolResult: KodaXMessage = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'command-tool', content: 'Prior command evidence' }] };
  try {
    const execute = async (inputId: string, initialMessages: KodaXMessage[]) => {
      const options: KodaXOptions = {
        provider: 'input-identity-test', agentMode, reasoningMode: 'off', maxIter: 1, lsp: false,
        context: { configHome: directory, executionCwd: directory, gitRoot: directory, skillsPrompt: '', repoIntelligenceMode: 'off' },
        session: { id: `identity-${agentMode}`, inputId, initialMessages },
      };
      return agentMode === 'sa' ? startKodaX(options, prompt).result : runManagedTask(options, prompt);
    };
    await execute('accepted-input', [accepted, toolCall, toolResult]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]!.filter(message => message.role === 'user' && message.content === prompt)).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain('Prior command evidence');
    const assistantIndex = requests[0]!.findIndex(message => message.role === 'assistant' && JSON.stringify(message.content).includes('command-tool'));
    expect(assistantIndex).toBeGreaterThan(0);
    expect(JSON.stringify(requests[0]![assistantIndex + 1])).toContain('Prior command evidence');
    requests.length = 0;
    await execute('different-input', [accepted]);
    expect(requests[0]!.filter(message => message.role === 'user' && message.content === prompt)).toHaveLength(2);
  } finally {
    clearRuntimeModelProviders(); setAgentConfigHome(undefined); vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
