import { expect, it } from 'vitest';
import type { KodaXSessionData } from '@kodax-ai/agent';
import { deriveInterruptedRunEvidence, selectInterruptedRunCandidates } from './runtime-interrupted-run-recovery.js';

const run = { runId: 'run', sessionId: 'session', sessionOrder: 1, productInput: { inputId: 'input' },
  terminal: { kind: 'interrupted', code: 'daemon_crashed' } };
const data: KodaXSessionData = { title: 'Recovery', gitRoot: '', messages: [{ role: 'user', content: 'work', inputId: 'input' }],
  uiHistory: [
    { type: 'assistant', outputId: 'draft', text: 'checkpointed tail', sourceRunId: 'run', afterInputId: 'input' },
    { type: 'thinking', text: 'private reasoning', sourceRunId: 'run', afterInputId: 'input' },
    { type: 'tool_group', sourceRunId: 'run', afterInputId: 'input', tools: [
      { id: 'executed', name: 'write', status: 'cancelled', executionBegan: true, preview: '{"path":"out.md"}' },
      { id: 'proposed', name: 'bash', status: 'awaiting_approval', preview: 'do not run' },
    ] },
  ],
};

it('recovers saved Host facts anchored by accepted input before a turn exists', () => {
  const evidence = deriveInterruptedRunEvidence(data, run);
  expect(evidence).toMatchObject({ inputId: 'input', replies: [{ outputId: 'draft', text: 'checkpointed tail' }],
    operations: [{ toolUseId: 'executed', name: 'write', target: 'out.md' }] });
  expect(evidence?.operations[0]?.result).toBeUndefined();
  expect(JSON.stringify(evidence)).not.toContain('private reasoning');
  expect(JSON.stringify(evidence)).not.toContain('proposed');
});

it('excludes another branch and outputs already committed by identity, not equal text', () => {
  expect(deriveInterruptedRunEvidence({ ...data, messages: [] }, run)).toBeUndefined();
  const saved = { ...data, messages: [...data.messages,
    { role: 'assistant' as const, content: 'checkpointed tail', outputId: 'other' }] };
  expect(deriveInterruptedRunEvidence(saved, run)?.replies).toHaveLength(1);
  saved.messages.push({ role: 'assistant', content: 'checkpointed tail', outputId: 'draft' });
  expect(deriveInterruptedRunEvidence(saved, run)?.replies).toEqual([]);
});

it('distinguishes an empty recorded result from execution with an unknown outcome', () => {
  const saved: KodaXSessionData = { ...data, uiHistory: [{ type: 'tool_group', sourceRunId: 'run',
    afterInputId: 'input', tools: [{ id: 'empty', name: 'write', status: 'success', resultRecorded: true, output: '' }] }] };
  expect(deriveInterruptedRunEvidence(saved, run)?.operations[0]?.result).toBe('(empty result)');
});

it('selects only the latest five unsuccessful Runs in the same Session', () => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({ ...run, runId: `old-${index}`, sessionOrder: index }));
  expect(selectInterruptedRunCandidates([...candidates, run,
    { ...run, runId: 'other', sessionId: 'other' },
    { ...run, runId: 'completed', terminal: { kind: 'completed', code: 'completed' } },
    { ...run, runId: 'active', terminal: undefined }], run).map(item => item.runId))
    .toEqual(['old-3', 'old-4', 'old-5', 'old-6', 'old-7']);
});

it('bounds reply tails and tool fields and excludes unanchored checkpoint items', () => {
  const saved: KodaXSessionData = { ...data, uiHistory: [
    ...Array.from({ length: 8 }, (_, index) => ({ type: 'assistant' as const, outputId: `draft-${index}`,
      text: `${'x'.repeat(1_300)}tail-${index}`, sourceRunId: 'run', afterInputId: 'input' })),
    { type: 'assistant', outputId: 'wrong', text: 'other branch', sourceRunId: 'run', afterInputId: 'missing' },
    { type: 'assistant', outputId: 'other-run', text: 'other run', sourceRunId: 'elsewhere' },
    { type: 'tool_group', sourceRunId: 'run', tools: [
      { id: 'long', name: 'bash', status: 'success', resultRecorded: true, preview: JSON.stringify({ command: 'a'.repeat(200) }), output: 'b'.repeat(200) },
      { id: 'legacy', name: 'read', status: 'error', resultRecorded: true, preview: 'legacy preview', error: 'error\nsecond line' },
      { id: 'no-preview', name: 'read', status: 'cancelled', executionBegan: true },
    ] },
  ] };
  const evidence = deriveInterruptedRunEvidence(saved, run)!;
  expect(evidence.replies).toHaveLength(6);
  expect(evidence.replies?.[0]).toMatchObject({ outputId: 'draft-2', truncated: true });
  expect(evidence.replies?.[0]?.text).toHaveLength(1_200);
  expect(evidence.operations[0]?.target).toHaveLength(120);
  expect(evidence.operations[0]?.result).toHaveLength(120);
  expect(evidence.operations[1]).toMatchObject({ target: 'legacy preview', result: 'error' });
  expect(evidence.operations[2]?.target).toBeUndefined();
});

it('anchors standalone evidence by a real turn and leaves empty or synthetic evidence out', () => {
  const standalone = { ...run, productInput: undefined, turnId: 'turn' };
  expect(deriveInterruptedRunEvidence(data, standalone)).toBeUndefined();
  const saved = { ...data, messages: [{ role: 'user' as const, content: 'work', turnId: 'turn', inputId: 'input' }] };
  expect(deriveInterruptedRunEvidence(saved, standalone)).toBeDefined();
  expect(deriveInterruptedRunEvidence({ ...saved, uiHistory: [] }, standalone)).toBeUndefined();
  expect(deriveInterruptedRunEvidence({ ...saved, messages: saved.messages.map(message => ({ ...message, _synthetic: true })) }, standalone)).toBeUndefined();
});
