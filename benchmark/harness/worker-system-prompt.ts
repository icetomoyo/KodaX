/**
 * The managed Worker's prompt as one system string, for one-shot evals that call a provider directly.
 *
 * It renders the same role prompt, workspace block and capability sections a root Run sends. A real
 * Run splits this into a stable System prompt and a hidden run-context message; one-shot evals send
 * the combined text, so their prompt bytes are close to, but not identical with, a live request.
 */
import type { KodaXOptions } from '../../packages/coding/src/types.js';
import { buildCapabilityContextSections, workerStableCapabilityContent } from '../../packages/coding/src/prompts/capability-sections.js';
import { buildRunnerAgentChain } from '../../packages/coding/src/task-engine/_internal/managed-task/agent-chain.js';
import { createRolePrompt } from '../../packages/coding/src/task-engine/_internal/managed-task/role-prompt.js';
import { buildFallbackRoutingDecision } from '../../packages/coding/src/reasoning.js';

// Same split as runner-driven.ts: these sections ride in the stable System prompt.
const STABLE_SECTION_IDS = new Set(['project-agents', 'self-knowledge-routing', 'memory-rules', 'tool-construction']);

export async function buildWorkerSystemPrompt(options: KodaXOptions, task: string, isNewSession = true): Promise<string> {
  const executionCwd = options.context?.executionCwd ?? process.cwd();
  const gitRoot = options.context?.gitRoot ?? undefined;
  const sections = await buildCapabilityContextSections(options, isNewSession);
  const chain = buildRunnerAgentChain({ backups: new Map(), executionCwd, gitRoot });
  const availableToolNames = (chain.worker.tools ?? []).map(tool => tool.name);
  const stable = sections.filter(section => STABLE_SECTION_IDS.has(section.id));
  const dynamic = sections.filter(section => !STABLE_SECTION_IDS.has(section.id));
  return createRolePrompt('worker', task, buildFallbackRoutingDecision(task), undefined, undefined, 'kodax/role/worker', undefined, {
    originalTask: task,
    availableToolNames,
    workspace: { executionCwd, gitRoot, platform: process.platform, provider: options.provider, model: options.model },
    stableCapabilityContextBlock: stable.map(section => workerStableCapabilityContent(section, availableToolNames)).join('\n\n') || undefined,
    capabilityContextBlock: dynamic.map(section => section.content).join('\n\n') || undefined,
  });
}
