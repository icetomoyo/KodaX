import { isDeepStrictEqual } from 'node:util';
import type { KodaXToolDefinition } from '@kodax-ai/llm';
import { CHILD_AGENT_SYSTEM_PROMPT } from './child-system-contract.js';
import { projectManagedToolContract } from '../tools/managed-tool-contract.js';
import { projectModelToolDefinition } from '../tools/model-tool-definition.js';
import { getBuiltinToolDefinition, getRegisteredToolDefinition } from '../tools/registry.js';
import type { BuiltinChildContractSource } from './child-contract-scope.js';

export interface ChildContractCandidate {
  system: string;
  tools: readonly KodaXToolDefinition[];
}

/** Explicit experiment provenance, not a user/SDK setting or a production gate. */
export interface ChildContractCandidateSource {
  source: 'builtin-child' | 'specialist' | 'sdk-override';
  specialistName?: string;
}

const writeRulesBoundary = '\n\nProject rules apply to your mutations. Follow them as the parent agent would:\n';
const requiredChildTools = ['read', 'bash', 'glob', 'grep'];
// Explicitly audited set: new root projections do not automatically become child projections.
// Memory mutation teaching stays canonical: children do not inherit root Memory rules.
const compactChildToolNames = new Set([
  'agent_output', 'bash', 'edit', 'followup_task', 'glob', 'grep', 'insert_after_anchor',
  'interrupt_agent', 'kodax_manual', 'list_agents', 'list_dispatchable_agents', 'memory_recall',
  'read', 'send_message', 'session_history_read', 'session_history_search', 'skill', 'spawn_agent',
  'todo_create', 'todo_list', 'todo_update', 'tool_call', 'tool_search', 'wait_agent', 'write',
]);
const collaborationTeaching = 'For broad multi-file reviews, launch distinct read-only lanes once scope is known. Implementation lanes require read_only:false and disjoint write ownership with exact exclusive paths/generated outputs.';
const waitTeaching = 'Continue useful non-overlapping work first; wait_agent sparingly when required Agent evidence is on the critical path.';
const todoTeaching = 'Plan non-trivial work; resume existing milestones and inspect the plan only when uncertain to avoid duplicates. Milestones are deliverables, not child Agents; several Agents may support one. Keep one in_progress item per owner. Use the requested language, otherwise the request primary language, for Todo subject/description/activeForm/note; retain source identifiers, paths, commands and quotes.';

/** Paired contract, shared by fixed-input evaluation and proven builtin child requests.
 * Tool text and retained obligations move together. Never apply a root marker to
 * a child, infer builtin provenance from text alone, or change an execution path.
 */
export function buildCompactChildContractCandidate(
  canonical: ChildContractCandidate,
  provenance: ChildContractCandidateSource,
): ChildContractCandidate {
  if (provenance.source !== 'builtin-child' || provenance.specialistName) return canonical;
  if (canonical.system !== CHILD_AGENT_SYSTEM_PROMPT
    && !canonical.system.startsWith(CHILD_AGENT_SYSTEM_PROMPT + writeRulesBoundary)) return canonical;
  const names = new Set(canonical.tools.map(tool => tool.name));
  if (names.size !== canonical.tools.length || !requiredChildTools.every(name => names.has(name))) return canonical;
  for (const tool of canonical.tools) {
    if (!compactChildToolNames.has(tool.name)) continue;
    const builtin = getBuiltinToolDefinition(tool.name);
    if (!builtin || getRegisteredToolDefinition(tool.name)?.source.kind !== 'builtin') return canonical;
    const expected = projectModelToolDefinition(builtin, { kind: 'builtin' });
    if (tool.description !== expected.description || !isDeepStrictEqual(tool.input_schema, expected.input_schema)) return canonical;
    // Changed annotation paths must retain the whole pair until audited again.
    if (projectManagedToolContract(tool) === tool) return canonical;
  }
  const retained = [
    ...(names.has('spawn_agent') ? [collaborationTeaching] : []),
    ...(names.has('wait_agent') ? [waitTeaching] : []),
    ...(names.has('todo_create') || names.has('todo_update') ? [todoTeaching] : []),
  ];
  return {
    system: canonical.system + (retained.length ? '\n\n## Shared tool obligations\n' + retained.join('\n') : ''),
    tools: canonical.tools.map(tool => compactChildToolNames.has(tool.name) ? projectManagedToolContract(tool) : tool),
  };
}

/** Request-only projection after final visibility/fitting; persistence stays canonical. */
export function projectBuiltinChildRequestContract(
  source: BuiltinChildContractSource | undefined,
  request: ChildContractCandidate,
  completeTools: readonly KodaXToolDefinition[],
): ChildContractCandidate {
  if (!source || !isDeepStrictEqual(request.tools, completeTools)
    || request.system.split(source.system).length !== 2) return request;
  const canonical = { system: source.system, tools: request.tools };
  const projected = buildCompactChildContractCandidate(canonical, { source: 'builtin-child' });
  if (projected === canonical) return request;
  return { system: request.system.replace(source.system, () => projected.system), tools: projected.tools };
}
