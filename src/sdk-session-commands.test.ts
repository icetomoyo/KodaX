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
import { FileSessionStorage } from '@kodax-ai/repl';
import { createKodaXRuntime, type KodaXRuntime } from './sdk-runtime.js';
import type { SessionCommandBinding } from '@kodax-ai/repl';

class ProbeProvider extends KodaXBaseProvider {
  readonly name = 't34-session-probe';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_T34_SESSION_KEY', model: 't34-session-probe', supportsThinking: false,
  };
  async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    void messages;
    return {
      textBlocks: [{ type: 'text', text: 'done' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    };
  }
}

/** Wired exactly like src/kodax_cli.ts wires the interactive runtime. */
function wireSessionCommands(runtime: KodaXRuntime): SessionCommandBinding {
  return {
    delete: (sessionId) => runtime.sessions.delete(sessionId),
    deleteAll: async ({ gitRoot }) => {
      const sessions = await runtime.sessions.list(
        gitRoot !== undefined ? { projectRoot: gitRoot } : undefined,
      );
      for (const session of sessions) {
        await runtime.sessions.delete(session.id);
      }
    },
    setActiveEntry: async (input) => {
      try {
        await runtime.sessions.setActiveEntry({
          sessionId: input.sessionId,
          entryId: input.selector,
          ...(input.summarizeCurrentBranch === true ? { summarizeCurrentBranch: true } : {}),
        });
        return true;
      } catch {
        return false;
      }
    },
    setLabel: async (input) => {
      try {
        await runtime.sessions.labelEntry(input);
        return true;
      } catch {
        return false;
      }
    },
    fork: async (input) => {
      const forked = await runtime.sessions.fork(input);
      return forked?.id;
    },
    rewind: async (input) => {
      const rewound = await runtime.sessions.rewind(input);
      return rewound !== null;
    },
    recover: async (input) => {
      const recovered = await runtime.sessions.recover(input);
      return recovered.id;
    },
    create: async (input) => {
      await runtime.sessions.create(input);
    },
  };
}

/**
 * FEATURE_298 T34 — session-command mutations go through the Host; the
 * REPL-side storage never writes, and its read-back sees exactly what the
 * Host persisted (same session file).
 */
it('routes session label/rewind/fork/recover mutations through the Host', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-t34-session-'));
  const sessionsDir = path.join(homeDir, '.kodax', 'sessions');
  registerModelProvider('t34-session-probe', () => new ProbeProvider());
  vi.stubEnv('KODAX_T34_SESSION_KEY', 'test-key');
  const runtime = await createKodaXRuntime({
    homeDir, sharedDaemonHost: true, defaultProvider: 't34-session-probe',
  });
  const binding = wireSessionCommands(runtime);
  const sessionId = 't34-cmds-session';
  await binding.create({ sessionId, title: 'T34 cmds', surface: 'repl' });

  // Two committed turns give the lineage two switchable branches.
  for (const [inputId, text] of [['t1', 'First turn.'], ['t2', 'Second turn.']] as const) {
    const active = await runtime.runs.acceptInput({ sessionId, inputId, text });
    if ('runId' in active && active.runId !== undefined) {
      await runtime.runs.await(active.runId);
    }
  }

  // The REPL's own writer instance pointed at the same sessions dir.
  const storage = new FileSessionStorage({ sessionsDir });
  const saveSpy = vi.spyOn(storage, 'save');

  try {
    // Label: Host writes; another read face observes; local re-read agrees.
    const lineageBefore = await runtime.sessions.readLineage(sessionId);
    expect(lineageBefore).not.toBeNull();
    const latestEntryId = lineageBefore!.entries
      .filter((entry) => entry.type === 'message').at(-1)?.id;
    expect(latestEntryId).toBeDefined();
    const labeled = await binding.setLabel({
      sessionId,
      selector: latestEntryId!,
      label: 'checkpoint',
    });
    expect(labeled).toBe(true);
    // Labeling appends a label entry to the lineage.
    await expect.poll(async () =>
      (await runtime.sessions.readLineage(sessionId))?.entries.length
    , { timeout: 10_000 }).toBe(lineageBefore!.entries.length + 1);
    const lineageAfter = await runtime.sessions.readLineage(sessionId);
    const localLineage = await storage.getLineage(sessionId);
    expect(localLineage?.entries.length).toBe(lineageAfter!.entries.length);

    // Rewind: Host truncates; the local read-back shows the rewound state.
    const rewound = await binding.rewind({ sessionId });
    expect(rewound).toBe(true);
    const rewoundLineage = await runtime.sessions.readLineage(sessionId);
    expect(rewoundLineage!.entries.length).toBeLessThan(lineageAfter!.entries.length);
    const localAfterRewind = await storage.getLineage(sessionId);
    expect(localAfterRewind?.entries.length).toBe(rewoundLineage!.entries.length);

    // Fork: the Host derives the new session; the local writer can re-read it.
    const forkedId = await binding.fork({ sessionId });
    expect(forkedId).toBeDefined();
    expect(forkedId).not.toBe(sessionId);
    const forkedSummary = (await runtime.sessions.list()).find((s) => s.id === forkedId);
    expect(forkedSummary).toBeDefined();
    const forkedLocal = await storage.load(forkedId!);
    expect(forkedLocal).not.toBeNull();

    // Recover: the Host derives a fresh seed session from its journal.
    const recoveredId = await binding.recover({ sessionId, reason: 'provider recovery' });
    expect(recoveredId).toBeDefined();
    expect(recoveredId).not.toBe(sessionId);
    const recoveredLocal = await storage.load(recoveredId!);
    expect(recoveredLocal).not.toBeNull();

    // Delete through the Host removes the forked session for every reader.
    await binding.delete(forkedId!);
    expect((await runtime.sessions.list()).find((s) => s.id === forkedId)).toBeUndefined();

    // Manual /compact goes through the Host compact command: the Host
    // replays its journal through the compaction domain (manual bypasses
    // the threshold) and persists; the local writer stays untouched.
    const compacted = await runtime.sessions.compact({
      sessionId,
      customInstructions: 'focus on auth',
    });
    expect(compacted.tokensBefore).toBeGreaterThan(0);
    // Whatever the outcome, the session stays readable for every client
    // and the compacted message list is the Host's own projection.
    expect(Array.isArray(compacted.messages)).toBe(true);
    const compactedLineage = await runtime.sessions.readLineage(sessionId);
    expect(compactedLineage).not.toBeNull();

    // The local canonical writer recorded zero writes throughout.
    expect(saveSpy).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    clearRuntimeModelProviders();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90_000);
