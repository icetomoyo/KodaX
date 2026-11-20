import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  FEATURE_270_LAYER_2_CASE_IDS,
  FEATURE_270_LAYER_3_CASE_IDS,
  buildFeature270Layer2Input,
  buildFeature270Layer3Round2,
  buildFeature270TreatmentPrompt,
  feature270BaselinePrompt,
  feature270ToolsForArm,
  normalizeFeature270Actions,
  scoreFeature270Adaptation,
  scoreFeature270Layer2,
} from './cases.js';

describe('FEATURE_270 frozen behavioral cases', () => {
  it('freezes the preregistered Layer 2 and Layer 3 case sets', () => {
    expect(FEATURE_270_LAYER_2_CASE_IDS).toEqual([
      'solo', 'parallel', 'fresh_capacity', 'capacity', 'explicit_workflow', 'no_workflow',
    ]);
    expect(FEATURE_270_LAYER_3_CASE_IDS).toEqual([
      'contradictory_finding', 'unavailable_specialist', 'changed_premise',
    ]);
  });

  it('seeds capacity with arm-native production vocabulary and no hidden queue', () => {
    const baseline = buildFeature270Layer2Input('capacity', 'baseline');
    const treatment = buildFeature270Layer2Input('capacity', 'treatment');

    expect(JSON.stringify(baseline.priorMessages)).toContain('dispatch_child_task');
    expect(JSON.stringify(treatment.priorMessages)).toContain('spawn_agent');
    expect(JSON.stringify(treatment.priorMessages)).toContain('AgentLimitReached');
    expect(JSON.stringify(treatment.priorMessages)).not.toContain('queued-for-capacity');
  });

  it.each(['parallel', 'fresh_capacity', 'explicit_workflow', 'no_workflow'] as const)(
    'seeds %s after scope acquisition so Layer 2 isolates collaboration policy',
    (caseId) => {
      const baseline = buildFeature270Layer2Input(caseId, 'baseline');
      const treatment = buildFeature270Layer2Input(caseId, 'treatment');

      expect(baseline.priorMessages).toEqual(treatment.priorMessages);
      expect(JSON.stringify(treatment.priorMessages)).toContain('changed_scope');
      expect(JSON.stringify(treatment.priorMessages)).toContain('packages/api/auth.ts');
    },
  );

  it('pins the released baseline and reads treatment bytes from production builders', () => {
    const baseline = feature270BaselinePrompt();
    const treatment = buildFeature270TreatmentPrompt();
    const baselineHash = createHash('sha256').update(baseline, 'utf8').digest('hex');

    expect(baselineHash).toBe('7885ab741a007b7e43cfe140e36157d62d6179519c0a655a3f0853603cb9c036');
    expect(baseline).toContain('DISPATCH RULES (`dispatch_child_task` idle-yield model)');
    expect(treatment).toContain('Use sub-agents when parallel work would materially improve speed or quality.');
    expect(treatment).toContain('Use `run_workflow` only when the user explicitly requests a Workflow');
    expect(treatment).toContain('This session runs at most 3 child Agents at a time.');
    expect(treatment).not.toContain('emit at most');
    expect(treatment).not.toContain('DISPATCH_RUN_WORKFLOW_NUDGE');
  });

  it('uses exact released and current production tool definitions', () => {
    const baseline = feature270ToolsForArm('baseline');
    const treatment = feature270ToolsForArm('treatment', 'Review three independent dimensions.');
    const explicitTreatment = feature270ToolsForArm(
      'treatment',
      'Use the named scoped-review Workflow.',
    );
    expect(baseline.map((tool) => tool.name)).toEqual([
      'dispatch_child_task', 'run_workflow', 'send_message', 'task_stop', 'task_output',
    ]);
    expect(treatment.map((tool) => tool.name)).toEqual([
      'spawn_agent', 'send_message', 'followup_task', 'wait_agent',
      'list_agents', 'interrupt_agent', 'agent_output',
    ]);
    expect(explicitTreatment.map((tool) => tool.name)).toEqual([
      'spawn_agent', 'run_workflow', 'send_message', 'followup_task', 'wait_agent',
      'list_agents', 'interrupt_agent', 'agent_output',
    ]);
    expect(baseline.find((tool) => tool.name === 'dispatch_child_task')?.description)
      .toContain('prefer run_workflow instead');
    expect(treatment.find((tool) => tool.name === 'spawn_agent')?.description)
      .not.toContain('prefer run_workflow instead');
    const workflowDescription = explicitTreatment
      .find((tool) => tool.name === 'run_workflow')?.description;
    expect(workflowDescription).toContain('Do not call this tool for an ordinary review');
    expect(workflowDescription).toContain('For an explicitly requested review or audit Workflow');
    expect(workflowDescription).not.toContain('A review or audit combines');
  });

  it('injects arm-native production completion envelopes in Layer 3', () => {
    const treatment = buildFeature270Layer3Round2(
      'contradictory_finding',
      'treatment',
      '',
      [{ name: 'spawn_agent', input: { task_name: 'cache-review', objective: 'test' } }],
    );
    const baseline = buildFeature270Layer3Round2(
      'contradictory_finding',
      'baseline',
      '',
      [{ name: 'dispatch_child_task', input: { id: 'cache-review', objective: 'test' } }],
    );

    expect(treatment.userMessage).toContain(
      '<agent-completed path="/root/cache-review" turn_id="eval-turn-1" state="completed">',
    );
    expect(treatment.userMessage).toContain('token invalidation ordering');
    expect(treatment.userMessage).not.toContain('controlled-agent-event');
    expect(baseline.userMessage).toContain('<task-completed task_id="cache-review">');
  });
});

describe('FEATURE_270 mechanical observations', () => {
  it.each([
    ['spawn_agent({})', 'child_start'],
    ['{"name":"run_workflow","arguments":{}}', 'workflow'],
    ['<wait_agent>{}</wait_agent>', 'wait'],
    ['name: list_agents', 'list'],
  ])('covers the required tool-text syntax family: %s', (text, action) => {
    expect(normalizeFeature270Actions([], text).map((item) => item.action)).toContain(action);
  });

  it('normalizes cross-version names but never maps Workflow to child start', () => {
    const actions = normalizeFeature270Actions([
      { name: 'dispatch_child_task', input: { objective: 'security review' } },
      { name: 'spawn_agent', input: { objective: 'API review' } },
      { name: 'run_workflow', input: { manifest: { name: 'scoped-review' } } },
    ], '');

    expect(actions.map((item) => item.action)).toEqual([
      'child_start', 'child_start', 'workflow',
    ]);
  });

  it('scores structural Layer 2 decisions without negative regex assertions', () => {
    expect(scoreFeature270Layer2('solo', [], '')).toMatchObject({ passed: true });
    expect(scoreFeature270Layer2('parallel', [
      { name: 'spawn_agent', input: { objective: 'security' } },
      { name: 'spawn_agent', input: { objective: 'API compatibility' } },
    ], '')).toMatchObject({ passed: true });
    expect(scoreFeature270Layer2('fresh_capacity', [
      { name: 'spawn_agent', input: { objective: 'security' } },
      { name: 'spawn_agent', input: { objective: 'compatibility' } },
      { name: 'spawn_agent', input: { objective: 'tests' } },
    ], '')).toMatchObject({ passed: true });
    expect(scoreFeature270Layer2('fresh_capacity', [
      { name: 'spawn_agent', input: { objective: 'security' } },
      { name: 'spawn_agent', input: { objective: 'compatibility' } },
      { name: 'spawn_agent', input: { objective: 'tests' } },
      { name: 'spawn_agent', input: { objective: 'performance' } },
    ], '')).toMatchObject({ passed: false });
    expect(scoreFeature270Layer2('capacity', [
      { name: 'list_agents', input: {} },
    ], '')).toMatchObject({ passed: true });
    expect(scoreFeature270Layer2('explicit_workflow', [
      { name: 'run_workflow', input: { manifest: { name: 'scoped-review' } } },
    ], '')).toMatchObject({ passed: true });
    expect(scoreFeature270Layer2('no_workflow', [], 'I should not call run_workflow.')).toMatchObject({
      passed: true,
      confidence: 'structural-negative',
    });
  });

  it('requires a changed second-round objective, specialist, or topology', () => {
    const first = [{ name: 'spawn_agent', input: { task_name: 'security', objective: 'verify cache collision' } }];
    expect(scoreFeature270Adaptation(first, [
      { name: 'spawn_agent', input: { task_name: 'security', objective: 'verify cache collision' } },
    ])).toMatchObject({ revised: false });
    expect(scoreFeature270Adaptation(first, [
      { name: 'spawn_agent', input: { task_name: 'api', objective: 'audit invalidation ordering' } },
    ])).toMatchObject({ revised: true });
    expect(scoreFeature270Adaptation(first, [
      { name: 'list_agents', input: {} },
    ])).toMatchObject({ revised: true });
  });
});
