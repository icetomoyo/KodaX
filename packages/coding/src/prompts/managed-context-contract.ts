import type { Agent } from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';
import type { KodaXContextOptions } from '../types.js';
import { canProjectManagedToolContracts } from '../tools/managed-tool-contract.js';
import { isManagedRunContextMessage } from '../task-engine/_internal/managed-task/managed-run-context.js';
import { buildWorkerActorCapacityContract } from '../agents/worker-role-prompt.js';

function projectActorCapacity(content: string, toolNames: readonly string[]): string {
  const matches = [...content.matchAll(/(^|\n)(ACTOR CAPACITY \(authoritative runtime fact\):[\s\S]*?)(?=\n\n|\n=== End Managed Run Context ===|$)/g)];
  if (matches.length !== 1) return content;
  const match = matches[0]!;
  const block = match[2]!;
  const snapshot = /^ACTOR CAPACITY \(authoritative runtime fact\):\n- This Actor tree has (\d+) total concurrency slots;[^\n]*\n- At this prompt snapshot, (\d+) non-root turns are active /.exec(block);
  if (!snapshot) return content;
  const total = Number(snapshot[1]), active = Number(snapshot[2]);
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isSafeInteger(active)) return content;
  if (buildWorkerActorCapacityContract({ maxConcurrentThreads: total, activeNonRootTurns: active }, toolNames) !== block) return content;
  const starts = Math.max(0, total - 1 - active);
  const projected = [
    'ACTOR CAPACITY (authoritative runtime fact):',
    `- This tree has ${total} total concurrency slots: root reserves one, leaving at most ${Math.max(0, total - 1)} active non-root Agents. Snapshot: ${active} active non-root turns; ${starts} child start slots available.`,
    `- HARD RUNTIME LIMIT FOR THIS ASSISTANT RESPONSE: emit at most ${starts} \`spawn_agent\` calls. Extra calls reject. If the task has more independent tracks, choose at most ${starts} now; keep others with root or as later refill waves after a terminal event. Never promise more starts than allowed.`,
    toolNames.includes('list_agents') ? '- Before a later multi-spawn wave, call `list_agents` for fresh capacity.'
      : '- Before another wave, use fresh runtime capacity evidence.',
  ].join('\n');
  return content.slice(0, match.index) + match[1] + projected + content.slice(match.index! + match[0].length);
}

/** Request view only: canonical envelopes, SDK and persistence retain their exact bytes. */
export function projectManagedContextContract(agent: Agent, messages: readonly KodaXMessage[],
  hostContext?: KodaXContextOptions): KodaXMessage[] {
  if (!canProjectManagedToolContracts(agent, hostContext)) return [...messages];
  const toolNames = (agent.tools ?? []).map(tool => tool.name);
  return messages.map(message => {
    if (message.role !== 'user' || message._synthetic !== true || !isManagedRunContextMessage(message)
      || typeof message.content !== 'string') return message;
    const content = projectActorCapacity(message.content, toolNames);
    return content === message.content ? message : { ...message, content };
  });
}
