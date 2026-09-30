import { describe, expect, it } from 'vitest';

import type { KodaXInterruptedRunJournal, KodaXMessage } from '../../types.js';
import { renderInterruptedRunRecovery } from './interrupted-run-recovery.js';

const anchoredHistory: KodaXMessage[] = [
  { role: 'user', content: 'build the episode', turnId: 'turn_a' },
  { role: 'user', content: 'continue', turnId: 'turn_b' },
];

function journal(overrides: Partial<KodaXInterruptedRunJournal> = {}): KodaXInterruptedRunJournal {
  return {
    runId: 'run_a',
    turnId: 'turn_a',
    terminalCode: 'daemon_crashed',
    operations: [
      { toolUseId: 'call_read', name: 'read', target: 'docs/plan.md', result: '1  # Plan' },
      { toolUseId: 'call_write', name: 'write', target: 'out/script.md', result: 'File created: out/script.md' },
      { toolUseId: 'call_bash', name: 'bash', target: 'npm run render' },
    ],
    ...overrides,
  };
}

describe('renderInterruptedRunRecovery', () => {
  it('labels the source and separates recorded results from unknown outcomes', () => {
    const text = renderInterruptedRunRecovery([journal()], anchoredHistory);

    expect(text).toContain('run_a');
    expect(text).toContain('daemon_crashed');
    expect(text).toContain('event journal');
    expect(text).toContain('not the conversation');
    const [recorded, unknown] = text!.split('Result unknown');
    expect(recorded).toContain('write out/script.md → File created: out/script.md');
    expect(recorded).not.toContain('npm run render');
    expect(unknown).toContain('bash npm run render');
  });

  it('omits operations whose results already exist in formal history', () => {
    const history: KodaXMessage[] = [
      ...anchoredHistory,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_read', name: 'read', input: {} }], turnId: 'turn_a' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'x' }], turnId: 'turn_a' },
    ];

    const text = renderInterruptedRunRecovery([journal()], history);

    expect(text).not.toContain('docs/plan.md');
    expect(text).toContain('out/script.md');
  });

  it('returns nothing once every operation is already in formal history', () => {
    const history: KodaXMessage[] = [
      ...anchoredHistory,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_only', content: 'x' }], turnId: 'turn_a' },
    ];
    const recorded = journal({ operations: [{ toolUseId: 'call_only', name: 'read', result: 'x' }] });

    expect(renderInterruptedRunRecovery([recorded], history)).toBeUndefined();
  });

  it('attributes an unstamped tool result to the turn it follows', () => {
    const history: KodaXMessage[] = [
      anchoredHistory[0]!,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'x' }] },
      anchoredHistory[1]!,
    ];

    const text = renderInterruptedRunRecovery([journal()], history);

    expect(text).not.toContain('docs/plan.md');
  });

  it('does not let an earlier turn mask a reused tool id of the interrupted turn', () => {
    const history: KodaXMessage[] = [
      anchoredHistory[0]!,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: {} }], turnId: 'turn_a' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'x' }], turnId: 'turn_a' },
      anchoredHistory[1]!,
    ];
    const interrupted = journal({
      runId: 'run_b',
      turnId: 'turn_b',
      operations: [{ toolUseId: 'call_1', turnId: 'turn_b', name: 'write', target: 'out/script.md' }],
    });

    const text = renderInterruptedRunRecovery([interrupted], history);

    expect(text).toContain('write out/script.md');
  });

  it('matches a tool id reused within one turn occurrence by occurrence', () => {
    const history: KodaXMessage[] = [
      ...anchoredHistory,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'x' }], turnId: 'turn_a' },
    ];
    const reused = journal({
      operations: [
        { toolUseId: 'call_1', name: 'read', target: 'docs/plan.md', result: 'x' },
        { toolUseId: 'call_1', name: 'write', target: 'out/script.md' },
      ],
    });

    const text = renderInterruptedRunRecovery([reused], history)!;

    expect(text).not.toContain('docs/plan.md');
    expect(text).toContain('write out/script.md');
  });

  it('ignores journals whose turn is not on the active history path', () => {
    const otherBranch = journal({ runId: 'run_other', turnId: 'turn_elsewhere' });

    expect(renderInterruptedRunRecovery([otherBranch], anchoredHistory)).toBeUndefined();
  });

  it('does not treat synthetic context messages as branch evidence', () => {
    const history: KodaXMessage[] = [
      { role: 'user', content: 'context', turnId: 'turn_a', _synthetic: true },
    ];

    expect(renderInterruptedRunRecovery([journal()], history)).toBeUndefined();
  });

  it('bounds the record and reports how many recorded operations were omitted', () => {
    const operations = Array.from({ length: 200 }, (_, index) => ({
      toolUseId: `call_${index}`,
      name: 'read',
      target: `src/file-${index}.ts`,
      result: 'x'.repeat(200),
    }));
    const runs = Array.from({ length: 5 }, (_, index) =>
      journal({ runId: `run_${index}`, operations }));

    const text = renderInterruptedRunRecovery(runs, anchoredHistory)!;

    expect(text.length).toBeLessThanOrEqual(6_000);
    expect(text).toContain('earlier recorded operations omitted');
    expect(text).toContain('run_4');
    expect(text).not.toContain('run_0');
    expect(text).toContain('src/file-199.ts');
  });

  it('shows streamed replies as labelled, unconfirmed excerpts', () => {
    const replies = journal({
      operations: [],
      replies: [{ turnId: 'turn_a', text: 'Plan: write the script,\nthen render.', truncated: false }],
    });

    const text = renderInterruptedRunRecovery([replies], anchoredHistory)!;

    expect(text).toContain('never saved');
    expect(text).toContain('> Plan: write the script,\n> then render.');
    expect(text).not.toContain('Result unknown');
  });

  it('marks an excerpt whose beginning was dropped', () => {
    const replies = journal({ replies: [{ turnId: 'turn_a', text: 'tail of a long reply', truncated: true }] });

    expect(renderInterruptedRunRecovery([replies], anchoredHistory)).toContain('> …tail of a long reply');
  });

  it('omits a reply that formal history already holds for the same turn', () => {
    const history: KodaXMessage[] = [
      anchoredHistory[0]!,
      { role: 'assistant', content: [{ type: 'text', text: 'Plan:  write the script.' }], turnId: 'turn_a' },
      { role: 'assistant', content: 'Rendering   now.' },
      anchoredHistory[1]!,
    ];
    const replies = journal({
      operations: [],
      replies: [
        { turnId: 'turn_a', text: 'Plan: write the script.', truncated: false },
        { turnId: 'turn_a', text: 'Rendering now.', truncated: false },
      ],
    });

    expect(renderInterruptedRunRecovery([replies], history)).toBeUndefined();
  });

  it('keeps a reply whose text only another turn holds', () => {
    const history: KodaXMessage[] = [
      ...anchoredHistory,
      { role: 'assistant', content: 'Plan: write the script.', turnId: 'turn_b' },
    ];
    const replies = journal({
      operations: [],
      replies: [{ turnId: 'turn_a', text: 'Plan: write the script.', truncated: false }],
    });

    expect(renderInterruptedRunRecovery([replies], history)).toContain('> Plan: write the script.');
  });

  it('keeps operations ahead of excerpts so the bound trims excerpts first', () => {
    const replies = Array.from({ length: 10 }, (_, index) => ({
      turnId: 'turn_a',
      text: `reply ${index} ${'r'.repeat(2_000)}`,
      truncated: false,
    }));
    const runs = Array.from({ length: 3 }, (_, index) => journal({ runId: `run_${index}`, replies }));

    const text = renderInterruptedRunRecovery(runs, anchoredHistory)!;

    expect(text.length).toBeLessThanOrEqual(6_000);
    expect(text).toContain('bash npm run render');
    expect(text).toContain('earlier reply excerpts omitted');
    expect(text.indexOf('npm run render')).toBeLessThan(text.indexOf('never saved'));
  });

  it('keeps an older Run\'s operations when a newer Run carries only long excerpts', () => {
    const recorded = Array.from({ length: 16 }, (_, index) => ({
      toolUseId: `call_read_${index}`,
      name: 'read',
      target: `src/file-${index}.ts`,
      result: 'x'.repeat(200),
    }));
    const unknown = Array.from({ length: 8 }, (_, index) => ({
      toolUseId: `call_write_${index}`,
      name: 'write',
      target: `out/${'d'.repeat(120)}/part-${index}.md`,
    }));
    const older = journal({ runId: 'run_old', operations: [...recorded, ...unknown] });
    const newer = journal({
      runId: 'run_new',
      turnId: 'turn_b',
      operations: [],
      replies: Array.from({ length: 3 }, (_, index) => ({
        turnId: 'turn_b',
        text: `${'r'.repeat(2_000)} end of reply ${index}`,
        truncated: false,
      })),
    });

    const text = renderInterruptedRunRecovery([older, newer], anchoredHistory)!;

    expect(text.length).toBeLessThanOrEqual(6_000);
    expect(text).toContain('run_old');
    expect(text).toContain('src/file-15.ts');
    for (let index = 0; index < 8; index += 1) expect(text).toContain(`/part-${index}.md`);
    expect(text).toContain('Check the current files');
    expect(text).toContain('run_new');
    expect(text).toContain('end of reply 2');
    expect(text).toContain('earlier reply excerpts omitted');
    expect(text.endsWith('=== End Interrupted Run Recovery ===')).toBe(true);
    expect(text).not.toMatch(/…\n=== End/);
  });

  it('does not let an older Run\'s excerpts crowd out a newer Run\'s operations', () => {
    const older = journal({
      operations: [],
      replies: Array.from({ length: 10 }, (_, index) => ({
        turnId: 'turn_a',
        text: `reply ${index} ${'r'.repeat(2_000)}`,
        truncated: false,
      })),
    });
    const newer = journal({ runId: 'run_new', turnId: 'turn_b' });

    const text = renderInterruptedRunRecovery([older, newer], anchoredHistory)!;

    expect(text.length).toBeLessThanOrEqual(6_000);
    expect(text).toContain('bash npm run render');
    expect(text.indexOf('run_a')).toBeLessThan(text.indexOf('run_new'));
  });

  it('renders the same text for the same evidence', () => {
    const first = renderInterruptedRunRecovery([journal()], anchoredHistory);

    expect(renderInterruptedRunRecovery([journal()], anchoredHistory)).toBe(first);
  });
});
