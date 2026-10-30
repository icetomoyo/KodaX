import { staticText } from './static-text.js';
import { isDeepStrictEqual } from 'node:util';
import type { Agent } from '@kodax-ai/agent';
import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type { KodaXContextOptions } from '../types.js';
import { buildWorkerStableInstructions } from '../agents/worker-role-prompt.js';
import { canProjectManagedToolContracts, projectManagedToolContract } from '../tools/managed-tool-contract.js';
import { projectModelToolDefinition } from '../tools/model-tool-definition.js';
import { getBuiltinToolDefinition, getRegisteredToolDefinition } from '../tools/registry.js';
import { getScriptModelContracts } from '../agent-runtime/script/model.js';
import { filterModelToolAliases } from '../agent-runtime/tool-resolution.js';
import { buildMemoryRulesSection } from './memory-rules.js';
import { SELF_KNOWLEDGE_ROUTING_RULE } from '../self-knowledge/routing-rule.js';
import { compactWorkerContract } from './compact-worker-contract.js';
import { WORKER_CLOSING_RULE, WORKER_WORKSPACE_DISCIPLINE } from '../task-engine/_internal/managed-task/role-prompt.js';

const requiredTools = ['read', 'write', 'edit', 'bash', 'grep', 'glob',
  'todo_create', 'todo_update', 'todo_list', 'spawn_agent', 'wait_agent',
  'send_message', 'followup_task', 'list_agents', 'agent_output', 'interrupt_agent'];

function replaceOnce(system: string, original: string, replacement: string): string {
  return system.split(original).length === 2 ? system.replace(original, () => replacement) : system;
}

const compactMemory = staticText("t12.prompts/managed-system-contract.0");

/** Project only a proven ordinary-root request, after final tool-schema fitting.
 * Canonical history and SDK instructions remain unchanged. Missing, shortened or
 * host-modified contracts retain their original teaching; no discovery is added.
 */
export function projectManagedSystemContract(agent: Agent, tools: readonly KodaXToolDefinition[],
  system: string, hostContext?: KodaXContextOptions): string {
  if (!canProjectManagedToolContracts(agent, hostContext)) return system;
  const script = getScriptModelContracts(agent, tools);
  if (agent.tools?.some(tool => tool.name === 'script_exec') && !script) return system;
  const effective = [...tools, ...script?.leaves.filter(tool => tool.name !== 'bash') ?? []];
  if (new Set(effective.map(tool => tool.name)).size !== effective.length) return system;
  const has = (name: string): boolean => {
    const actual = effective.find(tool => tool.name === name);
    const builtin = getBuiltinToolDefinition(name);
    if (!actual || !builtin || getRegisteredToolDefinition(name)?.source.kind !== 'builtin') return false;
    const expected = projectManagedToolContract(projectModelToolDefinition(builtin, { kind: 'builtin' }));
    return actual.description === expected.description && isDeepStrictEqual(actual.input_schema, expected.input_schema);
  };
  if (!requiredTools.every(has)) return system;
  const original = system.match(/MANAGED RUN CONTEXT TRUST:[\s\S]*?(?=\n\nWorkspace discipline:)/)?.[0];
  if (!original || system.split(original).length !== 2) return system;
  // Canonical factories may use the full contract or a capability-specific one.
  // Never replace custom Worker teaching just because it shares section markers.
  const names = filterModelToolAliases(agent.tools ?? []).map(tool => tool.name);
  if (original !== buildWorkerStableInstructions(names) && original !== buildWorkerStableInstructions()) return system;
  let projected = replaceOnce(system, original, compactWorkerContract(original));
  if (has('memory_intent') && has('memory_recall')) {
    projected = replaceOnce(projected, buildMemoryRulesSection('.'), compactMemory);
  }
  if (has('kodax_manual')) {
    projected = replaceOnce(projected, SELF_KNOWLEDGE_ROUTING_RULE,
      staticText("t12.prompts/managed-system-contract.1"));
  }
  // Preserve unknown-host guidance; only remove the duplicate command table
  // when the canonical environment already states the current platform/shell.
  if (/^## Environment\nWorking Directory:[\s\S]*?\nShell defaults: (Windows|Unix) shell\./.test(system)) {
    projected = replaceOnce(projected, WORKER_WORKSPACE_DISCIPLINE,
      staticText("t12.prompts/managed-system-contract.2"));
    projected = replaceOnce(projected, WORKER_CLOSING_RULE,
      staticText("t12.prompts/managed-system-contract.3"));
  }
  return projected;
}
