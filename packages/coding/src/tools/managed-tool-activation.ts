import { isDeepStrictEqual } from 'node:util';
import type { Agent } from '@kodax-ai/agent';
import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import type { KodaXContextOptions } from '../types.js';
import { canProjectManagedToolContracts, projectManagedToolContract } from './managed-tool-contract.js';
import { getRegistryManagedAgentContext, projectModelToolDefinition } from './model-tool-definition.js';
import { getBuiltinToolDefinition, getRegisteredToolDefinition } from './registry.js';
import { resolveToolBridgeTarget } from './tool-bridge.js';
import { normalizeSkillToolName } from './skill.js';

export interface ManagedToolActivationFacts {
  /** Only the owning Run can establish this from a complete product-owner snapshot. */
  readonly visualSnapshotEmpty?: boolean;
}

function observedCalls(messages: readonly KodaXMessage[]): ReadonlySet<string> {
  const pending = new Map<string, { name: string; input: Record<string, unknown> }>();
  const observed = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool_use') pending.set(block.id, { name: block.name, input: block.input ?? {} });
      else if (message.role === 'user' && block.type === 'tool_result') {
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        pending.delete(block.tool_use_id);
        observed.add(call.name);
        const target = resolveToolBridgeTarget({ id: block.tool_use_id, ...call });
        const effective = target?.ok ? target.call : call;
        observed.add(effective.name);
        if (effective.name === 'tool_search' && typeof effective.input?.query === 'string'
          && effective.input.query.trim().startsWith('select:')) {
          for (const name of effective.input.query.trim().slice(7).split(/[,\s]+/)) observed.add(name);
        }
        if (effective.name === 'skill' && typeof effective.input?.skill === 'string'
          && normalizeSkillToolName(effective.input.skill) === 'visual-review'
          && getRegisteredToolDefinition('skill')?.source.kind === 'builtin') observed.add('visual-review');
      }
    }
  }
  return observed;
}

function hasImage(messages: readonly KodaXMessage[]): boolean {
  return messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'
    || (block.type === 'tool_result' && Array.isArray(block.content) && block.content.some(part => part.type === 'image'))));
}

function canonical(tool: KodaXToolDefinition): boolean {
  const builtin = getBuiltinToolDefinition(tool.name);
  if (!builtin || getRegisteredToolDefinition(tool.name)?.source.kind !== 'builtin') return false;
  const expected = projectManagedToolContract(projectModelToolDefinition(builtin, { kind: 'builtin' }));
  return tool.description === expected.description && isDeepStrictEqual(tool.input_schema, expected.input_schema);
}

/** Standard object signatures only; unfamiliar schema semantics keep their native definition. */
function flatContract(tool: KodaXToolDefinition): string | undefined {
  const schema = tool.input_schema;
  if (schema.type !== 'object' || Object.keys(schema).some(key => !['type', 'properties', 'required'].includes(key))) return;
  const required = new Set(schema.required ?? []), fields: string[] = [];
  if ([...required].some(name => !(name in schema.properties))) return;
  for (const [name, raw] of Object.entries(schema.properties)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const field = raw as Record<string, unknown>;
    if (Object.keys(field).some(key => !['type', 'enum', 'description'].includes(key))
      || !['string', 'boolean', 'number'].includes(String(field.type))
      || (field.description !== undefined && typeof field.description !== 'string')) return;
    if (field.enum !== undefined && (!Array.isArray(field.enum) || field.enum.length === 0
      || !field.enum.every((value: unknown) => typeof value === field.type))) return;
    const type = Array.isArray(field.enum) ? field.enum.map((value: unknown) => JSON.stringify(value)).join(' | ') : String(field.type);
    const comment = typeof field.description === 'string' ? ` // ${field.description.replace(/[\r\n]+/g, ' ')}` : '';
    fields.push(`  ${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${type};${comment}`);
  }
  return `${tool.name}: ${tool.description}\ninput: {\n${fields.join('\n')}\n}`;
}

/** Ordinary-root request view only. Execution and discovery inventories remain untouched. */
export function projectManagedToolActivation(agent: Agent, tools: readonly KodaXToolDefinition[],
  context?: KodaXContextOptions, messages: readonly KodaXMessage[] = [],
  facts: ManagedToolActivationFacts = {}): readonly KodaXToolDefinition[] {
  if (!canProjectManagedToolContracts(agent, context)
    || !['tool_call', 'tool_search'].every(name => tools.some(tool => tool.name === name && canonical(tool)))) return tools;
  const compact = new Map<string, string>(), hidden = new Set<string>();
  const observed = observedCalls(messages);
  for (const tool of tools) {
    if (!['worktree_create', 'worktree_remove', 'session_history_read'].includes(tool.name) || !canonical(tool)
      || observed.has(tool.name) || (tool.name === 'session_history_read' && observed.has('session_history_search'))) continue;
    const contract = flatContract(tool);
    if (contract !== undefined) compact.set(tool.name, contract);
  }
  const visualActivated = hasImage(messages)
    || ['visual_history', 'visual_inspect', 'visual_read_pixels', 'visual-review'].some(name => observed.has(name))
    || (context?.skillInvocation?.name !== undefined && normalizeSkillToolName(context.skillInvocation.name) === 'visual-review');
  if (facts.visualSnapshotEmpty === true && !visualActivated) {
    for (const tool of tools) if (['visual_inspect', 'visual_read_pixels'].includes(tool.name) && canonical(tool)) hidden.add(tool.name);
  }
  const mode = (context?.resolveShellPermissionMode ?? getRegistryManagedAgentContext(agent)?.resolveShellPermissionMode)?.();
  const inactivePlan = mode !== undefined && mode !== 'plan'
    && tools.some(tool => tool.name === 'exit_plan_mode' && canonical(tool));
  if (!compact.size && !hidden.size && !inactivePlan) return tools;
  return tools.filter(tool => !compact.has(tool.name) && !hidden.has(tool.name)
    && !(inactivePlan && tool.name === 'exit_plan_mode')).map(tool => tool.name === 'tool_call' && compact.size
    ? { ...tool, description: tool.description
      + '\nDirect contracts below: call tool_call({name,input}) with the stated input object; no discovery is required. Policies, permissions and shared budgets still apply.\n'
      + [...compact.values()].join('\n\n') }
    : tool.name === 'tool_search' && hidden.size ? { ...tool, description: tool.description
      + '\nVisual detail tools: visual_inspect inspects accepted image regions; visual_read_pixels measures original raster samples. '
      + 'Read a local image or use visual_history for its observationId first. Detail parameters appear after image/visual Skill evidence; '
      + 'select:NAME also supplies the full contract for tool_call when needed.' } : tool);
}
