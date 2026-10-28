import type { KodaXMessage } from '../../packages/llm/src/types.js';

/** Experimental replacement only; production instructions are unchanged. */
export const CONTRACT_EVIDENCE_BASE = '- `read` first when the file is non-trivial. Copy anchors from current file content to avoid failed edits and retry rounds.';
export const CONTRACT_EVIDENCE_CANDIDATE = '- `read` non-trivial files before editing and copy anchors from current content. Establish relevant behavior and compatibility constraints from code, nearby documentation and tests. Batch independent missing evidence with these reads; reuse current evidence rather than adding a fixed discovery step.';

export function candidateEvidenceSystem(system: string): string {
  if (system.split(CONTRACT_EVIDENCE_BASE).length !== 2) throw new Error('Expected exactly one canonical mutation rule');
  return system.replace(CONTRACT_EVIDENCE_BASE, CONTRACT_EVIDENCE_CANDIDATE);
}

const source = `export function csvRow(values) {
  return values.map(value => String(value ?? '').replaceAll('"', '""')).join(',') + '\\r\\n';
}
`;
const contract = `# Export format
Rows end with CRLF. Null and undefined cells are empty; other values retain their text.
Fields containing a comma, quote, CR or LF are enclosed in double quotes; embedded quotes are doubled.
Ordinary fields stay unquoted for compatibility. No formula sanitization or locale conversion is performed.
`;
const tests = `import test from 'node:test';
import assert from 'node:assert/strict';
import { csvRow } from '../src/csv.js';
test('ordinary cells', () => assert.equal(csvRow(['a', 2, null]), 'a,2,\\r\\n'));
`;
export const EVIDENCE_CHECKPOINTS = [
  {
    id: 'missing-contract',
    prompt: 'CSV 导出的备注包含换行时，会被拆成两条记录。请修复并补测试，保持导出格式兼容。',
    project: 'Project: workspace\n  README.md\n  package.json\n  docs/\n    export-format.md\n  src/\n    csv.js\n  tests/\n    csv.test.js',
    history: [] as KodaXMessage[],
    rubric: 'Inspect implementation, relevant format contract and existing tests in the same response when paths are known. Static child review may be useful but does not excuse waiting for evidence the root can obtain now. Do not count an unrelated README read or a tool mention in prose as contract acquisition. Do not repair from guessed behavior.',
  },
  {
    id: 'evidence-ready',
    prompt: '请修复刚才定位到的 CSV 换行问题并补回归测试，保持导出格式兼容。',
    project: 'Project: workspace\n  README.md\n  package.json\n  docs/\n    export-format.md\n  src/\n    csv.js\n  tests/\n    csv.test.js',
    history: [
      { role: 'user', content: '先看看 CSV 导出换行异常涉及的实现和现有约定。' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'read-code', name: 'read', input: { path: 'src/csv.js' } },
        { type: 'tool_use', id: 'read-format', name: 'read', input: { path: 'docs/export-format.md' } },
        { type: 'tool_use', id: 'read-tests', name: 'read', input: { path: 'tests/csv.test.js' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'read-code', content: source, is_error: false },
        { type: 'tool_result', tool_use_id: 'read-format', content: contract, is_error: false },
        { type: 'tool_result', tool_use_id: 'read-tests', content: tests, is_error: false },
      ] },
      { role: 'assistant', content: '已读到当前完整实现、格式约定和已有测试。实现只替换了引号，没有按字段内容决定是否加外层引号；尚未修改文件或运行测试。' },
    ] as KodaXMessage[],
    rubric: 'Use the supplied current implementation, public format contract and tests to begin a targeted edit and regression coverage. Do not require another discovery/read-only round or repeat the same complete reads without conflicting evidence. Preserve CRLF, empty values and ordinary-field compatibility; do not invent unrelated requirements. Preserve legitimate plan/child use and do not preclaim tests passed.',
  },
] as const;
