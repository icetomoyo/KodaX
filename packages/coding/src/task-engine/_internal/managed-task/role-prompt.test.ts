import { describe, expect, it } from 'vitest';
import { createRolePrompt } from './role-prompt.js';
import { resolveRoleRuntimeStateContext } from './role-prompts.js';
import {
  buildFallbackRoutingDecision,
  type ReasoningPlan,
} from '../../../reasoning.js';
import type { KodaXRepoRoutingSignals } from '../../../types.js';
import { applyCurrentDiffReviewRoutingFloor } from './review-routing.js';
import type { ManagedRolePromptContext } from './role-prompt-types.js';

const userQuestion = '你底层用的是什么模型？';

function buildContext(
  overrides: Partial<NonNullable<ManagedRolePromptContext['workspace']>> = {},
): ManagedRolePromptContext {
  return {
    originalTask: userQuestion,
    workspace: {
      executionCwd: 'C:\\Works\\GitWorks\\KodaX-author\\KodaX',
      platform: 'win32',
      osRelease: '10.0.19045',
      ...overrides,
    },
  };
}

// FEATURE_193 v0.7.43: callScout renamed to callWorker and role changed from 'scout' to 'worker' (V1 chain retired)
function callWorker(ctx: ManagedRolePromptContext): string {
  const decision = buildFallbackRoutingDecision(userQuestion);
  return createRolePrompt(
    'worker',
    userQuestion,
    decision,
    undefined,
    undefined,
    'kodax/role/worker',
    undefined,
    ctx,
    undefined,
    false,
  );
}

describe('createRolePrompt — runtime identity in workspace section', () => {
  it('presents each routing fact once while retaining assurance and the current task on resume', () => {
    const decision = buildFallbackRoutingDecision(userQuestion);
    for (const mode of ['combined', 'context'] as const) {
      const rendered = createRolePrompt(
        'worker', 'Continue from the saved milestone.', decision,
        undefined, undefined, 'kodax/role/worker', undefined,
        buildContext(), undefined, false, mode,
      );
      expect(rendered.match(/(?:^|\n)(?:- )?Primary task:/g)).toHaveLength(1);
      expect(rendered.match(/(?:^|\n)(?:- )?Risk:/g)).toHaveLength(1);
      expect(rendered).toContain(`Assurance intent: ${decision.assuranceIntent ?? 'default'}`);
      expect(rendered).toContain('Current round instructions:\nContinue from the saved milestone.');
    }
  });

  it('guides a restricted Worker using only its available repository tools without losing review scope or fallback', () => {
    const decision = {
      ...buildFallbackRoutingDecision('Review the requested changes.'),
      primaryTask: 'review' as const,
      reviewScale: 'large' as const,
      reviewTarget: 'current-worktree' as const,
    };
    for (const agent of ['kodax/role/worker', 'root/review-child']) {
      for (const availableToolNames of [[], ['read', 'grep', 'module_context']] as const) {
        const ctx = {
          ...buildContext(), availableToolNames,
          actorCapacity: { maxConcurrentThreads: 4, activeNonRootTurns: 0 },
        };
        const render = (mode: 'stable' | 'context') => createRolePrompt(
          'worker', 'Review the requested changes.', decision,
          undefined, undefined, agent, undefined, ctx, undefined, false, mode,
        );
        const firstRequest = `${render('stable')}\n${render('context')}`;
        for (const unavailable of ['changed_scope', 'changed_diff_bundle', 'symbol_context', 'relationship_scan']) {
          expect(firstRequest).not.toContain(`\`${unavailable}`);
        }
        for (const unavailable of ['todo_create', 'todo_update', 'todo_get', 'todo_list', 'spawn_agent', 'wait_agent', 'send_message', 'followup_task', 'interrupt_agent', 'list_agents', 'agent_output']) {
          expect(firstRequest.includes(unavailable), `${agent}: unavailable ${unavailable}`).toBe(false);
        }
        expect(firstRequest).not.toContain('start at least 2 distinct read-only review Agents');
        expect(firstRequest.includes('`module_context`')).toBe(availableToolNames.length > 0);
        expect(firstRequest).toContain('requested scope');
        expect(firstRequest).toContain('read/grep');
        expect(firstRequest).toContain('verify the requested result');
        expect(firstRequest).not.toContain('run_workflow');
        expect(resolveRoleRuntimeStateContext(ctx)).toBeUndefined();
      }
    }
  });

  it('emits Provider and Model lines when both are supplied', () => {
    const rendered = callWorker(
      buildContext({ provider: 'ark-coding', model: 'glm-5.2' }),
    );
    expect(rendered).toContain('Provider: ark-coding');
    expect(rendered).toContain('Model: glm-5.2');
  });

  it('places Provider/Model inside the ## Environment block (not elsewhere)', () => {
    const rendered = callWorker(
      buildContext({ provider: 'kimi-code', model: 'kimi-for-coding' }),
    );
    const envIdx = rendered.indexOf('## Environment');
    const providerIdx = rendered.indexOf('Provider: kimi-code');
    const modelIdx = rendered.indexOf('Model: kimi-for-coding');
    const shellIdx = rendered.indexOf('Shell defaults:');
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(providerIdx).toBeGreaterThan(envIdx);
    expect(modelIdx).toBeGreaterThan(envIdx);
    // Sanity: runtime fact comes before the shell-defaults guidance,
    // matching the proximity assumption in the role-prompt source.
    expect(providerIdx).toBeLessThan(shellIdx);
    expect(modelIdx).toBeLessThan(shellIdx);
  });

  it('omits Provider line when provider is absent', () => {
    const rendered = callWorker(buildContext({ model: 'glm-5.2' }));
    expect(rendered).not.toMatch(/^Provider:/m);
    expect(rendered).toContain('Model: glm-5.2');
  });

  it('omits Model line when model is absent', () => {
    const rendered = callWorker(buildContext({ provider: 'ark-coding' }));
    expect(rendered).toContain('Provider: ark-coding');
    expect(rendered).not.toMatch(/^Model:/m);
  });

  it('emits neither when workspace lacks both fields (legacy callers unaffected)', () => {
    const rendered = callWorker(buildContext());
    expect(rendered).not.toMatch(/^Provider:/m);
    expect(rendered).not.toMatch(/^Model:/m);
    // Sanity: the rest of the workspace block still renders.
    expect(rendered).toContain('## Environment');
    expect(rendered).toContain('Working Directory:');
    expect(rendered).toContain('Platform: Windows');
  });

  it('keeps Session Scratch Directory in dynamic context while preserving stable discipline', () => {
    const scratchDir = 'C:\\Works\\GitWorks\\KodaX-author\\KodaX\\.agent\\tmp\\sessions\\session-1';
    const ctx = buildContext({ scratchDir });
    const decision = buildFallbackRoutingDecision(userQuestion);
    const render = (mode: 'stable' | 'context') => createRolePrompt(
      'worker',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/worker',
      undefined,
      ctx,
      undefined,
      false,
      mode,
    );
    const rendered = callWorker(ctx);
    const stable = render('stable');
    const dynamic = render('context');

    expect(rendered).toContain(`Session Scratch Directory: ${scratchDir}`);
    expect(stable).not.toContain(scratchDir);
    expect(dynamic).toContain(`Session Scratch Directory: ${scratchDir}`);
    expect(stable).toContain('use the Session Scratch Directory named in Managed Run Context');
    expect(rendered).toContain('Do not write directly in the shared `.agent/tmp/` root.');
  });

  // FEATURE_193 v0.7.43: emits identity facts for non-Scout roles (Generator) it deleted (V1 generator role retired)
});

// FEATURE_193 v0.7.43: FEATURE_107 Generator reasoning discipline describe deleted (V1 generator role retired)

// FEATURE_144 (v0.7.35.1): AMA worker capability-context parity. Each
// role MUST receive the 6 SA-path sections that v0.7.26 FEATURE_084
// dropped during the Runner-driven migration: mcp-capability-context,
// skills-addendum, project-agents (AGENTS.md / CLAUDE.md), tool-
// construction, git-context, project-snapshot.
//
// The runner pre-computes these via `buildCapabilityContextSections()`
// once per AMA entry and threads the joined block onto
// `ManagedRolePromptContext.capabilityContextBlock`. This test asserts
// (a) the block is rendered when present, (b) contract-critical context
// precedes the potentially large block so hard-capping cannot remove the
// task contract first, (c) it is omitted cleanly when absent, and
// (d) the 5 sections that ride on other Runner paths are NOT in this
// block (they would otherwise duplicate).
describe('FEATURE_144 — AMA worker capability-context parity', () => {
  // FEATURE_193 v0.7.43: renderRole role type trimmed from scout|planner|generator to worker (V1 chain retired)
  function renderRole(
    role: 'worker',
    capabilityContextBlock: string | undefined,
    renderMode: 'combined' | 'context' = 'combined',
  ): string {
    const decision = buildFallbackRoutingDecision(userQuestion);
    const base = buildContext({ provider: 'p', model: 'm' });
    const ctx: ManagedRolePromptContext = {
      ...base,
      capabilityContextBlock,
    };
    return createRolePrompt(
      role,
      userQuestion,
      decision,
      undefined,
      undefined,
      `kodax/role/${role}`,
      undefined,
      ctx,
      undefined,
      false,
      renderMode,
    );
  }

  // FEATURE_193 v0.7.43: roles array trimmed from ['scout','planner','generator'] to ['worker'] (V1 chain retired)
  // FEATURE_184 (v0.7.45) Phase C.3: 'evaluator' removed — in-chain Evaluator retired.
  const roles = ['worker'] as const;

  it('keeps stable project rules in System while volatile capability facts stay in context', () => {
    const decision = buildFallbackRoutingDecision(userQuestion);
    const ctx: ManagedRolePromptContext = {
      ...buildContext({ provider: 'p', model: 'm' }),
      stableCapabilityContextBlock: 'PROJECT_AGENTS_STABLE_RULE',
      capabilityContextBlock: 'MCP_DYNAMIC_FACT',
    };
    const render = (mode: 'stable' | 'context') => createRolePrompt(
      'worker',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/worker',
      undefined,
      ctx,
      undefined,
      false,
      mode,
    );

    expect(render('stable')).toContain('PROJECT_AGENTS_STABLE_RULE');
    expect(render('stable')).not.toContain('MCP_DYNAMIC_FACT');
    expect(render('context')).toContain('MCP_DYNAMIC_FACT');
    expect(render('context')).not.toContain('PROJECT_AGENTS_STABLE_RULE');
  });

  it('partitions every managed Worker field between stable rules and dynamic context', () => {
    const decision = buildFallbackRoutingDecision('ROUND_QUERY_SENTINEL');
    const ctx: ManagedRolePromptContext = {
      originalTask: 'ORIGINAL_QUERY_SENTINEL',
      workspace: {
        executionCwd: 'C:\\STABLE_WORKSPACE_SENTINEL',
        platform: 'win32',
      },
      stableCapabilityContextBlock: 'PROJECT_RULE_SENTINEL',
      capabilityContextBlock: 'DYNAMIC_CAPABILITY_SENTINEL',
      teamModeSection: 'TEAM_STATE_SENTINEL',
      actorCapacity: { maxConcurrentThreads: 4, activeNonRootTurns: 1 },
      skillInvocation: {
        name: 'SKILL_NAME_SENTINEL',
        path: 'skill/sentinel',
        expandedContent: 'SKILL_CONTENT_SENTINEL',
      },
    };
    const render = (mode: 'stable' | 'context') => createRolePrompt(
      'worker',
      'ROUND_QUERY_SENTINEL',
      decision,
      {
        summary: 'VERIFICATION_SENTINEL',
        requiredEvidence: ['EVIDENCE_SENTINEL'],
      },
      {
        summary: 'TOOL_POLICY_SENTINEL',
        allowedTools: ['read'],
      },
      'AGENT_IDENTITY_SENTINEL',
      { metadataSentinel: 'METADATA_SENTINEL' },
      ctx,
      undefined,
      false,
      mode,
    );

    const stable = render('stable');
    const dynamic = render('context');
    for (const marker of [
      'C:\\STABLE_WORKSPACE_SENTINEL',
      'PROJECT_RULE_SENTINEL',
      'AGENT_IDENTITY_SENTINEL',
    ]) {
      expect(stable).toContain(marker);
      expect(dynamic).not.toContain(marker);
    }
    for (const marker of [
      'ROUND_QUERY_SENTINEL',
      'DYNAMIC_CAPABILITY_SENTINEL',
      'TEAM_STATE_SENTINEL',
      '1 non-root turns are active',
      'Primary task:',
      'VERIFICATION_SENTINEL',
      'TOOL_POLICY_SENTINEL',
      'METADATA_SENTINEL',
      'SKILL_NAME_SENTINEL',
      'SKILL_CONTENT_SENTINEL',
    ]) {
      expect(dynamic).toContain(marker);
      expect(stable).not.toContain(marker);
    }
    expect(stable).not.toContain('ORIGINAL_QUERY_SENTINEL');
    expect(dynamic.indexOf('VERIFICATION_SENTINEL'))
      .toBeLessThan(dynamic.indexOf('DYNAMIC_CAPABILITY_SENTINEL'));
    expect(dynamic.indexOf('TOOL_POLICY_SENTINEL'))
      .toBeLessThan(dynamic.indexOf('DYNAMIC_CAPABILITY_SENTINEL'));
  });

  it('renders capabilityContextBlock for every role when present', () => {
    const block = [
      '## MCP Capability Provider',
      'Use mcp_search before mcp_call.',
      '',
      '## Project Agents',
      'PROJECT RULE: prefer immutability.',
      '',
      'Working git context here.',
    ].join('\n');
    for (const role of roles) {
      const rendered = renderRole(role, block);
      expect(rendered, `role=${role}`).toContain('## MCP Capability Provider');
      expect(rendered, `role=${role}`).toContain('## Project Agents');
      expect(rendered, `role=${role}`).toContain('PROJECT RULE: prefer immutability.');
      expect(rendered, `role=${role}`).toContain('Working git context here.');
    }
  });

  it('positions the capability block after contract-critical routing context', () => {
    const block = '## MCP Capability Provider\nFROZEN_MCP_MARKER';
    for (const role of roles) {
      const rendered = renderRole(role, block, 'context');
      const capIdx = rendered.indexOf('FROZEN_MCP_MARKER');
      const decisionIdx = rendered.indexOf('Primary task:');
      expect(decisionIdx, `role=${role}: decisionSummary present`).toBeGreaterThanOrEqual(0);
      expect(capIdx, `role=${role}: capability block present`).toBeGreaterThan(decisionIdx);
    }
  });

  it('emits no capability block when undefined (legacy callers unaffected)', () => {
    for (const role of roles) {
      const rendered = renderRole(role, undefined);
      // Workspace + decision summary still present; no orphan blank gap
      // means the filter() chain dropped the undefined entry cleanly.
      expect(rendered).toContain('## Environment');
      expect(rendered).toContain('Primary task:');
      // Sentinel: no MCP / project-agents content leaks in when the
      // parent didn't pre-compute one.
      expect(rendered).not.toContain('## MCP Capability Provider');
    }
  });

  it('emits no capability block when empty / whitespace-only string', () => {
    for (const role of roles) {
      const renderedEmpty = renderRole(role, '');
      const renderedWs = renderRole(role, '   \n\t  \n');
      // Both should match the undefined behavior — whitespace-only blocks
      // would otherwise inject a noisy empty section between workspace
      // and decision summary.
      expect(renderedEmpty).toContain('## Environment');
      expect(renderedWs).toContain('## Environment');
      expect(renderedEmpty).toContain('Primary task:');
      expect(renderedWs).toContain('Primary task:');
    }
  });
});

describe('FEATURE_114 Slice 2 — worker role prompt entry wire', () => {
  function renderWorker(
    overrides: Partial<ManagedRolePromptContext> = {},
  ): string {
    const decision = buildFallbackRoutingDecision(userQuestion);
    const ctx: ManagedRolePromptContext = {
      ...buildContext({ provider: 'p', model: 'm' }),
      ...overrides,
    };
    return createRolePrompt(
      'worker',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/worker',
      undefined,
      ctx,
      undefined,
      false,
    );
  }

  it('emits the canonical context layers (workspace / decisionSummary / shared closing rule)', () => {
    const rendered = renderWorker();
    expect(rendered).toContain('## Environment');
    expect(rendered).toContain('Working Directory:');
    expect(rendered).toContain('Primary task:');
    expect(rendered).toContain('Workspace discipline:');
    expect(rendered).toContain('Preserve any exact machine-readable closing contract');
  });

  it('decisionSummary is de-harnessed and the Worker self-judges via EXECUTION GUIDANCE (ADR-043)', () => {
    const rendered = renderWorker();
    // Semantic routing fields stay (they help; see decisionSummary eval).
    expect(rendered).toContain('Primary task:');
    expect(rendered).toContain('Risk:');
    // The collapsed/vestige harness-tier classification lines were removed (P1.6).
    expect(rendered).not.toContain('Harness:');
    expect(rendered).not.toContain('Topology ceiling:');
    // The Worker self-judges its approach from the static guidance (H3) instead.
    expect(rendered).toContain('EXECUTION GUIDANCE');
  });

  it('teaches language continuity across Actor-event resumes', () => {
    const rendered = renderWorker();
    expect(rendered).toContain('Actor-event resume summaries: match the primary natural language of the original user request');
    expect(rendered).toContain('user-visible explanations, progress notes, and final answer');
    expect(rendered).toContain('Code, identifiers, file paths, tool output, and quoted evidence stay in their source language');
  });

  it('does NOT route Worker through emit_handoff (FEATURE_190: text-only termination)', () => {
    const rendered = renderWorker();
    expect(rendered).not.toContain('"emit_handoff"');
    expect(rendered).not.toContain('PROTOCOL EMISSION — MUST be in the SAME response');
    expect(rendered).not.toContain('kodax-task-handoff');
    // Sanity: also not the other role-specific emit names.
    expect(rendered).not.toContain('"emit_scout_verdict"');
    expect(rendered).not.toContain('"emit_contract"');
    expect(rendered).not.toContain('"emit_verdict"');
  });

  it('splices buildWorkerInstructions content and canonical Agent policies', () => {
    const rendered = renderWorker();
    // Pinned tokens from `buildWorkerInstructions` — if the entry
    // wire breaks, these disappear and the V2 path silently falls
    // back to a context-only prompt with no planning guidance.
    expect(rendered).toContain('PLAN-FIRST GUIDANCE:');
    expect(rendered).toContain('SCOPE COMMITMENT:');
    expect(rendered).toContain('MUTATION DISCIPLINE');
    expect(rendered).toContain('AGENT COLLABORATION:');
    expect(rendered).toContain(
      'Use sub-agents when parallel work would materially improve speed or quality.',
    );
    expect(rendered).toContain(
      'Use `run_workflow` only when the user explicitly requests a Workflow or names a Workflow.',
    );
    expect(rendered).toContain('the following mailbox block carries the evidence');
    expect(rendered).toContain('After `AgentLimitReached`');
    // FEATURE_190 (v0.7.43): legacy `EVALUATOR HANDOFF` replaced by
    // positive text-only termination block.
    expect(rendered).toContain('TERMINATION');
    expect(rendered).not.toContain('Sidecar Verifier');
    expect(rendered).not.toContain('EVALUATOR HANDOFF');
    expect(rendered).toContain('You are the Worker — KodaX\'s single primary agent');
  });

  it('no longer threads isResumeAfterReviseFailure into the Worker prompt (retrospective moved to the sidecar reanimate message post-F116)', () => {
    const fresh = renderWorker();
    const resume = renderWorker({ isResumeAfterReviseFailure: true });
    // Neither prompt carries the retrospective now — it rides the Sidecar
    // Verifier's synthetic user message (mapVerifierVerdictToStopHookResult),
    // so the system prompt stays byte-stable across revise cycles for cache reuse.
    expect(fresh).not.toContain('Sidecar Verifier review');
    expect(resume).not.toContain('A previous attempt at this task failed Sidecar Verifier review');
    expect(resume).not.toContain('Evaluator review');
  });

  it('does not leak Scout/Planner/Generator/Evaluator-specific prompt fragments', () => {
    const rendered = renderWorker();
    // FEATURE_106 Scout EMIT TIMING / TRIVIAL-EXEMPTION block belongs
    // only to Scout; would confuse the Worker which emits handoffs.
    expect(rendered).not.toContain('EMIT TIMING (CRITICAL — read this carefully)');
    // Planner contract payload shape is generator-handoff-equivalent
    // for Worker — make sure we did not paste the planner block in.
    expect(rendered).not.toContain('Contract payload shape (pass to emit_contract)');
    // Evaluator verdict shape ditto.
    expect(rendered).not.toContain('Verdict payload shape (pass to emit_verdict)');
  });

  it('renders capability + repo intelligence parity (FEATURE_144 / FEATURE_086 still apply to Worker)', () => {
    const rendered = renderWorker({
      capabilityContextBlock: '## MCP Capability Provider\nFROZEN_MCP_MARKER',
    });
    const envIdx = rendered.indexOf('## Environment');
    const capIdx = rendered.indexOf('FROZEN_MCP_MARKER');
    const decisionIdx = rendered.indexOf('Primary task:');
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(capIdx).toBeGreaterThan(envIdx);
    expect(decisionIdx).toBeGreaterThan(capIdx);
  });
});

// FEATURE_193 v0.7.43: FEATURE_114 Slice 8a Scout TRIVIAL-EXEMPTION boundary pin describe deleted (V1 scout role retired)

describe('createRolePrompt — wait-discipline isolation (FEATURE_155 / FEATURE_184)', () => {
  // FEATURE_193 v0.7.43: loop trimmed from ['scout','planner','generator','worker'] to ['worker'] (V1 chain retired)
  it('CHILD-TASK WAIT DISCIPLINE does NOT appear in Worker prompt', () => {
    const decision = buildFallbackRoutingDecision(userQuestion);
    for (const role of ['worker'] as const) {
      const rendered = createRolePrompt(
        role,
        userQuestion,
        decision,
        undefined,
        undefined,
        `kodax/role/${role}`,
        undefined,
        buildContext({ provider: 'p', model: 'm' }),
        undefined,
        false,
      );
      expect(rendered, `role=${role}`).not.toContain('CHILD-TASK WAIT DISCIPLINE');
    }
  });
});

describe('FEATURE_125 — teamModeSection wiring across roles', () => {
  const SAMPLE_BLOCK = [
    '=== Other active KodaX sessions ===',
    '',
    'You are not alone — the user has 1 other KodaX session running:',
    '',
    '- pid 42 @ /repo (started 1 min ago)',
    '  Phase: running_tool',
    '  Intent: "refactoring auth"',
  ].join('\n');

  // FEATURE_193 v0.7.43: role type trimmed from scout|planner|generator|worker to worker (V1 chain retired)
  function renderWithTeamBlock(role: 'worker'): string {
    const decision = buildFallbackRoutingDecision(userQuestion);
    const ctx: ManagedRolePromptContext = {
      ...buildContext({ provider: 'p', model: 'm' }),
      teamModeSection: SAMPLE_BLOCK,
    };
    return createRolePrompt(
      role,
      userQuestion,
      decision,
      undefined,
      undefined,
      `kodax/role/${role}`,
      undefined,
      ctx,
      undefined,
      false,
    );
  }

  // FEATURE_193 v0.7.43: loop trimmed from ['scout','planner','generator','worker'] to ['worker'] (V1 chain retired)
  for (const role of ['worker'] as const) {
    it(`role=${role} includes the team-mode block when supplied`, () => {
      const rendered = renderWithTeamBlock(role);
      expect(rendered).toContain('=== Other active KodaX sessions ===');
      expect(rendered).toContain('pid 42 @ /repo');
      expect(rendered).toContain('Intent: "refactoring auth"');
    });

    it(`role=${role} places the team-mode block in the orientation header (before the original task)`, () => {
      const rendered = renderWithTeamBlock(role);
      const blockIdx = rendered.indexOf('=== Other active KodaX sessions ===');
      const taskIdx = rendered.indexOf('Original user request:');
      expect(blockIdx).toBeGreaterThanOrEqual(0);
      expect(taskIdx).toBeGreaterThanOrEqual(0);
      expect(blockIdx).toBeLessThan(taskIdx);
    });
  }

  // FEATURE_193 v0.7.43: 'scout' → 'worker' (V1 chain retired)
  it('omits the block entirely when teamModeSection is undefined (solo session)', () => {
    const decision = buildFallbackRoutingDecision(userQuestion);
    const rendered = createRolePrompt(
      'worker',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/worker',
      undefined,
      buildContext({ provider: 'p', model: 'm' }),
      undefined,
      false,
    );
    expect(rendered).not.toContain('Other active KodaX sessions');
  });

  it('omits the block when teamModeSection is whitespace-only', () => {
    const decision = buildFallbackRoutingDecision(userQuestion);
    const ctx: ManagedRolePromptContext = {
      ...buildContext({ provider: 'p', model: 'm' }),
      teamModeSection: '   \n  \n',
    };
    const rendered = createRolePrompt(
      'worker',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/worker',
      undefined,
      ctx,
      undefined,
      false,
    );
    expect(rendered).not.toContain('Other active KodaX sessions');
  });
});

describe('F270 — explicit Workflow activation policy', () => {
  function renderWorker(
    overrides: Partial<ManagedRolePromptContext> = {},
  ): string {
    const decision = buildFallbackRoutingDecision(userQuestion);
    const ctx: ManagedRolePromptContext = {
      ...buildContext({ provider: 'p', model: 'm' }),
      ...overrides,
    };
    return createRolePrompt(
      'worker',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/worker',
      undefined,
      ctx,
      undefined,
      false,
    );
  }

  it('exposes proactive Agent collaboration without complexity-driven Workflow orchestration', () => {
    const rendered = renderWorker();
    expect(rendered).toContain(
      'Use sub-agents when parallel work would materially improve speed or quality.',
    );
    expect(rendered).toContain(
      'Use `run_workflow` only when the user explicitly requests a Workflow or names a Workflow.',
    );
    expect(rendered).not.toContain('ORCHESTRATION DEFAULT');
    expect(rendered).not.toContain('PLAN-TIME COMMITMENT');
    expect(rendered).not.toContain('dispatch_child_task');
  });

  it('teaches Actor completion and capacity recovery semantics', () => {
    const rendered = renderWorker({
      actorCapacity: { maxConcurrentThreads: 4, activeNonRootTurns: 1 },
    });
    expect(rendered).toContain('<agent-completed path="..." turn_id="..." state="completed">');
    expect(rendered).toContain('`wait_agent` returns only a wake acknowledgement');
    expect(rendered).toContain('Use it directly');
    expect(rendered).toContain('Do not call `agent_output` speculatively');
    expect(rendered).toContain('do not retry `spawn_agent` while the reported capacity is still full');
    expect(rendered).toContain('4 total concurrency slots');
    expect(rendered).toContain('2 child start slots are available');
    expect(rendered).toMatch(/^ACTOR CAPACITY \(authoritative runtime fact\):/);
    expect(rendered).toContain('emit at most 2 `spawn_agent` calls');
  });

  it('places a broad-review fan-out decision beside current Actor capacity', () => {
    const decision = {
      ...buildFallbackRoutingDecision(userQuestion),
      primaryTask: 'review' as const,
      complexity: 'complex' as const,
      reviewScale: 'massive' as const,
      reviewTarget: 'compare-range' as const,
      needsIndependentQA: true,
    };
    const ctx: ManagedRolePromptContext = {
      ...buildContext({ provider: 'p', model: 'm' }),
      actorCapacity: { maxConcurrentThreads: 4, activeNonRootTurns: 0 },
    };
    const rendered = createRolePrompt(
      'worker',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/worker',
      undefined,
      ctx,
      undefined,
      false,
      'context',
    );

    expect(rendered).toContain('Review scale: massive');
    expect(rendered).toContain('Review target: compare-range');
    expect(rendered).toContain('Independent QA needed: yes');
    expect(rendered).toContain('BROAD REVIEW FAN-OUT (authoritative task policy):');
    expect(rendered.indexOf('ACTOR CAPACITY')).toBeLessThan(
      rendered.indexOf('BROAD REVIEW FAN-OUT'),
    );
    expect(rendered.indexOf('BROAD REVIEW FAN-OUT')).toBeLessThan(
      rendered.indexOf('Primary task:'),
    );
  });

  it.each([
    ['Review this change set for merge blockers.', 'current-worktree'],
    ['Audit the diff for merge blockers.', 'current-worktree'],
    ['Review diff for merge blockers.', 'current-worktree'],
    ['Review the changed files for merge blockers.', 'current-worktree'],
    ['请审查当前改动中的合并阻塞问题。', 'current-worktree'],
    ['请审查当前变更中的合并阻塞问题。', 'current-worktree'],
    ['请看下当前改动中的合并阻塞问题。', 'current-worktree'],
    ['请对比 v0.7.76 到 v0.7.79 的变更并审查合并阻塞问题。', 'compare-range'],
    ['Review 38aa0dfb^..HEAD for merge blockers.', 'compare-range'],
    ['Audit v0.7.76...v0.7.79 for merge blockers.', 'compare-range'],
  ] as const)(
    'routes the natural review request "%s" into the authoritative fan-out prompt',
    (prompt, expectedTarget) => {
      const repoSignals: KodaXRepoRoutingSignals = {
        changedFileCount: 45,
        changedLineCount: 6_500,
        addedLineCount: 3_800,
        deletedLineCount: 2_700,
        touchedModuleCount: 6,
        changedModules: ['agent', 'coding', 'repl'],
        crossModule: true,
        reviewScale: 'massive',
        riskHints: [],
        plannerBias: false,
        investigationBias: false,
        lowConfidence: false,
      };
      const initialPlan: ReasoningPlan = {
        effort: 'medium',
        decision: buildFallbackRoutingDecision(prompt),
        promptOverlay: '',
      };
      const routed = applyCurrentDiffReviewRoutingFloor(
        initialPlan,
        prompt,
        repoSignals,
      );
      const rendered = createRolePrompt(
        'worker',
        prompt,
        routed.plan.decision,
        undefined,
        undefined,
        'kodax/role/worker',
        undefined,
        {
          ...buildContext({ provider: 'p', model: 'm' }),
          originalTask: prompt,
          actorCapacity: { maxConcurrentThreads: 4, activeNonRootTurns: 0 },
        },
        undefined,
        false,
        'context',
      );

      expect(routed.reviewTarget).toBe(expectedTarget);
      expect(routed.plan.decision.primaryTask).toBe('review');
      expect(rendered).toContain(`Review target: ${expectedTarget}`);
      expect(rendered).toContain('BROAD REVIEW FAN-OUT (authoritative task policy):');
      expect(rendered).toContain('call `changed_scope` once, then fan out');
    },
  );

  it.each([
    'Fix the diff renderer bug across the changed modules.',
    'Analyze the diff renderer bug across the changed modules.',
    'Check the current parser bug before implementing the fix.',
  ])('does not turn the implementation task "%s" into a review', (prompt) => {
    const routed = applyCurrentDiffReviewRoutingFloor(
      {
        effort: 'medium',
        decision: buildFallbackRoutingDecision(prompt),
        promptOverlay: '',
      },
      prompt,
      {
        changedFileCount: 45,
        changedLineCount: 6_500,
        addedLineCount: 3_800,
        deletedLineCount: 2_700,
        touchedModuleCount: 6,
        changedModules: ['agent', 'coding', 'repl'],
        crossModule: true,
        reviewScale: 'massive',
        riskHints: [],
        plannerBias: false,
        investigationBias: false,
        lowConfidence: false,
      },
    );

    expect(routed.plan.decision.primaryTask).toBe('bugfix');
    expect(routed.applied).not.toBe(true);
  });

  it.each([
    'Audit range checks in the parser.',
    'Review workspace architecture.',
    '审查并比较变更检测算法。',
    '审查并比较 React 与 Vue 的实现。',
    '审查从 React 到 Vue 的迁移方案。',
  ])('does not mistake the general review "%s" for a Git diff review', (prompt) => {
    const routed = applyCurrentDiffReviewRoutingFloor(
      {
        effort: 'medium',
        decision: buildFallbackRoutingDecision(prompt),
        promptOverlay: '',
      },
      prompt,
      {
        changedFileCount: 45,
        changedLineCount: 6_500,
        addedLineCount: 3_800,
        deletedLineCount: 2_700,
        touchedModuleCount: 6,
        changedModules: ['agent', 'coding', 'repl'],
        crossModule: true,
        reviewScale: 'massive',
        riskHints: [],
        plannerBias: false,
        investigationBias: false,
        lowConfidence: false,
      },
    );

    expect(routed.reviewTarget).toBe('general');
    expect(routed.plan.decision.routingNotes ?? []).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('Diff-driven review surface'),
      ]),
    );
  });

  it('injects one capacity-aware broad-review contract in combined mode', () => {
    const decision = {
      ...buildFallbackRoutingDecision(userQuestion),
      primaryTask: 'review' as const,
      complexity: 'systemic' as const,
      reviewScale: 'massive' as const,
      reviewTarget: 'general' as const,
    };
    const rendered = createRolePrompt(
      'worker',
      userQuestion,
      decision,
      undefined,
      undefined,
      'kodax/role/worker',
      undefined,
      {
        ...buildContext({ provider: 'p', model: 'm' }),
        actorCapacity: { maxConcurrentThreads: 2, activeNonRootTurns: 0 },
      },
    );

    expect(rendered.match(/BROAD REVIEW FAN-OUT \(authoritative task policy\):/g)).toHaveLength(1);
    expect(rendered).toContain('Start 1 read-only review Agent');
    expect(rendered).not.toContain('when at least 2 child start slots are available');
  });
});
