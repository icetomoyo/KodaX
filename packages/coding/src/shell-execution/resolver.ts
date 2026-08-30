import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, win32 } from 'node:path';
import iconv from 'iconv-lite';
import {
  BUN_BE_BUN_ENV,
  ELECTRON_RUN_AS_NODE_ENV,
  killChildProcessTree,
  prepareJavaScriptChildLaunch,
  registerManagedChildProcess,
} from '@kodax-ai/agent';

import type {
  KodaXShellExecutionContract,
  KodaXShellKind,
  KodaXShellProfileMode,
} from '../types.js';
import {
  DEFAULT_SHELL_ENV_CACHE_TTL_MS,
  DEFAULT_SHELL_ENV_PROBE_TIMEOUT_MS,
  normalizeShellExecutionContract,
  shellExecutionContractFingerprint,
} from './contract.js';
import {
  buildShellProbeEnvironment,
  hardenShellCommandEnvironment,
  mergeWindowsRegistryEnvironment,
  parseWindowsRegistryEnvironment,
  sanitizeResolvedShellEnvironment,
} from './environment.js';

const MAX_PROBE_OUTPUT_BYTES = 3 * 1024 * 1024;
const MAX_SHELL_ENV_CACHE_ENTRIES = 64;
const NODE_ENV_HELPER_SOURCE = [
  `delete process.env.${BUN_BE_BUN_ENV};`,
  'const s=process.argv[1];',
  "process.stdout.write(s+Buffer.from(JSON.stringify(process.env)).toString('base64')+s);",
].join('');
const NODE_ENV_HELPER_EXPRESSION = `eval(Buffer.from('${
  Buffer.from(NODE_ENV_HELPER_SOURCE).toString('base64')
}','base64').toString())`;

interface ShellEnvironmentCacheEntry {
  readonly expiresAt: number;
  readonly value: ResolvedShellExecution;
}

interface InFlightShellResolution {
  readonly controller: AbortController;
  readonly promise: Promise<ResolvedShellExecution>;
  waiters: number;
  settled: boolean;
}

export interface ResolvedShellExecution {
  readonly executable: string;
  readonly commandArgs: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly contract: KodaXShellExecutionContract;
  readonly contractFingerprint: string;
}

export interface ShellCommandInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly windowsVerbatimArguments?: boolean;
}

const environmentCache = new Map<string, ShellEnvironmentCacheEntry>();
const inFlightResolutions = new Map<string, InFlightShellResolution>();
let environmentCacheGeneration = 0;

export function clearShellExecutionEnvironmentCache(): void {
  environmentCacheGeneration += 1;
  environmentCache.clear();
  for (const resolution of inFlightResolutions.values()) {
    resolution.controller.abort();
  }
  inFlightResolutions.clear();
}

export async function resolveShellExecution(
  rawContract: KodaXShellExecutionContract,
  cwd: string,
  sessionScratchDir?: string,
  signal?: AbortSignal,
): Promise<ResolvedShellExecution> {
  if (signal?.aborted) throw shellResolutionAbortError();
  const contract = normalizeShellExecutionContract(rawContract);
  const executionCwd = resolve(cwd);
  const normalizedCwd = normalizeCacheCwd(executionCwd);
  const contractFingerprint = shellExecutionContractFingerprint(contract);
  const scratchKey = sessionScratchDir === undefined
    ? ''
    : normalizeCacheCwd(sessionScratchDir);
  const key = [
    environmentCacheGeneration,
    contractFingerprint,
    normalizedCwd,
    scratchKey,
  ].join('\0');
  const cached = environmentCache.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
  if (cached !== undefined) environmentCache.delete(key);

  let pending = inFlightResolutions.get(key);
  if (pending?.controller.signal.aborted) {
    if (inFlightResolutions.get(key) === pending) {
      inFlightResolutions.delete(key);
    }
    pending = undefined;
  }
  if (pending !== undefined) return waitForInFlightResolution(pending, signal);
  const controller = new AbortController();
  let entry: InFlightShellResolution;
  const promise = resolveFreshShellExecution(
    contract,
    contractFingerprint,
    executionCwd,
    sessionScratchDir,
    controller.signal,
  ).then((value) => {
    if (
      controller.signal.aborted
      || inFlightResolutions.get(key) !== entry
    ) {
      throw shellResolutionAbortError();
    }
    const ttlMs = contract.cache?.ttlMs ?? DEFAULT_SHELL_ENV_CACHE_TTL_MS;
    if (ttlMs > 0) cacheResolvedEnvironment(key, value, ttlMs);
    return value;
  }).finally(() => {
    entry.settled = true;
    if (inFlightResolutions.get(key) === entry) {
      inFlightResolutions.delete(key);
    }
  });
  entry = {
    controller,
    promise,
    waiters: 0,
    settled: false,
  };
  inFlightResolutions.set(key, entry);
  return waitForInFlightResolution(entry, signal);
}

function waitForInFlightResolution(
  entry: InFlightShellResolution,
  signal: AbortSignal | undefined,
): Promise<ResolvedShellExecution> {
  if (signal?.aborted) {
    if (entry.waiters === 0 && !entry.settled) entry.controller.abort();
    return Promise.reject(shellResolutionAbortError());
  }
  entry.waiters += 1;
  return new Promise((resolveValue, reject) => {
    let finished = false;
    const releaseWaiter = (): boolean => {
      signal?.removeEventListener('abort', onAbort);
      entry.waiters -= 1;
      return entry.waiters === 0 && !entry.settled;
    };
    const finish = (
      outcome:
        | { readonly value: ResolvedShellExecution }
        | { readonly error: unknown },
    ): void => {
      if (finished) return;
      finished = true;
      if (releaseWaiter()) entry.controller.abort();
      if ('value' in outcome) resolveValue(outcome.value);
      else reject(outcome.error);
    };
    const onAbort = (): void => {
      if (finished) return;
      finished = true;
      const abortsResolution = releaseWaiter();
      if (!abortsResolution) {
        reject(shellResolutionAbortError());
        return;
      }
      entry.controller.abort();
      void entry.promise.then(
        () => reject(shellResolutionAbortError()),
        () => reject(shellResolutionAbortError()),
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    void entry.promise.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error }),
    );
    if (signal?.aborted) onAbort();
  });
}

function shellResolutionAbortError(): Error {
  return Object.assign(
    new Error('shell environment resolution cancelled'),
    { name: 'AbortError' },
  );
}

export function createShellCommandInvocation(
  resolved: ResolvedShellExecution,
  command: string,
): ShellCommandInvocation {
  const hardened = hardenShellCommandEnvironment(
    resolved.env,
    resolved.contract.shell.kind,
    process.platform,
  );
  return {
    executable: resolved.executable,
    args: [
      ...resolved.commandArgs,
      resolved.contract.shell.kind === 'cmd' && command.trimStart().startsWith('"')
        ? `"${command.trimStart()}"`
        : command,
    ],
    env: hardened,
    ...(resolved.contract.shell.kind === 'cmd'
      ? { windowsVerbatimArguments: true }
      : {}),
  };
}

async function resolveFreshShellExecution(
  contract: KodaXShellExecutionContract,
  contractFingerprint: string,
  cwd: string,
  sessionScratchDir?: string,
  signal?: AbortSignal,
): Promise<ResolvedShellExecution> {
  const profile = contract.shell.profile ?? 'default';
  if (
    process.platform === 'win32'
    && contract.shell.kind === 'pwsh'
    && (profile === 'login' || profile === 'login-interactive')
  ) {
    throw new Error('pwsh login profile mode is supported only on Linux and macOS');
  }
  let bootstrapEnv = buildShellProbeEnvironment(
    process.env,
    contract,
    sessionScratchDir,
    process.platform,
  );
  if (
    contract.shell.kind === 'bash'
    && profile === 'none'
  ) {
    bootstrapEnv = withoutEnvironmentVariable(bootstrapEnv, 'BASH_ENV');
  }
  if (
    process.platform === 'win32'
    && contract.environment?.windowsPath === 'registry'
  ) {
    bootstrapEnv = await withCurrentWindowsRegistryPath(
      bootstrapEnv,
      cwd,
      contract,
      signal,
    );
    bootstrapEnv = buildShellProbeEnvironment(
      bootstrapEnv,
      contract,
      sessionScratchDir,
      process.platform,
    );
  }
  const executable = resolveShellExecutable(contract, bootstrapEnv);
  const captured = await probeShellEnvironment(
    executable,
    contract,
    cwd,
    bootstrapEnv,
    signal,
  );
  return {
    executable,
    commandArgs: buildCommandArgs(contract.shell.kind, contract.shell.args),
    env: sanitizeResolvedShellEnvironment(
      captured,
      contract,
      process.platform,
    ),
    contract,
    contractFingerprint,
  };
}

async function probeShellEnvironment(
  executable: string,
  contract: KodaXShellExecutionContract,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, string>>> {
  const sentinel = `__KODAX_ENV_${randomBytes(16).toString('hex')}__`;
  const helper = buildNodeEnvironmentHelper(contract.shell.kind, sentinel);
  const setup = contract.environment?.setup;
  const command = combineProbeSetup(contract.shell.kind, setup, helper);
  const args = buildShellProbeArgs(
    contract.shell.kind,
    contract.shell.args,
    contract.shell.profile ?? 'default',
    command,
  );
  const output = await captureProcess({
    executable,
    args,
    cwd,
    env,
    timeoutMs:
      contract.probeTimeoutMs ?? DEFAULT_SHELL_ENV_PROBE_TIMEOUT_MS,
    kind: 'shell-environment-probe',
    windowsVerbatimArguments: contract.shell.kind === 'cmd',
    signal,
  });
  return parseEnvironmentProbeOutput(output.stdout, sentinel);
}

function parseEnvironmentProbeOutput(
  output: Buffer,
  sentinel: string,
): Readonly<Record<string, string>> {
  const marker = Buffer.from(sentinel);
  const start = output.indexOf(marker);
  const end = start < 0 ? -1 : output.indexOf(marker, start + marker.length);
  if (start < 0 || end < 0) {
    throw new Error('shell environment probe did not return a valid framed payload');
  }
  const encoded = output
    .subarray(start + marker.length, end)
    .toString('ascii');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('shell environment probe returned an invalid payload encoding');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new Error('shell environment probe returned invalid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('shell environment probe returned a non-object environment');
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (
      name.length === 0
      || name.length > 32_767
      || name.includes('=')
      || name.includes('\0')
      || typeof value !== 'string'
    ) {
      throw new Error('shell environment probe returned an invalid environment entry');
    }
    result[name] = value;
  }
  return result;
}

/** @internal Exported for Electron bootstrap contract tests. */
export function buildNodeEnvironmentHelper(
  kind: KodaXShellKind,
  sentinel: string,
  executable = process.execPath,
  isElectron = process.versions.electron !== undefined,
  isBundled = process.env.KODAX_BUNDLED === 'true',
): string {
  const launch = prepareJavaScriptChildLaunch({
    args: ['-e', NODE_ENV_HELPER_EXPRESSION, sentinel],
    env: {},
    executable,
    isBundled,
    isElectron,
  });
  let command: string;
  if (kind === 'pwsh' || kind === 'powershell') {
    command = `& ${quotePowerShell(launch.command)} ${launch.args.map(quotePowerShell).join(' ')}`;
  } else if (kind === 'cmd') {
    command = [quoteCmd(launch.command), ...launch.args.map(quoteCmd)].join(' ');
  } else {
    command = [quotePosix(launch.command), ...launch.args.map(quotePosix)].join(' ');
  }
  const bootstrapEnv = [BUN_BE_BUN_ENV, ELECTRON_RUN_AS_NODE_ENV]
    .filter((name) => launch.env[name] === '1');
  if (bootstrapEnv.length === 0) return command;
  if (kind === 'pwsh' || kind === 'powershell') {
    const assignments = bootstrapEnv
      .map((name) => `$env:${name} = '1';`)
      .join(' ');
    return `& { ${assignments} ${command} }`;
  }
  if (kind === 'cmd') {
    const assignments = bootstrapEnv
      .map((name) => `set "${name}=1"`)
      .join(' && ');
    return `${assignments} && ${command}`;
  }
  return `${bootstrapEnv.map((name) => `${name}=1`).join(' ')} ${command}`;
}

function combineProbeSetup(
  kind: KodaXShellKind,
  setup: string | undefined,
  helper: string,
): string {
  if (setup === undefined) return kind === 'cmd' ? `"${helper}"` : helper;
  if (kind === 'pwsh' || kind === 'powershell') {
    return `$ErrorActionPreference='Stop'; ${setup}\n${helper}`;
  }
  if (kind === 'cmd') return `(${setup}) && ${helper}`;
  return `set -e\n${setup}\n${helper}`;
}

/** @internal Exported for cross-platform argv contract tests. */
export function buildShellProbeArgs(
  kind: KodaXShellKind,
  prefixArgs: readonly string[] | undefined,
  profile: KodaXShellProfileMode,
  command: string,
): readonly string[] {
  const prefix = [...(prefixArgs ?? [])];
  if (kind === 'cmd') return [...prefix, '/d', '/v:off', '/s', '/c', command];
  if (kind === 'pwsh' || kind === 'powershell') {
    const interactive =
      profile === 'interactive' || profile === 'login-interactive';
    const login = profile === 'login' || profile === 'login-interactive';
    return [
      ...(kind === 'pwsh' && login ? ['-Login'] : []),
      ...prefix,
      '-NoLogo',
      ...(interactive ? ['-Interactive'] : ['-NonInteractive']),
      ...(profile === 'none' ? ['-NoProfile'] : []),
      '-Command',
      command,
    ];
  }
  const profileArgs = posixProfileArgs(kind, profile);
  return [...prefix, ...profileArgs, '-c', command];
}

function buildCommandArgs(
  kind: KodaXShellKind,
  prefixArgs: readonly string[] | undefined,
): readonly string[] {
  const prefix = [...(prefixArgs ?? [])];
  if (kind === 'cmd') return [...prefix, '/d', '/v:off', '/s', '/c'];
  if (kind === 'pwsh' || kind === 'powershell') {
    return [
      ...prefix,
      '-NoLogo',
      '-NonInteractive',
      '-NoProfile',
      '-Command',
    ];
  }
  return kind === 'bash'
    ? [...prefix, '--noprofile', '--norc', '-c']
    : [...prefix, '-f', '-c'];
}

function posixProfileArgs(
  kind: 'bash' | 'zsh',
  profile: KodaXShellProfileMode,
): readonly string[] {
  if (profile === 'default') return [];
  if (profile === 'none') {
    return kind === 'bash' ? ['--noprofile', '--norc'] : ['-f'];
  }
  if (profile === 'login') return kind === 'bash' ? ['--login'] : ['-l'];
  if (profile === 'interactive') return ['-i'];
  return kind === 'bash' ? ['--login', '-i'] : ['-l', '-i'];
}

function resolveShellExecutable(
  contract: KodaXShellExecutionContract,
  env: NodeJS.ProcessEnv,
): string {
  const requested = contract.shell.executable
    ?? defaultShellExecutable(contract.shell.kind, env);
  const resolved = resolveExecutableFromEnvironment(requested, env);
  if (resolved === undefined) {
    throw new Error(`configured shell is unavailable: ${requested}`);
  }
  return resolved;
}

function defaultShellExecutable(
  kind: KodaXShellKind,
  env: NodeJS.ProcessEnv,
): string {
  if (kind === 'cmd') return env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  if (kind === 'powershell') {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
    return systemRoot === undefined
      ? 'powershell.exe'
      : join(
          systemRoot,
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        );
  }
  if (kind === 'pwsh') return process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
  if (kind === 'bash') return process.platform === 'win32' ? 'bash.exe' : 'bash';
  return process.platform === 'win32' ? 'zsh.exe' : 'zsh';
}

function resolveExecutableFromEnvironment(
  requested: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (isAbsolute(requested) || win32.isAbsolute(requested)) {
    return isExecutableFile(requested) ? requested : undefined;
  }
  const pathValue = environmentValue(env, 'PATH') ?? '';
  const extensions = process.platform === 'win32'
    ? executableExtensions(requested, environmentValue(env, 'PATHEXT'))
    : [''];
  for (const entry of pathValue.split(delimiter)) {
    const directory = entry.replace(/^"|"$/g, '');
    if (!isAbsolute(directory) && !win32.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${requested}${extension}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function executableExtensions(
  requested: string,
  pathExt: string | undefined,
): readonly string[] {
  if (win32.extname(requested).length > 0) return [''];
  return (pathExt ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(
      candidate,
      process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

async function withCurrentWindowsRegistryPath(
  env: NodeJS.ProcessEnv,
  cwd: string,
  contract: KodaXShellExecutionContract,
  signal?: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
  const systemRoot = environmentValue(env, 'SystemRoot');
  if (systemRoot === undefined) {
    throw new Error('Windows registry PATH resolution requires SystemRoot');
  }
  const regExecutable = join(systemRoot, 'System32', 'reg.exe');
  if (!isExecutableFile(regExecutable)) {
    throw new Error('Windows registry PATH resolution requires reg.exe');
  }
  const timeoutMs =
    contract.probeTimeoutMs ?? DEFAULT_SHELL_ENV_PROBE_TIMEOUT_MS;
  const outputEncoding = await resolveWindowsCommandEncoding(
    systemRoot,
    cwd,
    env,
    timeoutMs,
    signal,
  );
  const [machineEnvironment, userEnvironment] = await Promise.all([
    queryWindowsRegistryEnvironment(
      regExecutable,
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
      cwd,
      env,
      timeoutMs,
      outputEncoding,
      signal,
    ),
    queryWindowsRegistryEnvironment(
      regExecutable,
      'HKCU\\Environment',
      cwd,
      env,
      timeoutMs,
      outputEncoding,
      signal,
    ),
  ]);
  if (machineEnvironment === undefined && userEnvironment === undefined) {
    throw new Error('Windows registry PATH could not be resolved');
  }
  return mergeWindowsRegistryEnvironment(
    env,
    machineEnvironment ?? {},
    userEnvironment ?? {},
  );
}

async function queryWindowsRegistryEnvironment(
  executable: string,
  key: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputEncoding: string | undefined,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, string>> | undefined> {
  try {
    const output = await captureProcess({
      executable,
      args: ['query', key],
      cwd,
      env,
      timeoutMs,
      kind: 'shell-registry-path-probe',
      acceptNonZeroExit: true,
      signal,
    });
    if (output.exitCode !== 0) return undefined;
    const utf8 = output.stdout.toString('utf8');
    let decoded = utf8;
    if (outputEncoding !== undefined) {
      decoded = iconv.decode(output.stdout, outputEncoding);
    } else if (utf8.includes('\uFFFD')) {
      decoded = iconv.decode(output.stdout, 'cp936');
    }
    const parsed = parseWindowsRegistryEnvironment(decoded);
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function resolveWindowsCommandEncoding(
  systemRoot: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const cmdExecutable = join(systemRoot, 'System32', 'cmd.exe');
  if (!isExecutableFile(cmdExecutable)) return undefined;
  try {
    const output = await captureProcess({
      executable: cmdExecutable,
      args: ['/d', '/s', '/c', 'chcp'],
      cwd,
      env,
      timeoutMs,
      kind: 'shell-windows-codepage-probe',
      acceptNonZeroExit: true,
      signal,
    });
    if (output.exitCode !== 0) return undefined;
    const match = /(\d{3,5})/.exec(output.stdout.toString('ascii'));
    if (match?.[1] === undefined || match[1] === '65001') return undefined;
    const encoding = `cp${match[1]}`;
    return iconv.encodingExists(encoding) ? encoding : undefined;
  } catch {
    return undefined;
  }
}

interface CaptureProcessInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly kind: string;
  readonly acceptNonZeroExit?: boolean;
  readonly windowsVerbatimArguments?: boolean;
  readonly signal?: AbortSignal;
}

function captureProcess(
  input: CaptureProcessInput,
): Promise<{ readonly stdout: Buffer; readonly exitCode: number | null }> {
  return new Promise((resolveOutput, reject) => {
    if (input.signal?.aborted) {
      reject(shellResolutionAbortError());
      return;
    }
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      ...(input.windowsVerbatimArguments === true
        ? { windowsVerbatimArguments: true }
        : {}),
    });
    const unregister = registerManagedChildProcess(child, {
      kind: input.kind,
      command: input.executable,
      cwd: input.cwd,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let termination: Promise<void> | undefined;
    let terminationError: Error | undefined;
    const finish = (error?: Error, exitCode: number | null = null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      unregister();
      if (error !== undefined) reject(error);
      else resolveOutput({ stdout: Buffer.concat(chunks), exitCode });
    };
    const finishAfterTermination = (error: Error): void => {
      terminationError ??= error;
      const pendingTermination = termination
        ?? killChildProcessTree(child).then(() => undefined);
      termination = pendingTermination;
      void pendingTermination.then(
        () => finish(terminationError),
        () => finish(terminationError),
      );
    };
    const timer = setTimeout(() => {
      finishAfterTermination(new Error('shell environment probe timed out'));
    }, input.timeoutMs);
    const onAbort = (): void => {
      finishAfterTermination(shellResolutionAbortError());
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_PROBE_OUTPUT_BYTES) {
        finishAfterTermination(
          new Error('shell environment probe output exceeds the size limit'),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.resume();
    child.on('error', () => {
      if (input.signal?.aborted || termination !== undefined) {
        finishAfterTermination(terminationError ?? shellResolutionAbortError());
        return;
      }
      finish(new Error('configured shell could not be started'));
    });
    child.on('close', (code) => {
      if (termination !== undefined) {
        finishAfterTermination(terminationError ?? shellResolutionAbortError());
        return;
      }
      if (code !== 0 && input.acceptNonZeroExit !== true) {
        finish(new Error('shell environment probe failed'), code);
        return;
      }
      finish(undefined, code);
    });
  });
}

function cacheResolvedEnvironment(
  key: string,
  value: ResolvedShellExecution,
  ttlMs: number,
): void {
  environmentCache.delete(key);
  environmentCache.set(key, { expiresAt: Date.now() + ttlMs, value });
  while (environmentCache.size > MAX_SHELL_ENV_CACHE_ENTRIES) {
    const oldest = environmentCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    environmentCache.delete(oldest);
  }
}

function normalizeCacheCwd(cwd: string): string {
  const absolute = resolve(cwd);
  let normalized = absolute;
  try {
    normalized = realpathSync.native(absolute);
  } catch {
    // spawn will surface a missing cwd; keeping the normalized absolute path
    // still gives stable cache isolation without hiding the actual failure.
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const entry = Object.entries(env).find(
    ([candidate]) => candidate.toUpperCase() === name.toUpperCase(),
  );
  return entry?.[1];
}

function withoutEnvironmentVariable(
  env: NodeJS.ProcessEnv,
  name: string,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([candidate]) => candidate.toUpperCase() !== name.toUpperCase(),
    ),
  );
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteCmd(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}
