import { expect, it, vi } from 'vitest';
import type { FrozenInput } from './first-turn-eval-support.js';
import { ACTIVATION_LIMITS, activationBlindPacket, capturedActivationInput, controlledActivationInputs,
  plannedActivationCells, validateActivationExpansion, persistActivationResult, type ActivationRow } from './contract-activation.eval.js';
import { activationCommonEvidence } from './contract-activation.eval.js';
import { dispatchAfterPersistence } from './restructured-contract.eval.js';

const input = (system: string): FrozenInput => ({ system, messages: [{ role: 'user', content: '自然任务' }],
  tools: [{ name: 'todo_update', description: 'Current contract', input_schema: { type: 'object', properties: {} } }] });

it('stops another lane before a slow fatal-result persistence finishes while preserving the original write', async () => {
  const abort = new AbortController();
  let release!: () => void;
  const slowWrite = new Promise<void>(resolve => { release = resolve; });
  const persist = vi.fn(() => slowWrite), dispatch = vi.fn(async () => 'must not start');
  const pending = persistActivationResult(true, abort, persist);
  try {
    await expect(dispatchAfterPersistence(async () => undefined, () => abort.signal.aborted, dispatch)).rejects.toThrow('not dispatched');
    expect(abort.signal.aborted).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  } finally { release(); await pending; }
});

it('preregisters eight pilot, four DeepSeek and only six optional third-checkpoint cells', () => {
  const pilot = plannedActivationCells('pilot'), core = plannedActivationCells('expand'), expanded = plannedActivationCells('expand', true);
  expect(pilot).toHaveLength(8); expect(core).toHaveLength(4); expect(expanded).toHaveLength(10);
  expect(new Set(pilot.map(cell => cell.route))).toEqual(new Set(['zhipu-coding', 'kimi-code']));
  expect(core.every(cell => cell.route === 'deepseek')).toBe(true);
  expect(new Set([...pilot, ...expanded].map(cell => cell.id)).size).toBe(ACTIVATION_LIMITS.calls);
  expect(ACTIVATION_LIMITS).toEqual({ calls: 18, tokens: 1_200_000, usd: 1, output: 2048, timeoutMs: 120_000 });
});

it('blocks stopped, missing and mismatched blind reviews before any expansion', () => {
  expect(() => validateActivationExpansion({ packetHash: 'p', decision: 'stop', reason: 'Invalid task' }, 'p')).toThrow('stopped');
  expect(() => validateActivationExpansion(undefined, 'p')).toThrow('review');
  expect(() => validateActivationExpansion({ packetHash: 'old', decision: 'continue', reason: 'Reviewed' }, 'p')).toThrow('review');
  expect(() => validateActivationExpansion({ packetHash: 'p', decision: 'continue', reason: 'Reviewed', includeCapacity: 'yes' }, 'p')).toThrow('boolean');
  expect(validateActivationExpansion({ packetHash: 'p', decision: 'continue', reason: 'Reviewed' }, 'p')).toBe(false);
  expect(validateActivationExpansion({ packetHash: 'p', decision: 'continue', reason: 'Specific unresolved issue', includeCapacity: true }, 'p')).toBe(true);
});

it('holds real baseline messages constant while preserving actually captured candidate contracts', () => {
  const baseline = input('baseline-root'), candidate = { ...input('candidate-root'), messages: [{ role: 'user' as const, content: 'A different capture timestamp/path' }] };
  const pair = controlledActivationInputs(baseline, candidate);
  expect(pair.baseline).toEqual(baseline);
  expect(pair.candidate).toEqual({ ...candidate, messages: baseline.messages });
  expect(pair.candidate.messages).not.toBe(baseline.messages);
  expect(candidate.messages[0]!.content).toBe('A different capture timestamp/path');
});

it('requires the requested actual and normalized checkpoint to be unique and root-shaped', () => {
  const row = { phase: 'edit', step: 0, input: input('root') };
  const evidence = { summary: { mode: 'agent', externalModelCalls: 0 }, sourceHashes: { 'production.ts': 'frozen' }, inputs: [row], normalized: [row] };
  expect(capturedActivationInput(evidence, 'agent', 'edit', 0)).toEqual(row.input);
  expect(() => capturedActivationInput({ ...evidence, normalized: [row, row] }, 'agent', 'edit', 0)).toThrow('unique');
  expect(() => capturedActivationInput(evidence, 'script', 'edit', 0)).toThrow('identity');
  expect(() => capturedActivationInput({ ...evidence, inputs: [] }, 'agent', 'edit', 0)).toThrow('unique');
});

it('keeps treatment mapping, inputs and cost metadata out of the review packet', () => {
  const row: ActivationRow = { id: 'route-case-A', caseId: 'worktree-first-use-agent', route: 'zhipu-coding', label: 'A',
    result: { textBlocks: [{ type: 'text', text: '读取当前文件。' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn',
      usage: { inputTokens: 300, outputTokens: 9, totalTokens: 309 } }, error: null, facts: [], wallMs: 1234, actualUsd: 0.5, stop: false };
  const caseDetails = { id: 'worktree-first-use-agent' as const, task: '修复已有值', rubric: '合法下一步',
    commonEvidence: { facts: { workspace: 'shared-workspace' }, history: [{ role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: 'history-read', content: '{"status":"stale","entryId":"real-entry-42"}', is_error: true }] }] } };
  const packet = activationBlindPacket('pilot', [caseDetails], [row], []);
  const serialized = JSON.stringify(packet);
  expect(serialized).toContain('读取当前文件');
  expect(serialized).toContain('real-entry-42');
  expect(serialized).toContain('shared-workspace');
  expect(packet.responses[0]).not.toHaveProperty('facts');
  for (const forbidden of ['usage', 'inputTokens', 'actualUsd', 'wallMs', 'input_schema', 'inputs', 'mapping', 'baseline', 'candidate']) expect(serialized).not.toContain(forbidden);
});

it('retains only shared business history and facts without exposing synthetic teaching or mutating inputs', () => {
  const messages = [{ role: 'system' as const, content: 'Private root contract' },
    { role: 'user' as const, _synthetic: true, content: 'Private compact capacity teaching' },
    { role: 'user' as const, content: '核对原文' },
    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'search', name: 'session_history_search', input: { query: '兼容标签' } }] },
    { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'search', content: '{"entryId":"actual-persisted-entry"}' }] }];
  const before = structuredClone(messages);
  const evidence = activationCommonEvidence(messages, { activeNonRootTurns: 3 });
  expect(evidence.history).toHaveLength(3);
  expect(JSON.stringify(evidence)).toContain('actual-persisted-entry');
  expect(JSON.stringify(evidence)).not.toContain('Private');
  expect(evidence.facts).toEqual({ activeNonRootTurns: 3 });
  expect(messages).toEqual(before);
});
