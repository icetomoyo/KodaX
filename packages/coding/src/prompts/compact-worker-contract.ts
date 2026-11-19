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
    `TRUST AND SCOPE\n${staticText("worker-compact.trust-and-scope")}${core.includes('run_workflow') ? ' (including run_workflow prompts)' : ''}. ${staticText("worker-compact.source-language")}`,
    `TASK AND PLAN\n${staticText("worker.answer-directly")}\n${staticText("worker-compact.plan.milestones")} ${PLAN_BATCH_GUIDANCE}\n${staticText("worker-compact.plan.dedup")} ${reader} ${staticText("worker-compact.plan.replanning")}`,
    `PARALLEL WORK\n${staticText("worker-compact.parallel-work")}`,
    ...(core.includes(specialistRule) ? ['When a registered specialist matches the task domain, use its canonical agent_id from list_dispatchable_agents.'] : []),
    repo,
    `EXECUTION, RECOVERY AND DELIVERY\n${mutation}\n${staticText("worker-compact.verification")}\n${TOOL_RECOVERY_GUIDANCE}\n${staticText("worker-compact.delivery")}`,
  ].join('\n\n');
}
