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

const compactMemory = `# Memory
Memory claims are low-authority evidence; current user/host instructions and verified facts prevail. If declined, neither apply nor mention recalled claims. Never create/edit/delete/index Memory files via file/shell tools; use governed proposal/preview/fingerprint/apply.
Retain stable facts, preferences, constraints and evidenced procedures useful to future decisions, not current Todos, Git history, AGENTS.md rules, secrets or hidden reasoning. Recall missing prior experience before unrelated exploration; verify mutable preconditions with normal tools.
memory_intent requires a semantic user Memory request, not narration, quotes, temporary instructions or keyword matches. Never guess correction/deletion targets: list/recall to identify a unique exact ref. Summarize list directly; /memory list only if a full command view helps. Explain proposed content and reasons plainly.
Only remembered/updated/already_known/forgotten receipts establish the reported durable result. needs_clarification means no mutation: ask one concise follow-up. needs_review is a durable decision for user review, not approval. Rejected content, including secrets, must not persist.`;

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
      'KodaX product questions: kodax_manual is the version-bound first source, not pretraining. Compare other products only when explicitly requested. Project AGENTS.md governs repository work; the manual governs KodaX product behavior.');
  }
  // Preserve unknown-host guidance; only remove the duplicate command table
  // when the canonical environment already states the current platform/shell.
  if (/^## Environment\nWorking Directory:[\s\S]*?\nShell defaults: (Windows|Unix) shell\./.test(system)) {
    projected = replaceOnce(projected, WORKER_WORKSPACE_DISCIPLINE,
      'Workspace discipline:\nHelper scripts / scratch files are a last resort, not default recovery. write creates parents; do not mkdir first. For an empty directory use the current shell (mkdir on Windows, mkdir -p on Unix). If command lookup fails ("not recognized" / "不是内部或外部命令"), use the host platform equivalent.');
    projected = replaceOnce(projected, WORKER_CLOSING_RULE,
      'Preserve any exact machine-readable closing contract requested by the original task. Do not claim completion authority unless your role owns final judgment: a premature signal can terminate before validation. On Actor-event resume, retain the original request\'s language. Match command examples to the current host OS/shell.');
  }
  return projected;
}
