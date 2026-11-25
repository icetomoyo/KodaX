import { createHash } from 'node:crypto';
import path from 'node:path';

export type RuntimePermissionHostPlatform = 'win32' | 'posix';

interface RuntimePermissionMatcherBase {
  readonly version: 1;
  readonly toolName: string;
  readonly fingerprint: string;
}

export interface RuntimeExactCommandPermissionMatcher
  extends RuntimePermissionMatcherBase {
  readonly kind: 'exact-command';
  readonly shell: 'cmd' | 'posix' | 'powershell';
  /** Hash of the host-owned interpreter/environment contract, when configured. */
  readonly shellContractFingerprint?: string;
  /** SHA-256 of the normalized concrete command; raw command text is never persisted. */
  readonly commandFingerprint: string;
  readonly cwd: string;
  readonly executable?: string;
  readonly argvFingerprint?: string;
  readonly background: boolean;
}

export interface RuntimeExactPathPermissionMatcher
  extends RuntimePermissionMatcherBase {
  readonly kind: 'exact-path';
  readonly path: string;
}

export interface RuntimeExactCallPermissionMatcher
  extends RuntimePermissionMatcherBase {
  readonly kind: 'exact-call';
  readonly cwd: string;
  readonly inputFingerprint: string;
}

export type RuntimePermissionMatcher =
  | RuntimeExactCommandPermissionMatcher
  | RuntimeExactPathPermissionMatcher
  | RuntimeExactCallPermissionMatcher;

export interface RuntimePermissionMatcherInput {
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly executionCwd: string;
  readonly platform?: RuntimePermissionHostPlatform;
  readonly shell?: RuntimeExactCommandPermissionMatcher['shell'];
  readonly shellContractFingerprint?: string;
}

const FILE_PATH_KEYS = ['path', 'file_path'] as const;
const PATH_SCOPED_TOOL_NAMES = new Set([
  'read',
  'write',
  'edit',
  'multi_edit',
  'insert_after_anchor',
]);

export function createRuntimePermissionMatcher(
  input: RuntimePermissionMatcherInput,
): RuntimePermissionMatcher {
  const platform = input.platform ?? runtimePermissionHostPlatform();
  if (input.toolName === 'bash') {
    return createExactCommandMatcher(input, platform);
  }
  const targetPath = PATH_SCOPED_TOOL_NAMES.has(input.toolName)
    ? FILE_PATH_KEYS
        .map((key) => input.toolInput[key])
        .find((value): value is string => typeof value === 'string' && value.length > 0)
    : undefined;
  if (targetPath !== undefined) {
    return createExactPathMatcher(input.toolName, targetPath, input.executionCwd, platform);
  }
  const cwd = normalizePermissionPath(input.executionCwd, input.executionCwd, platform);
  // An mcp_call grant names one MCP tool; its arguments change on every call.
  const scopedInput = input.toolName === 'mcp_call'
    ? { id: input.toolInput.id }
    : input.toolInput;
  const inputFingerprint = stableFingerprint(normalizeGenericInput(scopedInput));
  return {
    version: 1,
    kind: 'exact-call',
    toolName: input.toolName,
    cwd,
    inputFingerprint,
    fingerprint: stableFingerprint({
      version: 1,
      kind: 'exact-call',
      toolName: input.toolName,
      cwd,
      inputFingerprint,
    }),
  };
}

export function runtimePermissionMatcherMatches(
  matcher: RuntimePermissionMatcher,
  input: RuntimePermissionMatcherInput,
): boolean {
  if (matcher.toolName !== input.toolName) return false;
  const candidate = createRuntimePermissionMatcher(input);
  return matcher.kind === candidate.kind && matcher.fingerprint === candidate.fingerprint;
}

export function parseRuntimePermissionMatcher(value: unknown): RuntimePermissionMatcher {
  if (!isRecord(value) || value.version !== 1 || typeof value.toolName !== 'string'
    || typeof value.fingerprint !== 'string') {
    throw new Error('invalid Runtime permission matcher');
  }
  if (value.kind === 'exact-command') {
    if ((value.shell !== 'cmd' && value.shell !== 'posix' && value.shell !== 'powershell')
      || !isSha256(value.commandFingerprint) || typeof value.cwd !== 'string'
      || typeof value.background !== 'boolean'
      || (value.shellContractFingerprint !== undefined
        && !isSha256(value.shellContractFingerprint))
      || (value.executable !== undefined && typeof value.executable !== 'string')
      || (value.argvFingerprint !== undefined && !isSha256(value.argvFingerprint))) {
      throw new Error('invalid Runtime command permission matcher');
    }
    const matcher: RuntimeExactCommandPermissionMatcher = {
      version: 1,
      kind: 'exact-command',
      toolName: value.toolName,
      fingerprint: value.fingerprint,
      shell: value.shell,
      ...(value.shellContractFingerprint !== undefined
        ? { shellContractFingerprint: value.shellContractFingerprint }
        : {}),
      commandFingerprint: value.commandFingerprint,
      cwd: value.cwd,
      background: value.background,
      ...(value.executable !== undefined ? { executable: value.executable } : {}),
      ...(value.argvFingerprint !== undefined
        ? { argvFingerprint: value.argvFingerprint }
        : {}),
    };
    assertMatcherFingerprint(matcher, {
      version: 1,
      kind: 'exact-command',
      toolName: matcher.toolName,
      shell: matcher.shell,
      ...(matcher.shellContractFingerprint !== undefined
        ? { shellContractFingerprint: matcher.shellContractFingerprint }
        : {}),
      commandFingerprint: matcher.commandFingerprint,
      cwd: matcher.cwd,
      ...(matcher.executable !== undefined ? { executable: matcher.executable } : {}),
      ...(matcher.argvFingerprint !== undefined
        ? { argvFingerprint: matcher.argvFingerprint }
        : {}),
      background: matcher.background,
    });
    return matcher;
  }
  if (value.kind === 'exact-path' && typeof value.path === 'string') {
    const matcher: RuntimeExactPathPermissionMatcher = {
      version: 1,
      kind: 'exact-path',
      toolName: value.toolName,
      fingerprint: value.fingerprint,
      path: value.path,
    };
    assertMatcherFingerprint(matcher, {
      version: 1,
      kind: 'exact-path',
      toolName: matcher.toolName,
      path: matcher.path,
    });
    return matcher;
  }
  if (value.kind === 'exact-call' && typeof value.cwd === 'string'
    && isSha256(value.inputFingerprint)) {
    const matcher: RuntimeExactCallPermissionMatcher = {
      version: 1,
      kind: 'exact-call',
      toolName: value.toolName,
      fingerprint: value.fingerprint,
      cwd: value.cwd,
      inputFingerprint: value.inputFingerprint,
    };
    assertMatcherFingerprint(matcher, {
      version: 1,
      kind: 'exact-call',
      toolName: matcher.toolName,
      cwd: matcher.cwd,
      inputFingerprint: matcher.inputFingerprint,
    });
    return matcher;
  }
  throw new Error('invalid Runtime permission matcher');
}

function assertMatcherFingerprint(
  matcher: RuntimePermissionMatcher,
  canonical: unknown,
): void {
  if (stableFingerprint(canonical) !== matcher.fingerprint) {
    throw new Error('Runtime permission matcher fingerprint does not match its scope.');
  }
}

export function hasDynamicShellExpansion(
  command: string,
  platform: RuntimePermissionHostPlatform,
): boolean {
  if (platform === 'win32') {
    return /%[^%\r\n]+%|![^!\r\n]+!|\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}\r\n]+\}|\([^)]*\)|[?^$])|%(?:\*|[0-9]|~[A-Za-z]*[0-9])|%%[A-Za-z]/i
      .test(command);
  }
  return /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}\r\n]+\}|\([^)]*\)|[0-9@*#?$!_-])|`/
    .test(command);
}

export function hasDynamicExpansionForPermissionShell(
  command: string,
  shell: RuntimeExactCommandPermissionMatcher['shell'],
): boolean {
  return hasDynamicShellExpansion(
    command,
    shell === 'posix' ? 'posix' : 'win32',
  );
}

export function runtimePermissionHostPlatform(): RuntimePermissionHostPlatform {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

function createExactCommandMatcher(
  input: RuntimePermissionMatcherInput,
  platform: RuntimePermissionHostPlatform,
): RuntimeExactCommandPermissionMatcher {
  const rawCommand = input.toolInput.command;
  const command = typeof rawCommand === 'string'
    ? normalizeCommand(rawCommand)
    : '';
  const cwd = normalizePermissionPath(input.executionCwd, input.executionCwd, platform);
  const background = input.toolInput.run_in_background === true;
  const shell: RuntimeExactCommandPermissionMatcher['shell'] =
    input.shell ?? (platform === 'win32' ? 'cmd' : 'posix');
  const tokens = tokenizeShellCommand(command, shell);
  const executable = safeExecutableMetadata(tokens?.[0], platform);
  const argvFingerprint = tokens && tokens.length > 1
    ? stableFingerprint(tokens.slice(1))
    : undefined;
  const commandFingerprint = stableFingerprint(command);
  const canonical = {
    version: 1 as const,
    kind: 'exact-command' as const,
    toolName: input.toolName,
    shell,
    ...(input.shellContractFingerprint !== undefined
      ? { shellContractFingerprint: input.shellContractFingerprint }
      : {}),
    commandFingerprint,
    cwd,
    ...(executable !== undefined ? { executable } : {}),
    ...(argvFingerprint !== undefined ? { argvFingerprint } : {}),
    background,
  };
  return {
    ...canonical,
    fingerprint: stableFingerprint(canonical),
  };
}

function safeExecutableMetadata(
  value: string | undefined,
  platform: RuntimePermissionHostPlatform,
): string | undefined {
  if (value === undefined || value.includes('=') || value.length > 512) return undefined;
  const basename = platform === 'win32'
    ? path.win32.basename(value.replaceAll('/', '\\'))
    : path.posix.basename(value);
  return basename.length > 0 && basename.length <= 128 ? basename : undefined;
}

function createExactPathMatcher(
  toolName: string,
  targetPath: string,
  executionCwd: string,
  platform: RuntimePermissionHostPlatform,
): RuntimeExactPathPermissionMatcher {
  const normalizedPath = normalizePermissionPath(targetPath, executionCwd, platform);
  const canonical = {
    version: 1 as const,
    kind: 'exact-path' as const,
    toolName,
    path: normalizedPath,
  };
  return {
    ...canonical,
    fingerprint: stableFingerprint(canonical),
  };
}

function normalizeCommand(command: string): string {
  return command.replace(/\r\n?/g, '\n').trim();
}

function normalizePermissionPath(
  value: string,
  executionCwd: string,
  platform: RuntimePermissionHostPlatform,
): string {
  if (platform === 'win32') {
    const cwd = path.win32.resolve(executionCwd.replaceAll('/', '\\'));
    return path.win32.resolve(cwd, value.replaceAll('/', '\\')).toLowerCase();
  }
  return path.posix.resolve(executionCwd, value);
}

function tokenizeShellCommand(
  command: string,
  shell: RuntimeExactCommandPermissionMatcher['shell'],
): readonly string[] | undefined {
  if (command.length === 0 || command.includes('\0') || command.includes('\n')) return undefined;
  const tokens: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? '';
    if (shell !== 'cmd' && char === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
      continue;
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
      continue;
    }
    const escape = shell === 'cmd' ? '^' : shell === 'powershell' ? '`' : '\\';
    if (char === escape && quote !== 'single' && index + 1 < command.length) {
      token += command[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (/\s/.test(char) && quote === undefined) {
      if (token.length > 0) tokens.push(token);
      token = '';
      continue;
    }
    token += char;
  }
  if (quote !== undefined) return undefined;
  if (token.length > 0) tokens.push(token);
  return tokens.length > 0 ? tokens : undefined;
}

function normalizeGenericInput(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(input)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableSerialize(record[key])}`
  )).join(',')}}`;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
