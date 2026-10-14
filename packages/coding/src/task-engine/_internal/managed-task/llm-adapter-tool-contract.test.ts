import { afterEach, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXToolDefinition, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { getToolDefinition } from '../../../tools/registry.js';
import { buildRunnerLlmAdapter } from './llm-adapter.js';

afterEach(() => { clearRuntimeModelProviders(); vi.unstubAllEnvs(); });

it.each([false, true])('projects legacy todo at the final managed boundary while preserving caller constraints (custom=%s)', async (custom) => {
  const registered = getToolDefinition('todo_update');
  if (!registered) throw new Error('Missing todo_update');
  const original = custom ? {
    ...registered,
    input_schema: {
      ...registered.input_schema,
      properties: { ...registered.input_schema.properties, label: { type: 'string' }, forbidden: false },
      required: ['op', 'items', 'status'],
    },
  } : registered;
  const before = structuredClone(original.input_schema);
  let sent: KodaXToolDefinition[] = [];
  class CaptureProvider extends KodaXBaseProvider {
    readonly name = 'todo-contract';
    readonly supportsThinking = false;
    protected readonly config = {
      apiKeyEnv: 'KODAX_TODO_CONTRACT_TEST_KEY', model: 'scripted', supportsThinking: false,
      reasoningCapability: 'prompt-only' as const, maxOutputTokens: 32000,
    };
    async stream(_messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
      sent = tools;
      return { textBlocks: [{ type: 'text', text: 'done' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
    }
  }
  vi.stubEnv('KODAX_TODO_CONTRACT_TEST_KEY', 'local-test-key');
  registerModelProvider('todo-contract', () => new CaptureProvider());
  const adapter = buildRunnerLlmAdapter({ provider: 'todo-contract',
    context: { gitRoot: tmpdir(), executionCwd: tmpdir(), repoIntelligenceMode: 'off' } });
  await adapter([{ role: 'user', content: 'Continue the current plan.' }], {
    name: 'kodax/role/worker', instructions: '',
    tools: [{ ...original, execute: async () => ({ content: 'unused' }) }],
  });
  const todo = sent.find((tool) => tool.name === 'todo_update');
  expect(todo?.input_schema.required).toEqual(custom ? ['status', 'id'] : ['id']);
  expect(todo?.input_schema.properties).not.toHaveProperty('op');
  expect(todo?.input_schema.properties).not.toHaveProperty('items');
  expect(original.input_schema).toEqual(before);
  if (custom) {
    expect(todo?.input_schema.properties.label).toEqual({ type: 'string' });
    expect(todo?.input_schema.properties.forbidden).toBe(false);
  }
});
