import { staticText } from './static-text.js';
import { PLAN_BATCH_GUIDANCE, TOOL_RECOVERY_GUIDANCE } from './execution-guidance.js';

/** Decisions and lifecycle only; the request projector verifies canonical tool coverage. */
export function compactWorkerContract(original: string): string {
  const repo = original.match(/REPO INTELLIGENCE TOOLS:[\s\S]*?(?=\n\n|$)/)?.[0];
  const mutation = original.match(/MUTATION DISCIPLINE:[\s\S]*?(?=\n\n|$)/)?.[0];
  if (!repo || !mutation) return original;
  const core = original.replace(repo, '');
  const reader = core.includes('todo_get(id)') ? 'todo_get(id)' : 'todo_list({id})';
  const specialistRule = '- SPECIALIST ROUTING: when a registered specialist Agent matches the task domain, use its canonical `agent_id` from `list_dispatchable_agents`.';
  return [
    `${staticText("t12i.prompts/compact-worker-contract.span.0")}${core.includes('run_workflow') ? ' (including run_workflow prompts)' : ''}. Code, identifiers, paths, commands and quoted evidence keep their source language.`,
    `${staticText("t12i.prompts/compact-worker-contract.span.1")}${PLAN_BATCH_GUIDANCE} Replanning preserves progress; delete off-plan items or cancel to retain history. Review/audit plans are report skeletons, not the work.
Before mid-task additions, check the visible plan for the same deliverable/artifact/file/module; parent summaries and narrower leaves are distinct. An empty initial plan needs no dedup read. Read only unknown/uncertain state; refresh an item with ${reader} only after possible external Actor/runtime changes (e.g. wait/resume), not ordinary consecutive turns.`,
    staticText("t11.prompts/compact-worker-contract.0"),
    ...(core.includes(specialistRule) ? ['Use a matching registered specialist via its canonical agent_id from list_dispatchable_agents.'] : []),
    repo,
    `EXECUTION, RECOVERY AND DELIVERY
${mutation}${staticText("t12i.prompts/compact-worker-contract.span.2")}${TOOL_RECOVERY_GUIDANCE}${staticText("t12i.prompts/compact-worker-contract.span.3")}`,
  ].join('\n\n');
}
