import { buildWorkerInstructions } from '../agents/worker-role-prompt.js';
import type { KodaXTaskRoutingDecision } from '../types.js';
import { DEFERRED_TOOL_HINTS } from './deferred-tools.js';
import { getToolDefinition } from './registry.js';

const decision: KodaXTaskRoutingDecision = {
  primaryTask: 'edit',
  workIntent: 'append',
  complexity: 'moderate',
  riskLevel: 'medium',
  harnessProfile: 'PLANNED',
  recommendedMode: 'implementation',
  recommendedThinkingDepth: 'medium',
  confidence: 0.7,
  reason: 'planned route',
  requiresBrainstorm: false,
};

describe('FEATURE_259 prompt contracts', () => {
  it('keeps the resident workflow identity at least 60% smaller while full teaching stays discoverable', () => {
    const full = getToolDefinition('run_workflow')?.description ?? '';
    const resident = DEFERRED_TOOL_HINTS.run_workflow ?? '';
    expect(Buffer.byteLength(resident, 'utf8')).toBeLessThanOrEqual(
      Math.floor(Buffer.byteLength(full, 'utf8') * 0.4),
    );
    expect(resident).toContain('manifest + source');
    expect(resident).toContain('canonical Workflow actor path');
    expect(resident).not.toContain('background task_id');
    expect(resident).not.toContain('idle-yield');
    expect(resident).toContain('tool_search');
    expect(full).toContain('wf.pipeline');
    expect(full).toContain('outputSchema');
    expect(full).toContain('wf.workflow');
    expect(full).toContain('list_agents');
    expect(full).toContain('wait_agent');
    expect(full).toContain('interrupt_agent');
    expect(full).not.toContain('task_output');
    expect(full).not.toContain('task_stop');
  });

  it('keeps implementation metadata out of Worker-visible prose', () => {
    const prompt = buildWorkerInstructions(decision, undefined, false);
    expect(prompt).not.toMatch(/FEATURE_\d+/);
    expect(prompt).not.toMatch(/PLAN-FIRST CONTRACT \([^)]*v0\./);
    expect(prompt).toContain('Configured `fast`/`deep` tiers select their operator-mapped route');
  });

  it('keeps Agent lifecycle and user-visible plan granularity separate', () => {
    const waitDescription = getToolDefinition('wait_agent')?.description ?? '';
    const createDescription = getToolDefinition('todo_create')?.description ?? '';

    expect(waitDescription).toContain('reconcile the affected semantic plan milestone');
    expect(waitDescription).toContain('before waiting again');
    expect(createDescription).toContain('semantic milestone');
    expect(createDescription).toContain('Milestones are deliverables, not child Agents');
    expect(createDescription).toContain('several Agents may support one');
    expect(createDescription).not.toContain('natural anchor for the work each child will execute');
  });
});
