import { describe, expect, it } from 'vitest';

import type { RuntimeEvent } from './sdk-runtime.js';
import {
  deriveInterruptedRunOperations,
  deriveInterruptedRunReplies,
  selectInterruptedRunCandidates,
} from './runtime-interrupted-run-journal.js';

let seq = 0;
function event(type: string, payload: unknown, turnId = 'turn-1'): RuntimeEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    seq,
    cursor: { sessionId: 'session-1', journalEpoch: 'epoch-1', seq },
    time: '2026-09-28T08:30:00.000Z',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId,
    type: type as RuntimeEvent['type'],
    payload,
  };
}

const started = (id: string, name: string, input: Record<string, unknown>, turnId?: string) =>
  event('tool.started', { tool: { id, name, input } }, turnId);
const finished = (id: string, name: string, content: string, turnId?: string) =>
  event('tool.finished', { result: { id, name, content } }, turnId);
const segment = (providerRequestId: string, mode: 'append' | 'replace' = 'append', turnId = 'turn-1') =>
  event('output.segment.started', { responseId: turnId, providerRequestId, mode }, turnId);
const delta = (providerRequestId: string, text: string, turnId = 'turn-1') =>
  event('assistant.delta', { text, providerRequestId }, turnId);

describe('deriveInterruptedRunOperations', () => {
  it('keeps journal order and marks started tools without a result as unknown', () => {
    const operations = deriveInterruptedRunOperations([
      started('call_w', 'write', { path: 'out/script.md', content: 'x'.repeat(5_000) }),
      event('assistant.delta', { text: 'writing' }),
      finished('call_w', 'write', 'File created: out/script.md\nmore detail'),
      started('call_b', 'bash', { command: 'npm run render' }),
    ]);

    expect(operations).toEqual([
      { toolUseId: 'call_w', turnId: 'turn-1', name: 'write', target: 'out/script.md', result: 'File created: out/script.md' },
      { toolUseId: 'call_b', turnId: 'turn-1', name: 'bash', target: 'npm run render' },
    ]);
  });

  it('keeps a tool id reused by a later turn as its own invocation', () => {
    const operations = deriveInterruptedRunOperations([
      started('call_1', 'read', { path: 'docs/plan.md' }, 'turn-1'),
      finished('call_1', 'read', '1  # Plan', 'turn-1'),
      started('call_1', 'write', { path: 'out/script.md' }, 'turn-2'),
    ]);

    expect(operations).toEqual([
      { toolUseId: 'call_1', turnId: 'turn-1', name: 'read', target: 'docs/plan.md', result: '1  # Plan' },
      { toolUseId: 'call_1', turnId: 'turn-2', name: 'write', target: 'out/script.md' },
    ]);
  });

  it('pairs each result with the open invocation of its own turn', () => {
    const operations = deriveInterruptedRunOperations([
      started('call_1', 'read', { path: 'a.md' }),
      finished('call_1', 'read', 'A'),
      started('call_1', 'write', { path: 'b.md' }),
      finished('call_1', 'write', 'B'),
      started('call_2', 'bash', { command: 'npm test' }, 'turn-1'),
      finished('call_2', 'bash', 'stale', 'turn-2'),
    ]);

    expect(operations.map((operation) => [operation.name, operation.result])).toEqual([
      ['read', 'A'],
      ['write', 'B'],
      ['bash', undefined],
    ]);
  });

  it('merges a repeated start of an invocation that is still open', () => {
    const operations = deriveInterruptedRunOperations([
      started('call_1', 'bash', { command: 'npm run render' }),
      started('call_1', 'bash', { command: 'npm run render' }),
    ]);

    expect(operations).toHaveLength(1);
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

describe('deriveInterruptedRunReplies', () => {
  it('keeps one reply per provider call and drops output a retry replaced', () => {
    const replies = deriveInterruptedRunReplies([
      segment('req_1'),
      delta('req_1', 'Plan: write the '),
      delta('req_1', 'script first.'),
      event('thinking.delta', { text: 'private reasoning', providerRequestId: 'req_1' }),
      started('call_w', 'write', { path: 'out/script.md' }),
      segment('req_2'),
      delta('req_2', 'Rendering fail'),
      segment('req_3', 'replace'),
      delta('req_3', 'Rendering now.'),
    ]);

    expect(replies).toEqual([
      { turnId: 'turn-1', text: 'Plan: write the script first.', truncated: false },
      { turnId: 'turn-1', text: 'Rendering now.', truncated: false },
    ]);
  });

  it('attributes each reply to the turn that streamed it', () => {
    const replies = deriveInterruptedRunReplies([
      segment('req_1', 'append', 'turn-1'),
      delta('req_1', 'first turn', 'turn-1'),
      segment('req_2', 'append', 'turn-2'),
      delta('req_2', 'second turn', 'turn-2'),
    ]);

    expect(replies.map((reply) => [reply.turnId, reply.text])).toEqual([
      ['turn-1', 'first turn'],
      ['turn-2', 'second turn'],
    ]);
  });

  it('ignores text that no started output segment owns', () => {
    expect(deriveInterruptedRunReplies([
      event('assistant.delta', { text: 'legacy delta without a request id' }),
      delta('req_unknown', 'orphan'),
      segment('req_1'),
      delta('req_1', '   '),
    ])).toEqual([]);
  });

  it('keeps only the root Run replies, not child actor output mirrored live', () => {
    const childMeta = { providerRequestId: 'req_child', liveOnly: true, contextKind: 'child' };
    expect(deriveInterruptedRunReplies([
      segment('req_root'),
      delta('req_root', 'Delegating the render.'),
      event('output.segment.started', { responseId: 'child-turn', providerRequestId: 'req_child', mode: 'append', meta: childMeta }),
      event('assistant.delta', { text: 'child says hi', providerRequestId: 'req_child', meta: childMeta }),
    ])).toEqual([{ turnId: 'turn-1', text: 'Delegating the render.', truncated: false }]);
  });

  it('keeps the tail of a long reply and only the most recent replies', () => {
    const events = [
      segment('req_long'),
      delta('req_long', `${'a'.repeat(5_000)}LATEST STATUS`),
      ...Array.from({ length: 10 }, (_, index) => [
        segment(`req_${index}`),
        delta(`req_${index}`, `reply ${index}`),
      ]).flat(),
    ];

    const replies = deriveInterruptedRunReplies(events);
    const long = deriveInterruptedRunReplies(events.slice(0, 2))[0]!;

    expect(replies.length).toBeLessThanOrEqual(6);
    expect(replies.at(-1)!.text).toBe('reply 9');
    expect(long.truncated).toBe(true);
    expect(long.text.endsWith('LATEST STATUS')).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(1_200);
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
