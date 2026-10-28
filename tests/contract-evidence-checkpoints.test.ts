import { expect, it } from 'vitest';
import { buildWorkerStableInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import { CONTRACT_EVIDENCE_BASE, CONTRACT_EVIDENCE_CANDIDATE, candidateEvidenceSystem, EVIDENCE_CHECKPOINTS } from '../benchmark/datasets/contract-evidence-checkpoints.js';

it('changes only the existing mutation rule in the canonical worker contract', () => {
  const current = buildWorkerStableInstructions();
  const candidate = candidateEvidenceSystem(current);
  expect(candidate.replace(CONTRACT_EVIDENCE_CANDIDATE, CONTRACT_EVIDENCE_BASE)).toBe(current);
  expect(candidate).not.toContain('export-format.md');
  expect(candidate).not.toContain('CSV');
});

it('refuses missing or duplicated anchors instead of silently testing the wrong prompt', () => {
  expect(() => candidateEvidenceSystem('custom host instructions')).toThrow('exactly one');
  expect(() => candidateEvidenceSystem(`${CONTRACT_EVIDENCE_BASE}\n${CONTRACT_EVIDENCE_BASE}`)).toThrow('exactly one');
});

it('provides complete evidence only in the reuse checkpoint', () => {
  expect(EVIDENCE_CHECKPOINTS[0].history).toEqual([]);
  const history = EVIDENCE_CHECKPOINTS[1].history;
  const receipts = history.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
  expect(receipts.map(receipt => receipt.tool_use_id)).toEqual(['read-code', 'read-format', 'read-tests']);
  expect(receipts.every(receipt => receipt.is_error === false && typeof receipt.content === 'string' && receipt.content.length > 80)).toBe(true);
  expect(history.at(-1)?.content).toContain('尚未修改文件或运行测试');
});
