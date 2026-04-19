/**
 * FEATURE_079 — Task Engine Phase 1 Pure Extraction (Slice 8)
 *
 * Managed-worker tool policy builder and supporting constants extracted from
 * task-engine.ts. Zero-behavior-change move.
 *
 * Exports:
 * - Primitive tool/path/shell constants used by the per-role policy switch and
 *   by the in-task-engine tool hook (`createToolPolicyHook`):
 *     WRITE_ONLY_TOOLS, INSPECTION_SHELL_PATTERNS, DOCS_ONLY_WRITE_PATH_PATTERNS,
 *     PLANNER_ALLOWED_TOOLS, H1_EVALUATOR_ALLOWED_TOOLS,
 *     H1_READONLY_GENERATOR_ALLOWED_TOOLS, VERIFICATION_SHELL_PATTERNS,
 *     SHELL_WRITE_PATTERNS.
 * - `buildRuntimeVerificationShellPatterns` / `extractRuntimeCommandCandidate`
 *   — pure helpers that extend the inspection allow-list with runtime-specific
 *   startup/API/DB command patterns.
 * - `buildManagedWorkerToolPolicy` — the per-role switch producing the
 *   `KodaXTaskToolPolicy` for each managed worker.
 *
 * Kept local to task-engine.ts: `SHELL_PATTERN_CACHE`, `WRITE_PATH_PATTERN_CACHE`,
 * `matchesShellPattern`, `matchesWritePathPattern`, `createToolPolicyHook` —
 * these are runtime enforcement helpers that read the policy produced here.
 * They belong to the execution path, not the prompt/policy assembly path.
 */

import type {
  KodaXRepoIntelligenceMode,
  KodaXTaskRole,
  KodaXTaskRoutingDecision,
  KodaXTaskToolPolicy,
  KodaXTaskVerificationContract,
} from '../../../types.js';
import { MANAGED_PROTOCOL_TOOL_NAME } from '../../../managed-protocol.js';
import {
  filterRepoIntelligenceWorkingToolNames,
  MCP_TOOL_NAMES,
} from '../../../tools/index.js';
import { resolveKodaXAutoRepoMode } from '../../../repo-intelligence/runtime.js';
import { escapeRegexLiteral } from '../text-utils.js';
import type { ScoutMutationIntent } from './role-prompt-types.js';

export const WRITE_ONLY_TOOLS = new Set([
  'write',
  'edit',
  'multi_edit',
  'apply_patch',
  'delete',
  'remove',
  'rename',
  'move',
  'create',
  'create_file',
  'create_resource',
  'scene_create',
  'scene_node_add',
  'scene_node_delete',
  'scene_node_set',
  'scene_save',
  'script_create',
  'script_modify',
  'project_setting_set',
  'signal_connect',
]);

export const INSPECTION_SHELL_PATTERNS = [
  '^(?:git\\s+(?:status|diff|show|log|branch|rev-parse|ls-files))\\b',
  '^(?:Get-ChildItem|Get-Content|Select-String|type|dir|ls|cat)\\b',
  '^(?:findstr|where|pwd|cd)\\b',
  '^(?:node|npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:lint|typecheck|check|list|why)\\b',
];

export const DOCS_ONLY_WRITE_PATH_PATTERNS = [
  '\\.(?:md|mdx|txt|rst|adoc)$',
  '(?:^|/)(?:docs?|documentation|design|requirements?|specs?|plans?|notes?|reports?)(?:/|$)',
  '(?:^|/)(?:README|CHANGELOG|FEATURE_LIST|KNOWN_ISSUES|PRD|ADR|HLD|DD)(?:\\.[^/]+)?$',
] as const;

export const PLANNER_ALLOWED_TOOLS = [
  'changed_scope',
  'repo_overview',
  'changed_diff_bundle',
  'glob',
  'grep',
  'read',
  ...MCP_TOOL_NAMES,
] as const;

export const H1_EVALUATOR_ALLOWED_TOOLS = [
  'changed_scope',
  'repo_overview',
  'changed_diff_bundle',
  'changed_diff',
  'glob',
  'grep',
  'read',
  ...MCP_TOOL_NAMES,
] as const;

export const H1_READONLY_GENERATOR_ALLOWED_TOOLS = [
  'changed_scope',
  'repo_overview',
  'changed_diff_bundle',
  'changed_diff',
  'glob',
  'grep',
  'read',
  'dispatch_child_task',
  ...MCP_TOOL_NAMES,
] as const;

export const VERIFICATION_SHELL_PATTERNS = [
  ...INSPECTION_SHELL_PATTERNS,
  '^(?:agent-browser)\\b',
  '^(?:npx\\s+)?playwright\\b',
  '^(?:npx\\s+)?vitest\\b',
  '^(?:npx\\s+)?jest\\b',
  '^(?:npx\\s+)?cypress\\b',
  '^(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:test|test:[^\\s]+|e2e|e2e:[^\\s]+|verify|verify:[^\\s]+|build|build:[^\\s]+|lint|lint:[^\\s]+|typecheck|typecheck:[^\\s]+)\\b',
  '^(?:pytest|go\\s+test|cargo\\s+test|dotnet\\s+test|mvn\\s+test|gradle\\s+test)\\b',
];

export const SHELL_WRITE_PATTERNS = [
  '\\b(?:Set-Content|Add-Content|Out-File|Tee-Object|Copy-Item|Move-Item|Rename-Item|Remove-Item|New-Item|Clear-Content)\\b',
  '\\b(?:rm|mv|cp|del|erase|touch|mkdir|rmdir|rename|ren)\\b',
  '\\b(?:sed\\s+-i|perl\\s+-pi|python\\s+-c|node\\s+-e)\\b',
  '(?:^|\\s)(?:>|>>)(?!(?:\\s*&1|\\s*2>&1))',
];

/**
 * Extract a plausible shell command out of a free-form verification hint.
 * Accepts a few common "label: <command>" prefixes and returns the command
 * suffix only when it starts with a recognized runtime driver (test runners,
 * package managers, curl, etc.). Returns undefined otherwise so that callers
 * don't add arbitrary user prose to the shell allow-list.
 */
export function extractRuntimeCommandCandidate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const suffixMatch = trimmed.match(/^[^:]+:\s*(.+)$/);
  const candidate = suffixMatch?.[1]?.trim() || trimmed;
  return /^(?:npm|pnpm|yarn|bun|npx|node|python|pytest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|curl|Invoke-WebRequest|Invoke-RestMethod|agent-browser|sqlite3|psql|mysql)\b/i.test(candidate)
    ? candidate
    : undefined;
}

/**
 * Build a regex allow-list extending the verification-run shell patterns with
 * the exact startup / API / DB commands declared on the task's verification
 * contract, plus a generic curl/Invoke-* pattern when the contract implies a
 * live HTTP target. Called once per role policy branch that accepts runtime
 * verification commands (H1 Generator/Evaluator and H2 Evaluator).
 */
export function buildRuntimeVerificationShellPatterns(
  verification: KodaXTaskVerificationContract | undefined,
): string[] {
  const runtime = verification?.runtime;
  if (!runtime) {
    return [];
  }

  const exactCommands = [
    runtime.startupCommand,
    ...(runtime.apiChecks ?? []),
    ...(runtime.dbChecks ?? []),
  ]
    .map(extractRuntimeCommandCandidate)
    .filter((value): value is string => Boolean(value));
  const patterns = exactCommands.map((command) => `^${escapeRegexLiteral(command)}(?:\\s+.*)?$`);

  if (runtime.baseUrl || (runtime.apiChecks?.length ?? 0) > 0) {
    patterns.push('^(?:curl|Invoke-WebRequest|Invoke-RestMethod)\\b');
  }

  return Array.from(new Set(patterns));
}

/**
 * Produce the per-role `KodaXTaskToolPolicy` for a managed worker, or
 * `undefined` when the role should run with the default unrestricted policy
 * (currently: Scout, and the open-scope H1/H2 Generator).
 *
 * Behavior details:
 * - In repo-intelligence "off" mode, any role-specific allow-list is filtered
 *   to drop repo-intel working tools and a note is appended to the summary.
 * - `MANAGED_PROTOCOL_TOOL_NAME` is always added back to any non-empty
 *   allow-list so that the control-plane escape hatch can never be blocked.
 * - H1 Generator branches off Scout's scope intent (review-only / docs-scoped)
 *   to add write-path or blocked-tool constraints; H2 Generator stays open and
 *   relies on the Evaluator tail-gate.
 */
export function buildManagedWorkerToolPolicy(
  role: KodaXTaskRole,
  verification: KodaXTaskVerificationContract | undefined,
  harnessProfile?: KodaXTaskRoutingDecision['harnessProfile'],
  scoutMutationIntent?: ScoutMutationIntent,
  repoIntelligenceMode?: KodaXRepoIntelligenceMode,
): KodaXTaskToolPolicy | undefined {
  const strictRepoIntelligenceOff = resolveKodaXAutoRepoMode(repoIntelligenceMode) === 'off';
  const finalizeToolPolicy = (
    policy: KodaXTaskToolPolicy | undefined,
  ): KodaXTaskToolPolicy | undefined => {
    if (!policy) {
      return policy;
    }

    const allowedTools = policy.allowedTools?.length
      ? Array.from(new Set([
          ...(strictRepoIntelligenceOff
            ? filterRepoIntelligenceWorkingToolNames(policy.allowedTools)
            : policy.allowedTools),
          MANAGED_PROTOCOL_TOOL_NAME,
        ]))
      : policy.allowedTools;

    return {
      ...policy,
      allowedTools,
      summary: strictRepoIntelligenceOff && policy.allowedTools
        ? [
            policy.summary,
            'Repo-intelligence working tools are disabled in off mode; rely on general-purpose read/glob/grep evidence instead.',
          ].join(' ')
        : policy.summary,
    };
  };

  switch (role) {
    case 'scout':
      // Scout has full tool access. The three-level quality framework (eval-verified 100%
      // accuracy on strong models) guides harness decisions via prompt, not tool restrictions.
      // Scout investigates, declares confirmed_harness, and for H0 tasks completes directly.
      // For H1/H2 tasks, Scout escalates to the multi-agent pipeline.
      return undefined;
    case 'planner':
      return finalizeToolPolicy({
        summary: 'Planner may inspect scope facts and overview evidence to produce a sprint contract, but must not linearly page raw diffs, perform deep claim verification, mutate files, or execute implementation steps.',
        blockedTools: [...WRITE_ONLY_TOOLS],
        allowedTools: [...PLANNER_ALLOWED_TOOLS],
        allowedShellPatterns: INSPECTION_SHELL_PATTERNS,
      });
    case 'generator':
      // Issue 119: Constraints are keyed to Scout's own scope analysis, not the
      // pre-Scout regex heuristic. If Scout leaves scope 'open', trust Scout's
      // scope + Evaluator tail-gate rather than hard-restricting writes here.
      if (harnessProfile === 'H1_EXECUTE_EVAL' && scoutMutationIntent === 'review-only') {
        return finalizeToolPolicy({
          summary: 'H1 review-only Generator should stay non-mutating per Scout\'s scope. It may inspect scoped evidence and run only limited inspection or explicitly required verification commands; mutate files only if the handoff explicitly requires fixes.',
          blockedTools: [...WRITE_ONLY_TOOLS],
          allowedTools: [...H1_READONLY_GENERATOR_ALLOWED_TOOLS],
          allowedShellPatterns: Array.from(new Set([
            ...INSPECTION_SHELL_PATTERNS,
            ...buildRuntimeVerificationShellPatterns(verification),
          ])),
        });
      }
      if (harnessProfile === 'H1_EXECUTE_EVAL' && scoutMutationIntent === 'docs-scoped') {
        return finalizeToolPolicy({
          summary: 'H1 docs-scoped Generator: Scout\'s scope points entirely at documentation paths. Keep edits within those paths; do not expand into source, configuration, build outputs, or system state unless new evidence demands it.',
          allowedWritePathPatterns: [...DOCS_ONLY_WRITE_PATH_PATTERNS],
          allowedShellPatterns: Array.from(new Set([
            ...INSPECTION_SHELL_PATTERNS,
            ...buildRuntimeVerificationShellPatterns(verification),
          ])),
        });
      }
      return undefined;
    case 'evaluator':
      if (harnessProfile === 'H1_EXECUTE_EVAL') {
        return finalizeToolPolicy({
          summary: 'H1 Evaluator is a lightweight checker. It may only do targeted spot-checks against the Generator handoff and must not broad-scan the repo, deep-page large diffs, or run broad test sweeps unless the verification contract explicitly requires them.',
          blockedTools: [...WRITE_ONLY_TOOLS],
          allowedTools: [...H1_EVALUATOR_ALLOWED_TOOLS],
          allowedShellPatterns: Array.from(new Set([
            ...INSPECTION_SHELL_PATTERNS,
            ...buildRuntimeVerificationShellPatterns(verification),
          ])),
        });
      }
      return finalizeToolPolicy({
        summary: 'Verification agents may inspect the repo and run verification commands, including browser, startup, API, and runtime checks declared by the verification contract, but must not edit project files or mutate control-plane artifacts.',
        blockedTools: [...WRITE_ONLY_TOOLS],
        allowedShellPatterns: [
          ...VERIFICATION_SHELL_PATTERNS,
          ...buildRuntimeVerificationShellPatterns(verification),
        ],
      });
    default:
      return undefined;
  }
}
