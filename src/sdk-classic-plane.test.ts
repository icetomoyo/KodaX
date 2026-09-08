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
  firstActiveRunId,
  type InkClientPlane,
} from '@kodax-ai/repl';
import { attachClassicPlaneDisplay } from '@kodax-ai/repl';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { createKodaXRuntime, type KodaXRuntime } from './sdk-runtime.js';

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

/** Wired exactly like src/kodax_cli.ts wires the interactive runtime. */
function wireClientPlane(runtime: KodaXRuntime): InkClientPlane {
  return {
    submit: (input) => runtime.runs.acceptInput({
      sessionId: input.sessionId,
      text: input.text,
      inputId: input.inputId,
      ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
    }),
    withdraw: (sessionId, inputId) =>
      runtime.runs.withdrawInput(sessionId, inputId)
        .then((withdrawn) => withdrawn.text)
        .catch((error: unknown) => {
          if ((error as { readonly code?: string }).code === 'conflict') return undefined;
          throw error;
        }),
    awaitRun: async (sessionId, runId) => {
      void sessionId;
      const outcome = await runtime.runs.await(runId);
      return {
        phase: outcome.phase,
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error.message } : {}),
      };
    },
    stop: (runId) => runtime.runs.abort(runId),
    activeRun: (sessionId) =>
      runtime.runs.list({ sessionId }).then((runs) =>
        firstActiveRunId(runs.map((run) => ({ runId: run.runId, phase: run.phase })))),
    observe: (sessionId, onView) =>
      runtime.sessions
        .observeView(sessionId, onView)
        .then((observation) => () => observation.close()),
    readItem: (sessionId, itemId, readOptions) =>
      runtime.sessions.readViewItem(
        sessionId,
        itemId,
        typeof readOptions === 'number'
          ? { offset: readOptions }
          : readOptions,
      ),
    respondInteraction: (requestId, response) =>
      runtime.interactions
        .respond(requestId, response)
        .then((result) => result.accepted),
  };
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
  const plane = wireClientPlane(runtime);
  try {
    const session = await runtime.sessions.create({ title: 'T18 classic', surface: 'repl' });
    await runtime.sessions.updateSettings(session.id, {
      agentMode: 'sa', permissionMode: 'full-access',
    });

    const lines: string[] = [];
    const detach = await attachClassicPlaneDisplay(plane, session.id, {
      write: (line) => lines.push(line),
    });

    const roundPromise = runClientPlaneRound({
      plane, sessionId: session.id, prompt: 'Summarize for the console.',
    });
    await expect.poll(() => releaseStream !== undefined, { timeout: 15_000 }).toBe(true);
    releaseStream!({
      textBlocks: [{ type: 'text', text: 'Classic summary.' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    });
    const result = await roundPromise;
    expect(result.success).toBe(true);
    expect(result.lastText).toContain('Classic summary.');
    await expect.poll(() =>
      lines.some((line) => line === 'assistant:Classic summary.'),
    { timeout: 15_000 }).toBe(true);
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
  const plane = wireClientPlane(runtime);
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
