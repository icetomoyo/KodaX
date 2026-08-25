import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync,
  constants,
  existsSync,
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
  rename,
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
  KodaXFileLockTimeoutError,
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
  KodaXShellSandbox,
  KodaXShellSandboxBackend,
  KodaXShellSandboxObservation,
  KodaXSkillScriptRunInput,
  KodaXSkillScriptRunner,
  KodaXTextFileMutationRequest,
  KodaXTextFileMutationUnavailableReason,
  KodaXTextFileMutationSandbox,
} from '@kodax-ai/coding';
import {
  acquireFileSystemMutationLease,
  acquireExclusiveFileSystemEffectLease,
  FileSystemCleanupAdmissionTimeoutError,
  finishAndReleaseFileSystemEffectLease,
  scheduleUnrefBackgroundRetry,
  type FileSystemMutationLeaseRelease,
  withExclusiveFileSystemCleanupLease,
} from '@kodax-ai/coding/internal/file-system-effects';
import {
  rewriteWindowsGitSafeDirectoryArgv,
  windowsGitBrokerHelpersSource,
  windowsGitTrustRoots,
} from './windows-git-sandbox.js';

export { rewriteWindowsGitSafeDirectoryArgv, windowsGitTrustRoots };

export const KODAX_ASRT_VERSION = '0.0.65';

// The CLI imports this module only for sandbox commands/cleanup. Keep ASRT
// behind that module boundary while preserving ordinary static bindings once
// the sandbox runtime itself is initialized.
const {
  DEFAULT_WINDOWS_PROXY_PORT_RANGE,
  SandboxManager,
  getSrtWinPath,
  getWindowsSandboxUserStatus,
  grantWindowsAcl,
  installWindowsSandbox,
  resolveSrtWin,
  revokeWindowsAcl,
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
   * default; these roots also carve back access beneath a broader denyRead.
   */
  readonly allowRead: readonly string[];
  /** The only roots in which the command may create, modify, or remove data. */
  readonly allowWrite: readonly string[];
  /** Read-denied roots; a more specific allowRead entry takes precedence. */
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
  /** Defaults to a minimal process environment. */
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
  };

export interface SandboxSetupOutcome {
  readonly status: 'ready' | 'cancelled' | 'unavailable';
  readonly attempted: boolean;
  readonly doctor: SandboxRuntimeDoctorResult;
  readonly guidance: readonly string[];
  readonly error?: string;
}

export interface KodaXSandboxCapability {
  readonly version: 5;
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
    version: 5,
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
  };
}

const MAX_OUTPUT_BYTES = 1_048_576;
const SCRIPT_TIMEOUT_MS = 120_000;
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
const WORKSPACE_SHELL_SENSITIVE_HOME_PATHS = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.kodax',
  '.agents',
  '.codex',
  '.claude',
  '.gemini',
  '.direnv',
  '.terraform.d',
  path.join('.cargo', 'credentials.toml'),
  path.join('.config', 'gcloud'),
  path.join('.config', 'gh'),
  path.join('.config', 'openai'),
  path.join('.config', 'anthropic'),
  '.gitconfig',
  path.join('.config', 'git', 'config'),
  '.terraformrc',
  path.join('.config', 'pypoetry', 'auth.toml'),
  '.condarc',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  path.join('.config', 'fish', 'config.fish'),
  path.join('.config', 'fish', 'fish_variables'),
  '.bash_history',
  '.zsh_history',
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
  '.password-store',
  '.env',
  '.envrc',
  '.pgpass',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.env.staging',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'application_default_credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
] as const;
const WORKSPACE_SHELL_SENSITIVE_AGENT_HOME_PATHS = [
  'runtime',
  'mcp-tokens',
  'mcp-clients',
  'integrations',
  'sandbox-runtime',
  'processes',
  'learned',
  'config.json',
  'auth.json',
  'trusted-project-rules.json',
  '.env',
  '.envrc',
  '.pgpass',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'application_default_credentials.json',
] as const;
const WORKSPACE_SHELL_INTERNAL_AGENT_HOME_DIRECTORIES = [
  'runtime',
  'processes',
  'learned',
] as const;
const WINDOWS_ACL_GUARD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$mutex = [System.Threading.Mutex]::new($false, 'Local\KodaXAsrtAclGuard-v1')
$held = $false
$missing = [System.Collections.Generic.List[string]]::new()
function Test-KodaXAsrtAclRule($acl, $sidValue, $rights, $inheritance) {
  foreach ($rule in $acl.Access) {
    try {
      $ruleSid = $rule.IdentityReference.Translate(
        [System.Security.Principal.SecurityIdentifier]
      ).Value
    } catch {
      continue
    }
    if (
      $ruleSid -eq $sidValue -and
      $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny -and
      -not $rule.IsInherited -and
      $rule.InheritanceFlags -eq $inheritance -and
      $rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None -and
      (([int]$rule.FileSystemRights -band [int]$rights) -eq [int]$rights)
    ) {
      return $true
    }
  }
  return $false
}
function Test-KodaXParentDeleteChildSafe($acl, $tokenSidValues) {
  foreach ($rule in $acl.Access) {
    try {
      $ruleSid = $rule.IdentityReference.Translate(
        [System.Security.Principal.SecurityIdentifier]
      ).Value
    } catch {
      continue
    }
    if (
      $tokenSidValues -contains $ruleSid -and
      $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny -and
      ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
      (([int]$rule.FileSystemRights -band [int][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles) -ne 0)
    ) {
      return $true
    }
  }
  foreach ($rule in $acl.Access) {
    try {
      $ruleSid = $rule.IdentityReference.Translate(
        [System.Security.Principal.SecurityIdentifier]
      ).Value
    } catch {
      continue
    }
    if (
      $tokenSidValues -contains $ruleSid -and
      $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
      (([int]$rule.FileSystemRights -band [int][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles) -ne 0)
    ) {
      return $false
    }
  }
  return $true
}
function Test-KodaXAsrtAclRuleReadsData($acl, $sidValue) {
  foreach ($rule in $acl.Access) {
    try {
      $ruleSid = $rule.IdentityReference.Translate(
        [System.Security.Principal.SecurityIdentifier]
      ).Value
    } catch {
      continue
    }
    if (
      $ruleSid -eq $sidValue -and
      $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny -and
      -not $rule.IsInherited -and
      $rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None -and
      (([int]$rule.FileSystemRights -band ([int][System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [int][System.Security.AccessControl.FileSystemRights]::Synchronize)) -ne 0)
    ) {
      return $true
    }
  }
  return $false
}
function Add-KodaXAsrtAclRule($target, $sid, $rights, $inheritance, $ruleText) {
  $acl = Get-Acl -LiteralPath $target
  if (Test-KodaXAsrtAclRule $acl $sid.Value $rights $inheritance) {
    return
  }
  $principal = '*' + $sid.Value
  & "$env:SystemRoot\System32\icacls.exe" $target '/deny' "$($principal):$ruleText" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "icacls failed to install a KodaX sandbox guard on $target."
  }
}
function Add-KodaXAsrtWriteAclRule($target, $sid, $rights, $inheritance) {
  $acl = Get-Acl -LiteralPath $target
  if (Test-KodaXAsrtAclRule $acl $sid.Value $rights $inheritance) {
    return
  }
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    $rights,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Deny
  )
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $target -AclObject $acl
}
try {
  try {
    $held = $mutex.WaitOne(10000)
  } catch [System.Threading.AbandonedMutexException] {
    $held = $true
  }
  if (-not $held) {
    throw 'Timed out waiting for the KodaX ASRT ACL guard mutex.'
  }
  $sid = [System.Security.Principal.SecurityIdentifier]::new([string]$payload.sid)
  $tokenSidValues = @($payload.tokenSids | ForEach-Object { [string]$_ })
  foreach ($entry in $payload.paths) {
    $target = [System.IO.Path]::GetFullPath([string]$entry.path)
    if (-not (Test-Path -LiteralPath $target)) {
      throw "ACL guard target disappeared before it could be protected: $target"
    }
    $inheritance = if ([bool]$entry.directory) {
      [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
      [System.Security.AccessControl.InheritanceFlags]::None
    }
    $writeRights = [System.Security.AccessControl.FileSystemRights]::Write -bor
      [System.Security.AccessControl.FileSystemRights]::Delete -bor
      [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
      [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    if ([bool]$entry.directory) {
      $writeRights = $writeRights -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
    }
    $targetRights = if ([string]$entry.mode -eq 'write') {
      $writeRights
    } else {
      [System.Security.AccessControl.FileSystemRights]::FullControl
    }
    $parent = [System.IO.Path]::GetDirectoryName($target)
    $targetAcl = Get-Acl -LiteralPath $target
    $targetReady = Test-KodaXAsrtAclRule $targetAcl $sid.Value $targetRights $inheritance
    $targetTooBroad = [string]$entry.mode -eq 'write' -and (Test-KodaXAsrtAclRuleReadsData $targetAcl $sid.Value)
    if ($targetTooBroad) {
      $targetReady = $false
    }
    $parentReady = -not $parent -or $parent -eq $target -or -not (Test-Path -LiteralPath $parent)
    if (-not $parentReady) {
      $parentAcl = Get-Acl -LiteralPath $parent
      $parentReady = (Test-KodaXAsrtAclRule $parentAcl $sid.Value ([System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles) ([System.Security.AccessControl.InheritanceFlags]::None)) -or (Test-KodaXParentDeleteChildSafe $parentAcl $tokenSidValues)
    }
    if (-not [bool]$payload.install) {
      if (-not $targetReady -or -not $parentReady) {
        [void]$missing.Add($target)
      }
      continue
    }
    if ($targetTooBroad) {
      $principal = '*' + $sid.Value
      & "$env:SystemRoot\System32\icacls.exe" $target '/remove:d' $principal | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "icacls failed to remove an obsolete KodaX sandbox guard from $target."
      }
    }
    if (-not $targetReady) {
      if ([string]$entry.mode -eq 'write') {
        Add-KodaXAsrtWriteAclRule $target $sid $targetRights $inheritance
      } else {
        $targetRule = if ([bool]$entry.directory) { '(OI)(CI)(F)' } else { '(F)' }
        Add-KodaXAsrtAclRule $target $sid $targetRights $inheritance $targetRule
      }
    }
    if (-not $parentReady) {
      Add-KodaXAsrtAclRule $parent $sid ([System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles) ([System.Security.AccessControl.InheritanceFlags]::None) '(DC)'
    }
  }
  [Console]::Out.Write((@{ missing = @($missing) } | ConvertTo-Json -Compress))
} finally {
  if ($held) {
    [void]$mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
`;
const windowsAclReadGuardedPaths = new Set<string>();
const windowsAclWriteGuardedPaths = new Set<string>();
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
import { readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
let SandboxManager;
const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
await rm(process.argv[2], { force: true });
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
const writeObservation = async (observation) => {
  if (typeof request.observationFile !== 'string') return;
  await writeFile(request.observationFile, JSON.stringify(observation), { mode: 0o600 });
};
const waitForTarget = (target, observation) => {
  const marker = Buffer.from(targetStartedMarker, 'utf8');
  let pending = Buffer.alloc(0);
  let diagnostic = Buffer.alloc(0);
  let processError;
  let wrapperSpawned = false;
  let targetStarted = false;
  let observationWrite = Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    target.once('spawn', () => {
      wrapperSpawned = true;
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      void observationWrite.then(() => resolve(result), reject);
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
        const suffix = pending.subarray(markerOffset + marker.length);
        pending = Buffer.alloc(0);
        diagnostic = Buffer.alloc(0);
        observationWrite = writeObservation(observation).catch(() => undefined);
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
        diagnostic: preTarget || processError || undefined,
      });
    });
  });
};
let child;
let targetStarted = false;
let normalFallbackAttempted = false;
const runDirect = async () => {
  const internalElectronNode = request.command === process.execPath && process.versions.electron !== undefined;
  const directArgs = internalElectronNode
    ? ['--import', ${ELECTRON_NODE_ENV_SCRUB_IMPORT_LITERAL}, ...request.args]
    : request.args;
  const directEnv = internalElectronNode
    ? { ...request.env, [${ELECTRON_RUN_AS_NODE_ENV_LITERAL}]: '1' }
    : request.env;
  child = spawn(request.command, directArgs, {
    cwd: request.cwd,
    env: directEnv,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
    windowsVerbatimArguments: request.windowsVerbatimArguments === true,
  });
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
  });
};
const runNormalFallback = async () => {
  if (
    request.fallbackToNormalExecution !== true
    || targetStarted
    || normalFallbackAttempted
  ) return false;
  await writeObservation({
    version: 1,
    state: 'fallback',
    reason: 'backend_failed',
    execution: 'normal_permission_policy',
  }).catch(() => undefined);
  normalFallbackAttempted = true;
  process.exitCode = await runDirect();
  return true;
};
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
    });
    targetStarted = result.targetStarted;
    const fellBack = result.spawnFailedBeforeSpawn
      ? await runNormalFallback()
      : false;
    if (!targetStarted && !fellBack) {
      process.stderr.write((result.diagnostic || 'Sandbox target launch could not be attested.') + '\n');
    }
    if (!fellBack) process.exitCode = targetStarted ? result.exitCode : 1;
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
  });
  targetStarted = result.targetStarted;
  try { SandboxManager.cleanupAfterCommand(); } catch {}
  await SandboxManager.reset().catch(() => undefined);
  const fellBack = result.spawnFailedBeforeSpawn
    ? await runNormalFallback()
    : false;
  if (!targetStarted && !fellBack) {
    process.stderr.write((result.diagnostic || 'Sandbox target launch could not be attested.') + '\n');
  }
  if (!fellBack) process.exitCode = targetStarted ? result.exitCode : 1;
  }
} catch (error) {
  await SandboxManager?.reset().catch(() => undefined);
  if (
    request.fallbackToNormalExecution === true
    && !targetStarted
    && !normalFallbackAttempted
    && child === undefined
  ) {
    try {
      await runNormalFallback();
    } catch (fallbackError) {
      process.stderr.write((fallbackError instanceof Error ? fallbackError.message : String(fallbackError)) + '\n');
      process.exitCode = 1;
    }
  } else {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  }
}
`;
let doctorPromise: Promise<SandboxRuntimeDoctorResult> | undefined;
let doctorExpiresAt = 0;
const SANDBOX_NOT_READY_RECHECK_MS = 30_000;

interface PreparedWindowsSandboxRunner {
  readonly path: string;
  readonly directory: string;
  readonly srtWin: ReturnType<typeof resolveSrtWin>;
}

let preparedWindowsRunnerPromise: Promise<PreparedWindowsSandboxRunner> | undefined;
let preparedWindowsRunner: PreparedWindowsSandboxRunner | undefined;
let windowsSandboxAclStartupRecovered = false;
let preparedWindowsRunnerGrant: {
  readonly runner: PreparedWindowsSandboxRunner;
  readonly sandboxUserSid: string;
} | undefined;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFileSystemError(error: unknown, ...codes: readonly string[]): boolean {
  return error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && codes.includes(error.code);
}

async function readFileIfPresent(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error: unknown) {
    if (isFileSystemError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function installWindowsRunnerCopy(
  source: Buffer,
  destination: string,
): Promise<void> {
  const existing = await readFileIfPresent(destination);
  if (existing?.equals(source)) return;
  if (existing !== undefined) {
    throw new Error(`Prepared Windows sandbox runner failed integrity verification: ${destination}.`);
  }
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, { flag: 'wx', mode: 0o700 });
    try {
      await rename(temporary, destination);
    } catch (error: unknown) {
      const concurrent = await readFileIfPresent(destination);
      if (!concurrent?.equals(source)) throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
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

async function prepareWindowsSandboxRunner(): Promise<PreparedWindowsSandboxRunner> {
  if (preparedWindowsRunnerPromise === undefined) {
    const preparation = (async () => {
      const source = await readFile(resolveSrtWinSourcePath());
      const contentId = createHash('sha256').update(source).digest('hex').slice(0, 16);
      const directory = path.join(
        path.resolve(getAgentConfigHome()),
        'sandbox-runtime',
        'runner',
        KODAX_ASRT_VERSION,
        process.arch,
        contentId,
      );
      const runnerPath = path.join(directory, 'srt-win.exe');
      await mkdir(windowsSandboxAclCoordinationDirectory(), { recursive: true, mode: 0o700 });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await installWindowsRunnerCopy(source, runnerPath);
      const runner = {
        path: runnerPath,
        directory,
        srtWin: resolveSrtWin({ path: runnerPath }),
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
  return preparedWindowsRunnerPromise;
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

const activeWindowsSandboxAclOwnerMarkers = new Set<string>();
const legacyWindowsSandboxAclOwnerMarkers = new Map<string, string>();
const recoverableWindowsEffectFences = new Map<
  string,
  FileSystemMutationLeaseRelease
>();
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

function windowsSandboxAclPoisonStagingDirectory(): string {
  return path.join(windowsSandboxAclCoordinationDirectory(), 'acl-poison-staging');
}

function legacyWindowsSandboxAclPoisonStagingDirectory(configHome = getAgentConfigHome()): string {
  return path.join(path.resolve(configHome), 'sandbox-runtime', 'acl-poison-staging');
}

function windowsSandboxAclRecoveryLockFile(): string {
  return path.join(windowsSandboxAclCoordinationDirectory(), 'acl-recovery.lock');
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

function persistWindowsSandboxAclPoisonOwner(
  pid: number | undefined,
  processStartIdentity: string | undefined,
  state: 'active' | 'unconfirmed' | 'recovery_pending' = 'recovery_pending',
  policyKey?: string,
): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const windowsBootIdentity = readWindowsBootIdentity();
  const holderProcessStartIdentity = readProcessStartIdentity(process.pid);
  const id = randomUUID();
  const basename = `${state === 'active' ? '' : 'recovery-'}owner-${id}.json`;
  const owner: WindowsSandboxAclPoisonOwner = {
    version: 3,
    state,
    ticketId: id,
    ...(policyKey === undefined ? {} : { policyKey }),
    holderPid: process.pid,
    ...(holderProcessStartIdentity === undefined ? {} : { holderProcessStartIdentity }),
    ...(pid === undefined ? {} : { pid }),
    ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
    ...(windowsBootIdentity === undefined ? {} : { windowsBootIdentity }),
  };
  return persistWindowsSandboxAclPoisonRecord(owner, basename);
}

function persistWindowsSandboxAclPoisonRecord(
  owner: WindowsSandboxAclPoisonOwner,
  basename: string,
): string {
  const payload = JSON.stringify(owner);
  const persist = (
    directory: string,
    stagingDirectory: string,
  ): string => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, basename);
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
    const temporary = path.join(stagingDirectory, `owner-${randomUUID()}.tmp`);
    writeFileSync(temporary, payload, { flag: 'wx', mode: 0o600 });
    try {
      renameSync(temporary, destination);
    } catch (error: unknown) {
      rmSync(temporary, { force: true });
      throw error;
    }
    return destination;
  };
  const primary = persist(
    windowsSandboxAclPoisonDirectory(),
    windowsSandboxAclPoisonStagingDirectory(),
  );
  try {
    const legacy = persist(
      legacyWindowsSandboxAclPoisonDirectory(),
      legacyWindowsSandboxAclPoisonStagingDirectory(),
    );
    legacyWindowsSandboxAclOwnerMarkers.set(primary, legacy);
  } catch (error: unknown) {
    try {
      rmSync(primary, { force: true });
    } catch (rollbackError: unknown) {
      throw new AggregateError(
        [error, rollbackError],
        'Windows sandbox owner compatibility marker and primary rollback both failed.',
      );
    }
    throw error;
  }
  return primary;
}

function createWindowsSandboxAclOwnerMarker(policyKey?: string): string | undefined {
  const marker = persistWindowsSandboxAclPoisonOwner(
    undefined,
    undefined,
    'active',
    policyKey,
  );
  if (marker !== undefined) {
    activeWindowsSandboxAclOwnerMarkers.add(marker);
    const legacy = legacyWindowsSandboxAclOwnerMarkers.get(marker);
    if (legacy !== undefined) activeWindowsSandboxAclOwnerMarkers.add(legacy);
  }
  return marker;
}

function confirmWindowsSandboxAclOwnerStopped(marker: string | undefined): void {
  if (marker === undefined) return;
  const legacy = legacyWindowsSandboxAclOwnerMarkers.get(marker);
  try {
    if (legacy !== undefined) rmSync(legacy, { force: true });
    rmSync(marker, { force: true });
    activeWindowsSandboxAclOwnerMarkers.delete(marker);
    if (legacy !== undefined) activeWindowsSandboxAclOwnerMarkers.delete(legacy);
    legacyWindowsSandboxAclOwnerMarkers.delete(marker);
  } catch (error: unknown) {
    activeWindowsSandboxAclOwnerMarkers.delete(marker);
    if (legacy !== undefined) activeWindowsSandboxAclOwnerMarkers.delete(legacy);
    recordWindowsSandboxAclFailure(error);
    throw new Error('Windows sandbox owner poison marker could not be cleared.', { cause: error });
  }
}

async function retainWindowsSandboxAclOwnerPoison(
  marker: string | undefined,
  error: unknown,
): Promise<void> {
  recordWindowsSandboxAclFailure(error);
  const poisonError = await transitionWindowsSandboxAclOwnerToPoison(
    marker,
    undefined,
    undefined,
    error,
  );
  recordWindowsSandboxAclFailure(poisonError);
  if (poisonError !== error) throw poisonError;
}

function writeAheadWindowsSandboxAclOwnerPoison(
  marker: string | undefined,
  pid: number | undefined,
  processStartIdentity: string | undefined,
): string | undefined {
  if (marker === undefined) {
    return persistWindowsSandboxAclPoisonOwner(pid, processStartIdentity, 'recovery_pending');
  }
  const legacy = legacyWindowsSandboxAclOwnerMarkers.get(marker);
  const recoveryMarker = path.join(path.dirname(marker), `recovery-${path.basename(marker)}`);
  const recoveryLegacy = legacy === undefined
    ? undefined
    : path.join(path.dirname(legacy), `recovery-${path.basename(legacy)}`);
  if (!existsSync(marker) && existsSync(recoveryMarker)) {
    activeWindowsSandboxAclOwnerMarkers.delete(marker);
    if (legacy !== undefined) activeWindowsSandboxAclOwnerMarkers.delete(legacy);
    if (recoveryLegacy !== undefined && existsSync(recoveryLegacy)) {
      legacyWindowsSandboxAclOwnerMarkers.set(recoveryMarker, recoveryLegacy);
    }
    legacyWindowsSandboxAclOwnerMarkers.delete(marker);
    return recoveryMarker;
  }
  const owner = parseWindowsSandboxAclPoisonOwner(readFileSync(marker, 'utf8'));
  const recoveryOwner: WindowsSandboxAclPoisonOwner = {
    ...owner,
    version: 3,
    state: 'recovery_pending',
    ...(pid === undefined ? {} : { pid }),
    ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
  };
  const rewrite = (source: string, destination: string): void => {
    const stagingDirectory = path.dirname(destination) === windowsSandboxAclPoisonDirectory()
      ? windowsSandboxAclPoisonStagingDirectory()
      : legacyWindowsSandboxAclPoisonStagingDirectory();
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      stagingDirectory,
      `.recovery-${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temporary, JSON.stringify(recoveryOwner), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, destination);
      if (source !== destination) rmSync(source, { force: true });
    } catch (error: unknown) {
      rmSync(temporary, { force: true });
      throw error;
    }
  };
  try {
    rewrite(marker, recoveryMarker);
    if (legacy !== undefined && recoveryLegacy !== undefined) rewrite(legacy, recoveryLegacy);
    activeWindowsSandboxAclOwnerMarkers.delete(marker);
    if (legacy !== undefined) activeWindowsSandboxAclOwnerMarkers.delete(legacy);
    if (recoveryLegacy !== undefined) {
      legacyWindowsSandboxAclOwnerMarkers.set(recoveryMarker, recoveryLegacy);
    }
    legacyWindowsSandboxAclOwnerMarkers.delete(marker);
    return recoveryMarker;
  } catch (renameError: unknown) {
    try {
      const fallbackId = recoveryOwner.ticketId ?? randomUUID();
      const fallback = persistWindowsSandboxAclPoisonRecord(
        { ...recoveryOwner, ticketId: fallbackId },
        `recovery-owner-${fallbackId}.json`,
      );
      activeWindowsSandboxAclOwnerMarkers.delete(marker);
      if (legacy !== undefined) activeWindowsSandboxAclOwnerMarkers.delete(legacy);
      legacyWindowsSandboxAclOwnerMarkers.delete(marker);
      return fallback;
    } catch (persistError: unknown) {
      activeWindowsSandboxAclOwnerMarkers.delete(marker);
      if (legacy !== undefined) activeWindowsSandboxAclOwnerMarkers.delete(legacy);
      legacyWindowsSandboxAclOwnerMarkers.delete(marker);
      throw new AggregateError(
        [renameError, persistError],
        'Windows sandbox ACL poison write-ahead failed.',
      );
    }
  }
}

function bindWindowsSandboxAclOwnerToJob(
  marker: string | undefined,
  effectJob: WindowsEffectJob,
): void {
  if (process.platform !== 'win32' || marker === undefined) return;
  const legacy = legacyWindowsSandboxAclOwnerMarkers.get(marker);
  const supervisorProcessStartIdentity = readProcessStartIdentity(effectJob.supervisorPid);
  const sandboxSid = getWindowsSandboxUserStatus({
    srtWin: requirePreparedWindowsRunner().srtWin,
  }).sid;
  if (sandboxSid === undefined) {
    throw new Error('Windows sandbox Job binding could not verify the sandbox account SID.');
  }
  for (const file of [marker, legacy]) {
    if (file === undefined) continue;
    const owner = parseWindowsSandboxAclPoisonOwner(readFileSync(file, 'utf8'));
    const stagingDirectory = path.dirname(file) === windowsSandboxAclPoisonDirectory()
      ? windowsSandboxAclPoisonStagingDirectory()
      : legacyWindowsSandboxAclPoisonStagingDirectory();
    mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
    const temporary = path.join(stagingDirectory, `.contained-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify({
        ...owner,
        version: 3,
        state: 'active',
        containment: {
          kind: 'windows-job',
          jobName: effectJob.jobName,
          sandboxSid,
          supervisorPid: effectJob.supervisorPid,
          ...(supervisorProcessStartIdentity === undefined
            ? {}
            : { supervisorProcessStartIdentity }),
        },
      } satisfies WindowsSandboxAclPoisonOwner), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
    } catch (error: unknown) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

async function transitionWindowsSandboxAclOwnerToPoison(
  marker: string | undefined,
  pid: number | undefined,
  processStartIdentity: string | undefined,
  error: unknown,
): Promise<unknown> {
  if (process.platform !== 'win32') return error;
  let poisonedMarker: string | undefined;
  try {
    poisonedMarker = writeAheadWindowsSandboxAclOwnerPoison(
      marker,
      pid,
      processStartIdentity,
    );
    await withKodaXFileLock(
      windowsSandboxAclRecoveryLockFile(),
      async () => undefined,
      WINDOWS_SANDBOX_ACL_RECOVERY_LOCK_TIMEOUT_MS,
    );
    return error;
  } catch (persistError: unknown) {
    return new AggregateError(
      [error, persistError],
      poisonedMarker === undefined
        ? 'Windows sandbox owner termination and durable ACL poison recording both failed.'
        : 'Windows sandbox owner termination was not confirmed and ACL poison serialization failed.',
    );
  }
}

function isVerifiedActiveWindowsSandboxAclOwner(
  file: string,
  _owner: WindowsSandboxAclPoisonOwner,
): boolean {
  return activeWindowsSandboxAclOwnerMarkers.has(file);
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

async function windowsSandboxSidIsIdle(expectedSid?: string): Promise<boolean> {
  try {
    const runner = requirePreparedWindowsRunner();
    const status = getWindowsSandboxUserStatus({ srtWin: runner.srtWin });
    const sid = expectedSid ?? status.sid;
    if (sid === undefined || (status.sid !== undefined && status.sid !== sid)) return false;
    return !(await windowsSandboxSidHasOtherProcesses(sid, {
      executable: runner.srtWin.exe,
      prependArgs: runner.srtWin.prependArgs,
    }));
  } catch (error: unknown) {
    emitKodaXDiagnostic({
      source: 'runtime:sandbox-acl-recovery',
      level: 'warn',
      message: 'Windows sandbox-user process inspection failed; ACL recovery remains fenced for automatic retry.',
      detail: error,
    });
    return false;
  }
}

async function canAutomaticallyRecoverUncontainedWindowsSandboxAclOwners(
  entries: ReadonlyArray<{ readonly owner: WindowsSandboxAclPoisonOwner }>,
): Promise<boolean> {
  return entries.length > 0
    && entries.every(({ owner }) => (
      owner.containment === undefined
      && windowsSandboxAclOwnerLiveness(owner) === 'stale'
    ))
    && await windowsSandboxSidIsIdle();
}

function isCompatibleWindowsSandboxAclOwner(
  file: string,
  owner: WindowsSandboxAclPoisonOwner,
  policyKey: string | undefined,
): boolean {
  if (owner.state !== 'active') return false;
  if (activeWindowsSandboxAclOwnerMarkers.has(file)) {
    return policyKey === undefined || owner.policyKey === policyKey;
  }
  return policyKey !== undefined
    && owner.policyKey === policyKey
    && windowsSandboxAclOwnerLiveness(owner) === 'live';
}

function assertNoPersistentWindowsSandboxAclPoison(policyKey?: string): void {
  const poisoned = readWindowsSandboxAclPoisonOwners().filter(
    ({ file, owner }) => !isCompatibleWindowsSandboxAclOwner(file, owner, policyKey),
  );
  if (poisoned.length === 0) return;
  throw persistentWindowsSandboxAclPoisonError(poisoned.map(({ owner }) => owner));
}

async function recordUnconfirmedWindowsSandboxOwner(
  pid: number | undefined,
  processStartIdentity: string | undefined,
  message: string,
  marker?: string,
): Promise<Error> {
  const error = new Error(message);
  if (process.platform === 'win32') {
    const durableError = await transitionWindowsSandboxAclOwnerToPoison(
      marker,
      pid,
      processStartIdentity,
      error,
    );
    recordWindowsSandboxAclFailure(durableError);
    return durableError instanceof Error ? durableError : error;
  }
  recordWindowsSandboxAclFailure(error);
  return error;
}

function unconfirmedSandboxProcessTreeMessage(subject: string): string {
  if (process.platform === 'win32') {
    return `${subject} process-tree termination was not confirmed; automatic Job recovery is pending.`;
  }
  return `${subject} process-tree termination was not confirmed; stop the retained process tree before retrying.`;
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
      undefined,
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
  windowsSandboxAclStartupRecovered = true;
}

/**
 * Recover Windows ACL residue only for one daemon whose Job containment has
 * already proved empty. This remains an internal lifecycle authority: callers
 * cannot request force recovery or delete arbitrary marker paths.
 */
export async function recoverWindowsSandboxAclsForRuntimeOwner(
  configHome: string,
  owner: {
    readonly pid: number;
    readonly processStartIdentity?: string;
  },
  windowsBootIdentity: string,
  timeoutMs = 70_000,
): Promise<number> {
  if (process.platform !== 'win32') return 0;
  if (owner.processStartIdentity === undefined) {
    throw new Error('Windows sandbox ACL recovery requires an exact daemon process identity.');
  }
  const deadline = Date.now() + timeoutMs;
  return withKodaXFileLock(
    windowsSandboxAclRecoveryLockFile(),
    async () => {
      const markers = readWindowsSandboxAclPoisonOwners(configHome);
      const matching = markers.filter(({ owner: markerOwner }) => (
        markerOwner.holderPid === owner.pid
        && markerOwner.holderProcessStartIdentity === owner.processStartIdentity
        && markerOwner.windowsBootIdentity === windowsBootIdentity
      ));
      if (matching.length !== markers.length) {
        throw new WindowsSandboxAclAdmissionError(
          'Windows sandbox ACL recovery found a foreign or unverifiable owner marker.',
        );
      }
      if (matching.length === 0) return 0;
      await waitForWindowsSandboxRunnerPreparation(
        prepareWindowsSandboxRunner(),
        Math.max(1, deadline - Date.now()),
      );
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error('Windows sandbox ACL recovery deadline expired before mutation.');
      }
      await recoverWindowsSandboxAcls(remainingMs);
      return matching.length;
    },
    Math.max(1, Math.min(WINDOWS_SANDBOX_ACL_RECOVERY_LOCK_TIMEOUT_MS, timeoutMs)),
  );
}

/** @internal Recover ACLs only for markers proven to predate the current Windows boot. */
export async function recoverPreviousBootWindowsSandboxAcls(
  configHome: string,
  timeoutMs = 70_000,
): Promise<number> {
  if (process.platform !== 'win32') return 0;
  const deadline = Date.now() + timeoutMs;
  return withKodaXFileLock(
    windowsSandboxAclRecoveryLockFile(),
    async () => {
      const markers = readWindowsSandboxAclPoisonOwners(configHome);
      if (markers.length === 0) return 0;
      assertPreviousBootWindowsSandboxAclMarkers(markers);
      await waitForWindowsSandboxRunnerPreparation(
        prepareWindowsSandboxRunner(),
        Math.max(1, deadline - Date.now()),
      );
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error('Windows sandbox ACL recovery deadline expired before mutation.');
      }
      await recoverWindowsSandboxAcls(remainingMs);
      return markers.length;
    },
    Math.max(1, Math.min(WINDOWS_SANDBOX_ACL_RECOVERY_LOCK_TIMEOUT_MS, timeoutMs)),
  );
}

function assertPreviousBootWindowsSandboxAclMarkers(
  markers: ReadonlyArray<{ readonly owner: WindowsSandboxAclPoisonOwner }>,
): void {
  const currentBootIdentity = readWindowsBootIdentity();
  if (currentBootIdentity === undefined || !isCanonicalWindowsBootIdentity(currentBootIdentity)) {
    throw new WindowsSandboxAclAdmissionError(
      'Windows sandbox ACL recovery could not verify the current boot identity.',
      { recoveryAction: 'automatic-retry' },
    );
  }
  if (markers.some(({ owner }) => owner.windowsBootIdentity === undefined)) {
    throw new WindowsSandboxAclAdmissionError(
      'Windows sandbox ACL recovery found an unverifiable owner marker.',
      { recoveryAction: 'automatic-retry' },
    );
  }
  if (markers.some(({ owner }) => owner.windowsBootIdentity === currentBootIdentity)) {
    throw new WindowsSandboxAclAdmissionError(
      'Windows sandbox ACL recovery found a current-boot owner marker.',
      { recoveryAction: 'automatic-retry' },
    );
  }
}

async function waitForWindowsSandboxRunnerPreparation(
  preparation: Promise<PreparedWindowsSandboxRunner>,
  timeoutMs: number,
): Promise<PreparedWindowsSandboxRunner> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Windows sandbox runner preparation timed out.')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([preparation, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** @internal Clear only markers whose ACL recovery was durably recorded. */
export async function clearWindowsSandboxAclMarkersForRuntimeOwner(
  configHome: string,
  owner: {
    readonly pid: number;
    readonly processStartIdentity?: string;
  },
  windowsBootIdentity: string,
  timeoutMs = 40_000,
): Promise<number> {
  if (process.platform !== 'win32') return 0;
  if (owner.processStartIdentity === undefined) {
    throw new Error('Windows sandbox marker cleanup requires an exact daemon process identity.');
  }
  return withKodaXFileLock(
    windowsSandboxAclRecoveryLockFile(),
    async () => {
      const markers = readWindowsSandboxAclPoisonOwners(configHome);
      const matching = markers.filter(({ owner: markerOwner }) => (
        markerOwner.holderPid === owner.pid
        && markerOwner.holderProcessStartIdentity === owner.processStartIdentity
        && markerOwner.windowsBootIdentity === windowsBootIdentity
      ));
      if (matching.length !== markers.length) {
        throw new WindowsSandboxAclAdmissionError(
          'Windows sandbox marker cleanup found a foreign or unverifiable owner marker.',
        );
      }
      for (const marker of matching) rmSync(marker.file, { force: true });
      return matching.length;
    },
    Math.max(1, Math.min(WINDOWS_SANDBOX_ACL_RECOVERY_LOCK_TIMEOUT_MS, timeoutMs)),
  );
}

/** @internal Clear only previous-boot markers whose ACL recovery is durably recorded. */
export async function clearPreviousBootWindowsSandboxAclMarkers(
  configHome: string,
  timeoutMs = 40_000,
): Promise<number> {
  if (process.platform !== 'win32') return 0;
  return withKodaXFileLock(
    windowsSandboxAclRecoveryLockFile(),
    async () => {
      const markers = readWindowsSandboxAclPoisonOwners(configHome);
      if (markers.length === 0) return 0;
      assertPreviousBootWindowsSandboxAclMarkers(markers);
      for (const marker of markers) rmSync(marker.file, { force: true });
      return markers.length;
    },
    Math.max(1, Math.min(WINDOWS_SANDBOX_ACL_RECOVERY_LOCK_TIMEOUT_MS, timeoutMs)),
  );
}

function isWindowsSandboxAclRecoveryLockTimeout(error: unknown): boolean {
  return error instanceof KodaXFileLockTimeoutError;
}

class ForeignWindowsSandboxAclOwnerContentionError extends WindowsSandboxAclAdmissionError {
  constructor(cause: Error) {
    super(
      'Another Windows sandbox owner is active for the shared sandbox account; '
      + 'recovery is waiting and will retry automatically; non-sandbox work remains available.',
      { cause, recoveryAction: 'automatic-retry' },
    );
    this.name = 'ForeignWindowsSandboxAclOwnerContentionError';
  }
}

class StaleWindowsSandboxAclOwnerContentionError extends WindowsSandboxAclAdmissionError {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = 'StaleWindowsSandboxAclOwnerContentionError';
  }
}

function recordWindowsSandboxAclAdmissionFailure(error: unknown): void {
  if (
    isWindowsSandboxAclRecoveryLockTimeout(error)
    || error instanceof ForeignWindowsSandboxAclOwnerContentionError
    || error instanceof StaleWindowsSandboxAclOwnerContentionError
  ) {
    scheduleWindowsSandboxAclRecoveryRetry();
    return;
  }
  recordWindowsSandboxAclFailure(error);
}

interface WindowsSandboxAclPoisonEntry {
  readonly file: string;
  readonly owner: WindowsSandboxAclPoisonOwner;
}

function windowsSandboxAclPoisonSnapshotError(
  poisoned: ReadonlyArray<WindowsSandboxAclPoisonEntry>,
  currentBootIdentity = readWindowsBootIdentity(),
): Error {
  const error = persistentWindowsSandboxAclPoisonError(
    poisoned.map(({ owner }) => owner),
    currentBootIdentity,
  );
  if (poisoned.every(({ owner }) => owner.state === 'active')) {
    return poisoned.some(({ owner }) => windowsSandboxAclOwnerLiveness(owner) === 'stale')
      ? new StaleWindowsSandboxAclOwnerContentionError(error)
      : new ForeignWindowsSandboxAclOwnerContentionError(error);
  }
  return error;
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
    assertNoPersistentWindowsSandboxAclPoison();
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

function groupWindowsSandboxAclPoisonEntries(
  poisoned: ReadonlyArray<WindowsSandboxAclPoisonEntry>,
  key: (entry: WindowsSandboxAclPoisonEntry) => string | undefined,
): Map<string, WindowsSandboxAclPoisonEntry[]> {
  const grouped = new Map<string, WindowsSandboxAclPoisonEntry[]>();
  for (const entry of poisoned) {
    const groupKey = key(entry);
    if (groupKey === undefined) continue;
    grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), entry]);
  }
  return grouped;
}

async function assertWindowsSandboxAclPoisonIsRecoverable(
  poisoned: ReadonlyArray<WindowsSandboxAclPoisonEntry>,
  currentBootIdentity: string | undefined,
): Promise<void> {
  const activeOrUnknown = poisoned.filter(({ owner }) => (
    owner.state === 'active'
    && windowsSandboxAclOwnerLiveness(owner) !== 'stale'
    && (
      owner.containment === undefined
      || !recoverableWindowsEffectFences.has(owner.containment.jobName)
    )
  ));
  if (activeOrUnknown.length > 0) {
    throw windowsSandboxAclPoisonSnapshotError(activeOrUnknown, currentBootIdentity);
  }
  const fromEarlierBoot = currentBootIdentity !== undefined
    && poisoned.every(({ owner }) => (
      owner.windowsBootIdentity !== undefined
      && owner.windowsBootIdentity !== currentBootIdentity
    ));
  if (fromEarlierBoot) return;
  const tickets = groupWindowsSandboxAclPoisonEntries(
    poisoned,
    (entry) => entry.owner.ticketId ?? entry.file,
  );
  const uncontainedSafe = await canAutomaticallyRecoverUncontainedWindowsSandboxAclOwners(poisoned);
  const recoverable = [...tickets.values()].every((entries) => (
    entries.some(({ owner }) => owner.containment !== undefined)
    || entries.every(({ owner }) => owner.version === 3 && owner.state === 'active' && owner.pid === undefined)
    || uncontainedSafe
  ));
  if (!recoverable) throw windowsSandboxAclPoisonSnapshotError(poisoned, currentBootIdentity);
}

async function drainWindowsSandboxAclRecoveryJobs(
  jobs: ReadonlyMap<string, ReadonlyArray<WindowsSandboxAclPoisonEntry>>,
): Promise<void> {
  for (const [jobName, entries] of jobs) {
    const result = await terminateWindowsEffectJob(jobName);
    if (result !== 'not_found' || jobName.startsWith('Global\\')) continue;
    const sandboxSids = new Set(entries.flatMap(({ owner }) => (
      owner.containment?.sandboxSid === undefined ? [] : [owner.containment.sandboxSid]
    )));
    if (sandboxSids.size === 1 && await windowsSandboxSidIsIdle([...sandboxSids][0])) continue;
    throw new WindowsSandboxAclAdmissionError(
      'Windows sandbox Job recovery is waiting for exact process-drain proof; '
      + 'recovery will retry automatically and non-sandbox work remains available.',
      { recoveryAction: 'automatic-retry' },
    );
  }
}

async function completeWindowsSandboxAclRecovery(
  owners: ReadonlyArray<WindowsSandboxAclPoisonEntry>,
  poisoned: ReadonlyArray<WindowsSandboxAclPoisonEntry>,
  jobs: ReadonlyMap<string, ReadonlyArray<WindowsSandboxAclPoisonEntry>>,
  policyKey: string | undefined,
): Promise<void> {
  const poisonedFiles = new Set(poisoned.map(({ file }) => file));
  if (!owners.some(({ file }) => !poisonedFiles.has(file))) await recoverWindowsSandboxAcls();
  for (const jobName of jobs.keys()) {
    const fence = recoverableWindowsEffectFences.get(jobName);
    if (fence === undefined) continue;
    await finishAndReleaseFileSystemEffectLease(fence);
    recoverableWindowsEffectFences.delete(jobName);
  }
  for (const marker of poisoned) rmSync(marker.file, { force: true });
  clearWindowsSandboxAclRecoveryRetry();
  windowsSandboxAclStartupRecovered = true;
  assertNoPersistentWindowsSandboxAclPoison(policyKey);
}

async function ensureWindowsSandboxAclRecoveryWithLock(policyKey?: string): Promise<void> {
  const owners = readWindowsSandboxAclPoisonOwners();
  const poisoned = owners.filter(
    ({ file, owner }) => !isCompatibleWindowsSandboxAclOwner(file, owner, policyKey),
  );
  if (poisoned.length > 0) {
    await assertWindowsSandboxAclPoisonIsRecoverable(poisoned, readWindowsBootIdentity());
    const jobs = groupWindowsSandboxAclPoisonEntries(
      poisoned,
      (entry) => entry.owner.containment?.jobName,
    );
    await drainWindowsSandboxAclRecoveryJobs(jobs);
    await completeWindowsSandboxAclRecovery(owners, poisoned, jobs, policyKey);
    return;
  }
  if (owners.length > 0 || windowsSandboxAclStartupRecovered) {
    clearWindowsSandboxAclRecoveryRetry();
    return;
  }
  await recoverWindowsSandboxAcls();
  clearWindowsSandboxAclRecoveryRetry();
  windowsSandboxAclStartupRecovered = true;
  assertNoPersistentWindowsSandboxAclPoison(policyKey);
}

async function recoverUnreadableWindowsSandboxAclTicketsWithFence(
  policyKey?: string,
): Promise<void> {
  await withKodaXFileLock(
    windowsSandboxAclRecoveryLockFile(),
    async () => {
      try {
        await ensureWindowsSandboxAclRecoveryWithLock(policyKey);
      } catch (error: unknown) {
        if (!(error instanceof UnreadableWindowsSandboxAclRecoveryTicketError)) throw error;
        if (!(await windowsSandboxSidIsIdle())) throw error;
        await recoverWindowsSandboxAcls();
        for (const file of listWindowsSandboxAclPoisonFiles()) rmSync(file, { force: true });
        clearWindowsSandboxAclRecoveryRetry();
        windowsSandboxAclStartupRecovered = true;
        assertNoPersistentWindowsSandboxAclPoison(policyKey);
      }
    },
    WINDOWS_SANDBOX_ACL_RECOVERY_LOCK_TIMEOUT_MS,
  );
}

async function ensureWindowsSandboxAclRecovery(
  policyKey?: string,
  effectFenceHeld = false,
): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    await withKodaXFileLock(
      windowsSandboxAclRecoveryLockFile(),
      async () => ensureWindowsSandboxAclRecoveryWithLock(policyKey),
      WINDOWS_SANDBOX_ACL_RECOVERY_LOCK_TIMEOUT_MS,
    );
  } catch (error: unknown) {
    if (error instanceof UnreadableWindowsSandboxAclRecoveryTicketError) {
      try {
        if (effectFenceHeld) {
          await recoverUnreadableWindowsSandboxAclTicketsWithFence(policyKey);
          return;
        }
        const release = await acquireExclusiveFileSystemEffectLease();
        try {
          await recoverUnreadableWindowsSandboxAclTicketsWithFence(policyKey);
        } finally {
          await release();
        }
        return;
      } catch (recoveryError: unknown) {
        recordWindowsSandboxAclAdmissionFailure(recoveryError);
        throw recoveryError;
      }
    }
    recordWindowsSandboxAclAdmissionFailure(error);
    throw error;
  }
}

async function admitWindowsSandboxAclOwner(policyKey?: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  await ensureWindowsSandboxAclRecovery(policyKey, true);
  let admittedMarker: string | undefined;
  try {
    return await withKodaXFileLock(
      windowsSandboxAclRecoveryLockFile(),
      async () => {
        assertNoPersistentWindowsSandboxAclPoison(policyKey);
        admittedMarker = createWindowsSandboxAclOwnerMarker(policyKey);
        return admittedMarker;
      },
      WINDOWS_SANDBOX_ACL_RECOVERY_LOCK_TIMEOUT_MS,
    );
  } catch (error: unknown) {
    if (admittedMarker === undefined) {
      recordWindowsSandboxAclAdmissionFailure(error);
      throw error;
    }
    try {
      confirmWindowsSandboxAclOwnerStopped(admittedMarker);
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        'Windows sandbox owner admission and marker cleanup both failed.',
      );
    }
    throw error;
  }
}

async function confirmWindowsSandboxAclRecovery(
  marker?: string,
): Promise<void> {
  if (process.platform !== 'win32') return;
  let policyKey: string | undefined;
  try {
    if (marker === undefined || !activeWindowsSandboxAclOwnerMarkers.has(marker)) return;
    policyKey = parseWindowsSandboxAclPoisonOwner(readFileSync(marker, 'utf8')).policyKey;
    if (policyKey !== undefined) {
      await withKodaXFileLock(
        windowsSandboxAclRecoveryLockFile(),
        async () => {
          const legacy = legacyWindowsSandboxAclOwnerMarkers.get(marker);
          const ownedFiles = new Set([marker, legacy].filter((file) => file !== undefined));
          const remaining = readWindowsSandboxAclPoisonOwners().filter(
            ({ file }) => !ownedFiles.has(file),
          );
          const incompatible = remaining.filter(
            ({ file, owner }) => !isCompatibleWindowsSandboxAclOwner(file, owner, policyKey),
          );
          if (incompatible.length > 0) {
            throw windowsSandboxAclPoisonSnapshotError(incompatible);
          }
          if (remaining.length > 0) {
            confirmWindowsSandboxAclOwnerStopped(marker);
            return;
          }
          await recoverWindowsSandboxAcls();
          confirmWindowsSandboxAclOwnerStopped(marker);
        },
        WINDOWS_SANDBOX_ACL_RECOVERY_LOCK_TIMEOUT_MS,
      );
      return;
    }
    const poisonedMarker = writeAheadWindowsSandboxAclOwnerPoison(
      marker,
      undefined,
      undefined,
    );
    await withKodaXFileLock(
      windowsSandboxAclRecoveryLockFile(),
      async () => {
        await recoverWindowsSandboxAcls();
        confirmWindowsSandboxAclOwnerStopped(poisonedMarker);
        if (marker !== poisonedMarker) confirmWindowsSandboxAclOwnerStopped(marker);
      },
      WINDOWS_SANDBOX_ACL_RECOVERY_LOCK_TIMEOUT_MS,
    );
  } catch (error: unknown) {
    const durableError = policyKey === undefined
      ? error
      : await transitionWindowsSandboxAclOwnerToPoison(
          marker,
          undefined,
          undefined,
          error,
        );
    recordWindowsSandboxAclFailure(durableError);
    throw durableError;
  }
}

function releasePreparedWindowsRunnerGrant(): void {
  if (preparedWindowsRunnerGrant === undefined) return;
  revokeWindowsAcl({
    sandboxUserSid: preparedWindowsRunnerGrant.sandboxUserSid,
    holderPid: process.pid,
    srtWin: preparedWindowsRunnerGrant.runner.srtWin,
  });
  preparedWindowsRunnerGrant = undefined;
}

function retainPreparedWindowsRunnerGrant(
  runner: PreparedWindowsSandboxRunner,
  sandboxUserSid: string,
): void {
  if (
    preparedWindowsRunnerGrant?.runner.path === runner.path
    && preparedWindowsRunnerGrant.sandboxUserSid === sandboxUserSid
  ) {
    return;
  }
  process.removeListener('exit', releasePreparedWindowsRunnerGrant);
  releasePreparedWindowsRunnerGrant();
  try {
    grantWindowsAcl({
      read: [runner.directory, runner.path],
      write: [],
      sandboxUserSid,
      holderPid: process.pid,
      srtWin: runner.srtWin,
    });
  } catch (grantError: unknown) {
    try {
      revokeWindowsAcl({
        sandboxUserSid,
        holderPid: process.pid,
        srtWin: runner.srtWin,
      });
    } catch (revokeError: unknown) {
      throw new AggregateError(
        [grantError, revokeError],
        'Windows sandbox runner ACL grant failed and its partial grant could not be revoked.',
      );
    }
    throw grantError;
  }
  preparedWindowsRunnerGrant = { runner, sandboxUserSid };
  process.once('exit', releasePreparedWindowsRunnerGrant);
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
  let safetyBlocked = false;
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
      if (accountDiagnostics.length > 0 || !user.sid) {
        setupRequired = true;
        diagnostics.push(...accountDiagnostics);
      } else {
        retainPreparedWindowsRunnerGrant(runner, user.sid);
        const missingGuards = runWindowsAclGuard(
          windowsPersistentAclGuardRoots(),
          user.sid,
          user.groupSid,
          false,
          'read',
        );
        if (missingGuards.length > 0) {
          setupRequired = true;
          diagnostics.push(
            `[acl_guards_missing] ${missingGuards.length} persistent Windows sandbox ACL guard(s) are missing. `
            + 'Run "kodax sandbox setup" once to install them outside the startup path.',
          );
        }
        await verifyPreparedWindowsWfp(runner);
      }
    } catch (error: unknown) {
      setupRequired = true;
      diagnostics.push(errorText(error));
    }
    try {
      const poisoned = readWindowsSandboxAclPoisonOwners().filter(
        ({ file, owner }) => !isVerifiedActiveWindowsSandboxAclOwner(file, owner),
      );
      if (poisoned.length > 0) {
        const currentBootIdentity = readWindowsBootIdentity();
        const allFromEarlierBoot = currentBootIdentity !== undefined
          && poisoned.every(({ owner }) => (
            owner.windowsBootIdentity !== undefined
            && owner.windowsBootIdentity !== currentBootIdentity
          ));
        if (!allFromEarlierBoot) {
          safetyBlocked = true;
          diagnostics.push(
            `${WINDOWS_SANDBOX_ACL_CLEANUP_DIAGNOSTIC} `
            + windowsSandboxAclPoisonSnapshotError(poisoned, currentBootIdentity).message,
          );
        }
      }
    } catch (error: unknown) {
      safetyBlocked = true;
      diagnostics.push(`${WINDOWS_SANDBOX_ACL_CLEANUP_DIAGNOSTIC} ${errorText(error)}`);
    }
  }
  return {
    ready: SandboxManager.isSupportedPlatform() && !setupRequired && !safetyBlocked,
    platform: process.platform,
    version: KODAX_ASRT_VERSION,
    diagnostics,
    setupRequired,
  };
}

async function setupWindowsSandboxRuntimeWithLock(): Promise<SandboxRuntimeDoctorResult> {
  const initial = await doctorSandboxRuntime({ refresh: true });
  try {
    const setupBlock = await windowsSandboxAclSetupBlockWithLock();
    if (setupBlock !== undefined) return withWindowsSandboxAclSetupBlock(initial, setupBlock);
  } catch (error: unknown) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    return withWindowsSandboxAclSetupBlock(initial, normalized);
  }
  if (initial.ready) return initial;
  if (doctorHasWindowsSandboxAclCleanupBlock(initial)) return initial;
  if (!initial.setupRequired) return initial;
  let accountReady = false;
  try {
    const runner = await prepareWindowsSandboxRunner();
    const user = getWindowsSandboxUserStatus({ srtWin: runner.srtWin });
    accountReady = windowsSandboxAccountDiagnostics(user).length === 0 && user.sid !== undefined;
  } catch {
    accountReady = false;
  }
  if (accountReady) {
    installWindowsAclGuards(windowsPersistentAclGuardRoots(), 'read');
    const repaired = await doctorSandboxRuntime({ refresh: true });
    if (repaired.ready) return repaired;
  }
  const runner = await prepareWindowsSandboxRunner();
  const result = installWindowsSandbox({ srtWin: runner.srtWin });
  if (result.cancelled) throw new Error('Sandbox setup was cancelled.');
  installWindowsAclGuards(windowsPersistentAclGuardRoots(), 'read');
  return doctorSandboxRuntime({ refresh: true });
}

export async function setupSandboxRuntime(): Promise<SandboxRuntimeDoctorResult> {
  if (process.platform !== 'win32') return doctorSandboxRuntime({ refresh: true });
  return withKodaXFileLock(
    windowsSandboxAclRecoveryLockFile(),
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

async function collectProcess(
  child: ReturnType<typeof spawn>,
  signal?: AbortSignal,
  timeoutMs = SCRIPT_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  windowsAclOwnerMarker?: string,
  deferWindowsOwnerSettlement = false,
): Promise<SandboxProcessResult> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const childProcessStartIdentity = child.pid === undefined
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
    const unconfirmedTermination = async (cause?: unknown): Promise<Error> => {
      const terminationError = deferWindowsOwnerSettlement
        ? new Error(unconfirmedSandboxProcessTreeMessage('Sandbox broker'))
        : await recordUnconfirmedWindowsSandboxOwner(
            child.pid,
            childProcessStartIdentity,
            unconfirmedSandboxProcessTreeMessage('Sandbox broker'),
            windowsAclOwnerMarker,
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
      await terminationProof;
      throw stopError;
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

async function prepareStandaloneBrokerLaunch(
  args: readonly string[],
  requestDirectory: string,
  controlPipe = false,
): Promise<StandaloneBrokerLaunch> {
  const brokerLaunch = prepareInternalNodeLaunch({
    args,
    env: sanitizedEnvironment(),
    isElectron: process.versions.electron !== undefined,
  });
  if (process.platform !== 'win32') {
    return { command: process.execPath, ...brokerLaunch };
  }
  return prepareWindowsGatedLaunch({
    command: process.execPath,
    args: brokerLaunch.args,
    env: brokerLaunch.env,
    cwd: requirePreparedWindowsRunner().directory,
    controlPipe,
  }, requestDirectory);
}

async function containStandaloneBrokerFence(
  fence: Awaited<ReturnType<typeof acquireExclusiveFileSystemEffectLease>>,
  child: ReturnType<typeof spawn>,
): Promise<WindowsEffectJob> {
  if (child.pid === undefined || child.stdin === null) {
    throw new Error('Standalone sandbox broker gate did not expose a PID and stdin.');
  }
  await fence.bindEffectProcess(child.pid, false);
  return containWindowsEffectProcess(child.pid);
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

interface StandaloneBrokerSettlement {
  child: ReturnType<typeof spawn>,
  effectJob?: WindowsEffectJob;
  fence: Awaited<ReturnType<typeof acquireExclusiveFileSystemEffectLease>>;
  marker?: string;
  targetStartAttempted: boolean;
  terminateFirst: boolean;
}

async function proveStandaloneBrokerDrained(
  settlement: StandaloneBrokerSettlement,
): Promise<void> {
  const { child, effectJob, targetStartAttempted, terminateFirst } = settlement;
  if (!targetStartAttempted) {
    await closeSandboxGate(child).catch(() => undefined);
    if (effectJob !== undefined) {
      await terminateWindowsEffectJob(effectJob.jobName);
      await effectJob.drained;
    } else {
      await killChildProcessTree(child);
    }
    return;
  }
  if (terminateFirst) {
    if (effectJob !== undefined) {
      await terminateWindowsEffectJob(effectJob.jobName);
    } else {
      const termination = await killChildProcessTree(child);
      if (termination.status === 'unknown') {
        throw new Error('Standalone sandbox broker process tree drain was not confirmed.');
      }
    }
  }
  if (effectJob !== undefined) {
    await effectJob.drained;
  } else if (!terminateFirst) {
    const termination = await killChildProcessTree(child);
    if (termination.status === 'unknown') {
      throw new Error('Standalone sandbox broker process tree drain was not confirmed.');
    }
  }
}

function reportDeferredStandaloneBrokerSettlement(error: unknown): void {
  emitKodaXDiagnostic({
    source: 'sandbox:standalone-broker',
    level: 'warn',
    message: 'Standalone sandbox broker cleanup remains durably fenced.',
    detail: error,
  });
}

function unrefStandaloneBrokerResource(resource: object | null): void {
  if (resource === null) return;
  const unref = Reflect.get(resource, 'unref');
  if (typeof unref === 'function') unref.call(resource);
}

function detachDeferredStandaloneBroker(input: StandaloneBrokerSettlement): void {
  input.effectJob?.unref?.();
  input.child.unref();
  unrefStandaloneBrokerResource(input.child.stdin);
  unrefStandaloneBrokerResource(input.child.stdout);
  unrefStandaloneBrokerResource(input.child.stderr);
}

function trackDeferredStandaloneBrokerSettlement(input: StandaloneBrokerSettlement): void {
  detachDeferredStandaloneBroker(input);
  trackPendingStandaloneBrokerSettlement(settleStandaloneBrokerOwnershipUntilRecovered(input));
}

function trackDeferredStandaloneFenceRelease(input: StandaloneBrokerSettlement): void {
  detachDeferredStandaloneBroker(input);
  trackPendingStandaloneBrokerSettlement(releaseStandaloneBrokerFenceUntilRecovered(input));
}

function trackPendingStandaloneBrokerSettlement(settlement: Promise<void>): void {
  pendingStandaloneBrokerSettlements.add(settlement);
  void settlement.then(
    () => pendingStandaloneBrokerSettlements.delete(settlement),
    (error: unknown) => {
      pendingStandaloneBrokerSettlements.delete(settlement);
      reportDeferredStandaloneBrokerSettlement(error);
    },
  );
}

async function confirmStandaloneBrokerOwnershipRecovered(
  input: StandaloneBrokerSettlement,
): Promise<void> {
  try {
    await proveStandaloneBrokerDrained(input);
    if (input.targetStartAttempted) await confirmWindowsSandboxAclRecovery(input.marker);
    else confirmWindowsSandboxAclOwnerStopped(input.marker);
  } catch (error: unknown) {
    await retainWindowsSandboxAclOwnerPoison(input.marker, error);
    throw error;
  }
}

async function releaseStandaloneBrokerFenceUntilRecovered(
  input: StandaloneBrokerSettlement,
): Promise<void> {
  let retryDelayMs = 250;
  while (true) {
    try {
      await finishAndReleaseFileSystemEffectLease(input.fence);
      if (input.effectJob !== undefined) {
        recoverableWindowsEffectFences.delete(input.effectJob.jobName);
      }
      return;
    } catch (error: unknown) {
      reportDeferredStandaloneBrokerSettlement(error);
      await Promise.race([
        input.fence.released,
        waitForUnreferencedRetry(retryDelayMs),
      ]);
      retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
    }
  }
}

async function settleStandaloneBrokerOwnershipUntilRecovered(
  input: StandaloneBrokerSettlement,
): Promise<void> {
  await confirmStandaloneBrokerOwnershipRecovered(input);
  await releaseStandaloneBrokerFenceUntilRecovered(input);
}

async function settleStandaloneBrokerOwnershipInForeground(
  input: StandaloneBrokerSettlement,
): Promise<void> {
  await confirmStandaloneBrokerOwnershipRecovered(input);
  try {
    await finishAndReleaseFileSystemEffectLease(input.fence);
    if (input.effectJob !== undefined) {
      recoverableWindowsEffectFences.delete(input.effectJob.jobName);
    }
  } catch (error: unknown) {
    reportDeferredStandaloneBrokerSettlement(error);
    trackDeferredStandaloneFenceRelease(input);
  }
}

function waitForUnreferencedRetry(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
}

async function runBrokerResult(
  request: SandboxBrokerRequest,
  signal?: AbortSignal,
  timeoutMs = SCRIPT_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
): Promise<SandboxProcessResult> {
  const requestDirectory = process.platform === 'win32'
    ? await sandboxControlDirectory()
    : os.tmpdir();
  const requestFile = path.join(requestDirectory, `kodax-asrt-${process.pid}-${randomUUID()}.json`);
  const guardedConfig = process.platform === 'win32'
    ? withoutWindowsAsrtDenyPropagation(request.config)
    : {
        ...request.config,
        filesystem: {
          ...request.config.filesystem,
          denyRead: [...request.config.filesystem.denyRead, requestFile],
        },
      };
  const protectedRequest: SandboxBrokerRequest = {
    ...request,
    bootstrapCommand: request.bootstrapCommand ?? sandboxJavaScriptCommand(),
    config: guardedConfig,
  };
  await writeFile(requestFile, JSON.stringify(protectedRequest), { mode: 0o600 });
  let executionFailure: unknown;
  let windowsAclOwnerMarker: string | undefined;
  let windowsOwnerFence:
    | Awaited<ReturnType<typeof acquireExclusiveFileSystemEffectLease>>
    | undefined;
  let brokerChild: ReturnType<typeof spawn> | undefined;
  let brokerEffectJob: WindowsEffectJob | undefined;
  let brokerGateFile: string | undefined;
  let brokerStartAttempted = false;
  let standaloneOwnershipManaged = false;
  try {
    if (process.platform === 'win32') {
      await waitForWorkspaceSessionResets();
      const leasedSessions = await closeIdleCachedWorkspaceSessionsForStandalone();
      if (leasedSessions > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, WORKSPACE_SESSION_TERMINATE_GRACE_MS);
          timer.unref?.();
        });
        const stillLeased = await closeIdleCachedWorkspaceSessionsForStandalone();
        if (stillLeased > 0) {
          throw new Error(
            `A leased workspace sandbox session is still active (${String(stillLeased)}); `
            + 'standalone sandbox admission is unavailable until its background command completes.',
          );
        }
      }
      await ensureWindowsSandboxAclRecovery();
      windowsOwnerFence = await acquireExclusiveFileSystemEffectLease();
    }
    const args = process.env.KODAX_BUNDLED === 'true'
      ? ['__asrt-broker', requestFile]
      : ['--input-type=module', '-e', BROKER_SOURCE, ASRT_MODULE_URL!, requestFile];
    const launch = await prepareStandaloneBrokerLaunch(args, requestDirectory);
    brokerGateFile = launch.gateFile;
    windowsAclOwnerMarker = await admitWindowsSandboxAclOwner();
    brokerChild = spawn(launch.command, [...launch.args], {
      cwd: process.platform === 'win32'
        ? requirePreparedWindowsRunner().directory
        : undefined,
      env: launch.env,
      shell: false,
      stdio: process.platform === 'win32' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    rememberChildProcessTree(brokerChild);
    const brokerResult = collectProcess(
      brokerChild,
      signal,
      timeoutMs,
      maxOutputBytes,
      windowsAclOwnerMarker,
      windowsOwnerFence !== undefined,
    );
    void brokerResult.catch(() => undefined);
    if (windowsOwnerFence !== undefined) {
      brokerEffectJob = await containStandaloneBrokerFence(windowsOwnerFence, brokerChild);
      bindWindowsSandboxAclOwnerToJob(windowsAclOwnerMarker, brokerEffectJob);
      recoverableWindowsEffectFences.set(brokerEffectJob.jobName, windowsOwnerFence);
      await windowsOwnerFence.bindEffectProcess(brokerEffectJob.supervisorPid, true);
      brokerStartAttempted = true;
      await writeSandboxGate(brokerChild, true);
    }
    const result = await brokerResult;
    if (windowsOwnerFence !== undefined) {
      const fence = windowsOwnerFence;
      windowsOwnerFence = undefined;
      standaloneOwnershipManaged = true;
      await settleStandaloneBrokerOwnershipInForeground({
        child: brokerChild,
        effectJob: brokerEffectJob,
        fence,
        marker: windowsAclOwnerMarker,
        targetStartAttempted: brokerStartAttempted,
        terminateFirst: false,
      });
    }
    return result;
  } catch (error: unknown) {
    executionFailure = error;
    if (windowsOwnerFence !== undefined && brokerChild !== undefined) {
      const fence = windowsOwnerFence;
      windowsOwnerFence = undefined;
      standaloneOwnershipManaged = true;
      trackDeferredStandaloneBrokerSettlement({
        child: brokerChild,
        effectJob: brokerEffectJob,
        fence,
        marker: windowsAclOwnerMarker,
        targetStartAttempted: brokerStartAttempted,
        terminateFirst: true,
      });
    }
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try {
      await rm(requestFile, { force: true });
    } catch (error: unknown) {
      cleanupFailures.push(error);
    }
    if (brokerGateFile !== undefined) {
      try {
        await rm(brokerGateFile, { force: true });
      } catch (error: unknown) {
        cleanupFailures.push(error);
      }
    }
    if (!standaloneOwnershipManaged) {
      try {
        await confirmWindowsSandboxAclRecovery(windowsAclOwnerMarker);
      } catch (error: unknown) {
        cleanupFailures.push(error);
      }
    }
    if (windowsOwnerFence !== undefined) {
      try {
        await windowsOwnerFence();
      } catch (error: unknown) {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length > 0) {
      if (executionFailure !== undefined) cleanupFailures.unshift(executionFailure);
      if (cleanupFailures.length === 1) throw cleanupFailures[0];
      throw new AggregateError(cleanupFailures, 'Sandbox broker cleanup was not confirmed.');
    }
  }
}

async function runBroker(request: SandboxBrokerRequest, signal?: AbortSignal): Promise<string> {
  const result = await runBrokerResult(request, signal);
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
      allowRead: [...new Set([...config.filesystem.allowRead, runner.directory])],
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
  const homeDenies = process.platform === 'win32'
    ? windowsPersistentAclGuardRoots()
    : [home];
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

function workspaceShellSensitiveReadDenies(
  home: string,
  agentHome: string,
  controlDirectory: string,
): string[] {
  const homeDenies = WORKSPACE_SHELL_SENSITIVE_HOME_PATHS
    .map((relative) => path.resolve(home, relative))
    .filter((candidate) => path.relative(candidate, agentHome) !== '');
  const agentHomeDenies = process.platform === 'win32'
    ? [path.resolve(agentHome), windowsSandboxAclCoordinationDirectory()]
    : [
        path.resolve(controlDirectory),
        ...WORKSPACE_SHELL_SENSITIVE_AGENT_HOME_PATHS.map(
          (relative) => path.resolve(agentHome, relative),
        ),
      ];
  return [...new Set([...agentHomeDenies, ...homeDenies])];
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

function windowsAclGuardKey(candidate: string): string {
  return path.resolve(candidate).toLowerCase();
}

function windowsAclGuardCovers(candidate: string, mode: 'read' | 'write'): boolean {
  const key = windowsAclGuardKey(candidate);
  const roots = mode === 'read'
    ? windowsAclReadGuardedPaths
    : new Set([...windowsAclReadGuardedPaths, ...windowsAclWriteGuardedPaths]);
  for (const root of roots) {
    if (key === root || key.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)) {
      return true;
    }
  }
  return false;
}

function windowsPersistentAclGuardRoots(): string[] {
  const home = path.resolve(process.env.USERPROFILE ?? os.homedir());
  const agentHome = path.resolve(getAgentConfigHome());
  return existingMinimalWindowsAclGuardRoots(workspaceShellSensitiveReadDenies(
    home,
    agentHome,
    path.join(agentHome, 'sandbox-runtime'),
  ));
}

function runWindowsAclGuard(
  candidates: readonly string[],
  sandboxUserSid: string,
  sandboxGroupSid: string | undefined,
  install: boolean,
  mode: 'read' | 'write',
): string[] {
  const roots = existingMinimalWindowsAclGuardRoots(candidates);
  if (roots.length === 0) return [];
  const payload = JSON.stringify({
    sid: sandboxUserSid,
    tokenSids: [
      sandboxUserSid,
      sandboxGroupSid,
      'S-1-1-0',
      'S-1-5-11',
      'S-1-5-32-545',
    ].filter((candidate): candidate is string => candidate !== undefined),
    install,
    paths: roots.map((candidate) => ({
      path: candidate,
      directory: statSync(candidate).isDirectory(),
      mode,
    })),
  });
  const powershell = windowsAclPowerShellExecutable();
  const result = spawnSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(WINDOWS_ACL_GUARD_SCRIPT, 'utf16le').toString('base64'),
    ],
    {
      input: payload,
      encoding: 'utf8',
      timeout: install && mode === 'read' ? 15 * 60_000 : install ? 15_000 : 5_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    const detail = (result.error?.message || result.stderr || result.stdout || 'no diagnostics')
      .trim()
      .slice(-4_096);
    throw new Error(`Windows sandbox ACL guard failed: ${detail}`);
  }
  let missing: string[];
  try {
    const output = JSON.parse(result.stdout.trim()) as { readonly missing?: unknown };
    missing = Array.isArray(output.missing)
      ? output.missing.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch (error: unknown) {
    throw new Error(`Windows sandbox ACL guard returned invalid output: ${errorText(error)}`);
  }
  if (missing.length === 0) {
    const guardedPaths = mode === 'read'
      ? windowsAclReadGuardedPaths
      : windowsAclWriteGuardedPaths;
    for (const root of roots) guardedPaths.add(windowsAclGuardKey(root));
  }
  return missing;
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

function installWindowsAclGuards(
  candidates: readonly string[],
  mode: 'read' | 'write',
): void {
  if (process.platform !== 'win32' || candidates.length === 0) return;
  const pending = candidates.filter((candidate) => !windowsAclGuardCovers(candidate, mode));
  if (pending.length === 0) return;
  const runner = requirePreparedWindowsRunner();
  const user = getWindowsSandboxUserStatus({ srtWin: runner.srtWin });
  if (!user.sid) throw new Error('Windows sandbox account SID is unavailable for ACL guards.');
  const missing = runWindowsAclGuard(pending, user.sid, user.groupSid, true, mode);
  if (missing.length > 0) {
    throw new Error('Windows sandbox ACL guards were not installed completely.');
  }
}

function withoutWindowsAsrtDenyPropagation(
  config: SandboxRuntimeConfig,
): SandboxRuntimeConfig {
  if (process.platform !== 'win32') return config;
  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      // Persistent guards cover broad roots once during explicit setup. Keep
      // uncovered SDK-specific denies on ASRT's ordinary per-run path.
      denyRead: config.filesystem.denyRead.filter(
        (candidate) => !windowsAclGuardCovers(candidate, 'read'),
      ),
      denyWrite: config.filesystem.denyWrite?.filter(
        (candidate) => !windowsAclGuardCovers(candidate, 'write'),
      ),
    },
  };
}

function workspaceShellWriteRoots(
  candidateRoots: readonly string[],
  agentHome: string,
): string[] {
  let canonicalAgentHome: string;
  try {
    canonicalAgentHome = realpathSync.native(agentHome);
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const candidateRoot of candidateRoots) {
    let canonicalCandidate: string;
    try {
      canonicalCandidate = realpathSync.native(candidateRoot);
    } catch {
      continue;
    }
    if (!isInside(canonicalCandidate, canonicalAgentHome)) {
      roots.push(candidateRoot);
    } else if (canonicalCandidate !== canonicalAgentHome) {
      const protectedSegments = path.relative(canonicalCandidate, canonicalAgentHome).split(path.sep);
      let current = canonicalCandidate;
      try {
        for (const protectedSegment of protectedSegments) {
          for (const entry of readdirSync(current, { withFileTypes: true })) {
            if (entry.name !== protectedSegment) roots.push(path.join(current, entry.name));
          }
          current = path.join(current, protectedSegment);
        }
      } catch {
        // Existing sibling grants are optional; omitting them is fail-closed.
      }
    }
  }
  if (process.platform !== 'win32') roots.push(agentHome);
  return [...new Set(roots)];
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
  return process.platform === 'win32'
    ? shellTempDirectory === undefined ? [] : [path.dirname(shellTempDirectory)]
    : canonicalTempDirectories();
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
  const agentHome = path.resolve(getAgentConfigHome());
  const sensitiveRoots = workspaceShellSensitiveReadDenies(
    home, agentHome, path.join(agentHome, 'sandbox-runtime'),
  );
  const boundaries = workspaceShellUserDataBoundaries(home);
  const scopes = new Map<string, string>();
  const safe = (candidate: string): string | undefined => {
    const resolved = path.resolve(candidate);
    if (
      resolved === path.parse(resolved).root
      || resolved.toLowerCase() === home.toLowerCase()
      || isInside(agentHome, resolved)
      || isInside(resolved, agentHome)
      || sensitiveRoots.some((sensitive) => isInside(sensitive, resolved))
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
): SandboxRuntimeConfig {
  const agentHome = path.resolve(getAgentConfigHome());
  const controlDirectory = path.join(agentHome, 'sandbox-runtime');
  const home = path.resolve(
    process.platform === 'win32' ? process.env.USERPROFILE ?? os.homedir() : os.homedir(),
  );
  const sensitiveReadDenies = workspaceShellSensitiveReadDenies(
    home,
    agentHome,
    controlDirectory,
  );
  const denyRead = process.platform === 'win32'
    ? existingMinimalWindowsAclGuardRoots(sensitiveReadDenies)
    : sensitiveReadDenies.filter((candidate) => candidate !== agentHome);
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
  return withPreparedWindowsRunner({
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
      allowRead: [
        ...new Set([
          ...runtimeReadScopes,
          ...scopedAgentHomeAccess.read,
          ...(filesystemAccess?.read ?? []),
          ...(linkedGit.mainGitDirectory !== undefined
            ? [linkedGit.mainGitDirectory]
            : []),
        ]),
      ],
      allowWrite: writeRoots,
      denyWrite: [
        controlDirectory,
        ...WORKSPACE_SHELL_INTERNAL_AGENT_HOME_DIRECTORIES.map(
          (directory) => path.join(agentHome, directory),
        ),
        ...existingWorkspaceDenyWrites(workspaceRoot),
        ...(linkedGit.gitfile !== undefined ? [linkedGit.gitfile] : []),
      ],
    },
  });
}

function workspaceShellSessionSandboxConfig(
  workspaceRoot: string,
  shellTempDirectory: string | undefined,
  agentHomeAccess?: AsrtShellAgentHomeAccess,
  filesystemAccess?: AsrtShellSandboxSelection['filesystemAccess'],
  runtimeReadScopes?: readonly string[],
): SandboxRuntimeConfig {
  const config = workspaceShellSandboxConfig(
    workspaceRoot,
    shellTempDirectory,
    agentHomeAccess,
    filesystemAccess,
    runtimeReadScopes,
  );
  if (process.platform !== 'win32') return config;
  return boundedWindowsWorkspaceDenies(config);
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
      // SID. No glob expansion or child enumeration occurs, and exact grants
      // can still carve back reviewed paths below an inherited deny.
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
): SandboxRuntimeConfig {
  const config = workspaceShellSandboxConfig(
    workspaceRoot,
    shellTempDirectory,
    agentHomeAccess,
    filesystemAccess,
    runtimeReadScopes,
  );
  return process.platform === 'win32'
    ? boundedWindowsWorkspaceDenies(config)
    : config;
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
  const network = input.network ?? { mode: 'deny' };
  const endpoints = sdkSandboxEndpoints(network);
  const doctor = await doctorSandboxRuntime();
  if (!doctor.ready) {
    if (!doctorHasWindowsSandboxAclCleanupBlock(doctor)) {
      return { status: 'unavailable', sandboxed: false, doctor };
    }
    await ensureWindowsSandboxAclRecovery();
    if (doctor.setupRequired) return { status: 'unavailable', sandboxed: false, doctor };
  }
  const env = mergeSandboxEnvironment(
    input.inheritEnvironment === true ? process.env : sanitizedEnvironment(),
    input.env ?? {},
  );
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
        allowRead: normalizedSandboxPaths(input.filesystem.allowRead, cwd),
        allowWrite: normalizedSandboxPaths(input.filesystem.allowWrite, cwd),
        denyRead: normalizedSandboxPaths(input.filesystem.denyRead, cwd),
        denyWrite: normalizedSandboxPaths(input.filesystem.denyWrite, cwd),
      },
    }),
    command: input.command,
    args: input.args ?? [],
    cwd,
    env,
    endpoints,
    allowAllNetwork: network.mode === 'allow',
  };
  const result = await runBrokerResult(
    request,
    input.signal,
    input.timeoutMs ?? SCRIPT_TIMEOUT_MS,
    input.maxOutputBytes ?? MAX_OUTPUT_BYTES,
  );
  return {
    status: 'completed',
    sandboxed: true,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

interface WorkspaceSessionResponse {
  readonly id?: string;
  readonly type: 'ready' | 'result';
  readonly ok: boolean;
  readonly invocation?: NonNullable<SandboxBrokerRequest['wrappedInvocation']>;
  readonly error?: string;
}

interface WorkspaceSessionLease {
  readonly invocation: NonNullable<SandboxBrokerRequest['wrappedInvocation']>;
  release(): Promise<void>;
}

/** Why a workspace session admission was denied (structured reasons, Issue 304). */
type WorkspaceSessionDenialReason =
  | 'doctor_not_ready'
  | 'doctor_setup_required'
  | 'session_reset_pending'
  | 'acl_transition_pending';

type WorkspaceSessionAdmission =
  | { readonly session: WorkspaceSessionClient }
  | { readonly denied: WorkspaceSessionDenialReason };

interface WorkspaceSessionClient {
  readonly policyKey: string;
  readonly tempDirectory?: string;
  acquire(
    request: SandboxBrokerRequest,
    signal?: AbortSignal,
    deadlineAt?: number,
  ): Promise<WorkspaceSessionLease>;
  /**
   * `lifecycle` closes defer while the session still holds active leases; the
   * last lease release re-fires them, so a live background command is never
   * terminated by a convenience close. `forced` closes keep the historical
   * shutdown semantics (bounded lease drain, then terminate).
   */
  close(mode?: 'lifecycle' | 'forced'): Promise<void>;
  /** True while at least one active lease keeps this session servable. */
  leased(): boolean;
}

const WORKSPACE_SESSION_IDLE_MS = 5 * 60_000;
const WORKSPACE_SESSION_START_TIMEOUT_MS = 30_000;
const WORKSPACE_SESSION_RPC_TIMEOUT_MS = 30_000;
const WORKSPACE_SESSION_TERMINATE_GRACE_MS = 1_500;
const WORKSPACE_SESSION_WINDOWS_RESET_GRACE_MS = 130_000;
// A cleanup resets shared Windows ACL/WFP state and may legitimately wait
// behind in-flight wraps on the session's serial queue, so it shares the
// Windows reset grace budget instead of the generic RPC deadline. The budget
// applies on every platform (the serial-queue wait exists everywhere); POSIX
// simply rarely needs the full window.
const WORKSPACE_SESSION_CLEANUP_TIMEOUT_MS = WORKSPACE_SESSION_WINDOWS_RESET_GRACE_MS;
const STANDALONE_BROKER_SHUTDOWN_SETTLEMENT_TIMEOUT_MS = 5_000;
let workspaceSessionRpcTimeoutMs = WORKSPACE_SESSION_RPC_TIMEOUT_MS;
let workspaceSessionCleanupTimeoutMs = WORKSPACE_SESSION_CLEANUP_TIMEOUT_MS;
let standaloneBrokerShutdownSettlementTimeoutMs = STANDALONE_BROKER_SHUTDOWN_SETTLEMENT_TIMEOUT_MS;
const MAX_CACHED_SCOPED_WORKSPACE_SESSIONS = 8;
const workspaceSessions = new Map<string, Promise<WorkspaceSessionClient>>();
const pendingWorkspaceSessionWarmups = new Set<Promise<WorkspaceSessionClient | undefined>>();
const pendingWorkspaceSessionResets = new Set<Promise<void>>();
/**
 * Every in-flight session close, registered at close() entry so shutdown and
 * drain paths can wait for closes that have not yet committed (their tracked
 * reset registers only when the fence admission is held). Admission gates do
 * NOT consult this set — only drains do.
 */
const inFlightWorkspaceSessionCloses = new Set<Promise<void>>();
const pendingWindowsSandboxAclTransitions = new Set<Promise<void>>();
const pendingStandaloneBrokerSettlements = new Set<Promise<void>>();
let windowsSandboxAclFailure: Error | undefined;
let sandboxProcessSafetyFailure: Error | undefined;
let workspaceBeforeExitRegistered = false;
let windowsSandboxAclRecoveryRetry: NodeJS.Timeout | undefined;
let windowsSandboxAclRecoveryRetryDelayMs = 250;

function clearWindowsSandboxAclRecoveryRetry(): void {
  windowsSandboxAclFailure = undefined;
  if (windowsSandboxAclRecoveryRetry !== undefined) {
    clearTimeout(windowsSandboxAclRecoveryRetry);
    windowsSandboxAclRecoveryRetry = undefined;
  }
  windowsSandboxAclRecoveryRetryDelayMs = 250;
}

function scheduleWindowsSandboxAclRecoveryRetry(): void {
  if (process.platform !== 'win32' || windowsSandboxAclRecoveryRetry !== undefined) return;
  const delayMs = windowsSandboxAclRecoveryRetryDelayMs;
  windowsSandboxAclRecoveryRetryDelayMs = Math.min(delayMs * 2, 300_000);
  windowsSandboxAclRecoveryRetry = setTimeout(() => {
    windowsSandboxAclRecoveryRetry = undefined;
    void ensureWindowsSandboxAclRecovery().catch(() => {
      scheduleWindowsSandboxAclRecoveryRetry();
    });
  }, delayMs);
  windowsSandboxAclRecoveryRetry.unref();
}

function recordWindowsSandboxAclFailure(error: unknown): void {
  const normalized = error instanceof Error
    ? error
    : new Error(String(error));
  if (process.platform !== 'win32') {
    sandboxProcessSafetyFailure ??= normalized;
    return;
  }
  windowsSandboxAclFailure ??= normalized;
  scheduleWindowsSandboxAclRecoveryRetry();
}

function assertWindowsSandboxAclProcessSafe(): void {
  if (process.platform !== 'win32' && sandboxProcessSafetyFailure !== undefined) {
    throw new Error(
      'Sandbox process cleanup was not confirmed; stop the retained process tree before more sandboxed commands.',
      { cause: sandboxProcessSafetyFailure },
    );
  }
  if (process.platform !== 'win32') return;
  if (windowsSandboxAclFailure !== undefined) {
    if (windowsSandboxAclFailure instanceof WindowsSandboxAclAdmissionError) {
      throw windowsSandboxAclFailure;
    }
    throw new Error(
      'Windows sandbox ACL cleanup is pending automatic recovery; non-sandbox work remains available.',
      { cause: windowsSandboxAclFailure },
    );
  }
}

function assertWindowsSandboxAclSafe(policyKey?: string): void {
  assertWindowsSandboxAclProcessSafe();
  if (process.platform !== 'win32') return;
  assertNoPersistentWindowsSandboxAclPoison(policyKey);
}

function trackWorkspaceSessionReset(reset: Promise<void>, policyKey?: string): void {
  pendingWorkspaceSessionResets.add(reset);
  trackedPolicyKeys.set(reset, policyKey);
  void reset.then(
    () => {
      pendingWorkspaceSessionResets.delete(reset);
      trackedPolicyKeys.delete(reset);
    },
    () => {
      pendingWorkspaceSessionResets.delete(reset);
      trackedPolicyKeys.delete(reset);
    },
  );
}

/**
 * Policy keys for in-flight session resets. Entries with an undefined key (or
 * the empty-string sentinel) are account-wide and block every policy.
 */
const trackedPolicyKeys = new WeakMap<Promise<void>, string | undefined>();

function trackWindowsSandboxAclTransition(transition: Promise<void>): void {
  pendingWindowsSandboxAclTransitions.add(transition);
  void transition.then(
    () => pendingWindowsSandboxAclTransitions.delete(transition),
    (error: unknown) => {
      pendingWindowsSandboxAclTransitions.delete(transition);
      emitKodaXDiagnostic({
        source: 'sandbox:workspace-session',
        level: 'error',
        message: 'Workspace sandbox durable ACL poison transition failed.',
        detail: error,
      });
    },
  );
}

async function waitForWindowsSandboxAclTransitions(): Promise<void> {
  while (pendingWindowsSandboxAclTransitions.size > 0) {
    await Promise.allSettled([...pendingWindowsSandboxAclTransitions]);
  }
}

async function waitForStandaloneBrokerSettlements(): Promise<void> {
  while (pendingStandaloneBrokerSettlements.size > 0) {
    await Promise.allSettled([...pendingStandaloneBrokerSettlements]);
  }
}

/** Test-only drain for deferred standalone broker ownership settlement. */
export async function waitForStandaloneBrokerSettlementsForTest(): Promise<void> {
  await waitForStandaloneBrokerSettlements();
}

function standaloneBrokerShutdownTimeoutError(timeoutMs: number): Error {
  return new Error(
    `Standalone sandbox broker settlement did not finish within ${timeoutMs} ms; `
      + 'automatic recovery remains in progress and process ownership stays durably fenced.',
  );
}

async function waitForStandaloneBrokerSettlementsBeforeShutdown(): Promise<void> {
  if (pendingStandaloneBrokerSettlements.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      waitForStandaloneBrokerSettlements(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(standaloneBrokerShutdownTimeoutError(
            standaloneBrokerShutdownSettlementTimeoutMs,
          )),
          standaloneBrokerShutdownSettlementTimeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForWorkspaceSessionResets(): Promise<void> {
  for (;;) {
    const before = pendingWorkspaceSessionResets.size + inFlightWorkspaceSessionCloses.size;
    if (before === 0) break;
    await Promise.allSettled([
      ...pendingWorkspaceSessionResets,
      ...inFlightWorkspaceSessionCloses,
    ]);
    if (
      pendingWorkspaceSessionResets.size + inFlightWorkspaceSessionCloses.size === 0
    ) break;
  }
  await waitForWindowsSandboxAclTransitions();
  if (process.platform !== 'win32') assertWindowsSandboxAclProcessSafe();
}

/** Test-only drain for deferred workspace-session cleanup. */
export async function waitForWorkspaceSessionResetsForTest(): Promise<void> {
  await waitForWorkspaceSessionResets();
}

async function closeCachedWorkspaceSessions(): Promise<unknown[]> {
  const sessions = [...workspaceSessions.values()];
  workspaceSessions.clear();
  const failures: unknown[] = [];
  for (const pendingSession of sessions) {
    try {
      await (await pendingSession).close('forced');
    } catch (error: unknown) {
      failures.push(error);
      emitKodaXDiagnostic({
        source: 'sandbox:workspace-session',
        level: 'warn',
        message: 'Workspace sandbox shutdown could not confirm ACL reset.',
        detail: error,
      });
    }
  }
  return failures;
}

/**
 * Closes only cached sessions that hold no active lease; leased sessions stay
 * cached and servable. Used before standalone admission: a live background
 * command's session must not be terminated, so the standalone run is failed
 * instead once the short drain grace below expires.
 */
async function closeIdleCachedWorkspaceSessionsForStandalone(): Promise<number> {
  const failures: unknown[] = [];
  let leased = 0;
  for (const [key, pendingSession] of [...workspaceSessions.entries()]) {
    let session: WorkspaceSessionClient;
    try {
      session = await pendingSession;
    } catch {
      workspaceSessions.delete(key);
      continue;
    }
    if (session.leased()) {
      leased += 1;
      continue;
    }
    workspaceSessions.delete(key);
    try {
      await session.close();
    } catch (error: unknown) {
      failures.push(error);
      emitKodaXDiagnostic({
        source: 'sandbox:workspace-session',
        level: 'warn',
        message: 'Workspace sandbox standalone admission could not confirm a cached reset.',
        detail: error,
      });
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'Cached workspace sandbox reset was not confirmed before standalone execution.',
    );
  }
  return leased;
}

const closeWorkspaceSessionsBeforeExit = (): void => {
  workspaceBeforeExitRegistered = false;
  void closeCachedWorkspaceSessions();
};

function registerWorkspaceSessionBeforeExit(): void {
  if (workspaceBeforeExitRegistered) return;
  workspaceBeforeExitRegistered = true;
  process.once('beforeExit', closeWorkspaceSessionsBeforeExit);
}

export async function shutdownAsrtWorkspaceSessions(): Promise<void> {
  process.removeListener('beforeExit', closeWorkspaceSessionsBeforeExit);
  workspaceBeforeExitRegistered = false;
  while (pendingWorkspaceSessionWarmups.size > 0) {
    await Promise.allSettled([...pendingWorkspaceSessionWarmups]);
  }
  const failures = await closeCachedWorkspaceSessions();
  try {
    while (pendingWorkspaceSessionResets.size > 0) {
      await Promise.allSettled([...pendingWorkspaceSessionResets]);
    }
    await waitForStandaloneBrokerSettlementsBeforeShutdown();
    await waitForWindowsSandboxAclTransitions();
    assertWindowsSandboxAclProcessSafe();
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Workspace sandbox shutdown was not confirmed.');
  }
}

function workspacePreparationTimeoutError(): Error {
  const error = new Error('ASRT workspace session preparation timed out.');
  error.name = 'TimeoutError';
  return error;
}

function throwIfWorkspacePreparationStopped(
  signal?: AbortSignal,
  deadlineAt?: number,
): void {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw workspacePreparationTimeoutError();
  }
}

function waitForWorkspacePreparation<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<T> {
  throwIfWorkspacePreparationStopped(signal, deadlineAt);
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
        finish(() => reject(workspacePreparationTimeoutError()));
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
  const directory = path.join(getAgentConfigHome(), 'sandbox-runtime');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function workspaceSessionEntryArgs(initFile: string): string[] {
  if (process.env.KODAX_BUNDLED === 'true') {
    return ['__asrt-workspace-session', initFile];
  }
  if (import.meta.url.endsWith('.ts')) {
    return [
      '--import',
      pathToFileURL(moduleRequire.resolve('tsx')).href,
      fileURLToPath(new URL('./sandbox-workspace-session-entry.ts', import.meta.url)),
      initFile,
    ];
  }
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const distributionDirectory = path.basename(currentDirectory) === 'chunks'
    ? path.dirname(currentDirectory)
    : currentDirectory;
  const entry = path.join(distributionDirectory, 'sandbox-workspace-session.js');
  return [entry, initFile];
}

function setWorkspaceSessionReferenced(
  child: ReturnType<typeof spawn>,
  referenced: boolean,
): void {
  const method = referenced ? 'ref' : 'unref';
  child[method]();
  for (const stream of child.stdio) {
    if (!stream) continue;
    const controllable = stream as typeof stream & {
      ref?: () => void;
      unref?: () => void;
    };
    controllable[method]?.();
  }
}

async function withExclusiveFileSystemEffectFence<T>(
  alreadyHeld: boolean,
  action: () => Promise<T>,
  sandboxPolicyKey?: string,
): Promise<T> {
  if (alreadyHeld) return action();
  // POSIX policies are process-local, so a session transition is an ordinary
  // shell effect: it may overlap every shell policy but still waits for host
  // direct sinks and real namespace mutations. Windows needs exclusive,
  // exact-policy coordination for its shared sandbox-account ACLs.
  const release = process.platform === 'win32'
    ? await acquireExclusiveFileSystemEffectLease(sandboxPolicyKey)
    : await acquireFileSystemMutationLease(sandboxPolicyKey);
  try {
    return await action();
  } finally {
    await release();
  }
}

async function withExclusiveFileSystemCleanupFence<T>(
  action: () => Promise<T>,
  sandboxPolicyKey: string,
  child: ReturnType<typeof spawn>,
  effectJob: WindowsEffectJob | undefined,
  onDeferredFailure: (error: unknown) => Promise<void>,
): Promise<T> {
  if (process.platform !== 'win32') {
    return withExclusiveFileSystemEffectFence(false, action, sandboxPolicyKey);
  }
  const cleanupOwnerPid = effectJob?.supervisorPid ?? child.pid;
  if (cleanupOwnerPid === undefined) {
    throw new Error('Workspace cleanup process identity is unavailable.');
  }
  return withExclusiveFileSystemCleanupLease(sandboxPolicyKey, {
    pid: cleanupOwnerPid,
    windowsJobContained: effectJob !== undefined || isCurrentProcessWindowsJobContained(),
  }, action, onDeferredFailure, (lease) => {
    if (effectJob !== undefined) recoverableWindowsEffectFences.set(effectJob.jobName, lease);
  }, () => {
    if (effectJob !== undefined) recoverableWindowsEffectFences.delete(effectJob.jobName);
  });
}

async function startWorkspaceSessionClientWithFence(
  workspaceRoot: string,
  agentHomeAccess: AsrtShellAgentHomeAccess | undefined,
  filesystemAccess: AsrtShellSandboxSelection['filesystemAccess'],
  runtimeReadScopes: readonly string[],
  policyKey: string,
  onExit: () => void,
): Promise<WorkspaceSessionClient> {
  const tempDirectory = process.platform === 'win32'
    ? createWorkspaceShellTempDirectory(workspaceRoot, policyKey)
    : undefined;
  if (tempDirectory !== undefined) {
    await mkdir(tempDirectory, {
      recursive: true,
      mode: 0o700,
    });
  }
  const controlDirectory = await sandboxControlDirectory();
  if (process.platform === 'win32') {
    installWindowsAclGuards(existingWorkspaceDenyWrites(workspaceRoot), 'write');
  }
  const initFile = path.join(
    controlDirectory,
    `workspace-${process.pid}-${randomUUID()}.json`,
  );
  const sessionConfig = withoutWindowsAsrtDenyPropagation(
    workspaceShellSessionSandboxConfig(
      workspaceRoot,
      tempDirectory,
      agentHomeAccess,
      filesystemAccess,
      runtimeReadScopes,
    ),
  );
  await writeFile(initFile, JSON.stringify({
    config: sessionConfig,
  }), { mode: 0o600 });
  const launch = prepareInternalNodeLaunch({
    args: workspaceSessionEntryArgs(initFile),
    env: sanitizedEnvironment(),
    isElectron: process.versions.electron !== undefined,
  });
  const workspaceLaunch = process.platform === 'win32'
    ? await prepareStandaloneBrokerLaunch(launch.args, controlDirectory, true)
    : { command: process.execPath, ...launch };
  const workspaceGateFile = workspaceLaunch.gateFile;
  let windowsAclOwnerMarker: string | undefined;
  try {
    windowsAclOwnerMarker = await admitWindowsSandboxAclOwner(policyKey);
  } catch (error: unknown) {
    const cleanup = await Promise.allSettled([
      rm(initFile, { force: true }),
      ...(workspaceGateFile === undefined ? [] : [rm(workspaceGateFile, { force: true })]),
      ...(tempDirectory === undefined
        ? []
        : [removeWorkspaceShellTempDirectory(tempDirectory)]),
    ]);
    const failures: unknown[] = [
      error,
      ...cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
    ];
    if (failures.length === 1) throw error;
    throw new AggregateError(
      failures,
      'Workspace sandbox owner admission and pre-launch cleanup both failed.',
    );
  }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(workspaceLaunch.command, [...workspaceLaunch.args], {
      cwd: process.platform === 'win32'
        ? requirePreparedWindowsRunner().directory
        : undefined,
      env: workspaceLaunch.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error: unknown) {
    const failures: unknown[] = [error];
    try {
      await confirmWindowsSandboxAclRecovery(windowsAclOwnerMarker);
    } catch (cleanupError: unknown) {
      await retainWindowsSandboxAclOwnerPoison(windowsAclOwnerMarker, cleanupError);
      failures.push(cleanupError);
    }
    const artifactCleanup = await Promise.allSettled([
      rm(initFile, { force: true }),
      ...(workspaceGateFile === undefined ? [] : [rm(workspaceGateFile, { force: true })]),
      ...(tempDirectory === undefined
        ? []
        : [removeWorkspaceShellTempDirectory(tempDirectory)]),
    ]);
    failures.push(...artifactCleanup.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    )));
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, 'Workspace sandbox owner launch cleanup failed.');
  }
  rememberChildProcessTree(child);
  const childExit = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };
    child.once('exit', finish);
    child.once('close', finish);
  });
  const childError = new Promise<Error>((resolve) => child.once('error', resolve));
  let workspaceEffectJob: WindowsEffectJob | undefined;
  let workspaceStartAttempted = false;
  if (process.platform === 'win32') {
    try {
      if (child.pid === undefined) throw new Error('Workspace sandbox gate did not expose a PID.');
      workspaceEffectJob = await containWindowsEffectProcess(child.pid);
      bindWindowsSandboxAclOwnerToJob(windowsAclOwnerMarker, workspaceEffectJob);
      workspaceStartAttempted = true;
      await writeSandboxGate(child, false);
    } catch (error: unknown) {
      const failures: unknown[] = [error];
      try {
        if (!workspaceStartAttempted) await closeSandboxGate(child).catch(() => undefined);
        if (workspaceEffectJob !== undefined) {
          await terminateWindowsEffectJob(workspaceEffectJob.jobName);
          await workspaceEffectJob.drained;
        } else {
          const termination = await killChildProcessTree(child);
          if (workspaceStartAttempted && termination.status === 'unknown') {
            throw new Error('Workspace sandbox gate termination was not confirmed.');
          }
        }
        if (workspaceStartAttempted) await confirmWindowsSandboxAclRecovery(windowsAclOwnerMarker);
        else confirmWindowsSandboxAclOwnerStopped(windowsAclOwnerMarker);
      } catch (cleanupError: unknown) {
        await retainWindowsSandboxAclOwnerPoison(windowsAclOwnerMarker, cleanupError);
        failures.push(cleanupError);
      }
      const artifactCleanup = await Promise.allSettled([
        rm(initFile, { force: true }),
        ...(workspaceGateFile === undefined ? [] : [rm(workspaceGateFile, { force: true })]),
        ...(tempDirectory === undefined
          ? []
          : [removeWorkspaceShellTempDirectory(tempDirectory)]),
      ]);
      failures.push(...artifactCleanup.flatMap((result) => (
        result.status === 'rejected' ? [result.reason] : []
      )));
      throw new AggregateError(failures, 'Workspace sandbox Job containment failed.');
    }
  }
  const childProcessStartIdentity = child.pid === undefined
    ? undefined
    : readProcessStartIdentity(child.pid);
  const control = child.stdio[3];
  if (!control) throw new Error('ASRT workspace session control pipe was not created.');
  const responses = readline.createInterface({
    input: control as NodeJS.ReadableStream,
  });
  const pending = new Map<string, {
    resolve: (response: WorkspaceSessionResponse) => void;
    reject: (error: Error) => void;
  }>();
  let stderrTail = '';
  let exited = false;
  let closing = false;
  let readyConfirmed = false;
  let evicted = false;
  let requestSequence = 0;
  let activeLeases = 0;
  let resolveDrained: (() => void) | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let closePromise: Promise<void> | undefined;
  let forcedRequested = false;
  const tempCleanup = childExit.then(async () => {
    if (tempDirectory === undefined) return;
    try {
      await removeWorkspaceShellTempDirectory(tempDirectory);
    } catch (error: unknown) {
      emitKodaXDiagnostic({
        source: 'sandbox:workspace-session',
        level: 'warn',
        message: 'Workspace sandbox temp cleanup failed.',
        detail: error,
      });
    }
  });
  const confirmCleanReset = async (): Promise<void> => {
    await childExit;
    if (workspaceEffectJob !== undefined) await workspaceEffectJob.drained;
    await tempCleanup;
    await confirmWindowsSandboxAclRecovery(windowsAclOwnerMarker);
  };
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const evict = (): void => {
    if (evicted) return;
    evicted = true;
    onExit();
  };
  let closeDeferralWatchdog: NodeJS.Timeout | undefined;
  let closeDeferralWatchdogFires = 0;
  const startCloseDeferralWatchdog = (): void => {
    if (closeDeferralWatchdog !== undefined || exited) return;
    closeDeferralWatchdog = setInterval(() => {
      closeDeferralWatchdogFires += 1;
      emitKodaXDiagnostic({
        source: 'sandbox:workspace-session',
        level: closeDeferralWatchdogFires === 1 ? 'warn' : 'error',
        message: 'A deferred workspace session close is still waiting on active leases; '
          + `policyKey=${policyKey} leases=${String(activeLeases)}. `
          + 'The session stays reusable; a leaked lease keeps it alive until process exit.',
      });
    }, WORKSPACE_SESSION_WINDOWS_RESET_GRACE_MS);
    closeDeferralWatchdog.unref?.();
  };
  const stopCloseDeferralWatchdog = (): void => {
    if (closeDeferralWatchdog !== undefined) clearInterval(closeDeferralWatchdog);
    closeDeferralWatchdog = undefined;
    closeDeferralWatchdogFires = 0;
  };
  const waitForOrderlyClose = async (): Promise<boolean> => {
    if (
      !closing
      || !readyConfirmed
      || activeLeases !== 0
      || child.exitCode !== null
      || child.signalCode !== null
      || !child.stdin.writable
    ) return false;
    try {
      child.stdin.end();
    } catch {
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exit = await Promise.race([
        childExit,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(
            resolve,
            process.platform === 'win32'
              ? WORKSPACE_SESSION_WINDOWS_RESET_GRACE_MS
              : WORKSPACE_SESSION_TERMINATE_GRACE_MS,
          );
        }),
      ]);
      return exit !== undefined && exit.code === 0 && exit.signal === null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  let terminatePromise: Promise<void> | undefined;
  let terminationRequested = false;
  const terminate = (): Promise<void> => {
    if (terminatePromise) return terminatePromise;
    terminationRequested = true;
    const current = (async () => {
      try {
        if (await waitForOrderlyClose()) return;
        const result = await killChildProcessTree(child, {
          gracefulStdinEnd: false,
          gracefulMs: WORKSPACE_SESSION_TERMINATE_GRACE_MS,
          forceMs: WORKSPACE_SESSION_TERMINATE_GRACE_MS,
          taskkillMs: WORKSPACE_SESSION_TERMINATE_GRACE_MS,
        });
        if (result.status === 'unknown') {
          if (workspaceEffectJob !== undefined) {
            await terminateWindowsEffectJob(workspaceEffectJob.jobName);
          } else {
            throw await recordUnconfirmedWindowsSandboxOwner(
              child.pid,
              childProcessStartIdentity,
              unconfirmedSandboxProcessTreeMessage('ASRT workspace session'),
              windowsAclOwnerMarker,
            );
          }
        }
      } finally {
        responses.close();
        control.destroy();
        child.stdin.destroy();
      }
    })().finally(evict);
    terminatePromise = current;
    void current.catch(() => {
      if (terminatePromise === current) terminatePromise = undefined;
    });
    return current;
  };
  const observeFailedTermination = (reason: string): void => {
    void terminate().catch((error: unknown) => {
      emitKodaXDiagnostic({
        source: 'runtime.sandbox.workspace-session',
        level: 'error',
        message: `ASRT workspace session termination failed after ${reason}.`,
        detail: error,
      });
    });
  };
  const fail = (error: Error): void => {
    if (exited) return;
    exited = true;
    rejectReady(error);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-16_384);
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-16_384);
  });
  responses.on('line', (line) => {
    let response: WorkspaceSessionResponse;
    try {
      response = JSON.parse(line) as WorkspaceSessionResponse;
    } catch {
      fail(new Error('ASRT workspace session returned malformed control data.'));
      observeFailedTermination('malformed control data');
      return;
    }
    if (response.type === 'ready') {
      if (response.ok) {
        readyConfirmed = true;
        resolveReady();
      }
      else rejectReady(new Error(response.error ?? 'ASRT workspace session failed.'));
      return;
    }
    if (response.type !== 'result' || !response.id) {
      fail(new Error('ASRT workspace session returned an invalid control response.'));
      observeFailedTermination('an invalid control response');
      return;
    }
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);
    item.resolve(response);
  });
  void childError.then((error) => {
    fail(error);
    observeFailedTermination('a child-process error');
  });
  responses.once('close', () => {
    if (closing || exited) return;
    fail(new Error('ASRT workspace session control pipe closed unexpectedly.'));
    observeFailedTermination('an unexpected control-pipe close');
  });
  void childExit.then(({ code, signal }) => {
    if (idleTimer) clearTimeout(idleTimer);
    stopCloseDeferralWatchdog();
    const exitError = new Error(
      `ASRT workspace session exited ${signal ?? code ?? 1}: ${stderrTail.trim() || 'no diagnostics'}`,
    );
    if (!terminationRequested && (code !== 0 || signal !== null || !closing)) {
      trackWindowsSandboxAclTransition(
        retainWindowsSandboxAclOwnerPoison(windowsAclOwnerMarker, exitError),
      );
    }
    fail(exitError);
    evict();
  });
  const startupTimer = setTimeout(() => {
    fail(new Error('ASRT workspace session initialization timed out.'));
    observeFailedTermination('an initialization timeout');
  }, WORKSPACE_SESSION_START_TIMEOUT_MS);
  try {
    await ready.finally(() => clearTimeout(startupTimer));
  } catch (error) {
    closing = true;
    const failures: unknown[] = [error];
    let terminationConfirmed = false;
    try {
      await terminate();
      terminationConfirmed = true;
    } catch (cleanupError: unknown) {
      failures.push(cleanupError);
    }
    if (terminationConfirmed) {
      try {
        await confirmCleanReset();
      } catch (cleanupError: unknown) {
        await retainWindowsSandboxAclOwnerPoison(windowsAclOwnerMarker, cleanupError);
        failures.push(cleanupError);
      }
    }
    await rm(initFile, { force: true });
    if (failures.length === 1) throw error;
    throw new AggregateError(
      failures,
      `Workspace sandbox startup cleanup failed: ${errorText(failures.at(-1))}`,
    );
  }

  const request = async (
    type: 'wrap' | 'cleanup',
    value?: SandboxBrokerRequest,
  ): Promise<WorkspaceSessionResponse> => {
    if (exited || (closing && type === 'wrap')) {
      throw new Error('ASRT workspace session is unavailable.');
    }
    const id = `workspace_${++requestSequence}`;
    const response = new Promise<WorkspaceSessionResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    const timeout = setTimeout(() => {
      const timeoutError = new Error(`ASRT workspace session ${type} request timed out.`);
      if (type === 'cleanup') {
        // A cleanup legitimately queues behind in-flight wraps on the
        // session's serial queue. Retire only this request: the caller
        // finalizes its lease and the close deferral keeps the session
        // servable, instead of failing every pending wrap and killing the
        // child — which is exactly the long-background-command failure mode.
        const item = pending.get(id);
        if (item) {
          pending.delete(id);
          item.reject(timeoutError);
        }
        return;
      }
      // Wrap timeouts mean the child is not answering handshakes: fail the
      // pending requests and retire the session through a forced close,
      // which drains leases first and gives the child the orderly-close
      // grace to reset cleanly instead of poisoning the owner marker.
      fail(timeoutError);
      void client.close('forced').catch((closeError: unknown) => {
        emitKodaXDiagnostic({
          source: 'sandbox:workspace-session',
          level: 'warn',
          message: 'Timed-out workspace sandbox request could not retire its session.',
          detail: closeError,
        });
      });
    }, type === 'cleanup' ? workspaceSessionCleanupTimeoutMs : workspaceSessionRpcTimeoutMs);
    timeout.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(
          `${JSON.stringify({ id, type, request: value })}\n`,
          (error) => error ? reject(error) : resolve(),
        );
      });
    } catch (error: unknown) {
      pending.delete(id);
      clearTimeout(timeout);
      fail(error instanceof Error ? error : new Error(String(error)));
      observeFailedTermination('a control request write failure');
      throw error;
    }
    return response.finally(() => clearTimeout(timeout));
  };
  const scheduleIdleClose = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (activeLeases > 0 || closing || exited) return;
    if (process.platform === 'win32') {
      setWorkspaceSessionReferenced(child, false);
      return;
    }
    idleTimer = setTimeout(() => {
      void client.close().catch((error: unknown) => {
        emitKodaXDiagnostic({
          source: 'sandbox:workspace-session',
          level: 'warn',
          message: 'Idle workspace sandbox session could not confirm ACL reset.',
          detail: error,
        });
      });
    }, WORKSPACE_SESSION_IDLE_MS);
    idleTimer.unref();
    setWorkspaceSessionReferenced(child, false);
  };
  const client: WorkspaceSessionClient = {
    policyKey,
    ...(tempDirectory === undefined ? {} : { tempDirectory }),
    leased: () => activeLeases > 0 && !exited,
    async acquire(value, signal, deadlineAt) {
      assertWindowsSandboxAclSafe(policyKey);
      throwIfWorkspacePreparationStopped(signal, deadlineAt);
      if (exited || closing) {
        throw new Error('ASRT workspace session is unavailable.');
      }
      if (idleTimer) clearTimeout(idleTimer);
      setWorkspaceSessionReferenced(child, true);
      activeLeases += 1;
      let finalized = false;
      let closeRequiredAfterFinalize = false;
      const finalize = (): boolean => {
        if (finalized) return false;
        finalized = true;
        activeLeases -= 1;
        const idle = activeLeases === 0;
        if (activeLeases === 0) {
          resolveDrained?.();
          resolveDrained = undefined;
        }
        scheduleIdleClose();
        return idle;
      };
      const finalizeAndCloseIfIdle = async (): Promise<void> => {
        if (!finalized) {
          closeRequiredAfterFinalize = finalize() && process.platform === 'win32';
        }
        if (closeRequiredAfterFinalize) {
          // Bounded wait: normally the idle close converges in milliseconds.
          // Under fence contention it may defer or skip for a new lease, and
          // a finishing command's cleanup must not block on that convergence;
          // the deferral re-arms from the last lease release.
          await Promise.race([
            client.close().then(
              () => undefined,
              (closeError: unknown) => {
                emitKodaXDiagnostic({
                  source: 'sandbox:workspace-session',
                  level: 'warn',
                  message: 'Idle workspace sandbox session could not confirm ACL reset.',
                  detail: closeError,
                });
              },
            ),
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, WORKSPACE_SESSION_TERMINATE_GRACE_MS);
              timer.unref?.();
            }),
          ]);
        }
      };
      const retireAfterCleanupFailure = (message: string, error: unknown): void => {
        emitKodaXDiagnostic({
          source: 'sandbox:workspace-session',
          level: 'warn',
          message,
          detail: error,
        });
        const idle = finalize();
        if (!idle) return;
        void client.close().catch((closeError: unknown) => {
          emitKodaXDiagnostic({
            source: 'sandbox:workspace-session',
            level: 'warn',
            message: 'Failed workspace sandbox cleanup could not retire its session.',
            detail: closeError,
          });
        });
      };
      const wrapPromise = request('wrap', value);
      let response: WorkspaceSessionResponse;
      try {
        response = await waitForWorkspacePreparation(
          wrapPromise,
          signal,
          deadlineAt,
        );
      } catch (error: unknown) {
        void wrapPromise.then(async (lateResponse) => {
          if (!lateResponse.ok || !lateResponse.invocation) return;
          const cleanup = await request('cleanup');
          if (!cleanup.ok) throw new Error(cleanup.error ?? 'ASRT command cleanup failed.');
        }).then(
          finalizeAndCloseIfIdle,
          (cleanupError: unknown) => retireAfterCleanupFailure(
            'Late workspace sandbox preparation cleanup failed.',
            cleanupError,
          ),
        );
        throw error;
      }
      try {
        if (!response.ok || !response.invocation) {
          finalize();
          const wrapError = new Error(response.error ?? 'ASRT workspace wrapping failed.');
          // Fire-and-forget: the session close defers behind surviving leases
          // (a live background command) and must not delay this error path.
          void client.close().catch((closeError: unknown) => {
            emitKodaXDiagnostic({
              source: 'sandbox:workspace-session',
              level: 'warn',
              message: 'Failed workspace sandbox wrap could not retire its session.',
              detail: closeError,
            });
          });
          throw wrapError;
        }
        try {
          throwIfWorkspacePreparationStopped(signal, deadlineAt);
        } catch (error: unknown) {
          try {
            const cleanup = await request('cleanup');
            if (!cleanup.ok) throw new Error(cleanup.error ?? 'ASRT command cleanup failed.');
          } catch (cleanupError: unknown) {
            retireAfterCleanupFailure(
              'Cancelled workspace sandbox preparation cleanup failed.',
              cleanupError,
            );
          }
          await finalizeAndCloseIfIdle();
          throw error;
        }
        let released = false;
        let cleanupCompleted = false;
        let releasePromise: Promise<void> | undefined;
        return {
          invocation: response.invocation,
          async release() {
            if (released) return;
            if (releasePromise !== undefined) return releasePromise;
            const current = (async (): Promise<void> => {
              if (!cleanupCompleted) {
                let cleanup: WorkspaceSessionResponse;
                try {
                  cleanup = await request('cleanup');
                } catch (cleanupError: unknown) {
                  try {
                    await finalizeAndCloseIfIdle();
                    released = true;
                  } catch (closeError: unknown) {
                    throw new AggregateError(
                      [cleanupError, closeError],
                      'Workspace sandbox command cleanup and policy-group reset both failed.',
                    );
                  }
                  throw cleanupError;
                }
                if (!cleanup.ok) {
                  // The lease intentionally stays unfinalized: the background
                  // cleanup retry re-sends the session cleanup RPC through
                  // release(), and its eventual success finalizes the lease.
                  throw new Error(cleanup.error ?? 'ASRT command cleanup failed.');
                }
                cleanupCompleted = true;
              }
              await finalizeAndCloseIfIdle();
              released = true;
            })();
            releasePromise = current;
            try {
              await current;
            } finally {
              if (releasePromise === current) releasePromise = undefined;
            }
          },
        };
      } catch (error) {
        finalize();
        throw error;
      }
    },
    async close(mode: 'lifecycle' | 'forced' = 'lifecycle') {
      if (closePromise) {
        // A forced caller (shutdown/reset) piggybacking an in-flight lifecycle
        // close must still get forced semantics: the close below may not skip
        // for a lease that arrived while it waited for admission.
        if (mode === 'forced') forcedRequested = true;
        return closePromise;
      }
      if (mode === 'lifecycle' && !exited && activeLeases > 0) {
        // A live background command still holds this session. Defer the close
        // without evicting it from the cache: the session stays servable, and
        // the last lease release (finalizeAndCloseIfIdle) re-fires the close,
        // so the deferral is always re-armed by the existing release path.
        startCloseDeferralWatchdog();
        return;
      }
      let settleInflightClose!: () => void;
      const inflightClose = new Promise<void>((resolve) => {
        settleInflightClose = resolve;
      });
      inFlightWorkspaceSessionCloses.add(inflightClose);
      if (mode === 'forced') {
        closing = true;
        evict();
      }
      let aclActionStarted = false;
      let aclRecoveryConfirmed = false;
      let closeSkippedForNewLease = false;
      let settleTrackedReset: (() => void) | undefined;
      const current = (async () => {
        if (idleTimer) clearTimeout(idleTimer);
        stopCloseDeferralWatchdog();
        if (mode === 'forced') {
          setWorkspaceSessionReferenced(child, true);
          if (activeLeases > 0) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, WORKSPACE_SESSION_TERMINATE_GRACE_MS);
              timer.unref?.();
              resolveDrained = () => {
                clearTimeout(timer);
                resolve();
              };
            });
          }
          setWorkspaceSessionReferenced(child, false);
        }
        await withExclusiveFileSystemCleanupFence(
          async () => {
            if (mode === 'lifecycle' && !forcedRequested && !exited && activeLeases > 0) {
              // A new lease arrived while this close waited for admission.
              // Committing now would terminate the session under that live
              // command; skip instead — the lease's release re-fires the
              // close — and leave the latch open for that retry. A forced
              // caller never skips: shutdown keeps its terminate semantics.
              closeSkippedForNewLease = true;
              startCloseDeferralWatchdog();
              return;
            }
            aclActionStarted = true;
            if (mode === 'lifecycle') {
              // Commit the close only now, with the cleanup fence admission
              // held: until this point the session stays cached and reusable
              // while its close waits behind a long-lived command's lease.
              closing = true;
              evict();
              const trackedReset = new Promise<void>((resolve) => {
                settleTrackedReset = resolve;
              });
              trackWorkspaceSessionReset(trackedReset, policyKey);
            }
            try {
              setWorkspaceSessionReferenced(child, true);
              await terminate();
              await confirmCleanReset();
              aclRecoveryConfirmed = true;
            } finally {
              settleTrackedReset?.();
            }
          },
          policyKey,
          child,
          workspaceEffectJob,
          async (error) => {
            setWorkspaceSessionReferenced(child, false);
            if (!aclRecoveryConfirmed) {
              await retainWindowsSandboxAclOwnerPoison(windowsAclOwnerMarker, error);
            }
          },
        );
      })().catch(async (error: unknown) => {
        setWorkspaceSessionReferenced(child, false);
        if (
          !aclRecoveryConfirmed
          && aclActionStarted
          && !(error instanceof FileSystemCleanupAdmissionTimeoutError)
        ) {
          await retainWindowsSandboxAclOwnerPoison(windowsAclOwnerMarker, error);
        }
        throw error;
      }).finally(() => {
        if (closeSkippedForNewLease && closePromise === current) {
          closePromise = undefined;
        }
        inFlightWorkspaceSessionCloses.delete(inflightClose);
        settleInflightClose();
      });
      closePromise = current;
      if (mode === 'forced') {
        trackWorkspaceSessionReset(current);
      }
      return current;
    },
  };
  scheduleIdleClose();
  return client;
}

function startWorkspaceSessionClient(
  workspaceRoot: string,
  agentHomeAccess: AsrtShellAgentHomeAccess | undefined,
  filesystemAccess: AsrtShellSandboxSelection['filesystemAccess'],
  runtimeReadScopes: readonly string[],
  policyKey: string,
  aclFenceHeld: boolean,
  onExit: () => void,
): Promise<WorkspaceSessionClient> {
  return withExclusiveFileSystemEffectFence(
    aclFenceHeld,
    async () => {
      const currentPolicyKey = workspaceShellPolicyKey(
        workspaceRoot,
        agentHomeAccess,
        filesystemAccess,
        runtimeReadScopes,
      );
      if (currentPolicyKey !== policyKey) {
        throw new Error('Sandbox policy paths changed before ACL initialization.');
      }
      await ensureWindowsSandboxAclRecovery(policyKey, true);
      assertWindowsSandboxAclSafe(policyKey);
      return startWorkspaceSessionClientWithFence(
        workspaceRoot,
        agentHomeAccess,
        filesystemAccess,
        runtimeReadScopes,
        policyKey,
        onExit,
      );
    },
    policyKey,
  );
}

function normalizedWorkspacePolicyPaths(values: readonly string[]): string[] {
  return [...new Set(values.map((candidate) => {
    const resolved = path.resolve(candidate);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }))].sort();
}

interface WorkspacePolicyPathIdentity {
  readonly lexical: string;
  readonly canonical: string | null;
}

function workspacePolicyPathIdentity(candidate: string): WorkspacePolicyPathIdentity {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  let canonical: string | null = null;
  try {
    canonical = normalize(realpathSync.native(candidate));
  } catch {
    // A missing path remains distinguishable from an existing or retargeted
    // path. Windows write grants reject unrepresentable missing targets before
    // this policy is admitted.
  }
  return {
    lexical: normalize(candidate),
    canonical,
  };
}

function workspacePolicyPathIdentities(
  values: readonly string[],
): WorkspacePolicyPathIdentity[] {
  const identities = new Map<string, WorkspacePolicyPathIdentity>();
  for (const value of values) {
    const identity = workspacePolicyPathIdentity(value);
    identities.set(`${identity.lexical}\0${identity.canonical ?? ''}`, identity);
  }
  return [...identities.values()].sort((left, right) => (
    left.lexical.localeCompare(right.lexical)
    || (left.canonical ?? '').localeCompare(right.canonical ?? '')
  ));
}

function workspaceShellPolicyKey(
  workspaceRoot: string,
  agentHomeAccess: AsrtShellAgentHomeAccess | undefined,
  filesystemAccess: AsrtShellSandboxSelection['filesystemAccess'],
  runtimeReadScopes: readonly string[],
): string {
  // Keep persistent deny guards in the policy identity even though their
  // ASRT copies are removed after the OS-level guard is installed. The guard
  // remains part of the effective policy, and this makes the identity stable
  // before and after first-session initialization.
  const effectiveConfig = workspaceShellSessionSandboxConfig(
    workspaceRoot,
    undefined,
    agentHomeAccess,
    filesystemAccess,
    runtimeReadScopes,
  );
  return createHash('sha256').update(JSON.stringify({
    workspace: workspacePolicyPathIdentity(workspaceRoot),
    agentHome: workspacePolicyPathIdentity(getAgentConfigHome()),
    tempBase: workspacePolicyPathIdentity(os.tmpdir()),
    filesystem: {
      allowRead: workspacePolicyPathIdentities(effectiveConfig.filesystem.allowRead),
      allowWrite: workspacePolicyPathIdentities(effectiveConfig.filesystem.allowWrite),
      denyRead: workspacePolicyPathIdentities(effectiveConfig.filesystem.denyRead),
      denyWrite: workspacePolicyPathIdentities(effectiveConfig.filesystem.denyWrite),
    },
    network: effectiveConfig.network,
    windowsRunner: process.platform === 'win32'
      ? {
          version: KODAX_ASRT_VERSION,
          architecture: process.arch,
          path: workspacePolicyPathIdentity(requirePreparedWindowsRunner().path),
        }
      : null,
    ephemeral: agentHomeAccess?.ephemeral === true,
  })).digest('hex');
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

async function getWorkspaceSession(
  workspaceRoot: string,
  agentHomeAccess?: AsrtShellAgentHomeAccess,
  filesystemAccess?: AsrtShellSandboxSelection['filesystemAccess'],
  runtimeReadScopes = workspaceShellRuntimeReadScopes(
    process.env,
    workspaceShellExecutable(),
  ),
  baselineReadScopes: readonly string[] = runtimeReadScopes,
  aclFenceHeld = false,
): Promise<WorkspaceSessionAdmission> {
  if (process.platform !== 'win32') {
    await waitForWorkspaceSessionResets();
  }
  const doctor = await doctorSandboxRuntime();
  if (!doctor.ready && !doctorHasWindowsSandboxAclCleanupBlock(doctor)) {
    return { denied: 'doctor_not_ready' };
  }
  if (process.platform !== 'win32') {
    // The sandbox and filesystem-effect coordinator create internal state under
    // KODAX_HOME. Make that expected initialization visible before capturing the
    // fail-closed policy identity so a fresh POSIX home is not mistaken for path
    // retargeting while the coordinator fence is acquired.
    const agentHome = getAgentConfigHome();
    await Promise.all([
      sandboxControlDirectory(),
      ...WORKSPACE_SHELL_INTERNAL_AGENT_HOME_DIRECTORIES.map((directory) => (
        mkdir(path.join(agentHome, directory), { recursive: true, mode: 0o700 })
      )),
    ]);
  }
  const policyKey = workspaceShellPolicyKey(
    workspaceRoot,
    process.platform === 'win32' ? agentHomeAccess : undefined,
    filesystemAccess,
    runtimeReadScopes,
  );
  if (process.platform === 'win32') {
    // Fail closed while this policy's own session reset is in flight, or while
    // any account-wide ACL transition is pending (undefined-key resets and all
    // poison transitions are account-wide and block every policy). A different
    // policy's in-flight reset no longer blocks this one: the durable ACL
    // owner marker layer remains the authoritative cross-policy serializer.
    if (pendingWindowsSandboxAclTransitions.size > 0) {
      return { denied: 'acl_transition_pending' };
    }
    if ([...pendingWorkspaceSessionResets].some((reset) => {
      const trackedKey = trackedPolicyKeys.get(reset);
      return trackedKey === undefined || trackedKey === '' || trackedKey === policyKey;
    })) {
      return { denied: 'session_reset_pending' };
    }
  }
  if (!doctor.ready && doctor.setupRequired) {
    return { denied: 'doctor_setup_required' };
  }
  registerWorkspaceSessionBeforeExit();
  const scopedAccess = process.platform === 'win32'
    ? agentHomeAccess
    : undefined;
  const workspaceKey = process.platform === 'win32'
    ? workspaceRoot.toLowerCase()
    : workspaceRoot;
  const normalizedReadScopes = normalizedWorkspacePolicyPaths;
  const normalizedRuntimeReadScopes = normalizedReadScopes(runtimeReadScopes);
  const isBaselineScope = JSON.stringify(normalizedRuntimeReadScopes)
    === JSON.stringify(normalizedReadScopes(baselineReadScopes));
  const hasAdditionalFilesystemAccess = (filesystemAccess?.read.length ?? 0) > 0
    || (filesystemAccess?.write.length ?? 0) > 0;
  const accessKey = scopedAccess === undefined
    && !hasAdditionalFilesystemAccess
    && isBaselineScope
    ? 'workspace'
    : createHash('sha256').update(JSON.stringify({
        read: [...(scopedAccess?.read ?? [])].map((candidate) => candidate.toLowerCase()).sort(),
        write: [...(scopedAccess?.write ?? [])].map((candidate) => candidate.toLowerCase()).sort(),
        additionalRead: normalizedWorkspacePolicyPaths(filesystemAccess?.read ?? []),
        additionalWrite: normalizedWorkspacePolicyPaths(filesystemAccess?.write ?? []),
        runtimeReadScopes: normalizedRuntimeReadScopes,
      })).digest('hex');
  // Windows ACL owners share one machine account, so their cache identity is
  // exactly the canonical effective policy. POSIX retains its existing local
  // workspace/access cache partitioning.
  const key = process.platform === 'win32'
    ? policyKey
    : `${workspaceKey}\0${accessKey}`;
  if (scopedAccess?.ephemeral === true) {
    return {
      session: await startWorkspaceSessionClient(
        workspaceRoot,
        scopedAccess,
        filesystemAccess,
        runtimeReadScopes,
        policyKey,
        aclFenceHeld,
        () => undefined,
      ),
    };
  }
  let session = workspaceSessions.get(key);
  if (session) {
    await ensureWindowsSandboxAclRecovery(policyKey);
    assertWindowsSandboxAclSafe(policyKey);
    workspaceSessions.delete(key);
    workspaceSessions.set(key, session);
  }
  if (!session) {
    if (process.platform !== 'win32' && accessKey !== 'workspace') {
      const scopedKeys = [...workspaceSessions.keys()].filter(
        (candidate) => !candidate.endsWith('\0workspace'),
      );
      if (scopedKeys.length >= MAX_CACHED_SCOPED_WORKSPACE_SESSIONS) {
        const oldestKey = scopedKeys[0]!;
        const oldest = workspaceSessions.get(oldestKey);
        workspaceSessions.delete(oldestKey);
        if (oldest) {
          try {
            await (await oldest).close();
          } catch (error: unknown) {
            emitKodaXDiagnostic({
              source: 'sandbox:workspace-session',
              level: 'warn',
              message: 'Retiring an old scoped workspace sandbox failed.',
              detail: error,
            });
            throw error;
          }
        }
      }
    }
    session = startWorkspaceSessionClient(
      workspaceRoot,
      scopedAccess,
      filesystemAccess,
      runtimeReadScopes,
      policyKey,
      aclFenceHeld,
      () => {
        if (workspaceSessions.get(key) === session) workspaceSessions.delete(key);
      },
    );
    workspaceSessions.set(key, session);
    void session.catch(() => {
      if (workspaceSessions.get(key) === session) workspaceSessions.delete(key);
    });
  }
  return { session: await session };
}

/** Test-only cleanup for mocked or disposable workspace sessions. */
export async function resetAsrtWorkspaceSessionsForTest(options: {
  readonly preserveAclPoison?: boolean;
} = {}): Promise<void> {
  process.removeListener('beforeExit', closeWorkspaceSessionsBeforeExit);
  workspaceBeforeExitRegistered = false;
  while (pendingWorkspaceSessionWarmups.size > 0) {
    await Promise.allSettled([...pendingWorkspaceSessionWarmups]);
  }
  await closeCachedWorkspaceSessions();
  while (pendingWorkspaceSessionResets.size > 0) {
    await Promise.allSettled([...pendingWorkspaceSessionResets]);
  }
  while (pendingStandaloneBrokerSettlements.size > 0) {
    await Promise.allSettled([...pendingStandaloneBrokerSettlements]);
  }
  await waitForWindowsSandboxAclTransitions();
  pendingWorkspaceSessionResets.clear();
  pendingStandaloneBrokerSettlements.clear();
  clearWindowsSandboxAclRecoveryRetry();
  sandboxProcessSafetyFailure = undefined;
  windowsSandboxAclStartupRecovered = false;
  cachedWindowsBootIdentity = undefined;
  activeWindowsSandboxAclOwnerMarkers.clear();
  legacyWindowsSandboxAclOwnerMarkers.clear();
  recoverableWindowsEffectFences.clear();
  process.removeListener('exit', releasePreparedWindowsRunnerGrant);
  releasePreparedWindowsRunnerGrant();
  doctorPromise = undefined;
  doctorExpiresAt = 0;
  preparedWindowsRunnerPromise = undefined;
  preparedWindowsRunner = undefined;
  windowsAclReadGuardedPaths.clear();
  windowsAclWriteGuardedPaths.clear();
  if (options.preserveAclPoison !== true) {
    rmSync(windowsSandboxAclPoisonDirectory(), { recursive: true, force: true });
    rmSync(legacyWindowsSandboxAclPoisonDirectory(), { recursive: true, force: true });
  }
}

/** Test-only override for workspace session RPC deadlines. */
export function overrideWorkspaceSessionRpcTimeoutsForTest(options: {
  readonly rpcMs?: number;
  readonly cleanupMs?: number;
}): () => void {
  const restoreRpcMs = workspaceSessionRpcTimeoutMs;
  const restoreCleanupMs = workspaceSessionCleanupTimeoutMs;
  if (options.rpcMs !== undefined) workspaceSessionRpcTimeoutMs = options.rpcMs;
  if (options.cleanupMs !== undefined) workspaceSessionCleanupTimeoutMs = options.cleanupMs;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    workspaceSessionRpcTimeoutMs = restoreRpcMs;
    workspaceSessionCleanupTimeoutMs = restoreCleanupMs;
  };
}

/** Test-only override for the production shutdown settlement deadline. */
export function overrideStandaloneBrokerSettlementTimeoutForTest(timeoutMs: number): () => void {
  const restoreTimeoutMs = standaloneBrokerShutdownSettlementTimeoutMs;
  standaloneBrokerShutdownSettlementTimeoutMs = timeoutMs;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    standaloneBrokerShutdownSettlementTimeoutMs = restoreTimeoutMs;
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
  const baselineReadScopes = workspaceShellRuntimeReadScopes(
    process.platform === 'win32' ? {} : process.env,
    workspaceShellExecutable(),
  );
  const workspaceWarmup = process.platform === 'win32'
    ? undefined
    : getWorkspaceSession(
      workspaceRoot,
      undefined,
      undefined,
      baselineReadScopes,
      baselineReadScopes,
    ).then(
      (admission): WorkspaceSessionClient | undefined => (
        'denied' in admission ? undefined : admission.session
      ),
      (): WorkspaceSessionClient | undefined => undefined,
    );
  if (workspaceWarmup !== undefined) {
    pendingWorkspaceSessionWarmups.add(workspaceWarmup);
    void workspaceWarmup.then(
      () => pendingWorkspaceSessionWarmups.delete(workspaceWarmup),
      () => pendingWorkspaceSessionWarmups.delete(workspaceWarmup),
    );
    void workspaceWarmup.catch((error: unknown) => {
      emitKodaXDiagnostic({
        source: 'sandbox:workspace-session',
        level: 'warn',
        message: 'Workspace sandbox warm-up failed; admitted commands will use normal permission fallback.',
        detail: error,
      });
    });
  }
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
        shellInput.reportObservation?.({
          version: 1,
          state: 'fallback',
          reason: 'not_ready',
          execution: 'normal_permission_policy',
        });
        return undefined;
      }
      const ephemeralSession = process.platform === 'win32'
        && agentHomeAccess?.ephemeral === true;
      const executable = workspaceShellExecutable(shellInput.executable);
      const args = shellInput.args
        ?? (process.platform === 'win32'
          ? ['/d', '/s', '/c', shellInput.command]
          : ['-c', shellInput.command]);
      const commandEnvironment = normalizedSandboxEnvironment(shellInput.env);
      const runtimeReadScopes = workspaceShellRuntimeReadScopes(
        commandEnvironment,
        executable,
      );
      let lease: WorkspaceSessionLease | undefined;
      let workspaceSession: WorkspaceSessionClient | undefined;
      try {
        if (workspaceWarmup !== undefined) {
          await waitForWorkspacePreparation(
            workspaceWarmup.then(() => undefined, () => undefined),
            shellInput.signal,
            shellInput.deadlineAt,
          );
          throwIfWorkspacePreparationStopped(shellInput.signal, shellInput.deadlineAt);
        }
        const pendingSession = getWorkspaceSession(
          workspaceRoot,
          agentHomeAccess,
          filesystemAccess,
          runtimeReadScopes,
          baselineReadScopes,
        );
        let session: WorkspaceSessionClient | undefined;
        let admissionDenied: WorkspaceSessionDenialReason | undefined;
        try {
          session = await waitForWorkspacePreparation(
            pendingSession,
            shellInput.signal,
            shellInput.deadlineAt,
          ).then((admission): WorkspaceSessionClient | undefined => {
            if ('denied' in admission) {
              admissionDenied = admission.denied;
              return undefined;
            }
            return admission.session;
          });
        } catch (error: unknown) {
          if (
            process.platform === 'win32'
            && (
              shellInput.signal?.aborted
              || (
                shellInput.deadlineAt !== undefined
                && Date.now() >= shellInput.deadlineAt
              )
            )
          ) {
            const lateRollback = pendingSession.then(
              async (lateAdmission) => {
                if ('session' in lateAdmission) await lateAdmission.session.close();
              },
              async () => undefined,
            );
            void lateRollback.catch((closeError: unknown) => {
              emitKodaXDiagnostic({
                source: 'sandbox:workspace-session',
                level: 'warn',
                message: 'Late cancelled workspace session rollback failed.',
                detail: closeError,
              });
            });
          }
          throw error;
        }
        if (!session) {
          shellInput.reportObservation?.({
            version: 1,
            state: 'fallback',
            reason: admissionDenied === 'session_reset_pending'
              || admissionDenied === 'acl_transition_pending'
              ? admissionDenied
              : 'not_ready',
            execution: 'normal_permission_policy',
          });
          return undefined;
        }
        const policyKey = session.policyKey;
        workspaceSession = session;
        const controlDirectory = await sandboxControlDirectory();
        const requestFile = path.join(
          controlDirectory,
          `kodax-asrt-shell-${process.pid}-${randomUUID()}.json`,
        );
        const observationFile = path.join(
          controlDirectory,
          `kodax-asrt-observation-${process.pid}-${randomUUID()}.json`,
        );
        let env = commandEnvironment;
        if (process.platform === 'win32') {
          const sandboxTemp = session.tempDirectory;
          if (sandboxTemp === undefined) {
            throw new Error('Windows workspace sandbox temp directory is unavailable.');
          }
          env = mergeSandboxEnvironment(commandEnvironment, {
            TEMP: sandboxTemp,
            TMP: sandboxTemp,
            TMPDIR: sandboxTemp,
            GIT_CONFIG_GLOBAL: 'NUL',
            GIT_CONFIG_NOSYSTEM: '1',
          });
        }
        const request: SandboxBrokerRequest = {
          config: withoutWindowsAsrtDenyPropagation(workspaceShellCommandSandboxConfig(
            workspaceRoot,
            session.tempDirectory,
            agentHomeAccess,
            filesystemAccess,
            runtimeReadScopes,
          )),
          command: executable,
          args,
          windowsVerbatimArguments: shellInput.windowsVerbatimArguments === true,
          cwd: shellInput.cwd,
          env,
          endpoints: [],
          allowAllNetwork: true,
          bootstrapCommand: sandboxJavaScriptCommand(),
          fallbackToNormalExecution: shellInput.fallbackToNormalExecution !== false,
          observationBackend: sandboxRuntimeCapability().backend,
          observationFile,
          targetStartedMarker:
            `\0KODAX_ASRT_TARGET_STARTED:${randomUUID()}\0\n`,
        };
        const activeLease = await session.acquire(
          request,
          shellInput.signal,
          shellInput.deadlineAt,
        );
        lease = activeLease;
        const brokerRequest: SandboxBrokerRequest = {
          ...request,
          wrappedInvocation: activeLease.invocation,
        };
        const brokerArgs = process.env.KODAX_BUNDLED === 'true'
          ? ['__asrt-broker', requestFile]
          : ['--input-type=module', '-e', BROKER_SOURCE, ASRT_MODULE_URL!, requestFile];
        const launch = prepareInternalNodeLaunch({
          args: brokerArgs,
          env: sanitizedEnvironment(),
          isElectron: process.versions.electron !== undefined,
        });
        await writeFile(requestFile, JSON.stringify(brokerRequest), { mode: 0o600 });
        let retirement: Promise<void> | undefined;
        const retireWorkspaceSession = async (): Promise<void> => {
          if (ephemeralSession) return;
          if (retirement === undefined) {
            retirement = workspaceSession?.close() ?? Promise.resolve();
            void retirement.catch((error: unknown) => {
              emitKodaXDiagnostic({
                source: 'sandbox:workspace-session',
                level: 'warn',
                message: 'Workspace sandbox session retirement failed.',
                detail: error,
              });
            });
          }
          if (process.platform === 'win32') await retirement;
        };
        let observationResolved = false;
        let retainedObservation: KodaXShellSandboxObservation | undefined;
        let cleanupPromise: Promise<KodaXShellSandboxObservation | undefined> | undefined;
        return {
          executable: process.execPath,
          args: launch.args,
          env: launch.env,
          fileSystemEffectPolicyKey: policyKey,
          authorizeStart: () => assertWindowsSandboxAclSafe(policyKey),
          async cleanup(cleanupInput) {
            if (cleanupPromise !== undefined) return cleanupPromise;
            const current = (async () => {
              const cleanupFailures: unknown[] = [];
              if (!observationResolved) {
                try {
                  retainedObservation = await readFile(observationFile, 'utf8')
                    .then(parseBrokerObservation)
                    .catch((error: NodeJS.ErrnoException) => {
                      if (error.code === 'ENOENT') return undefined;
                      throw error;
                    });
                  observationResolved = true;
                } catch (error: unknown) {
                  cleanupFailures.push(error);
                }
              }
              const removals = await Promise.allSettled([
                rm(requestFile, { force: true }),
                ...(observationResolved ? [rm(observationFile, { force: true })] : []),
              ]);
              for (const removal of removals) {
                if (removal.status === 'rejected') cleanupFailures.push(removal.reason);
              }
              try {
                await activeLease.release();
              } catch (error: unknown) {
                cleanupFailures.push(error);
              }
              const attestationMissing = cleanupInput?.execution === 'started_or_unknown'
                && retainedObservation === undefined;
              if (attestationMissing) {
                cleanupFailures.push(new Error(
                  'Required OS sandbox execution could not be attested; '
                  + 'the workspace session must be retired and the command was not retried',
                ));
              }
              if (cleanupFailures.length > 0) {
                const summary = attestationMissing
                  ? 'Required OS sandbox execution could not be attested and request cleanup failed; '
                    + 'the workspace session must be retired and the command was not retried.'
                  : 'Required OS sandbox request cleanup failed; '
                    + 'the workspace session must be retired.';
                const message = cleanupFailures.length === 1
                  ? `${summary} Cause: ${errorText(cleanupFailures[0])}`
                  : summary;
                const error = new AggregateError(
                  cleanupFailures,
                  message,
                );
                emitKodaXDiagnostic({
                  source: 'sandbox:workspace-session',
                  level: 'warn',
                  message: 'Workspace sandbox command cleanup failed.',
                  detail: error,
                });
                throw error;
              }
              return retainedObservation;
            })();
            cleanupPromise = current;
            try {
              return await current;
            } finally {
              if (cleanupPromise === current) cleanupPromise = undefined;
            }
          },
          retire: retireWorkspaceSession,
        };
      } catch (error: unknown) {
        const failures: unknown[] = [error];
        const preparationStopped = shellInput.signal?.aborted
          || (
            shellInput.deadlineAt !== undefined
            && Date.now() >= shellInput.deadlineAt
          );
        let leaseReleaseFailed = false;
        if (lease) {
          try {
            await lease.release();
          } catch (releaseError: unknown) {
            leaseReleaseFailed = true;
            failures.push(releaseError);
            emitKodaXDiagnostic({
              source: 'sandbox:workspace-session',
              level: 'warn',
              message: 'Workspace sandbox lease release failed.',
              detail: releaseError,
            });
          }
        }
        if (
          preparationStopped
          && process.platform === 'win32'
          && workspaceSession
          && lease === undefined
        ) {
          void workspaceSession.close().catch((closeError: unknown) => {
            emitKodaXDiagnostic({
              source: 'sandbox:workspace-session',
              level: 'warn',
              message: 'Cancelled workspace preparation cleanup could not retire its session.',
              detail: closeError,
            });
          });
          throw error;
        }
        if (process.platform === 'win32' && workspaceSession) {
          try {
            await workspaceSession.close();
          } catch (closeError: unknown) {
            failures.push(closeError);
            emitKodaXDiagnostic({
              source: 'sandbox:workspace-session',
              level: 'warn',
              message: 'Failed workspace lease cleanup could not retire its session.',
              detail: closeError,
            });
          }
        } else if (leaseReleaseFailed && workspaceSession) {
          void workspaceSession.close().catch((closeError: unknown) => {
            emitKodaXDiagnostic({
              source: 'sandbox:workspace-session',
              level: 'warn',
              message: 'Failed workspace lease cleanup could not retire its session.',
              detail: closeError,
            });
          });
        }
        if (preparationStopped) throw error;
        const diagnostic = failures.length === 1
          ? error
          : new AggregateError(
              failures,
              `Workspace sandbox preparation failed and cleanup was incomplete: ${failures
                .map(errorText)
                .join(' | ')}`,
            );
        emitKodaXDiagnostic({
          source: 'sandbox:workspace-session',
          level: 'warn',
          message: 'Workspace sandbox preparation failed; using normal permission fallback.',
          detail: diagnostic,
        });
        shellInput.reportObservation?.({
          version: 1,
          state: 'fallback',
          reason: 'prepare_failed',
          execution: 'normal_permission_policy',
        });
        return undefined;
      }
    },
  };
}

const TEXT_FILE_MUTATION_HELPER = String.raw`
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
process.stdin.once('end', async () => {
  const assertSingleLink = (stat) => {
    if (stat.nlink !== 1n) throw new Error('Text mutation target must not be hard-linked.');
  };
  const revision = (content, stat) => 'present:' + createHash('sha256')
    .update(stat.dev.toString())
    .update(':')
    .update(stat.ino.toString())
    .update(':')
    .update(stat.nlink.toString())
    .update('\0')
    .update(content)
    .digest('hex');
  const backupPath = async (target, openedStat) => {
    const canonical = await fs.realpath(target);
    let canonicalHandle;
    try {
      canonicalHandle = await fs.open(canonical, 'r');
      const canonicalStat = await canonicalHandle.stat({ bigint: true });
      assertSingleLink(canonicalStat);
      if (canonicalStat.dev !== openedStat.dev || canonicalStat.ino !== openedStat.ino) {
        throw new Error('Text mutation target identity changed while reading.');
      }
      return canonical;
    } finally {
      await canonicalHandle?.close();
    }
  };
  const snapshot = async (target) => {
    let handle;
    try {
      handle = await fs.open(target, 'r');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { state: 'missing', content: '', revision: 'missing', backupPath: path.resolve(target) };
      }
      throw error;
    }
    try {
      const [content, stat] = await Promise.all([
        handle.readFile('utf8'),
        handle.stat({ bigint: true }),
      ]);
      assertSingleLink(stat);
      return {
        state: 'present',
        content,
        revision: revision(content, stat),
        backupPath: await backupPath(target, stat),
      };
    } finally {
      await handle?.close();
    }
  };
  const writeFully = async (handle, content) => {
    const encoded = Buffer.from(content, 'utf8');
    let written = 0;
    while (written < encoded.length) {
      const result = await handle.write(encoded, written, encoded.length - written, written);
      if (result.bytesWritten === 0) throw new Error('Text mutation write made no progress.');
      written += result.bytesWritten;
    }
    await handle.truncate(encoded.length);
  };
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input.path !== 'string' || !path.isAbsolute(input.path)) {
      throw new Error('Text mutation target must be an absolute path.');
    }
    if (input.action === 'read') {
      process.stdout.write(JSON.stringify({ status: 'ok', snapshot: await snapshot(input.path) }));
      return;
    }
    if (
      input.action !== 'write'
      || typeof input.content !== 'string'
      || typeof input.expectedRevision !== 'string'
      || typeof input.createParentDirectories !== 'boolean'
    ) throw new Error('Invalid text mutation request.');
    if (input.createParentDirectories) await fs.mkdir(path.dirname(input.path), { recursive: true });
    let handle;
    try {
      if (input.expectedRevision === 'missing') {
        handle = await fs.open(input.path, 'wx');
        assertSingleLink(await handle.stat({ bigint: true }));
      } else {
        handle = await fs.open(input.path, 'r+');
        const [content, stat] = await Promise.all([
          handle.readFile('utf8'),
          handle.stat({ bigint: true }),
        ]);
        assertSingleLink(stat);
        if (revision(content, stat) !== input.expectedRevision) {
          process.stdout.write(JSON.stringify({ status: 'conflict' }));
          return;
        }
      }
      await writeFully(handle, input.content);
      process.stdout.write(JSON.stringify({ status: 'written' }));
    } catch (error) {
      if (input.expectedRevision === 'missing' && error && error.code === 'EEXIST') {
        process.stdout.write(JSON.stringify({ status: 'conflict' }));
        return;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  }
});
`;

const TEXT_FILE_MUTATION_OUTPUT_LIMIT = 64 * 1024 * 1024;
const TEXT_FILE_SELECTION_CACHE_LIMIT = 128;
const TEXT_FILE_CALL_KEY = '__kodaxTextFileMutationCall';

interface EncodedTextFileMutationCall {
  readonly id: string;
  readonly name: KodaXTextFileMutationRequest['toolName'];
  readonly input: Readonly<Record<string, unknown>>;
  readonly path: string;
}

function encodedTextFileMutationCall(call: RunnerToolCall): EncodedTextFileMutationCall | undefined {
  const encoded = call.input[TEXT_FILE_CALL_KEY];
  if (encoded === null || typeof encoded !== 'object') return undefined;
  const candidate = encoded as Partial<EncodedTextFileMutationCall>;
  if (
    typeof candidate.id !== 'string'
    || typeof candidate.name !== 'string'
    || typeof candidate.path !== 'string'
    || candidate.input === null
    || typeof candidate.input !== 'object'
  ) return undefined;
  return candidate as EncodedTextFileMutationCall;
}

async function executePreparedTextFileMutation(
  sandbox: KodaXShellSandbox,
  workspaceRoot: string,
  request: KodaXTextFileMutationRequest,
  payload: Readonly<Record<string, unknown>>,
  observeFallback?: (observation: KodaXShellSandboxObservation) => void,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const toolCallId = request.toolCallId ?? `text-file-${randomUUID()}`;
  const invocation = await sandbox.prepare({
    toolCallId,
    toolInput: {
      [TEXT_FILE_CALL_KEY]: {
        id: toolCallId,
        name: request.toolName,
        input: request.toolInput,
        path: request.path,
      } satisfies EncodedTextFileMutationCall,
    },
    command: 'kodax-internal-text-file-mutation',
    executable: process.execPath,
    args: ['-e', TEXT_FILE_MUTATION_HELPER],
    cwd: workspaceRoot,
    env: sanitizedEnvironment(),
    fallbackToNormalExecution: false,
    signal: request.signal,
    reportObservation: observeFallback,
  });
  if (invocation === undefined) return undefined;

  let execution: 'not_started' | 'started_or_unknown' = 'not_started';
  let operationFailure: unknown;
  let effectLease: Awaited<ReturnType<typeof acquireFileSystemMutationLease>> | undefined;
  let effectProcessBound = false;
  let effectProcessFinished = false;
  let processDrained = false;
  let child: ReturnType<typeof spawn> | undefined;
  let windowsEffectJob: WindowsEffectJob | undefined;
  let invocationCleaned = false;
  let effectLeaseReleased = false;
  let cleanupRecoveryScheduled = false;
  const cleanupRecovered = (): boolean => (
    (child === undefined || processDrained)
    && (effectLease === undefined || effectProcessFinished)
    && invocationCleaned
    && effectLeaseReleased
  );
  const recoverTextMutationCleanup = async (terminateContainedJob: boolean): Promise<void> => {
    if (child !== undefined && !processDrained) {
      if (terminateContainedJob && windowsEffectJob !== undefined) {
        await terminateWindowsEffectJob(windowsEffectJob.jobName);
      } else {
        const termination = await killChildProcessTree(child);
        if (termination.status === 'unknown') {
          throw new Error('Sandboxed text mutation process tree is still not proven drained.');
        }
        await windowsEffectJob?.drained;
      }
      processDrained = true;
    }
    if (effectLease !== undefined && !effectProcessFinished) {
      await effectLease.finishEffectProcess();
      effectProcessFinished = true;
    }
    if (effectProcessBound) {
      if (!invocationCleaned) {
        await invocation.cleanup({ execution });
        invocationCleaned = true;
      }
      if (!effectLeaseReleased) {
        await effectLease?.();
        effectLeaseReleased = true;
      }
      return;
    }
    if (!effectLeaseReleased) {
      await effectLease?.();
      effectLeaseReleased = true;
    }
    if (!invocationCleaned) {
      await invocation.cleanup({ execution });
      invocationCleaned = true;
    }
  };
  const scheduleCleanupRecovery = (): void => {
    if (cleanupRecoveryScheduled || cleanupRecovered()) return;
    cleanupRecoveryScheduled = true;
    scheduleUnrefBackgroundRetry(
      () => recoverTextMutationCleanup(true),
      () => undefined,
      (error, attempt) => {
        if (attempt % 10 !== 0) return;
        emitKodaXDiagnostic({
          source: 'runtime:text-file-mutation',
          level: 'warn',
          message: 'Automatic text-mutation cleanup recovery is still pending; its sandbox owner and filesystem fence remain closed.',
          detail: error,
        });
      },
    );
  };
  try {
    if (invocation.fileSystemEffectPolicyKey !== undefined) {
      effectLease = await acquireFileSystemMutationLease(invocation.fileSystemEffectPolicyKey);
    }
    child = spawn(invocation.executable, [...invocation.args], {
      cwd: workspaceRoot,
      detached: process.platform !== 'win32',
      env: invocation.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    execution = 'started_or_unknown';
    rememberChildProcessTree(child);
    if (effectLease !== undefined) {
      if (child.pid === undefined) throw new Error('Sandboxed text mutation process has no PID.');
      if (process.platform === 'win32') {
        windowsEffectJob = await containWindowsEffectProcess(child.pid);
      }
      await effectLease.bindEffectProcess(
        windowsEffectJob?.supervisorPid ?? child.pid,
        windowsEffectJob !== undefined,
      );
      effectProcessBound = true;
    }
    invocation.authorizeStart?.();
    const childInput = child.stdin;
    if (childInput === null) throw new Error('Sandboxed text mutation process has no stdin gate.');
    const resultPromise = collectProcess(
      child,
      request.signal,
      SCRIPT_TIMEOUT_MS,
      TEXT_FILE_MUTATION_OUTPUT_LIMIT,
    );
    const inputPromise = new Promise<void>((resolve, reject) => {
      childInput.end(JSON.stringify(payload), (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
    const [result] = await Promise.all([resultPromise, inputPromise]);
    if (windowsEffectJob !== undefined) {
      await windowsEffectJob.drained;
    } else {
      const termination = await killChildProcessTree(child);
      if (termination.status === 'unknown') {
        throw new Error('Sandboxed text mutation process tree could not be proven drained.');
      }
    }
    processDrained = true;
    if (effectLease !== undefined) {
      await effectLease.finishEffectProcess();
      effectProcessFinished = true;
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Sandboxed text mutation failed (${result.exitCode}): ${result.stderr.trim() || 'no diagnostics'}`,
      );
    }
    const parsed = JSON.parse(result.stdout) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Sandboxed text mutation returned an invalid response.');
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch (error: unknown) {
    operationFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try {
      await recoverTextMutationCleanup(false);
    } catch (error: unknown) {
      cleanupFailures.push(error);
    }
    // Any unfinished phase keeps the appropriate owner/fence and converges in
    // the same retry loop, whether the first failure was drain, inner cleanup,
    // policy reset, or outer lease release.
    if (!cleanupRecovered()) scheduleCleanupRecovery();
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [
          ...(operationFailure === undefined ? [] : [operationFailure]),
          ...cleanupFailures,
        ],
        operationFailure === undefined
          ? 'Sandboxed text mutation cleanup failed.'
          : 'Sandboxed text mutation and cleanup both failed.',
      );
    }
  }
}

function textMutationUnavailableReason(
  observation: KodaXShellSandboxObservation,
): KodaXTextFileMutationUnavailableReason {
  if (observation.state === 'not_selected') return 'not_selected';
  if (observation.reason === 'session_reset_pending') return 'session_reset_pending';
  if (observation.reason === 'acl_transition_pending') return 'acl_transition_pending';
  return 'not_ready';
}

/** Direct text tools use the same workspace sandbox policy as shell tools. */
export function createAsrtTextFileMutationSandbox(
  input: CreateAsrtShellSandboxInput,
): KodaXTextFileMutationSandbox {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const canonicalWorkspaceRoot = realpathSync(workspaceRoot);
  const canonicalCandidate = (filePath: string): string | undefined => {
    let existing = path.resolve(filePath);
    const missingSegments: string[] = [];
    for (;;) {
      try {
        return path.join(realpathSync.native(existing), ...missingSegments);
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) return undefined;
        missingSegments.unshift(path.basename(existing));
        existing = parent;
      }
    }
  };
  const canHandlePath = (filePath: string): boolean => {
    const candidate = path.resolve(filePath);
    const canonical = canonicalCandidate(candidate);
    if (
      isInside(workspaceRoot, candidate)
      || (canonical !== undefined && isInside(canonicalWorkspaceRoot, canonical))
    ) return true;
    if (canonical === undefined) return false;
    return (input.additionalWorkspaceRoots?.() ?? []).some((root) => (
      isInside(path.resolve(root), canonical)
    ));
  };
  const selections = new Map<string, {
    readonly fingerprint: string;
    readonly selection: Promise<boolean | AsrtShellSandboxSelection>;
  }>();
  const sandbox = createAsrtShellSandbox({
    workspaceRoot: input.workspaceRoot,
    ...(input.additionalWorkspaceRoots === undefined
      ? {}
      : { additionalWorkspaceRoots: input.additionalWorkspaceRoots }),
    shouldSandbox: async (wrapperCall) => {
      const encoded = encodedTextFileMutationCall(wrapperCall);
      if (encoded === undefined) return false;
      if (!canHandlePath(encoded.path)) return false;
      const fingerprint = createHash('sha256')
        .update(encoded.name)
        .update('\0')
        .update(encoded.path)
        .update('\0')
        .update(JSON.stringify(encoded.input))
        .digest('hex');
      let cached = selections.get(encoded.id);
      if (cached !== undefined && cached.fingerprint !== fingerprint) {
        throw new Error(`Text mutation tool-call identity was reused with different input: ${encoded.id}`);
      }
      if (cached === undefined) {
        const selection = Promise.resolve(input.shouldSandbox({
          id: encoded.id,
          name: encoded.name,
          input: encoded.input,
        })).catch((error: unknown) => {
          selections.delete(encoded.id);
          throw error;
        });
        cached = { fingerprint, selection };
        selections.set(encoded.id, cached);
        if (selections.size > TEXT_FILE_SELECTION_CACHE_LIMIT) {
          selections.delete(selections.keys().next().value as string);
        }
      }
      return cached.selection;
    },
  });
  return {
    canHandlePath,
    async read(request) {
      let unavailableReason: KodaXTextFileMutationUnavailableReason = 'not_ready';
      const response = await executePreparedTextFileMutation(
        sandbox,
        workspaceRoot,
        request,
        { action: 'read', path: request.path },
        (observation) => {
          unavailableReason = textMutationUnavailableReason(observation);
        },
      );
      if (response === undefined) return { status: 'unavailable', reason: unavailableReason };
      const snapshot = response.snapshot;
      if (
        response.status !== 'ok'
        || snapshot === null
        || typeof snapshot !== 'object'
      ) throw new Error('Sandboxed text read returned an invalid response.');
      const value = snapshot as Record<string, unknown>;
      if (
        (value.state !== 'missing' && value.state !== 'present')
        || typeof value.content !== 'string'
        || typeof value.revision !== 'string'
        || typeof value.backupPath !== 'string'
        || !path.isAbsolute(value.backupPath)
        || !canHandlePath(value.backupPath)
      ) throw new Error('Sandboxed text read returned an invalid snapshot.');
      return {
        status: 'ok',
        snapshot: {
          state: value.state,
          content: value.content,
          revision: value.revision,
          backupPath: value.backupPath,
        },
      };
    },
    async write(request) {
      let unavailableReason: KodaXTextFileMutationUnavailableReason = 'not_ready';
      try {
        const response = await executePreparedTextFileMutation(
          sandbox,
          workspaceRoot,
          request,
          {
            action: 'write',
            path: request.path,
            content: request.content,
            expectedRevision: request.expectedRevision,
            createParentDirectories: request.createParentDirectories,
          },
          (observation) => {
            unavailableReason = textMutationUnavailableReason(observation);
          },
        );
        if (response === undefined) return { status: 'unavailable', reason: unavailableReason };
        if (response.status === 'written') return { status: 'written' };
        if (response.status === 'conflict') return { status: 'conflict' };
        throw new Error('Sandboxed text write returned an invalid response.');
      } finally {
        if (request.toolCallId !== undefined) selections.delete(request.toolCallId);
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
      throw new Error(`Ambiguous Windows child environment variable: ${name}.`);
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
  observation: KodaXShellSandboxObservation,
): Promise<void> {
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
        }).catch(() => undefined);
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

async function resetWorkspaceSessionSandboxManager(): Promise<void> {
  try {
    SandboxManager.cleanupAfterCommand();
  } catch (error: unknown) {
    emitKodaXDiagnostic({
      source: 'sandbox:workspace-session',
      level: 'warn',
      message: 'Workspace sandbox command cleanup reported an error before ACL reset.',
      detail: error,
    });
  }
  await SandboxManager.reset();
}

async function runNormalBrokerProcess(
  request: SandboxBrokerRequest,
): Promise<number> {
  const internalElectronNode = (
    request.command === process.execPath
    && process.versions.electron !== undefined
  );
  const args = internalElectronNode
    ? ['--import', ELECTRON_NODE_ENV_SCRUB_IMPORT, ...request.args]
    : request.args;
  const env = internalElectronNode
    ? { ...request.env, [ELECTRON_RUN_AS_NODE_ENV]: '1' }
    : request.env;
  const child = spawn(request.command, args, {
    cwd: request.cwd,
    env,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
    windowsVerbatimArguments: request.windowsVerbatimArguments === true,
  });
  return new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

/** Internal entry used only by the standalone binary's isolated broker process. */
export async function runAsrtBrokerProcess(requestFile: string): Promise<number> {
  let request: SandboxBrokerRequest | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let targetStarted = false;
  let normalFallbackAttempted = false;
  try {
    request = JSON.parse(await readFile(requestFile, 'utf8')) as SandboxBrokerRequest;
    await rm(requestFile, { force: true });
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
    if (
      result.spawnFailedBeforeSpawn
      && request.fallbackToNormalExecution === true
      && !normalFallbackAttempted
    ) {
      normalFallbackAttempted = true;
      if (request.wrappedInvocation === undefined) {
        await resetSandboxManagerBestEffort();
      }
      await writeBrokerObservation(request, {
        version: 1,
        state: 'fallback',
        reason: 'backend_failed',
        execution: 'normal_permission_policy',
      }).catch(() => undefined);
      return await runNormalBrokerProcess(request);
    }
    if (!targetStarted) {
      process.stderr.write(
        `${result.diagnostic ?? 'Sandbox target launch could not be attested.'}\n`,
      );
    }
    return targetStarted ? result.exitCode : 1;
  } catch (error: unknown) {
    if (
      request?.fallbackToNormalExecution === true
      && !targetStarted
      && !normalFallbackAttempted
      && child === undefined
    ) {
      if (request.wrappedInvocation === undefined) {
        await resetSandboxManagerBestEffort();
      }
      try {
        await writeBrokerObservation(request, {
          version: 1,
          state: 'fallback',
          reason: 'backend_failed',
          execution: 'normal_permission_policy',
        }).catch(() => undefined);
        normalFallbackAttempted = true;
        return await runNormalBrokerProcess(request);
      } catch (fallbackError: unknown) {
        process.stderr.write(`${errorText(fallbackError)}\n`);
        return 1;
      }
    }
    process.stderr.write(`${errorText(error)}\n`);
    return 1;
  } finally {
    if (request?.wrappedInvocation === undefined) {
      await resetSandboxManagerBestEffort();
    }
  }
}

interface WorkspaceSessionCommand {
  readonly id: string;
  readonly type: 'wrap' | 'cleanup';
  readonly request?: SandboxBrokerRequest;
}

function writeWorkspaceSessionResponse(response: WorkspaceSessionResponse): void {
  writeSync(3, `${JSON.stringify(response)}\n`);
}

/** Internal long-lived owner for one workspace's ASRT ACL/WFP session. */
export async function runAsrtWorkspaceSessionProcess(
  initFile: string,
): Promise<number> {
  try {
    const init = JSON.parse(await readFile(initFile, 'utf8')) as {
      readonly config: SandboxRuntimeConfig;
    };
    await rm(initFile, { force: true });
    await SandboxManager.initialize(init.config, async () => true);
    writeWorkspaceSessionResponse({ type: 'ready', ok: true });
    const lines = readline.createInterface({ input: process.stdin });
    let previous = Promise.resolve();
    for await (const line of lines) {
      const command = JSON.parse(line) as WorkspaceSessionCommand;
      previous = previous.then(async () => {
        try {
          if (command.type === 'cleanup') {
            SandboxManager.cleanupAfterCommand();
            writeWorkspaceSessionResponse({
              id: command.id,
              type: 'result',
              ok: true,
            });
            return;
          }
          if (!command.request) throw new Error('Missing workspace wrap request.');
          const marker = command.request.targetStartedMarker
            ?? `\0KODAX_ASRT_TARGET_STARTED:${randomUUID()}\0\n`;
          const invocation = await wrapSandboxTarget(command.request, marker);
          writeWorkspaceSessionResponse({
            id: command.id,
            type: 'result',
            ok: true,
            invocation,
          });
        } catch (error: unknown) {
          writeWorkspaceSessionResponse({
            id: command.id,
            type: 'result',
            ok: false,
            error: errorText(error),
          });
        }
      });
    }
    await previous;
    await resetWorkspaceSessionSandboxManager();
    return 0;
  } catch (error: unknown) {
    try {
      writeWorkspaceSessionResponse({
        type: 'ready',
        ok: false,
        error: errorText(error),
      });
    } catch (responseError: unknown) {
      process.stderr.write(
        `ASRT workspace session could not report startup failure: ${errorText(responseError)}\n`,
      );
    }
    await resetSandboxManagerBestEffort();
    return 1;
  }
}
