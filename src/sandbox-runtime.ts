import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
  SandboxAskCallback,
  SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import {
  ELECTRON_NODE_ENV_SCRUB_IMPORT,
  ELECTRON_RUN_AS_NODE_ENV,
  containWindowsEffectProcess,
  emitKodaXDiagnostic,
  getAgentConfigHome,
  isCurrentProcessWindowsJobContained,
  killChildProcessTree,
  prepareInternalNodeLaunch,
  prepareJavaScriptChildLaunch,
  readProcessStartIdentity,
  rememberChildProcessTree,
  terminateWindowsEffectJob,
  windowsSandboxSidHasOtherProcesses,
  withKodaXFileLock,
  type ISkillRegistry,
  type RunnerToolCall,
  type Skill,
  type WindowsEffectJob,
} from '@kodax-ai/agent';
import {
  KODAX_HARD_TIMEOUT,
  KodaXShellSandbox,
  KodaXShellSandboxBackend,
  KodaXPreparedShellSandboxInvocation,
  KodaXShellSandboxObservation,
  KodaXShellSandboxProcessControl,
  KodaXSkillScriptRunInput,
  KodaXSkillScriptRunner,
} from '@kodax-ai/coding';
import {
  mergeWindowsSandboxTargetEnvironment,
  rewriteWindowsGitSafeDirectoryArgv,
  windowsGitBrokerHelpersSource,
  windowsGitTrustRoots,
} from './windows-git-sandbox.js';
import {
  asrtWindowsNetworkOnlyConfig,
  createWindowsSandboxV2RunRequest,
  encodeWindowsSandboxV2Bootstrap,
  encodeWindowsSandboxV2ControlFrame,
  resolveWindowsSandboxV2Executable,
  splitAsrtWindowsInvocation,
  WINDOWS_SANDBOX_V2_PROTOCOL,
  windowsSandboxV2Generation,
} from './windows-sandbox-v2.js';
import {
  assertWindowsAsrtRunnerTrustOutsideWriteRoots,
  assertWindowsSandboxControlStateNotDirectlyAccessible,
  assertTrustedTextNativeStateNotDirectlyReadable,
  assertTrustedTextNativeStateNotDirectlyWritable,
  assertWindowsNativeArtifactStoreNotDirectlyWritable,
  ensureWindowsSandboxControlDirectory,
  repairWindowsSandboxControlDirectory,
  resolveWindowsAsrtRunnerArtifact,
  trustedTextNativeArtifactStateRoots,
  verifyWindowsSandboxControlDirectory,
  windowsNativeArtifactCacheRoot,
  windowsSandboxControlDirectory,
} from './windows-native-artifacts.js';

export { rewriteWindowsGitSafeDirectoryArgv, windowsGitTrustRoots };

export const KODAX_ASRT_VERSION = '0.0.65';

const WINDOWS_LEGACY_ASRT_FILESYSTEM_BACKEND_RETIRED =
  'Windows ASRT filesystem/workspace-session execution is retired; use the native v2 shell sandbox.';

function rejectWindowsLegacyAsrtFilesystemBackend(): void {
  if (process.platform === 'win32') {
    throw new Error(WINDOWS_LEGACY_ASRT_FILESYSTEM_BACKEND_RETIRED);
  }
}

// The CLI imports this module only for sandbox commands/cleanup. Keep ASRT
// behind that module boundary while preserving ordinary static bindings once
// the sandbox runtime itself is initialized.
const {
  DEFAULT_WINDOWS_PROXY_PORT_RANGE,
  SandboxManager,
  getSrtWinPath,
  getWindowsSandboxUserStatus,
  installWindowsSandbox,
  resolveSrtWin,
  uninstallWindowsSandbox,
} = await import('@anthropic-ai/sandbox-runtime');

export interface SandboxRuntimeDoctorResult {
  readonly ready: boolean;
  readonly platform: NodeJS.Platform;
  readonly version: string;
  readonly diagnostics: readonly string[];
  readonly setupRequired: boolean;
}

export interface CreateSkillScriptRunnerInput {
  readonly registry: ISkillRegistry;
  readonly admissions: Readonly<Record<string, readonly string[]>>;
  readonly snapshotRoot: string;
  readonly workspaceAccess: 'none' | 'read' | 'write';
  readonly workspaceByteLimit?: number;
  readonly network:
    | { readonly mode: 'deny' }
    | { readonly mode: 'allowlist'; readonly origins: readonly string[] };
}

interface AdmittedScript {
  readonly skill: string;
  readonly relativePath: string;
  readonly snapshotPath: string;
}

interface SandboxEndpoint {
  readonly host: string;
  readonly port: number;
}

interface SandboxBrokerRequest {
  readonly config: SandboxRuntimeConfig;
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly endpoints: readonly SandboxEndpoint[];
  readonly allowAllNetwork?: boolean;
  readonly bootstrapCommand?: string;
  readonly fallbackToNormalExecution?: boolean;
  readonly controlInvocationId?: string;
  readonly observationBackend?: KodaXShellSandboxBackend;
  readonly observationFile?: string;
  readonly targetStartedMarker?: string;
  readonly wrappedInvocation?: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly shell: boolean;
  };
}

type SandboxBrokerControlObservation =
  | KodaXShellSandboxObservation
  | {
      readonly version: 1;
      readonly state: 'not_started';
      readonly diagnostic?: string;
    };

interface SandboxBrokerControlFrame {
  readonly version: 1;
  readonly invocationId: string;
  readonly observation: SandboxBrokerControlObservation;
}

const SANDBOX_BROKER_REQUEST_MAX_BYTES = 1024 * 1024;
const SANDBOX_BROKER_CONTROL_MAX_BYTES = 16 * 1024;

interface WindowsNetworkBrokerRequest {
  readonly version: 1;
  readonly setupGenerationNonce: string;
  readonly config: SandboxRuntimeConfig;
  readonly cwd: string;
  readonly srtWinPath: string;
  readonly srtWinSha256: string;
  readonly controllerExecutable: string;
  readonly controllerSha256: string;
  readonly controllerProtocol: number;
  readonly expectedSandboxUserSid: string;
  readonly expectedSandboxGroupSid: string;
  readonly endpoints: readonly SandboxEndpoint[];
  readonly allowAllNetwork: boolean;
}

interface WindowsNetworkBrokerState {
  readonly key: string;
  readonly requestFile: string;
  readonly started: Promise<void>;
  markStarted(): void;
  child?: ReturnType<typeof spawn>;
  exit?: Promise<WindowsNetworkBrokerExit>;
  stderrTail: Buffer;
  lastUsed: number;
  ready?: Promise<WindowsNetworkBrokerReady & { readonly ok: true }>;
  references: number;
  failed: boolean;
  stopRequested: boolean;
  stopping?: Promise<void>;
  idleTimer?: NodeJS.Timeout;
}

function retireWindowsNetworkBrokerState(state: WindowsNetworkBrokerState): void {
  state.failed = true;
}

function setWindowsNetworkBrokerReferenced(
  state: WindowsNetworkBrokerState,
  referenced: boolean,
): void {
  const child = state.child;
  if (child === undefined) return;
  if (referenced) child.ref();
  else child.unref();
  const handles = new Set<object>();
  for (const handle of [child.stdin, child.stderr, child.stdio[3]]) {
    if (handle !== null && handle !== undefined) handles.add(handle);
  }
  for (const handle of handles) {
    const update = Reflect.get(handle, referenced ? 'ref' : 'unref');
    if (typeof update === 'function') update.call(handle);
  }
}

interface WindowsNetworkBrokerExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

interface WindowsNetworkBrokerLease {
  readonly ready: WindowsNetworkBrokerReady & { readonly ok: true };
  release(options?: { readonly retireIfLast?: boolean }): Promise<void>;
}

type WindowsNetworkBrokerReady =
  | {
      readonly version: 1;
      readonly ok: true;
      readonly asrtExecutable: string;
      readonly asrtPrefixArgs: readonly string[];
      readonly asrtChildEnvironment: Readonly<Record<string, string>>;
      readonly sandboxUserSid: string;
      readonly sandboxGroupSid: string;
      readonly controllerPipe: string;
    }
  | {
      readonly version: 1;
      readonly ok: false;
      readonly error: string;
    };

export interface AsrtShellAgentHomeAccess {
  readonly read: readonly string[];
  readonly write: readonly string[];
  /** Review-only access must release its Windows ACL grant after this command. */
  readonly ephemeral?: boolean;
}

export interface AsrtShellSandboxSelection {
  /** Exact Agent Home paths admitted by the host permission review. */
  readonly agentHomeAccess?: AsrtShellAgentHomeAccess;
  /** Exact non-workspace paths admitted by the same host permission review. */
  readonly filesystemAccess?: {
    readonly read: readonly string[];
    readonly write: readonly string[];
  };
}

export interface CreateAsrtShellSandboxInput {
  readonly workspaceRoot: string;
  /** Exact Runtime-owned linked-worktree roots that share this workspace policy. */
  readonly additionalWorkspaceRoots?: () => readonly string[];
  /** Existing trusted project Exec Policy from the Run admission snapshot. */
  readonly trustedProjectExecPolicyPath?: string;
  readonly shouldSandbox: (
    call: RunnerToolCall,
  ) => boolean | AsrtShellSandboxSelection
    | Promise<boolean | AsrtShellSandboxSelection>;
}

function withAdditionalWorkspaceRoots(
  selection: boolean | AsrtShellSandboxSelection,
  roots: readonly string[],
): boolean | AsrtShellSandboxSelection {
  if (roots.length === 0) return selection;
  const normalizedRoots = [...new Set(roots.map((root) => path.resolve(root)))];
  const current = typeof selection === 'object'
    ? selection.filesystemAccess
    : undefined;
  return {
    ...(typeof selection === 'object' && selection.agentHomeAccess !== undefined
      ? { agentHomeAccess: selection.agentHomeAccess }
      : {}),
    filesystemAccess: {
      read: [...new Set([...(current?.read ?? []), ...normalizedRoots])],
      write: [...new Set([...(current?.write ?? []), ...normalizedRoots])],
    },
  };
}

export type KodaXSandboxNetworkPolicy =
  | { readonly mode: 'allow' }
  | { readonly mode: 'deny' }
  | { readonly mode: 'allowlist'; readonly origins: readonly string[] };

export interface KodaXSandboxFilesystemPolicy {
  /**
   * Read roots required by the command. ASRT permits ordinary reads by
   * default. An explicit denyRead remains authoritative beneath these roots.
   */
  readonly allowRead: readonly string[];
  /** The only roots in which the command may create, modify, or remove data. */
  readonly allowWrite: readonly string[];
  /** Read-denied roots; denyRead takes precedence over allowRead. */
  readonly denyRead?: readonly string[];
  /** Write-denied roots; denyWrite takes precedence over allowWrite. */
  readonly denyWrite?: readonly string[];
}

export interface KodaXSandboxRunInput {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly filesystem: KodaXSandboxFilesystemPolicy;
  readonly network?: KodaXSandboxNetworkPolicy;
  /** Defaults to the host process environment; set false for a minimal bootstrap environment. */
  readonly inheritEnvironment?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export type KodaXSandboxRunResult =
  | {
    readonly status: 'completed';
    readonly sandboxed: true;
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }
  | {
    readonly status: 'unavailable';
    readonly sandboxed: false;
    readonly doctor: SandboxRuntimeDoctorResult;
    readonly reason?: 'doctor_not_ready' | 'backend_launch_failed';
    readonly diagnostic?: string;
  }
  | {
    readonly status: 'execution_uncertain';
    readonly sandboxed: false;
    readonly reason: 'attestation_failed';
    readonly diagnostic: string;
    readonly doctor: SandboxRuntimeDoctorResult;
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  };

export interface SandboxSetupOutcome {
  readonly status: 'ready' | 'cancelled' | 'unavailable';
  readonly attempted: boolean;
  readonly doctor: SandboxRuntimeDoctorResult;
  readonly guidance: readonly string[];
  readonly error?: string;
}

export interface KodaXSandboxCapability {
  readonly version: 7;
  readonly asrtVersion: string;
  readonly platform: NodeJS.Platform;
  readonly backend: 'windows-restricted-user' | 'macos-seatbelt' | 'linux-bubblewrap' | 'unsupported';
  readonly genericCommandExecution: true;
  readonly controls: readonly ['filesystem', 'network', 'environment', 'timeout', 'output'];
  readonly ordinaryCallsTriggerSetup: false;
  readonly setupMayElevate: boolean;
  readonly unavailableBehavior: 'structured-no-execution';
  readonly permissionFallback: 'normal-permission-policy';
  /**
   * Marker field (v4, non-versioned): Windows sandboxed git trusts exactly the
   * session-authorized repo roots through per-exec `safe.directory` env entries.
   * A daemon that reports `sandboxRuntime` without this field predates that
   * behavior; clients surface a restart diagnostic instead of failing the gate.
   */
  readonly gitSafeDirectory: 'authorized-repo-roots';
  readonly delayedEffectDrainRecovery: 'automatic';
  readonly sameBootAclRecovery: 'sandbox-user-process-probe';
  readonly trustedTextAuthority: 'host-transaction';
  readonly windowsShellAuthority: 'native-token-job-v2';
  readonly commandLifetimeFilesystemLease: false;
}

export function sandboxRuntimeCapability(): KodaXSandboxCapability {
  const backend = process.platform === 'win32'
    ? 'windows-restricted-user'
    : process.platform === 'darwin'
      ? 'macos-seatbelt'
      : process.platform === 'linux'
        ? 'linux-bubblewrap'
        : 'unsupported';
  return {
    version: 7,
    asrtVersion: KODAX_ASRT_VERSION,
    platform: process.platform,
    backend,
    genericCommandExecution: true,
    controls: ['filesystem', 'network', 'environment', 'timeout', 'output'],
    ordinaryCallsTriggerSetup: false,
    setupMayElevate: process.platform === 'win32',
    unavailableBehavior: 'structured-no-execution',
    permissionFallback: 'normal-permission-policy',
    gitSafeDirectory: 'authorized-repo-roots',
    delayedEffectDrainRecovery: 'automatic',
    sameBootAclRecovery: 'sandbox-user-process-probe',
    trustedTextAuthority: 'host-transaction',
    windowsShellAuthority: 'native-token-job-v2',
    commandLifetimeFilesystemLease: false,
  };
}

const MAX_OUTPUT_BYTES = 1_048_576;
const SCRIPT_TIMEOUT_MS = 120_000;
const WINDOWS_V2_LAUNCH_TIMEOUT_MS = 30_000;
const windowsNetworkBrokers = new Map<string, WindowsNetworkBrokerState>();
const WINDOWS_NETWORK_PORTS_PER_BROKER = 2;
const [WINDOWS_NETWORK_PROXY_PORT_LOW, WINDOWS_NETWORK_PROXY_PORT_HIGH]
  = DEFAULT_WINDOWS_PROXY_PORT_RANGE;
const WINDOWS_NETWORK_BROKER_CAPACITY = Math.max(
  1,
  Math.floor(
    (WINDOWS_NETWORK_PROXY_PORT_HIGH - WINDOWS_NETWORK_PROXY_PORT_LOW + 1)
      / WINDOWS_NETWORK_PORTS_PER_BROKER,
  ),
);
const WINDOWS_NETWORK_BROKER_IDLE_GRACE_MS = 1_000;
let windowsNetworkBrokerUseSequence = 0;

function touchWindowsNetworkBroker(state: WindowsNetworkBrokerState): void {
  windowsNetworkBrokerUseSequence += 1;
  state.lastUsed = windowsNetworkBrokerUseSequence;
}
const moduleRequire = createRequire(import.meta.url);
const ASRT_MODULE_URL = process.env.KODAX_BUNDLED === 'true'
  ? undefined
  : pathToFileURL(moduleRequire.resolve('@anthropic-ai/sandbox-runtime')).href;
const SENSITIVE_PATH_PARTS = new Set([
  '.ssh', '.aws', '.azure', '.gnupg', '.kodax', '.agents', '.codex', '.claude', '.gemini',
  '.direnv', '.terraform.d',
]);
const SENSITIVE_FILES = new Set([
  '.env', '.envrc', '.pgpass', '.npmrc', '.pypirc', 'credentials', 'id_rsa', 'id_ed25519',
]);
const WORKSPACE_SHELL_LEGACY_HOME_DENY_PATHS = [
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.kodax', '.agents',
  '.codex', '.claude', '.gemini', '.direnv', '.terraform.d',
  path.join('.cargo', 'credentials.toml'),
  path.join('.config', 'gcloud'),
  path.join('.config', 'gh'),
  path.join('.config', 'openai'),
  path.join('.config', 'anthropic'),
  '.gitconfig',
  path.join('.config', 'git', 'config'),
  '.terraformrc',
  path.join('.config', 'pypoetry', 'auth.toml'),
  '.condarc', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile',
  path.join('.config', 'fish', 'config.fish'),
  path.join('.config', 'fish', 'fish_variables'),
  '.bash_history', '.zsh_history',
  path.join('.m2', 'settings.xml'),
  path.join('.m2', 'settings-security.xml'),
  path.join('.gradle', 'gradle.properties'),
  path.join('.nuget', 'NuGet', 'NuGet.Config'),
  path.join('.pip', 'pip.conf'),
  path.join('.config', 'pip', 'pip.conf'),
  path.join('.cache', 'huggingface', 'token'),
  path.join('.huggingface', 'token'),
  path.join('.config', 'rclone', 'rclone.conf'),
  path.join('.local', 'share', 'keyrings'),
  path.join('Library', 'Keychains'),
  path.join('AppData', 'Roaming', 'Microsoft', 'Protect'),
  path.join('AppData', 'Roaming', 'Microsoft', 'Credentials'),
  path.join('AppData', 'Roaming', 'Microsoft', 'Vault'),
  path.join('AppData', 'Local', 'Microsoft', 'Credentials'),
  path.join('AppData', 'Local', 'Microsoft', 'Protect'),
  path.join('AppData', 'Local', 'Microsoft', 'Vault'),
  '.password-store', '.env', '.envrc', '.pgpass', '.env.local', '.env.development',
  '.env.production', '.env.test', '.env.staging', '.npmrc', '.pypirc', '.netrc',
  '.git-credentials', 'credentials', 'credentials.json',
  'application_default_credentials.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
] as const;
const WORKSPACE_SHELL_LEGACY_AGENT_HOME_DENY_PATHS = [
  'native-text-state-v1', 'runtime', 'mcp-tokens', 'mcp-clients', 'integrations',
  'sandbox-runtime', 'processes', 'learned', 'config.json', 'auth.json',
  'trusted-project-rules.json', '.env', '.envrc', '.pgpass', '.npmrc', '.pypirc',
  '.netrc', '.git-credentials', 'credentials', 'credentials.json',
  'application_default_credentials.json',
] as const;
const WORKSPACE_SHELL_INTERNAL_AGENT_HOME_DIRECTORIES = [
  'native-text-state-v1',
  'runtime',
  'processes',
  'learned',
] as const;
const ELECTRON_NODE_ENV_SCRUB_IMPORT_LITERAL = JSON.stringify(ELECTRON_NODE_ENV_SCRUB_IMPORT);
const ELECTRON_RUN_AS_NODE_ENV_LITERAL = JSON.stringify(ELECTRON_RUN_AS_NODE_ENV);
const TARGET_ARGV_BOOTSTRAP = String.raw`
const { spawn } = require('node:child_process');
const { writeSync } = require('node:fs');
const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const childEnv = { ...process.env };
for (const name of Object.keys(childEnv)) {
  if (name.toLowerCase() === 'electron_run_as_node') delete childEnv[name];
}
if (input.electronRunAsNode === true) childEnv.ELECTRON_RUN_AS_NODE = '1';
const child = spawn(input.command, input.args, {
  cwd: input.cwd,
  env: childEnv,
  shell: false,
  stdio: ['inherit', 'inherit', 'pipe'],
  windowsHide: true,
  windowsVerbatimArguments: input.windowsVerbatimArguments === true,
});
const stop = (signal) => child.kill(signal);
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
child.once('spawn', () => {
  writeSync(2, input.targetStartedMarker);
  child.stderr.pipe(process.stderr);
});
child.once('error', (error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});
`;
const TARGET_ARGV_LOADER = "eval(Buffer.from(process.argv[1],'base64').toString('utf8'))";
const TARGET_ARGV_LOADER_LITERAL = JSON.stringify(TARGET_ARGV_LOADER);
const TARGET_ARGV_BOOTSTRAP_BASE64 = Buffer.from(
  TARGET_ARGV_BOOTSTRAP,
  'utf8',
).toString('base64');
const TARGET_ARGV_BOOTSTRAP_BASE64_LITERAL = JSON.stringify(TARGET_ARGV_BOOTSTRAP_BASE64);
const WINDOWS_GIT_BROKER_SOURCE = windowsGitBrokerHelpersSource();
const WINDOWS_STANDALONE_BROKER_GATE_SOURCE = String.raw`
const { spawn } = require('node:child_process');
const { createWriteStream } = require('node:fs');
const { readFile, rm } = require('node:fs/promises');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin, terminal: false });
input.once('line', async (gate) => {
  input.close();
  if (gate !== 'go') { process.exitCode = 125; return; }
  const launchFile = process.argv[1];
  const launch = JSON.parse(await readFile(launchFile, 'utf8'));
  await rm(launchFile, { force: true });
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    shell: false,
    stdio: launch.controlPipe === true
      ? ['pipe', 'pipe', 'pipe', 'pipe']
      : ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  if (launch.controlPipe === true && child.stdio[3]) {
    child.stdio[3].pipe(createWriteStream(null, { fd: 3, autoClose: false }));
  }
  child.once('error', (error) => {
    process.stderr.write(String(error?.message ?? error));
    process.exitCode = 1;
  });
  child.once('close', (code) => { process.exitCode = Number.isInteger(code) ? code : 1; });
});
`;

const BROKER_SOURCE = String.raw`
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
let SandboxManager;
const request = await new Promise((resolve, reject) => {
  const chunks = [];
  let bytes = 0;
  process.stdin.on('data', (chunk) => {
    bytes += chunk.byteLength;
    if (bytes > ${SANDBOX_BROKER_REQUEST_MAX_BYTES}) {
      reject(new Error('Sandbox broker request exceeded its byte limit.'));
      process.stdin.destroy();
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  process.stdin.once('error', reject);
  process.stdin.once('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (error) { reject(error); }
  });
});
if (typeof request.controlInvocationId !== 'string' || request.controlInvocationId === '') {
  throw new Error('Sandbox broker request omitted its control invocation identity.');
}
const targetStartedMarker = request.targetStartedMarker
  ?? '\u0000KODAX_ASRT_TARGET_STARTED:' + randomUUID() + '\u0000\n';
const endpoints = new Set(request.endpoints.map((item) => item.host.toLowerCase() + ':' + item.port));
const callback = request.allowAllNetwork === true
  ? async () => true
  : request.endpoints.length === 0
    ? undefined
    : async ({ host, port }) => endpoints.has(host.toLowerCase() + ':' + port);
${WINDOWS_GIT_BROKER_SOURCE}
const withWindowsChildEnvironment = (argv, environment, gitTrustRoots) => {
  const separator = argv.lastIndexOf('--');
  if (separator < 0) throw new Error('ASRT Windows wrapper omitted its child separator.');
  const requested = [];
  const requestedNames = new Set();
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (value === undefined) continue;
    if (!name || name.includes('=') || name.includes('\0') || value.includes('\0')) {
      throw new Error('Invalid environment entry for ASRT Windows child.');
    }
    const normalized = name.toLowerCase();
    if (requestedNames.has(normalized)) {
      throw new Error('Ambiguous Windows child environment variable: ' + name + '.');
    }
    requestedNames.add(normalized);
    requested.push([name, value]);
  }
  const requestedOverrides = new Set(requested.flatMap(([name]) => (
    ['path', 'pathext'].includes(name.toLowerCase()) ? [name.toLowerCase()] : []
  )));
  const controlled = new Set();
  const prefix = [];
  for (let index = 0; index < separator; index += 1) {
    if (argv[index] !== '--env' || index + 1 >= separator) {
      prefix.push(argv[index]);
      continue;
    }
    const assignment = argv[index + 1];
    const name = assignment.split('=', 1)[0]?.toLowerCase();
    if (name) controlled.add(name);
    if (!name || !requestedOverrides.has(name)) prefix.push(argv[index], assignment);
    index += 1;
  }
  const injected = [];
  for (const [name, value] of requested) {
    const normalized = name.toLowerCase();
    if (controlled.has(normalized) && normalized !== 'path' && normalized !== 'pathext') continue;
    injected.push('--env', name + '=' + value);
  }
  const result = [...prefix, ...injected, ...argv.slice(separator)];
  const withGitTrust = rewriteWindowsGitSafeDirectoryArgv(result, gitTrustRoots);
  const estimate = withGitTrust.reduce((size, value) => size + value.length + 3, 0);
  if (estimate > 30000) throw new Error('ASRT Windows child environment exceeds the CreateProcess command-line limit.');
  return withGitTrust;
};
const writeObservation = (observation) => {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    invocationId: request.controlInvocationId,
    observation,
  }) + '\n', 'utf8');
  if (payload.byteLength > ${SANDBOX_BROKER_CONTROL_MAX_BYTES}) {
    throw new Error('Sandbox broker control frame exceeded its byte limit.');
  }
  if (writeSync(3, payload) !== payload.byteLength) {
    throw new Error('Sandbox broker control frame was only partially written.');
  }
};
const waitForTarget = (target, observation, onTargetStarted) => {
  const marker = Buffer.from(targetStartedMarker, 'utf8');
  let pending = Buffer.alloc(0);
  let diagnostic = Buffer.alloc(0);
  let processError;
  let wrapperSpawned = false;
  let targetStarted = false;
  return new Promise((resolve, reject) => {
    let settled = false;
    target.once('spawn', () => {
      wrapperSpawned = true;
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    target.stderr.on('data', (chunk) => {
      if (targetStarted) {
        process.stderr.write(chunk);
        return;
      }
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      const markerOffset = pending.indexOf(marker);
      if (markerOffset >= 0) {
        targetStarted = true;
        onTargetStarted();
        const suffix = pending.subarray(markerOffset + marker.length);
        pending = Buffer.alloc(0);
        diagnostic = Buffer.alloc(0);
        try {
          writeObservation(observation);
        } catch (error) {
          processError = error instanceof Error ? error.message : String(error);
          target.kill('SIGTERM');
        }
        if (suffix.length > 0) process.stderr.write(suffix);
        return;
      }
      const retained = Math.max(0, marker.length - 1);
      if (pending.length > retained) {
        diagnostic = Buffer.concat([
          diagnostic,
          pending.subarray(0, pending.length - retained),
        ]).subarray(-65536);
        pending = pending.subarray(pending.length - retained);
      }
    });
    target.once('error', (error) => {
      processError = error instanceof Error ? error.message : String(error);
    });
    target.once('close', (exitCode, signal) => {
      const preTarget = Buffer.concat([diagnostic, pending]).toString('utf8').trim();
      finish({
        exitCode: signal ? 1 : exitCode ?? 1,
        targetStarted,
        spawnFailedBeforeSpawn: processError !== undefined && !wrapperSpawned,
        controlFailure: targetStarted ? processError : undefined,
        diagnostic: preTarget || processError || undefined,
      });
    });
  });
};
let child;
let targetStarted = false;
try {
  if (request.wrappedInvocation) {
    const wrapped = request.wrappedInvocation;
    child = spawn(wrapped.executable, wrapped.args, {
      cwd: request.cwd,
      env: wrapped.env,
      shell: wrapped.shell,
      stdio: ['inherit', 'inherit', 'pipe'],
      windowsHide: true,
    });
    const result = await waitForTarget(child, {
      version: 1,
      state: 'applied',
      backend: request.observationBackend ?? 'unsupported',
      policyId: 'kodax-workspace-shell-v1',
    }, () => { targetStarted = true; });
    targetStarted = result.targetStarted;
    if (result.controlFailure) {
      process.stderr.write(result.controlFailure + '\n');
      process.exitCode = 125;
    } else {
      if (!targetStarted) {
        if (result.spawnFailedBeforeSpawn) {
          writeObservation({
            version: 1,
            state: 'not_started',
            diagnostic: result.diagnostic,
          });
        }
        process.stderr.write((result.diagnostic || 'Sandbox target launch could not be attested.') + '\n');
      }
      process.exitCode = targetStarted ? result.exitCode : result.spawnFailedBeforeSpawn ? 1 : 125;
    }
  } else {
  ({ SandboxManager } = await import(process.argv[1]));
  const bootstrap = request.bootstrapCommand ?? 'node';
  const bootstrapIsAbsolute = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(bootstrap);
  const bootstrapIsElectronNode = bootstrap === process.execPath
    && process.versions.electron !== undefined;
  const config = process.platform === 'win32' && bootstrapIsAbsolute
    ? {
        ...request.config,
        filesystem: {
          ...request.config.filesystem,
          allowRead: [...new Set([
            ...request.config.filesystem.allowRead,
            bootstrap,
            path.dirname(bootstrap),
          ])],
        },
      }
    : request.config;
  await SandboxManager.initialize(config, callback);
  const quote = (value) => process.platform === 'win32'
    ? '"' + value.replaceAll('"', '""') + '"'
    : "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const internalElectronNode = request.command === process.execPath && process.versions.electron !== undefined;
  const childArgs = internalElectronNode
    ? ['--import', ${ELECTRON_NODE_ENV_SCRUB_IMPORT_LITERAL}, ...request.args]
    : request.args;
  const command = [
    quote(bootstrap),
    '-e',
    quote(${TARGET_ARGV_LOADER_LITERAL}),
    ${TARGET_ARGV_BOOTSTRAP_BASE64_LITERAL},
    Buffer.from(JSON.stringify({
      command: request.command,
      args: childArgs,
      windowsVerbatimArguments: request.windowsVerbatimArguments === true,
      cwd: request.cwd,
      targetStartedMarker,
      electronRunAsNode: internalElectronNode,
    }), 'utf8').toString('base64'),
  ].join(' ');
  if (process.platform === 'win32') {
    const wrapped = await SandboxManager.wrapWithSandboxArgv(command, 'cmd', undefined, undefined, request.cwd);
    const requestedEnv = internalElectronNode || bootstrapIsElectronNode
      ? { ...request.env, [${ELECTRON_RUN_AS_NODE_ENV_LITERAL}]: '1' }
      : request.env;
    const childArgv = withWindowsChildEnvironment(wrapped.argv, requestedEnv, windowsGitTrustRoots(request));
    child = spawn(childArgv[0], childArgv.slice(1), {
      cwd: request.cwd,
      env: wrapped.env,
      shell: false,
      stdio: ['inherit', 'inherit', 'pipe'],
      windowsHide: true,
    });
  } else {
    const wrapped = await SandboxManager.wrapWithSandbox(command);
    const childEnv = internalElectronNode || bootstrapIsElectronNode
      ? { ...request.env, [${ELECTRON_RUN_AS_NODE_ENV_LITERAL}]: '1' }
      : request.env;
    child = spawn(wrapped, {
      cwd: request.cwd,
      env: childEnv,
      shell: true,
      stdio: ['inherit', 'inherit', 'pipe'],
    });
  }
  const stop = () => child?.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const result = await waitForTarget(child, {
    version: 1,
    state: 'applied',
    backend: request.observationBackend ?? 'unsupported',
    policyId: 'kodax-workspace-shell-v1',
  }, () => { targetStarted = true; });
  targetStarted = result.targetStarted;
  try { SandboxManager.cleanupAfterCommand(); } catch {}
  await SandboxManager.reset().catch(() => undefined);
  if (result.controlFailure) {
    process.stderr.write(result.controlFailure + '\n');
    process.exitCode = 125;
  } else {
    if (!targetStarted) {
      if (result.spawnFailedBeforeSpawn) {
        writeObservation({
          version: 1,
          state: 'not_started',
          diagnostic: result.diagnostic,
        });
      }
      process.stderr.write((result.diagnostic || 'Sandbox target launch could not be attested.') + '\n');
    }
    process.exitCode = targetStarted ? result.exitCode : result.spawnFailedBeforeSpawn ? 1 : 125;
  }
  }
} catch (error) {
  await SandboxManager?.reset().catch(() => undefined);
  if (!targetStarted && child === undefined) {
    try {
      writeObservation({
        version: 1,
        state: 'not_started',
        diagnostic: error instanceof Error ? error.message : String(error),
      });
    } catch {}
  }
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = targetStarted ? 125 : 1;
}
`;
let doctorPromise: Promise<SandboxRuntimeDoctorResult> | undefined;
let doctorExpiresAt = 0;
const SANDBOX_NOT_READY_RECHECK_MS = 30_000;

interface PreparedWindowsSandboxRunner {
  readonly path: string;
  readonly directory: string;
  readonly sha256: string;
  readonly developmentTrustRoots: readonly string[];
  readonly srtWin: ReturnType<typeof resolveSrtWin>;
}

let preparedWindowsRunnerPromise: Promise<PreparedWindowsSandboxRunner> | undefined;
let preparedWindowsRunner: PreparedWindowsSandboxRunner | undefined;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFileSystemError(error: unknown, ...codes: readonly string[]): boolean {
  return error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && codes.includes(error.code);
}

const SRT_WIN_ARCH_DIRECTORIES: Readonly<Record<string, string>> = { x64: 'x64', arm64: 'arm64' };

/**
 * Sidecar `srt-win.exe` shipped next to a bundled (Bun `--compile`) Windows
 * executable. The ASRT library's own lookup is module-relative, which inside
 * a Bun binary resolves onto the virtual `B:\` drive and can never exist.
 */
export function bundledSrtWinSidecarPath(execDir: string): string | undefined {
  const archDirectory = SRT_WIN_ARCH_DIRECTORIES[process.arch];
  if (archDirectory === undefined) return undefined;
  const sidecar = path.join(execDir, 'vendor', 'srt-win', archDirectory, 'srt-win.exe');
  return existsSync(sidecar) ? sidecar : undefined;
}

/**
 * Source path for staging the Windows sandbox runner. Bundled builds prefer
 * the sidecar next to the real executable — inside a Bun `--compile` binary
 * the library's module-relative lookup resolves onto the virtual `B:\` drive
 * and can never exist. Every layout still falls back to the library lookup so
 * mocked and development trees keep working. The parameter exists so tests
 * can point at a temporary layout.
 */
export function resolveSrtWinSourcePath(
  execDir: string = path.dirname(process.execPath),
): string {
  if (process.env.KODAX_BUNDLED === 'true') {
    const sidecar = bundledSrtWinSidecarPath(execDir);
    if (sidecar !== undefined) return sidecar;
  }
  return getSrtWinPath();
}

async function prepareWindowsSandboxRunner(
  untrustedWriteRoots: readonly string[] = [],
  provision = false,
): Promise<PreparedWindowsSandboxRunner> {
  if (preparedWindowsRunnerPromise === undefined) {
    const preparation = (async () => {
      const protectedRunner = resolveWindowsAsrtRunnerArtifact(
        import.meta.url,
        resolveSrtWinSourcePath(),
        KODAX_ASRT_VERSION,
        { untrustedWriteRoots, provision },
      );
      const directory = path.dirname(protectedRunner.path);
      await mkdir(windowsSandboxAclCoordinationDirectory(), { recursive: true, mode: 0o700 });
      const runner = {
        path: protectedRunner.path,
        directory,
        sha256: protectedRunner.sha256,
        developmentTrustRoots: protectedRunner.developmentTrustRoots,
        srtWin: resolveSrtWin({ path: protectedRunner.path }),
      };
      preparedWindowsRunner = runner;
      return runner;
    })();
    preparedWindowsRunnerPromise = preparation;
    void preparation.catch(() => {
      if (preparedWindowsRunnerPromise === preparation) {
        preparedWindowsRunnerPromise = undefined;
        preparedWindowsRunner = undefined;
      }
    });
  }
  const runner = await preparedWindowsRunnerPromise;
  assertWindowsAsrtRunnerTrustOutsideWriteRoots(
    runner.developmentTrustRoots,
    untrustedWriteRoots,
  );
  return runner;
}

function requirePreparedWindowsRunner(): PreparedWindowsSandboxRunner {
  if (process.platform !== 'win32') {
    throw new Error('A prepared Windows sandbox runner was requested on a non-Windows platform.');
  }
  if (preparedWindowsRunner === undefined) {
    throw new Error('Windows sandbox runner is not prepared; run the sandbox readiness check first.');
  }
  return preparedWindowsRunner;
}

interface WindowsSandboxAclPoisonOwner {
  readonly version: 1 | 2 | 3;
  readonly state?: 'active' | 'unconfirmed' | 'recovery_pending';
  readonly ticketId?: string;
  readonly policyKey?: string;
  readonly holderPid?: number;
  readonly holderProcessStartIdentity?: string;
  readonly pid?: number;
  readonly processStartIdentity?: string;
  readonly windowsBootIdentity?: string;
  readonly containment?: {
    readonly kind: 'windows-job';
    readonly jobName: string;
    readonly sandboxSid?: string;
    readonly supervisorPid: number;
    readonly supervisorProcessStartIdentity?: string;
  };
}

let cachedWindowsBootIdentity: string | null | undefined;
const WINDOWS_SANDBOX_ACL_RECOVERY_LOCK_TIMEOUT_MS = 35_000;
const WINDOWS_SANDBOX_ACL_CLEANUP_DIAGNOSTIC = '[acl_cleanup_unconfirmed]';

class WindowsSandboxAclAdmissionError extends Error {
  readonly recoveryAction?: 'automatic-retry';

  constructor(
    message: string,
    options?: ErrorOptions & {
      readonly recoveryAction?: 'automatic-retry';
    },
  ) {
    super(message, options);
    this.name = 'WindowsSandboxAclAdmissionError';
    this.recoveryAction = options?.recoveryAction;
  }
}

class UnreadableWindowsSandboxAclRecoveryTicketError extends WindowsSandboxAclAdmissionError {
  constructor(file: string, cause: unknown) {
    super(
      `Windows sandbox ACL recovery ticket is temporarily unreadable: ${file}. `
      + 'Sandbox admission will retry automatically; non-sandbox work remains available.',
      { cause, recoveryAction: 'automatic-retry' },
    );
    this.name = 'UnreadableWindowsSandboxAclRecoveryTicketError';
  }
}

function isCanonicalWindowsBootIdentity(value: string): boolean {
  return /^windows-boot-\d+$/.test(value);
}

function doctorHasWindowsSandboxAclCleanupBlock(
  doctor: SandboxRuntimeDoctorResult,
): boolean {
  return doctor.diagnostics.some(
    (candidate) => candidate.startsWith(WINDOWS_SANDBOX_ACL_CLEANUP_DIAGNOSTIC),
  );
}

function windowsSandboxAclPoisonDirectory(): string {
  const commonApplicationData = Object.entries(process.env).find(
    ([name, value]) => name.toUpperCase() === 'PROGRAMDATA' && value !== undefined,
  )?.[1] ?? 'C:\\ProgramData';
  return path.join(path.resolve(commonApplicationData), 'KodaX', 'sandbox-runtime', 'acl-poison');
}

function windowsSandboxAclCoordinationDirectory(): string {
  return path.dirname(windowsSandboxAclPoisonDirectory());
}

function legacyWindowsSandboxAclPoisonDirectory(configHome = getAgentConfigHome()): string {
  return path.join(path.resolve(configHome), 'sandbox-runtime', 'acl-poison');
}

function windowsSandboxV2SetupLockFile(): string {
  return path.join(windowsSandboxAclCoordinationDirectory(), 'windows-v2-setup.lock');
}

const WINDOWS_SANDBOX_V2_CUTOVER_DIAGNOSTIC = '[windows_v2_acl_cutover_required]';
const WINDOWS_LEGACY_ACL_STATE_IGNORED_DIAGNOSTIC = '[legacy_acl_state_ignored]';
const WINDOWS_SANDBOX_V2_CUTOVER_MARKER_MAX_BYTES = 4_096;
const WINDOWS_SANDBOX_V2_SETUP_VERSION = 8 as const;
const WINDOWS_LEGACY_ADMISSION_DRAIN_MS = KODAX_HARD_TIMEOUT * 1_000 + 1_000;

interface WindowsSandboxV2CutoverMarker {
  readonly version: typeof WINDOWS_SANDBOX_V2_SETUP_VERSION;
  readonly protocol: typeof WINDOWS_SANDBOX_V2_PROTOCOL;
  readonly generationNonce: string;
  readonly filesystemCapabilityNonce: string;
  readonly hostUserSid: string;
  readonly sandboxUserSid: string;
  readonly sandboxGroupSid: string;
}

type WindowsSandboxLegacyDrainMarker =
  | {
      readonly version: 1;
      readonly state: 'pending';
    }
  | {
      readonly version: 1;
      readonly state: 'draining';
      readonly deadlineUnixMs: number;
    };

let cachedWindowsSandboxV2HostUserSid: string | undefined;
let windowsSandboxV2CutoverDirectory = windowsNativeArtifactCacheRoot;
let waitForLegacyWindowsSandboxAdmissions = (delayMs: number) => new Promise<void>(
  (resolve) => setTimeout(resolve, delayMs),
);
let cachedWindowsSandboxV2Cutover: WindowsSandboxV2CutoverMarker | undefined;
const preparedWindowsShellArtifacts = new Map<
  string,
  Promise<ReturnType<typeof resolveWindowsSandboxV2Executable>>
>();
let preparedWindowsControlDirectoryPromise: Promise<string> | undefined;

function windowsSandboxV2HostUserSid(): string {
  if (cachedWindowsSandboxV2HostUserSid !== undefined) {
    return cachedWindowsSandboxV2HostUserSid;
  }
  const artifact = resolveWindowsSandboxV2Executable({ provision: false });
  const result = spawnSync(artifact.path, ['__current-user-sid'], {
    env: sanitizedEnvironment(),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 5_000,
  });
  const sid = result.status === 0 ? result.stdout.trim() : '';
  if (!/^S-\d+(?:-\d+)+$/i.test(sid)) {
    const reason = result.error?.message
      ?? (result.stderr.trim() || `exit ${String(result.status)}`);
    throw new Error(`cannot identify the Windows v2 setup owner SID: ${reason}`);
  }
  cachedWindowsSandboxV2HostUserSid = sid;
  return sid;
}

function windowsSandboxV2CutoverMarkerFile(): string {
  return path.join(windowsSandboxV2CutoverDirectory(), 'windows-v2-cutover.json');
}

function windowsSandboxLegacyDrainMarkerFile(): string {
  return path.join(windowsSandboxV2CutoverDirectory(), 'windows-v2-legacy-drain.json');
}

export function overrideWindowsSandboxV2CutoverDirectoryForTest(
  resolveDirectory: () => string,
): () => void {
  const previous = windowsSandboxV2CutoverDirectory;
  windowsSandboxV2CutoverDirectory = resolveDirectory;
  return () => {
    windowsSandboxV2CutoverDirectory = previous;
  };
}

export function overrideLegacyWindowsSandboxAdmissionDrainForTest(
  wait: (delayMs: number) => Promise<void>,
): () => void {
  const previous = waitForLegacyWindowsSandboxAdmissions;
  waitForLegacyWindowsSandboxAdmissions = wait;
  return () => {
    waitForLegacyWindowsSandboxAdmissions = previous;
  };
}

function parseWindowsSandboxV2CutoverMarker(text: string): WindowsSandboxV2CutoverMarker {
  if (Buffer.byteLength(text, 'utf8') > WINDOWS_SANDBOX_V2_CUTOVER_MARKER_MAX_BYTES) {
    throw new Error('the cutover marker exceeds its size bound');
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the cutover marker is not an object');
  }
  const marker = parsed as Readonly<Record<string, unknown>>;
  const keys = Object.keys(marker).sort();
  if (
    keys.join(',') !== 'filesystemCapabilityNonce,generationNonce,hostUserSid,protocol,sandboxGroupSid,sandboxUserSid,version'
    || marker.version !== WINDOWS_SANDBOX_V2_SETUP_VERSION
    || marker.protocol !== WINDOWS_SANDBOX_V2_PROTOCOL
    || typeof marker.generationNonce !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker.generationNonce)
    || typeof marker.filesystemCapabilityNonce !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker.filesystemCapabilityNonce)
    || typeof marker.hostUserSid !== 'string'
    || typeof marker.sandboxUserSid !== 'string'
    || typeof marker.sandboxGroupSid !== 'string'
    || !/^S-\d+(?:-\d+)+$/i.test(marker.hostUserSid)
    || !/^S-\d+(?:-\d+)+$/i.test(marker.sandboxUserSid)
    || !/^S-\d+(?:-\d+)+$/i.test(marker.sandboxGroupSid)
  ) {
    throw new Error('the cutover marker has an incompatible schema or SID');
  }
  return {
    version: WINDOWS_SANDBOX_V2_SETUP_VERSION,
    protocol: WINDOWS_SANDBOX_V2_PROTOCOL,
    generationNonce: marker.generationNonce,
    filesystemCapabilityNonce: marker.filesystemCapabilityNonce,
    hostUserSid: marker.hostUserSid,
    sandboxUserSid: marker.sandboxUserSid,
    sandboxGroupSid: marker.sandboxGroupSid,
  };
}

function readWindowsSandboxV2CutoverMarker(): WindowsSandboxV2CutoverMarker | undefined {
  const file = windowsSandboxV2CutoverMarkerFile();
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(file);
  } catch (error: unknown) {
    if (isFileSystemError(error, 'ENOENT')) return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error('the cutover marker is not a private regular file');
  }
  return parseWindowsSandboxV2CutoverMarker(readFileSync(file, 'utf8'));
}

function windowsSandboxV2CutoverError(reason: string): Error {
  return new Error(
    `${WINDOWS_SANDBOX_V2_CUTOVER_DIAGNOSTIC} ${reason}. `
    + 'Run "kodax sandbox setup" to rotate the legacy sandbox account SID and activate Windows v2.',
  );
}

function assertWindowsSandboxV2Cutover(
  user: ReturnType<typeof getWindowsSandboxUserStatus>,
): WindowsSandboxV2CutoverMarker {
  let marker: WindowsSandboxV2CutoverMarker | undefined;
  try {
    marker = readWindowsSandboxV2CutoverMarker();
  } catch (error: unknown) {
    throw windowsSandboxV2CutoverError(`The recorded migration state is invalid: ${errorText(error)}`);
  }
  if (marker === undefined) {
    throw windowsSandboxV2CutoverError('The sandbox account has not completed the Windows v2 ACL cutover');
  }
  if (user.sid !== marker.sandboxUserSid || user.groupSid !== marker.sandboxGroupSid) {
    throw windowsSandboxV2CutoverError('The installed sandbox account identity does not match the recorded v2 generation');
  }
  return marker;
}

function previousWindowsFilesystemCapabilityNonce(): string | undefined {
  const file = windowsSandboxV2CutoverMarkerFile();
  try {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const nonce = Reflect.get(parsed, 'filesystemCapabilityNonce');
    return typeof nonce === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)
      ? nonce.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

function currentWindowsSandboxV2Cutover(
  runner: PreparedWindowsSandboxRunner,
): WindowsSandboxV2CutoverMarker {
  let marker: WindowsSandboxV2CutoverMarker | undefined;
  try {
    marker = readWindowsSandboxV2CutoverMarker();
  } catch (error: unknown) {
    throw windowsSandboxV2CutoverError(`The recorded migration state is invalid: ${errorText(error)}`);
  }
  if (marker === undefined) {
    throw windowsSandboxV2CutoverError('The sandbox account has not completed the Windows v2 ACL cutover');
  }
  if (
    cachedWindowsSandboxV2Cutover !== undefined
    && JSON.stringify(cachedWindowsSandboxV2Cutover) === JSON.stringify(marker)
  ) {
    return cachedWindowsSandboxV2Cutover;
  }
  const verified = assertWindowsSandboxV2Cutover(
    getWindowsSandboxUserStatus({ srtWin: runner.srtWin }),
  );
  cachedWindowsSandboxV2Cutover = verified;
  return verified;
}

function prepareWindowsShellArtifact(
  sandboxReadSid: string,
  untrustedWriteRoots: readonly string[],
): Promise<ReturnType<typeof resolveWindowsSandboxV2Executable>> {
  let prepared = preparedWindowsShellArtifacts.get(sandboxReadSid);
  if (prepared === undefined) {
    prepared = Promise.resolve().then(() => resolveWindowsSandboxV2Executable({
      sandboxReadSid,
      provision: false,
    }));
    preparedWindowsShellArtifacts.set(sandboxReadSid, prepared);
    void prepared.catch(() => {
      if (preparedWindowsShellArtifacts.get(sandboxReadSid) === prepared) {
        preparedWindowsShellArtifacts.delete(sandboxReadSid);
      }
    });
  }
  assertWindowsNativeArtifactStoreNotDirectlyWritable(untrustedWriteRoots);
  return prepared.then((artifact) => {
    assertWindowsAsrtRunnerTrustOutsideWriteRoots(
      artifact.developmentTrustRoots,
      untrustedWriteRoots,
    );
    return artifact;
  });
}

function prepareWindowsControlDirectory(): Promise<string> {
  if (preparedWindowsControlDirectoryPromise === undefined) {
    const preparation = Promise.resolve().then(() => {
      const controlDirectory = windowsSandboxControlDirectory();
      const metadata = lstatSync(controlDirectory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('Protected native shell control state is not a regular directory.');
      }
      const canonicalRoot = realpathSync.native(windowsNativeArtifactCacheRoot());
      const canonicalControl = realpathSync.native(controlDirectory);
      if (!isInside(canonicalRoot, canonicalControl)) {
        throw new Error('Protected native shell control state escaped its cache root.');
      }
      return canonicalControl;
    });
    preparedWindowsControlDirectoryPromise = preparation;
    void preparation.catch(() => {
      if (preparedWindowsControlDirectoryPromise === preparation) {
        preparedWindowsControlDirectoryPromise = undefined;
      }
    });
  }
  return preparedWindowsControlDirectoryPromise;
}

function writePrivateJsonFile(file: string, value: object): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    let offset = 0;
    while (offset < payload.length) {
      const written = writeSync(descriptor, payload, offset, payload.length - offset);
      if (written === 0) throw new Error('Windows sandbox private-state write made no progress.');
      offset += written;
    }
    fsyncSync(descriptor);
    const completedDescriptor = descriptor;
    descriptor = undefined;
    closeSync(completedDescriptor);
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

async function removeWindowsSandboxCutoverMarkerForSetup(file: string): Promise<void> {
  const deadline = Date.now() + WINDOWS_V2_LAUNCH_TIMEOUT_MS;
  while (true) {
    try {
      rmSync(file, { force: true });
      return;
    } catch (error: unknown) {
      if (
        !isFileSystemError(error, 'EACCES', 'EBUSY', 'EPERM')
        || Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}

function writeWindowsSandboxV2CutoverMarker(
  marker: WindowsSandboxV2CutoverMarker,
): void {
  writePrivateJsonFile(windowsSandboxV2CutoverMarkerFile(), marker);
}

function readWindowsSandboxLegacyDrainMarker(): WindowsSandboxLegacyDrainMarker | undefined {
  const file = windowsSandboxLegacyDrainMarkerFile();
  if (!existsSync(file)) return undefined;
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('the legacy admission drain marker is not a regular file');
  }
  if (metadata.size > WINDOWS_SANDBOX_V2_CUTOVER_MARKER_MAX_BYTES) {
    throw new Error('the legacy admission drain marker exceeds its size bound');
  }
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the legacy admission drain marker is not an object');
  }
  const marker = parsed as Readonly<Record<string, unknown>>;
  const keys = Object.keys(marker).sort().join(',');
  if (marker.state === 'pending') {
    if (keys !== 'state,version' || marker.version !== 1) {
      throw new Error('the legacy admission drain marker has an incompatible schema');
    }
    return { version: 1, state: 'pending' };
  }
  if (
    keys !== 'deadlineUnixMs,state,version'
    || marker.state !== 'draining'
    || typeof marker.deadlineUnixMs !== 'number'
    || !Number.isSafeInteger(marker.deadlineUnixMs)
    || marker.deadlineUnixMs <= 0
  ) {
    throw new Error('the legacy admission drain marker has an incompatible schema');
  }
  return { version: 1, state: 'draining', deadlineUnixMs: marker.deadlineUnixMs };
}

async function invalidateWindowsSandboxV2CutoverForSetup(): Promise<void> {
  cachedWindowsSandboxV2Cutover = undefined;
  await removeWindowsSandboxCutoverMarkerForSetup(windowsSandboxV2CutoverMarkerFile());
}

async function invalidateLegacyWindowsSandboxCutoverForSetup(): Promise<number> {
  const file = path.join(windowsSandboxAclCoordinationDirectory(), 'windows-v2-cutover.json');
  const drainFile = windowsSandboxLegacyDrainMarkerFile();
  let marker = readWindowsSandboxLegacyDrainMarker();
  const legacyMarkerExists = existsSync(file);
  if (!legacyMarkerExists && marker === undefined) return 0;
  if (legacyMarkerExists) {
    writePrivateJsonFile(drainFile, { version: 1, state: 'pending' });
    marker = { version: 1, state: 'pending' };
  }
  await removeWindowsSandboxCutoverMarkerForSetup(file);
  if (marker?.state === 'pending') {
    marker = {
      version: 1,
      state: 'draining',
      deadlineUnixMs: Date.now() + WINDOWS_LEGACY_ADMISSION_DRAIN_MS,
    };
    writePrivateJsonFile(drainFile, marker);
  }
  if (marker?.state !== 'draining') return 0;
  return Math.max(0, Math.min(
    marker.deadlineUnixMs - Date.now(),
    WINDOWS_LEGACY_ADMISSION_DRAIN_MS,
  ));
}

function recoverWindowsV2ExecutionDeniesForSetup(): void {
  const executable = resolveWindowsSandboxV2Executable({ provision: true }).path;
  const result = spawnSync(
    executable,
    ['__recover-execution-denies', windowsSandboxControlDirectory()],
    {
      env: sanitizedEnvironment(),
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 15 * 60_000,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    const reason = result.error?.message
      ?? (result.stderr.trim() || `exit ${String(result.status)}`);
    throw new Error(`Windows v2 denyRead setup recovery failed: ${reason}`);
  }
}

function parseWindowsSandboxAclPoisonOwner(text: string): WindowsSandboxAclPoisonOwner {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== 'object' || value === null) {
    throw new Error('Windows sandbox ACL poison marker is not an object.');
  }
  const owner = value as Readonly<Record<string, unknown>>;
  if (
    (owner.version !== 1 && owner.version !== 2 && owner.version !== 3)
    || (
      owner.state !== undefined
      && owner.state !== 'active'
      && owner.state !== 'unconfirmed'
      && owner.state !== 'recovery_pending'
    )
    || (owner.ticketId !== undefined && (
      typeof owner.ticketId !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(owner.ticketId)
    ))
    || (owner.policyKey !== undefined && typeof owner.policyKey !== 'string')
    || (owner.holderPid !== undefined && (
      typeof owner.holderPid !== 'number'
      || !Number.isSafeInteger(owner.holderPid)
      || owner.holderPid <= 0
    ))
    || (
      owner.holderProcessStartIdentity !== undefined
      && typeof owner.holderProcessStartIdentity !== 'string'
    )
    || (owner.pid !== undefined && (
      typeof owner.pid !== 'number'
      || !Number.isSafeInteger(owner.pid)
      || owner.pid <= 0
    ))
    || (
      owner.processStartIdentity !== undefined
      && typeof owner.processStartIdentity !== 'string'
    )
    || (
      owner.windowsBootIdentity !== undefined
      && (
        typeof owner.windowsBootIdentity !== 'string'
        || !isCanonicalWindowsBootIdentity(owner.windowsBootIdentity)
      )
    )
    || (owner.containment !== undefined && (
      typeof owner.containment !== 'object'
      || owner.containment === null
      || (owner.containment as Readonly<Record<string, unknown>>).kind !== 'windows-job'
      || typeof (owner.containment as Readonly<Record<string, unknown>>).jobName !== 'string'
      || !/^(?:Global\\)?KodaXEffect-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        String((owner.containment as Readonly<Record<string, unknown>>).jobName),
      )
      || (
        (owner.containment as Readonly<Record<string, unknown>>).sandboxSid !== undefined
        && (
          typeof (owner.containment as Readonly<Record<string, unknown>>).sandboxSid !== 'string'
          || !/^S-1-(?:\d+-)+\d+$/i.test(
            String((owner.containment as Readonly<Record<string, unknown>>).sandboxSid),
          )
        )
      )
      || typeof (owner.containment as Readonly<Record<string, unknown>>).supervisorPid !== 'number'
      || !Number.isSafeInteger(
        (owner.containment as Readonly<Record<string, unknown>>).supervisorPid,
      )
      || Number((owner.containment as Readonly<Record<string, unknown>>).supervisorPid) <= 0
      || (
        (owner.containment as Readonly<Record<string, unknown>>).supervisorProcessStartIdentity !== undefined
        && typeof (owner.containment as Readonly<Record<string, unknown>>).supervisorProcessStartIdentity !== 'string'
      )
    ))
  ) {
    throw new Error('Windows sandbox ACL poison marker has an invalid owner identity.');
  }
  return {
    version: owner.version,
    ...(
      owner.state === 'active'
      || owner.state === 'unconfirmed'
      || owner.state === 'recovery_pending'
      ? { state: owner.state }
      : {}),
    ...(typeof owner.ticketId === 'string' ? { ticketId: owner.ticketId } : {}),
    ...(typeof owner.policyKey === 'string' ? { policyKey: owner.policyKey } : {}),
    ...(typeof owner.holderPid === 'number' ? { holderPid: owner.holderPid } : {}),
    ...(typeof owner.holderProcessStartIdentity === 'string'
      ? { holderProcessStartIdentity: owner.holderProcessStartIdentity }
      : {}),
    ...(typeof owner.pid === 'number' ? { pid: owner.pid } : {}),
    ...(typeof owner.processStartIdentity === 'string'
      ? { processStartIdentity: owner.processStartIdentity }
      : {}),
    ...(typeof owner.windowsBootIdentity === 'string'
      ? { windowsBootIdentity: owner.windowsBootIdentity }
      : {}),
    ...(owner.containment === undefined ? {} : {
      containment: {
        kind: 'windows-job' as const,
        jobName: String((owner.containment as Readonly<Record<string, unknown>>).jobName),
        ...(typeof (owner.containment as Readonly<Record<string, unknown>>).sandboxSid === 'string'
          ? { sandboxSid: String((owner.containment as Readonly<Record<string, unknown>>).sandboxSid) }
          : {}),
        supervisorPid: Number(
          (owner.containment as Readonly<Record<string, unknown>>).supervisorPid,
        ),
        ...(typeof (owner.containment as Readonly<Record<string, unknown>>).supervisorProcessStartIdentity === 'string'
          ? {
              supervisorProcessStartIdentity: String(
                (owner.containment as Readonly<Record<string, unknown>>).supervisorProcessStartIdentity,
              ),
            }
          : {}),
      },
    }),
  };
}

function listWindowsSandboxAclPoisonFiles(configHome = getAgentConfigHome()): string[] {
  const directories = [...new Set([
    windowsSandboxAclPoisonDirectory(),
    legacyWindowsSandboxAclPoisonDirectory(configHome),
  ])];
  return directories.flatMap((directory) => {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (error: unknown) {
      if (isFileSystemError(error, 'ENOENT')) return [];
      throw error;
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(directory, name));
  });
}

function readWindowsSandboxAclPoisonOwners(configHome = getAgentConfigHome()): Array<{
  readonly file: string;
  readonly owner: WindowsSandboxAclPoisonOwner;
}> {
  return listWindowsSandboxAclPoisonFiles(configHome).map((file) => {
    try {
      const markerStat = lstatSync(file);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
        throw new Error('Windows sandbox ACL poison marker is not a regular file.');
      }
      const owner = parseWindowsSandboxAclPoisonOwner(readFileSync(file, 'utf8'));
      return {
        file,
        owner: path.basename(file).startsWith('unconfirmed-')
          ? { ...owner, state: 'unconfirmed' }
          : path.basename(file).startsWith('recovery-')
            ? { ...owner, state: 'recovery_pending' }
            : owner,
      };
    } catch (error: unknown) {
      throw new UnreadableWindowsSandboxAclRecoveryTicketError(file, error);
    }
  });
}

function windowsAclPowerShellExecutable(): string {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pwsh = path.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
  if (existsSync(pwsh)) return pwsh;
  return path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function readWindowsBootIdentity(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  if (cachedWindowsBootIdentity !== undefined) {
    return cachedWindowsBootIdentity ?? undefined;
  }
  const script = String.raw`
# KodaXWindowsBootIdentity-v1
$boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime
[Console]::Out.Write($boot.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture))
`;
  const result = spawnSync(
    windowsAclPowerShellExecutable(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    },
  );
  const ticks = result.status === 0 ? result.stdout.trim() : '';
  const identity = /^\d+$/.test(ticks) ? `windows-boot-${ticks}` : undefined;
  cachedWindowsBootIdentity = identity ?? null;
  return identity;
}

/** @internal Runtime lifecycle proof; not a general sandbox recovery surface. */
export function readWindowsSandboxBootIdentity(): string | undefined {
  return readWindowsBootIdentity();
}

function persistentWindowsSandboxAclPoisonError(
  owners: readonly WindowsSandboxAclPoisonOwner[],
  currentBootIdentity = readWindowsBootIdentity(),
): Error {
  const unverifiable = owners.find(({ windowsBootIdentity }) => (
    windowsBootIdentity === undefined || currentBootIdentity === undefined
  ));
  if (unverifiable !== undefined) {
    return new WindowsSandboxAclAdmissionError(
      'A legacy Windows sandbox recovery ticket has no verifiable boot identity. '
      + 'Sandbox admission will retry recovery automatically without blocking non-sandbox work.',
      { recoveryAction: 'automatic-retry' },
    );
  }
  const owner = owners[0];
  const detail = owner?.pid === undefined ? '' : ` (last root PID ${owner.pid})`;
  return new WindowsSandboxAclAdmissionError(
    `A legacy Windows sandbox recovery ticket${detail} from the current Windows boot `
    + 'does not contain safe process-containment proof. Sandbox admission will retry recovery '
    + 'automatically without blocking non-sandbox work.',
    { recoveryAction: 'automatic-retry' },
  );
}

type WindowsSandboxAclOwnerLiveness = 'live' | 'stale' | 'unknown';

function windowsSandboxAclOwnerLiveness(
  owner: WindowsSandboxAclPoisonOwner,
): WindowsSandboxAclOwnerLiveness {
  if (
    owner.holderPid === undefined
    || owner.holderProcessStartIdentity === undefined
  ) return 'stale';
  const identity = readProcessStartIdentity(owner.holderPid);
  if (identity !== undefined) {
    return identity === owner.holderProcessStartIdentity ? 'live' : 'stale';
  }
  try {
    process.kill(owner.holderPid, 0);
    return 'unknown';
  } catch (error: unknown) {
    return isFileSystemError(error, 'ESRCH') ? 'stale' : 'unknown';
  }
}

async function windowsSandboxSidIsIdle(expectedSid: string): Promise<boolean> {
  try {
    const runner = requirePreparedWindowsRunner();
    const status = getWindowsSandboxUserStatus({ srtWin: runner.srtWin });
    if (status.sid !== undefined && status.sid !== expectedSid) return false;
    return !(await windowsSandboxSidHasOtherProcesses(expectedSid, {
      executable: runner.srtWin.exe,
      prependArgs: runner.srtWin.prependArgs,
    }));
  } catch (error: unknown) {
    emitKodaXDiagnostic({
      source: 'runtime:sandbox-setup',
      level: 'warn',
      message: 'Windows sandbox account process inspection failed; account rotation remains blocked.',
      detail: error,
    });
    return false;
  }
}

async function recoverWindowsSandboxAcls(timeoutMs = 30_000): Promise<void> {
  const runner = requirePreparedWindowsRunner();
  const launch = await prepareWindowsGatedLaunch({
    command: runner.srtWin.exe,
    args: [...runner.srtWin.prependArgs, 'acl', 'recover', '--json'],
    env: sanitizedEnvironment(),
    cwd: runner.directory,
    controlPipe: false,
  }, await sandboxControlDirectory());
  let child: ReturnType<typeof spawn> | undefined;
  let effectJob: WindowsEffectJob | undefined;
  let recoveryStartAttempted = false;
  let result: SandboxProcessResult;
  try {
    child = spawn(launch.command, [...launch.args], {
      cwd: runner.directory,
      env: launch.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    rememberChildProcessTree(child);
    if (child.pid === undefined) throw new Error('Windows ACL recovery gate did not expose a PID.');
    const collected = collectProcess(
      child,
      undefined,
      Math.max(1, Math.min(30_000, timeoutMs)),
      1024 * 1024,
      true,
    );
    void collected.catch(() => undefined);
    effectJob = await containWindowsEffectProcess(child.pid);
    recoveryStartAttempted = true;
    await writeSandboxGate(child, true);
    result = await collected;
    await effectJob.drained;
  } catch (error: unknown) {
    const failures: unknown[] = [error];
    if (child !== undefined) {
      try {
        if (!recoveryStartAttempted) await closeSandboxGate(child);
        if (effectJob !== undefined) {
          await terminateWindowsEffectJob(effectJob.jobName);
          await effectJob.drained;
        } else {
          await killChildProcessTree(child);
        }
      } catch (cleanupError: unknown) {
        failures.push(cleanupError);
      }
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, 'Windows sandbox ACL recovery helper cleanup failed.');
  } finally {
    await rm(launch.gateFile, { force: true });
  }
  const stderr = result.stderr.trim();
  let output: unknown;
  try {
    output = JSON.parse(result.stdout.trim()) as unknown;
  } catch (error: unknown) {
    throw new Error(
      `Windows sandbox ACL recovery failed with unparseable output `
      + `(exit ${String(result.exitCode)}): ${stderr || '(empty stderr)'}.`,
      { cause: error },
    );
  }
  const recovery = typeof output === 'object' && output !== null
    ? output as Readonly<Record<string, unknown>>
    : undefined;
  if (
    result.exitCode !== 0
    || typeof recovery?.deadBrokers !== 'number'
    || !Number.isSafeInteger(recovery.deadBrokers)
    || recovery.deadBrokers < 0
    || typeof recovery.acesRevoked !== 'number'
    || !Number.isSafeInteger(recovery.acesRevoked)
    || recovery.acesRevoked < 0
  ) {
    throw new Error(
      `Windows sandbox ACL recovery failed (exit ${String(result.exitCode)}): `
      + `${stderr || '(empty stderr)'}.`,
    );
  }
}

interface WindowsSandboxAclPoisonEntry {
  readonly file: string;
  readonly owner: WindowsSandboxAclPoisonOwner;
}

function windowsSandboxAclPoisonSnapshotError(
  poisoned: ReadonlyArray<WindowsSandboxAclPoisonEntry>,
  currentBootIdentity = readWindowsBootIdentity(),
): Error {
  return persistentWindowsSandboxAclPoisonError(
    poisoned.map(({ owner }) => owner),
    currentBootIdentity,
  );
}

async function windowsSandboxAclSetupBlockWithLock(): Promise<Error | undefined> {
  const owners = readWindowsSandboxAclPoisonOwners();
  if (owners.length === 0) return undefined;
  const currentBootIdentity = readWindowsBootIdentity();
  const allFromEarlierBoot = currentBootIdentity !== undefined
    && owners.every(({ owner }) => (
      owner.windowsBootIdentity !== undefined
      && owner.windowsBootIdentity !== currentBootIdentity
  ));
  if (allFromEarlierBoot) {
    await recoverWindowsSandboxAcls();
    for (const marker of owners) rmSync(marker.file, { force: true });
    if (readWindowsSandboxAclPoisonOwners().length > 0) {
      throw new Error('Legacy Windows sandbox recovery tickets remained after ACL recovery.');
    }
    return undefined;
  }
  if (owners.every(({ owner }) => windowsSandboxAclOwnerLiveness(owner) !== 'stale')) {
    return new WindowsSandboxAclAdmissionError(
      'Windows sandbox setup cannot run while a sandbox owner is active for the shared Windows sandbox account; '
      + 'recovery is waiting and will retry automatically; non-sandbox work remains available.',
      { recoveryAction: 'automatic-retry' },
    );
  }
  return windowsSandboxAclPoisonSnapshotError(owners, currentBootIdentity);
}

function withWindowsSandboxAclSetupBlock(
  doctor: SandboxRuntimeDoctorResult,
  error: Error,
): SandboxRuntimeDoctorResult {
  return {
    ...doctor,
    ready: false,
    diagnostics: [
      ...doctor.diagnostics.filter(
        (diagnostic) => !diagnostic.startsWith(WINDOWS_SANDBOX_ACL_CLEANUP_DIAGNOSTIC),
      ),
      `${WINDOWS_SANDBOX_ACL_CLEANUP_DIAGNOSTIC} ${error.message}`,
    ],
  };
}

async function bindWindowsWfpProbe(): Promise<{
  readonly server: ReturnType<typeof createServer>;
  readonly target: string;
}> {
  const [low, high] = DEFAULT_WINDOWS_PROXY_PORT_RANGE;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (typeof address === 'object' && address !== null && (address.port < low || address.port > high)) {
      return { server, target: `127.0.0.1:${address.port}` };
    }
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  throw new Error(
    `[wfp_probe_bind_failed] Could not bind a loopback listener outside `
    + `the Windows sandbox proxy range [${low},${high}].`,
  );
}

function windowsRunnerFailureCode(stderr: string): string {
  if (/0x80070005|access (?:is )?denied|拒绝访问/i.test(stderr)) {
    return 'runner_launch_access_denied';
  }
  if (/seclogon|secondary logon/i.test(stderr)) return 'secondary_logon_unavailable';
  return 'wfp_probe_failed';
}

function windowsRunnerSpawnFailureCode(error: Error): string {
  if (isFileSystemError(error, 'ETIMEDOUT')) return 'wfp_probe_timeout';
  if (isFileSystemError(error, 'EACCES', 'EPERM')) return 'runner_launch_access_denied';
  return 'runner_spawn_failed';
}

async function verifyPreparedWindowsWfp(
  runner: PreparedWindowsSandboxRunner,
): Promise<void> {
  const { server, target } = await bindWindowsWfpProbe();
  try {
    const result = spawnSync(
      runner.srtWin.exe,
      [...runner.srtWin.prependArgs, 'wfp', 'verify', '--target', target],
      {
        cwd: runner.directory,
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const stderr = (result.stderr ?? '').trim();
    if (result.error) {
      throw new Error(
        `[${windowsRunnerSpawnFailureCode(result.error)}] `
        + `Windows sandbox runner failed to start: ${result.error.message}`,
      );
    }
    let output: Readonly<Record<string, unknown>>;
    try {
      output = JSON.parse((result.stdout ?? '').trim()) as Readonly<Record<string, unknown>>;
    } catch {
      const code = result.status === null
        ? 'wfp_probe_timeout'
        : windowsRunnerFailureCode(stderr);
      throw new Error(
        `[${code}] Windows sandbox WFP probe exited ${String(result.status)}`
        + `${result.signal ? ` (signal ${result.signal})` : ''}`
        + ` with unparseable output; stderr: ${stderr || '(empty)'}.`,
      );
    }
    if (result.status === 3) {
      throw new Error(
        `[wfp_fence_inactive] Direct outbound access to ${String(output.target ?? target)} succeeded. `
        + 'Run "kodax sandbox setup" to reinstall the Windows network policy.',
      );
    }
    if (result.status !== 0 || output.egress_probe !== 'blocked') {
      throw new Error(
        `[${windowsRunnerFailureCode(stderr)}] Windows sandbox WFP probe to `
        + `${String(output.target ?? target)} was ${String(output.egress_probe)} `
        + `(exit ${String(result.status)}): ${stderr || '(empty stderr)'}.`,
      );
    }
  } finally {
    server.close();
  }
}

function windowsSandboxAccountDiagnostics(
  user: ReturnType<typeof getWindowsSandboxUserStatus>,
): string[] {
  const diagnostics: string[] = [];
  if (!user.provisioned) diagnostics.push('Windows sandbox account does not exist.');
  if (!user.sid) diagnostics.push('Windows sandbox account SID is unavailable.');
  if (!user.groupExists || !user.groupSid) diagnostics.push('Windows sandbox local group is unavailable.');
  if (!user.inBuiltinUsers) diagnostics.push('Windows sandbox account is not in the built-in Users group.');
  if (!user.inSandboxGroup) diagnostics.push('Windows sandbox account is not in the sandbox-runtime-users group.');
  if (!user.hiddenFromLogon) diagnostics.push('Windows sandbox account is not hidden from interactive logon.');
  if (!user.credPresent) diagnostics.push('Windows sandbox account credential is unavailable.');
  return diagnostics;
}

function parseBrokerObservation(
  text: string,
): KodaXShellSandboxObservation | undefined {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== 'object' || value === null) return undefined;
  const observation = value as Readonly<Record<string, unknown>>;
  if (observation.version !== 1) return undefined;
  if (
    observation.state === 'applied'
    && observation.policyId === 'kodax-workspace-shell-v1'
    && (
      observation.backend === 'windows-restricted-user'
      || observation.backend === 'macos-seatbelt'
      || observation.backend === 'linux-bubblewrap'
      || observation.backend === 'unsupported'
    )
  ) {
    return observation as KodaXShellSandboxObservation;
  }
  if (
    observation.state === 'fallback'
    && observation.reason === 'backend_failed'
    && observation.execution === 'normal_permission_policy'
  ) {
    return observation as KodaXShellSandboxObservation;
  }
  return undefined;
}

function encodeControlledBrokerRequest(
  request: SandboxBrokerRequest,
): {
  readonly invocationId: string;
  readonly payload: Uint8Array;
  readonly request: SandboxBrokerRequest;
} {
  const invocationId = randomUUID();
  const controlled = { ...request, controlInvocationId: invocationId };
  const payload = Buffer.from(JSON.stringify(controlled), 'utf8');
  if (payload.byteLength > SANDBOX_BROKER_REQUEST_MAX_BYTES) {
    throw new Error(
      `Sandbox broker request exceeded ${SANDBOX_BROKER_REQUEST_MAX_BYTES} bytes.`,
    );
  }
  return { invocationId, payload, request: controlled };
}

function parseSandboxBrokerControl(
  bytes: Uint8Array,
  invocationId: string,
  expectedBackend: KodaXShellSandboxBackend,
): SandboxBrokerControlObservation | undefined {
  if (bytes.byteLength === 0) return undefined;
  if (bytes.byteLength > SANDBOX_BROKER_CONTROL_MAX_BYTES) {
    throw new Error('Sandbox broker control frame exceeded its byte limit.');
  }
  const payload = Buffer.from(bytes);
  const newline = payload.indexOf(0x0a);
  if (newline < 0 || payload.subarray(newline + 1).some((byte) => byte > 0x20)) {
    throw new Error('Sandbox broker control channel returned an invalid frame boundary.');
  }
  const value = JSON.parse(payload.subarray(0, newline).toString('utf8')) as unknown;
  if (typeof value !== 'object' || value === null) {
    throw new Error('Sandbox broker control channel returned a non-object frame.');
  }
  const frame = value as Readonly<Record<string, unknown>>;
  if (
    frame.version !== 1
    || frame.invocationId !== invocationId
    || typeof frame.observation !== 'object'
    || frame.observation === null
  ) {
    throw new Error('Sandbox broker control frame did not match this invocation.');
  }
  const observation = frame.observation as Readonly<Record<string, unknown>>;
  if (observation.version !== 1) {
    throw new Error('Sandbox broker control observation has an incompatible version.');
  }
  if (observation.state === 'not_started') {
    if (
      observation.diagnostic !== undefined
      && typeof observation.diagnostic !== 'string'
    ) {
      throw new Error('Sandbox broker pre-target diagnostic is invalid.');
    }
    return observation as SandboxBrokerControlObservation;
  }
  const parsed = parseBrokerObservation(JSON.stringify(observation));
  if (parsed === undefined) {
    throw new Error('Sandbox broker control observation is invalid.');
  }
  if (parsed.state === 'applied' && parsed.backend !== expectedBackend) {
    throw new Error('Sandbox broker control observation reported the wrong backend.');
  }
  return parsed;
}

function collectSandboxBrokerControl(
  child: ReturnType<typeof spawn>,
): Promise<Uint8Array> {
  const control = child.stdio[3];
  if (control === null || control === undefined) {
    return Promise.reject(new Error('Sandbox broker control pipe was not created.'));
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolve(Buffer.concat(chunks));
      else reject(error);
    };
    control.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > SANDBOX_BROKER_CONTROL_MAX_BYTES) {
        finish(new Error('Sandbox broker control frame exceeded its byte limit.'));
        control.destroy();
        return;
      }
      chunks.push(chunk);
    });
    control.once('error', finish);
    control.once('end', () => finish());
  });
}

function sandboxJavaScriptCommand(): string {
  if (process.env.KODAX_A2A_NODE !== undefined) return process.env.KODAX_A2A_NODE;
  if (process.versions.electron !== undefined) return process.execPath;
  return process.env.KODAX_BUNDLED === 'true' ? 'node' : process.execPath;
}

export async function doctorSandboxRuntime(options: { readonly refresh?: boolean } = {}): Promise<SandboxRuntimeDoctorResult> {
  if (
    options.refresh
    || doctorPromise === undefined
    || Date.now() >= doctorExpiresAt
  ) {
    const probe = inspectSandboxRuntime();
    doctorPromise = probe;
    doctorExpiresAt = Number.POSITIVE_INFINITY;
    void probe.then(
      (result) => {
        if (doctorPromise !== probe) return;
        doctorExpiresAt = result.ready
          ? Number.POSITIVE_INFINITY
          : Date.now() + SANDBOX_NOT_READY_RECHECK_MS;
      },
      () => {
        if (doctorPromise !== probe) return;
        doctorPromise = undefined;
        doctorExpiresAt = 0;
      },
    );
  }
  return doctorPromise;
}

async function inspectSandboxRuntime(): Promise<SandboxRuntimeDoctorResult> {
  const diagnostics: string[] = [];
  if (!SandboxManager.isSupportedPlatform()) diagnostics.push(`Unsupported platform: ${process.platform}.`);
  // ASRT's Windows dependency probe resolves its vendor executable before
  // KodaX can stage that executable outside Electron ASAR. The staged-runner
  // account and WFP checks below are the authoritative Windows readiness test.
  const dependencies = process.platform === 'win32'
    ? { errors: [], warnings: [] }
    : SandboxManager.checkDependencies();
  diagnostics.push(...dependencies.warnings, ...dependencies.errors);
  let setupRequired = dependencies.errors.length > 0;
  if (process.env.KODAX_BUNDLED !== 'true') {
    try {
      const manifest = JSON.parse(
        await readFile(moduleRequire.resolve('@anthropic-ai/sandbox-runtime/package.json'), 'utf8'),
      ) as { readonly version?: unknown };
      if (manifest.version !== KODAX_ASRT_VERSION) {
        setupRequired = true;
        diagnostics.push(`ASRT package version mismatch: expected ${KODAX_ASRT_VERSION}, found ${String(manifest.version)}.`);
      }
    } catch (error: unknown) {
      setupRequired = true;
      diagnostics.push(`ASRT package provenance check failed: ${errorText(error)}`);
    }
  }
  const nodeCommand = sandboxJavaScriptCommand();
  const nodeProbeLaunch = prepareInternalNodeLaunch({
    args: ['--version'],
    env: sanitizedEnvironment(),
    isElectron: nodeCommand === process.execPath && process.versions.electron !== undefined,
  });
  const nodeProbe = spawnSync(nodeCommand, nodeProbeLaunch.args, {
    env: nodeProbeLaunch.env, shell: false, encoding: 'utf8', windowsHide: true, timeout: 5_000,
  });
  if (nodeProbe.status !== 0) {
    setupRequired = true;
    const reason = nodeProbe.error?.message ?? (nodeProbe.stderr.trim() || nodeCommand);
    diagnostics.push(`JavaScript Skill interpreter is unavailable: ${reason}.`);
  }
  if (process.platform === 'win32') {
    try {
      const runner = await prepareWindowsSandboxRunner();
      const user = getWindowsSandboxUserStatus({ srtWin: runner.srtWin });
      const accountDiagnostics = windowsSandboxAccountDiagnostics(user);
      if (accountDiagnostics.length > 0 || !user.sid || !user.groupSid) {
        setupRequired = true;
        diagnostics.push(...accountDiagnostics);
      } else {
        resolveWindowsSandboxV2Executable({
          sandboxReadSid: user.groupSid,
          provision: false,
        });
        verifyWindowsSandboxControlDirectory();
        try {
          cachedWindowsSandboxV2Cutover = assertWindowsSandboxV2Cutover(user);
          verifyWindowsV2AccountCompatibility(user.sid);
          await verifyPreparedWindowsWfp(runner);
        } catch (error: unknown) {
          setupRequired = true;
          diagnostics.push(errorText(error));
        }
      }
    } catch (error: unknown) {
      setupRequired = true;
      diagnostics.push(errorText(error));
    }
    const legacyTickets = listWindowsSandboxAclPoisonFiles();
    if (legacyTickets.length > 0) {
      diagnostics.push(
        `${WINDOWS_LEGACY_ACL_STATE_IGNORED_DIAGNOSTIC} ${legacyTickets.length} pre-v2 ACL recovery record(s) `
        + 'remain for migration diagnosis; Windows v2 shell admission does not read them.',
      );
    }
  }
  return {
    ready: SandboxManager.isSupportedPlatform() && !setupRequired,
    platform: process.platform,
    version: KODAX_ASRT_VERSION,
    diagnostics,
    setupRequired,
  };
}

const INSTALL_WINDOWS_SETUP_CAPABILITIES = String.raw`
$ErrorActionPreference = 'Stop'
$process = Start-Process -FilePath $env:KODAX_NATIVE_SETUP_EXE -ArgumentList @('__setup-account-capabilities', $env:KODAX_NATIVE_SETUP_ENVELOPE) -Verb RunAs -Wait -PassThru -WindowStyle Hidden
exit $process.ExitCode
`;

interface WindowsSetupCapabilityRequest {
  readonly version: 1;
  readonly sandboxSid: string;
  readonly sandboxGroupSid: string;
  readonly filesystemCapabilityNonce: string;
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
}

type WindowsSetupCapabilityInstaller = (
  executable: string,
  request: WindowsSetupCapabilityRequest,
) => void;

const installWindowsSetupCapabilities: WindowsSetupCapabilityInstaller = (executable, request) => {
  if (
    !/^S-1-5-21(?:-\d+)+$/i.test(request.sandboxSid)
    || !/^S-1-5-21(?:-\d+)+$/i.test(request.sandboxGroupSid)
    || request.sandboxSid.toLowerCase() === request.sandboxGroupSid.toLowerCase()
  ) {
    throw new Error('Windows sandbox account authority is invalid for capability setup.');
  }
  if (request.readRoots.length + request.writeRoots.length > 1_024) {
    throw new Error('Windows sandbox setup capability request exceeds 1024 roots.');
  }
  const controlDirectory = verifyWindowsSandboxControlDirectory();
  const requestFile = path.join(
    controlDirectory,
    `windows-setup-${process.pid}-${randomUUID()}.json`,
  );
  const payload = Buffer.from(JSON.stringify(request), 'utf8');
  if (payload.byteLength > 1024 * 1024) {
    throw new Error('Windows sandbox setup capability request exceeds 1 MiB.');
  }
  const requestSha256 = createHash('sha256').update(payload).digest('hex');
  const envelope = Buffer.from(JSON.stringify({
    version: 1,
    requestPath: requestFile,
    sha256: requestSha256,
  }), 'utf8').toString('base64');
  writeFileSync(requestFile, payload, { flag: 'wx', mode: 0o600 });
  const powershell = path.join(
    process.env.SystemRoot ?? String.raw`C:\Windows`,
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  try {
    const result = spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(INSTALL_WINDOWS_SETUP_CAPABILITIES, 'utf16le').toString('base64'),
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        KODAX_NATIVE_SETUP_EXE: executable,
        KODAX_NATIVE_SETUP_ENVELOPE: envelope,
      },
      shell: false,
      windowsHide: true,
    });
    if (result.error !== undefined || result.status !== 0) {
      const reason = result.error?.message ?? (result.stderr.trim() || `exit ${String(result.status)}`);
      throw new Error(`Windows sandbox account capability setup failed: ${reason}`);
    }
  } finally {
    rmSync(requestFile, { force: true });
  }
};

let windowsSetupCapabilityInstaller: WindowsSetupCapabilityInstaller = installWindowsSetupCapabilities;

export function overrideWindowsSetupCapabilityInstallerForTest(
  installer: WindowsSetupCapabilityInstaller,
): () => void {
  const previous = windowsSetupCapabilityInstaller;
  windowsSetupCapabilityInstaller = installer;
  return () => {
    windowsSetupCapabilityInstaller = previous;
  };
}

function installWindowsV2AccountCapabilities(
  sandboxSid: string,
  sandboxGroupSid: string,
  filesystemCapabilityNonce: string,
): void {
  windowsSetupCapabilityInstaller(
    resolveWindowsSandboxV2Executable({ provision: true }).path,
    {
      version: 1,
      sandboxSid,
      sandboxGroupSid,
      filesystemCapabilityNonce,
      readRoots: windowsSandboxSetupReadRoots(),
      writeRoots: windowsSandboxSetupWriteRoots(),
    },
  );
}

function verifyWindowsV2AccountCompatibility(sandboxSid: string): void {
  const result = spawnSync(
    resolveWindowsSandboxV2Executable({ provision: false }).path,
    ['__verify-null-device', sandboxSid],
    {
      env: sanitizedEnvironment(),
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 5_000,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    const reason = result.error?.message ?? (result.stderr.trim() || `exit ${String(result.status)}`);
    throw windowsSandboxV2CutoverError(
      `The sandbox account NUL-device compatibility ACE is missing or unsafe: ${reason}`,
    );
  }
}

async function setupWindowsSandboxRuntimeWithLock(): Promise<SandboxRuntimeDoctorResult> {
  const initial = await doctorSandboxRuntime({ refresh: true });
  if (initial.ready) return initial;
  if (!initial.setupRequired) return initial;
  // Migration state lives in the protected native cache. Provision that cache
  // before publishing a legacy drain marker; a normal mkdir would inherit a
  // weaker parent DACL and make later artifact verification fail closed.
  resolveWindowsSandboxV2Executable({ provision: true });
  const filesystemCapabilityNonce = previousWindowsFilesystemCapabilityNonce() ?? randomUUID();
  let previousCutover: WindowsSandboxV2CutoverMarker | undefined;
  try {
    previousCutover = readWindowsSandboxV2CutoverMarker();
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError || errorText(error).includes('cutover marker'))) {
      throw new Error('Cannot inspect the Windows sandbox setup generation.', { cause: error });
    }
    emitKodaXDiagnostic({
      source: 'sandbox:windows-v2-setup',
      level: 'warn',
      message: 'The previous Windows sandbox generation marker is invalid and will be rotated.',
      detail: error,
    });
  }
  // Protocol-7 Runtimes read the former ProgramData marker and do not know the
  // protocol-8 marker-handle gate. Remove that authority once, then drain the
  // full Bash hard-timeout window: a legacy admission may already have read the
  // marker but can never retain pre-start authority beyond that deadline.
  const legacyAdmissionDrainMs = await invalidateLegacyWindowsSandboxCutoverForSetup();
  // Setup never shares a valid account generation with new admissions.
  await invalidateWindowsSandboxV2CutoverForSetup();
  if (legacyAdmissionDrainMs > 0) {
    await waitForLegacyWindowsSandboxAdmissions(legacyAdmissionDrainMs);
  }
  await removeWindowsSandboxCutoverMarkerForSetup(windowsSandboxLegacyDrainMarkerFile());
  const runner = await prepareWindowsSandboxRunner([], true);
  const oldUser = getWindowsSandboxUserStatus({ srtWin: runner.srtWin });
  const oldSid = oldUser.sid;
  const markerMatchesCurrentUser = previousCutover !== undefined
    && windowsSandboxAccountDiagnostics(oldUser).length === 0
    && oldUser.sid === previousCutover.sandboxUserSid
    && oldUser.groupSid === previousCutover.sandboxGroupSid
    && windowsSandboxV2HostUserSid() === previousCutover.hostUserSid;
  recoverWindowsV2ExecutionDeniesForSetup();
  let controlStateFailure: unknown;
  try {
    verifyWindowsSandboxControlDirectory();
  } catch (error: unknown) {
    controlStateFailure = error;
  }
  if (controlStateFailure !== undefined) {
    if (existsSync(windowsSandboxControlDirectory())) {
      if (oldUser.sid === undefined && oldUser.provisioned !== false) {
        throw new Error(
          '[windows_control_repair_sid_unavailable] The native shell control directory needs '
          + 'repair, but the provisioned sandbox account SID is unavailable; repair cannot '
          + 'safely prove that no sandbox process still holds a control-state handle.',
        );
      }
      if (oldSid !== undefined && !await windowsSandboxSidIsIdle(oldSid)) {
        throw new Error(
          'The native shell control directory needs repair while the sandbox account still has '
          + 'a live process; close sandboxed shells and retry "kodax sandbox setup".',
        );
      }
    }
    try {
      repairWindowsSandboxControlDirectory();
    } catch (repairError: unknown) {
      throw new AggregateError(
        [controlStateFailure, repairError],
        'Windows native shell control state verification and setup repair both failed.',
      );
    }
    const repaired = await doctorSandboxRuntime({ refresh: true });
    if (repaired.ready) return repaired;
  }
  if (markerMatchesCurrentUser) {
    if (oldSid !== undefined && !await windowsSandboxSidIsIdle(oldSid)) {
      throw new Error(
        'The Windows sandbox account still has a live process; '
        + 'close sandboxed shells and retry "kodax sandbox setup".',
      );
    }
    const result = installWindowsSandbox({ srtWin: runner.srtWin });
    if (result.cancelled) throw new Error('Sandbox setup was cancelled.');
    const installedUser = getWindowsSandboxUserStatus({ srtWin: runner.srtWin });
    if (installedUser.sid === undefined || installedUser.groupSid === undefined) {
      throw new Error('Windows sandbox setup did not return complete account SIDs.');
    }
    resolveWindowsSandboxV2Executable({
      sandboxReadSid: installedUser.groupSid,
      provision: true,
    });
    installWindowsV2AccountCapabilities(
      installedUser.sid,
      installedUser.groupSid,
      filesystemCapabilityNonce,
    );
    await verifyPreparedWindowsWfp(runner);
    writeWindowsSandboxV2CutoverMarker({
      version: WINDOWS_SANDBOX_V2_SETUP_VERSION,
      protocol: WINDOWS_SANDBOX_V2_PROTOCOL,
      generationNonce: randomUUID(),
      filesystemCapabilityNonce,
      hostUserSid: windowsSandboxV2HostUserSid(),
      sandboxUserSid: installedUser.sid,
      sandboxGroupSid: installedUser.groupSid,
    });
    return doctorSandboxRuntime({ refresh: true });
  }

  if (oldSid !== undefined && !await windowsSandboxSidIsIdle(oldSid)) {
    throw new Error(
      'The Windows sandbox account still has a live process; '
      + 'close sandboxed shells and retry "kodax sandbox setup".',
    );
  }

  const setupBlock = await windowsSandboxAclSetupBlockWithLock();
  if (setupBlock !== undefined) return withWindowsSandboxAclSetupBlock(initial, setupBlock);
  if (oldSid !== undefined) {
    await recoverWindowsSandboxAcls();
    if (oldUser.groupSid === undefined) {
      throw new Error(
        'The legacy Windows sandbox group SID is unavailable; exact ACL migration cannot proceed.',
      );
    }
    migrateWindowsLegacyAclGuardsForSetup(oldSid, oldUser.groupSid);
    const uninstalled = uninstallWindowsSandbox({ keepUser: false, srtWin: runner.srtWin });
    if (uninstalled.cancelled) throw new Error('Sandbox account rotation was cancelled.');
  }

  const result = installWindowsSandbox({ srtWin: runner.srtWin });
  if (result.cancelled) throw new Error('Sandbox setup was cancelled.');
  const installedUser = getWindowsSandboxUserStatus({ srtWin: runner.srtWin });
  const installedDiagnostics = windowsSandboxAccountDiagnostics(installedUser);
  if (installedDiagnostics.length > 0 || installedUser.sid === undefined || installedUser.groupSid === undefined) {
    throw new Error(`Windows sandbox setup remained incomplete: ${installedDiagnostics.join(' ')}`);
  }
  if (oldSid !== undefined && installedUser.sid === oldSid) {
    throw new Error('Windows sandbox account rotation did not produce a new SID; v2 remains fail-closed.');
  }
  resolveWindowsSandboxV2Executable({
    sandboxReadSid: installedUser.groupSid,
    provision: true,
  });
  installWindowsV2AccountCapabilities(
    installedUser.sid,
    installedUser.groupSid,
    filesystemCapabilityNonce,
  );
  await verifyPreparedWindowsWfp(runner);
  writeWindowsSandboxV2CutoverMarker({
    version: WINDOWS_SANDBOX_V2_SETUP_VERSION,
    protocol: WINDOWS_SANDBOX_V2_PROTOCOL,
    generationNonce: randomUUID(),
    filesystemCapabilityNonce,
    hostUserSid: windowsSandboxV2HostUserSid(),
    sandboxUserSid: installedUser.sid,
    sandboxGroupSid: installedUser.groupSid,
  });
  return doctorSandboxRuntime({ refresh: true });
}

export async function setupSandboxRuntime(): Promise<SandboxRuntimeDoctorResult> {
  if (process.platform !== 'win32') return doctorSandboxRuntime({ refresh: true });
  await mkdir(path.dirname(windowsSandboxV2SetupLockFile()), { recursive: true, mode: 0o700 });
  return withKodaXFileLock(
    windowsSandboxV2SetupLockFile(),
    setupWindowsSandboxRuntimeWithLock,
    WINDOWS_SANDBOX_ACL_RECOVERY_LOCK_TIMEOUT_MS,
  );
}

export function sandboxSetupGuidance(
  doctor: SandboxRuntimeDoctorResult,
): readonly string[] {
  if (doctor.ready) {
    return [
      `KodaX sandbox is active (${doctor.platform}, ASRT ${doctor.version}).`,
    ];
  }
  if (doctor.platform === 'win32') {
    const cleanupDiagnostic = doctor.diagnostics.find(
      (diagnostic) => diagnostic.startsWith(WINDOWS_SANDBOX_ACL_CLEANUP_DIAGNOSTIC),
    );
    if (cleanupDiagnostic !== undefined) {
      return [cleanupDiagnostic.slice(WINDOWS_SANDBOX_ACL_CLEANUP_DIAGNOSTIC.length).trim()];
    }
    return [
      'Run "kodax sandbox setup". Windows will show a UAC prompt for the one-time sandbox account and network policy setup.',
      'The terminal itself does not need to be started as Administrator; approve the UAC prompt when it appears.',
    ];
  }
  if (doctor.platform === 'darwin') {
    return [
      'KodaX uses macOS Seatbelt through sandbox-exec. Install the missing dependency, then rerun "kodax sandbox doctor".',
      'Homebrew: brew install ripgrep',
    ];
  }
  if (doctor.platform === 'linux') {
    return [
      'KodaX uses bubblewrap on Linux. Install bubblewrap, socat, and ripgrep, then rerun "kodax sandbox doctor".',
      'Debian/Ubuntu: sudo apt install bubblewrap socat ripgrep',
      'Fedora/RHEL: sudo dnf install bubblewrap socat ripgrep',
      'Arch Linux: sudo pacman -S bubblewrap socat ripgrep',
    ];
  }
  return [
    `KodaX sandbox is not supported on ${doctor.platform}.`,
  ];
}

/**
 * Setup/onboarding helper. It may trigger the Windows UAC installer, but never
 * invokes a macOS/Linux package manager or silently widens execution.
 */
export async function prepareSandboxRuntimeForSetup(
  options: { readonly allowElevation?: boolean } = {},
): Promise<SandboxSetupOutcome> {
  const initial = await doctorSandboxRuntime({ refresh: true });
  if (initial.ready) {
    return {
      status: 'ready',
      attempted: false,
      doctor: initial,
      guidance: sandboxSetupGuidance(initial),
    };
  }
  if (doctorHasWindowsSandboxAclCleanupBlock(initial)) {
    return {
      status: 'unavailable',
      attempted: false,
      doctor: initial,
      guidance: sandboxSetupGuidance(initial),
    };
  }
  if (!initial.setupRequired) {
    return {
      status: 'unavailable',
      attempted: false,
      doctor: initial,
      guidance: sandboxSetupGuidance(initial),
    };
  }
  if (initial.platform !== 'win32' || options.allowElevation === false) {
    return {
      status: 'unavailable',
      attempted: false,
      doctor: initial,
      guidance: sandboxSetupGuidance(initial),
    };
  }
  try {
    const doctor = await setupSandboxRuntime();
    return {
      status: doctor.ready ? 'ready' : 'unavailable',
      attempted: true,
      doctor,
      guidance: sandboxSetupGuidance(doctor),
    };
  } catch (error: unknown) {
    const doctor = await doctorSandboxRuntime({ refresh: true });
    const message = errorText(error);
    return {
      status: /cancelled/i.test(message) ? 'cancelled' : 'unavailable',
      attempted: true,
      doctor,
      guidance: sandboxSetupGuidance(doctor),
      error: message,
    };
  }
}

function canonicalRelative(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return normalized;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isSensitiveRelative(relative: string): boolean {
  const parts = relative.split(path.sep).map((part) => part.toLowerCase());
  return parts.some((part) => SENSITIVE_PATH_PARTS.has(part))
    || parts.some((part) => SENSITIVE_FILES.has(part) || part.startsWith('.env.'));
}

async function copySkillSnapshot(skill: Skill, root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const files = [
    ...(skill.scripts ?? []).map((file) => ({ folder: 'scripts', file })),
    ...(skill.references ?? []).map((file) => ({ folder: 'references', file })),
    ...(skill.assets ?? []).map((file) => ({ folder: 'assets', file })),
    ...(skill.templates ?? []).map((file) => ({ folder: 'templates', file })),
    ...(skill.resources ?? []).map((file) => ({ folder: 'resources', file })),
  ];
  await writeFile(path.join(root, 'SKILL.md'), await readFile(skill.skillFilePath), { mode: 0o600 });
  for (const { folder, file } of files) {
    const relative = canonicalRelative(file.relativePath, `Skill ${skill.name} support file`);
    const target = path.join(root, folder, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, await readFile(file.path), { mode: 0o600 });
  }
}

async function snapshotAdmissions(input: CreateSkillScriptRunnerInput, root: string): Promise<Map<string, AdmittedScript>> {
  const scripts = new Map<string, AdmittedScript>();
  for (const [skillName, rawPaths] of Object.entries(input.admissions)) {
    const skill = await input.registry.loadFull(skillName);
    const available = new Map((skill.scripts ?? []).map((file) => [
      `scripts/${canonicalRelative(file.relativePath, `Skill ${skillName} script`)}`, file,
    ]));
    const skillRoot = path.join(root, skillName.replace(/[^A-Za-z0-9._-]/g, '_'));
    await copySkillSnapshot(skill, skillRoot);
    for (const rawPath of rawPaths) {
      const relativePath = canonicalRelative(rawPath, `toolPolicy.skillScripts.${skillName}`);
      if (!available.has(relativePath)) throw new Error(`Skill "${skillName}" has no script "${relativePath}".`);
      scripts.set(`${skillName}\0${relativePath}`, {
        skill: skillName,
        relativePath,
        snapshotPath: path.join(skillRoot, ...relativePath.split('/')),
      });
    }
  }
  return scripts;
}

function networkEndpoints(network: CreateSkillScriptRunnerInput['network']): SandboxEndpoint[] {
  if (network.mode === 'deny') return [];
  return network.origins.map((origin) => {
    const url = new URL(origin);
    return { host: url.hostname.toLowerCase(), port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80 };
  });
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const names = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'COMSPEC',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'LANG',
  ];
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('LC_') && value !== undefined) env[name] = value;
  }
  return normalizedSandboxEnvironment(env);
}

function normalizedSandboxEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return { ...environment };
  const entries = new Map<string, readonly [string, string]>();
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    entries.set(name.toLowerCase(), [name, value]);
  }
  return Object.fromEntries(entries.values());
}

function mergeSandboxEnvironment(
  base: Readonly<NodeJS.ProcessEnv>,
  overrides: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  return normalizedSandboxEnvironment({ ...base, ...overrides });
}

function interpreterFor(script: string): { readonly command: string; readonly args: readonly string[] } {
  const extension = path.extname(script).toLowerCase();
  if (['.js', '.mjs', '.cjs'].includes(extension)) {
    return {
      command: process.env.KODAX_A2A_NODE ?? (process.env.KODAX_BUNDLED === 'true' ? 'node' : process.execPath),
      args: [script],
    };
  }
  if (extension === '.py') return { command: process.env.KODAX_A2A_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3'), args: [script] };
  if (extension === '.ps1') {
    const command = process.env.KODAX_A2A_POWERSHELL
      ?? (process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh');
    return { command, args: ['-NoProfile', '-NonInteractive', '-File', script] };
  }
  if (extension === '.sh' && process.platform !== 'win32') return { command: '/bin/sh', args: [script] };
  if (['.cmd', '.bat'].includes(extension) && process.platform === 'win32') {
    return { command: process.env.COMSPEC ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', script] };
  }
  throw new Error(`Unsupported admitted Skill script type: ${extension || '<none>'}.`);
}

interface SandboxProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const SANDBOX_TERMINATION_FORCE_MS = 250;
const SANDBOX_TERMINATION_HARD_MS = 1_500;
const WINDOWS_V2_TERMINATION_ATTESTATION_MS = 12_000;

async function collectProcess(
  child: ReturnType<typeof spawn>,
  signal?: AbortSignal,
  timeoutMs = SCRIPT_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  nativeJobContained = false,
  nativeProcessControl?: KodaXShellSandboxProcessControl,
): Promise<SandboxProcessResult> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const childProcessStartIdentity = nativeProcessControl !== undefined || child.pid === undefined
    ? undefined
    : readProcessStartIdentity(child.pid);
  let bytes = 0;
  let stopError: Error | undefined;
  let reportStopRequested: () => void = () => undefined;
  let terminationProof: Promise<void> | undefined;
  let hardStopTimer: ReturnType<typeof setTimeout> | undefined;
  const stopRequested = new Promise<void>((resolve) => {
    reportStopRequested = resolve;
  });
  const requestStop = (error: Error): void => {
    if (stopError !== undefined) return;
    stopError = error;
    reportStopRequested();
    let settled = false;
    let resolveTermination!: () => void;
    let rejectTermination!: (failure: Error) => void;
    terminationProof = new Promise<void>((resolve, reject) => {
      resolveTermination = resolve;
      rejectTermination = reject;
    });
    void terminationProof.catch(() => undefined);
    if (nativeProcessControl !== undefined) {
      void nativeProcessControl.terminate(child).then(resolveTermination, (failure: unknown) => {
        rejectTermination(failure instanceof Error ? failure : new Error(String(failure)));
      });
      return;
    }
    const unconfirmedTermination = async (cause?: unknown): Promise<Error> => {
      const terminationError = nativeJobContained
        ? new Error('Native Windows sandbox host termination was not confirmed.')
        : new Error(
            'Sandbox broker process-tree termination was not confirmed; '
            + 'stop the retained process tree before retrying.',
          );
      return cause === undefined
        ? terminationError
        : new AggregateError(
            [terminationError, cause],
            'Sandbox broker termination failed and its process tree may still be alive.',
          );
    };
    const finish = (failure?: Error): void => {
      if (settled) return;
      settled = true;
      if (hardStopTimer !== undefined) clearTimeout(hardStopTimer);
      if (failure === undefined) resolveTermination();
      else rejectTermination(failure);
    };
    hardStopTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
        void unconfirmedTermination().then(finish);
      } catch (killError: unknown) {
        void unconfirmedTermination(killError).then(finish);
      }
    }, SANDBOX_TERMINATION_HARD_MS);
    void killChildProcessTree(child, {
      expectedProcessStartIdentity: childProcessStartIdentity,
      forceMs: SANDBOX_TERMINATION_FORCE_MS,
      taskkillMs: SANDBOX_TERMINATION_FORCE_MS,
    }).then(
      async (result) => finish(
        result.status === 'unknown' ? await unconfirmedTermination() : undefined,
      ),
      async (killError: unknown) => finish(await unconfirmedTermination(killError)),
    );
  };
  const append = (chunks: Buffer[], chunk: Buffer): void => {
    bytes += chunk.byteLength;
    if (bytes > maxOutputBytes) {
      requestStop(new Error(`Sandboxed command output exceeded ${maxOutputBytes} bytes.`));
    }
    else chunks.push(chunk);
  };
  child.stdout?.on('data', (chunk: Buffer) => { append(stdoutChunks, chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { append(stderrChunks, chunk); });
  const timer = setTimeout(() => {
    requestStop(new Error(`Sandboxed command exceeded its ${timeoutMs} ms timeout.`));
  }, timeoutMs);
  const abort = (): void => {
    const reason = signal?.reason;
    requestStop(reason instanceof Error ? reason : new Error('Sandboxed command was cancelled.'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const completed = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.stdin?.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    const exitCode = await Promise.race([completed, stopRequested.then(() => 1)]);
    if (stopError !== undefined) {
      const originalStopError = stopError;
      try {
        await terminationProof;
      } catch (terminationError: unknown) {
        const nativeDiagnostic = Buffer.concat(stderrChunks).toString('utf8').trim();
        throw new AggregateError(
          [
            originalStopError,
            terminationError,
            ...(nativeDiagnostic === ''
              ? []
              : [new Error(`Native sandbox stderr: ${nativeDiagnostic.slice(0, 4_096)}`)]),
          ],
          'Sandboxed command failed and native termination was not confirmed.',
        );
      }
      throw originalStopError;
    }
    return {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    };
  } finally {
    clearTimeout(timer);
    if (hardStopTimer !== undefined) clearTimeout(hardStopTimer);
    signal?.removeEventListener('abort', abort);
  }
}

interface SandboxBrokerResult extends SandboxProcessResult {
  readonly controlFailure?: string;
  readonly controlInvocationId: string;
  readonly controlOutput: Uint8Array;
  readonly expectedBackend: KodaXShellSandboxBackend;
}

/** @internal Test isolation for cached doctor and staged Windows runner state. */
export async function resetSandboxRuntimeForTest(): Promise<void> {
  cachedWindowsBootIdentity = undefined;
  doctorPromise = undefined;
  doctorExpiresAt = 0;
  preparedWindowsRunnerPromise = undefined;
  preparedWindowsRunner = undefined;
  cachedWindowsSandboxV2Cutover = undefined;
  preparedWindowsShellArtifacts.clear();
  preparedWindowsControlDirectoryPromise = undefined;
  const brokerStops = [...windowsNetworkBrokers.values()].map((state) => {
    state.references = 0;
    return stopSharedWindowsNetworkBroker(state);
  });
  const brokerResults = await Promise.allSettled(brokerStops);
  windowsNetworkBrokers.clear();
  windowsNetworkBrokerUseSequence = 0;
  rmSync(windowsSandboxAclPoisonDirectory(), { recursive: true, force: true });
  rmSync(legacyWindowsSandboxAclPoisonDirectory(), { recursive: true, force: true });
  const failures = brokerResults.flatMap((result) => (
    result.status === 'rejected' ? [result.reason] : []
  ));
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Windows network broker test reset failed.');
  }
}

function sandboxAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Operation aborted', 'AbortError');
}

interface WindowsV2ProcessControl extends KodaXShellSandboxProcessControl {
  waitForTerminalObservation(): Promise<void>;
}

function createWindowsV2ProcessControl(
  bootstrap: Uint8Array,
  resumeRecordPath: string,
  startedRecordPath: string,
  terminalRecordPath: string,
  terminalNonce: string,
  validateStart: NonNullable<KodaXShellSandboxProcessControl['validateStart']>,
): WindowsV2ProcessControl {
  type ControlPhase =
    | 'bootstrap-pending'
    | 'control-open'
    | 'pre-start-unavailable'
    | 'started'
    | 'terminal';
  const terminations = new WeakMap<ReturnType<typeof spawn>, Promise<void>>();
  const startAttestations = new WeakMap<
    ReturnType<typeof spawn>,
    ReturnType<NonNullable<KodaXShellSandboxProcessControl['attestStart']>>
  >();
  const phases = new WeakMap<ReturnType<typeof spawn>, ControlPhase>();
  let terminalObservation: Promise<void> | undefined;
  const initialInput = Buffer.concat([
    Buffer.from(bootstrap),
    encodeWindowsSandboxV2ControlFrame('close-stdin'),
  ]);

  const closeInput: KodaXShellSandboxProcessControl['closeInput'] = (
    child,
    signal,
    deadlineAt,
  ) => {
    const stdin = child.stdin;
    if (stdin === null) {
      return Promise.reject(new Error('Native sandbox bootstrap pipe was not created.'));
    }
    if (signal?.aborted) return Promise.reject(sandboxAbortError(signal));
    if (Date.now() >= deadlineAt) {
      return Promise.reject(new Error('Native sandbox bootstrap delivery timed out.'));
    }
    let stderrTail = Buffer.alloc(0);
    const stderr = child.stderr;
    const onStderr = (chunk: Buffer): void => {
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-4_096);
    };
    stderr?.on('data', onStderr);
    phases.set(child, 'bootstrap-pending');
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let diagnosticTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(
        () => finish(new Error('Native sandbox bootstrap delivery timed out.')),
        Math.max(1, deadlineAt - Date.now()),
      );
      timer.unref();
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (diagnosticTimer !== undefined) clearTimeout(diagnosticTimer);
        signal?.removeEventListener('abort', onAbort);
        stderr?.off('data', onStderr);
        if (error === undefined) resolve();
        else {
          const diagnostic = stderrTail.toString('utf8').trim();
          reject(diagnostic === ''
            ? error
            : new Error(
                `${error.message} Native sandbox stderr: ${diagnostic}`,
                { cause: error },
              ));
        }
      };
      const failAfterStderrDrain = (error: Error): void => {
        if (settled || diagnosticTimer !== undefined) return;
        diagnosticTimer = setTimeout(() => finish(error), 100);
        diagnosticTimer.unref();
      };
      const onError = (error: Error): void => {
        failAfterStderrDrain(
          new Error('Native sandbox bootstrap delivery failed.', { cause: error }),
        );
      };
      const onClose = (): void => {
        stdin.off('error', onError);
        if (!settled) {
          failAfterStderrDrain(
            new Error('Native sandbox bootstrap pipe closed before delivery completed.'),
          );
        }
      };
      const onAbort = (): void => {
        if (signal !== undefined) finish(sandboxAbortError(signal));
      };
      // Keep observing late EPIPE until close. The write callback only proves that
      // bootstrap + CloseStdin entered the persistent native control stream.
      stdin.on('error', onError);
      stdin.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      stdin.write(initialInput, (error) => {
        if (error === null || error === undefined) {
          if (!settled) phases.set(child, 'control-open');
          finish();
        } else {
          failAfterStderrDrain(
            new Error('Native sandbox bootstrap delivery failed.', { cause: error }),
          );
        }
      });
    });
  };

  const verifyTerminalRecord = async (): Promise<void> => {
    const raw = await readFile(terminalRecordPath, 'utf8');
    const value = JSON.parse(raw) as unknown;
    const cleanupDeferred = typeof value === 'object' && value !== null
      ? Reflect.get(value, 'denyReadCleanupDeferred')
      : undefined;
    const cleanupDiagnostic = typeof value === 'object' && value !== null
      ? Reflect.get(value, 'denyReadCleanupDiagnostic')
      : undefined;
    if (
      typeof value !== 'object'
      || value === null
      || Reflect.get(value, 'protocol') !== WINDOWS_SANDBOX_V2_PROTOCOL
      || Reflect.get(value, 'nonce') !== terminalNonce.toLowerCase()
      || Reflect.get(value, 'jobDrained') !== true
      || !Number.isSafeInteger(Reflect.get(value, 'targetExitCode'))
      || typeof Reflect.get(value, 'terminationRequested') !== 'boolean'
      || typeof cleanupDeferred !== 'boolean'
      || (
        cleanupDeferred
        && (
          typeof cleanupDiagnostic !== 'string'
          || cleanupDiagnostic.length === 0
          || cleanupDiagnostic.length > 2_048
        )
      )
    ) {
      throw new Error('Native sandbox terminal record was invalid.');
    }
    if (cleanupDeferred) {
      emitKodaXDiagnostic({
        source: 'sandbox:windows-v2',
        level: 'warn',
        message: 'Windows denyRead ACL cleanup was deferred for automatic recovery.',
        detail: cleanupDiagnostic,
      });
    }
  };

  const verifyLaunchRecord = async (recordPath: string): Promise<void> => {
    const raw = await readFile(recordPath, 'utf8');
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value !== 'object'
      || value === null
      || Reflect.get(value, 'protocol') !== WINDOWS_SANDBOX_V2_PROTOCOL
      || Reflect.get(value, 'nonce') !== terminalNonce.toLowerCase()
      || !Number.isSafeInteger(Reflect.get(value, 'targetPid'))
      || Number(Reflect.get(value, 'targetPid')) <= 0
      || Reflect.get(value, 'jobContained') !== true
    ) {
      throw new Error('Native sandbox target-start record was invalid.');
    }
  };

  const verifyStartedRecord = () => verifyLaunchRecord(startedRecordPath);

  const attestStart: NonNullable<KodaXShellSandboxProcessControl['attestStart']> = (
    child,
    signal,
    deadlineAt,
  ) => {
    const existing = startAttestations.get(child);
    if (existing !== undefined) return existing;
    const attestation = new Promise<
      | { readonly state: 'started' }
      | { readonly state: 'pre_start_unavailable'; readonly diagnostic: string }
    >((resolve, reject) => {
      let settled = false;
      let closed = child.exitCode !== null || child.signalCode !== null;
      let closeCode = child.exitCode;
      let closeSignal = child.signalCode;
      let pollTimer: NodeJS.Timeout | undefined;
      let stderrTail = Buffer.alloc(0);
      const stderr = child.stderr;
      const finish = (
        result?: { readonly state: 'started' }
          | { readonly state: 'pre_start_unavailable'; readonly diagnostic: string },
        error?: unknown,
      ): void => {
        if (settled) return;
        settled = true;
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        child.off('close', onClose);
        signal?.removeEventListener('abort', onAbort);
        stderr?.off('data', onStderr);
        if (error !== undefined) reject(error);
        else if (result !== undefined) resolve(result);
      };
      const onStderr = (chunk: Buffer): void => {
        stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-4_096);
      };
      const onClose = (code: number | null, closeSignalValue: NodeJS.Signals | null): void => {
        closed = true;
        closeCode = code;
        closeSignal = closeSignalValue;
        void poll();
      };
      const onAbort = (): void => {
        if (signal !== undefined) finish(undefined, sandboxAbortError(signal));
      };
      const poll = async (): Promise<void> => {
        if (settled) return;
        try {
          await verifyStartedRecord();
          phases.set(child, 'started');
          finish({ state: 'started' });
          return;
        } catch (error: unknown) {
          if (!isFileSystemError(error, 'ENOENT')) {
            finish(undefined, error);
            return;
          }
        }
        if (closed) {
          try {
            await verifyLaunchRecord(resumeRecordPath);
          } catch (error: unknown) {
            if (!isFileSystemError(error, 'ENOENT')) {
              finish(undefined, error);
              return;
            }
            phases.set(child, 'pre-start-unavailable');
            const diagnostic = stderrTail.toString('utf8').trim()
              || `Native sandbox exited before target-start attestation `
                + `(code ${String(closeCode)}, signal ${String(closeSignal)}).`;
            finish({ state: 'pre_start_unavailable', diagnostic });
            return;
          }
          const diagnostic = stderrTail.toString('utf8').trim()
            || 'Native sandbox authorized target Resume but exited before target-start '
              + 'attestation; execution is started-or-unknown and will not be replayed.';
          finish(undefined, new Error(diagnostic));
          return;
        }
        if (Date.now() >= deadlineAt) {
          finish(undefined, new Error('Native sandbox target-start attestation timed out.'));
          return;
        }
        pollTimer = setTimeout(() => { void poll(); }, 20);
        pollTimer.unref();
      };
      stderr?.on('data', onStderr);
      child.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else void poll();
    });
    startAttestations.set(child, attestation);
    void attestation.catch(() => undefined);
    return attestation;
  };

  const terminate: KodaXShellSandboxProcessControl['terminate'] = (child) => {
    const existing = terminations.get(child);
    if (existing !== undefined) return existing;
    const termination = new Promise<void>((resolve, reject) => {
      const phase = phases.get(child);
      const provenNotStarted = phase === undefined || phase === 'pre-start-unavailable';
      const stdin = child.stdin;
      if (stdin === null) {
        reject(new Error('Native sandbox control pipe was not created.'));
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        phases.set(child, 'terminal');
        if (provenNotStarted) resolve();
        else void verifyTerminalRecord().then(resolve, reject);
        return;
      }
      let settled = false;
      let emergencyStarted = false;
      let deliveryFailure: Error | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('close', onClose);
        child.off('error', onChildError);
        stdin.off('error', onStdinError);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onClose = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
        if (emergencyStarted) return;
        phases.set(child, 'terminal');
        if (provenNotStarted) {
          finish();
          return;
        }
        void verifyTerminalRecord().then(
          () => finish(),
          (recordError: unknown) => finish(new Error(
            `Native sandbox closed without a Job-drain attestation (code ${String(code)}, `
            + `signal ${String(closeSignal)}).`,
            {
              cause: new AggregateError(
                [recordError, ...(deliveryFailure === undefined ? [] : [deliveryFailure])],
                'Native sandbox terminal record verification failed.',
              ),
            },
          )),
        );
      };
      const onChildError = (error: Error): void => {
        deliveryFailure ??= error;
      };
      const onStdinError = (error: Error): void => {
        deliveryFailure ??= error;
      };
      const timer = setTimeout(() => {
        emergencyStarted = true;
        void killChildProcessTree(child, { forceMs: 500, taskkillMs: 500 }).then(
          (result) => finish(new AggregateError(
            [
              new Error(
                `Native sandbox did not attest Job drain within `
                + `${WINDOWS_V2_TERMINATION_ATTESTATION_MS} ms.`,
              ),
              ...(deliveryFailure === undefined ? [] : [deliveryFailure]),
              ...(result.status === 'unknown'
                ? [new Error('Emergency process-tree termination was not confirmed.')]
                : []),
            ],
            'Native sandbox termination was not confirmed by its runner.',
          )),
          (error: unknown) => finish(new AggregateError(
            [
              new Error(
                `Native sandbox did not attest Job drain within `
                + `${WINDOWS_V2_TERMINATION_ATTESTATION_MS} ms.`,
              ),
              ...(deliveryFailure === undefined ? [] : [deliveryFailure]),
              error,
            ],
            'Native sandbox termination and emergency cleanup both failed.',
          )),
        );
      }, WINDOWS_V2_TERMINATION_ATTESTATION_MS);
      timer.unref();
      child.once('close', onClose);
      child.once('error', onChildError);
      stdin.on('error', onStdinError);
      stdin.end(
        phases.get(child) === undefined
          ? undefined
          : encodeWindowsSandboxV2ControlFrame('terminate'),
        (error) => {
        if (error !== null && error !== undefined) deliveryFailure ??= error;
        },
      );
    });
    terminations.set(child, termination);
    terminalObservation = termination;
    void termination.catch(() => undefined);
    return termination;
  };

  return {
    validateStart,
    closeInput,
    attestStart,
    terminate,
    async waitForTerminalObservation() {
      const active = terminalObservation;
      if (active === undefined) {
        await verifyTerminalRecord();
        return;
      }
      await active;
    },
  };
}

function closeNativeSandboxInput(
  child: ReturnType<typeof spawn>,
  prefix: Uint8Array | undefined,
  signal: AbortSignal | undefined,
  deadlineAt: number,
): Promise<void> {
  const stdin = child.stdin;
  if (stdin === null) {
    return Promise.reject(new Error('Native sandbox bootstrap pipe was not created.'));
  }
  if (signal?.aborted) return Promise.reject(sandboxAbortError(signal));
  if (Date.now() >= deadlineAt) {
    return Promise.reject(new Error('Native sandbox bootstrap delivery timed out.'));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error('Native sandbox bootstrap delivery timed out.')),
      Math.max(0, deadlineAt - Date.now()),
    );
    timer.unref();
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onError = (): void => finish(new Error('Native sandbox bootstrap delivery failed.'));
    const onAbort = (): void => {
      if (signal !== undefined) finish(sandboxAbortError(signal));
    };
    const onClose = (): void => {
      stdin.off('error', onError);
      if (!settled) finish(new Error('Native sandbox bootstrap pipe closed before delivery completed.'));
    };
    // Keep observing errors until the stream actually closes. An end callback can
    // run before a later EPIPE is emitted when the native host exits during the
    // final flush; removing the listener at that callback would turn a request
    // failure into an uncaught process-level exception.
    stdin.on('error', onError);
    stdin.once('close', onClose);
    stdin.once('finish', () => finish());
    signal?.addEventListener('abort', onAbort, { once: true });
    if (prefix === undefined) stdin.end();
    else stdin.end(prefix);
  });
}

interface StandaloneBrokerLaunch {
  readonly args: readonly string[];
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
  readonly gateFile?: string;
}

interface WindowsGatedLaunchTarget {
  readonly args: readonly string[];
  readonly command: string;
  readonly controlPipe: boolean;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

async function prepareWindowsGatedLaunch(
  target: WindowsGatedLaunchTarget,
  requestDirectory: string,
): Promise<Required<StandaloneBrokerLaunch>> {
  const gateFile = path.join(
    requestDirectory,
    `kodax-asrt-gate-${process.pid}-${randomUUID()}.json`,
  );
  await writeFile(gateFile, JSON.stringify(target), { mode: 0o600 });
  const gateLaunch = prepareJavaScriptChildLaunch({
    args: ['-e', WINDOWS_STANDALONE_BROKER_GATE_SOURCE, gateFile],
    env: sanitizedEnvironment(),
    isElectron: process.versions.electron !== undefined,
  });
  return { ...gateLaunch, gateFile };
}

function writeSandboxGate(
  child: ReturnType<typeof spawn>,
  closeAfterWrite: boolean,
): Promise<void> {
  const input = child.stdin;
  if (input === null) return Promise.reject(new Error('Sandbox gate stdin is unavailable.'));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => input.removeListener('error', onError);
    const settle = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => settle(error);
    input.once('error', onError);
    if (closeAfterWrite) input.end('go\n', settle);
    else input.write('go\n', settle);
  });
}

function closeSandboxGate(child: ReturnType<typeof spawn>): Promise<void> {
  const input = child.stdin;
  if (input === null || input.destroyed || input.writableEnded) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => input.removeListener('error', onError);
    const settle = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => settle(error);
    input.once('error', onError);
    input.end(settle);
  });
}

async function runBrokerResult(
  request: SandboxBrokerRequest,
  signal?: AbortSignal,
  timeoutMs = SCRIPT_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
): Promise<SandboxBrokerResult> {
  rejectWindowsLegacyAsrtFilesystemBackend();
  const controlled = encodeControlledBrokerRequest({
    ...request,
    bootstrapCommand: request.bootstrapCommand ?? sandboxJavaScriptCommand(),
  });
  const args = process.env.KODAX_BUNDLED === 'true'
    ? ['__asrt-broker']
    : ['--input-type=module', '-e', BROKER_SOURCE, ASRT_MODULE_URL!];
  const launch = prepareInternalNodeLaunch({
    args,
    env: sanitizedEnvironment(),
    isElectron: process.versions.electron !== undefined,
  });
  const child = spawn(process.execPath, launch.args, {
    cwd: request.cwd,
    env: launch.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  rememberChildProcessTree(child);
  const collecting = collectProcess(child, signal, timeoutMs, maxOutputBytes);
  const control = collectSandboxBrokerControl(child).then(
    (output) => ({ output }),
    (error: unknown) => ({ output: new Uint8Array(), failure: errorText(error) }),
  );
  try {
    await closeNativeSandboxInput(
      child,
      controlled.payload,
      signal,
      Date.now() + timeoutMs,
    );
  } catch (error: unknown) {
    child.kill('SIGTERM');
    await Promise.allSettled([collecting, control]);
    throw error;
  }
  const [result, controlResult] = await Promise.all([collecting, control]);
  return {
    ...result,
    ...(controlResult.failure === undefined
      ? {}
      : { controlFailure: controlResult.failure }),
    controlInvocationId: controlled.invocationId,
    controlOutput: controlResult.output,
    expectedBackend: controlled.request.observationBackend ?? 'unsupported',
  };
}
async function runBroker(request: SandboxBrokerRequest, signal?: AbortSignal): Promise<string> {
  let result: SandboxProcessResult;
  if (process.platform === 'win32') {
    const deadlineAt = Date.now() + SCRIPT_TIMEOUT_MS;
    const prepared = await prepareWindowsV2Invocation({
      shellPolicy: request.config,
      executable: request.command,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      endpoints: request.endpoints,
      allowAllNetwork: request.allowAllNetwork === true,
      signal,
      deadlineAt,
    });
    if (prepared === undefined) throw new Error('Windows native sandbox invocation was not prepared.');
    if (prepared.processControl === undefined) {
      throw new Error('Windows native sandbox invocation has no persistent process control.');
    }
    const processControl = prepared.processControl;
    const child = spawn(prepared.executable, [...prepared.args], {
      cwd: request.cwd,
      env: prepared.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    rememberChildProcessTree(child);
    let executionFailure: unknown;
    try {
      const collecting = collectProcess(
        child,
        signal,
        Math.max(1, deadlineAt - Date.now()),
        MAX_OUTPUT_BYTES,
        true,
        processControl,
      );
      // The native host can close while bootstrap delivery is still draining.
      // Observe collection immediately so that its early rejection cannot reach
      // the process-level unhandledRejection hook before the delivery branch joins it.
      void collecting.catch(() => undefined);
      try {
        await processControl.closeInput(child, signal, deadlineAt);
      } catch (deliveryError: unknown) {
        let finalError = deliveryError;
        try {
          await processControl.terminate(child);
        } catch (terminationError: unknown) {
          finalError = new AggregateError(
            [deliveryError, terminationError],
            'Native sandbox bootstrap and termination both failed.',
          );
        }
        await collecting.catch(() => undefined);
        throw finalError;
      }
      const collected = await collecting;
      result = collected;
    } catch (error: unknown) {
      executionFailure = error;
      throw error;
    } finally {
      try {
        await prepared.cleanup({ execution: 'started_or_unknown' });
      } catch (cleanupError: unknown) {
        if (executionFailure !== undefined) {
          throw new AggregateError(
            [executionFailure, cleanupError],
            'Sandboxed Skill execution and cleanup both failed.',
          );
        }
        throw cleanupError;
      }
    }
  } else {
    result = await runBrokerResult(request, signal);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`Sandboxed Skill script failed (${result.exitCode}): ${detail}`);
  }
  return result.stdout;
}

async function workspaceSource(root: string, relative: string): Promise<string> {
  const realRoot = await realpath(root);
  const candidate = path.resolve(root, canonicalRelative(relative, 'Skill script input'));
  const resolved = await realpath(candidate);
  if (!isInside(realRoot, resolved) || isSensitiveRelative(path.relative(realRoot, resolved))) {
    throw new Error('Skill script input is outside the permitted workspace surface.');
  }
  if (!(await stat(resolved)).isFile()) throw new Error('Skill script inputs must be files.');
  return resolved;
}

async function workspaceTarget(root: string, relative: string): Promise<string> {
  const realRoot = await realpath(root);
  const candidate = path.resolve(root, canonicalRelative(relative, 'Skill script output target'));
  if (!isInside(path.resolve(root), candidate) || isSensitiveRelative(path.relative(path.resolve(root), candidate))) {
    throw new Error('Skill script output target is outside the permitted workspace surface.');
  }
  await mkdir(path.dirname(candidate), { recursive: true });
  if (!isInside(realRoot, await realpath(path.dirname(candidate)))) throw new Error('Skill script output target escapes through a symlink.');
  try { await stat(candidate); throw new Error('Skill script output target already exists.'); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return candidate;
}

async function stageInputFiles(root: string, stage: string, input: KodaXSkillScriptRunInput, access: CreateSkillScriptRunnerInput['workspaceAccess']): Promise<void> {
  if (input.inputs.length > 0 && access === 'none') throw new Error('Skill script inputs require workspace read access.');
  for (const item of input.inputs) {
    const source = await workspaceSource(root, item.path);
    const relative = canonicalRelative(item.as ?? path.basename(source), 'Skill script staged input');
    const target = path.resolve(stage, 'inputs', ...relative.split('/'));
    if (!isInside(path.join(stage, 'inputs'), target)) throw new Error('Skill script staged input escapes staging.');
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
  }
}

async function promoteOutputs(
  root: string,
  stage: string,
  input: KodaXSkillScriptRunInput,
  access: CreateSkillScriptRunnerInput['workspaceAccess'],
  workspaceByteLimit?: number,
): Promise<string[]> {
  if (input.outputs.length > 0 && access !== 'write') throw new Error('Skill script outputs require workspace write access.');
  const promoted: string[] = [];
  for (const item of input.outputs) {
    const relative = canonicalRelative(item.path, 'Skill script staged output');
    const source = path.resolve(stage, 'outputs', ...relative.split('/'));
    const realSource = await realpath(source);
    if (!isInside(path.join(stage, 'outputs'), realSource)
      || (await lstat(source)).isSymbolicLink()
      || !(await stat(source)).isFile()) {
      throw new Error(`Skill script did not produce output "${relative}".`);
    }
    const target = await workspaceTarget(root, item.target);
    if (workspaceByteLimit !== undefined
      && directorySize(root, true) + (await stat(source)).size > workspaceByteLimit) {
      throw new Error('Skill script outputs would exceed the remote workspace byte quota.');
    }
    await copyFile(source, target, constants.COPYFILE_EXCL);
    promoted.push(path.relative(root, target));
  }
  return promoted;
}

function directorySize(root: string, skipScriptStaging = false): number {
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (skipScriptStaging && entry.name === '.kodax-a2a-script') continue;
    if (entry.isSymbolicLink()) continue;
    const item = path.join(root, entry.name);
    if (entry.isDirectory()) total += directorySize(item);
    else if (entry.isFile()) total += statSync(item).size;
  }
  return total;
}

function withPreparedWindowsRunner(
  config: SandboxRuntimeConfig,
): SandboxRuntimeConfig {
  if (process.platform !== 'win32') return config;
  const runner = requirePreparedWindowsRunner();
  return {
    ...config,
    windows: {
      ...config.windows,
      srtWin: { path: runner.path },
    },
    filesystem: {
      ...config.filesystem,
      // srt-win is launched by the trusted host, not by the restricted target.
      // Adding its protected cache directory to target policy caused native ACL
      // transactions to mutate an otherwise immutable bootstrap artifact.
      allowRead: config.filesystem.allowRead,
      denyWrite: process.platform === 'win32'
        ? config.filesystem.denyWrite
        : [...new Set([...(config.filesystem.denyWrite ?? []), runner.directory])],
    },
  };
}

function sandboxConfig(
  stage: string,
  snapshotRoot: string,
  endpoints: readonly SandboxEndpoint[],
  interpreter: string,
): SandboxRuntimeConfig {
  const home = process.platform === 'win32'
    ? process.env.USERPROFILE ?? os.homedir()
    : os.homedir();
  const homeDenies = [home];
  const executableReadScopes = (command: string): string[] => (
    path.isAbsolute(command)
      ? process.platform === 'win32'
        ? [command, path.dirname(command)]
        : [command]
      : []
  );
  return withPreparedWindowsRunner({
    network: {
      allowedDomains: [], deniedDomains: [], strictAllowlist: endpoints.length === 0,
      allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
    },
    filesystem: {
      denyRead: homeDenies,
      allowRead: [
        stage,
        snapshotRoot,
        ...new Set([
          ...executableReadScopes(process.execPath),
          ...executableReadScopes(interpreter),
        ]),
      ],
      allowWrite: [stage],
      denyWrite: homeDenies,
    },
  });
}

function canonicalTempDirectories(): string[] {
  const candidates = [
    os.tmpdir(),
    process.env.TEMP,
    process.env.TMP,
    process.env.TMPDIR,
    ...(process.platform === 'win32' ? [] : ['/tmp', '/var/tmp']),
  ];
  return [...new Set(candidates
    .filter((candidate): candidate is string => (
      typeof candidate === 'string' && path.isAbsolute(candidate)
    ))
    .map((candidate) => path.resolve(candidate)))];
}

function existingWorkspaceDenyWrites(workspaceRoot: string): string[] {
  const candidates = [
    path.join(workspaceRoot, '.kodax', 'runtime'),
    path.join(workspaceRoot, '.git', 'config'),
    path.join(workspaceRoot, '.git', 'hooks'),
  ];
  return candidates.filter((candidate) => {
    try {
      statSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

function trustedProjectExecPolicyDenyWrite(
  trustedProjectExecPolicyPath: string | undefined,
): string[] {
  if (trustedProjectExecPolicyPath === undefined) return [];
  if (statSync(trustedProjectExecPolicyPath, { throwIfNoEntry: false }) === undefined) {
    throw new Error(
      `Trusted project Exec Policy snapshot disappeared before sandbox admission: ${trustedProjectExecPolicyPath}`,
    );
  }
  return [trustedProjectExecPolicyPath];
}

function existingMinimalWindowsAclGuardRoots(
  candidates: readonly string[],
): string[] {
  const existing = [...new Set(candidates.map((candidate) => path.resolve(candidate)))]
    .filter((candidate) => statSync(candidate, { throwIfNoEntry: false }) !== undefined)
    .sort((left, right) => left.length - right.length);
  const roots: string[] = [];
  for (const candidate of existing) {
    if (!roots.some((root) => isInside(root, candidate))) roots.push(candidate);
  }
  return roots;
}

function windowsLegacyPersistentAclGuardRoots(): string[] {
  const home = path.resolve(process.env.USERPROFILE ?? os.homedir());
  const agentHome = path.resolve(getAgentConfigHome());
  const legacyHomeRoots = WORKSPACE_SHELL_LEGACY_HOME_DENY_PATHS
    .map((relative) => path.join(home, relative))
    .filter((candidate) => !sameWindowsPath(candidate, agentHome));
  return existingMinimalWindowsAclGuardRoots([
    ...legacyHomeRoots,
    ...WORKSPACE_SHELL_LEGACY_AGENT_HOME_DENY_PATHS.map(
      (relative) => path.join(agentHome, relative),
    ),
    windowsSandboxAclCoordinationDirectory(),
  ]);
}

function removeWindowsLegacyAclGuards(
  candidates: readonly string[],
  sandboxUserSid: string,
  sandboxGroupSid: string | undefined,
): void {
  if (sandboxGroupSid === undefined) {
    throw new Error('Windows sandbox group SID is unavailable for persistent denyRead.');
  }
  const roots = existingMinimalWindowsAclGuardRoots(candidates);
  if (roots.length === 0) return;
  const executable = resolveWindowsSandboxV2Executable({
    sandboxReadSid: sandboxGroupSid,
    untrustedWriteRoots: [],
  }).path;
  const result = spawnSync(
    executable,
    [
      '__persistent-deny-read',
      'remove',
      sandboxUserSid,
      sandboxGroupSid,
    ],
    {
      input: JSON.stringify(roots),
      encoding: 'utf8',
      timeout: 15 * 60_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    const detail = (result.error?.message || result.stderr || result.stdout || 'no diagnostics')
      .trim()
      .slice(-4_096);
    throw new Error(`Windows sandbox ACL guard failed: ${detail}`);
  }
  try {
    const output: unknown = JSON.parse(result.stdout.trim());
    if (!Array.isArray(output) || output.length !== 0) {
      throw new Error('legacy ACL removal returned a non-empty result');
    }
  } catch (error: unknown) {
    throw new Error(`Windows sandbox ACL guard returned invalid output: ${errorText(error)}`);
  }
}

function windowsLegacyAclReconciliationMarkerFile(): string {
  return path.join(
    path.resolve(process.env.ProgramData ?? path.join(os.homedir(), 'AppData', 'Local')),
    'KodaX',
    'sandbox-runtime',
    'read-policy-v2.json',
  );
}

function migrateWindowsLegacyAclGuardsForSetup(
  sandboxUserSid: string,
  sandboxGroupSid: string,
): void {
  // Machine-wide ACL migration belongs to the versioned setup cutover. Ordinary
  // command admission must remain read-only with respect to shared ACL state so
  // independent Runtime processes can prepare and execute concurrently.
  const legacyRoots = windowsLegacyPersistentAclGuardRoots();
  removeWindowsLegacyAclGuards(legacyRoots, sandboxUserSid, sandboxGroupSid);
  writeFileSync(
    windowsLegacyAclReconciliationMarkerFile(),
    JSON.stringify({
      version: 2,
      setupVersion: WINDOWS_SANDBOX_V2_SETUP_VERSION,
      sandboxGroupSid,
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
}

function windowsSandboxProfileReadRoots(home: string): string[] {
  return readdirSync(home, { withFileTypes: true })
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => path.join(home, entry.name));
}

function windowsSandboxSetupReadRoots(): string[] {
  const home = path.resolve(process.env.USERPROFILE ?? os.homedir());
  return existingMinimalWindowsAclGuardRoots([
    ...windowsSandboxProfileReadRoots(home),
    ...windowsNativeRuntimeReadScopes(workspaceShellRuntimeReadScopes(process.env)),
  ]);
}

function windowsSandboxSetupWriteRoots(): string[] {
  return workspaceShellWriteRoots(canonicalTempDirectories(), '');
}

function workspaceShellWriteRoots(
  candidateRoots: readonly string[],
  _agentHome: string,
): string[] {
  const roots: string[] = [];
  for (const candidateRoot of candidateRoots) {
    try {
      roots.push(realpathSync.native(candidateRoot));
    } catch {
      continue;
    }
  }
  return process.platform === 'win32'
    ? existingMinimalWindowsAclGuardRoots(roots)
    : [...new Set(roots)];
}

function workspaceShellTempRoot(workspaceRoot: string, policyKey: string): string {
  const identity = process.platform === 'win32'
    ? policyKey
    : path.resolve(workspaceRoot);
  return path.join(
    os.tmpdir(),
    'kodax-sandbox',
    createHash('sha256').update(identity).digest('hex').slice(0, 16),
  );
}

function createWorkspaceShellTempDirectory(
  workspaceRoot: string,
  policyKey: string,
): string {
  return path.join(
    workspaceShellTempRoot(workspaceRoot, policyKey),
    `${process.pid}-${randomUUID()}`,
  );
}

async function removeWorkspaceShellTempDirectory(tempDirectory: string): Promise<void> {
  await rm(tempDirectory, { recursive: true, force: true });
  await rmdir(path.dirname(tempDirectory)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
  });
}

function workspaceShellTempWriteRoots(shellTempDirectory?: string): string[] {
  return [...new Set([
    ...canonicalTempDirectories(),
    ...(shellTempDirectory === undefined ? [] : [path.dirname(shellTempDirectory)]),
  ])];
}

function windowsAgentHomeAccessRoot(
  candidate: string,
  agentHome: string,
  write: boolean,
): string | undefined {
  try {
    const canonicalHome = realpathSync.native(agentHome);
    const lexicalHome = path.resolve(agentHome);
    let current = path.resolve(candidate);
    if (!isInside(lexicalHome, current) || current === lexicalHome) return undefined;
    while (current !== lexicalHome) {
      try {
        const canonicalCandidate = realpathSync.native(current);
        if (
          canonicalCandidate === canonicalHome
          || !isInside(canonicalHome, canonicalCandidate)
        ) return undefined;
        const topLevel = path.relative(canonicalHome, canonicalCandidate)
          .split(path.sep)[0]?.toLowerCase();
        if (topLevel === 'sandbox-runtime') return undefined;
        if (
          write
          && WORKSPACE_SHELL_INTERNAL_AGENT_HOME_DIRECTORIES.some(
            (directory) => directory === topLevel,
          )
        ) return undefined;
        return canonicalCandidate;
      } catch (error: unknown) {
        if (!write) return undefined;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
        try {
          lstatSync(current);
          return undefined;
        } catch (lstatError: unknown) {
          if ((lstatError as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
        }
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function windowsAgentHomeAccessRoots(
  agentHome: string,
  access: AsrtShellAgentHomeAccess | undefined,
): AsrtShellAgentHomeAccess {
  if (!access) return { read: [], write: [] };
  const roots = (
    candidates: readonly string[],
    write: boolean,
  ): string[] => [...new Set(candidates.flatMap((candidate) => {
    const root = windowsAgentHomeAccessRoot(candidate, agentHome, write);
    return root ? [root] : [];
  }))];
  return {
    read: roots(access.read, false),
    write: roots(access.write, true),
    ...(access.ephemeral === true ? { ephemeral: true } : {}),
  };
}

function workspaceShellExecutable(executable?: string): string {
  return executable ?? (process.platform === 'win32'
    ? process.env.COMSPEC ?? path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'cmd.exe',
    )
    : '/bin/sh');
}

function shellEnvironmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined {
  return Object.entries(environment).find(([candidate, value]) => (
    candidate.toUpperCase() === name && value !== undefined
  ))?.[1];
}

function workspaceShellUserDataBoundaries(home: string): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    localAppData === undefined ? undefined : path.join(localAppData, 'Programs'),
    localAppData,
    process.env.APPDATA,
    path.join(home, 'AppData', 'Local', 'Programs'),
    path.join(home, 'AppData', 'Local'),
    path.join(home, 'AppData', 'Roaming'),
    home,
  ];
  return [...new Set(candidates.flatMap((candidate) => (
    candidate === undefined ? [] : [path.resolve(candidate)]
  )))]
    .filter((candidate) => isInside(home, candidate))
    .sort((left, right) => right.length - left.length);
}

function workspaceShellLinkedTargetAncestors(
  lexical: string,
  canonical: string,
  boundaries: readonly string[],
): string[] {
  if (process.platform !== 'win32' || lexical.toLowerCase() === canonical.toLowerCase()) {
    return [];
  }
  try {
    if (!lstatSync(lexical).isSymbolicLink()) return [];
  } catch {
    return [];
  }
  const boundary = boundaries.find((current) => (
    current.toLowerCase() !== canonical.toLowerCase() && isInside(current, canonical)
  ));
  if (boundary === undefined) return [];
  const [applicationDirectory] = path.relative(boundary, canonical).split(path.sep);
  if (!applicationDirectory) return [];
  const applicationRoot = path.join(boundary, applicationDirectory);
  const ancestors: string[] = [];
  for (
    let current = path.dirname(canonical);
    current.toLowerCase() !== applicationRoot.toLowerCase()
      && isInside(applicationRoot, current);
    current = path.dirname(current)
  ) {
    ancestors.push(current);
  }
  return ancestors;
}

function workspaceShellRuntimeReadScopes(
  environment: Readonly<NodeJS.ProcessEnv>,
  executable?: string,
): string[] {
  const home = path.resolve(
    process.platform === 'win32' ? process.env.USERPROFILE ?? os.homedir() : os.homedir(),
  );
  const boundaries = workspaceShellUserDataBoundaries(home);
  const scopes = new Map<string, string>();
  const safe = (candidate: string): string | undefined => {
    const resolved = path.resolve(candidate);
    if (
      resolved === path.parse(resolved).root
      || resolved.toLowerCase() === home.toLowerCase()
    ) return undefined;
    return resolved;
  };
  const remember = (candidate: string, requireUserHome: boolean): void => {
    const lexical = safe(candidate);
    if (lexical === undefined) return;
    let canonical: string;
    try {
      canonical = realpathSync(lexical);
    } catch {
      return;
    }
    if (safe(canonical) === undefined) return;
    const directories = requireUserHome
      ? [lexical, canonical].filter((current) => isInside(home, current))
      : [lexical, canonical];
    for (const directory of directories) {
      scopes.set(process.platform === 'win32' ? directory.toLowerCase() : directory, directory);
    }
    if (requireUserHome && directories.includes(canonical)) {
      for (const ancestor of workspaceShellLinkedTargetAncestors(
        lexical,
        canonical,
        boundaries,
      )) {
        const trusted = safe(ancestor);
        if (trusted !== undefined && isInside(home, trusted)) {
          scopes.set(trusted.toLowerCase(), trusted);
        }
      }
    }
  };
  for (const entry of (shellEnvironmentValue(environment, 'PATH') ?? '').split(path.delimiter)) {
    const unquoted = entry.trim().replace(/^"(.*)"$/, '$1');
    if (unquoted && path.isAbsolute(unquoted)) remember(unquoted, true);
  }
  const resolvedExecutable = workspaceShellExecutable(executable);
  if (path.isAbsolute(resolvedExecutable)) remember(path.dirname(resolvedExecutable), true);
  const bootstrap = sandboxJavaScriptCommand();
  if (path.isAbsolute(bootstrap)) {
    const trusted = safe(bootstrap);
    if (trusted !== undefined) {
      scopes.set(process.platform === 'win32' ? trusted.toLowerCase() : trusted, trusted);
    }
    remember(path.dirname(bootstrap), false);
  }
  return [...scopes.values()].sort((left, right) => (
    left.toLowerCase().localeCompare(right.toLowerCase())
  ));
}

function windowsNativeRuntimeReadScopes(scopes: readonly string[]): string[] {
  const canonical = new Map<string, string>();
  for (const scope of scopes) {
    try {
      const resolved = realpathSync.native(scope);
      canonical.set(resolved.toLowerCase(), resolved);
    } catch {
      // A concurrent removal must not fall back to a lexical grant that the
      // native runner would correctly reject for containing a reparse point.
    }
  }
  return [...canonical.values()].sort((left, right) => (
    left.toLowerCase().localeCompare(right.toLowerCase())
  ));
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function readBoundedUtf8File(filePath: string, maxBytes: number): string | undefined {
  const descriptor = openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    return bytesRead > maxBytes ? undefined : buffer.toString('utf8', 0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function linkedWorktreeMainGitDirectory(gitdir: string, gitLink: string): string | undefined {
  const match = /^(.*)[/\\]worktrees[/\\][^/\\]+$/.exec(gitdir);
  if (match === null) return undefined;
  const commonDirectoryLink = readBoundedUtf8File(path.join(gitdir, 'commondir'), 4_096);
  const worktreeBacklink = readBoundedUtf8File(path.join(gitdir, 'gitdir'), 4_096);
  if (commonDirectoryLink === undefined || worktreeBacklink === undefined) return undefined;
  const mainGit = realpathSync(match[1]!);
  const commonDirectory = realpathSync(path.resolve(
    gitdir,
    commonDirectoryLink.trim(),
  ));
  const backlink = realpathSync(path.resolve(
    gitdir,
    worktreeBacklink.trim(),
  ));
  return sameWindowsPath(commonDirectory, mainGit) && sameWindowsPath(backlink, gitLink)
    ? mainGit
    : undefined;
}

function submoduleGitWorktree(gitdir: string): string | undefined {
  const config = readBoundedUtf8File(path.join(gitdir, 'config'), 65_536);
  if (config === undefined) return undefined;
  let inCore = false;
  let worktree: string | undefined;
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inCore = /^\[\s*core\s*\]$/i.test(trimmed);
      continue;
    }
    if (!inCore) continue;
    const match = /^worktree\s*=\s*(.+?)\s*$/i.exec(trimmed);
    if (match === null) continue;
    if (worktree !== undefined) return undefined;
    const candidate = match[1]!;
    if (candidate.includes('\0') || candidate.startsWith('"') || candidate.endsWith('"')) {
      return undefined;
    }
    worktree = candidate;
  }
  return worktree === undefined
    ? undefined
    : realpathSync(path.resolve(gitdir, worktree));
}

function isStructurallyBoundSubmoduleGitDirectory(gitdir: string, workspaceRoot: string): boolean {
  if (!/[/\\]\.git[/\\]modules[/\\]/i.test(gitdir)) return false;
  const linkedWorktree = submoduleGitWorktree(gitdir);
  return linkedWorktree !== undefined && sameWindowsPath(linkedWorktree, workspaceRoot);
}

/** Grant only gitfile targets whose external metadata proves its workspace relationship. */
function windowsLinkedWorktreeGitAccess(
  workspaceRoot: string,
): { readonly mainGitDirectory?: string; readonly gitfile?: string } {
  if (process.platform !== 'win32') return {};
  const gitLink = path.join(workspaceRoot, '.git');
  try {
    if (!lstatSync(gitLink).isFile()) return {};
    const content = readBoundedUtf8File(gitLink, 4_096);
    if (content === undefined) return {};
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
    if (match === null) return {};
    const gitdir = realpathSync(path.resolve(workspaceRoot, match[1]!));
    const linkedMainGit = linkedWorktreeMainGitDirectory(gitdir, gitLink);
    const submodule = isStructurallyBoundSubmoduleGitDirectory(gitdir, workspaceRoot);
    if (linkedMainGit === undefined && !submodule) return {};
    const mainGitDirectory = linkedMainGit ?? gitdir;
    if (!statSync(mainGitDirectory).isDirectory()) return {};
    if (!statSync(path.join(mainGitDirectory, 'HEAD')).isFile()) return {};
    return { mainGitDirectory, gitfile: gitLink };
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return {};
    throw error;
  }
}

function workspaceShellSandboxConfig(
  workspaceRoot: string,
  shellTempDirectory: string | undefined,
  agentHomeAccess?: AsrtShellAgentHomeAccess,
  filesystemAccess?: AsrtShellSandboxSelection['filesystemAccess'],
  runtimeReadScopes = workspaceShellRuntimeReadScopes(
    process.env,
    workspaceShellExecutable(),
  ),
  trustedProjectExecPolicyPath?: string,
): SandboxRuntimeConfig {
  const agentHome = path.resolve(getAgentConfigHome());
  const controlDirectory = path.join(agentHome, 'sandbox-runtime');
  const home = path.resolve(
    process.platform === 'win32' ? process.env.USERPROFILE ?? os.homedir() : os.homedir(),
  );
  const denyRead: string[] = [];
  const scopedAgentHomeAccess = process.platform === 'win32'
    ? windowsAgentHomeAccessRoots(agentHome, agentHomeAccess)
    : { read: [], write: [] };
  const writeRoots = workspaceShellWriteRoots(
    [
      workspaceRoot,
      ...workspaceShellTempWriteRoots(shellTempDirectory),
      ...scopedAgentHomeAccess.write,
      ...(filesystemAccess?.write ?? []),
    ],
    agentHome,
  );
  const linkedGit = windowsLinkedWorktreeGitAccess(workspaceRoot);
  const allowReadCandidates = [
      ...(process.platform === 'win32'
        ? [...windowsSandboxProfileReadRoots(home), agentHome]
        : []),
      ...runtimeReadScopes,
      ...scopedAgentHomeAccess.read,
      ...(filesystemAccess?.read ?? []),
      ...(linkedGit.mainGitDirectory !== undefined
        ? [linkedGit.mainGitDirectory]
        : []),
  ];
  const allowRead = process.platform === 'win32'
    ? existingMinimalWindowsAclGuardRoots(allowReadCandidates)
    : [...new Set(allowReadCandidates)];
  return {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: false,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite: writeRoots,
      denyWrite: [
        controlDirectory,
        ...trustedTextNativeArtifactStateRoots(),
        ...WORKSPACE_SHELL_INTERNAL_AGENT_HOME_DIRECTORIES.map(
          (directory) => path.join(agentHome, directory),
        ),
        ...trustedProjectExecPolicyDenyWrite(trustedProjectExecPolicyPath),
        ...existingWorkspaceDenyWrites(workspaceRoot),
        ...(linkedGit.gitfile !== undefined ? [linkedGit.gitfile] : []),
      ],
    },
  };
}

function boundedWindowsWorkspaceDenies(
  config: SandboxRuntimeConfig,
): SandboxRuntimeConfig {
  const writeRoots = config.filesystem.allowWrite;
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      // Existing sensitive roots are guarded once for the dedicated sandbox
      // SID. No glob expansion or child enumeration occurs; explicit denies
      // remain authoritative over any overlapping grant.
      denyRead: config.filesystem.denyRead,
      denyWrite: config.filesystem.denyWrite.filter((denied) => (
        writeRoots.some((granted) => isInside(granted, denied))
      )),
    },
  };
}

function workspaceShellCommandSandboxConfig(
  workspaceRoot: string,
  shellTempDirectory: string | undefined,
  agentHomeAccess?: AsrtShellAgentHomeAccess,
  filesystemAccess?: AsrtShellSandboxSelection['filesystemAccess'],
  runtimeReadScopes?: readonly string[],
  trustedProjectExecPolicyPath?: string,
): SandboxRuntimeConfig {
  const config = workspaceShellSandboxConfig(
    workspaceRoot,
    shellTempDirectory,
    agentHomeAccess,
    filesystemAccess,
    runtimeReadScopes,
    trustedProjectExecPolicyPath,
  );
  return process.platform === 'win32'
    ? boundedWindowsWorkspaceDenies(config)
    : config;
}

function workspaceShellFilesystemAccessIsRepresentable(
  filesystemAccess: AsrtShellSandboxSelection['filesystemAccess'],
): boolean {
  if (process.platform !== 'win32') return true;
  return (filesystemAccess?.write ?? []).every((candidate) => {
    try {
      realpathSync.native(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

function normalizedSandboxPaths(
  values: readonly string[] | undefined,
  cwd: string,
): string[] {
  return [...new Set((values ?? []).map((value) => (
    path.resolve(cwd, value)
  )))];
}

function sdkSandboxEndpoints(network: KodaXSandboxNetworkPolicy): SandboxEndpoint[] {
  if (network.mode !== 'allowlist') return [];
  return network.origins.map((origin) => {
    const url = new URL(origin);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      throw new Error(`Sandbox network origin must be an HTTP(S) origin: ${origin}`);
    }
    return {
      host: url.hostname.toLowerCase(),
      port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    };
  });
}

async function runWindowsV2Sandboxed(
  input: KodaXSandboxRunInput,
  cwd: string,
  env: NodeJS.ProcessEnv,
  network: KodaXSandboxNetworkPolicy,
  endpoints: readonly SandboxEndpoint[],
): Promise<SandboxProcessResult> {
  const deadlineAt = Date.now() + (input.timeoutMs ?? SCRIPT_TIMEOUT_MS);
  const targetLaunch = input.command === process.execPath
    ? prepareInternalNodeLaunch({
        args: input.args ?? [],
        env,
        isElectron: process.versions.electron !== undefined,
      })
    : { args: [...(input.args ?? [])], env };
  const shellPolicy: SandboxRuntimeConfig = {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      strictAllowlist: network.mode === 'deny',
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: {
      allowRead: normalizedSandboxPaths(input.filesystem.allowRead, cwd),
      allowWrite: normalizedSandboxPaths(input.filesystem.allowWrite, cwd),
      denyRead: normalizedSandboxPaths(input.filesystem.denyRead, cwd),
      denyWrite: normalizedSandboxPaths(input.filesystem.denyWrite, cwd),
    },
  };
  const prepared = await prepareWindowsV2Invocation({
    shellPolicy,
    executable: input.command,
    args: targetLaunch.args,
    cwd,
    env: targetLaunch.env,
    endpoints,
    allowAllNetwork: network.mode === 'allow',
    signal: input.signal,
    deadlineAt,
  });
  if (prepared === undefined) throw new Error('Windows native sandbox invocation was not prepared.');
  let cleanupExecution: 'not_started' | 'started_or_unknown' = 'not_started';
  let executionFailure: unknown;
  let nativeHostFailure: Error | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    if (prepared.processControl === undefined) {
      throw new Error('Windows native sandbox invocation has no persistent process control.');
    }
    const processControl = prepared.processControl;
    await processControl.validateStart?.();
    child = spawn(prepared.executable, [...prepared.args], {
      cwd,
      env: prepared.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments === true,
    });
    cleanupExecution = 'started_or_unknown';
    rememberChildProcessTree(child);
    const result = collectProcess(
      child,
      input.signal,
      Math.max(1, deadlineAt - Date.now()),
      input.maxOutputBytes ?? MAX_OUTPUT_BYTES,
      true,
      processControl,
    );
    // Controller/host loss may reject collection before closeInput finishes its
    // bounded stderr drain. Attach the observer now; the authoritative await and
    // error propagation remain below.
    void result.catch(() => undefined);
    try {
      await processControl.closeInput(child, input.signal, deadlineAt);
    } catch (deliveryError: unknown) {
      let finalError = deliveryError;
      try {
        await processControl.terminate(child);
      } catch (terminationError: unknown) {
        finalError = new AggregateError(
          [deliveryError, terminationError],
          'Native sandbox bootstrap and termination both failed.',
        );
      }
      await result.catch(() => undefined);
      throw finalError;
    }
    const start = await processControl.attestStart?.(child, input.signal, deadlineAt);
    if (start?.state === 'pre_start_unavailable') {
      cleanupExecution = 'not_started';
      throw new Error(start.diagnostic);
    }
    const collected = await result;
    if (collected.exitCode !== 0) {
      const internalDiagnostic = collected.stderr
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('kodax-windows-sandbox protocol '))
        .slice(-4)
        .join('\n');
      nativeHostFailure = new Error(
        internalDiagnostic.length > 0
          ? internalDiagnostic
          : `Windows native sandbox host exited with code ${collected.exitCode}.`,
      );
    }
    return collected;
  } catch (error: unknown) {
    executionFailure = error;
    if (child !== undefined && prepared.processControl !== undefined) {
      try {
        await prepared.processControl.terminate(child);
      } catch (terminationError: unknown) {
        executionFailure = new AggregateError(
          [error, terminationError],
          'Windows native sandbox execution and termination both failed.',
        );
      }
    }
    throw executionFailure;
  } finally {
    try {
      await prepared.cleanup({ execution: cleanupExecution });
    } catch (cleanupError: unknown) {
      if (executionFailure !== undefined) {
        throw new AggregateError(
          [executionFailure, cleanupError],
          'Windows native sandbox execution and cleanup both failed.',
        );
      }
      if (nativeHostFailure !== undefined) {
        throw new AggregateError(
          [nativeHostFailure, cleanupError],
          'Windows native sandbox host and cleanup both failed.',
        );
      }
      throw cleanupError;
    }
  }
}

/**
 * Public SDK executor. An unavailable sandbox is returned as structured state;
 * this function never runs the command without containment.
 */
export async function runKodaXSandboxed(
  input: KodaXSandboxRunInput,
): Promise<KodaXSandboxRunResult> {
  if (!input.command.trim()) throw new Error('Sandbox command must not be empty.');
  if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) {
    throw new Error('Sandbox timeoutMs must be a positive finite number.');
  }
  if (
    input.maxOutputBytes !== undefined
    && (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes <= 0)
  ) {
    throw new Error('Sandbox maxOutputBytes must be a positive safe integer.');
  }
  const cwd = path.resolve(input.cwd);
  const protectedTextStateRoots = process.platform === 'win32'
    ? []
    : trustedTextNativeArtifactStateRoots();
  const normalizedFilesystem: KodaXSandboxFilesystemPolicy = {
    allowRead: normalizedSandboxPaths(input.filesystem.allowRead, cwd),
    allowWrite: normalizedSandboxPaths(input.filesystem.allowWrite, cwd),
    denyRead: normalizedSandboxPaths(input.filesystem.denyRead, cwd),
    denyWrite: normalizedSandboxPaths(input.filesystem.denyWrite, cwd),
  };
  if (process.platform === 'win32') {
    assertWindowsSandboxControlStateNotDirectlyAccessible(normalizedFilesystem);
  }
  if (process.platform !== 'win32') {
    assertTrustedTextNativeStateNotDirectlyReadable(normalizedFilesystem.allowRead);
  }
  assertTrustedTextNativeStateNotDirectlyWritable(normalizedFilesystem.allowWrite);
  const protectedFilesystem = {
    ...normalizedFilesystem,
    denyRead: [
      ...(normalizedFilesystem.denyRead ?? []),
      ...protectedTextStateRoots,
    ],
    denyWrite: [
      ...(normalizedFilesystem.denyWrite ?? []),
      ...protectedTextStateRoots,
    ],
  };
  const network = input.network ?? { mode: 'deny' };
  const endpoints = sdkSandboxEndpoints(network);
  const doctor = await doctorSandboxRuntime();
  if (!doctor.ready) {
    return {
      status: 'unavailable',
      sandboxed: false,
      doctor,
      reason: 'doctor_not_ready',
    };
  }
  const env = mergeSandboxEnvironment(
    input.inheritEnvironment !== false ? process.env : sanitizedEnvironment(),
    input.env ?? {},
  );
  if (process.platform === 'win32') {
    const result = await runWindowsV2Sandboxed(
      { ...input, filesystem: protectedFilesystem },
      cwd,
      env,
      network,
      endpoints,
    );
    return {
      status: 'completed',
      sandboxed: true,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  const request: SandboxBrokerRequest = {
    config: withPreparedWindowsRunner({
      network: {
        allowedDomains: [],
        deniedDomains: [],
        strictAllowlist: network.mode === 'deny',
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
      filesystem: {
        allowRead: normalizedSandboxPaths(protectedFilesystem.allowRead, cwd),
        allowWrite: normalizedSandboxPaths(protectedFilesystem.allowWrite, cwd),
        denyRead: normalizedSandboxPaths(protectedFilesystem.denyRead, cwd),
        denyWrite: normalizedSandboxPaths(protectedFilesystem.denyWrite, cwd),
      },
    }),
    command: input.command,
    args: input.args ?? [],
    cwd,
    env,
    endpoints,
    allowAllNetwork: network.mode === 'allow',
    observationBackend: sandboxRuntimeCapability().backend,
    targetStartedMarker: `\0KODAX_ASRT_TARGET_STARTED:${randomUUID()}\0\n`,
  };
  const result = await runBrokerResult(
    request,
    input.signal,
    input.timeoutMs ?? SCRIPT_TIMEOUT_MS,
    input.maxOutputBytes ?? MAX_OUTPUT_BYTES,
  );
  let observation: SandboxBrokerControlObservation | undefined;
  let controlFailure: unknown = result.controlFailure;
  if (controlFailure === undefined) {
    try {
      observation = parseSandboxBrokerControl(
        result.controlOutput,
        result.controlInvocationId,
        result.expectedBackend,
      );
    } catch (error: unknown) {
      controlFailure = error;
    }
  }
  if (observation?.state === 'not_started') {
    const diagnostic = [
      observation.diagnostic,
      result.stderr.trim(),
    ].filter((value): value is string => value !== undefined && value !== '')
      .join(' ')
      .slice(0, 4096) || 'The sandbox backend exited before target-start attestation.';
    return {
      status: 'unavailable',
      sandboxed: false,
      reason: 'backend_launch_failed',
      diagnostic,
      doctor: {
        ...doctor,
        ready: false,
        setupRequired: true,
        diagnostics: [...doctor.diagnostics, diagnostic],
      },
    };
  }
  if (observation?.state !== 'applied') {
    const diagnostic = [
      controlFailure === undefined ? undefined : errorText(controlFailure),
      result.stderr.trim(),
    ].filter((value): value is string => value !== undefined && value !== '')
      .join(' ')
      .slice(0, 4096) || 'Sandbox target execution could not be attested; do not retry blindly.';
    return {
      status: 'execution_uncertain',
      sandboxed: false,
      reason: 'attestation_failed',
      diagnostic,
      doctor,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return {
    status: 'completed',
    sandboxed: true,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function sandboxRunnerPreparationTimeoutError(): Error {
  const error = new Error('Sandbox runner preparation timed out.');
  error.name = 'TimeoutError';
  return error;
}

function throwIfSandboxRunnerPreparationStopped(
  signal?: AbortSignal,
  deadlineAt?: number,
): void {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw sandboxRunnerPreparationTimeoutError();
  }
}

function waitForSandboxRunnerPreparation<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<T> {
  throwIfSandboxRunnerPreparationStopped(signal, deadlineAt);
  if (signal === undefined && deadlineAt === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = (): void => {
      finish(() => reject(new DOMException('Operation aborted', 'AbortError')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (deadlineAt !== undefined) {
      timer = setTimeout(() => {
        finish(() => reject(sandboxRunnerPreparationTimeoutError()));
      }, Math.max(0, deadlineAt - Date.now()));
      timer.unref();
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function sandboxControlDirectory(): Promise<string> {
  return ensureWindowsSandboxControlDirectory();
}

function windowsNetworkBrokerEntryArgs(initFile: string): string[] {
  if (process.env.KODAX_BUNDLED === 'true') {
    return ['__asrt-windows-network-broker', initFile];
  }
  if (import.meta.url.endsWith('.ts')) {
    return [
      '--import',
      pathToFileURL(moduleRequire.resolve('tsx')).href,
      fileURLToPath(new URL('./sandbox-network-broker-entry.ts', import.meta.url)),
      initFile,
    ];
  }
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const distributionDirectory = path.basename(currentDirectory) === 'chunks'
    ? path.dirname(currentDirectory)
    : currentDirectory;
  return [path.join(distributionDirectory, 'sandbox-network-broker.js'), initFile];
}

async function readWindowsNetworkBrokerReady(
  child: ReturnType<typeof spawn>,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<WindowsNetworkBrokerReady> {
  const control = child.stdio[3];
  if (!control) throw new Error('Windows network broker control pipe was not created.');
  return new Promise<WindowsNetworkBrokerReady>((resolve, reject) => {
    let settled = false;
    let buffered = Buffer.alloc(0);
    let timer: NodeJS.Timeout | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      control.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      action();
    };
    const onAbort = (): void => finish(() => reject(
      signal?.reason ?? new DOMException('Operation aborted', 'AbortError'),
    ));
    const onError = (error: Error): void => finish(() => reject(error));
    const onExit = (code: number | null): void => finish(() => reject(new Error(
      `Windows network broker exited ${String(code)} before readiness.`,
    )));
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 1024 * 1024) {
        finish(() => reject(new Error('Windows network broker readiness exceeded 1 MiB.')));
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const ready = JSON.parse(buffered.subarray(0, newline).toString('utf8')) as unknown;
        if (ready === null || typeof ready !== 'object' || (ready as { version?: unknown }).version !== 1) {
          throw new Error('Windows network broker returned an incompatible response.');
        }
        finish(() => resolve(ready as WindowsNetworkBrokerReady));
      } catch (error: unknown) {
        finish(() => reject(error));
      }
    };
    control.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (deadlineAt !== undefined) {
      timer = setTimeout(
        () => finish(() => reject(sandboxRunnerPreparationTimeoutError())),
        Math.max(0, deadlineAt - Date.now()),
      );
      timer.unref();
    }
  });
}

async function stopWindowsNetworkBroker(
  child: ReturnType<typeof spawn>,
  exit: Promise<WindowsNetworkBrokerExit>,
  stderrTail: () => string,
): Promise<void> {
  const assertCleanExit = (outcome: WindowsNetworkBrokerExit): void => {
    if (outcome.error !== undefined || outcome.code !== 0 || outcome.signal !== null) {
      const diagnostic = stderrTail().trim();
      throw new Error(
        `Windows network broker exited without a clean cleanup result `
        + `(code ${String(outcome.code)}, signal ${String(outcome.signal)})`
        + (diagnostic === '' ? '.' : `: ${diagnostic}`),
        outcome.error === undefined ? undefined : { cause: outcome.error },
      );
    }
  };
  if (child.exitCode !== null || child.signalCode !== null) {
    assertCleanExit(await exit);
    return;
  }
  await new Promise<void>((resolve) => {
    const stdin = child.stdin;
    if (stdin === null || stdin.destroyed) {
      resolve();
      return;
    }
    const finish = (): void => resolve();
    stdin.once('error', finish);
    stdin.end(finish);
  });
  const graceful = await Promise.race([
    exit.then((outcome) => ({ graceful: true as const, outcome })),
    new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      timer.unref();
    }),
  ]);
  if (graceful !== false) {
    assertCleanExit(graceful.outcome);
    return;
  }
  const termination = await killChildProcessTree(child, { forceMs: 500, taskkillMs: 500 });
  if (termination.status === 'unknown') {
    throw new Error('Windows network broker process-tree termination was not confirmed.');
  }
  await exit;
  throw new Error('Windows network broker did not exit within its graceful cleanup budget.');
}

function normalizedWindowsNetworkBrokerRequest(
  request: WindowsNetworkBrokerRequest,
): WindowsNetworkBrokerRequest {
  return {
    ...request,
    srtWinPath: path.resolve(request.srtWinPath),
    srtWinSha256: request.srtWinSha256.toLowerCase(),
    controllerExecutable: path.resolve(request.controllerExecutable),
    controllerSha256: request.controllerSha256.toLowerCase(),
    endpoints: [...request.endpoints]
      .map(({ host, port }) => ({ host: host.toLowerCase(), port }))
      .sort((left, right) => (
        left.host.localeCompare(right.host) || left.port - right.port
      ))
      .filter((endpoint, index, endpoints) => (
        index === 0
        || endpoint.host !== endpoints[index - 1]!.host
        || endpoint.port !== endpoints[index - 1]!.port
      )),
  };
}

function canonicalWindowsNetworkBrokerValue(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Windows network broker policy number is invalid.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalWindowsNetworkBrokerValue(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => (
      `${JSON.stringify(key)}:${canonicalWindowsNetworkBrokerValue(item)}`
    )).join(',')}}`;
  }
  throw new Error('Windows network broker policy contains an unsupported value.');
}

function windowsNetworkBrokerKey(request: WindowsNetworkBrokerRequest): string {
  const normalized = normalizedWindowsNetworkBrokerRequest(request);
  // With filesystem authority disabled, ASRT uses cwd only for safe.directory.
  // KodaX replaces that environment per native target, so cwd is deliberately
  // excluded while every network/account authority input remains in the key.
  const serialized = canonicalWindowsNetworkBrokerValue({
    version: normalized.version,
    setupGenerationNonce: normalized.setupGenerationNonce,
    config: normalized.config,
    srtWinPath: path.resolve(normalized.srtWinPath).toLowerCase(),
    srtWinSha256: normalized.srtWinSha256,
    controllerExecutable: normalized.controllerExecutable.toLowerCase(),
    controllerSha256: normalized.controllerSha256,
    controllerProtocol: normalized.controllerProtocol,
    expectedSandboxUserSid: normalized.expectedSandboxUserSid.toUpperCase(),
    expectedSandboxGroupSid: normalized.expectedSandboxGroupSid.toUpperCase(),
    endpoints: normalized.endpoints,
    allowAllNetwork: normalized.allowAllNetwork,
  });
  return createHash('sha256').update(serialized).digest('hex');
}

function createWindowsNetworkBrokerState(
  key: string,
  request: WindowsNetworkBrokerRequest,
  controlDirectory: string,
): WindowsNetworkBrokerState {
  let markStarted = (): void => undefined;
  const state: WindowsNetworkBrokerState = {
    key,
    requestFile: path.join(
      controlDirectory,
      `windows-network-${process.pid}-${randomUUID()}.json`,
    ),
    started: new Promise<void>((resolve) => { markStarted = resolve; }),
    markStarted: () => markStarted(),
    references: 0,
    failed: false,
    lastUsed: 0,
    stopRequested: false,
    stderrTail: Buffer.alloc(0),
  };
  state.ready = (async () => {
    try {
      await writeFile(state.requestFile, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
      if (state.stopRequested) throw new Error('Windows network broker start was cancelled.');
      const launch = prepareInternalNodeLaunch({
        args: windowsNetworkBrokerEntryArgs(state.requestFile),
        env: sanitizedEnvironment(),
        isElectron: process.versions.electron !== undefined,
      });
      const child = spawn(process.execPath, launch.args, {
        cwd: controlDirectory,
        env: launch.env,
        shell: false,
        stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      state.child = child;
      rememberChildProcessTree(child);
      state.markStarted();
      child.stderr?.on('data', (chunk: Buffer) => {
        state.stderrTail = Buffer.concat([state.stderrTail, chunk]).subarray(-16 * 1024);
      });
      state.exit = new Promise<WindowsNetworkBrokerExit>((resolve) => {
        let processError: Error | undefined;
        child.once('error', (error) => { processError = error; });
        child.once('close', (code, signal) => resolve({
          code,
          signal,
          ...(processError === undefined ? {} : { error: processError }),
        }));
      });
      if (state.references === 0) setWindowsNetworkBrokerReferenced(state, false);
      child.on('error', (error) => {
        emitKodaXDiagnostic({
          source: 'sandbox:windows-v2',
          level: 'warn',
          message: 'Shared Windows network broker process failed.',
          detail: error,
        });
      });
      child.once('exit', (code, signal) => {
        if (state.stopping === undefined && windowsNetworkBrokers.get(key) === state) {
          windowsNetworkBrokers.delete(key);
        }
        if (!state.stopRequested && (code !== 0 || signal !== null)) {
          retireWindowsNetworkBrokerState(state);
          emitKodaXDiagnostic({
            source: 'sandbox:windows-v2',
            level: 'warn',
            message: 'Shared Windows network broker exited unexpectedly.',
            detail: state.stderrTail.toString('utf8').trim()
              || `code ${String(code)}, signal ${String(signal)}`,
          });
        }
      });
      let ready: WindowsNetworkBrokerReady;
      try {
        ready = await readWindowsNetworkBrokerReady(
          child,
          undefined,
          Date.now() + WINDOWS_V2_LAUNCH_TIMEOUT_MS,
        );
      } catch (error: unknown) {
        const diagnostic = state.stderrTail.toString('utf8').trim();
        throw new Error(
          diagnostic === ''
            ? 'Windows network broker failed before readiness.'
            : `Windows network broker failed before readiness: ${diagnostic}`,
          { cause: error },
        );
      }
      if (!ready.ok) throw new Error(ready.error);
      return ready;
    } finally {
      state.markStarted();
    }
  })().catch((error: unknown) => {
    retireWindowsNetworkBrokerState(state);
    throw error;
  });
  void state.ready.catch(() => undefined);
  return state;
}

async function stopSharedWindowsNetworkBroker(state: WindowsNetworkBrokerState): Promise<void> {
  if (state.stopping !== undefined) return state.stopping;
  if (state.idleTimer !== undefined) {
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }
  state.stopRequested = true;
  state.stopping = (async () => {
    await state.started;
    setWindowsNetworkBrokerReferenced(state, true);
    const results = await Promise.allSettled([
      ...(state.child === undefined || state.exit === undefined
        ? []
        : [stopWindowsNetworkBroker(
            state.child,
            state.exit,
            () => state.stderrTail.toString('utf8'),
          )]),
      rm(state.requestFile, { force: true }),
    ]);
    const failures = results.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    ));
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Shared Windows network broker cleanup failed.');
    }
  })().finally(() => {
    setWindowsNetworkBrokerReferenced(state, false);
    if (windowsNetworkBrokers.get(state.key) === state) {
      windowsNetworkBrokers.delete(state.key);
    }
  });
  return state.stopping;
}

async function releaseWindowsNetworkBrokerState(
  state: WindowsNetworkBrokerState,
  retireIfLast = false,
): Promise<void> {
  state.references = Math.max(0, state.references - 1);
  if (state.references !== 0) return;
  if (retireIfLast) retireWindowsNetworkBrokerState(state);
  setWindowsNetworkBrokerReferenced(state, false);
  touchWindowsNetworkBroker(state);
  if (state.failed) {
    await stopSharedWindowsNetworkBroker(state);
    return;
  }
  state.idleTimer = setTimeout(() => {
    state.idleTimer = undefined;
    if (state.references !== 0 || state.stopping !== undefined) return;
    void stopSharedWindowsNetworkBroker(state).catch((error: unknown) => {
      emitKodaXDiagnostic({
        source: 'sandbox:windows-v2',
        level: 'warn',
        message: 'Idle Windows network broker cleanup failed.',
        detail: error,
      });
    });
  }, WINDOWS_NETWORK_BROKER_IDLE_GRACE_MS);
  state.idleTimer.unref();
}

async function evictIdleWindowsNetworkBroker(
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<void> {
  if (windowsNetworkBrokers.size < WINDOWS_NETWORK_BROKER_CAPACITY) return;
  const idle = [...windowsNetworkBrokers.values()]
    .filter((state) => state.references === 0 && state.stopping === undefined)
    .sort((left, right) => left.lastUsed - right.lastUsed)[0];
  if (idle === undefined) {
    const stopping = [...windowsNetworkBrokers.values()]
      .flatMap((state) => state.stopping === undefined ? [] : [state.stopping]);
    if (stopping.length > 0) {
      await waitForSandboxRunnerPreparation(
        Promise.race(stopping),
        signal,
        deadlineAt,
      );
      return;
    }
    throw new Error(
      'Windows network broker capacity is fully active; no command was started.',
    );
  }
  await waitForSandboxRunnerPreparation(
    stopSharedWindowsNetworkBroker(idle),
    signal,
    deadlineAt,
  );
}

async function acquireWindowsNetworkBroker(
  request: WindowsNetworkBrokerRequest,
  controlDirectory: string,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<WindowsNetworkBrokerLease> {
  const normalized = normalizedWindowsNetworkBrokerRequest(request);
  const key = windowsNetworkBrokerKey(normalized);
  while (true) {
    let state = windowsNetworkBrokers.get(key);
    if (state?.stopping !== undefined) {
      await waitForSandboxRunnerPreparation(state.stopping, signal, deadlineAt);
      continue;
    }
    if (state?.failed) {
      if (state.references !== 0) {
        throw new Error(
          'Windows network broker failed while prior command leases are still settling; no command was started.',
        );
      }
      await waitForSandboxRunnerPreparation(
        stopSharedWindowsNetworkBroker(state),
        signal,
        deadlineAt,
      );
      continue;
    }
    if (state === undefined) {
      if (windowsNetworkBrokers.size >= WINDOWS_NETWORK_BROKER_CAPACITY) {
        await evictIdleWindowsNetworkBroker(signal, deadlineAt);
        continue;
      }
      state = createWindowsNetworkBrokerState(key, normalized, controlDirectory);
      windowsNetworkBrokers.set(key, state);
    }
    touchWindowsNetworkBroker(state);
    if (state.idleTimer !== undefined) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
    state.references += 1;
    if (state.references === 1) setWindowsNetworkBrokerReferenced(state, true);
    let released = false;
    const release = async (options?: { readonly retireIfLast?: boolean }): Promise<void> => {
      if (released) return;
      released = true;
      await releaseWindowsNetworkBrokerState(state, options?.retireIfLast === true);
    };
    try {
      const readyPromise = state.ready;
      if (readyPromise === undefined) throw new Error('Windows network broker did not start.');
      const ready = await waitForSandboxRunnerPreparation(readyPromise, signal, deadlineAt);
      return {
        ready,
        release,
      };
    } catch (error: unknown) {
      try {
        await release();
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          'Windows network broker acquisition and cleanup both failed.',
        );
      }
      throw error;
    }
  }
}

async function prepareWindowsV2ShellInvocation(input: {
  readonly workspaceRoot: string;
  readonly agentHomeAccess: AsrtShellAgentHomeAccess | undefined;
  readonly filesystemAccess: AsrtShellSandboxSelection['filesystemAccess'];
  readonly trustedProjectExecPolicyPath: string | undefined;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}): Promise<Awaited<ReturnType<KodaXShellSandbox['prepare']>>> {
  const runtimeReadScopes = windowsNativeRuntimeReadScopes(
    workspaceShellRuntimeReadScopes(input.env, input.executable),
  );
  const shellPolicy = workspaceShellCommandSandboxConfig(
    input.workspaceRoot,
    undefined,
    input.agentHomeAccess,
    input.filesystemAccess,
    runtimeReadScopes,
    input.trustedProjectExecPolicyPath,
  );
  return prepareWindowsV2Invocation({
    shellPolicy,
    executable: input.executable,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    endpoints: [],
    allowAllNetwork: true,
    signal: input.signal,
    deadlineAt: input.deadlineAt,
  });
}

async function prepareWindowsV2Invocation(input: {
  readonly shellPolicy: SandboxRuntimeConfig;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly endpoints: readonly SandboxEndpoint[];
  readonly allowAllNetwork: boolean;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}): Promise<Awaited<ReturnType<KodaXShellSandbox['prepare']>>> {
  const preparationDeadlineAt = input.deadlineAt
    ?? Date.now() + WINDOWS_V2_LAUNCH_TIMEOUT_MS;
  const runner = await waitForSandboxRunnerPreparation(
    prepareWindowsSandboxRunner(input.shellPolicy.filesystem.allowWrite),
    input.signal,
    preparationDeadlineAt,
  );
  throwIfSandboxRunnerPreparationStopped(input.signal, preparationDeadlineAt);
  const cutover = currentWindowsSandboxV2Cutover(runner);
  throwIfSandboxRunnerPreparationStopped(input.signal, preparationDeadlineAt);
  const shellPolicy = withPreparedWindowsRunner(input.shellPolicy);
  assertWindowsSandboxControlStateNotDirectlyAccessible({
    allowRead: shellPolicy.filesystem.allowRead,
    allowWrite: shellPolicy.filesystem.allowWrite,
    denyRead: shellPolicy.filesystem.denyRead,
    denyWrite: shellPolicy.filesystem.denyWrite,
  });
  assertWindowsNativeArtifactStoreNotDirectlyWritable(shellPolicy.filesystem.allowWrite);
  const shellArtifact = await waitForSandboxRunnerPreparation(
    prepareWindowsShellArtifact(
      cutover.sandboxGroupSid,
      shellPolicy.filesystem.allowWrite,
    ),
    input.signal,
    preparationDeadlineAt,
  );
  throwIfSandboxRunnerPreparationStopped(input.signal, preparationDeadlineAt);
  const controlDirectory = await waitForSandboxRunnerPreparation(
    prepareWindowsControlDirectory(),
    input.signal,
    preparationDeadlineAt,
  );
  throwIfSandboxRunnerPreparationStopped(input.signal, preparationDeadlineAt);
  if (controlDirectory.toLowerCase() !== windowsSandboxControlDirectory().toLowerCase()) {
    throw new Error('Windows native shell control state resolved to an unexpected path.');
  }
  const brokerRequest: WindowsNetworkBrokerRequest = {
    version: 1,
    setupGenerationNonce: cutover.generationNonce,
    config: asrtWindowsNetworkOnlyConfig(shellPolicy),
    cwd: input.cwd,
    srtWinPath: runner.path,
    srtWinSha256: runner.sha256,
    controllerExecutable: shellArtifact.path,
    controllerSha256: shellArtifact.sha256,
    controllerProtocol: WINDOWS_SANDBOX_V2_PROTOCOL,
    expectedSandboxUserSid: cutover.sandboxUserSid,
    expectedSandboxGroupSid: cutover.sandboxGroupSid,
    endpoints: input.endpoints,
    allowAllNetwork: input.allowAllNetwork,
  };
  let brokerLease: WindowsNetworkBrokerLease | undefined;
  let nativeRequestFile: string | undefined;
  let nativeTerminalRecordFile: string | undefined;
  try {
    brokerLease = await acquireWindowsNetworkBroker(
      brokerRequest,
      controlDirectory,
      input.signal,
      preparationDeadlineAt,
    );
    const ready = brokerLease.ready;
    if (
      ready.sandboxUserSid !== cutover.sandboxUserSid
      || ready.sandboxGroupSid !== cutover.sandboxGroupSid
    ) {
      throw windowsSandboxV2CutoverError(
        'The broker observed a sandbox account identity from another v2 generation',
      );
    }
    const generation = windowsSandboxV2Generation({
      setupGenerationNonce: cutover.generationNonce,
      sandboxUserSid: ready.sandboxUserSid,
      sandboxGroupSid: ready.sandboxGroupSid,
      asrtSha256: runner.sha256,
      shellSha256: shellArtifact.sha256,
    });
    nativeRequestFile = path.join(
      controlDirectory,
      `windows-shell-${process.pid}-${randomUUID()}.json`,
    );
    const recordIdentity = `${process.pid}-${randomUUID()}.json`;
    nativeTerminalRecordFile = path.join(controlDirectory, `windows-terminal-${recordIdentity}`);
    const nativeStartedRecordFile = path.join(controlDirectory, `windows-started-${recordIdentity}`);
    const nativeResumeRecordFile = path.join(controlDirectory, `windows-resume-${recordIdentity}`);
    const terminalNonce = randomUUID();
    const operationDeadlineUnixMs = input.deadlineAt ?? preparationDeadlineAt;
    const targetEnvironment = mergeWindowsSandboxTargetEnvironment(
      ready.asrtChildEnvironment,
      input.env,
      windowsGitTrustRoots(
        input.cwd,
        shellPolicy.filesystem.allowWrite,
        shellPolicy.filesystem.allowRead,
      ),
    );
    const nativeRequest = createWindowsSandboxV2RunRequest({
      generation,
      filesystemCapabilityNonce: cutover.filesystemCapabilityNonce,
      sandboxUserSid: ready.sandboxUserSid,
      sandboxGroupSid: ready.sandboxGroupSid,
      asrtInvocation: {
        executable: ready.asrtExecutable,
        prefixArgs: ready.asrtPrefixArgs,
        targetArgv: [],
        childEnvironment: {},
      },
      targetArgv: [input.executable, ...input.args],
      cwd: input.cwd,
      allowRead: shellPolicy.filesystem.allowRead,
      allowWrite: shellPolicy.filesystem.allowWrite,
      denyRead: shellPolicy.filesystem.denyRead,
      denyWrite: shellPolicy.filesystem.denyWrite,
      controllerPipe: ready.controllerPipe,
      terminalRecordPath: nativeTerminalRecordFile,
      terminalNonce,
      operationDeadlineUnixMs,
      setupMarkerPath: windowsSandboxV2CutoverMarkerFile(),
      setupMarkerSha256: createHash('sha256')
        .update(readFileSync(windowsSandboxV2CutoverMarkerFile()))
        .digest('hex'),
    });
    await writeFile(nativeRequestFile, JSON.stringify(nativeRequest), { flag: 'wx', mode: 0o600 });
    throwIfSandboxRunnerPreparationStopped(input.signal, operationDeadlineUnixMs);
    let cleanupPromise: Promise<KodaXShellSandboxObservation | undefined> | undefined;
    const ownedBrokerLease = brokerLease;
    const ownedRequestFile = nativeRequestFile;
    const ownedTerminalRecordFile = nativeTerminalRecordFile;
    const bootstrap = encodeWindowsSandboxV2Bootstrap(targetEnvironment);
    const processControl = createWindowsV2ProcessControl(
      bootstrap,
      nativeResumeRecordFile,
      nativeStartedRecordFile,
      ownedTerminalRecordFile,
      terminalNonce,
      () => {
        const current = currentWindowsSandboxV2Cutover(runner);
        if (JSON.stringify(current) !== JSON.stringify(cutover)) {
          throw windowsSandboxV2CutoverError(
            'The Windows sandbox account generation changed before target start',
          );
        }
      },
    );
    return {
      executable: shellArtifact.path,
      args: ['__host', ownedRequestFile],
      env: sanitizedEnvironment(),
      stdinPrefix: bootstrap,
      processTreeContainment: 'native-job',
      processControl,
      cleanup(cleanupInput) {
        cleanupPromise ??= (async () => {
          let terminalFailure: unknown;
          if (cleanupInput?.execution === 'started_or_unknown') {
            try {
              await processControl.waitForTerminalObservation();
            } catch (error: unknown) {
              terminalFailure = error;
            }
          }
          const results = await Promise.allSettled([
            ownedBrokerLease.release({ retireIfLast: terminalFailure !== undefined }),
            rm(ownedRequestFile, { force: true }),
            rm(nativeResumeRecordFile, { force: true }),
            rm(nativeStartedRecordFile, { force: true }),
            rm(ownedTerminalRecordFile, { force: true }),
          ]);
          const failures = results.flatMap((result) => (
            result.status === 'rejected' ? [result.reason] : []
          ));
          if (terminalFailure !== undefined) failures.unshift(terminalFailure);
          if (failures.length > 0) {
            throw new AggregateError(failures, 'Windows native shell cleanup failed.');
          }
          return {
            version: 1,
            state: 'applied',
            backend: 'windows-restricted-user',
            policyId: 'kodax-workspace-shell-v1',
          };
        })();
        return cleanupPromise;
      },
    };
  } catch (error: unknown) {
    const cleanup = await Promise.allSettled([
      ...(brokerLease === undefined ? [] : [brokerLease.release()]),
      ...(nativeRequestFile === undefined ? [] : [rm(nativeRequestFile, { force: true })]),
      ...(nativeTerminalRecordFile === undefined
        ? []
        : [rm(nativeTerminalRecordFile, { force: true })]),
    ]);
    const failures = [
      error,
      ...cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
    ];
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, 'Windows native shell preparation and cleanup both failed.');
  }
}

async function preparePortableAsrtShellInvocation(input: {
  readonly workspaceRoot: string;
  readonly agentHomeAccess: AsrtShellAgentHomeAccess | undefined;
  readonly filesystemAccess: AsrtShellSandboxSelection['filesystemAccess'];
  readonly trustedProjectExecPolicyPath: string | undefined;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly windowsVerbatimArguments: boolean;
}): Promise<Awaited<ReturnType<KodaXShellSandbox['prepare']>>> {
  const runtimeReadScopes = workspaceShellRuntimeReadScopes(input.env, input.executable);
  const request: SandboxBrokerRequest = {
    config: workspaceShellCommandSandboxConfig(
      input.workspaceRoot,
      undefined,
      input.agentHomeAccess,
      input.filesystemAccess,
      runtimeReadScopes,
      input.trustedProjectExecPolicyPath,
    ),
    command: input.executable,
    args: input.args,
    windowsVerbatimArguments: input.windowsVerbatimArguments,
    cwd: input.cwd,
    env: input.env,
    endpoints: [],
    allowAllNetwork: true,
    bootstrapCommand: sandboxJavaScriptCommand(),
    observationBackend: sandboxRuntimeCapability().backend,
    targetStartedMarker: `\0KODAX_ASRT_TARGET_STARTED:${randomUUID()}\0\n`,
  };
  const controlled = encodeControlledBrokerRequest(request);
  const brokerArgs = process.env.KODAX_BUNDLED === 'true'
    ? ['__asrt-broker']
    : ['--input-type=module', '-e', BROKER_SOURCE, ASRT_MODULE_URL!];
  const launch = prepareInternalNodeLaunch({
    args: brokerArgs,
    env: sanitizedEnvironment(),
    isElectron: process.versions.electron !== undefined,
  });
  let cleanupPromise: ReturnType<KodaXPreparedShellSandboxInvocation['cleanup']> | undefined;
  return {
    executable: process.execPath,
    args: launch.args,
    env: launch.env,
    stdinPrefix: controlled.payload,
    controlChannel: {
      fd: 3,
      maxOutputBytes: SANDBOX_BROKER_CONTROL_MAX_BYTES,
    },
    cleanup(cleanupInput) {
      cleanupPromise ??= (async () => {
        const controlOutput = cleanupInput?.controlOutput;
        if (controlOutput === undefined) {
          if (cleanupInput?.execution === 'started_or_unknown') {
            return {
              version: 1,
              state: 'execution_uncertain',
              diagnostic: 'Required OS sandbox execution could not be attested.',
            };
          }
          return undefined;
        }
        const observation = parseSandboxBrokerControl(
          controlOutput,
          controlled.invocationId,
          controlled.request.observationBackend ?? 'unsupported',
        );
        if (observation === undefined) {
          return {
            version: 1,
            state: 'execution_uncertain',
            diagnostic: 'Required OS sandbox execution could not be attested.',
          };
        }
        return observation.state === 'not_started'
          ? {
              version: 1,
              state: 'pre_start_unavailable',
              ...(observation.diagnostic === undefined
                ? {}
                : { diagnostic: observation.diagnostic }),
            }
          : observation;
      })();
      return cleanupPromise;
    },
  };
}

/**
 * Runtime-owned broker for admitted workspace shell calls. Non-admitted calls
 * return undefined so the caller keeps the ordinary authorized execution path.
 */
export function createAsrtShellSandbox(
  input: CreateAsrtShellSandboxInput,
): KodaXShellSandbox {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  return {
    processTreeContainment: process.platform === 'linux'
      ? 'root-exit-drains'
      : undefined,
    async prepare(shellInput) {
      if (!shellInput.toolCallId) {
        shellInput.reportObservation?.({
          version: 1,
          state: 'not_selected',
        });
        return undefined;
      }
      const call: RunnerToolCall = {
        id: shellInput.toolCallId,
        name: 'bash',
        input: { ...shellInput.toolInput },
      };
      const selected = await input.shouldSandbox(call);
      const selection = selected
        ? withAdditionalWorkspaceRoots(
            selected,
            input.additionalWorkspaceRoots?.() ?? [],
          )
        : false;
      if (!selection) {
        shellInput.reportObservation?.({
          version: 1,
          state: 'not_selected',
        });
        return undefined;
      }
      const requestedAgentHomeAccess = typeof selection === 'object'
        ? selection.agentHomeAccess
        : undefined;
      const agentHomeAccess = process.platform === 'win32'
        && requestedAgentHomeAccess !== undefined
        ? windowsAgentHomeAccessRoots(
            path.resolve(getAgentConfigHome()),
            requestedAgentHomeAccess,
          )
        : requestedAgentHomeAccess;
      const filesystemAccess = typeof selection === 'object'
        ? selection.filesystemAccess
        : undefined;
      if (!workspaceShellFilesystemAccessIsRepresentable(filesystemAccess)) {
        throw new Error('The selected filesystem access is not representable by the OS sandbox.');
      }
      const executable = workspaceShellExecutable(shellInput.executable);
      const args = shellInput.args
        ?? (process.platform === 'win32'
          ? ['/d', '/s', '/c', shellInput.command]
          : ['-c', shellInput.command]);
      const commandEnvironment = normalizedSandboxEnvironment(shellInput.env);
      const trustedProjectExecPolicyPath = input.trustedProjectExecPolicyPath
        ?? shellInput.trustedProjectExecPolicyPath;
      if (process.platform === 'win32') {
        try {
          return await prepareWindowsV2ShellInvocation({
            workspaceRoot,
            agentHomeAccess,
            filesystemAccess,
            trustedProjectExecPolicyPath,
            executable,
            args,
            cwd: shellInput.cwd,
            env: commandEnvironment,
            signal: shellInput.signal,
            deadlineAt: shellInput.deadlineAt,
          });
        } catch (error: unknown) {
          if (
            shellInput.signal?.aborted
            || (
              shellInput.deadlineAt !== undefined
              && Date.now() >= shellInput.deadlineAt
            )
          ) {
            throw error;
          }
          emitKodaXDiagnostic({
            source: 'sandbox:windows-v2',
            level: 'warn',
            message: 'Windows native shell preparation failed before target start.',
            detail: error,
          });
          throw error;
        }
      }
      try {
        return await preparePortableAsrtShellInvocation({
          workspaceRoot,
          agentHomeAccess,
          filesystemAccess,
          trustedProjectExecPolicyPath,
          executable,
          args,
          cwd: shellInput.cwd,
          env: commandEnvironment,
          windowsVerbatimArguments: shellInput.windowsVerbatimArguments === true,
        });
      } catch (error: unknown) {
        if (
          shellInput.signal?.aborted
          || (shellInput.deadlineAt !== undefined && Date.now() >= shellInput.deadlineAt)
        ) {
          throw error;
        }
        emitKodaXDiagnostic({
          source: 'sandbox:portable-asrt',
          level: 'warn',
          message: 'Portable ASRT shell preparation failed before target start.',
          detail: error,
        });
        throw error;
      }
    },
  };
}

export async function createAsrtSkillScriptRunner(input: CreateSkillScriptRunnerInput): Promise<KodaXSkillScriptRunner> {
  const doctor = await doctorSandboxRuntime();
  if (!doctor.ready) throw new Error(`ASRT ${KODAX_ASRT_VERSION} is not ready: ${doctor.diagnostics.join(' ') || 'run kodax sandbox setup'}`);
  const runnerRoot = path.join(input.snapshotRoot, randomUUID());
  const snapshotRoot = path.join(runnerRoot, 'skills');
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  try {
    const scripts = await snapshotAdmissions(input, snapshotRoot);
    const endpoints = networkEndpoints(input.network);
    let previousRun = Promise.resolve();
    return {
      async run(runInput, context) {
        const waitForPrevious = previousRun;
        let releaseRun: (() => void) | undefined;
        previousRun = new Promise<void>((resolve) => { releaseRun = resolve; });
        await waitForPrevious;
        if (context.signal?.aborted) {
          releaseRun?.();
          throw context.signal.reason ?? new Error('Sandboxed Skill script was cancelled.');
        }
        try {
          if (runInput.args.length > 64 || runInput.args.some((arg) => arg.length > 8_192)) {
            throw new Error('Skill script arguments exceed the bounded remote contract.');
          }
          if (runInput.inputs.length > 32 || runInput.outputs.length > 32) {
            throw new Error('Skill script file mappings exceed the bounded remote contract.');
          }
          const relative = canonicalRelative(runInput.script, 'Skill script');
          const admitted = scripts.get(`${runInput.skill}\0${relative}`);
          if (!admitted) throw new Error('Skill script is not admitted by this Runtime binding.');
          if (['.cmd', '.bat'].includes(path.extname(admitted.snapshotPath).toLowerCase())
            && runInput.args.some((arg) => /[&|<>^]/.test(arg))) {
            throw new Error('Batch Skill script arguments cannot contain command operators.');
          }
          const stage = path.join(context.workspaceRoot, '.kodax-a2a-script', randomUUID());
          try {
            await mkdir(path.join(stage, 'inputs'), { recursive: true, mode: 0o700 });
            await mkdir(path.join(stage, 'outputs'), { recursive: true, mode: 0o700 });
            await stageInputFiles(context.workspaceRoot, stage, runInput, input.workspaceAccess);
            const interpreter = interpreterFor(admitted.snapshotPath);
            const stdout = await runBroker({
              config: sandboxConfig(stage, runnerRoot, endpoints, interpreter.command),
              command: interpreter.command,
              args: [...interpreter.args, ...runInput.args],
              cwd: stage,
              env: sanitizedEnvironment(),
              endpoints,
            }, context.signal);
            const outputs = await promoteOutputs(
              context.workspaceRoot,
              stage,
              runInput,
              input.workspaceAccess,
              input.workspaceByteLimit,
            );
            return JSON.stringify({ stdout: stdout.trim(), outputs });
          } finally {
            await rm(stage, { recursive: true, force: true });
          }
        } finally {
          releaseRun?.();
        }
      },
      async dispose() {
        await previousRun;
        await rm(runnerRoot, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await rm(runnerRoot, { recursive: true, force: true });
    throw error;
  }
}

let warnedUnexpectedAsrtGitEnv = false;

function warnUnexpectedAsrtGitEnvShape(): void {
  if (warnedUnexpectedAsrtGitEnv) return;
  warnedUnexpectedAsrtGitEnv = true;
  emitKodaXDiagnostic({
    source: 'sandbox:git-safe-directory',
    level: 'warn',
    message: 'ASRT git env block had an unexpected shape; execution was rejected.',
  });
}

export function withWindowsSandboxChildEnvironment(
  argv: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  gitTrustRoots?: readonly string[],
): string[] {
  const separator = argv.lastIndexOf('--');
  if (separator < 0) throw new Error('ASRT Windows wrapper omitted its child separator.');
  const requestedEntries: Array<readonly [string, string]> = [];
  const requestedNames = new Set<string>();
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (!name || name.includes('=') || name.includes('\0') || value.includes('\0')) {
      throw new Error('Invalid environment entry for ASRT Windows child.');
    }
    const normalized = name.toLowerCase();
    if (requestedNames.has(normalized)) {
      throw new Error(
        `Ambiguous Windows child environment variable: ${name}; names: `
        + Object.keys(environment).join(', '),
      );
    }
    requestedNames.add(normalized);
    requestedEntries.push([name, value]);
  }
  const controlled = new Set<string>();
  const requestedOverrides = new Set(requestedEntries.flatMap(([name]) => (
    ['path', 'pathext'].includes(name.toLowerCase())
      ? [name.toLowerCase()]
      : []
  )));
  const wrapperPrefix: string[] = [];
  for (let index = 0; index < separator; index += 1) {
    if (argv[index] !== '--env' || index + 1 >= separator) {
      wrapperPrefix.push(argv[index]!);
      continue;
    }
    const assignment = argv[index + 1]!;
    const name = assignment.split('=', 1)[0]?.toLowerCase();
    if (name) controlled.add(name);
    if (!name || !requestedOverrides.has(name)) {
      wrapperPrefix.push(argv[index]!, assignment);
    }
    index += 1;
  }
  const injected: string[] = [];
  for (const [name, value] of requestedEntries) {
    const normalized = name.toLowerCase();
    if (
      controlled.has(normalized)
      && normalized !== 'path'
      && normalized !== 'pathext'
    ) continue;
    injected.push('--env', `${name}=${value}`);
  }
  const result = [...wrapperPrefix, ...injected, ...argv.slice(separator)];
  let withGitTrust = result;
  if (gitTrustRoots !== undefined) {
    try {
      withGitTrust = rewriteWindowsGitSafeDirectoryArgv(result, gitTrustRoots);
    } catch (error: unknown) {
      warnUnexpectedAsrtGitEnvShape();
      throw error;
    }
  }
  const estimate = withGitTrust.reduce((size, value) => size + value.length + 3, 0);
  if (estimate > 30_000) {
    throw new Error(
      'ASRT Windows child environment exceeds the CreateProcess command-line limit.',
    );
  }
  return withGitTrust;
}

async function wrapSandboxTarget(
  request: SandboxBrokerRequest,
  targetStartedMarker: string,
): Promise<NonNullable<SandboxBrokerRequest['wrappedInvocation']>> {
  const bootstrapCommand = request.bootstrapCommand ?? sandboxJavaScriptCommand();
  const bootstrapIsElectronNode = (
    bootstrapCommand === process.execPath
    && process.versions.electron !== undefined
  );
  const internalElectronNode = (
    request.command === process.execPath
    && process.versions.electron !== undefined
  );
  const childArgs = internalElectronNode
    ? ['--import', ELECTRON_NODE_ENV_SCRUB_IMPORT, ...request.args]
    : request.args;
  const requestedEnv = internalElectronNode || bootstrapIsElectronNode
    ? { ...request.env, [ELECTRON_RUN_AS_NODE_ENV]: '1' }
    : request.env;
  const quote = (value: string): string => process.platform === 'win32'
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", `'"'"'`)}'`;
  const command = [
    quote(bootstrapCommand),
    '-e',
    quote(TARGET_ARGV_LOADER),
    TARGET_ARGV_BOOTSTRAP_BASE64,
    Buffer.from(JSON.stringify({
      command: request.command,
      args: childArgs,
      windowsVerbatimArguments: request.windowsVerbatimArguments === true,
      cwd: request.cwd,
      targetStartedMarker,
      electronRunAsNode: internalElectronNode,
    }), 'utf8').toString('base64'),
  ].join(' ');
  if (process.platform === 'win32') {
    // Windows supports per-exec denies but not grants. Empty grant arrays keep
    // the session's workspace/PATH grants while the command receives all denies.
    const perExecConfig = {
      filesystem: {
        denyRead: request.config.filesystem.denyRead,
        allowRead: [],
        allowWrite: [],
        denyWrite: request.config.filesystem.denyWrite,
      },
    } satisfies Partial<SandboxRuntimeConfig>;
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      command,
      'cmd',
      perExecConfig,
      undefined,
      request.cwd,
    );
    const argv = withWindowsSandboxChildEnvironment(
      wrapped.argv,
      requestedEnv,
      process.platform === 'win32'
        ? windowsGitTrustRoots(
            request.cwd,
            request.config.filesystem.allowWrite,
            request.config.filesystem.allowRead,
          )
        : undefined,
    );
    return {
      executable: argv[0]!,
      args: argv.slice(1),
      env: wrapped.env,
      shell: false,
    };
  }
  return {
    executable: await SandboxManager.wrapWithSandbox(command),
    args: [],
    env: requestedEnv,
    shell: true,
  };
}

async function writeBrokerObservation(
  request: SandboxBrokerRequest,
  observation: SandboxBrokerControlObservation,
): Promise<void> {
  if (request.controlInvocationId !== undefined) {
    const payload = Buffer.from(`${JSON.stringify({
      version: 1,
      invocationId: request.controlInvocationId,
      observation,
    })}\n`, 'utf8');
    if (payload.byteLength > SANDBOX_BROKER_CONTROL_MAX_BYTES) {
      throw new Error('Sandbox broker control frame exceeded its byte limit.');
    }
    if (writeSync(3, payload) !== payload.byteLength) {
      throw new Error('Sandbox broker control frame was only partially written.');
    }
    return;
  }
  if (request.observationFile === undefined) return;
  await writeFile(
    request.observationFile,
    JSON.stringify(observation),
    { mode: 0o600 },
  );
}

interface SandboxedBrokerChildResult {
  readonly exitCode: number;
  readonly targetStarted: boolean;
  readonly spawnFailedBeforeSpawn: boolean;
  readonly controlFailure?: string;
  readonly diagnostic?: string;
}

function waitForSandboxedBrokerTarget(
  child: ReturnType<typeof spawn>,
  request: SandboxBrokerRequest,
  targetStartedMarker: string,
): Promise<SandboxedBrokerChildResult> {
  const marker = Buffer.from(targetStartedMarker, 'utf8');
  const stderr = child.stderr;
  if (stderr === null) {
    throw new Error('ASRT wrapper stderr attestation pipe was not created.');
  }
  let pending = Buffer.alloc(0);
  let diagnostic = Buffer.alloc(0);
  let processError: string | undefined;
  let wrapperSpawned = false;
  let targetStarted = false;
  let observationWrite = Promise.resolve();
  return new Promise<SandboxedBrokerChildResult>((resolve) => {
    let settled = false;
    child.once('spawn', () => {
      wrapperSpawned = true;
    });
    const finish = (result: SandboxedBrokerChildResult): void => {
      if (settled) return;
      settled = true;
      void observationWrite.then(() => resolve(result));
    };
    stderr.on('data', (chunk: Buffer) => {
      if (targetStarted) {
        process.stderr.write(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      const markerOffset = pending.indexOf(marker);
      if (markerOffset >= 0) {
        targetStarted = true;
        const suffix = pending.subarray(markerOffset + marker.length);
        pending = Buffer.alloc(0);
        diagnostic = Buffer.alloc(0);
        observationWrite = writeBrokerObservation(request, {
          version: 1,
          state: 'applied',
          backend: request.observationBackend ?? 'unsupported',
          policyId: 'kodax-workspace-shell-v1',
        }).catch((error: unknown) => {
          processError = errorText(error);
          child.kill('SIGTERM');
        });
        if (suffix.length > 0) process.stderr.write(suffix);
        return;
      }
      const retained = Math.max(0, marker.length - 1);
      if (pending.length > retained) {
        diagnostic = Buffer.concat([
          diagnostic,
          pending.subarray(0, pending.length - retained),
        ]).subarray(-65_536);
        pending = pending.subarray(pending.length - retained);
      }
    });
    child.once('error', (error: Error) => {
      processError = error.message;
    });
    child.once('close', (code, signal) => {
      const preTarget = Buffer.concat([diagnostic, pending]).toString('utf8').trim();
      finish({
        exitCode: signal ? 1 : code ?? 1,
        targetStarted,
        spawnFailedBeforeSpawn: processError !== undefined && !wrapperSpawned,
        ...(targetStarted && processError ? { controlFailure: processError } : {}),
        ...(preTarget || processError
          ? { diagnostic: preTarget || processError }
          : {}),
      });
    });
  });
}

async function resetSandboxManagerBestEffort(): Promise<void> {
  try {
    SandboxManager.cleanupAfterCommand();
  } catch {
    // Cleanup diagnostics must not alter an already completed user command.
  }
  await SandboxManager.reset().catch(() => undefined);
}

async function readSandboxBrokerRequest(
  requestFile?: string,
): Promise<SandboxBrokerRequest> {
  if (requestFile !== undefined) {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('File-backed ASRT broker requests are test-only.');
    }
    const request = JSON.parse(await readFile(requestFile, 'utf8')) as SandboxBrokerRequest;
    await rm(requestFile, { force: true });
    return request;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > SANDBOX_BROKER_REQUEST_MAX_BYTES) {
      throw new Error('Sandbox broker request exceeded its byte limit.');
    }
    chunks.push(value);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SandboxBrokerRequest;
  if (typeof request.controlInvocationId !== 'string' || request.controlInvocationId === '') {
    throw new Error('Sandbox broker request omitted its control invocation identity.');
  }
  return request;
}

/** Internal entry used only by the standalone binary's isolated broker process. */
export async function runAsrtBrokerProcess(requestFile?: string): Promise<number> {
  rejectWindowsLegacyAsrtFilesystemBackend();
  let request: SandboxBrokerRequest | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let targetStarted = false;
  try {
    request = await readSandboxBrokerRequest(requestFile);
    const targetStartedMarker = request.targetStartedMarker
      ?? `\0KODAX_ASRT_TARGET_STARTED:${randomUUID()}\0\n`;
    if (request.wrappedInvocation === undefined) {
      const endpoints = new Set(
        request.endpoints.map((item) => `${item.host.toLowerCase()}:${item.port}`),
      );
      const callback: SandboxAskCallback | undefined = request.allowAllNetwork === true
        ? async () => true
        : request.endpoints.length === 0
          ? undefined
          : async ({ host, port }) => (
              port !== undefined && endpoints.has(`${host.toLowerCase()}:${port}`)
            );
      await SandboxManager.initialize(request.config, callback);
    }
    const wrapped = request.wrappedInvocation
      ?? await wrapSandboxTarget(request, targetStartedMarker);
    child = spawn(wrapped.executable, [...wrapped.args], {
      cwd: request.cwd,
      env: wrapped.env,
      shell: wrapped.shell,
      stdio: ['inherit', 'inherit', 'pipe'],
      windowsHide: true,
    });
    const stop = (): void => { child?.kill('SIGTERM'); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const result = await waitForSandboxedBrokerTarget(
      child,
      request,
      targetStartedMarker,
    );
    targetStarted = result.targetStarted;
    if (result.controlFailure !== undefined) {
      process.stderr.write(`${result.controlFailure}\n`);
      return 125;
    }
    if (!targetStarted) {
      if (result.spawnFailedBeforeSpawn) {
        await writeBrokerObservation(request, {
          version: 1,
          state: 'not_started',
          diagnostic: result.diagnostic,
        });
      }
      process.stderr.write(
        `${result.diagnostic ?? 'Sandbox target launch could not be attested.'}\n`,
      );
    }
    return targetStarted ? result.exitCode : result.spawnFailedBeforeSpawn ? 1 : 125;
  } catch (error: unknown) {
    if (!targetStarted && request !== undefined && child === undefined) {
      await writeBrokerObservation(request, {
        version: 1,
        state: 'not_started',
        diagnostic: errorText(error),
      }).catch(() => undefined);
    }
    process.stderr.write(`${errorText(error)}\n`);
    return targetStarted ? 125 : 1;
  } finally {
    if (request?.wrappedInvocation === undefined) {
      await resetSandboxManagerBestEffort();
    }
  }
}

function writeWindowsNetworkBrokerReady(response: WindowsNetworkBrokerReady): void {
  writeSync(3, `${JSON.stringify(response)}\n`);
}

interface WindowsNativeControllerProcess {
  readonly child: ReturnType<typeof spawn>;
  readonly pipe: string;
  readonly exit: Promise<WindowsNetworkBrokerExit>;
  readonly stderrTail: () => string;
  stopping: boolean;
  outcome?: WindowsNetworkBrokerExit;
}

async function startWindowsNativeController(
  executable: string,
): Promise<WindowsNativeControllerProcess> {
  const child = spawn(executable, ['__controller', String(process.pid)], {
    env: sanitizedEnvironment(),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderrTail = Buffer.alloc(0);
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-16 * 1024);
  });
  let processError: Error | undefined;
  let pipe = '';
  let resolveExit!: (outcome: WindowsNetworkBrokerExit) => void;
  const exit = new Promise<WindowsNetworkBrokerExit>((resolve) => {
    resolveExit = resolve;
  });
  const state: WindowsNativeControllerProcess = {
    child,
    get pipe() { return pipe; },
    exit,
    stderrTail: () => stderrTail.toString('utf8'),
    stopping: false,
  };
  child.once('error', (error) => { processError = error; });
  child.once('close', (code, signal) => {
    const outcome = {
      code,
      signal,
      ...(processError === undefined ? {} : { error: processError }),
    };
    state.outcome = outcome;
    resolveExit(outcome);
  });
  try {
    const stdout = child.stdout;
    if (stdout === null) throw new Error('Windows native controller stdout pipe was not created.');
    pipe = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let buffered = Buffer.alloc(0);
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stdout.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
        action();
      };
      const onError = (error: Error): void => finish(() => reject(error));
      const onExit = (code: number | null): void => finish(() => reject(new Error(
        `Windows native controller exited ${String(code)} before readiness: ${state.stderrTail()}`,
      )));
      const onData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length > 4_096) {
          finish(() => reject(new Error('Windows native controller readiness exceeded 4 KiB.')));
          return;
        }
        const newline = buffered.indexOf(0x0a);
        if (newline >= 0) {
          finish(() => resolve(buffered.subarray(0, newline).toString('utf8').trim()));
        }
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error('Windows native controller readiness timed out.'))),
        10_000,
      );
      timer.unref();
      stdout.on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
    });
    const match = /^\\\\\.\\pipe\\kodax-v2-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(pipe);
    if (match === null || child.pid === undefined || Number(match[1]) !== child.pid) {
      throw new Error('Windows native controller returned an unauthenticated pipe name.');
    }
    return state;
  } catch (error: unknown) {
    try {
      await stopWindowsNativeController(state);
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        'Windows native controller startup and cleanup both failed.',
      );
    }
    throw error;
  }
}

async function stopWindowsNativeController(
  controller: WindowsNativeControllerProcess,
): Promise<void> {
  controller.stopping = true;
  const stdin = controller.child.stdin;
  if (stdin !== null && !stdin.destroyed) {
    await new Promise<void>((resolve) => {
      const finish = (): void => resolve();
      stdin.once('error', finish);
      stdin.end(finish);
    });
  }
  const graceful = await Promise.race([
    controller.exit.then((outcome) => ({ graceful: true as const, outcome })),
    new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      timer.unref();
    }),
  ]);
  if (graceful === false) {
    controller.child.kill('SIGKILL');
    await controller.exit;
    throw new Error('Windows native controller did not exit within its cleanup budget.');
  }
  if (
    graceful.outcome.error !== undefined
    || graceful.outcome.code !== 0
    || graceful.outcome.signal !== null
  ) {
    throw new Error(
      `Windows native controller cleanup failed (code ${String(graceful.outcome.code)}, `
      + `signal ${String(graceful.outcome.signal)}): ${controller.stderrTail().trim()}`,
      graceful.outcome.error === undefined ? undefined : { cause: graceful.outcome.error },
    );
  }
}

/**
 * One process owns exactly one ASRT network proxy and one host-only native
 * controller. It never launches the target; the native host owns target
 * containment and each command keeps independent runner IPC and a Job.
 */
export async function runAsrtWindowsNetworkBrokerProcess(
  requestFile: string,
): Promise<number> {
  let controller: WindowsNativeControllerProcess | undefined;
  let stopLifetimeObservation: (() => void) | undefined;
  let readyWritten = false;
  const cleanupFailures: unknown[] = [];
  try {
    const request = JSON.parse(await readFile(requestFile, 'utf8')) as WindowsNetworkBrokerRequest;
    await rm(requestFile, { force: true });
    if (
      request.version !== 1
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        request.setupGenerationNonce,
      )
      || request.config.filesystem.disabled !== true
      || !path.isAbsolute(request.cwd)
      || !path.isAbsolute(request.srtWinPath)
      || !/^[0-9a-f]{64}$/i.test(request.srtWinSha256)
      || !path.isAbsolute(request.controllerExecutable)
      || !/^[0-9a-f]{64}$/i.test(request.controllerSha256)
      || request.controllerProtocol !== WINDOWS_SANDBOX_V2_PROTOCOL
      || !/^S-\d+(?:-\d+)+$/i.test(request.expectedSandboxUserSid)
      || !/^S-\d+(?:-\d+)+$/i.test(request.expectedSandboxGroupSid)
    ) {
      throw new Error('Windows network broker request is invalid or enables filesystem authority.');
    }
    const srtWinBytes = await readFile(request.srtWinPath);
    if (
      createHash('sha256').update(srtWinBytes).digest('hex')
      !== request.srtWinSha256.toLowerCase()
    ) {
      throw new Error('ASRT Windows runner artifact changed before broker startup.');
    }
    const controllerBytes = await readFile(request.controllerExecutable);
    if (
      createHash('sha256').update(controllerBytes).digest('hex')
      !== request.controllerSha256.toLowerCase()
    ) {
      throw new Error('Windows native controller artifact changed before broker startup.');
    }
    const endpoints = new Set(
      request.endpoints.map((item) => `${item.host.toLowerCase()}:${item.port}`),
    );
    const callback: SandboxAskCallback | undefined = request.allowAllNetwork
      ? async () => true
      : endpoints.size === 0
        ? undefined
        : async ({ host, port }) => (
            port !== undefined && endpoints.has(`${host.toLowerCase()}:${port}`)
          );
    await SandboxManager.initialize(request.config, callback);
    const sentinel = `KODAX_WINDOWS_V2_${randomUUID()}`;
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      `echo ${sentinel}`,
      'cmd',
      undefined,
      undefined,
      request.cwd,
    );
    if (wrapped.argv.length < 2 || !wrapped.argv.some((value) => value.includes(sentinel))) {
      throw new Error('ASRT Windows wrapper did not preserve the controlled target sentinel.');
    }
    const invocation = splitAsrtWindowsInvocation({
      executable: wrapped.argv[0]!,
      args: wrapped.argv.slice(1),
    });
    const sandboxUser = getWindowsSandboxUserStatus({
      srtWin: resolveSrtWin({ path: request.srtWinPath }),
    });
    if (
      !sandboxUser.sid
      || !sandboxUser.groupSid
      || windowsSandboxAccountDiagnostics(sandboxUser).length > 0
    ) {
      throw new Error('Windows sandbox account is not ready for native shell execution.');
    }
    if (
      sandboxUser.sid.toUpperCase() !== request.expectedSandboxUserSid.toUpperCase()
      || sandboxUser.groupSid.toUpperCase() !== request.expectedSandboxGroupSid.toUpperCase()
    ) {
      throw new Error('Windows sandbox account changed while the network broker was starting.');
    }
    controller = await startWindowsNativeController(request.controllerExecutable);
    writeWindowsNetworkBrokerReady({
      version: 1,
      ok: true,
      asrtExecutable: invocation.executable,
      asrtPrefixArgs: invocation.prefixArgs,
      asrtChildEnvironment: invocation.childEnvironment,
      sandboxUserSid: sandboxUser.sid,
      sandboxGroupSid: sandboxUser.groupSid,
      controllerPipe: controller.pipe,
    });
    readyWritten = true;
    const brokerLifetime = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        process.stdin.off('end', finish);
        process.stdin.off('close', finish);
        process.off('SIGINT', finish);
        process.off('SIGTERM', finish);
        process.stdin.pause();
        resolve();
      };
      stopLifetimeObservation = finish;
      process.stdin.once('end', finish);
      process.stdin.once('close', finish);
      process.once('SIGINT', finish);
      process.once('SIGTERM', finish);
      if (process.stdin.readableEnded || process.stdin.destroyed) finish();
      else process.stdin.resume();
    });
    const controllerLifetime = controller.exit.then((outcome) => {
      if (controller?.stopping) return;
      throw new Error(
        `Windows native controller exited while its broker was active `
        + `(code ${String(outcome.code)}, signal ${String(outcome.signal)}): `
        + controller!.stderrTail().trim(),
        outcome.error === undefined ? undefined : { cause: outcome.error },
      );
    });
    await Promise.race([brokerLifetime, controllerLifetime]);
    if (controller.outcome !== undefined && !controller.stopping) {
      throw new Error('Windows native controller exited before broker shutdown completed.');
    }
  } catch (error: unknown) {
    if (!readyWritten) {
      try {
        writeWindowsNetworkBrokerReady({ version: 1, ok: false, error: errorText(error) });
        readyWritten = true;
      } catch (reportError: unknown) {
        cleanupFailures.push(reportError);
      }
    }
    cleanupFailures.push(error);
  } finally {
    stopLifetimeObservation?.();
    if (controller !== undefined) {
      try {
        await stopWindowsNativeController(controller);
      } catch (error: unknown) {
        cleanupFailures.push(error);
      }
    }
    try {
      SandboxManager.cleanupAfterCommand();
    } catch (error: unknown) {
      cleanupFailures.push(error);
    }
    try {
      await SandboxManager.reset();
    } catch (error: unknown) {
      cleanupFailures.push(error);
    }
    try {
      await rm(requestFile, { force: true });
    } catch (error: unknown) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length > 0) {
    process.stderr.write(
      `Windows network broker failed: ${cleanupFailures.map(errorText).join(' | ')}\n`,
    );
    return 1;
  }
  return 0;
}
