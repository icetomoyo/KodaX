/**
 * Role-prompt resolution for the runner-driven AMA path.
 *
 * Hosts the `WORKER_INSTRUCTIONS_FALLBACK` constant used when
 * `buildRunnerAgentChain` is invoked without a full prompt context
 * (topology-only tests; V1 scout/planner/generator fallbacks deleted
 * by FEATURE_193 v0.7.43), plus the runtime resolver
 * `resolveRoleInstructions` that bridges `RunnerChainPromptContext`
 * through `createRolePrompt` for the current Worker prompt surface.
 *
 * Extracted from `task-engine/runner-driven.ts` (lines 345–681 in the
 * pre-FEATURE_171 monolith) as part of FEATURE_171 (v0.7.41) modular
 * split. Zero behavior change — bodies are byte-identical to the
 * previous in-file declarations.
 */

import type {
  KodaXTaskRole,
  KodaXTaskVerificationContract,
} from '../../../types.js';
import {
  buildWorkerActorCapacityContract,
  type WorkerActorCapacity,
} from '../../../agents/worker-role-prompt.js';
import { createRolePrompt } from './role-prompt.js';
import { EXECUTION_GUIDANCE } from '../../../prompts/execution-guidance.js';
import { formatVerificationContract } from './formatting.js';
import type { ManagedRolePromptContext } from './role-prompt-types.js';
import type { RunnerChainPromptContext } from './types.js';

// FEATURE_193 (v0.7.43): SCOUT_INSTRUCTIONS_FALLBACK, PLANNER_INSTRUCTIONS_FALLBACK,
// GENERATOR_INSTRUCTIONS_FALLBACK deleted — V1 chain roles retired.
// Only WORKER_INSTRUCTIONS_FALLBACK remains for the topology-only test path.

// FEATURE_114 v0.7.36 — minimal Worker instructions for the
// topology-only test path (no `promptContext`). Real Worker prompts
// are produced by `createRolePrompt('worker', ...)` via
// `worker-role-prompt.ts`. Mirrors the other *_FALLBACK constants
// above; the production path never reaches this string.
export const WORKER_INSTRUCTIONS_FALLBACK = [
  'You are Worker (AMA Harness V2 single-loop primary agent). Plan semantic ',
  'milestones via `todo_create` and `todo_update`; do not create one item per ',
  'child Agent. Execute via tool calls and update finished milestones before ',
  'waiting again or moving on, then end your turn with a brief ',
  'text-only summary when done — no tool call is needed to terminate. Verify ',
  'the actual result with available tools and report unverified requirements. ',
  'You may call: read, grep, glob, bash, write, edit, multi_edit, ',
  'todo_create, todo_update, todo_list, spawn_agent, send_message, followup_task, wait_agent, interrupt_agent, list_agents, agent_output, exit_plan_mode.',
].join('\n') + '\n' + EXECUTION_GUIDANCE;

function createResolvedRolePrompt(role: KodaXTaskRole,
  agentName: string,
  promptContext: RunnerChainPromptContext,
  verification: KodaXTaskVerificationContract | undefined,
  renderMode: 'stable' | 'context',
  resolvedContext?: ManagedRolePromptContext
): string {
  const ctx = resolvedContext ?? (promptContext.contextFactory
    ? promptContext.contextFactory(role)
    : { originalTask: promptContext.prompt });
  const toolPolicy = promptContext.toolPolicyFactory
    ? promptContext.toolPolicyFactory(role)
    : promptContext.toolPolicy;
  const decision = typeof promptContext.decision === 'function'
    ? promptContext.decision()
    : promptContext.decision;
  return createRolePrompt(
    role,
    promptContext.prompt,
    decision,
    verification,
    toolPolicy,
    agentName,
    promptContext.metadata,
    ctx,
    undefined,
    false,
    renderMode,
  );
}

// FEATURE_193 (v0.7.43): `renderScoutSkillMapBlock` removed — fed
// Scout's skillMap into Generator/Evaluator prompts. V1 Scout retired,
// `recorder.scout` is never populated on V2, so the helper produced
// `undefined` on every call. All call sites were removed in commits
// 1–5; this commit drops the dangling exporter.

/**
 * Resolve the system prompt for a role. When the full `promptContext`
 * (prompt + decision) is present, delegate to `createRolePrompt` for the
 * v0.7.22-parity prompt (decision summary, contract, metadata,
 * verification, tool-policy, evidence strategies, and collaboration
 * guidance).
 * Otherwise fall back to the minimal static constants — keeps test
 * fixtures that call `buildRunnerAgentChain(ctx, {})` working.
 */
export function resolveRoleInstructions(role: KodaXTaskRole,
  agentName: string,
  fallback: string,
  promptContext: RunnerChainPromptContext | undefined,
  verification: KodaXTaskVerificationContract | undefined,
  fallbackActorCapacity?: WorkerActorCapacity
): string {
  if (!promptContext) {
    // Legacy minimal-instructions path for tests / topology-only calls.
    // FEATURE_193 (v0.7.43): removed role === 'generator' skillMap append —
    // generator role deleted along with V1 chain.
    void fallbackActorCapacity;
    return fallback;
  }
  const basePrompt = createResolvedRolePrompt(
    role,
    agentName,
    promptContext,
    verification,
    'stable',

  );
  // FEATURE_247 (R1): a Partner profile (or any SDK-consumer profile) can carry
  // its own behavior instructions. On the SA path the embedder uses
  // `context.systemPromptOverride`; the AMA/AMAW Worker builds its role prompt
  // internally, so we PREPEND the profile instructions here as the governing
  // directive while keeping the managed-task scaffolding (todo / dispatch /
  // verdict) intact. Gated on the primary `worker` role AND presence, so the
  // default Coding Agent role prompt is byte-identical.
  const partnerBlock = role === 'worker'
    ? promptContext.partnerInstructions?.trim()
    : undefined;
  return partnerBlock
    ? `${partnerBlock}\n\n${basePrompt}`
    : basePrompt;
}

/** Resolve the full run-scoped context installed before the real user task. */
export function resolveRoleRunContext(role: KodaXTaskRole,
  agentName: string,
  promptContext: RunnerChainPromptContext | undefined,
  verification: KodaXTaskVerificationContract | undefined,
  resolvedContext?: ManagedRolePromptContext
): string | undefined {
  if (!promptContext) return formatVerificationContract(verification);
  const roleContext = createResolvedRolePrompt(
    role,
    agentName,
    promptContext,
    verification,
    'context',
    resolvedContext,

  );
  const repoBlock = promptContext.repoIntelligenceContext?.trim();
  const composed = repoBlock
    ? `${roleContext}\n\n${repoBlock}`
    : roleContext;
  return composed.trim().length > 0
    ? `=== Managed Run Context ===\n${composed}\n=== End Managed Run Context ===`
    : undefined;
}

/** Render the small runtime-state surface used for changed-only deltas. */
export function resolveRoleRuntimeStateContext(
  context: ManagedRolePromptContext | undefined,
): string | undefined {
  const scratchDirectory = context?.workspace?.scratchDir
    ? [
      '## Session Environment',
      `Session Scratch Directory: ${context.workspace.scratchDir}`,
    ].join('\n')
    : undefined;
  const actorCapacity = buildWorkerActorCapacityContract(context?.actorCapacity);
  const teamMode = context?.teamModeSection?.trim();
  const composed = [scratchDirectory, actorCapacity, teamMode]
    .filter((section): section is string => Boolean(section))
    .join('\n\n');
  return composed.length > 0
    ? `=== Managed Run Context ===\nRuntime state refresh:\n${composed}\n=== End Managed Run Context ===`
    : undefined;
}

/** Clock-free comparison key for changed-only runtime context emission. */
export function resolveRoleRuntimeStateFingerprint(
  context: ManagedRolePromptContext | undefined,
): string | undefined {
  if (!context) return undefined;
  const snapshot = {
    scratchDir: context.workspace?.scratchDir,
    actorCapacity: context.actorCapacity,
    teamMode: context.teamModeFingerprint,
  };
  return Object.values(snapshot).every((value) => value === undefined)
    ? undefined
    : JSON.stringify(snapshot);
}

/**
 * Shard 6d-S: render `verification.runtime` into an Evaluator-facing
 * block listing the startup command, ready signal, base URL, declared
 * UI flows, API checks, DB checks, and fixtures. Legacy
 * `buildRuntimeExecutionGuide` wrote an equivalent markdown file to
 * `runtime-execution.md`; the Runner path also needs to surface the
 * same obligations inline so the Evaluator actively probes the runtime
 * instead of writing a verdict from static file reads. Without this
 * block, `taskVerification.runtime` is persisted to
 * `runtime-contract.json` but never reaches the model making the
 * accept/revise/blocked call.
 */
export function renderRuntimeVerificationBlock(
  verification: KodaXTaskVerificationContract | undefined,
): string | undefined {
  const runtime = verification?.runtime;
  if (!runtime) return undefined;
  const hasAny = Boolean(
    runtime.startupCommand
      || runtime.readySignal
      || runtime.baseUrl
      || (runtime.uiFlows?.length ?? 0) > 0
      || (runtime.apiChecks?.length ?? 0) > 0
      || (runtime.dbChecks?.length ?? 0) > 0
      || (runtime.fixtures?.length ?? 0) > 0,
  );
  if (!hasAny) return undefined;
  const lines = ['', '=== Runtime Verification Contract ==='];
  if (runtime.cwd) lines.push(`- cwd: ${runtime.cwd}`);
  if (runtime.startupCommand) lines.push(`- startup_command: ${runtime.startupCommand}`);
  if (runtime.readySignal) lines.push(`- ready_signal: ${runtime.readySignal}`);
  if (runtime.baseUrl) lines.push(`- base_url: ${runtime.baseUrl}`);
  if (runtime.env && Object.keys(runtime.env).length > 0) {
    lines.push(`- env_keys: ${Object.keys(runtime.env).join(', ')}`);
  }
  if (runtime.uiFlows?.length) {
    lines.push('ui_flows (execute with bash via the app\'s own test harness; capture evidence):');
    runtime.uiFlows.forEach((flow, idx) => lines.push(`  ${idx + 1}. ${flow}`));
  }
  if (runtime.apiChecks?.length) {
    lines.push('api_checks (curl / wget / app-specific CLI):');
    runtime.apiChecks.forEach((check, idx) => lines.push(`  ${idx + 1}. ${check}`));
  }
  if (runtime.dbChecks?.length) {
    lines.push('db_checks (psql / sqlite / equivalent):');
    runtime.dbChecks.forEach((check, idx) => lines.push(`  ${idx + 1}. ${check}`));
  }
  if (runtime.fixtures?.length) {
    lines.push('fixtures:');
    runtime.fixtures.forEach((fixture, idx) => lines.push(`  ${idx + 1}. ${fixture}`));
  }
  lines.push(
    'Before accepting, start the runtime (if declared), wait for the ready signal, and ',
    'exercise every declared flow/check. Reject (status=revise or blocked) if any check ',
    'cannot be executed or fails.',
  );
  return lines.join('\n');
}
