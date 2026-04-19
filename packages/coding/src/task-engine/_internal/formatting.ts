/**
 * FEATURE_079 — Task Engine Phase 1 Pure Extraction (Slice 5 + Slice 8)
 *
 * Pure formatting helpers extracted from task-engine.ts. Each function is a
 * pure string-building function of its public `KodaX*` type inputs — no side
 * effects, no state, no dependency on task-engine-local types.
 *
 * Slice 8 addition: `formatVerificationContract` joined this module after
 * `buildRuntimeExecutionGuide` itself moved to `./prompts/runtime-execution-guide.ts`,
 * removing its only task-engine-local dependency.
 *
 * Not moved (deferred):
 * - `formatBudgetHint` — moves with the budget controller extraction (Slice 6).
 * - `formatManagedEvidenceRuntime` — large, bundled with runtime-evidence helpers.
 * - `formatManagedReviewTargetLabel` — uses a task-engine-local `ManagedReviewTarget`
 *   alias; kept with its neighbor review-scale inference helpers.
 * - `formatManagedPromptOverlay` — depends on local `ManagedTaskWorkerSpec`
 *   interface; moves after a shared types module is established.
 */

import type {
  KodaXJsonValue,
  KodaXManagedTask,
  KodaXRoleRoundSummary,
  KodaXSkillInvocationContext,
  KodaXSkillMap,
  KodaXTaskCapabilityHint,
  KodaXTaskRoutingDecision,
  KodaXTaskToolPolicy,
  KodaXTaskVerificationContract,
} from '../../types.js';
import { buildRuntimeExecutionGuide } from './prompts/runtime-execution-guide.js';

/**
 * Build a two-line "title + bulleted items" section, trimming and filtering
 * empty entries. Returns `undefined` when no items survive trimming so that the
 * caller can cleanly drop the section from the enclosing template.
 */
export function formatOptionalListSection(title: string, items: string[] | undefined): string | undefined {
  const cleaned = items?.map((item) => item.trim()).filter(Boolean) ?? [];
  if (cleaned.length === 0) {
    return undefined;
  }
  return [title, ...cleaned.map((item) => `- ${item}`)].join('\n');
}

export function formatSkillInvocationSummary(
  skillInvocation: KodaXSkillInvocationContext,
  rawSkillPath?: string,
): string {
  return [
    'Active skill invocation:',
    `- Name: ${skillInvocation.name}`,
    `- Path: ${skillInvocation.path}`,
    skillInvocation.arguments ? `- Arguments: ${skillInvocation.arguments}` : undefined,
    skillInvocation.description ? `- Description: ${skillInvocation.description}` : undefined,
    skillInvocation.allowedTools ? `- Allowed tools: ${skillInvocation.allowedTools}` : undefined,
    skillInvocation.agent ? `- Preferred agent: ${skillInvocation.agent}` : undefined,
    skillInvocation.model ? `- Preferred model: ${skillInvocation.model}` : undefined,
    skillInvocation.context ? `- Invocation context: ${skillInvocation.context}` : undefined,
    skillInvocation.hookEvents?.length ? `- Hook events: ${skillInvocation.hookEvents.join(', ')}` : undefined,
    rawSkillPath ? `- Raw skill artifact: ${rawSkillPath}` : undefined,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function formatSkillMapSection(
  skillMap: KodaXSkillMap,
  skillMapArtifactPath?: string,
): string {
  return [
    'Skill map:',
    `- Summary: ${skillMap.skillSummary}`,
    `- Projection confidence: ${skillMap.projectionConfidence}`,
    skillMap.allowedTools ? `- Allowed tools: ${skillMap.allowedTools}` : undefined,
    skillMap.preferredAgent ? `- Preferred agent: ${skillMap.preferredAgent}` : undefined,
    skillMap.preferredModel ? `- Preferred model: ${skillMap.preferredModel}` : undefined,
    skillMap.invocationContext ? `- Invocation context: ${skillMap.invocationContext}` : undefined,
    skillMap.hookEvents?.length ? `- Hook events: ${skillMap.hookEvents.join(', ')}` : undefined,
    skillMap.rawSkillFallbackAllowed ? '- Raw skill fallback: allowed when the map is incomplete or claims conflict.' : undefined,
    skillMapArtifactPath ? `- Skill map artifact: ${skillMapArtifactPath}` : undefined,
    formatOptionalListSection('Execution obligations:', skillMap.executionObligations),
    formatOptionalListSection('Verification obligations:', skillMap.verificationObligations),
    formatOptionalListSection('Required evidence:', skillMap.requiredEvidence),
    formatOptionalListSection('Ambiguities:', skillMap.ambiguities),
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function formatFullSkillSection(skillInvocation: KodaXSkillInvocationContext): string {
  return [
    'Full expanded skill (authoritative execution reference):',
    '```markdown',
    skillInvocation.expandedContent.trim(),
    '```',
  ].join('\n');
}

export function formatRoleRoundSummarySection(summary: KodaXRoleRoundSummary): string {
  return [
    'Previous same-role summary:',
    `- Round: ${summary.round}`,
    `- Objective: ${summary.objective}`,
    `- Summary: ${summary.summary}`,
    formatOptionalListSection('Confirmed conclusions:', summary.confirmedConclusions),
    formatOptionalListSection('Unresolved questions:', summary.unresolvedQuestions),
    formatOptionalListSection('Next focus:', summary.nextFocus),
  ].filter((line): line is string => Boolean(line)).join('\n');
}

/**
 * Collapse a full harness identifier (e.g. `H2_PLAN_EXECUTE_EVAL`) to its
 * short label (`H2`). Returns the raw input for any unknown value.
 */
export function formatHarnessProfileShort(
  harnessProfile?: KodaXTaskRoutingDecision['harnessProfile'],
): string | undefined {
  switch (harnessProfile) {
    case 'H0_DIRECT':
      return 'H0';
    case 'H1_EXECUTE_EVAL':
      return 'H1';
    case 'H2_PLAN_EXECUTE_EVAL':
      return 'H2';
    default:
      return harnessProfile;
  }
}

export function formatCapabilityHint(hint: KodaXTaskCapabilityHint): string {
  return `${hint.kind}:${hint.name}${hint.details ? ` - ${hint.details}` : ''}`;
}

export function formatTaskContract(task: KodaXManagedTask['contract']): string | undefined {
  const lines = [
    'Task contract:',
    task.contractSummary ? `Summary: ${task.contractSummary}` : undefined,
    task.successCriteria.length > 0
      ? ['Success criteria:', ...task.successCriteria.map((item) => `- ${item}`)].join('\n')
      : undefined,
    task.requiredEvidence.length > 0
      ? ['Required evidence:', ...task.requiredEvidence.map((item) => `- ${item}`)].join('\n')
      : undefined,
    task.constraints.length > 0
      ? ['Constraints:', ...task.constraints.map((item) => `- ${item}`)].join('\n')
      : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 1 ? lines.join('\n') : undefined;
}

export function formatTaskMetadata(metadata: Record<string, KodaXJsonValue> | undefined): string | undefined {
  if (!metadata || Object.keys(metadata).length === 0) {
    return undefined;
  }

  return [
    'Task metadata:',
    JSON.stringify(metadata, null, 2),
  ].join('\n');
}

export function formatToolPolicy(policy: KodaXTaskToolPolicy | undefined): string | undefined {
  if (!policy) {
    return undefined;
  }

  const lines = [
    'Tool policy:',
    `Summary: ${policy.summary}`,
    policy.allowedTools?.length
      ? `Allowed tools: ${policy.allowedTools.join(', ')}`
      : undefined,
    policy.blockedTools?.length
      ? `Blocked tools: ${policy.blockedTools.join(', ')}`
      : undefined,
    policy.allowedShellPatterns?.length
      ? ['Allowed shell patterns:', ...policy.allowedShellPatterns.map((pattern) => `- ${pattern}`)].join('\n')
      : undefined,
    policy.allowedWritePathPatterns?.length
      ? ['Allowed write path patterns:', ...policy.allowedWritePathPatterns.map((pattern) => `- ${pattern}`)].join('\n')
      : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 1 ? lines.join('\n') : undefined;
}

export function formatVerificationContract(
  verification: KodaXTaskVerificationContract | undefined,
): string | undefined {
  if (!verification) {
    return undefined;
  }

  const lines = [
    'Verification contract:',
    verification.summary ? `Summary: ${verification.summary}` : undefined,
    verification.rubricFamily ? `Rubric family: ${verification.rubricFamily}` : undefined,
    verification.instructions?.length
      ? ['Instructions:', ...verification.instructions.map((item) => `- ${item}`)].join('\n')
      : undefined,
    verification.requiredEvidence?.length
      ? ['Required evidence:', ...verification.requiredEvidence.map((item) => `- ${item}`)].join('\n')
      : undefined,
    verification.requiredChecks?.length
      ? ['Required checks:', ...verification.requiredChecks.map((item) => `- ${item}`)].join('\n')
      : undefined,
    verification.capabilityHints?.length
      ? ['Capability hints:', ...verification.capabilityHints.map((item) => `- ${formatCapabilityHint(item)}`)].join('\n')
      : undefined,
    verification.criteria?.length
      ? [
        'Verification criteria:',
        ...verification.criteria.map((criterion) => `- ${criterion.id}: ${criterion.label} (threshold=${criterion.threshold}, weight=${criterion.weight})`),
      ].join('\n')
      : undefined,
    verification.runtime
      ? [
        'Runtime under test:',
        verification.runtime.cwd ? `- cwd: ${verification.runtime.cwd}` : undefined,
        verification.runtime.startupCommand ? `- startupCommand: ${verification.runtime.startupCommand}` : undefined,
        verification.runtime.readySignal ? `- readySignal: ${verification.runtime.readySignal}` : undefined,
        verification.runtime.baseUrl ? `- baseUrl: ${verification.runtime.baseUrl}` : undefined,
        verification.runtime.uiFlows?.length ? `- uiFlows: ${verification.runtime.uiFlows.join(' | ')}` : undefined,
        verification.runtime.apiChecks?.length ? `- apiChecks: ${verification.runtime.apiChecks.join(' | ')}` : undefined,
        verification.runtime.dbChecks?.length ? `- dbChecks: ${verification.runtime.dbChecks.join(' | ')}` : undefined,
        verification.runtime.fixtures?.length ? `- fixtures: ${verification.runtime.fixtures.join(' | ')}` : undefined,
      ].filter((line): line is string => Boolean(line)).join('\n')
      : undefined,
    buildRuntimeExecutionGuide(verification)
      ? `Runtime execution guide:\n${buildRuntimeExecutionGuide(verification)?.trimEnd()}`
      : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 1 ? lines.join('\n') : undefined;
}

export function formatManagedScoutDecision(
  runtime: KodaXManagedTask['runtime'],
): string | undefined {
  const scoutDecision = runtime?.scoutDecision;
  if (!scoutDecision) {
    return undefined;
  }

  const lines = [
    'Scout handoff:',
    `Summary: ${scoutDecision.summary}`,
    `Confirmed harness: ${scoutDecision.recommendedHarness}`,
    scoutDecision.evidenceAcquisitionMode
      ? `Evidence acquisition mode: ${scoutDecision.evidenceAcquisitionMode}`
      : undefined,
    formatOptionalListSection('Scope facts:', scoutDecision.scope),
    formatOptionalListSection('Required evidence:', scoutDecision.requiredEvidence),
    formatOptionalListSection('Priority files or areas:', scoutDecision.reviewFilesOrAreas),
  ].filter((line): line is string => Boolean(line));

  return lines.length > 1 ? lines.join('\n') : undefined;
}
