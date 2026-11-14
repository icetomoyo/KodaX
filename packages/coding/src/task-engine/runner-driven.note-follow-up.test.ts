import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { KodaXMessage } from '@kodax-ai/llm';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../memory/note-reflection-job.js', () => ({ scheduleNoteRunFinish: vi.fn(async () => undefined) }));

import { noteStoresFor, type NotePlace } from '../memory/note-memory.js';
import { scheduleNoteRunFinish } from '../memory/note-reflection-job.js';
import { buildFallbackRoutingDecision, type ReasoningPlan } from '../reasoning.js';
import type { KodaXOptions } from '../types.js';
import { runManagedTaskViaRunner } from './runner-driven.js';

const scheduled = scheduleNoteRunFinish as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.unstubAllEnvs();
  scheduled.mockClear();
});

async function runAma(context: Record<string, unknown> = {}, extra: Partial<KodaXOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-ama-notes-'));
  try {
    const result = await runManagedTaskViaRunner({ provider: 'anthropic', effort: 'none', lsp: false,
      context: { configHome: path.join(root, 'home'), gitRoot: root, executionCwd: root, repoIntelligenceMode: 'off', ...context },
      ...extra,
    },'please remember that tests run with make check-fast', async () => ({ textBlocks: [{ text: 'done' }], toolBlocks: [] }));
    return { root, result };
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
}

it('hands the finished AMA session to the note follow-up', async () => {
  vi.stubEnv('KODAX_MEMORY_NOTES', '1');
  const { root, result } = await runAma();
  expect(scheduled).toHaveBeenCalledTimes(1);
  const call = scheduled.mock.calls[0]![0] as { sessionId: string; place: NotePlace; reflect: boolean; messages: KodaXMessage[]; earlierCalls: ReadonlySet<string> };
  expect(call.sessionId).toBe(result.sessionId);
  expect(call.place.cwd).toBe(root);
  expect(call.reflect).toBe(true);
  expect(call.earlierCalls.size).toBe(0);
  expect(JSON.stringify(call.messages)).toContain('make check-fast');
});

it('only counts reads when the host supplied its own learning reviewer', async () => {
  vi.stubEnv('KODAX_MEMORY_NOTES', '1');
  await runAma({}, { learningReviewer: async () => ({ memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard', reasonCodes: ['offline'] } }) });
  expect((scheduled.mock.calls[0]![0] as { reflect: boolean }).reflect).toBe(false);
});

it('does nothing when the note memory is off', async () => {
  await runAma();
  expect(scheduled).not.toHaveBeenCalled();
});

it('does nothing for a child agent, whose notes belong to its parent run', async () => {
  vi.stubEnv('KODAX_MEMORY_NOTES', '1');
  await runAma({ parentAgentId: '/root' });
  expect(scheduled).not.toHaveBeenCalled();
});

it('sends the memory index once per session, not again with every follow-up run', async () => {
  vi.stubEnv('KODAX_MEMORY_NOTES', '1');
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-ama-notes-'));
  try {
    const requests: string[] = [];
    const capture = async (transcript: readonly KodaXMessage[], _tools: unknown, system: string) => {
      requests.push(system + JSON.stringify(transcript));
      return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
    };
    const managedContextRetention = {};
    const options = (initialMessages?: KodaXMessage[]): KodaXOptions => ({ provider: 'anthropic', effort: 'none', lsp: false,
      context: { configHome: path.join(root, 'home'), gitRoot: root, executionCwd: root, repoIntelligenceMode: 'off' },
      session: { id: 'note-index-once', managedContextRetention, ...(initialMessages ? { initialMessages } : {}) },
    });
    const plan = (prompt: string): ReasoningPlan => ({ effort: 'medium', decision: buildFallbackRoutingDecision(prompt), promptOverlay: '' });
    const first = await runManagedTaskViaRunner(options(), 'Inspect the cache behavior.', capture, plan('Inspect the cache behavior.'));
    const second = await runManagedTaskViaRunner(options([...first.messages]), 'Now check the diagnostics.', capture, plan('Now check the diagnostics.'));
    const memoryRules = 'The index below lists notes saved in earlier sessions.';
    const occurrences = (request: string) => request.split(memoryRules).length - 1;
    expect(occurrences(requests[0]!)).toBe(1);
    expect(occurrences(requests.at(-1)!)).toBe(1);

    const place = (scheduled.mock.calls.at(-1)![0] as { place: NotePlace }).place;
    await noteStoresFor(place).project.write({ id: 'diag-cmd', type: 'project', description: 'Run diagnostics with npm run diag', body: 'b' });
    await runManagedTaskViaRunner(options([...second.messages]), 'Run the diagnostics again.', capture, plan('Run the diagnostics again.'));
    expect(occurrences(requests.at(-1)!)).toBe(2);
    expect(requests.at(-1)!.split('npm run diag').length - 1).toBe(1);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});
