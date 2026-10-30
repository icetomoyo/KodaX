import { describe, expect, it } from 'vitest';
import { buildWorkerStableInstructions as currentWorkerInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import { TOOL_RECOVERY_GUIDANCE } from '../packages/coding/src/prompts/execution-guidance.js';
import { buildRestructuredWorkerContract, replayAuditedWorkerCheckpoint } from './restructured-worker-contract.js';

const baseTools = ['read', 'write', 'edit', 'bash', 'grep', 'glob',
  'todo_create', 'todo_update', 'todo_list', 'spawn_agent', 'wait_agent',
  'send_message', 'followup_task', 'list_agents', 'agent_output', 'interrupt_agent'];

const buildWorkerStableInstructions = (tools?: readonly string[]) =>
  replayAuditedWorkerCheckpoint(currentWorkerInstructions(tools));

describe('restructured Worker experiment', () => {
  it('does not infer executable tool variants from verbatim repository policy text', () => {
    const original = buildWorkerStableInstructions(baseTools);
    const repo = original.match(/REPO INTELLIGENCE TOOLS:[\s\S]*?(?=\n\n|$)/)![0];
    const augmented = `${repo}\n- Do not use todo_get(id), batch with \`multi_edit\`, or run_workflow.`;
    const candidate = buildRestructuredWorkerContract(original.replace(repo, augmented));
    expect(candidate).toContain(augmented);
    const decisions = candidate.replace(augmented, '');
    expect(decisions).toContain('refresh with todo_list({id})');
    expect(decisions).not.toContain('todo_get(id)');
    expect(decisions).not.toContain('multi_edit');
    expect(decisions).not.toContain('run_workflow');
  });

  it('places planning and direct execution before delegation without adding a discovery ritual', () => {
    const original = buildWorkerStableInstructions(baseTools);
    const candidate = buildRestructuredWorkerContract(original);
    expect(candidate).toContain('TASK AND PLAN');
    expect(candidate).toContain('before broad execution');
    expect(candidate).toContain('reuse it without recreating or restating it');
    expect(candidate).toContain('Trivial typo, single-line edit, single lookup or conversation: act directly without Todo');
    expect(candidate).toContain('ordinary consecutive turns need no refresh');
    expect(candidate).toContain('no later than the first substantive edit or dispatch');
    expect(candidate).toContain('same response as independent reads or dispatch');
    expect(candidate).toContain('Carry child-reported refusals and verification limits into the final synthesis');
    expect(candidate.indexOf('TASK AND PLAN')).toBeLessThan(candidate.indexOf('PARALLEL WORK'));
    expect(candidate).not.toContain('tool_search');
    expect(candidate.length).toBeLessThan(original.length * 0.75);
  });

  it('keeps strong parallel policy, write ownership and semantic milestone reconciliation', () => {
    const candidate = buildRestructuredWorkerContract(buildWorkerStableInstructions(baseTools));
    for (const obligation of [
      'same assistant response', 'Do not first perform all lanes serially',
      'root and siblings must not touch that write set',
      'stable target with no concurrent writer of its dependency surface',
      'Do not duplicate delegated work',
      'before starting another milestone, waiting again or delivering',
      'one supporting Agent finishing does not complete unfinished work or synthesis',
      'canonical paths and unresolved ownership',
    ]) expect(candidate).toContain(obligation);
  });

  it('keeps original refusal recovery and genuine rendered verification rather than code-only success', () => {
    const candidate = buildRestructuredWorkerContract(buildWorkerStableInstructions(baseTools));
    expect(candidate).toContain(TOOL_RECOVERY_GUIDANCE);
    expect(candidate).toContain('visual-review');
    expect(candidate).toContain('actual rendered content');
    expect(candidate).toContain('Source, paths, render success and child completion are insufficient');
    expect(candidate).toContain('content, calculation, behavior and audio checks');
    expect(candidate).toContain('session-scoped .agent/tmp/sessions/');
    expect(candidate).toContain('Never use the project root');
    expect(candidate).toContain('not re-probed');
  });

  it.each([
    { profile: 'Agent', tools: baseTools },
    { profile: 'legacy Todo reader', tools: [...baseTools, 'todo_get'] },
    { profile: 'Coding', tools: [...baseTools, 'module_context', 'relationship_scan', 'changed_scope', 'changed_diff', 'lsp_incoming_calls'] },
    { profile: 'specialist and workflow', tools: [...baseTools, 'list_dispatchable_agents', 'run_workflow'] },
  ])('retains the exact capability-dependent repository policy and optional obligations: $profile', ({ tools }) => {
    const original = buildWorkerStableInstructions(tools);
    const repo = original.match(/REPO INTELLIGENCE TOOLS:[\s\S]*?(?=\n\n|$)/)?.[0];
    expect(repo).toBeTruthy();
    const candidate = buildRestructuredWorkerContract(original);
    expect(candidate).not.toBe(original);
    expect(candidate).toContain(repo);
    expect(candidate.includes('todo_get(id)')).toBe(tools.includes('todo_get'));
    expect(candidate.includes('list_dispatchable_agents')).toBe(tools.includes('list_dispatchable_agents'));
    expect(candidate.includes('run_workflow')).toBe(tools.includes('run_workflow'));
  });

  it('leaves unknown, partial, duplicated or host-augmented Worker teaching unchanged', () => {
    const original = buildWorkerStableInstructions(baseTools);
    for (const unsupported of [
      currentWorkerInstructions(baseTools),
      '', 'Host-specific system policy', buildWorkerStableInstructions(['read']),
      `${original}\nHost says: retain this added obligation.`, `${original}\n\n${original}`,
      original.replace('Trivial tasks', 'Unreviewed custom tasks'),
      original.replace('DISPATCH OBJECTIVE LANGUAGE:', 'DISPATCH OBJECTIVE LANGUAGE: New unreviewed obligation.'),
      original.replace('before starting the next item', 'only at the end of the task'),
    ]) expect(buildRestructuredWorkerContract(unsupported)).toBe(unsupported);
  });

  it('supports the canonical all-capability and legacy batch-edit forms without losing their exact Repo policies', () => {
    const all = buildWorkerStableInstructions();
    const legacy = buildWorkerStableInstructions(baseTools.filter(tool => tool !== 'edit').concat('multi_edit'));
    for (const original of [all, legacy]) {
      expect(buildRestructuredWorkerContract(original)).not.toBe(original);
      expect(buildRestructuredWorkerContract(original)).toContain(original.match(/REPO INTELLIGENCE TOOLS:[\s\S]*?(?=\n\n|$)/)![0]);
    }
    expect(buildRestructuredWorkerContract(legacy)).toContain('batch same-file edits with multi_edit');
  });
});
