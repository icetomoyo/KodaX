/**
 * Language-continuity coverage (③) — Layer-1 guard that the "answer in the
 * user's language" rule is actually assembled into every response-producing
 * surface. The audited gap was that the rule lived only in the AMA Worker's
 * shared closing contract (role-prompt.ts) + the /workflow NL generator, so SA,
 * dispatch children, and run_workflow children had no such instruction. These
 * assertions pin the rule into: SA + AMA Worker (shared EXECUTION_GUIDANCE), the
 * Worker's dispatch-objective authoring, the child agent's own system prompt,
 * and the run_workflow tool description.
 */
import { describe, expect, it } from 'vitest';

import { EXECUTION_GUIDANCE } from './prompts/execution-guidance.js';
import { CHILD_AGENT_SYSTEM_PROMPT } from './child-executor.js';
import { buildWorkerInstructions } from './agents/worker-role-prompt.js';
import { BUILTIN_TOOL_DEFINITIONS } from './tools/tool-definitions.js';
import { renderAmaPatternPlaybook } from './orchestration/pattern-catalog.js';
import type { KodaXTaskRoutingDecision } from './types.js';

const decision: KodaXTaskRoutingDecision = {
  primaryTask: 'edit',
  workIntent: 'append',
  complexity: 'moderate',
  riskLevel: 'medium',
  harnessProfile: 'PLANNED',
  recommendedMode: 'implementation',
  recommendedThinkingDepth: 'medium',
  confidence: 0.7,
  reason: 'coverage test',
  requiresBrainstorm: false,
};

describe('language-continuity rule coverage (③)', () => {
  it('EXECUTION_GUIDANCE (shared by SA + AMA Worker) tells the agent to answer in the user request language', () => {
    expect(EXECUTION_GUIDANCE).toContain("primary natural language of the user's request");
  });

  it('the AMA Worker instructions carry both the response-language rule and the dispatch-objective-language rule', () => {
    const out = buildWorkerInstructions(decision, undefined, false);
    // via the embedded EXECUTION_GUIDANCE block
    expect(out).toContain("primary natural language of the user's request");
    // the Worker authors each child's objective in the user's language
    expect(out).toContain('DISPATCH OBJECTIVE LANGUAGE');
    expect(out).toContain("same natural language as the user's request");
  });

  it('keeps user-visible todo fields in the request language', () => {
    const out = buildWorkerInstructions(decision, undefined, false);
    const todoCreate = BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.name === 'todo_create');
    const todoUpdate = BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.name === 'todo_update');

    expect(out).toContain('TODO LANGUAGE');
    expect(out).toContain('`subject`, `description`, `activeForm`, and user-visible `note`');
    expect(todoCreate?.description).toContain('requested language, otherwise the request primary language');
    expect(todoUpdate?.description).toContain('requested language, otherwise the request primary language');
  });

  it('the child-agent system prompt tells the child to report in the objective language', () => {
    expect(CHILD_AGENT_SYSTEM_PROMPT).toContain('same natural language as the objective');
  });

  it('the run_workflow tool description tells the author to write child prompts in the user language', () => {
    const runWorkflow = BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.name === 'run_workflow');
    expect(runWorkflow).toBeDefined();
    expect(runWorkflow?.description).toContain("same natural language as the user's request");
  });

  it('keeps the dormant F274 catalog renderer plus optional telemetry schemas within 3,000 bytes', () => {
    const strategySchemas = BUILTIN_TOOL_DEFINITIONS
      .filter((tool) => tool.name === 'spawn_agent' || tool.name === 'followup_task')
      .map((tool) => tool.input_schema.properties?.quality_strategy);
    const bytes = Buffer.byteLength(
      `${renderAmaPatternPlaybook()}\n${JSON.stringify(strategySchemas)}`,
      'utf8',
    );

    expect(strategySchemas).toHaveLength(2);
    expect(bytes).toBeLessThanOrEqual(3_000);
  });
});
