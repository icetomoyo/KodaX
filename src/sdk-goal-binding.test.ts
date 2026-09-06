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
  type KodaXStreamResult,
} from '@kodax-ai/llm';
import { readLatestGoalState } from '@kodax-ai/agent';
import { executeCommand, FileSessionStorage } from '@kodax-ai/repl';
import type { InteractiveContext } from '@kodax-ai/repl';
import { createKodaXRuntime } from './sdk-runtime.js';

const CONFIG = {
  provider: 't34-probe',
  thinking: false,
  reasoningMode: 'auto' as const,
  agentMode: 'sa' as const,
  permissionMode: 'full-access' as const,
};

class ProbeProvider extends KodaXBaseProvider {
  readonly name = 't34-probe';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_T34_PROBE_KEY', model: 't34-probe', supportsThinking: false,
  };
  async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    void messages;
    return {
      textBlocks: [{ type: 'text', text: 'done' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    };
  }
}

/**
 * FEATURE_298 T34 — /goal writes go through the Host session goal plane.
 * The REPL-side storage instance never writes canonical data: another
 * client (the Host read face) observes the same modification, and the
 * local writer records zero saves.
 */
it('routes /goal mutations through the Host goal plane without a local canonical write', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-t34-goal-'));
  const sessionsDir = path.join(homeDir, '.kodax', 'sessions');
  registerModelProvider('t34-probe', () => new ProbeProvider());
  vi.stubEnv('KODAX_T34_PROBE_KEY', 'test-key');
  const runtime = await createKodaXRuntime({
    homeDir, sharedDaemonHost: true, defaultProvider: 't34-probe',
  });
  const sessionId = 't34-goal-session';
  await runtime.sessions.create({ sessionId, title: 'T34 goal', surface: 'repl' });
  // One committed run gives the session a conversation entry, which the
  // Host requires before a goal can anchor to the active branch.
  const active = await runtime.runs.acceptInput({
    sessionId, inputId: 'seed', text: 'Start.',
  });
  if ('runId' in active && active.runId !== undefined) {
    await runtime.runs.await(active.runId);
  }
  await expect.poll(async () => {
    const goal = await runtime.sessions.readGoal(sessionId);
    return goal === null;
  }, { timeout: 15_000 }).toBe(true);

  // The REPL's own writer instance pointed at the same sessions dir.
  const storage = new FileSessionStorage({ sessionsDir });
  const saveSpy = vi.spyOn(storage, 'save');

  const context: InteractiveContext = {
    sessionId,
    title: 'T34 goal',
    createdAt: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    messages: [],
  };
  const callbacks = {
    exit: () => undefined,
    saveSession: async () => {
      await storage.save(context.sessionId, {
        messages: context.messages,
        title: context.title,
        gitRoot: '',
      });
    },
    loadSession: async () => 'loaded' as const,
    listSessions: async () => undefined,
    clearHistory: () => undefined,
    printHistory: () => undefined,
    ui: {} as Parameters<typeof executeCommand>[2]['ui'],
    // Wired exactly like src/kodax_cli.ts wires the interactive runtime.
    goal: {
      read: (id: string) => runtime.sessions.readGoal(id),
      create: (input: { sessionId: string; objective: string; tokenBudget?: number }) =>
        runtime.sessions.createGoal(input),
      pause: (id: string) => runtime.sessions.pauseGoal(id),
      resume: (id: string) => runtime.sessions.resumeGoal(id),
      clear: (id: string) => runtime.sessions.clearGoal(id),
    },
    refreshSessionLineage: async () =>
      (await storage.getLineage?.(context.sessionId)) ?? undefined,
  };

  try {
    await executeCommand(
      { command: 'goal', args: ['Ship', 'v0.7.97', '--tokens', '1234'] },
      context, callbacks, CONFIG,
    );

    // Another client observes the same modification through the Host.
    const observed = await runtime.sessions.readGoal(sessionId);
    expect(observed?.objective).toBe('Ship v0.7.97');
    expect(observed?.status).toBe('active');
    expect(observed?.tokenBudget).toBe(1234);

    // The Host persisted the goal into the session lineage (the same file
    // the local writer would have claimed as its own).
    const lineage = await runtime.sessions.readLineage(sessionId);
    expect(lineage).not.toBeNull();

    // The local canonical writer recorded zero writes, and the local view
    // is refreshed from the file the Host wrote (not mutated here).
    expect(saveSpy).not.toHaveBeenCalled();
    expect(context.lineage).toBeDefined();
    const localGoal = context.lineage ? readLatestGoalState(context.lineage) : null;
    expect(localGoal?.objective).toBe('Ship v0.7.97');

    // Lifecycle continues through the Host: pause, then clear.
    await executeCommand({ command: 'goal', args: ['pause'] }, context, callbacks, CONFIG);
    const paused = await runtime.sessions.readGoal(sessionId);
    expect(paused?.status).toBe('paused');

    await executeCommand({ command: 'goal', args: ['clear'] }, context, callbacks, CONFIG);
    expect(await runtime.sessions.readGoal(sessionId)).toBeNull();
    expect(saveSpy).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    clearRuntimeModelProviders();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90_000);
