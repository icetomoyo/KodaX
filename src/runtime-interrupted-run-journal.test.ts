import { describe, expect, it } from 'vitest';

import type { RuntimeEvent } from './sdk-runtime.js';
import {
  deriveInterruptedRunOperations,
  selectInterruptedRunCandidates,
} from './runtime-interrupted-run-journal.js';

let seq = 0;
function event(type: string, payload: unknown): RuntimeEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    seq,
    cursor: { sessionId: 'session-1', journalEpoch: 'epoch-1', seq },
    time: '2026-09-28T08:30:00.000Z',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    type: type as RuntimeEvent['type'],
    payload,
  };
}

const started = (id: string, name: string, input: Record<string, unknown>) =>
  event('tool.started', { tool: { id, name, input } });
const finished = (id: string, name: string, content: string) =>
  event('tool.finished', { result: { id, name, content } });

describe('deriveInterruptedRunOperations', () => {
  it('keeps journal order and marks started tools without a result as unknown', () => {
    const operations = deriveInterruptedRunOperations([
      started('call_w', 'write', { path: 'out/script.md', content: 'x'.repeat(5_000) }),
      event('assistant.delta', { text: 'writing' }),
      finished('call_w', 'write', 'File created: out/script.md\nmore detail'),
      started('call_b', 'bash', { command: 'npm run render' }),
    ]);

    expect(operations).toEqual([
      { toolUseId: 'call_w', name: 'write', target: 'out/script.md', result: 'File created: out/script.md' },
      { toolUseId: 'call_b', name: 'bash', target: 'npm run render' },
    ]);
  });

  it('bounds targets and results so large tool payloads never reach the record', () => {
    const [operation] = deriveInterruptedRunOperations([
      started('call_long', 'bash', { command: `echo ${'a'.repeat(1_000)}` }),
      finished('call_long', 'bash', `${'b'.repeat(1_000)}\nsecond line`),
    ]);

    expect(operation!.target!.length).toBeLessThanOrEqual(120);
    expect(operation!.result!.length).toBeLessThanOrEqual(120);
  });

  it('falls back to the first string input when no well-known target key exists', () => {
    const [operation] = deriveInterruptedRunOperations([
      started('call_s', 'web_search', { limit: 8, query: 'kodax runtime' }),
    ]);

    expect(operation!.target).toBe('kodax runtime');
  });

  it('ignores malformed payloads and results that were never started in this Run', () => {
    expect(deriveInterruptedRunOperations([
      event('tool.started', { tool: { name: 'read' } }),
      finished('call_orphan', 'read', 'content'),
    ])).toEqual([]);
  });
});

describe('selectInterruptedRunCandidates', () => {
  const run = (runId: string, overrides: Record<string, unknown> = {}) => ({
    runId,
    sessionId: 'session-1',
    turnId: `turn-${runId}`,
    sessionOrder: Number(runId.replace(/\D/g, '')),
    terminal: { kind: 'interrupted', code: 'daemon_crashed' },
    ...overrides,
  });

  it('keeps unfinished Runs of the same Session in session order', () => {
    const selected = selectInterruptedRunCandidates([
      run('run-3'),
      run('run-1'),
      run('run-2', { terminal: { kind: 'completed', code: 'completed' } }),
      run('run-4', { sessionId: 'session-other' }),
      run('run-5', { terminal: undefined }),
      run('run-6', { turnId: undefined }),
      run('run-7'),
    ], { runId: 'run-7', sessionId: 'session-1' });

    expect(selected.map((candidate) => candidate.runId)).toEqual(['run-1', 'run-3']);
  });

  it('reads only the most recent candidates', () => {
    const runs = Array.from({ length: 12 }, (_, index) => run(`run-${index + 1}`));

    const selected = selectInterruptedRunCandidates(runs, { runId: 'run-99', sessionId: 'session-1' });

    expect(selected.map((candidate) => candidate.runId)).toEqual(['run-8', 'run-9', 'run-10', 'run-11', 'run-12']);
  });
});
