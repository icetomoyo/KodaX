import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider,
  clearRuntimeModelProviders,
  registerModelProvider,
  type KodaXMessage,
  type KodaXProviderConfig,
  type KodaXProviderStreamOptions,
  type KodaXStreamResult,
} from '@kodax-ai/llm';
import {
  runClientPlaneRound,
} from '@kodax-ai/repl';
import { attachClassicPlaneDisplay } from '@kodax-ai/repl';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { createKodaXRuntime } from './sdk-runtime.js';
import { createCliClientPlane } from './cli-client-plane.js';

class ProbeProvider extends KodaXBaseProvider {
  readonly name = 't18-probe';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_T18_KEY', model: 't18-probe', supportsThinking: false,
  };
  constructor(private readonly finish: (resolve: (result: KodaXStreamResult) => void) => void) {
    super();
  }
  async stream(
    messages: KodaXMessage[],
    _tools: never[],
    _system: string,
    _reasoning?: boolean,
    streamOptions?: KodaXProviderStreamOptions,
  ): Promise<KodaXStreamResult> {
    void messages;
    return new Promise<KodaXStreamResult>((resolve) => this.finish((result) => {
      for (const block of result.textBlocks) {
        if (block.type === 'text') streamOptions?.onTextDelta?.(block.text);
      }
      resolve(result);
    }));
  }
}

/**
 * FEATURE_298 T18 — the classic console display rides a real Host round:
 * the baseline view primes the differ (no history reprint) and streamed
 * assistant text reaches the console writer.
 */
it('prints a plane-bound classic round from the live session view', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-t18-plane-'));
  let releaseStream: ((result: KodaXStreamResult) => void) | undefined;
  registerModelProvider('t18-probe', () => new ProbeProvider((resolve) => {
    releaseStream = resolve;
  }));
  vi.stubEnv('KODAX_T18_KEY', 'test-key');
  const runtime = await createKodaXRuntime({
    homeDir, sharedDaemonHost: true, defaultProvider: 't18-probe',
  });
  const plane = createCliClientPlane(runtime);
  try {
    const session = await runtime.sessions.create({ title: 'T18 classic', surface: 'repl' });
    await runtime.sessions.updateSettings(session.id, {
      agentMode: 'sa', permissionMode: 'full-access',
    });

    const lines: string[] = [];
    const detach = await attachClassicPlaneDisplay(plane, session.id, {
      write: (line) => lines.push(line),
    });

    const roundOutcome = runClientPlaneRound({
      plane, sessionId: session.id, prompt: 'Summarize for the console.',
    }).then(result => ({ result }), (error: unknown) => ({ error }));
    await expect.poll(() => releaseStream !== undefined, { timeout: 30_000 }).toBe(true);
    const expectedText = `Classic summary. ${'x'.repeat(9_000)} END`;
    releaseStream!({
      textBlocks: [{ type: 'text', text: expectedText }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    });
    const outcome = await roundOutcome;
    if ('error' in outcome) throw outcome.error;
    const result = outcome.result;
    expect(result.success).toBe(true);
    expect(result.lastText).toContain('Classic summary.');
    await expect.poll(() => lines.filter((line) => line.startsWith('assistant:'))
      .map((line) => line.slice('assistant:'.length)).join(''),
    { timeout: 15_000 }).toBe(expectedText);
    const history = await plane.readHistory!(session.id);
    const answer = history.items.find(item => item.type === 'assistant' && item.text.startsWith('Classic summary.'))!;
    expect(answer).toBeDefined();
    expect(answer.totalTextLength).toBe(expectedText.length);
    expect((await plane.readHistoryEntry!(session.id, answer.id))?.text).toBe(expectedText);
    // The baseline view (user echo etc.) never reprints history.
    expect(lines.every((line) => !line.startsWith('user:'))).toBe(true);
    detach();
  } finally {
    vi.unstubAllEnvs();
    clearRuntimeModelProviders();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

it('keeps the classic display view-only when no dialogs are provided', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-t18-plain-'));
  registerModelProvider('t18-probe', () => new ProbeProvider(() => undefined));
  vi.stubEnv('KODAX_T18_KEY', 'test-key');
  const runtime = await createKodaXRuntime({
    homeDir, sharedDaemonHost: true, defaultProvider: 't18-probe',
  });
  const plane = createCliClientPlane(runtime);
  try {
    const session = await runtime.sessions.create({ title: 'T18 plain', surface: 'repl' });
    const views: ClientSessionView[] = [];
    const detach = await attachClassicPlaneDisplay(plane, session.id, {
      write: () => undefined,
    });
    const observation = await plane.observe(session.id, (view) => views.push(view));
    expect(views.length).toBeGreaterThan(0);
    observation();
    detach();
  } finally {
    vi.unstubAllEnvs();
    clearRuntimeModelProviders();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
