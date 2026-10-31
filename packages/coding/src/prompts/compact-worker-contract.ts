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
    `${staticText("merge.compact-worker.0")}${core.includes('run_workflow') ? ' (including run_workflow prompts)' : ''}${staticText("merge.compact-worker.1")}`,
    `${staticText("merge.compact-worker.2")}${PLAN_BATCH_GUIDANCE}${staticText("merge.compact-worker.3")}${reader}${staticText("merge.compact-worker.4")}`,
    staticText("merge.compact-worker.5"),
    ...(core.includes(specialistRule) ? ['Use a matching registered specialist via its canonical agent_id from list_dispatchable_agents.'] : []),
    repo,
    `${staticText("merge.compact-worker.6")}${mutation}${staticText("merge.compact-worker.7")}${TOOL_RECOVERY_GUIDANCE}${staticText("merge.compact-worker.8")}`,
  ].join('\n\n');
}
