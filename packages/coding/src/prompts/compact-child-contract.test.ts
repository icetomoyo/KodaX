import { describe, expect, it } from 'vitest';
import type { KodaXToolDefinition } from '@kodax-ai/llm';
import { CHILD_AGENT_SYSTEM_PROMPT, CHILD_EXCLUDE_TOOLS_BASE } from '../child-executor.js';
import { filterExcludedTools, getActiveToolDefinitions } from '../agent-runtime/tool-resolution.js';
import { listToolDefinitions } from '../tools/index.js';
import { TOOL_RECOVERY_GUIDANCE } from './execution-guidance.js';
import { fitToolSchemasToContext } from '../agent-runtime/tool-exposure-planner.js';
import { buildCompactChildContractCandidate, projectBuiltinChildRequestContract } from './compact-child-contract.js';

function childContract(readOnly = true) {
  const names = filterExcludedTools(listToolDefinitions().map(tool => tool.name), [
    ...CHILD_EXCLUDE_TOOLS_BASE,
    ...(readOnly ? ['write', 'edit', 'multi_edit', 'insert_after_anchor', 'undo'] : []),
  ]);
  return { system: CHILD_AGENT_SYSTEM_PROMPT, tools: getActiveToolDefinitions(names, 'off')
    .map(({ name, description, input_schema }) => ({ name, description, input_schema })) };
}

// Annotation removal must not erase business fields named "description".
function constraints(value: unknown, properties = false): unknown {
  if (Array.isArray(value)) return value.map(item => constraints(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([name]) => properties || name !== 'description')
    .map(([name, item]) => [name, constraints(item, name === 'properties')]));
  return value;
}

describe('builtin child paired compact contract', () => {
  it('projects one proven base in the final request, preserving all runtime suffixes', () => {
    const canonical = childContract(false);
    const request = { ...canonical, system: 'Provider context\n' + canonical.system + '\n\nEffective permissions: readonly\nSkill contract.' };
    const expected = buildCompactChildContractCandidate(canonical, { source: 'builtin-child' });
    const source = { agentId: 'child', system: canonical.system };
    const result = projectBuiltinChildRequestContract(source, request, canonical.tools);
    expect(result.system).toBe('Provider context\n' + expected.system + '\n\nEffective permissions: readonly\nSkill contract.');
    expect(result.tools).toEqual(expected.tools);
    expect(projectBuiltinChildRequestContract(undefined, request, canonical.tools)).toBe(request);
    const partial = { ...request, tools: request.tools.filter(tool => tool.name !== 'web_search') };
    expect(projectBuiltinChildRequestContract(source, partial, canonical.tools)).toBe(partial);
    const fitted = { ...request, tools: fitToolSchemasToContext(canonical.tools,
      { contextWindow: 6000, systemTokens: 1000, reservedResponseTokens: 1000 }) };
    expect(fitted.tools.length).toBeLessThan(canonical.tools.length);
    expect(projectBuiltinChildRequestContract(source, fitted, canonical.tools)).toBe(fitted);
    const duplicate = { ...request, system: request.system + canonical.system };
    expect(projectBuiltinChildRequestContract(source, duplicate, canonical.tools)).toBe(duplicate);
    const missing = { ...request, system: 'Host replaced the entire system.' };
    expect(projectBuiltinChildRequestContract(source, missing, canonical.tools)).toBe(missing);
  });
  it.each([true, false])('pairs the actual child menu with retained system obligations, readonly=%s', readOnly => {
    const canonical = childContract(readOnly);
    const before = structuredClone(canonical);
    const candidate = buildCompactChildContractCandidate(canonical, { source: 'builtin-child' });
    expect(candidate).not.toBe(canonical);
    expect(candidate.tools.map(tool => tool.name)).toEqual(canonical.tools.map(tool => tool.name));
    expect(candidate.system).toContain(CHILD_AGENT_SYSTEM_PROMPT);
    expect(candidate.system).toContain(TOOL_RECOVERY_GUIDANCE);
    expect(candidate.system).toContain('final response MUST be text only');
    expect(candidate.system).toContain('SAME response');
    expect(candidate.system).toContain('distinct read-only lanes');
    expect(candidate.system).toContain('exclusive paths/generated outputs');
    expect(candidate.system).toContain('critical path');
    expect(candidate.system).toContain('one in_progress item per owner');
    expect(candidate.system).toContain('deliverables, not child Agents');
    expect(candidate.system).toContain('requested language');
    for (let index = 0; index < canonical.tools.length; index++) {
      expect(constraints(candidate.tools[index]!.input_schema), canonical.tools[index]!.name)
        .toEqual(constraints(canonical.tools[index]!.input_schema));
    }
    const spawn = candidate.tools.find(tool => tool.name === 'spawn_agent')!;
    expect(spawn.description).toContain('shared session concurrency/work budgets');
    expect(JSON.stringify(spawn)).toContain('parent permission ceiling');
    expect(JSON.stringify(spawn)).toContain('do not reapply');
    expect(candidate.tools.find(tool => tool.name === 'wait_agent')?.description).toContain('interruption');
    expect(JSON.stringify(candidate).length).toBeLessThan(JSON.stringify(canonical).length);
    expect(canonical).toEqual(before);
  });

  it('retains write-child project rules byte for byte and preserves read-only absence of mutations', () => {
    const rules = '\n\nProject rules apply to your mutations. Follow them as the parent agent would:\n# Project Context\nNever change files owned by another child.';
    const canonical = { ...childContract(false), system: CHILD_AGENT_SYSTEM_PROMPT + rules };
    const candidate = buildCompactChildContractCandidate(canonical, { source: 'builtin-child' });
    expect(candidate.system).toContain(CHILD_AGENT_SYSTEM_PROMPT + rules);
    const readonly = buildCompactChildContractCandidate(childContract(), { source: 'builtin-child' });
    expect(readonly.tools.some(tool => ['write', 'edit', 'undo'].includes(tool.name))).toBe(false);
  });

  it('fails closed for SDK overrides, specialized roles and unknown system instructions', () => {
    const canonical = childContract();
    expect(buildCompactChildContractCandidate(canonical, { source: 'sdk-override' })).toBe(canonical);
    expect(buildCompactChildContractCandidate(canonical, { source: 'specialist' })).toBe(canonical);
    expect(buildCompactChildContractCandidate(canonical, { source: 'builtin-child', specialistName: 'reviewer' })).toBe(canonical);
    for (const system of ['Custom system', CHILD_AGENT_SYSTEM_PROMPT + '\nUnknown extra rules']) {
      const custom = { ...canonical, system };
      expect(buildCompactChildContractCandidate(custom, { source: 'builtin-child' })).toBe(custom);
    }
  });

  it('preserves custom and incomplete tool contracts instead of applying a partial pair', () => {
    const canonical = childContract(false);
    const custom: KodaXToolDefinition = { ...canonical.tools.find(tool => tool.name === 'read')!, description: 'Host reader contract' };
    const changed = { ...canonical, tools: canonical.tools.map(tool => tool.name === 'read' ? custom : tool) };
    expect(buildCompactChildContractCandidate(changed, { source: 'builtin-child' })).toBe(changed);
    const missing = { ...canonical, tools: canonical.tools.filter(tool => tool.name !== 'read') };
    expect(buildCompactChildContractCandidate(missing, { source: 'builtin-child' })).toBe(missing);
    const duplicate = { ...canonical, tools: [...canonical.tools, canonical.tools[0]!] };
    expect(buildCompactChildContractCandidate(duplicate, { source: 'builtin-child' })).toBe(duplicate);
  });

  it('keeps tool-local recovery, authorization and provenance teaching without relying on root rules', () => {
    const canonical = childContract(false);
    const candidate = buildCompactChildContractCandidate(canonical, { source: 'builtin-child' });
    for (const [name, obligations] of Object.entries({
      read: ['line_offset', 'run-scoped', 'not network', 'already attached', 'read_pdf'],
      write: ['explicitly requested', 'existing changes: edit', 'stream-failed', 'skeleton', 'mutation/diff checks', 'UTF-8'],
      edit: ['Read first', 'unique in the whole current file', 'Later anchors', 'failure leaves file unchanged', 'never full-file rewrite'],
      bash: ['grep/glob', 'write/edit', 'not shell redirection/wrappers', 'run_in_background', 'recoverable artifact preview'],
      grep: ['literal:true', 'multiline', 'count', 'scan_offset', 'SOURCE_INCOMPLETE'],
      skill: ['discovered matching Skill', 'before responding', 'never read SKILL.md', 'template substitution'],
      memory_recall: ['current MemorySession-scoped', 'absent from current context', 'before unrelated repo exploration', 'facts require normal tools'],
      session_history_search: ['missing detail', 'do not guess', 'read needed hit', 'hit.entryRevision'],
      session_history_read: ['cited persisted entry', 'nextOffset', 'entryRevision', 'whole-history snapshot'],
      send_message: ['no new turn', 'idle retains', 'cycles', 'authenticates', 'cannot downgrade'],
      agent_output: ['controlled Actor/Turn', 'Never poll'],
      todo_update: ['before work', 'only after finishing', 'vetoed', 're-read and revise', 'Inactive store'],
      tool_call: ['Target policy, permissions and result guardrails reapply'],
      tool_search: ['Native tools callable directly', 'full active-tool contracts', 'Keep using returned schema'],
    })) {
      const tool = candidate.tools.find(item => item.name === name)!;
      const teaching = JSON.stringify(tool).toLowerCase();
      for (const obligation of obligations) expect(teaching, `${name}: ${obligation}`).toContain(obligation.toLowerCase());
    }
    expect(candidate.tools.find(tool => tool.name === 'memory_intent'))
      .toBe(canonical.tools.find(tool => tool.name === 'memory_intent'));
  });
});
