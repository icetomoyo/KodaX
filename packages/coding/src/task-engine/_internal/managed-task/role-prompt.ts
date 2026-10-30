/**
 * Role-prompt builder — restored from v0.7.22 task-engine (`createRolePrompt`,
 * FEATURE_079 Slice 8) and adapted for v0.7.26's Runner-driven per-role emit
 * tools.
 *
 * v0.7.22 had a single `emit_managed_protocol` tool; the Runner-driven path
 * uses four role-specific emit tools (`emit_scout_verdict`, `emit_contract`,
 * `emit_handoff`, `emit_verdict`). The only adaptation in this file is
 * `ROLE_EMIT_TOOL_NAMES` — every other prompt section is preserved verbatim
 * from v0.7.22 into the current Worker prompt surface (parallel child-agent
 * rules, evidence strategies, review-task framing, and shared closing rules).
 *
 * Restoring this file during the v0.7.26 parity audit closes the biggest
 * regression found: the Runner-driven `SCOUT_INSTRUCTIONS` / etc constants
 * in `runner-driven.ts` were 10-15 lines of static text; the v0.7.22 prompt
 * was ~480 lines of context-aware guidance. Without this file the LLM did
 * did not receive collaboration guidance for complex tasks (user report),
 * did not receive the decision summary / contract / metadata / verification
 * / tool-policy context, and was not given evidence-strategy guidance per
 * role.
 */

import type {
  KodaXJsonValue,
  KodaXTaskRole,
  KodaXTaskRoutingDecision,
  KodaXTaskToolPolicy,
  KodaXTaskVerificationContract,
} from '../../../types.js';
// FEATURE_193 (v0.7.43): MANAGED_TASK_CONTRACT_BLOCK, MANAGED_TASK_VERDICT_BLOCK,
// and isRepoIntelligenceWorkingToolName removed — only used by deleted V1 cases.
import {
  buildWorkerActorCapacityContract,
  buildWorkerReviewFanoutContract,
  buildWorkerRoutingContext,
  buildWorkerStableInstructions,
  EXPLICIT_WORKFLOW_POLICY,
  ULTRA_AGENT_POLICY,
} from '../../../agents/worker-role-prompt.js';
import {
  formatFullSkillSection,
  formatRoleRoundSummarySection,
  formatSkillInvocationSummary,
  formatSkillMapSection,
  formatTaskMetadata,
  formatToolPolicy,
  formatVerificationContract,
} from './formatting.js';
import {
  // FEATURE_193 (v0.7.43): inferScoutMutationIntent and isReviewEvidenceTask
  // no longer imported — only used by deleted V1 scout/planner/generator cases.
  type ManagedRolePromptContext,
} from './role-prompt-types.js';

// FEATURE_193 (v0.7.43): ROLE_EMIT_TOOL_NAMES deleted — scout and planner
// roles retired along with their emit tools (emit_scout_verdict,
// emit_contract). Only emit_verdict remains for the evaluator role, referenced
// directly in parse-helpers.ts. The worker role terminates text-only under
// F184/F190 architecture with no emit tool.

// Canonical fragments remain unchanged for SDK and specialized roles.
export const WORKER_CLOSING_RULE = [
    'Preserve any exact machine-readable closing contract requested by the original task.',
    'Do not claim completion authority unless your role explicitly owns final judgment — a premature complete signal from a non-authoritative role causes the runner to terminate the task before the owning role validates the result.',
    'Language continuity also applies to Actor-event resume summaries: match the primary natural language of the original user request.',
    'When proposing shell commands or command examples, match the current host OS and shell. Do not assume Unix-only tools such as head on Windows.',
  ].join('\n');

export const WORKER_WORKSPACE_DISCIPLINE = [
    'Workspace discipline:',
    '- Helper scripts / scratch files are a last resort, not a default recovery path.',
    '- The `write` tool creates parent directories automatically. Calling `mkdir` before `write` is redundant and may fail on Windows shells where `mkdir -p` is unsupported.',
    '- If you truly need an empty directory: `mkdir dir` (Windows) or `mkdir -p dir` (Unix).',
    '',
    'Cross-platform shell:',
    '- Move: `move` (Windows) vs `mv` (Unix/Mac).',
    '- List: `dir` (Windows) vs `ls` (Unix/Mac).',
    '- Delete: `del` (Windows) vs `rm` (Unix/Mac).',
    '- If you see "not recognized", "不是内部或外部命令", or a similar lookup error, the command does not exist on this platform. Try the platform equivalent.',
  ].join('\n');

/**
 * Build the system prompt for a single managed-task role.
 *
 * Adapted from v0.7.22 `createRolePrompt`. The `workerId` parameter is kept
 * on the signature for upstream call-site stability even though the body
 * does not read it.
 *
 * `task-context` renders the per-task part of the run context only. It follows
 * retained envelopes, so Session scratch, Actor capacity and Team state stay
 * with the changed-only runtime refresh instead of repeating every Run.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type ManagedRolePromptRenderMode = 'combined' | 'stable' | 'context' | 'task-context';

export function createRolePrompt(
  role: KodaXTaskRole,
  prompt: string,
  decision: KodaXTaskRoutingDecision,
  verification: KodaXTaskVerificationContract | undefined,
  toolPolicy: KodaXTaskToolPolicy | undefined,
  agent: string,
  metadata: Record<string, KodaXJsonValue> | undefined,
  rolePromptContext: ManagedRolePromptContext | undefined,
  workerId?: string,
  isTerminalAuthority = false,
  renderMode: ManagedRolePromptRenderMode = 'combined',
): string {
  void workerId;
  // FEATURE_193 (v0.7.43): isTerminalAuthority was used by the deleted
  // generator case. Kept on signature for call-site stability.
  void isTerminalAuthority;
  const originalTask = rolePromptContext?.originalTask || prompt;
  // Issue 119: For post-Scout roles (generator/planner/evaluator), `decision.mutationSurface`
  // is a stale pre-Scout regex heuristic. Show it only to Scout — downstream workers get
  // scope cues from Scout's own scope/reviewFilesOrAreas via the handoff.
  // decisionSummary carries the SEMANTIC routing fields the Worker still
  // benefits from (an eval showed Risk/assurance-intent help floor models
  // orient a review task). The `Harness:` (constant 'H0_DIRECT') + `Topology
  // ceiling:` (V1 vestige) lines were dropped — they were the ADR-033
  // classification-table residue and an eval confirmed removing them is
  // behaviour-neutral (the harness tier collapsed; see ADR-043 Phase 2).
  const decisionSummary = buildWorkerRoutingContext(decision);

  const sharedClosingRule = WORKER_CLOSING_RULE;

  // v0.7.26 NEW-1 — inject the workspace environment at prompt head.
  // Legacy SA path gets this via `buildSystemPrompt` (Working Directory
  // + environment-context); the Runner-driven path bypasses that
  // builder entirely. Without this block, managed workers guess paths
  // (e.g. `cd /d/user/kodax/workspace` when
  // the real cwd is `C:\Works\GitWorks\...`). Name the block after the
  // SA surface so the LLM can correlate with anything it already
  // learned from `buildSystemPrompt`.
  const workspace = rolePromptContext?.workspace;
  const workspaceSection = workspace
    ? [
      '## Environment',
      `Working Directory: ${workspace.executionCwd}`,
      workspace.gitRoot && workspace.gitRoot !== workspace.executionCwd
        ? `Git Root: ${workspace.gitRoot}`
        : undefined,
      `Platform: ${
        workspace.platform === 'win32'
          ? 'Windows'
          : workspace.platform === 'darwin'
            ? 'macOS'
            : workspace.platform
      }${workspace.osRelease ? ` (${workspace.osRelease})` : ''}`,
      // Runtime fact — managed workers (Scout/Planner/Generator/Evaluator)
      // bypass `buildSystemPrompt` and would otherwise have no provider /
      // model context, causing the LLM to fall back on pretraining
      // identity (e.g. GLM-5.1 self-reporting as Claude). Preflight
      // (2026-04, ark-coding/glm-5.1) confirmed two lines here flip the
      // answer from "I'm Claude" to "I'm GLM-5.1".
      workspace.provider ? `Provider: ${workspace.provider}` : undefined,
      workspace.model ? `Model: ${workspace.model}` : undefined,
      workspace.platform === 'win32'
        ? 'Shell defaults: Windows shell. Use: dir, move, copy, del, type. Avoid Unix-only tools like `head`, `tail`, `rm`, `cp`, `mv`.'
        : 'Shell defaults: Unix shell. Use: ls, mv, cp, rm, cat, head, tail.',
      'All relative paths you emit in tool calls (read/write/edit/bash) resolve against the Working Directory above. Do NOT `cd` into invented paths or assume a different cwd.',
    ].filter((line): line is string => Boolean(line)).join('\n')
    : undefined;
  const workspaceRunContextSection = workspace?.scratchDir
    ? [
      '## Session Environment',
      `Session Scratch Directory: ${workspace.scratchDir}`,
    ].join('\n')
    : undefined;

  // v0.7.35.1 FEATURE_144 — capability-context sections the AMA worker
  // bypasses by going through `runner-driven.ts` instead of
  // `buildSystemPrompt`. Pre-computed parent-side so each per-role
  // invocation reuses the same MCP / AGENTS.md / git / project-snapshot
  // / tool-construction / skills truth. See
  // `ManagedRolePromptContext.capabilityContextBlock` JSDoc for the
  // exact 6 sections this string covers and why the other 7 are
  // intentionally NOT included here.
  const capabilityContextSection = rolePromptContext?.capabilityContextBlock?.trim()
    ? rolePromptContext.capabilityContextBlock
    : undefined;
  const stableCapabilityContextSection =
    rolePromptContext?.stableCapabilityContextBlock?.trim()
      ? rolePromptContext.stableCapabilityContextBlock
      : undefined;

  // Harness LLM-judgment refactor (H3): the Worker no longer receives the
  // router-injected `plan.promptOverlay` (EXECUTION_MODE / HARNESS_PROFILE
  // overlays + [Task Routing] classification dump). Those are replaced by the
  // static EXECUTION GUIDANCE block in `buildWorkerInstructions`, which the
  // Worker self-applies. 5-alias panel confirmed behavioural parity + a
  // shorter prompt. See docs/harness-llm-judgment-design.md §2.1/§2.3.

  // FEATURE_125 v0.7.41 — "Other active KodaX sessions" block. Rendered
  // by the runner-driven adapter once per LLM round (sibling state can
  // change between rounds, so this is NOT in the stable prefix).
  // Empty/omitted means no live siblings; section is dropped from the
  // composition via the trailing `.filter(Boolean)`.
  const teamModeSection = rolePromptContext?.teamModeSection?.trim()
    ? rolePromptContext.teamModeSection
    : undefined;

  // v0.7.26 fix — managed workers bypass `buildSystemPrompt` (legacy SA
  // path), so the base `SYSTEM_PROMPT` discipline sections (tmp-directory
  // rule, mkdir warning, cross-platform notes) never reached the LLM. The
  // result: workers wrote scratch files to project root / system tmp
  // instead of `.agent/tmp/`. Re-inject the essential discipline as a
  // shared block prepended to every role's prompt.
  const sharedWorkerDiscipline = WORKER_WORKSPACE_DISCIPLINE;
  const originalTaskSection = `Original user request:\n${originalTask}`;
  const roundInstructionSection = prompt !== originalTask
    ? `Current round instructions:\n${prompt}`
    : undefined;

  // Explicit evidence belongs to the verification block below. The former
  // preview task contract only repeated that same array; it supplied no
  // independent summary, success criteria, or constraints.
  const metadataSection = formatTaskMetadata(metadata);
  const verificationSection = formatVerificationContract(verification);
  const toolPolicySection = formatToolPolicy(toolPolicy);
  const agentSection = `Assigned native agent identity: ${agent}`;
  const skillInvocation = rolePromptContext?.skillInvocation;
  const skillMap = rolePromptContext?.skillMap;
  // FEATURE_193 (v0.7.43): removed `role === 'generator' ? undefined : ...`
  // guard — generator role deleted. Worker always reads previousRoleSummaries.
  const previousRoleSummary = rolePromptContext?.previousRoleSummaries?.[role];
  // FEATURE_193 (v0.7.43): scoutSkillSection and plannerSkillSection deleted
  // with scout/planner roles.
  const generatorSkillSection = skillInvocation
    ? [
      skillMap ? formatSkillMapSection(skillMap, rolePromptContext?.skillMapArtifactPath) : undefined,
      formatSkillInvocationSummary(skillInvocation, rolePromptContext?.skillExecutionArtifactPath),
      // Harness collapsed to H0_DIRECT in V2 (ADR-043) — the H2/Planner variant
      // never fired, so the emitted text is unchanged.
      'You own execution. Treat the raw skill as the authoritative execution reference and the skill map as the lightweight coordination surface shared with Scout/Evaluator.',
      formatFullSkillSection(skillInvocation),
    ].filter((section): section is string => Boolean(section)).join('\n\n')
    : skillMap
      ? [
        formatSkillMapSection(skillMap, rolePromptContext?.skillMapArtifactPath),
        'Treat the skill map as the coordination surface shared with Scout/Evaluator. If any obligation conflicts with the contract, surface it in your handoff.',
      ].join('\n\n')
      : undefined;
  const previousRoleSummarySection = previousRoleSummary
    ? formatRoleRoundSummarySection(previousRoleSummary)
    : undefined;
  // FEATURE_193 (v0.7.43): reviewLikeTask, reviewPresentationRule,
  // repoWorkingToolsEnabled, diffPagingToolsEnabled deleted — only used by
  // V1 scout/planner/generator cases.
  const parallelBatchGuidance = [
    'When multiple read-only tool calls are independent, emit them in the same response so parallel mode can run them together.',
    'Only serialize tool calls when a later call depends on an earlier result.',
    'Keep parallel batches focused: prefer a few narrow grep/read/diff calls over many tiny sequential probes.',
  ].join('\n');
  // FEATURE_193 (v0.7.43): scoutReviewEvidenceGuidance, plannerReviewEvidenceGuidance,
  // generatorReviewEvidenceGuidance, h1GeneratorExecutionGuidance, h1MutationIntent,
  // h1MutationGuardance deleted — all V1 scout/planner/generator-only helpers.
  // Also: inferScoutMutationIntent and isReviewEvidenceTask imports are no longer needed
  // (see role-prompt-types.ts — those exports remain for external consumers if any).
  // FEATURE_193 (v0.7.43): case 'scout', case 'planner', case 'generator'
  // deleted — V1 chain roles retired. Only case 'worker', case 'evaluator'
  // (via default pass-through), and case 'direct' remain.
  switch (role) {
    case 'worker': {
      // FEATURE_114 v0.7.36 — AMA Harness V2 single-loop primary agent.
      // Combines the canonical Worker fragments (decisional + plan-first +
      // mutation + dispatch + handoff fragments) with the same
      // workspace / capability / overlay / decisionSummary / contract /
      // metadata / verification / tool-policy context layers the legacy
      // Worker prompt uses, so the V2 path doesn't lose any FEATURE_144
      // (capability-context) or
      // FEATURE_086 (repo-intelligence) parity gains. Skill section
      // mirrors Generator (skillMap + full skill expansion) — Worker
      // both plans and executes, so it needs the planner-style map AND
      // the generator-style execution surface.
      const workerSkillSection = generatorSkillSection;
      const actorCapacityContract = buildWorkerActorCapacityContract(
        rolePromptContext?.actorCapacity,
        rolePromptContext?.availableToolNames,
      );
      const reviewFanoutContract = buildWorkerReviewFanoutContract(
        decision,
        rolePromptContext?.actorCapacity,
        rolePromptContext?.availableToolNames,
      );
      const workerInstructions = buildWorkerStableInstructions(rolePromptContext?.availableToolNames);
      const collaborationPolicy = rolePromptContext?.availableToolNames === undefined
        || rolePromptContext.availableToolNames.includes('spawn_agent') ? ULTRA_AGENT_POLICY : undefined;
      const workflowPolicy = rolePromptContext?.availableToolNames === undefined
        || rolePromptContext.availableToolNames.includes('run_workflow') ? EXPLICIT_WORKFLOW_POLICY : undefined;
      if (renderMode === 'stable') {
        return [
          workspaceSection,
          agentSection,
          stableCapabilityContextSection,
          parallelBatchGuidance,
          collaborationPolicy,
          workflowPolicy,
          workerInstructions,
          sharedWorkerDiscipline,
          sharedClosingRule,
        ].filter((section): section is string => Boolean(section)).join('\n\n');
      }
      if (renderMode === 'context' || renderMode === 'task-context') {
        const runtimeState = renderMode === 'context';
        // Keep contract-critical fragments first. The aggregate hard cap may
        // shed bulky repository/capability evidence, but never before the
        // current task, verification, tool policy, and selected Skill.
        return [
          runtimeState ? workspaceRunContextSection : undefined,
          runtimeState ? actorCapacityContract : undefined,
          reviewFanoutContract,
          decisionSummary,
          verificationSection,
          toolPolicySection,
          workerSkillSection,
          roundInstructionSection,
          metadataSection,
          previousRoleSummarySection,
          runtimeState ? teamModeSection : undefined,
          capabilityContextSection,
        ].filter((section): section is string => Boolean(section)).join('\n\n');
      }
      return [
        actorCapacityContract,
        reviewFanoutContract,
        // Worker is its own role announcement, but we still emit the
        // canonical decisionSummary + originalTask / agent / contract
        // sections so the LLM sees the same machine-readable context
        // the legacy roles get.
        workspaceSection,
        workspaceRunContextSection,
        capabilityContextSection,
        teamModeSection,
        decisionSummary,
        originalTaskSection,
        roundInstructionSection,
        agentSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        parallelBatchGuidance,
        workerSkillSection,
        previousRoleSummarySection,
        collaborationPolicy,
        workflowPolicy,
        // The standalone Worker fragment (plan-first contract + scope
        // commitment + mutation discipline + dispatch RULE A/B/C +
        // handoff rules) lives here between context blocks and the shared
        // closing rules.
        workerInstructions,
        sharedWorkerDiscipline,
        sharedClosingRule,
      ].filter((section): section is string => Boolean(section)).join('\n\n');
    }
    case 'direct':
    default:
      return prompt;
  }
}
