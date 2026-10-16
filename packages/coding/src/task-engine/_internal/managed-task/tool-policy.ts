/**
 * Shared tool-policy guards and shell patterns used by execution boundaries
 * and Todo drift detection. Worker guidance lives in `worker-role-prompt.ts`;
 * the retired V1 role-policy assembler is no longer needed.
 */

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
  // Recognize scene/script mutations from MCP or extensions when enforcing
  // an explicitly supplied write boundary, even outside the core tool bundle.
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

export const SHELL_WRITE_PATTERNS: readonly string[] = [
  '\\b(?:Set-Content|Add-Content|Out-File|Tee-Object|Copy-Item|Move-Item|Rename-Item|Remove-Item|New-Item|Clear-Content)\\b',
  '\\b(?:rm|mv|cp|del|erase|touch|mkdir|rmdir|rename|ren)\\b',
  '\\b(?:sed\\s+-i|perl\\s+-pi|python\\s+-c|node\\s+-e)\\b',
  '(?:^|\\s)(?:>|>>)(?!(?:\\s*&1|\\s*2>&1))',
];

/**
 * Inspection command patterns used by Todo drift detection through
 * `VERIFICATION_SHELL_PATTERNS` below; these do not grant tool permission.
 */
export const INSPECTION_SHELL_PATTERNS: readonly string[] = [
  '^(?:git\\s+(?:status|diff|show|log|branch|rev-parse|ls-files))\\b',
  '^(?:Get-ChildItem|Get-Content|Select-String|type|dir|ls|cat)\\b',
  '^(?:findstr|where|pwd|cd)\\b',
  '^(?:node|npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:lint|typecheck|check|list|why)\\b',
];

/**
 * Recognized verification commands for Todo drift detection: inspection,
 * test runners, builds, lint, and E2E drivers.
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
