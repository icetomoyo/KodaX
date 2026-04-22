/**
 * Managed-task tool policy — path- and shell-pattern guards.
 *
 * Ported 1:1 from the legacy `task-engine.ts` helpers + the deleted
 * `_internal/prompts/tool-policy.ts` + `role-prompt-types.ts` modules
 * (removed in FEATURE_084 Shard 6d-b).
 *
 * Shard 6d-j + 6d-M scope — restore the **runtime** half of the legacy
 * tool policy:
 *   - `DOCS_ONLY_WRITE_PATH_PATTERNS` / `SHELL_WRITE_PATTERNS` constants.
 *   - `matchesWritePathPattern` / `matchesShellPattern` / `collectToolInputPaths`
 *     regex + recursive-object traversal primitives.
 *   - `enforceWritePathBoundary` — `'write' | 'edit' | 'multi_edit' | ...`
 *     guard that reads `input.file_path` (+ nested keys) and blocks writes
 *     outside the caller-supplied path allow-list.
 *   - `enforceShellWriteBoundary` — `'bash'` guard that blocks destructive
 *     shell commands when the caller role is verification-only or its
 *     mutation-intent is docs-scoped.
 *   - `ScoutMutationIntent` / `inferScoutMutationIntent` — pure function
 *     that classifies Scout's intent from its emitted `scope` +
 *     `reviewFilesOrAreas` + the routing `primaryTask`. Callers do NOT
 *     read LLM-self-declared intent; Scout's scope list IS the evidence.
 *
 * The prompt-assembly half of the legacy `buildManagedWorkerToolPolicy` is
 * **intentionally not ported** — the Runner-driven path does not assemble
 * per-role prompts with an injected policy summary; each `Agent` already
 * carries its own instructions + tool allow-list. This module supplies
 * only the runtime enforcement callers need.
 *
 * Callers:
 *   - `runner-driven.ts` → `wrapGeneratorWriteWithMutationGuard`,
 *     `wrapGeneratorBashWithMutationGuard` (Generator worker path).
 */

import { isDocsLikePath } from '../text-utils.js';
import type { KodaXTaskRoutingDecision } from '../../../types.js';

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
