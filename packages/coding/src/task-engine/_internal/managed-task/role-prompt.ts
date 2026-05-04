/**
 * Role-prompt builder — restored from v0.7.22 task-engine (`createRolePrompt`,
 * FEATURE_079 Slice 8) and adapted for v0.7.26's Runner-driven per-role emit
 * tools.
 *
 * v0.7.22 had a single `emit_managed_protocol` tool; the Runner-driven path
 * uses four role-specific emit tools (`emit_scout_verdict`, `emit_contract`,
 * `emit_handoff`, `emit_verdict`). The only adaptation in this file is
 * `ROLE_EMIT_TOOL_NAMES` — every other prompt section is preserved verbatim
 * from v0.7.22 so the LLM gets the exact same guidance (H0/H1/H2 quality
 * framework, parallel child-agent rules, evidence strategies, review-task
 * framing, H1 mutation intent guards, Evaluator public answer rules,
 * handoff/verdict/contract block specs, shared closing rules).
 *
 * Restoring this file during the v0.7.26 parity audit closes the biggest
 * regression found: the Runner-driven `SCOUT_INSTRUCTIONS` / etc constants
 * in `runner-driven.ts` were 10-15 lines of static text; the v0.7.22 prompt
 * was ~480 lines of context-aware guidance. Without this file the LLM did
 * not know to call `dispatch_child_task` for complex tasks (user report),
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
import {
  MANAGED_TASK_CONTRACT_BLOCK,
  MANAGED_TASK_HANDOFF_BLOCK,
  MANAGED_TASK_VERDICT_BLOCK,
} from '../../../managed-protocol.js';
import { isRepoIntelligenceWorkingToolName } from '../../../tools/index.js';
import {
  formatFullSkillSection,
  formatRoleRoundSummarySection,
  formatSkillInvocationSummary,
  formatSkillMapSection,
  formatTaskContract,
  formatTaskMetadata,
  formatToolPolicy,
  formatVerificationContract,
} from './formatting.js';
import {
  inferScoutMutationIntent,
  isReviewEvidenceTask,
  type ManagedRolePromptContext,
} from './role-prompt-types.js';

/**
 * Role → emit tool name mapping. v0.7.22 used a single
 * `emit_managed_protocol` tool; the Runner-driven path routes each role
 * through its own dedicated emitter so the LLM picks the correct schema.
 *
 * Keep in sync with `packages/coding/src/agents/protocol-emitters.ts` —
 * this is the single place the prompt text references emit tools by name.
 */
const ROLE_EMIT_TOOL_NAMES: Record<Exclude<KodaXTaskRole, 'direct'>, string> = {
  scout: 'emit_scout_verdict',
  planner: 'emit_contract',
  generator: 'emit_handoff',
  evaluator: 'emit_verdict',
};

/**
 * Build the system prompt for a single managed-task role.
 *
 * Adapted from v0.7.22 `createRolePrompt`. The `workerId` parameter is kept
 * on the signature for upstream call-site stability even though the body
 * does not read it.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
): string {
  void workerId;
  const originalTask = rolePromptContext?.originalTask || prompt;
  // Issue 119: For post-Scout roles (generator/planner/evaluator), `decision.mutationSurface`
  // is a stale pre-Scout regex heuristic. Show it only to Scout — downstream workers get
  // scope cues from Scout's own scope/reviewFilesOrAreas via the handoff.
  // FEATURE_112 (v0.7.34): Topology ceiling is rendered with a brief semantic gloss
  // **only for Scout** — the bare value (H1_EXECUTE_EVAL / H2_PLAN_EXECUTE_EVAL)
  // had no instruction telling Scout what the ceiling means or what action it
  // implies, so the ceiling lift from Slice 1 had no inference path into Scout's
  // H0/H1/H2 choice. Generator/Planner/Evaluator do NOT see the gloss because
  // (a) Evaluator IS the auditor — telling it "Evaluator can audit your
  // conclusion" is self-referential nonsense; (b) Planner/Generator do not
  // call emit_scout_verdict so "if you escalate" is meaningless; (c) the bare
  // ceiling value is the upper bound the post-Scout roles already operate
  // within and needs no further explanation at runtime.
  const ceilingValue = decision.topologyCeiling ?? decision.upgradeCeiling ?? 'none';
  const scoutCeilingGloss = role === 'scout'
    ? ceilingValue === 'H2_PLAN_EXECUTE_EVAL'
      ? ' — Planner+Generator+Evaluator pipeline available if you escalate to H2'
      : ceilingValue === 'H1_EXECUTE_EVAL'
        ? ' — Evaluator can audit your conclusion if you escalate to H1'
        : ''
    : '';
  const decisionSummary = [
    `Primary task: ${decision.primaryTask}`,
    ...(role === 'scout' ? [`Mutation surface (heuristic): ${decision.mutationSurface ?? 'unknown'}`] : []),
    `Assurance intent: ${decision.assuranceIntent ?? 'default'}`,
    `Work intent: ${decision.workIntent}`,
    `Complexity hint: ${decision.complexity}`,
    `Risk: ${decision.riskLevel}`,
    // FEATURE_061: Don't show pre-decided harness to Scout. Scout is the routing
    // authority and decides the harness based on its own evidence analysis.
    ...(role === 'scout'
      ? [`Topology ceiling: ${ceilingValue}${scoutCeilingGloss}`]
      : [
        `Harness: ${decision.harnessProfile}`,
        `Topology ceiling: ${ceilingValue}`,
      ]),
    `Brainstorm required: ${decision.requiresBrainstorm ? 'yes' : 'no'}`,
  ].join('\n');

  const sharedClosingRule = [
    'Preserve any exact machine-readable closing contract requested by the original task.',
    'Do not claim completion authority unless your role explicitly owns final judgment.',
    'When proposing shell commands or command examples, match the current host OS and shell. Do not assume Unix-only tools such as head on Windows.',
  ].join('\n');

  // v0.7.26 NEW-1 — inject the workspace environment at prompt head.
  // Legacy SA path gets this via `buildSystemPrompt` (Working Directory
  // + environment-context); the Runner-driven path bypasses that
  // builder entirely. Without this block, Scout/Planner/Generator/
  // Evaluator all guess paths (e.g. `cd /d/user/kodax/workspace` when
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

  // v0.7.26 fix — managed workers bypass `buildSystemPrompt` (legacy SA
  // path), so the base `SYSTEM_PROMPT` discipline sections (tmp-directory
  // rule, mkdir warning, cross-platform notes) never reached the LLM. The
  // result: workers wrote scratch files to project root / system tmp
  // instead of `.agent/tmp/`. Re-inject the essential discipline as a
  // shared block prepended to every role's prompt.
  //
  // Generator reasoning-discipline block — adapted verbatim from Claude
  // Code's stuck-handling guidance (Anthropic-tuned). Bidirectional:
  // catches both retry-blindly and abandon-too-early failure modes. Sets
  // a HIGH bar for emit_handoff status="blocked" ("genuine impasses after
  // investigation"). Adopted as default v0.7.32 after FEATURE_107 P6 eval
  // showed it is harmless across 6 aliases on low-context tasks. Only
  // KodaX adaptation: emit_handoff status="blocked" replaces Claude
  // Code's AskUserQuestion (different protocol surface).
  const generatorReasoningDiscipline =
    'If an approach fails, diagnose why before switching tactics — read the error, check your assumptions, try a focused fix. Don\'t retry the identical action blindly, but don\'t abandon a viable approach after a single failure either. Reserve emit_handoff status="blocked" for genuine impasses after investigation, not as a first response to friction.';

  const sharedWorkerDiscipline = [
    'Workspace discipline:',
    '- Helper scripts / scratch files are a last resort, not a default recovery path.',
    "- If you must write a temporary file, write it under `.agent/tmp/` (relative to the git root). That is the designated ephemeral workspace.",
    "- NEVER write scratch files to the project root, to `.agent/` top level (reserved for managed-tasks/, project/, repo-intelligence/), or to the system temp directory. Files in system tmp are invisible to the project and block code review.",
    '- Directories are created automatically by the `write` tool. NEVER use `mkdir` before writing files.',
    '- If you truly need an empty directory: `mkdir dir` (Windows) or `mkdir -p dir` (Unix).',
    '',
    'Cross-platform shell:',
    '- Move: `move` (Windows) vs `mv` (Unix/Mac).',
    '- List: `dir` (Windows) vs `ls` (Unix/Mac).',
    '- Delete: `del` (Windows) vs `rm` (Unix/Mac).',
    '- If you see "not recognized", "不是内部或外部命令", or a similar lookup error, the command does not exist on this platform. Try the platform equivalent.',
  ].join('\n');
  const originalTaskSection = `Original user request:\n${originalTask}`;
  const roundInstructionSection = prompt !== originalTask
    ? `Current round instructions:\n${prompt}`
    : undefined;

  const contractSection = formatTaskContract({
    taskId: 'preview',
    surface: 'cli',
    objective: originalTask,
    createdAt: '',
    updatedAt: '',
    status: 'running',
    primaryTask: decision.primaryTask,
    workIntent: decision.workIntent,
    complexity: decision.complexity,
    riskLevel: decision.riskLevel,
    harnessProfile: decision.harnessProfile,
    recommendedMode: decision.recommendedMode,
    requiresBrainstorm: decision.requiresBrainstorm,
    reason: decision.reason,
    contractSummary: undefined,
    successCriteria: [],
    requiredEvidence: verification?.requiredEvidence ?? [],
    constraints: [],
    metadata,
    verification,
  });
  const metadataSection = formatTaskMetadata(metadata);
  const verificationSection = formatVerificationContract(verification);
  const toolPolicySection = formatToolPolicy(toolPolicy);
  const agentSection = `Assigned native agent identity: ${agent}`;
  const skillInvocation = rolePromptContext?.skillInvocation;
  const skillMap = rolePromptContext?.skillMap;
  const previousRoleSummary = role === 'generator'
    ? undefined
    : rolePromptContext?.previousRoleSummaries?.[role];
  const scoutSkillSection = skillInvocation
    ? [
      formatSkillInvocationSummary(skillInvocation),
      'You own the first intelligent skill decomposition pass. Read the full expanded skill below, then map it into summary/obligations/ambiguities for the downstream harness.',
      formatFullSkillSection(skillInvocation),
    ].filter((section): section is string => Boolean(section)).join('\n\n')
    : undefined;
  const plannerSkillSection = skillMap
    ? [
      formatSkillMapSection(skillMap, rolePromptContext?.skillMapArtifactPath),
      'Use the skill map as the planning view of the skill. Do not rely on the raw skill workflow unless the map explicitly says it is low-confidence and missing critical obligations.',
    ].join('\n\n')
    : undefined;
  const generatorSkillSection = skillInvocation
    ? [
      skillMap ? formatSkillMapSection(skillMap, rolePromptContext?.skillMapArtifactPath) : undefined,
      formatSkillInvocationSummary(skillInvocation, rolePromptContext?.skillExecutionArtifactPath),
      decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
        ? 'You own execution. Treat the raw skill as the authoritative execution reference and the skill map as the coordination surface shared with Planner/Evaluator.'
        : 'You own execution. Treat the raw skill as the authoritative execution reference and the skill map as the lightweight coordination surface shared with Scout/Evaluator.',
      formatFullSkillSection(skillInvocation),
    ].filter((section): section is string => Boolean(section)).join('\n\n')
    : skillMap
      ? [
        formatSkillMapSection(skillMap, rolePromptContext?.skillMapArtifactPath),
        'Treat the skill map as the coordination surface shared with Scout/Evaluator. If any obligation conflicts with the contract, surface it in your handoff.',
      ].join('\n\n')
      : undefined;
  const evaluatorSkillSection = skillMap
    ? [
      formatSkillMapSection(skillMap, rolePromptContext?.skillMapArtifactPath),
      skillMap.rawSkillFallbackAllowed && rolePromptContext?.skillExecutionArtifactPath
        ? `Only if the skill map is incomplete or the Generator's claims conflict with it, reopen the raw skill artifact at ${rolePromptContext.skillExecutionArtifactPath}.`
        : undefined,
    ].filter((section): section is string => Boolean(section)).join('\n\n')
    : undefined;
  const previousRoleSummarySection = previousRoleSummary
    ? formatRoleRoundSummarySection(previousRoleSummary)
    : undefined;
  const reviewLikeTask = isReviewEvidenceTask(decision);
  const reviewPresentationRule = decision.primaryTask === 'review'
    ? [
      'When the task is review or audit, speak directly to the user about the final review findings. Do not frame the answer as grading or critiquing the Generator.',
      'Lead with concrete findings, ordered by severity, and anchor each finding to the strongest available file/path evidence.',
      'If there are no findings, say so explicitly before mentioning residual risks or testing gaps.',
    ].join('\n')
    : undefined;
  const evaluatorPublicAnswerRule = decision.primaryTask === 'review'
    ? [
      'Your public answer must read like the final review report itself.',
      'List concrete findings first, ordered by severity, with tight file/path references whenever the evidence supports them.',
      'Do not collapse the review into a one-line quality summary when concrete findings exist.',
      'If you found no actionable issues, say that explicitly before any residual-risk note.',
      'Do not say that you verified, evaluated, graded, or judged the Generator, its handoff, or its findings.',
      'Do not mention the Planner, Generator, contract, or verdict process in the user-facing answer.',
      'Keep evaluator-only reasoning inside the final verdict block and supporting artifacts.',
    ].join('\n')
    : [
      'Speak directly to the user in the public answer.',
      'Do not describe yourself as reviewing or judging another role.',
      'Keep evaluator-only reasoning inside the final verdict block and supporting artifacts.',
    ].join('\n');
  const repoWorkingToolsEnabled = toolPolicy?.allowedTools
    ? toolPolicy.allowedTools.some((toolName) => isRepoIntelligenceWorkingToolName(toolName))
    : true;
  const diffPagingToolsEnabled = toolPolicy?.allowedTools
    ? toolPolicy.allowedTools.includes('changed_diff') || toolPolicy.allowedTools.includes('changed_diff_bundle')
    : true;
  const parallelBatchGuidance = [
    'When multiple read-only tool calls are independent, emit them in the same response so parallel mode can run them together.',
    'Only serialize tool calls when a later call depends on an earlier result.',
    'Keep parallel batches focused: prefer a few narrow grep/read/diff calls over many tiny sequential probes.',
  ].join('\n');
  const scoutReviewEvidenceGuidance = reviewLikeTask
    ? [
      repoWorkingToolsEnabled
        ? 'For large or history-based reviews, stay at the scope-facts level first: changed_scope -> repo_overview (only when needed) -> a small amount of changed_diff_bundle for high-priority files.'
        : 'For large or history-based reviews in off mode, stay at cheap facts first with glob/grep/read and avoid rebuilding a repo-intelligence-style scope pass.',
      diffPagingToolsEnabled
        ? 'Do not linearly page changed_diff slices or verify individual claims. You are only deciding whether the task should stay direct or move into a heavier harness.'
        : 'Do not linearly page raw file content or verify individual claims. You are only deciding whether the task should stay direct or move into a heavier harness.',
      'When one file dominates the diff, summarize the risk and first-inspection areas instead of paging through the whole file.',
    ].join('\n')
    : undefined;
  const plannerReviewEvidenceGuidance = reviewLikeTask
    ? [
      repoWorkingToolsEnabled
        ? 'Plan from scope facts plus overview evidence only: changed_scope -> repo_overview (only when needed) -> changed_diff_bundle for high-priority files.'
        : 'In off mode, plan from general-purpose evidence only: use glob/grep/read to anchor the contract without assuming repo-intelligence scope tooling is available.',
      diffPagingToolsEnabled
        ? 'Do not linearly page changed_diff slices for large files. If a bundle flags a critical entrypoint or type, use at most a small pinpoint read to anchor the contract.'
        : 'Do not linearly page raw file content for large files. Use at most a small pinpoint read to anchor the contract.',
      'If overview evidence is still incomplete, record the missing proof in required_evidence or constraints instead of omitting the contract.',
    ].join('\n')
    : undefined;
  const generatorReviewEvidenceGuidance = reviewLikeTask
    ? (
        decision.harnessProfile === 'H1_EXECUTE_EVAL'
          ? [
            'Consume the Scout handoff before collecting more evidence.',
            diffPagingToolsEnabled
              ? 'Own the focused deep-evidence pass: use changed_diff/read only on the handoff\'s priority files, suspicious areas, and unresolved claims.'
              : 'Own the focused deep-evidence pass with read/grep only on the handoff\'s priority files, suspicious areas, and unresolved claims.',
            'Do not restart whole-repo evidence gathering unless the Scout handoff explicitly leaves critical scope unresolved.',
            diffPagingToolsEnabled
              ? 'When one file dominates the diff, prefer fewer larger changed_diff slices (roughly limit=360-480) over repeated 100-150 line paging.'
              : 'When one file dominates the evidence, prefer fewer larger read slices over repeated tiny paging.',
          ]
          : [
            'Consume the Scout handoff and Planner contract before collecting more evidence.',
            diffPagingToolsEnabled
              ? 'Own the deep evidence pass: use changed_diff/read to inspect the contract\'s flagged files, suspicious areas, and unresolved claims.'
              : 'Own the deep evidence pass: use read/grep to inspect the contract\'s flagged files, suspicious areas, and unresolved claims.',
            'Do not restart whole-repo evidence gathering unless the contract explicitly leaves critical scope unresolved.',
            diffPagingToolsEnabled
              ? 'When one file dominates the diff, prefer fewer larger changed_diff slices (roughly limit=360-480) over repeated 100-150 line paging.'
              : 'When one file dominates the evidence, prefer fewer larger read slices over repeated tiny paging.',
          ]
      ).join('\n')
    : undefined;
  const h1GeneratorExecutionGuidance = decision.harnessProfile === 'H1_EXECUTE_EVAL'
    ? [
      'This is lightweight H1 checked-direct execution, not mini-H2.',
      'Start from the Scout handoff. Reuse its cheap-facts summary, scope notes, and evidence-acquisition hints instead of rebuilding them from scratch.',
      'Gather only the minimum deep evidence needed to answer well or to support one short revise pass.',
      'Do not create a planner-style execution plan, contract, or broad repo survey.',
      'Converge quickly on the user-facing answer and a crisp evidence handoff for the lightweight evaluator.',
    ].join('\n')
    : undefined;
  // Issue 119: Read Scout's own scope analysis instead of the stale pre-Scout
  // heuristic. When Scout's scope is 'open' (the default when Scout didn't
  // flag it as review-only or docs-only), emit no hard mutation guard — trust
  // Scout's scope handoff + Evaluator instead of layering extra constraints.
  const h1MutationIntent = decision.harnessProfile === 'H1_EXECUTE_EVAL'
    ? inferScoutMutationIntent(
        rolePromptContext?.scoutScope,
        decision.primaryTask,
        rolePromptContext?.scoutScope?.confirmedHarness,
      )
    : 'open';
  const h1MutationGuardance = decision.harnessProfile === 'H1_EXECUTE_EVAL'
    ? (
        h1MutationIntent === 'review-only'
          ? 'Scout scoped this as a review-focused run (primary task: review, no files in scope). Treat it as non-mutating unless Scout\'s handoff explicitly asks for fixes — then act within that narrow scope only.'
          : h1MutationIntent === 'docs-scoped'
            ? 'Scout\'s scope points entirely at documentation paths. Keep edits within those paths unless new evidence during execution demands changes outside them — call that out explicitly in the handoff if so.'
            : undefined
      )
    : undefined;
  const evaluatorReviewEvidenceGuidance = reviewLikeTask
    ? (
        decision.harnessProfile === 'H1_EXECUTE_EVAL'
          ? [
            'Start from the Scout handoff and Generator handoff.',
            diffPagingToolsEnabled
              ? 'Use targeted spot-checks on the highest-risk claims with changed_diff/read. Do not repeat the Generator\'s full deep-evidence pass unless the handoff is contradictory or structurally incomplete.'
              : 'Use targeted spot-checks on the highest-risk claims with read/grep. Do not repeat the Generator\'s full deep-evidence pass unless the handoff is contradictory or structurally incomplete.',
            diffPagingToolsEnabled
              ? 'When a tool reports truncated output, narrow the follow-up by path or offset, or switch from changed_diff to changed_diff_bundle instead of repeating the same broad request.'
              : 'When a tool reports truncated output, narrow the follow-up by path or offset instead of repeating the same broad request.',
          ]
          : [
            'Start from the Planner contract and Generator handoff.',
            diffPagingToolsEnabled
              ? 'Use targeted spot-checks on the highest-risk claims with changed_diff/read. Do not repeat the full deep-evidence pass unless the handoff is contradictory or structurally incomplete.'
              : 'Use targeted spot-checks on the highest-risk claims with read/grep. Do not repeat the full deep-evidence pass unless the handoff is contradictory or structurally incomplete.',
            diffPagingToolsEnabled
              ? 'When a tool reports truncated output, narrow the follow-up by path or offset, or switch from changed_diff to changed_diff_bundle instead of repeating the same broad request.'
              : 'When a tool reports truncated output, narrow the follow-up by path or offset instead of repeating the same broad request.',
          ]
      ).join('\n')
    : undefined;
  const handoffBlockInstructions = [
    `Append a final fenced block named \`\`\`${MANAGED_TASK_HANDOFF_BLOCK}\` with this exact shape:`,
    'status: ready|incomplete|blocked',
    'summary: <one-line handoff summary>',
    'evidence:',
    '- <evidence item>',
    'followup:',
    '- <required next step or "none">',
    '- <optional second next step>',
    'Keep the role output above the block.',
  ].join('\n');
  const emitToolName = role !== 'direct' ? ROLE_EMIT_TOOL_NAMES[role] : undefined;
  const managedProtocolToolInstructions = role !== 'direct' && emitToolName && (!isTerminalAuthority || role !== 'generator')
    ? [
      'PROTOCOL EMISSION — MUST be in the SAME response as your answer:',
      `Write your user-facing answer, then call "${emitToolName}" exactly once — all in the SAME response.`,
      'Pass a minimal protocol payload matching your role contract.',
      'Do NOT stop between writing your answer and calling the protocol tool. Emit both in one turn.',
      'Keep the user-facing answer in normal text. Do not bury it inside the protocol payload.',
      'Never mention internal protocol tools, fenced blocks, MCP, capability runtimes, or extension runtimes in the user-facing answer.',
      // D2 parity (v0.7.22 line restored) — tell the LLM how to fall back
      // when tool calling isn't available on the provider. The fenced-block
      // parser in `sanitize.ts` + `parse-helpers.ts` still accepts this
      // payload form; without the prompt line, LLMs on CLI-bridge and
      // self-hosted OpenAI-compat providers never discover it.
      'If tool calling is unavailable, append the required fenced block at the end of this same response.',
    ].join('\n')
    : undefined;

  switch (role) {
    case 'scout':
      return [
        'You are Scout — the AMA entry role for a managed KodaX task.',
        workspaceSection,
        decisionSummary,
        originalTaskSection,
        roundInstructionSection,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        parallelBatchGuidance,
        scoutSkillSection,
        previousRoleSummarySection,
        decision.primaryTask === 'review'
          ? 'If you finish a review directly, write the answer as the review report itself: findings first, with concrete file/path references, not as a meta-summary of your own process.'
          : undefined,
        // FEATURE_106 (v0.7.31): three-tier framework rewritten with
        // quantitative H0 boundary + hard-rule scope commitment. Replaces
        // the v0.7.26 "default H0" framing that — combined with FEATURE_103
        // reasoning escalation — biased Scout into staying H0_DIRECT for
        // multi-file projects. The scope guardrail (Slice 1) surfaces
        // belated commitments at runtime; this prompt is the
        // pre-commitment teaching half of the calibration.
        [
          'QUALITY FRAMEWORK — Think of yourself as a senior engineer who just received this task.',
          '',
          'You have the full default tool set: read / grep / glob / bash / write / edit /',
          'dispatch_child_task(read-only) / exit_plan_mode. The harness decision below is about WHETHER',
          'your work needs an independent reviewer — NOT about whether you are allowed to use those tools.',
          '',
          'H0 — Bounded mutation OR pure answer. ≤1 file ≤30 lines mutation, OR no file',
          '  mutation at all (lookup / review / answer / git commit / config change / one-off',
          '  scratch file / straightforward typo).',
          '  → For mutation tasks within this bound, complete directly. For non-mutation tasks',
          '    (lookup / review / answer), no emit needed. Anything beyond this bound MUST',
          '    emit_scout_verdict first (see SCOPE COMMITMENT below).',
          '',
          'H1 — Multi-file change in known territory: bug fix across modules, refactor of familiar',
          '  code, security/perf fix. ≥2 files OR >30 lines mutation in 1 file.',
          '  → Call emit_scout_verdict with confirmed_harness="H1_EXECUTE_EVAL" to escalate. A Generator+Evaluator pipeline will handle it.',
          '',
          'H2 — New code without existing anchor: project from scratch, cross-module refactor,',
          '  new feature, system design, database migration.',
          '  → Call emit_scout_verdict with confirmed_harness="H2_PLAN_EXECUTE_EVAL" to escalate. A Planner+Generator+Evaluator pipeline will handle it.',
          '',
          'ESCALATION EXAMPLE:',
          '  emit_scout_verdict({confirmed_harness:"H1_EXECUTE_EVAL", summary:"...", scope:[...], review_files_or_areas:[...]})',
          '',
          'SCOPE COMMITMENT (hard rule):',
          '  Default harness is H0_DIRECT. The triggers below are escalation conditions, not defaults —',
          '  apply them only when one fires for the current task. Simple lookups, single-file edits, and',
          '  pure answer questions stay at H0 even when the rules below are present in this prompt.',
          '',
          '  • Mutation scope: If you intend to write ≥2 files OR start a project from scratch,',
          '    call emit_scout_verdict({confirmed_harness: H1 or H2}) BEFORE the first write.',
          '    The scope guardrail will surface belated commitments and slow you down.',
          '  • Investigation scope: If your read-only investigation reaches ≥5 distinct files',
          '    OR ≥8 searches without converging on a diagnosis, treat that as a signal the work',
          '    has exceeded H0 — emit emit_scout_verdict({confirmed_harness:"H1_EXECUTE_EVAL"}) so',
          '    an Evaluator can audit your conclusion. Continuing solo past this threshold loses',
          '    the audit signal.',
          '  • Multi-thread early decision: If your initial 1-2 scoping turns reveal ≥2',
          '    independent investigation threads, prefer dispatch_child_task over deep-diving',
          '    solo (per RULE A/B below). Dispatching AFTER you have already deep-dived is',
          '    wasted work — decide early.',
        ].join('\n'),
        // FEATURE_097 (v0.7.34) — H0 mini-planner addendum, Heavy variant.
        // Pinned VERBATIM from the 2026-05-04 64-cell A/B eval winner;
        // see `benchmark/datasets/scout-h0-mini-planner/cases.ts` and
        // `benchmark/results/feature-097--pilot-1run--ANALYSIS.md`. Heavy
        // beat Light by +14.5pp obligation_coherence (eliminating "Read X"
        // filler steps across zhipu / kimi / ark families) while keeping
        // simple_overformalization at 0%. Do not edit this block without
        // re-running the eval and updating the pin.
        [
          'EXECUTION OBLIGATIONS:',
          '  For any task that requires ≥ 2 distinct execution steps (whether at H0_DIRECT,',
          '  H1_EXECUTE_EVAL, or H2_PLAN_EXECUTE_EVAL), populate executionObligations with',
          '  one entry per step BEFORE calling emit_scout_verdict.',
          '',
          '  Examples of "distinct execution steps" (DO list separately):',
          '    - Editing files in different modules',
          '    - Refactor + verification (e.g. rename + run tests)',
          '    - Multiple changes to the same file when each is independent',
          '',
          '  Examples of NOT distinct steps (do NOT split into multiple obligations):',
          '    - Reading a file before editing it (preparation, not a step)',
          '    - "Think about X" or "analyze Y" (reasoning, not a step)',
          '    - Single-token typo fixes (single action, no plan needed)',
          '',
          '  After emit_scout_verdict, when continuing as H0_DIRECT executor, call',
          '  todo_update at each transition (pending → in_progress → completed) so the',
          '  user sees real-time progress. This gives the user a visible plan and forces',
          '  you to think through the full scope before acting.',
        ].join('\n'),
        'You are the Scout. For simple tasks (H0): complete the work directly and give the final answer.',
        'For complex tasks (H1/H2): investigate scope, then call emit_scout_verdict with the right harness to escalate. Do NOT do the implementation yourself for H1/H2 tasks.',
        'Respect any stated topology ceiling or upgrade ceiling in the routing metadata.',
        'Always fill `scope` (files / areas the downstream role will touch) and `review_files_or_areas` (high-priority files to consider). The harness infers mutation boundaries from these paths — if every path is docs-like, Generator is restricted to docs-style writes; if the task is a pure review (primaryTask=review) and `scope` is empty, Generator writes are blocked entirely.',
        scoutReviewEvidenceGuidance,
        // FEATURE_067: dispatch_child_task tool guidance.
        // v0.7.26 refresh: RULE-based decision tree covers both fan-out
        // (parallel children) and context-preservation (single child on a
        // heavy read-only investigation). The prior prompt's categorical
        // "NEVER dispatch exactly 1 child" blocked the latter case, so
        // Scout rationalised large multi-file investigations into direct
        // work and crowded its own context.
        [
          'PARALLEL CHILD AGENTS: dispatch_child_task delegates an investigation to a child agent that has its own context window. Calls in the same turn run in parallel; each child\'s findings return as a separate tool result.',
          '',
          'DECIDE after your initial 1-2 scoping turns, before any deep investigation:',
          '',
          'RULE A — Fan-out (2+ independent non-trivial threads)',
          '  "Non-trivial" means each thread on its own would need multiple file reads or multi-round searching. A bundle of small file lookups is NOT fan-out.',
          '  → Dispatch ONE child per thread, in the SAME turn.',
          '  Example: "Audit packages/ai, packages/agent, packages/coding for security" → 3 parallel children.',
          '  If you identify N qualifying threads, dispatch ALL N. Do not rationalize "I\'ll handle one myself" — that defeats the parallelism.',
          '',
          'RULE B — Heavy single investigation (context preservation)',
          '  Dispatch ONE child when BOTH conditions hold:',
          '    (1) the raw volume would crowd your own context — any signal qualifies: unclear target set needing multi-round "search → read → re-search", likely ≥10 file reads, or large grep result sets; AND',
          '    (2) you only need a summary / list / verdict as output — not the raw code in your own context to reason over.',
          '  Example: "Find every caller of handleAuth() and categorize usage patterns."',
          '',
          'RULE C — Default (targets known, output small, single-round)',
          '  Do it yourself with parallel tool calls (glob + grep + read together when independent).',
          '  A single child for work that fits this rule is pure overhead — do not dispatch.',
          '',
          // Issue 124 (v0.7.28) A5b: explicit negative-bumper list. Mirrors
          // the "When NOT to use" pattern used by Claude Code\'s Agent tool
          // and opencode\'s task tool — concrete refusal cases reduce
          // accidental dispatch on simple lookups.
          'When NOT to use dispatch_child_task (do these directly instead):',
          '  - Reading a known specific file path → use read_file directly.',
          '  - Searching for a known symbol like `class Foo` or `function bar` → use grep_files.',
          '  - Looking at 2–3 files you have already identified → parallel read_file calls.',
          '  - Work where you will keep the raw output in your own context anyway.',
          '',
          'TIMING: decide early. Children\'s findings can inform your emit_scout_verdict harness choice. Dispatching after you have already deep-dived is wasted work.',
          'Scope: Scout dispatches are readOnly. Write fan-out is Generator-only.',
        ].join('\n'),
        managedProtocolToolInstructions,
        sharedWorkerDiscipline,
        sharedClosingRule,
      ].filter((section): section is string => Boolean(section)).join('\n\n');
    case 'planner':
      return [
        'You are Planner — the H2 planning role for a managed KodaX task.',
        workspaceSection,
        decisionSummary,
        originalTaskSection,
        roundInstructionSection,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        parallelBatchGuidance,
        plannerSkillSection,
        previousRoleSummarySection,
        managedProtocolToolInstructions,
        plannerReviewEvidenceGuidance,
        'The Scout-confirmed harness is the active harness for this run. Do not reinterpret it locally; only request a stronger harness through an explicit later verdict if the evidence truly demands it.',
        'Produce a concise execution plan, the critical risks, and the evidence checklist.',
        `Your output is invalid unless you call "${ROLE_EMIT_TOOL_NAMES.planner}" with the contract payload.`,
        'Even if evidence is still incomplete, produce the best current contract and record the missing proof in required_evidence or constraints rather than omitting the call.',
        'Do not linearly page large raw diffs or perform file-by-file claim verification. Stop at overview evidence and hand deep inspection to the Generator.',
        'Do not perform the work yet and do not self-certify completion.',
        // FEATURE_097 (v0.7.34): when refining Scout obligations, the runner
        // updates the user-visible plan list automatically from your contract.
        // You only need to call todo_update if you want to record interim
        // status transitions (rare for a planner; status transitions are
        // mostly Generator territory).
        'PLAN PROGRESS: The user-visible plan list is refreshed automatically from your contract. You generally do not need to call todo_update; if you do, restrict it to status="skipped" when an obligation turned out to be unnecessary (Generator handles in_progress / completed transitions). If todo_update returns ok=false with reason "not active", no plan list was seeded for this run.',
        [
          `Contract payload shape (pass to ${ROLE_EMIT_TOOL_NAMES.planner}):`,
          'summary: <one-line contract summary>',
          'success_criteria:',
          '- <criterion>',
          'required_evidence:',
          '- <evidence item>',
          'constraints:',
          '- <constraint or leave empty>',
          `(The fenced-block form \`\`\`${MANAGED_TASK_CONTRACT_BLOCK}\`\`\` is accepted as a fallback; prefer the tool call.)`,
        ].join('\n'),
        sharedWorkerDiscipline,
        sharedClosingRule,
      ].filter((section): section is string => Boolean(section)).join('\n\n');
    case 'generator':
      return [
        'You are Generator — the H1/H2 execution role for a managed KodaX task.',
        workspaceSection,
        decisionSummary,
        originalTaskSection,
        roundInstructionSection,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        parallelBatchGuidance,
        generatorSkillSection,
        managedProtocolToolInstructions,
        reviewPresentationRule,
        generatorReviewEvidenceGuidance,
        h1GeneratorExecutionGuidance,
        h1MutationGuardance,
        'The Scout-confirmed harness is the active harness for this run. Do not reinterpret it locally; only request a stronger harness through an explicit later verdict if the evidence truly demands it.',
        'Read the managed task artifacts and dependency handoff artifacts before acting. Treat them as the primary coordination surface.',
        'Execute the task or produce the requested deliverable.',
        // FEATURE_097 (v0.7.34): drive the user-visible plan list so progress
        // is observable round-to-round. The tool soft-fails if no plan was
        // seeded for this run, so calling it is always safe.
        'PLAN PROGRESS: When the run carries a visible obligation list (Scout produced ≥ 2 execution obligations), call todo_update at each transition: status="in_progress" BEFORE starting an obligation, status="completed" AFTER finishing it. Only ONE obligation should be in_progress at a time (per owner). If a step clearly fails and needs retry, set status="failed" with a brief note. If todo_update returns ok=false with reason "not active", no plan list was seeded for this run — continue without calling it.',
        // FEATURE_107 P5: experimental, env-gated, P6 cleanup target.
        generatorReasoningDiscipline,
        isTerminalAuthority
          ? 'You are the terminal delivery role for this run. Return the final user-facing answer and summarize concrete evidence inline.'
          : 'Leave final judgment to the evaluator and include a crisp evidence handoff.',
        // FEATURE_067: Generator parallel task guidance via dispatch_child_task tool.
        // v0.7.26 refresh: mirrors the Scout RULE A/B/C structure so the
        // same decision model applies to mid-execution investigation.
        // Categorical "NEVER 1 child" was blocking the context-preservation
        // case where a Generator faces a heavy read-only verification that
        // would otherwise crowd its own context.
        [
          'PARALLEL CHILD AGENTS: dispatch_child_task delegates a sub-task to a child agent with its own context window. Calls in the same turn run in parallel; each child\'s findings return as a separate tool result.',
          '',
          'DECIDE when you hit a sub-task that is either fan-out or heavy-volume:',
          '',
          'RULE A — Fan-out (2+ independent non-trivial sub-tasks)',
          '  "Non-trivial" means each sub-task on its own would need multiple file reads / writes or multi-round searching.',
          '  → Dispatch ONE child per sub-task, in the SAME turn.',
          '  Example: modifying 3 independent modules in an H2 run → 3 parallel write children.',
          '  If you identify N qualifying sub-tasks, dispatch ALL N.',
          '',
          'RULE B — Heavy single investigation (context preservation)',
          '  Dispatch ONE readOnly child when BOTH hold:',
          '    (1) the raw volume would crowd your own context — any signal: unclear target set needing multi-round search, likely ≥10 file reads, or large grep result sets; AND',
          '    (2) you only need a summary / list / verdict — not raw code in your own context to continue execution.',
          '  Example: verifying "no other callers of removed API remain" across the repo before committing.',
          '',
          'RULE C — Default (targets known, output small, single-round)',
          '  Do it yourself with parallel tool calls. A single child for work that fits this rule is pure overhead.',
          '',
          // Issue 124 (v0.7.28) A5b: same negative bumper list as Scout, so
          // Generator mid-execution dispatch decisions follow identical
          // refusal cases.
          'When NOT to use dispatch_child_task (do these directly instead):',
          '  - Reading a known specific file path → use read_file directly.',
          '  - Searching for a known symbol like `class Foo` or `function bar` → use grep_files.',
          '  - Looking at 2–3 files you have already identified → parallel read_file calls.',
          '  - Work where you will keep the raw output in your own context anyway.',
          '',
          decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL' && !isTerminalAuthority
            ? 'WRITE FAN-OUT: In this H2 run you may call with readOnly=false when modifying independent modules. Each write child runs in an isolated git worktree; the Evaluator reviews all diffs before merging.'
            : 'Write fan-out (readOnly=false) is only available in H2_PLAN_EXECUTE_EVAL harness. In the current harness, children must be readOnly=true.',
        ].join('\n'),
        isTerminalAuthority ? undefined : handoffBlockInstructions,
        sharedWorkerDiscipline,
        sharedClosingRule,
      ].filter(Boolean).join('\n\n');
    case 'evaluator':
      return [
        'You are Evaluator — the H1/H2 verifier role for a managed KodaX task.',
        workspaceSection,
        decisionSummary,
        originalTaskSection,
        roundInstructionSection,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        parallelBatchGuidance,
        evaluatorSkillSection,
        previousRoleSummarySection,
        managedProtocolToolInstructions,
        reviewPresentationRule,
        evaluatorReviewEvidenceGuidance,
        'The Scout-confirmed harness is the active harness for this run. Do not reinterpret it locally; only recommend a stronger harness when the evidence clearly shows the current harness cannot safely finish the task.',
        'Read the managed task artifacts and dependency handoff artifacts before acting. Treat them as the primary coordination surface.',
        'Judge whether the dependency handoff satisfies the original task and whether the evidence is strong enough.',
        // FEATURE_067: Inject write fan-out review prompt for Evaluator
        rolePromptContext?.childWriteReviewPrompt
          ? [
            '## Child Agent Write Diffs — Pending Your Review',
            '',
            'The Generator spawned parallel child agents that modified code in isolated worktrees.',
            'Review each child\'s diff below. For each child, decide ACCEPT or REVISE.',
            'ACCEPT: changes are correct and consistent — they will be merged to the main branch.',
            'REVISE: changes need fixes — explain what\'s wrong so Generator can retry.',
            '',
            rolePromptContext.childWriteReviewPrompt,
          ].join('\n')
          : undefined,
        decision.harnessProfile === 'H1_EXECUTE_EVAL'
          ? [
            'You are the lightweight H1 evaluator, not a second full executor.',
            'Only check whether the answer is on target, whether it misses obvious requested work, whether key claims have evidence, and whether the answer sounds obviously overconfident.',
            'Do not broad-scan the repo, do not linearly page large diffs, and do not rerun the Generator\'s whole analysis.',
            'Only run a limited spot-check when the task explicitly requires verification or the Generator claimed a concrete test/check that needs confirmation.',
            'Do not request a stronger harness. H1 must stay lightweight; if the answer is still incomplete after one short revise pass, return the best supported answer with explicit limits instead of escalating to H2.',
            'When status=revise, keep the user-facing text short and specific: list the missing items, evidence gaps, or overconfident claims that the Generator must fix next.',
            'Do not write a full polished final report when status=revise. Reserve the full final-report style for accept, or for blocked when you must return the best supported answer with explicit limits.',
          ].join('\n')
          : 'You own the final verification pass and must personally execute any required checks or browser validation before accepting the task.',
        'Evaluate the task against the verification criteria and thresholds. If any hard threshold is not met, do not accept the task.',
        evaluatorPublicAnswerRule,
        (() => {
          // Use the effective ceiling (upgradeCeiling reflects the system's actual
          // decision after Scout override; topologyCeiling is the original heuristic).
          // This avoids telling the evaluator "don't exceed H0" when the task is
          // legitimately running at H1 because Scout escalated.
          const effectiveCeiling = decision.upgradeCeiling ?? decision.topologyCeiling;
          return effectiveCeiling && effectiveCeiling !== 'H2_PLAN_EXECUTE_EVAL'
            ? `Do not request a stronger harness than ${effectiveCeiling}. If the task is still incomplete at that ceiling, return the best supported user-facing answer with explicit limits instead of escalating further.`
            : undefined;
        })(),
        'Return the final user-facing answer. If the task is not ready, explain the blocker or missing evidence clearly.',
        'If the original task requires an exact closing block, include it in your final answer when you conclude.',
        [
          `Verdict payload shape (pass to ${ROLE_EMIT_TOOL_NAMES.evaluator}):`,
          'status: accept|revise|blocked',
          'reason: <one-line reason>',
          'user_answer: <optional final user-facing answer; multi-line content may continue on following lines>',
          decision.harnessProfile === 'H1_EXECUTE_EVAL'
            ? undefined
            : 'next_harness: <optional stronger harness when revise requires it>',
          'followup:',
          '- <required next step>',
          '- <optional second next step>',
          'Prefer putting the final user-facing answer in user_answer. If omitted, keep the user-facing answer above the call. Use status=revise when more execution should happen before acceptance.',
          `(The fenced-block form \`\`\`${MANAGED_TASK_VERDICT_BLOCK}\`\`\` is accepted as a fallback; prefer the tool call.)`,
        ].filter((line): line is string => Boolean(line)).join('\n'),
        sharedWorkerDiscipline,
        sharedClosingRule,
      ].filter((section): section is string => Boolean(section)).join('\n\n');
    case 'direct':
    default:
      return prompt;
  }
}
