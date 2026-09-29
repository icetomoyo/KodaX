import { describe, expect, it } from 'vitest';

import type { KodaXInterruptedRunJournal, KodaXMessage } from '../../../types.js';
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
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_read', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'x' }] },
    ];

    const text = renderInterruptedRunRecovery([journal()], history);

    expect(text).not.toContain('docs/plan.md');
    expect(text).toContain('out/script.md');
  });

  it('returns nothing once every operation is already in formal history', () => {
    const history: KodaXMessage[] = [
      ...anchoredHistory,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_only', content: 'x' }] },
    ];
    const recorded = journal({ operations: [{ toolUseId: 'call_only', name: 'read', result: 'x' }] });

    expect(renderInterruptedRunRecovery([recorded], history)).toBeUndefined();
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

  it('renders the same text for the same evidence', () => {
    const first = renderInterruptedRunRecovery([journal()], anchoredHistory);

    expect(renderInterruptedRunRecovery([journal()], anchoredHistory)).toBe(first);
  });
});
