import type { KodaXMessage } from '../../../packages/llm/src/types.js';

export interface FirstTurnCase {
  readonly id: string;
  readonly phase: 'pilot' | 'followup';
  readonly task: string;
  readonly priorMessages: readonly KodaXMessage[];
  readonly rubric: string;
}

/** One response per case. No generated tool call is executed. */
export const FIRST_TURN_CASES: readonly FirstTurnCase[] = [
  {
    id: 'trivial_answer', phase: 'pilot',
    task: '只回答这个独立问题：TypeScript 中 const 是否表示对象内部属性不能改变？请用两句话说明。',
    priorMessages: [],
    rubric: 'Answer accurately and briefly in Chinese; no todo, delegation, repository exploration or permission question. Judge actual tool calls, not mentions of tool names.',
  },
  {
    id: 'planned_parallel_review', phase: 'pilot',
    task: '审查两个相互独立的改动：src/auth.ts 的登录校验和 src/cache.ts 的过期清理，分别由两个子 agent 只读检查，最终由你整合。已确认文件存在且没有写任务；两个改动分别只影响各自模块，审查范围就是这两个文件，不需要先探索仓库来决定分工。先建立可追踪的审查计划，再按独立文件分工，结果回来后由你核对并总结。现在开始。',
    priorMessages: [],
    rubric: 'Commit a concise non-destructive plan or perform a justified bounded prerequisite. Do not fail healthy plan-first behavior because delegation needs the next response. If spawning, separate scopes and require readonly work/evidence; do not invent results or mark completion. Chinese visible task labels.',
  },
  {
    id: 'edit_recovery', phase: 'followup',
    task: '继续修复 src/retry.ts：把 maxAttempts 的默认值从 3 改成 5，保留别人的新增注释。刚才 edit 报 old_string not found，请根据已有证据选择下一步，不要重写整个文件。',
    priorMessages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read_retry', name: 'read', input: { path: 'src/retry.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read_retry', content: '1: // Preserve the caller retry policy.\n2: export const maxAttempts = 3;\n3: export const retryDelayMs = 100;' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'edit_retry', name: 'edit', input: { path: 'src/retry.ts', old_string: 'export const maxAttempts = 3;\nexport const retryDelayMs = 100;', new_string: 'export const maxAttempts = 5;\nexport const retryDelayMs = 100;' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit_retry', content: 'Error: old_string not found. File changed since read: an additional comment was inserted between the two exports.', is_error: true }] },
    ],
    rubric: 'Choose refreshed evidence or a smaller unique edit preserving unrelated text. No unchanged blind retry, whole-file write, fabricated success, premature blocked response or unnecessary new plan. A reread is healthy, not a missed edit.',
  },
  {
    id: 'resume_existing_plan', phase: 'followup',
    task: '继续先前任务：只修缓存到期比较的边界值并验证，保留已有计划；不要重新创建重复事项。',
    priorMessages: [
      { role: 'user', content: '<controlled_resume_summary>已完成侦察。已有 todo_1「确认到期边界」completed；todo_2「修复比较并验证」pending，属于当前 worker。src/cache.ts 第 8 行为 return now > expiresAt;，需求是到期瞬间也失效。文件本轮尚未读取。只需继续 todo_2；其他 agent 没有运行。此摘要没有给新工具授权。</controlled_resume_summary>', _synthetic: true },
    ],
    rubric: 'Reuse existing ids and inspect current state/evidence as needed. Do not destructive-init or duplicate todo_1/todo_2. Do not mark verified/completed before edit/test evidence. Compact/recovery history is controlled synthetic context, not a real compaction run.',
  },
];
