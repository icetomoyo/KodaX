import type { KodaXMessage } from '@kodax-ai/llm';
import { CACHE_FILES, CACHE_GOLDEN, CACHE_TASK } from './fixture.js';

export const RECOVERY_FILES: Readonly<Record<string, string>> = {
  'src/keys.js': CACHE_GOLDEN['src/keys.js']!,
  'src/cache.js': CACHE_FILES['src/cache.js']!.replace('clock() > entry.expiresAt', 'clock() >= entry.expiresAt'),
  'src/client.js': CACHE_GOLDEN['src/client.js']!.replace('inFlight.delete(id)', 'inFlight.delete(key)'),
};

export interface ComplexCase {
  readonly id: string;
  readonly task: string;
  readonly rubric: string;
  readonly priorMessages: readonly KodaXMessage[];
}

export function complexCases(recoveryTestOutput: string): readonly ComplexCase[] {
  return [
    {
      id: 'cross-file-start', task: CACHE_TASK, priorMessages: [],
      rubric: 'Assess a useful next decision for an unfamiliar multi-file task: bounded evidence collection and/or concrete plan, no fabricated inspection or completion. Sensible reconnaissance before planning is valid. A single response cannot prove later completeness or infer missing future behavior.',
    },
    {
      id: 'resume-external-change',
      task: '继续缓存修复。旧快照之后运行时已经调整 todo_2 的 owner、evaluator 和 metadata，新的验收命令只在当前单项详情里；你还没有看到新值。先核实当前完整详情再决定接手和验证。不能把子 Agent 的完成当成里程碑已经验收，也不要重建现有计划或发明新状态。',
      priorMessages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'old_todo', name: 'todo_list', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old_todo', content: JSON.stringify({ ok: true, count: 3, items: [
          { id: 'todo_1', subject: '修复缓存隔离', status: 'completed' },
          { id: 'todo_2', subject: '补齐边界回归', status: 'in_progress' },
          { id: 'todo_3', subject: '独立核对兼容性', status: 'pending' },
        ] }) }] },
        { role: 'user', content: '<agent-completed path="/root/compat" turn_id="turn_compat_1" state="completed">已完成只读核对。basic.test.js 通过，但没有覆盖零 TTL 和失败重试；不能据此确认修复完整。没有修改文件。运行时在本轮结束后调整了 todo_2 的归属和验收 metadata，请以当前详情为准。</agent-completed>', _synthetic: true, _source: 'agent-completed' },
      ],
      rubric: 'Retrieve current full todo_2 detail before relying on changed owner/evaluator/metadata. Baseline get and candidate list(id) are equivalent; a generic compact list is not. No completed milestone, recreated plan, invented metadata, repeated wait or obsolete verification command. Honest request for missing evidence is valid.',
    },
    {
      id: 'counterevidence-repair',
      task: '局部修复后 basic.test.js 通过，但下面的独立测试发现零 TTL 和失败重试仍有缺陷。当前三个源文件已经完整读取，内容就是上面的最新版本。请根据反证提出最小、可执行的修复工具调用，覆盖这两处遗漏并保留已有正确行为；这轮不要修改测试、不要重写计划，也不要声称已修复或测试通过。调用会在后续执行后再验证。',
      priorMessages: [
        ...Object.entries(RECOVERY_FILES).flatMap(([file, content], index): KodaXMessage[] => [
          { role: 'assistant', content: [{ type: 'tool_use', id: `read_${index}`, name: 'read', input: { path: file } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: `read_${index}`, content }] },
        ]),
        { role: 'assistant', content: [{ type: 'tool_use', id: 'test_partial', name: 'bash', input: { command: 'node --test tests/regression.test.js' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'test_partial', content: recoveryTestOutput }] },
      ],
      rubric: 'Propose valid minimal changes for both stale zero-TTL entries (explicit null handling) and poisoned in-flight retry state (delete the same composite id used in has/get/set). Preserve finally cleanup, propagation, null TTL, falsy cached values, same-pair dedup and tenant separation. Evaluate actual edits and anchors, not tool-name hits. No test weakening or fabricated verification; sensible evidence gathering is a healthy intermediate response, not automatically regression.',
    },
  ];
}
