/**
 * Managed-task tool policy — path- and shell-pattern guards + per-role
 * policy assembler.
 *
 * Ported 1:1 from the legacy `task-engine.ts` helpers + the deleted
 * `_internal/prompts/tool-policy.ts` + `role-prompt-types.ts` modules
 * (removed in FEATURE_084 Shard 6d-b), then restored in v0.7.26 to close
 * the prompt-surface parity gap — without `buildManagedWorkerToolPolicy`
 * the "## Tool Policy" section vanished from every managed worker's
 * system prompt.
 *
 * Runtime guards (always ported):
 *   - `DOCS_ONLY_WRITE_PATH_PATTERNS` / `SHELL_WRITE_PATTERNS` constants.
 *   - `matchesWritePathPattern` / `matchesShellPattern` / `collectToolInputPaths`.
 *   - `enforceWritePathBoundary` / `enforceShellWriteBoundary`.
 *   - `ScoutMutationIntent` / `inferScoutMutationIntent`.
 *
 * Policy assembly (restored for P1 parity):
 *   - `INSPECTION_SHELL_PATTERNS` / `VERIFICATION_SHELL_PATTERNS`.
 *   - `PLANNER_ALLOWED_TOOLS` / `H1_EVALUATOR_ALLOWED_TOOLS` /
 *     `H1_READONLY_GENERATOR_ALLOWED_TOOLS`.
 *   - `extractRuntimeCommandCandidate` / `buildRuntimeVerificationShellPatterns`.
 *   - `buildManagedWorkerToolPolicy` — the per-role switch that produces
 *     the `KodaXTaskToolPolicy` consumed by `formatToolPolicy` when
 *     rendering each worker's system prompt.
 */

import { isDocsLikePath, escapeRegexLiteral } from '../text-utils.js';
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

/**
 * Scope hints the Scout emits on `emit_scout_verdict` — `scope` + the
 * reviewer's short-list `reviewFilesOrAreas`. The intent classifier below
 * infers the mutation surface from these paths + the routing primaryTask.
 */
export interface ScoutScopeHint {
  scope?: readonly string[];
  reviewFilesOrAreas?: readonly string[];
}

/**
 * Mutation-intent taxonomy used by Generator/Evaluator guards. Matches
 * legacy `_internal/prompts/role-prompt-types.ts::ScoutMutationIntent`
 * (deleted in Shard 6d-b).
 *
 * - `'review-only'`: pure review / audit task. Generator writes blocked.
 * - `'docs-scoped'`: every path Scout flagged is docs-like. Generator
 *   writes restricted to `DOCS_ONLY_WRITE_PATH_PATTERNS` + destructive
 *   shell commands blocked.
 * - `'open'`: default. No mutation boundary applied.
 */
export type ScoutMutationIntent = 'review-only' | 'docs-scoped' | 'open';

/**
 * Issue 119 (legacy) — pure function that infers Scout's mutation intent
 * from its structured outputs. Restored here verbatim from the deleted
 * `_internal/prompts/role-prompt-types.ts::inferScoutMutationIntent`.
 *
 * Scout does NOT self-declare this intent. Its authority is its scope
 * list: if every path is docs-like, the run is docs-scoped; if the
 * routing primaryTask is `'review'` and Scout emitted no scope, the run
 * is review-only; otherwise open.
 */
export function inferScoutMutationIntent(
  scoutScope: ScoutScopeHint | undefined,
  primaryTask: KodaXTaskRoutingDecision['primaryTask'] | undefined,
): ScoutMutationIntent {
  const scope = (scoutScope?.scope ?? []).filter((s) => s.trim().length > 0);
  const reviewFiles = (scoutScope?.reviewFilesOrAreas ?? []).filter((s) => s.trim().length > 0);
  const allPaths = [...scope, ...reviewFiles];

  if (primaryTask === 'review' && scope.length === 0) {
    return 'review-only';
  }

  if (allPaths.length > 0 && allPaths.every(isDocsLikePath)) {
    return 'docs-scoped';
  }

  return 'open';
}

export const WRITE_ONLY_TOOLS: ReadonlySet<string> = new Set([
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
]);

export const DOCS_ONLY_WRITE_PATH_PATTERNS: readonly string[] = [
  '\\.(?:md|mdx|txt|rst|adoc)$',
  '(?:^|/)(?:docs?|documentation|design|requirements?|specs?|plans?|notes?|reports?)(?:/|$)',
  '(?:^|/)(?:README|CHANGELOG|FEATURE_LIST|KNOWN_ISSUES|PRD|ADR|HLD|DD)(?:\\.[^/]+)?$',
];

export const SHELL_WRITE_PATTERNS: readonly string[] = [
  '\\b(?:Set-Content|Add-Content|Out-File|Tee-Object|Copy-Item|Move-Item|Rename-Item|Remove-Item|New-Item|Clear-Content)\\b',
  '\\b(?:rm|mv|cp|del|erase|touch|mkdir|rmdir|rename|ren)\\b',
  '\\b(?:sed\\s+-i|perl\\s+-pi|python\\s+-c|node\\s+-e)\\b',
  '(?:^|\\s)(?:>|>>)(?!(?:\\s*&1|\\s*2>&1))',
];

/**
 * Read-only inspection shell allow-list. Shared by Scout / Planner /
 * Evaluator so they can run status/diff/log/list commands but nothing
 * mutating. 1:1 port from legacy `_internal/prompts/tool-policy.ts`.
 */
export const INSPECTION_SHELL_PATTERNS: readonly string[] = [
  '^(?:git\\s+(?:status|diff|show|log|branch|rev-parse|ls-files))\\b',
  '^(?:Get-ChildItem|Get-Content|Select-String|type|dir|ls|cat)\\b',
  '^(?:findstr|where|pwd|cd)\\b',
  '^(?:node|npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:lint|typecheck|check|list|why)\\b',
];

/**
 * Evaluator / verification-capable role allow-list — inspection +
 * test-runner / build / lint / e2e drivers. 1:1 port from legacy.
 */
export const VERIFICATION_SHELL_PATTERNS: readonly string[] = [
  ...INSPECTION_SHELL_PATTERNS,
  '^(?:agent-browser)\\b',
  '^(?:npx\\s+)?playwright\\b',
  '^(?:npx\\s+)?vitest\\b',
  '^(?:npx\\s+)?jest\\b',
  '^(?:npx\\s+)?cypress\\b',
  '^(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:test|test:[^\\s]+|e2e|e2e:[^\\s]+|verify|verify:[^\\s]+|build|build:[^\\s]+|lint|lint:[^\\s]+|typecheck|typecheck:[^\\s]+)\\b',
  '^(?:pytest|go\\s+test|cargo\\s+test|dotnet\\s+test|mvn\\s+test|gradle\\s+test)\\b',
];

/** Planner tool allow-list — read/overview/scope + MCP. 1:1 port. */
export const PLANNER_ALLOWED_TOOLS: readonly string[] = [
  'changed_scope',
  'repo_overview',
  'changed_diff_bundle',
  'glob',
  'grep',
  'read',
  ...MCP_TOOL_NAMES,
];

/** H1 Evaluator tool allow-list — inspection + diff + MCP. 1:1 port. */
export const H1_EVALUATOR_ALLOWED_TOOLS: readonly string[] = [
  'changed_scope',
  'repo_overview',
  'changed_diff_bundle',
  'changed_diff',
  'glob',
  'grep',
  'read',
  ...MCP_TOOL_NAMES,
];

/** H1 read-only Generator tool allow-list — inspection + dispatch + MCP. 1:1 port. */
export const H1_READONLY_GENERATOR_ALLOWED_TOOLS: readonly string[] = [
  'changed_scope',
  'repo_overview',
  'changed_diff_bundle',
  'changed_diff',
  'glob',
  'grep',
  'read',
  'dispatch_child_task',
  ...MCP_TOOL_NAMES,
];

/**
 * Extract a plausible shell command candidate from a free-form
 * verification hint (e.g. `"startup: npm run dev"`). Returns the
 * suffix only when it begins with a recognized runtime driver —
 * prevents arbitrary user prose from polluting the shell allow-list.
 * 1:1 port from legacy.
 */
export function extractRuntimeCommandCandidate(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const suffixMatch = trimmed.match(/^[^:]+:\s*(.+)$/);
  const candidate = suffixMatch?.[1]?.trim() || trimmed;
  return /^(?:npm|pnpm|yarn|bun|npx|node|python|pytest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|curl|Invoke-WebRequest|Invoke-RestMethod|agent-browser|sqlite3|psql|mysql)\b/i.test(candidate)
    ? candidate
    : undefined;
}

/**
 * Extend the verification shell allow-list with the exact startup /
 * API / DB commands declared by the task's verification contract,
 * plus a generic curl/Invoke-* pattern when a live HTTP target is
 * implied. 1:1 port from legacy.
 */
export function buildRuntimeVerificationShellPatterns(
  verification: KodaXTaskVerificationContract | undefined,
): string[] {
  const runtime = verification?.runtime;
  if (!runtime) return [];
  const exactCommands = [
    runtime.startupCommand,
    ...(runtime.apiChecks ?? []),
    ...(runtime.dbChecks ?? []),
  ]
    .map(extractRuntimeCommandCandidate)
    .filter((value): value is string => Boolean(value));
  const patterns = exactCommands.map(
    (command) => `^${escapeRegexLiteral(command)}(?:\\s+.*)?$`,
  );
  if (runtime.baseUrl || (runtime.apiChecks?.length ?? 0) > 0) {
    patterns.push('^(?:curl|Invoke-WebRequest|Invoke-RestMethod)\\b');
  }
  return Array.from(new Set(patterns));
}

/**
 * Produce the per-role `KodaXTaskToolPolicy` for a managed worker,
 * or `undefined` when the role should run with the default unrestricted
 * policy (currently Scout, and the open-scope H1/H2 Generator).
 *
 * 1:1 port from legacy `_internal/prompts/tool-policy.ts::buildManagedWorkerToolPolicy`.
 *
 * Behavior:
 *   - In `repo-intelligence: 'off'`, any allow-list is filtered to drop
 *     repo-intel working tools and the policy summary gets an explanatory
 *     sentence appended.
 *   - `MANAGED_PROTOCOL_TOOL_NAME` is always added back to any non-empty
 *     allow-list so the control-plane escape hatch can never be blocked.
 *   - H1 Generator branches off Scout's scope intent (review-only /
 *     docs-scoped) to add write-path or blocked-tool constraints; H2
 *     Generator stays open and relies on the Evaluator tail-gate.
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
    if (!policy) return policy;
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
      summary:
        strictRepoIntelligenceOff && policy.allowedTools
          ? [
              policy.summary,
              'Repo-intelligence working tools are disabled in off mode; rely on general-purpose read/glob/grep evidence instead.',
            ].join(' ')
          : policy.summary,
    };
  };

  switch (role) {
    case 'scout':
      return undefined;
    case 'planner':
      return finalizeToolPolicy({
        summary: 'Planner may inspect scope facts and overview evidence to produce a sprint contract, but must not linearly page raw diffs, perform deep claim verification, mutate files, or execute implementation steps.',
        blockedTools: [...WRITE_ONLY_TOOLS],
        allowedTools: [...PLANNER_ALLOWED_TOOLS],
        allowedShellPatterns: [...INSPECTION_SHELL_PATTERNS],
      });
    case 'generator':
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

const WRITE_PATH_PATTERN_CACHE = new Map<string, RegExp>();
const SHELL_PATTERN_CACHE = new Map<string, RegExp>();

function getWritePathRegex(pattern: string): RegExp {
  let cached = WRITE_PATH_PATTERN_CACHE.get(pattern);
  if (!cached) {
    cached = new RegExp(pattern, 'i');
    WRITE_PATH_PATTERN_CACHE.set(pattern, cached);
  }
  return cached;
}

function getShellRegex(pattern: string): RegExp {
  let cached = SHELL_PATTERN_CACHE.get(pattern);
  if (!cached) {
    cached = new RegExp(pattern);
    SHELL_PATTERN_CACHE.set(pattern, cached);
  }
  return cached;
}

export function matchesWritePathPattern(
  targetPath: string,
  allowedPatterns: readonly string[] | undefined,
): boolean {
  if (!allowedPatterns || allowedPatterns.length === 0) {
    return true;
  }
  const normalized = targetPath.replace(/\\/g, '/');
  return allowedPatterns.some((pattern) => getWritePathRegex(pattern).test(normalized));
}

export function matchesShellPattern(
  command: string,
  patterns: readonly string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  return patterns.some((pattern) => getShellRegex(pattern).test(command));
}

const TOOL_INPUT_PATH_KEYS: ReadonlySet<string> = new Set([
  'file_path',
  'path',
  'target_path',
  'destination',
  'dest',
  'output_path',
  'output',
  'dir',
  'directory',
  'filename',
  'file',
  'paths',
  'files',
]);

export function collectToolInputPaths(
  value: unknown,
  currentKey?: string,
  seen: WeakSet<object> = new WeakSet(),
): string[] {
  if (typeof value === 'string') {
    return currentKey && TOOL_INPUT_PATH_KEYS.has(currentKey) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectToolInputPaths(item, currentKey, seen));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) {
    return [];
  }
  seen.add(obj);

  const paths: string[] = [];
  for (const [childKey, childValue] of Object.entries(obj)) {
    paths.push(...collectToolInputPaths(childValue, childKey, seen));
  }
  return paths;
}

/**
 * Guard a write/edit tool call against an allowed-path pattern list.
 * Returns a human-readable error message when the call should be blocked,
 * or `undefined` when it's allowed.
 *
 * Matches legacy `createToolPolicyHook` behaviour (task-engine.ts:~1891):
 * if the input contains no recognisable path keys we *reject* the call —
 * the caller cannot verify the target against the boundary.
 */
export function enforceWritePathBoundary(
  toolName: string,
  input: unknown,
  allowedWritePathPatterns: readonly string[] | undefined,
  roleTitle = 'Generator',
): string | undefined {
  const normalizedTool = toolName.toLowerCase();
  if (!WRITE_ONLY_TOOLS.has(normalizedTool)) {
    return undefined;
  }
  if (!allowedWritePathPatterns || allowedWritePathPatterns.length === 0) {
    return undefined;
  }
  const targetPaths = Array.from(new Set(collectToolInputPaths(input)));
  if (targetPaths.length === 0) {
    return `[Managed Task ${roleTitle}] Tool "${toolName}" is blocked because the target path could not be verified against the docs-only boundary.`;
  }
  const disallowedPath = targetPaths.find(
    (targetPath) => !matchesWritePathPattern(targetPath, allowedWritePathPatterns),
  );
  if (disallowedPath) {
    return `[Managed Task ${roleTitle}] Tool "${toolName}" is blocked because "${disallowedPath}" is outside the allowed docs-only write boundary.`;
  }
  return undefined;
}

/**
 * Guard a bash tool call against the shell-write pattern list.
 * Returns a human-readable error message when the command is destructive
 * and the role is restricted; `undefined` when it's allowed.
 */
export function enforceShellWriteBoundary(
  command: string,
  roleTitle = 'Generator',
): string | undefined {
  if (matchesShellPattern(command.trim(), SHELL_WRITE_PATTERNS)) {
    return `[Managed Task ${roleTitle}] Shell command blocked because this role is restricted to docs-only mutations and the command would modify the filesystem outside the docs boundary.`;
  }
  return undefined;
}
