import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../memory/note-reflection-job.js', () => ({ scheduleNoteRunFinish: vi.fn(async () => undefined) }));

import { setAgentConfigHome } from '@kodax-ai/agent';
import {
  clearRuntimeModelProviders,
  KodaXBaseProvider,
  registerModelProvider,
} from '@kodax-ai/llm';
import type { KodaXMessage, KodaXProviderConfig, KodaXStreamResult } from '@kodax-ai/llm';

import type { NotePlace } from '../memory/note-memory.js';
import { scheduleNoteRunFinish } from '../memory/note-reflection-job.js';
import type { KodaXOptions } from '../types.js';
import { runSubstrate } from './run-substrate.js';

const PROVIDER_NAME = 'note-follow-up-runtime-test';
const API_KEY_ENV = 'NOTE_FOLLOW_UP_RUNTIME_TEST_API_KEY';
const scheduled = scheduleNoteRunFinish as unknown as ReturnType<typeof vi.fn>;

class AnswerProvider extends KodaXBaseProvider {
  readonly name = PROVIDER_NAME;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: API_KEY_ENV,
    model: 'note-follow-up-model',
    supportsThinking: false,
    contextWindow: 1_000_000,
    maxOutputTokens: 1_000,
  };

  async stream(): Promise<KodaXStreamResult> {
    return { textBlocks: [{ type: 'text', text: 'all done' }], thinkingBlocks: [], toolBlocks: [] };
  }
}

describe('runSubstrate note memory follow-up', { timeout: 30_000 }, () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'note-follow-up-'));
    setAgentConfigHome(home);
    process.env[API_KEY_ENV] = 'test-key';
    scheduled.mockClear();
    registerModelProvider(PROVIDER_NAME, () => new AnswerProvider());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setAgentConfigHome(undefined);
    delete process.env[API_KEY_ENV];
    clearRuntimeModelProviders();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const run = (context: Record<string, unknown> = {}, extra: Partial<KodaXOptions> = {}) => runSubstrate({
    provider: PROVIDER_NAME,
    model: 'note-follow-up-model',
    maxIter: 2,
    reasoningMode: 'off',
    context: { systemPromptOverride: 'NOTE FOLLOW-UP TEST', executionCwd: home, ...context },
    ...extra,
  }, 'please remember that tests run with make check-fast');

  type Call = { sessionId: string; place: NotePlace; reflect: boolean; messages: KodaXMessage[]; earlierCalls: ReadonlySet<string>; model?: string };

  it('hands the finished session to the note follow-up when the note memory is on', async () => {
    vi.stubEnv('KODAX_MEMORY_NOTES', '1');
    const result = await run();
    expect(scheduled).toHaveBeenCalledTimes(1);
    const call = scheduled.mock.calls[0]![0] as Call;
    expect(call.sessionId).toBe(result.sessionId);
    expect(call.place.cwd).toBe(home);
    expect(call.reflect).toBe(true);
    expect(call.model).toBe('note-follow-up-model');
    expect(call.earlierCalls.size).toBe(0);
    expect(JSON.stringify(call.messages)).toContain('make check-fast');
  });

  it('only counts reads when the host supplied its own learning reviewer', async () => {
    vi.stubEnv('KODAX_MEMORY_NOTES', '1');
    await run({}, { learningReviewer: async () => ({ memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard', reasonCodes: ['offline'] } }) });
    expect((scheduled.mock.calls[0]![0] as Call).reflect).toBe(false);
  });

  it('does nothing when the note memory is off', async () => {
    await run();
    expect(scheduled).not.toHaveBeenCalled();
  });

  it('does nothing for a child agent, whose notes belong to its parent run', async () => {
    vi.stubEnv('KODAX_MEMORY_NOTES', '1');
    await run({ parentAgentId: 'parent-1', currentAgentId: 'child-1' });
    expect(scheduled).not.toHaveBeenCalled();
  });
});
