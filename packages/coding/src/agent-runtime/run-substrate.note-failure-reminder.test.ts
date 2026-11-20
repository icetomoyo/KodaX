import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../memory/note-reflection-job.js', () => ({ scheduleNoteRunFinish: vi.fn(async () => undefined) }));

import { createNoteStore, setAgentConfigHome } from '@kodax-ai/agent';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';
import type {
  KodaXEphemeralSuffix,
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXReasoningRequest,
  KodaXStreamResult,
  KodaXToolDefinition,
} from '@kodax-ai/llm';

import { resolveNotePlace } from '../memory/note-memory.js';
import { staticText } from '../prompts/static-text.js';
import type { KodaXOptions } from '../types.js';
import { runSubstrate } from './run-substrate.js';

const PROVIDER_NAME = 'note-failure-reminder-test';
const API_KEY_ENV = 'NOTE_FAILURE_REMINDER_TEST_API_KEY';
const REMINDER = staticText('note-memory.failure-reminder');

/** First turn reads `readPath`; every later turn answers without tools. */
class ReadThenAnswerProvider extends KodaXBaseProvider {
  static readPath = '';
  static suffixes: Array<KodaXEphemeralSuffix | undefined> = [];

  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: API_KEY_ENV,
    model: 'note-failure-reminder-model',
    supportsThinking: false,
    contextWindow: 1_000_000,
    maxOutputTokens: 1_000,
  };

  override supportsEphemeralSuffix(): boolean {
    return true;
  }

  async stream(
    _messages: KodaXMessage[],
    _tools: KodaXToolDefinition[],
    _systemPrompt: string,
    _reasoning?: boolean | KodaXReasoningRequest,
    options?: KodaXProviderStreamOptions,
  ): Promise<KodaXStreamResult> {
    ReadThenAnswerProvider.suffixes.push(options?.ephemeralSuffix);
    if (ReadThenAnswerProvider.suffixes.length === 1) {
      return {
        textBlocks: [],
        thinkingBlocks: [],
        toolBlocks: [{ type: 'tool_use', id: 'read-1', name: 'read', input: { path: ReadThenAnswerProvider.readPath } }],
      };
    }
    return { textBlocks: [{ type: 'text', text: 'done' }], thinkingBlocks: [], toolBlocks: [] };
  }
}

describe('runSubstrate note failure reminder', { timeout: 30_000 }, () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'note-failure-reminder-'));
    setAgentConfigHome(home);
    process.env[API_KEY_ENV] = 'test-key';
    ReadThenAnswerProvider.suffixes = [];
    ReadThenAnswerProvider.readPath = path.join(home, 'missing.txt');
    registerModelProvider(PROVIDER_NAME, () => new ReadThenAnswerProvider());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setAgentConfigHome(undefined);
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const options = (context: Record<string, unknown> = {}): KodaXOptions => ({
    provider: PROVIDER_NAME,
    model: 'note-failure-reminder-model',
    maxIter: 3,
    reasoningMode: 'off',
    context: { systemPromptOverride: 'NOTE FAILURE REMINDER TEST', executionCwd: home, ...context },
  });

  const saveNote = async (): Promise<void> => {
    const store = createNoteStore(resolveNotePlace(options()).roots.project, 'project');
    const saved = await store.write({ id: 'node-path', type: 'project', description: 'Node comes from fnm', body: 'b' });
    expect(saved.ok).toBe(true);
  };

  it('reminds the request after a failed tool call when the index lists a note', async () => {
    vi.stubEnv('KODAX_MEMORY_NOTES', '1');
    await saveNote();
    await runSubstrate(options(), 'run the tests');
    expect(ReadThenAnswerProvider.suffixes).toHaveLength(2);
    expect(ReadThenAnswerProvider.suffixes[0]).toBeUndefined();
    expect(ReadThenAnswerProvider.suffixes[1]?.content).toBe(REMINDER);
  });

  it('stays silent after a tool call that succeeded', async () => {
    vi.stubEnv('KODAX_MEMORY_NOTES', '1');
    await saveNote();
    fs.writeFileSync(ReadThenAnswerProvider.readPath, 'hello\n');
    await runSubstrate(options(), 'run the tests');
    expect(ReadThenAnswerProvider.suffixes.map((suffix) => suffix?.content)).toEqual([undefined, undefined]);
  });

  it('stays silent while the index lists no note', async () => {
    vi.stubEnv('KODAX_MEMORY_NOTES', '1');
    await runSubstrate(options(), 'run the tests');
    expect(ReadThenAnswerProvider.suffixes.map((suffix) => suffix?.content)).toEqual([undefined, undefined]);
  });

  it('stays silent in a child agent, which holds no notes of its own', async () => {
    vi.stubEnv('KODAX_MEMORY_NOTES', '1');
    await saveNote();
    await runSubstrate(options({ parentAgentId: 'parent-1', currentAgentId: 'child-1' }), 'run the tests');
    expect(ReadThenAnswerProvider.suffixes.some((suffix) => suffix?.content === REMINDER)).toBe(false);
  });

  it('leaves the legacy memory path alone when the note memory is off', async () => {
    vi.stubEnv('KODAX_MEMORY_NOTES', '0');
    await runSubstrate(options(), 'run the tests');
    expect(ReadThenAnswerProvider.suffixes.some((suffix) => suffix?.content === REMINDER)).toBe(false);
  });
});
