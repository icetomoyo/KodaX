import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, type KodaXStreamResult } from '@kodax-ai/llm';
import { LEARNING_REVIEW_TOOL, awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import type { ClientSessionView, ClientViewItem } from '@kodax-ai/coding/client-contract';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';

it('records a provider failure as a retained error item after its input, without the CLI continue prompt', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-run-failure-view-'));
  let rejectKey = true;
  class Provider extends KodaXBaseProvider {
    readonly name = 'failure-view'; readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_FAILURE_VIEW_KEY', model: 'fixture', supportsThinking: false };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      if (rejectKey && !args[1].some(tool => tool.name === LEARNING_REVIEW_TOOL.name)) {
        // Through withRateLimit, as built-in HTTP providers do, so the SDK error gains its HTTP facts.
        return this.withRateLimit(async () => {
          throw Object.assign(new Error('401 invalid x-api-key sk-secret-value'), { status: 401 });
        });
      }
      return { textBlocks: [{ type: 'text', text: 'Answered.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  const unregister = registerModelProvider('failure-view', () => new Provider());
  vi.stubEnv('KODAX_FAILURE_VIEW_KEY', 'fixture');
  const options = { homeDir, defaultProvider: 'failure-view' };
  let runtime = await createKodaXRuntime(options);
  try {
    let client = toKodaXProductClient(runtime);
    const session = await client.sessions.create({ projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { reasoningMode: 'off' });
    const views: ClientSessionView[] = [];
    let observation = await client.sessions.observe(session.id, view => views.push(view));
    const failed = await client.inputs.submit({ sessionId: session.id, inputId: 'first', text: 'First question.' });
    const result = await client.runs.await(failed.runId!);
    expect(result).toMatchObject({ phase: 'failed', failureDetail: { failureKind: 'auth', httpStatus: 401 } });
    const safeMessage = result.failureDetail!.safeMessage;
    const failure = (items: readonly ClientViewItem[]) => items.filter(item => item.type === 'error');
    await expect.poll(() => failure(views.at(-1)!.items)).toMatchObject([
      { type: 'error', text: safeMessage, sourceRunId: failed.runId, afterInputId: 'first' },
    ]);
    expect(views.at(-1)!.items.some(item => item.text.includes('continue'))).toBe(false);

    rejectKey = false;
    const next = await client.inputs.submit({ sessionId: session.id, inputId: 'second', text: 'Second question.' });
    expect((await client.runs.await(next.runId!)).phase).toBe('completed');
    await expect.poll(() => views.at(-1)!.items.map(item => item.type === 'error' ? 'error' : item.text)).toEqual([
      'First question.', 'error', 'Second question.', 'Answered.',
    ]);
    observation.close();

    await runtime.close();
    runtime = await createKodaXRuntime(options);
    client = toKodaXProductClient(runtime);
    const reopened: ClientSessionView[] = [];
    observation = await client.sessions.observe(session.id, view => reopened.push(view));
    expect(reopened[0]!.items.map(item => item.type === 'error' ? `error:${item.text}:${item.sourceRunId}` : item.text)).toEqual([
      'First question.', `error:${safeMessage}:${failed.runId}`, 'Second question.', 'Answered.',
    ]);
    expect(JSON.stringify(reopened[0]!.items)).not.toContain('sk-secret-value');
    observation.close();
  } finally {
    await runtime.close(); await awaitLatestCodingMemoryReviewDrain(5_000);
    unregister(); vi.unstubAllEnvs(); await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
