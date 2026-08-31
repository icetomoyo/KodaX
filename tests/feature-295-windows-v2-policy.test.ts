import {
  execFile as execFileCallback,
  spawn,
  type ChildProcess,
} from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createConnection, createServer, type Server } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WINDOWS_PROXY_PORT_RANGE } from '@anthropic-ai/sandbox-runtime';

import {
  assertTrustedTextMutationPolicy,
  toolBash,
  toolEdit,
  toolInsertAfterAnchor,
  toolUndo,
  toolWrite,
  type KodaXToolExecutionContext,
} from '@kodax-ai/coding';
import { toolMultiEdit } from '../packages/coding/src/tools/multi-edit.js';

import {
  createAsrtShellSandbox,
  doctorSandboxRuntime,
  runKodaXSandboxed,
  setupSandboxRuntime,
  type KodaXSandboxRunResult,
} from '../src/sandbox-runtime.js';
import {
  ensureWindowsSandboxControlDirectory,
  repairWindowsSandboxControlDirectory,
  verifyWindowsSandboxControlDirectory,
  windowsNativeArtifactCacheRoot,
  windowsSandboxControlDirectory,
} from '../src/windows-native-artifacts.js';
import {
  createWindowsSandboxV2RunRequest,
  resolveWindowsSandboxV2Executable,
} from '../src/windows-sandbox-v2.js';
import { createWindowsTrustedTextMutationHost } from '../src/windows-text-transaction.js';

const execFile = promisify(execFileCallback);
const STATUS_DLL_INIT_FAILED = 0xc0000142;
const STATUS_DLL_INIT_FAILED_SIGNED = STATUS_DLL_INIT_FAILED | 0;

interface WindowsProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  readonly commandLine: string;
  readonly created: string;
}

interface SandboxProcessMarker {
  readonly targetPid: number;
  readonly runnerPid: number;
  readonly descendantPid: number;
}

interface RuntimeCompletion {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RuntimeLaunch {
  readonly child: ChildProcess;
  readonly completion: Promise<RuntimeCompletion>;
  readonly diagnostics: () => string;
}

type RuntimeProbeRecord =
  | { readonly kind: 'result'; readonly result: KodaXSandboxRunResult }
  | { readonly kind: 'error'; readonly message: string };

interface RuntimeRecoveryProbe {
  readonly readyPath: string;
  readonly stopPath: string;
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

async function createWindowsV2TestRoot(prefix: string): Promise<string> {
  const base = process.env.KODAX_NATIVE_TEST_TEMP
    ?? process.env.RUNNER_TEMP
    ?? os.tmpdir();
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, prefix));
}

async function populateWideWindowsTestTree(root: string, fileCount = 24_000): Promise<void> {
  const payloadRoot = path.join(root, 'wide-tree');
  const filesPerDirectory = 100;
  const directoryCount = Math.ceil(fileCount / filesPerDirectory);
  await mkdir(payloadRoot);
  await Promise.all(Array.from({ length: directoryCount }, (_value, index) => (
    mkdir(path.join(payloadRoot, `d-${index.toString().padStart(4, '0')}`))
  )));
  for (let start = 0; start < fileCount; start += 128) {
    const end = Math.min(start + 128, fileCount);
    await Promise.all(Array.from({ length: end - start }, (_value, offset) => {
      const index = start + offset;
      const directoryIndex = Math.floor(index / filesPerDirectory);
      return writeFile(
        path.join(
          payloadRoot,
          `d-${directoryIndex.toString().padStart(4, '0')}`,
          `f-${index.toString().padStart(5, '0')}`,
        ),
        '',
        'utf8',
      );
    }));
  }
}

async function protectPrivateTestDirectory(directory: string): Promise<void> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:KODAX_PRIVATE_TEST_PATH
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
[void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($current, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $propagation, $allow))
[void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, $propagation, $allow))
[IO.Directory]::SetAccessControl($path, $acl)
`;
  await execFile(windowsPowerShell(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    env: { ...process.env, KODAX_PRIVATE_TEST_PATH: directory },
    windowsHide: true,
  });
}

async function occupyLoopbackPort(port: number): Promise<Server | undefined> {
  const server = createServer();
  return new Promise<Server | undefined>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.close();
      if (error.code === 'EADDRINUSE') resolve(undefined);
      else reject(error);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error === undefined) resolve();
    else reject(error);
  }));
}

async function readControllerPipe(child: ChildProcess): Promise<string> {
  const stdout = child.stdout;
  if (stdout === null) throw new Error('Native controller stdout pipe was not created.');
  return new Promise<string>((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => finish(new Error('Native controller readiness timed out.')), 10_000);
    const finish = (error?: Error, value?: string): void => {
      clearTimeout(timer);
      stdout.off('data', onData);
      child.off('exit', onExit);
      if (error === undefined && value !== undefined) resolve(value);
      else reject(error ?? new Error('Native controller readiness was empty.'));
    };
    const onData = (chunk: Buffer | string): void => {
      buffered += chunk.toString();
      const newline = buffered.indexOf('\n');
      if (newline >= 0) finish(undefined, buffered.slice(0, newline).trim());
    };
    const onExit = (code: number | null): void => finish(new Error(
      `Native controller exited before readiness with code ${String(code)}.`,
    ));
    stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

async function connectHostPipe(pipeName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(pipeName);
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          if (error === undefined) resolve();
          else reject(error);
        };
        const timer = setTimeout(
          () => finish(new Error('Host controller-pipe connection timed out.')),
          Math.max(1, deadline - Date.now()),
        );
        socket.once('connect', () => finish());
        socket.once('error', finish);
      });
      return;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'ENOENT' && code !== 'EBUSY' && code !== 'EPIPE') || Date.now() >= deadline) {
        throw error;
      }
      await delay(10);
    }
  }
}

function assertExpectedWindowsPolicyWriteDenial(
  result: KodaXSandboxRunResult,
  expectedSentinel: string,
): void {
  if (result.status !== 'completed') {
    throw new Error(`Windows v2 smoke unavailable: ${JSON.stringify(result.doctor)}`);
  }
  if (
    result.exitCode === STATUS_DLL_INIT_FAILED
    || result.exitCode === STATUS_DLL_INIT_FAILED_SIGNED
  ) {
    throw new Error('Windows policy denial was masked by STATUS_DLL_INIT_FAILED (0xc0000142).');
  }
  if (result.exitCode !== 1 || !result.stderr.split(/\r?\n/).includes(expectedSentinel)) {
    throw new Error(
      `Windows policy B did not return the expected access-denied failure: ${JSON.stringify(result)}`,
    );
  }
}

describe('FEATURE_295 Windows policy smoke verdict', () => {
  const sentinel = 'KODAX_EXPECTED_POLICY_DENIAL:test-nonce';

  it.each([STATUS_DLL_INIT_FAILED, STATUS_DLL_INIT_FAILED_SIGNED])(
    'does not count loader failure exit %s as a policy denial',
    (exitCode) => {
      expect(() => assertExpectedWindowsPolicyWriteDenial({
        status: 'completed',
        sandboxed: true,
        exitCode,
        stdout: '',
        stderr: '',
      }, sentinel)).toThrow(/STATUS_DLL_INIT_FAILED/);
    },
  );

  it('accepts the intended Node access-denied failure', () => {
    expect(() => assertExpectedWindowsPolicyWriteDenial({
      status: 'completed',
      sandboxed: true,
      exitCode: 1,
      stdout: '',
      stderr: `${sentinel}\n`,
    }, sentinel)).not.toThrow();
  });

  it('does not invoke the synchronous PID identity probe on native Job control', async () => {
    const source = await readFile(
      new URL('../src/sandbox-runtime.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain(
      'nativeProcessControl !== undefined || child.pid === undefined',
    );
  });

  it.runIf(process.platform === 'win32')(
    'rejects SDK grants overlapping native shell control state before doctor or target launch',
    async () => {
      await expect(runKodaXSandboxed({
        command: process.env.ComSpec ?? String.raw`C:\Windows\System32\cmd.exe`,
        args: ['/d', '/s', '/c', 'exit 0'],
        cwd: process.cwd(),
        filesystem: {
          allowRead: [path.dirname(windowsSandboxControlDirectory())],
          allowWrite: [],
          denyRead: [],
          denyWrite: [],
        },
        network: { mode: 'deny' },
      })).rejects.toThrow(/protected native shell control state/);
      await expect(runKodaXSandboxed({
        command: process.env.ComSpec ?? String.raw`C:\Windows\System32\cmd.exe`,
        args: ['/d', '/s', '/c', 'exit 0'],
        cwd: process.cwd(),
        filesystem: {
          allowRead: [],
          allowWrite: [],
          denyRead: [],
          denyWrite: [windowsSandboxControlDirectory()],
        },
        network: { mode: 'deny' },
      })).rejects.toThrow(/deny policy targets protected native shell control state/);
    },
  );
});

function windowsPowerShell(): string {
  return path.join(
    process.env.SystemRoot ?? String.raw`C:\Windows`,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

async function windowsDaclIsProtected(file: string): Promise<boolean> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$acl = [IO.File]::GetAccessControl($env:KODAX_ACL_TEST_PATH)
[Console]::Out.Write($acl.AreAccessRulesProtected)
`;
  const { stdout } = await execFile(windowsPowerShell(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    env: { ...process.env, KODAX_ACL_TEST_PATH: file },
    windowsHide: true,
  });
  if (stdout.trim() === 'True') return true;
  if (stdout.trim() === 'False') return false;
  throw new Error(`Unexpected Windows DACL protection value: ${JSON.stringify(stdout)}`);
}

async function windowsDaclSddl(directory: string): Promise<string> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$acl = [IO.Directory]::GetAccessControl($env:KODAX_ACL_TEST_PATH)
[Console]::Out.Write($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access))
`;
  const { stdout } = await execFile(windowsPowerShell(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    env: { ...process.env, KODAX_ACL_TEST_PATH: directory },
    windowsHide: true,
  });
  return stdout.trim();
}

function parseWindowsProcess(value: unknown): WindowsProcessIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Windows process query returned a non-object row.');
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.pid !== 'number'
    || !Number.isSafeInteger(row.pid)
    || typeof row.parentPid !== 'number'
    || !Number.isSafeInteger(row.parentPid)
    || typeof row.name !== 'string'
    || typeof row.commandLine !== 'string'
    || typeof row.created !== 'string'
  ) {
    throw new Error(`Windows process query returned an invalid row: ${JSON.stringify(value)}`);
  }
  return {
    pid: row.pid,
    parentPid: row.parentPid,
    name: row.name,
    commandLine: row.commandLine,
    created: row.created,
  };
}

async function queryWindowsProcesses(filter: string): Promise<readonly WindowsProcessIdentity[]> {
  const script = String.raw`& {
  $ErrorActionPreference = 'Stop'
  $Filter = $env:KODAX_TEST_PROCESS_FILTER
  $rows = @(
    Get-CimInstance Win32_Process -Filter $Filter | ForEach-Object {
      [pscustomobject]@{
        pid = [int]$_.ProcessId
        parentPid = [int]$_.ParentProcessId
        name = [string]$_.Name
        commandLine = [string]$_.CommandLine
        created = if ($null -eq $_.CreationDate) { '' } else { $_.CreationDate.ToUniversalTime().Ticks.ToString() }
      }
    }
  )
  ConvertTo-Json -InputObject $rows -Compress
}`;
  const { stdout } = await execFile(windowsPowerShell(), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, KODAX_TEST_PROCESS_FILTER: filter },
  });
  const parsed: unknown = JSON.parse(stdout.trim() || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).map(parseWindowsProcess);
}

async function queryWindowsProcessIds(
  processIds: readonly number[],
): Promise<readonly WindowsProcessIdentity[]> {
  const unique = [...new Set(processIds)];
  if (unique.length === 0) return [];
  if (unique.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error(`Cannot query invalid Windows process IDs: ${unique.join(', ')}`);
  }
  return queryWindowsProcesses(unique.map((pid) => `ProcessId = ${pid}`).join(' OR '));
}

function parseSandboxProcessMarker(value: unknown): SandboxProcessMarker {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sandbox process marker was not an object.');
  }
  const marker = value as Record<string, unknown>;
  for (const field of ['targetPid', 'runnerPid', 'descendantPid'] as const) {
    if (typeof marker[field] !== 'number' || !Number.isSafeInteger(marker[field]) || marker[field] <= 0) {
      throw new Error(`Sandbox process marker contained an invalid ${field}.`);
    }
  }
  return {
    targetPid: marker.targetPid as number,
    runnerPid: marker.runnerPid as number,
    descendantPid: marker.descendantPid as number,
  };
}

async function waitForSandboxProcessMarker(
  markerPath: string,
  runtime: RuntimeLaunch,
): Promise<SandboxProcessMarker> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      return parseSandboxProcessMarker(JSON.parse(await readFile(markerPath, 'utf8')) as unknown);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(`Sandbox Runtime exited before its target became ready: ${runtime.diagnostics()}`);
    }
    await delay(50);
  }
  throw new Error(`Sandbox target did not publish its process marker: ${runtime.diagnostics()}`);
}

async function waitForNativeHost(
  runtimePid: number,
  runtime: RuntimeLaunch,
): Promise<WindowsProcessIdentity> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const children = await queryWindowsProcesses(`ParentProcessId = ${runtimePid}`);
    const host = children.find((candidate) => (
      candidate.name.toLowerCase() === 'kodax-windows-sandbox.exe'
      && /(?:^|[\s"])__host(?:[\s"]|$)/i.test(candidate.commandLine)
    ));
    if (host !== undefined) return host;
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(`Sandbox Runtime exited before host discovery: ${runtime.diagnostics()}`);
    }
    await delay(100);
  }
  throw new Error(`Native sandbox host was not found below Runtime ${runtimePid}: ${runtime.diagnostics()}`);
}

async function waitForNativeController(
  runtimePid: number,
  runtime: RuntimeLaunch,
): Promise<{ readonly broker: WindowsProcessIdentity; readonly controller: WindowsProcessIdentity }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const children = await queryWindowsProcesses(`ParentProcessId = ${runtimePid}`);
    const brokers = children.filter((candidate) => (
      /sandbox-network-broker(?:-entry\.ts|\.js)(?:[\s"]|$)/i.test(candidate.commandLine)
    ));
    for (const broker of brokers) {
      const descendants = await queryWindowsProcesses(`ParentProcessId = ${broker.pid}`);
      const controller = descendants.find((candidate) => (
        candidate.name.toLowerCase() === 'kodax-windows-sandbox.exe'
        && /(?:^|[\s"])__controller(?:[\s"]|$)/i.test(candidate.commandLine)
      ));
      if (controller !== undefined) return { broker, controller };
    }
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(`Sandbox Runtime exited before controller discovery: ${runtime.diagnostics()}`);
    }
    await delay(100);
  }
  throw new Error(
    `Native sandbox controller was not found below Runtime ${runtimePid}: ${runtime.diagnostics()}`,
  );
}

function sameProcess(left: WindowsProcessIdentity, right: WindowsProcessIdentity): boolean {
  return left.pid === right.pid && left.created === right.created;
}

async function terminateExactProcess(identity: WindowsProcessIdentity): Promise<void> {
  const current = (await queryWindowsProcessIds([identity.pid]))[0];
  if (current === undefined || !sameProcess(current, identity)) {
    throw new Error(`Windows process ${identity.pid} exited before the requested termination.`);
  }
  try {
    process.kill(identity.pid, 'SIGKILL');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    if (code !== 'EPERM') throw error;
    const script = String.raw`& {
  $ErrorActionPreference = 'Stop'
  $pidValue = [int]$env:KODAX_TEST_TERMINATE_PID
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue"
  if ($null -eq $process) { throw 'process disappeared before CIM termination' }
  $result = Invoke-CimMethod -InputObject $process -MethodName Terminate
  if ([int]$result.ReturnValue -ne 0) { throw "CIM termination returned $($result.ReturnValue)" }
}`;
    await execFile(windowsPowerShell(), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      timeout: 10_000,
      env: { ...process.env, KODAX_TEST_TERMINATE_PID: String(identity.pid) },
    });
  }
}

async function waitForExactProcessesToExit(
  identities: readonly WindowsProcessIdentity[],
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let remaining = identities;
  while (Date.now() < deadline) {
    const live = await queryWindowsProcessIds(remaining.map((identity) => identity.pid));
    remaining = remaining.filter((identity) => live.some((candidate) => sameProcess(candidate, identity)));
    if (remaining.length === 0) return;
    await delay(100);
  }
  throw new Error(`Sandbox processes did not drain: ${remaining.map((identity) => (
    `${identity.name}:${identity.pid} parent=${identity.parentPid} argv=${identity.commandLine}`
  )).join(', ')}`);
}

async function terminateIfStillExact(identity: WindowsProcessIdentity | undefined): Promise<void> {
  if (identity === undefined) return;
  const current = (await queryWindowsProcessIds([identity.pid]))[0];
  if (current !== undefined && sameProcess(current, identity)) await terminateExactProcess(identity);
}

function launchSandboxRuntime(
  root: string,
  markerPath: string,
  recovery?: RuntimeRecoveryProbe,
  denyRead: readonly string[] = [],
): RuntimeLaunch {
  const sandboxRuntimeUrl = new URL('../src/sandbox-runtime.ts', import.meta.url).href;
  const targetScript = [
    'const fs=require("node:fs")',
    'const {spawn}=require("node:child_process")',
    'const descendant=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true})',
    'if(!descendant.pid) process.exit(71)',
    'fs.writeFileSync(process.argv[1],JSON.stringify({targetPid:process.pid,runnerPid:process.ppid,descendantPid:descendant.pid}))',
    'setInterval(()=>{},1000)',
  ].join(';');
  const runtimeScript = [
    `import { runKodaXSandboxed } from ${JSON.stringify(sandboxRuntimeUrl)}`,
    'const decode=value=>JSON.parse(Buffer.from(value,"base64url").toString("utf8"))',
    'const encode=value=>Buffer.from(JSON.stringify(value)).toString("base64url")',
    'const run=async input=>{try{return {kind:"result",result:await runKodaXSandboxed(input)}}catch(error){return {kind:"error",message:error instanceof Error?error.message:String(error)}}}',
    'const first=await run(decode(process.argv[1]))',
    'if(process.argv[2]===undefined){process.stdout.write("TERMINAL:"+encode(first))}else{process.stdout.write("FIRST:"+encode(first)+"\\n");const second=await run(decode(process.argv[2]));process.stdout.write("SECOND:"+encode(second))}',
  ].join(';');
  const request = Buffer.from(JSON.stringify({
    command: process.execPath,
    args: ['-e', targetScript, markerPath],
    cwd: root,
    filesystem: { allowRead: [root], allowWrite: [root], denyRead, denyWrite: [] },
    network: { mode: 'allow' },
    timeoutMs: 60_000,
    inheritEnvironment: true,
  }), 'utf8').toString('base64url');
  const recoveryScript = [
    'const fs=require("node:fs")',
    'fs.writeFileSync(process.argv[1],"ready")',
    'const wait=new Int32Array(new SharedArrayBuffer(4))',
    'const deadline=Date.now()+20000',
    'while(!fs.existsSync(process.argv[2])&&Date.now()<deadline) Atomics.wait(wait,0,0,25)',
    'if(!fs.existsSync(process.argv[2])) process.exit(41)',
  ].join(';');
  const recoveryRequest = recovery === undefined
    ? undefined
    : Buffer.from(JSON.stringify({
        command: process.execPath,
        args: ['-e', recoveryScript, recovery.readyPath, recovery.stopPath],
        cwd: root,
        filesystem: { allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [] },
        network: { mode: 'allow' },
        timeoutMs: 30_000,
        inheritEnvironment: true,
      }), 'utf8').toString('base64url');
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      runtimeScript,
      request,
      ...(recoveryRequest === undefined ? [] : [recoveryRequest]),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
  const completion = new Promise<RuntimeCompletion>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return {
    child,
    completion,
    diagnostics: () => JSON.stringify({ stdout, stderr }),
  };
}

function decodeRuntimeProbeRecord(output: string, prefix: 'FIRST' | 'SECOND'): RuntimeProbeRecord {
  const encoded = new RegExp(`${prefix}:([A-Za-z0-9_-]+)`).exec(output)?.[1];
  if (encoded === undefined) {
    throw new Error(`Sandbox Runtime omitted its ${prefix.toLowerCase()} record: ${output}`);
  }
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
  if (value === null || typeof value !== 'object') {
    throw new Error(`Sandbox Runtime returned an invalid ${prefix.toLowerCase()} record.`);
  }
  const kind = Reflect.get(value, 'kind');
  if (kind === 'error' && typeof Reflect.get(value, 'message') === 'string') {
    return { kind, message: Reflect.get(value, 'message') as string };
  }
  const result = Reflect.get(value, 'result');
  if (kind === 'result' && result !== null && typeof result === 'object') {
    return { kind, result: result as KodaXSandboxRunResult };
  }
  throw new Error(`Sandbox Runtime returned an invalid ${prefix.toLowerCase()} outcome.`);
}

async function waitForRecoveryReady(file: string, runtime: RuntimeLaunch): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await stat(file);
      return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(`Sandbox Runtime exited before its recovery target: ${runtime.diagnostics()}`);
    }
    await delay(50);
  }
  throw new Error(`Sandbox Runtime recovery target did not become ready: ${runtime.diagnostics()}`);
}

async function waitForRuntimeCompletion(runtime: RuntimeLaunch): Promise<RuntimeCompletion> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      runtime.completion,
      new Promise<RuntimeCompletion>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(
          `Sandbox Runtime did not settle after process termination: ${runtime.diagnostics()}`,
        )), 20_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

const realWindowsV2 = process.platform === 'win32'
  && process.env.KODAX_REAL_WINDOWS_SANDBOX_V2 === '1';

describe.runIf(realWindowsV2)('FEATURE_295 real Windows policy isolation', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          await rm(root, { force: true, recursive: true });
          return;
        } catch (error: unknown) {
          const code = (error as NodeJS.ErrnoException).code;
          if ((code !== 'EBUSY' && code !== 'EPERM') || attempt === 19) throw error;
          await delay(100);
        }
      }
    }));
  });

  it('starts an inbox Windows command under the restricted target token', async () => {
    const parent = await createWindowsV2TestRoot('kodax-v2-loader-parent-');
    roots.push(parent);
    const root = await mkdtemp(path.join(parent, 'workspace-'));
    const parentDacl = await windowsDaclSddl(parent);
    const command = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
    const result = await runKodaXSandboxed({
      command,
      args: ['/d', '/s', '/c', 'exit 0'],
      cwd: root,
      filesystem: { allowRead: [], allowWrite: [root], denyRead: [], denyWrite: [] },
      network: { mode: 'allow' },
      timeoutMs: 15_000,
      inheritEnvironment: true,
    });

    if (result.status !== 'completed' || result.exitCode !== 0) {
      throw new Error(`Windows restricted target loader failed: ${JSON.stringify(result)}`);
    }
    expect(result).toMatchObject({ status: 'completed', sandboxed: true, exitCode: 0 });
    expect(await windowsDaclSddl(parent)).toBe(parentDacl);
  }, 45_000);

  it('lets every trusted text tool replace a file created by the sandbox account', async () => {
    const root = await createWindowsV2TestRoot('kodax-v2-sandbox-owned-text-');
    roots.push(root);
    const target = path.join(root, 'sandbox-owned.md');
    const createResult = await runKodaXSandboxed({
      command: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "sandbox-owned")', target],
      cwd: root,
      filesystem: { allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [] },
      network: { mode: 'deny' },
      timeoutMs: 30_000,
      inheritEnvironment: true,
    });
    expect(createResult).toMatchObject({ status: 'completed', sandboxed: true, exitCode: 0 });

    const textHost = createWindowsTrustedTextMutationHost(
      () => [root],
      assertTrustedTextMutationPolicy,
    );
    const context: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: root,
      gitRoot: root,
      trustedTextMutationHost: textHost,
    };
    await expect(toolWrite({ path: target, content: 'trusted-host' }, context))
      .resolves.toContain('File updated');
    await expect(toolEdit({
      path: target,
      old_string: 'trusted-host',
      new_string: 'trusted-edit',
    }, context)).resolves.toContain('File edited');
    await expect(toolMultiEdit({
      path: target,
      edits: [{ old_string: 'trusted-edit', new_string: 'trusted-anchor' }],
    }, context)).resolves.toContain('File edited');
    await expect(toolInsertAfterAnchor({
      path: target,
      anchor: 'trusted-anchor',
      content: 'trusted-insert',
    }, context)).resolves.toContain('Content inserted');
    await expect(readFile(target, 'utf8')).resolves.toBe('trusted-anchor\ntrusted-insert');
    await expect(toolUndo({}, context)).resolves.toContain('Restored');
    await expect(readFile(target, 'utf8')).resolves.toBe('trusted-anchor');
  }, 60_000);

  it('self-heals a sandbox-owned file with stale inherited ACLs without disabling inheritance', async () => {
    const parent = await createWindowsV2TestRoot('kodax-v2-stale-inherited-text-');
    roots.push(parent);
    const sourceRoot = path.join(parent, 'source');
    const targetRoot = path.join(parent, 'target');
    await Promise.all([mkdir(sourceRoot), mkdir(targetRoot)]);
    const source = path.join(sourceRoot, 'sandbox-owned.md');
    const target = path.join(targetRoot, 'sandbox-owned.md');
    const createResult = await runKodaXSandboxed({
      command: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "sandbox-owned")', source],
      cwd: sourceRoot,
      filesystem: {
        allowRead: [sourceRoot], allowWrite: [sourceRoot], denyRead: [], denyWrite: [],
      },
      network: { mode: 'deny' },
      timeoutMs: 30_000,
      inheritEnvironment: true,
    });
    expect(createResult).toMatchObject({ status: 'completed', sandboxed: true, exitCode: 0 });
    await execFile('icacls.exe', [source, '/setintegritylevel', 'L'], {
      windowsHide: true,
    });
    await rename(source, target);
    expect(await windowsDaclIsProtected(target)).toBe(false);

    const textHost = createWindowsTrustedTextMutationHost(
      () => [targetRoot],
      assertTrustedTextMutationPolicy,
    );
    const context: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: targetRoot,
      gitRoot: targetRoot,
      trustedTextMutationHost: textHost,
    };
    await expect(toolWrite({ path: target, content: 'trusted-host' }, context))
      .resolves.toContain('File updated');
    await expect(readFile(target, 'utf8')).resolves.toBe('trusted-host');
    expect(await windowsDaclIsProtected(target)).toBe(false);
  }, 60_000);

  it('reaches private read/write roots without exposing their parent or siblings', async () => {
    const parent = await createWindowsV2TestRoot('kodax-v2-private-parent-');
    roots.push(parent);
    await protectPrivateTestDirectory(parent);
    const parentDacl = await windowsDaclSddl(parent);
    const workspace = path.join(parent, 'workspace');
    const readOnly = path.join(parent, 'read-only');
    const sibling = path.join(parent, 'sibling');
    await Promise.all([mkdir(workspace), mkdir(readOnly), mkdir(sibling)]);
    await Promise.all([
      writeFile(path.join(readOnly, 'allowed.txt'), 'read-only-ok', 'utf8'),
      writeFile(path.join(sibling, 'secret.txt'), 'sibling-secret', 'utf8'),
    ]);
    const probe = [
      'const fs=require("node:fs")',
      'const path=require("node:path")',
      'const [workspace,readOnly,parent,sibling]=process.argv.slice(1)',
      'if(!fs.statSync(workspace).isDirectory()) process.exit(61)',
      'if(fs.readFileSync(path.join(readOnly,"allowed.txt"),"utf8")!=="read-only-ok") process.exit(62)',
      'fs.writeFileSync(path.join(workspace,"written.txt"),"workspace-ok")',
      'const denied=(operation)=>{try{operation();return false}catch(error){return error&&["EACCES","EPERM"].includes(error.code)}}',
      'if(!denied(()=>fs.readdirSync(parent))) process.exit(63)',
      'if(!denied(()=>fs.readFileSync(path.join(sibling,"secret.txt")))) process.exit(64)',
      'if(!denied(()=>fs.writeFileSync(path.join(sibling,"escape.txt"),"escape"))) process.exit(65)',
      'process.stdout.write("private-parent-policy-ok")',
    ].join(';');
    const result = await runKodaXSandboxed({
      command: process.execPath,
      args: ['-e', probe, workspace, readOnly, parent, sibling],
      cwd: workspace,
      filesystem: {
        allowRead: [workspace, readOnly],
        allowWrite: [workspace],
        denyRead: [],
        denyWrite: [],
      },
      network: { mode: 'deny' },
      timeoutMs: 30_000,
      inheritEnvironment: true,
    });

    if (result.status !== 'completed') {
      throw new Error(`Private-parent policy smoke unavailable: ${JSON.stringify(result)}`);
    }
    expect(result).toMatchObject({
      status: 'completed',
      sandboxed: true,
      exitCode: 0,
      stdout: 'private-parent-policy-ok',
    });
    await expect(readFile(path.join(workspace, 'written.txt'), 'utf8')).resolves.toBe('workspace-ok');
    await expect(stat(path.join(sibling, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await windowsDaclSddl(parent)).toBe(parentDacl);
  }, 60_000);

  it('fails closed on unsupported denyRead before target start or DACL mutation', async () => {
    const root = await createWindowsV2TestRoot('kodax-v2-deny-read-');
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    const secret = path.join(root, 'secret');
    await Promise.all([mkdir(workspace), mkdir(secret)]);
    await writeFile(path.join(secret, 'value.txt'), 'host-only-secret', 'utf8');
    const secretDacl = await windowsDaclSddl(secret);
    const probe = [
      'const fs=require("node:fs")',
      'const path=require("node:path")',
      'const [workspace,secret]=process.argv.slice(1)',
      'fs.writeFileSync(path.join(workspace,"allowed.txt"),"allowed")',
      'try{fs.readFileSync(path.join(secret,"value.txt"));process.exit(71)}catch(error){if(!error||!["EACCES","EPERM"].includes(error.code))throw error}',
      'process.stdout.write("deny-read-ok")',
    ].join(';');
    const result = await runKodaXSandboxed({
      command: process.execPath,
      args: ['-e', probe, workspace, secret],
      cwd: workspace,
      filesystem: {
        allowRead: [root],
        allowWrite: [workspace],
        denyRead: [secret],
        denyWrite: [],
      },
      network: { mode: 'deny' },
      timeoutMs: 30_000,
      inheritEnvironment: true,
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      sandboxed: false,
      reason: 'unsupported_policy',
      diagnostic: expect.stringContaining('denyRead is unsupported'),
    });
    await expect(stat(path.join(workspace, 'allowed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await windowsDaclSddl(secret)).toBe(secretDacl);
  }, 60_000);

  it('keeps the shared controller pipe host-only under restricted connection pressure', async () => {
    const root = await createWindowsV2TestRoot('kodax-v2-controller-acl-');
    roots.push(root);
    const shell = resolveWindowsSandboxV2Executable();
    const controller = spawn(shell.path, ['__controller', String(process.pid)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const controllerCompletion = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => controller.once('close', (code, signal) => resolve({ code, signal })));
    let controllerStderr = '';
    controller.stderr?.on('data', (chunk: Buffer | string) => {
      controllerStderr += chunk.toString();
    });
    try {
      const controllerPipe = await readControllerPipe(controller);
      expect(controllerPipe).toMatch(/^\\\\\.\\pipe\\kodax-v2-\d+-[0-9a-f-]{36}$/i);
      await Promise.all(Array.from({ length: 16 }, () => connectHostPipe(controllerPipe)));

      const pressureScript = [
        'const net=require("node:net")',
        'const pipe=process.argv[1]',
        'let pending=64,connected=0',
        'const finish=()=>{if(--pending===0){process.stdout.write(String(connected));process.exit(connected===0?0:42)}}',
        'for(let i=0;i<64;i+=1){',
        ' const socket=net.createConnection(pipe)',
        ' const timer=setTimeout(()=>{socket.destroy();finish()},2000)',
        ' socket.once("connect",()=>{clearTimeout(timer);connected+=1;socket.destroy();finish()})',
        ' socket.once("error",()=>{clearTimeout(timer);finish()})',
        '}',
      ].join(';');
      const pressure = await runKodaXSandboxed({
        command: process.execPath,
        args: ['-e', pressureScript, controllerPipe],
        cwd: root,
        filesystem: { allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [] },
        network: { mode: 'deny' },
        timeoutMs: 30_000,
        inheritEnvironment: true,
      });
      if (pressure.status !== 'completed') {
        throw new Error(`Restricted controller pressure was unavailable: ${JSON.stringify(pressure)}`);
      }
      expect(pressure).toMatchObject({
        status: 'completed', sandboxed: true, exitCode: 0, stdout: '0',
      });
      await Promise.all(Array.from({ length: 16 }, () => connectHostPipe(controllerPipe)));
    } finally {
      controller.stdin?.end();
      const completion = await controllerCompletion;
      if (completion.code !== 0) {
        throw new Error(
          `Native controller cleanup failed: ${JSON.stringify({ ...completion, controllerStderr })}`,
        );
      }
    }
  }, 60_000);

  it('keeps control state host-only and native host rejects a forged overlapping grant', async () => {
    const root = await createWindowsV2TestRoot('kodax-v2-control-boundary-');
    roots.push(root);
    const shell = resolveWindowsSandboxV2Executable();
    const control = ensureWindowsSandboxControlDirectory();
    const secret = path.join(control, `host-secret-${randomUUID()}.txt`);
    const marker = path.join(root, 'target-started.txt');
    const requestPath = path.join(control, `windows-shell-${process.pid}-${randomUUID()}.json`);
    const terminalPath = path.join(control, `windows-terminal-${process.pid}-${randomUUID()}.json`);
    const denyRequestPath = path.join(control, `windows-shell-${process.pid}-${randomUUID()}.json`);
    const denyTerminalPath = path.join(control, `windows-terminal-${process.pid}-${randomUUID()}.json`);
    const setupMarkerPath = path.join(windowsNativeArtifactCacheRoot(), 'windows-v2-cutover.json');
    const setupMarkerSha256 = createHash('sha256')
      .update(await readFile(setupMarkerPath))
      .digest('hex');
    await writeFile(secret, 'host-only-secret', { flag: 'wx' });
    try {
      const denied = await runKodaXSandboxed({
        command: process.execPath,
        args: ['-e', 'require("node:fs").readFileSync(process.argv[1])', secret],
        cwd: root,
        filesystem: { allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [] },
        network: { mode: 'deny' },
        timeoutMs: 30_000,
        inheritEnvironment: true,
      });
      expect(denied).toMatchObject({ status: 'completed', sandboxed: true });
      if (denied.status !== 'completed') throw new Error('Expected a completed access-denied probe.');
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stdout).not.toContain('host-only-secret');

      const request = createWindowsSandboxV2RunRequest({
        generation: 'control-boundary-test',
        filesystemCapabilityNonce: '00000000-0000-4000-8000-000000000003',
        sandboxUserSid: 'S-1-5-21-1-2-3-1001',
        sandboxGroupSid: 'S-1-5-21-1-2-3-1002',
        asrtInvocation: {
          executable: process.env.ComSpec ?? String.raw`C:\Windows\System32\cmd.exe`,
          prefixArgs: ['exec', '--'],
          targetArgv: [],
          childEnvironment: {},
        },
        targetArgv: [
          process.execPath,
          '-e',
          'require("node:fs").writeFileSync(process.argv[1],"started")',
          marker,
        ],
        cwd: root,
        allowRead: [path.dirname(control)],
        allowWrite: [root],
        denyRead: [],
        denyWrite: [],
        controllerPipe: String.raw`\\.\pipe\kodax-v2-${process.pid}-${randomUUID()}`,
        terminalRecordPath: terminalPath,
        terminalNonce: randomUUID(),
        operationDeadlineUnixMs: Date.now() + 30_000,
        setupMarkerPath,
        setupMarkerSha256,
      });
      await writeFile(requestPath, JSON.stringify(request), { flag: 'wx' });
      let nativeFailure: unknown;
      try {
        await execFile(shell.path, ['__host', requestPath], {
          cwd: control,
          timeout: 30_000,
          windowsHide: true,
        });
      } catch (error: unknown) {
        nativeFailure = error;
      }
      expect(nativeFailure).toBeDefined();
      expect(String((nativeFailure as { readonly stderr?: unknown }).stderr ?? nativeFailure))
        .toMatch(/overlaps protected native shell control state/);
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });

      const denyRequest = createWindowsSandboxV2RunRequest({
        generation: 'control-deny-boundary-test',
        filesystemCapabilityNonce: '00000000-0000-4000-8000-000000000003',
        sandboxUserSid: 'S-1-5-21-1-2-3-1001',
        sandboxGroupSid: 'S-1-5-21-1-2-3-1002',
        asrtInvocation: {
          executable: process.env.ComSpec ?? String.raw`C:\Windows\System32\cmd.exe`,
          prefixArgs: ['exec', '--'],
          targetArgv: [],
          childEnvironment: {},
        },
        targetArgv: [process.execPath, '-e', 'process.exit(91)'],
        cwd: root,
        allowRead: [root],
        allowWrite: [root],
        denyRead: [],
        denyWrite: [control],
        controllerPipe: String.raw`\\.\pipe\kodax-v2-${process.pid}-${randomUUID()}`,
        terminalRecordPath: denyTerminalPath,
        terminalNonce: randomUUID(),
        operationDeadlineUnixMs: Date.now() + 30_000,
        setupMarkerPath,
        setupMarkerSha256,
      });
      await writeFile(denyRequestPath, JSON.stringify(denyRequest), { flag: 'wx' });
      let denyFailure: unknown;
      try {
        await execFile(shell.path, ['__host', denyRequestPath], {
          cwd: control,
          timeout: 30_000,
          windowsHide: true,
        });
      } catch (error: unknown) {
        denyFailure = error;
      }
      expect(String((denyFailure as { readonly stderr?: unknown }).stderr ?? denyFailure))
        .toMatch(/deny policy targets protected native shell control state/);
      expect(verifyWindowsSandboxControlDirectory()).toBe(control);
      const subsequent = await runKodaXSandboxed({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("after-control-deny-ok")'],
        cwd: root,
        filesystem: { allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [] },
        network: { mode: 'deny' },
        timeoutMs: 30_000,
        inheritEnvironment: true,
      });
      expect(subsequent).toMatchObject({
        status: 'completed', sandboxed: true, exitCode: 0, stdout: 'after-control-deny-ok',
      });
    } finally {
      await Promise.all([
        rm(secret, { force: true }),
        rm(requestPath, { force: true }),
        rm(terminalPath, { force: true }),
        rm(denyRequestPath, { force: true }),
        rm(denyTerminalPath, { force: true }),
      ]);
    }
  }, 90_000);

  it('keeps doctor verify-only and setup retires dead request/staging creators before control repair', async () => {
    const control = ensureWindowsSandboxControlDirectory();
    const staleRequest = path.join(
      control,
      `windows-shell-4294967294-${randomUUID()}.json`,
    );
    const liveRequest = path.join(
      control,
      `windows-shell-${process.pid}-${randomUUID()}.json`,
    );
    const staleStartedStage = path.join(
      control,
      `windows-started-${process.pid}-${randomUUID()}.4294967294.${'a'.repeat(32)}.tmp`,
    );
    const staleDenyStage = path.join(
      control,
      `windows-deny-${randomUUID()}.4294967294.${'b'.repeat(32)}.tmp`,
    );
    const liveDenyStage = path.join(
      control,
      `windows-deny-${randomUUID()}.${process.pid}.${'c'.repeat(32)}.tmp`,
    );
    const staleWarmupLog = path.join(
      control,
      `windows-read-warmup-4294967294-${randomUUID()}.log`,
    );
    const corruption = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:KODAX_CONTROL_TEST_PATH
$acl = [IO.Directory]::GetAccessControl($path)
$users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [Security.AccessControl.FileSystemAccessRule]::new($users, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
[IO.Directory]::SetAccessControl($path, $acl)
`;
    try {
      await writeFile(staleRequest, JSON.stringify({ operationDeadlineUnixMs: 1 }), {
        flag: 'wx',
      });
      await writeFile(liveRequest, JSON.stringify({ operationDeadlineUnixMs: 1 }), {
        flag: 'wx',
      });
      await Promise.all([
        writeFile(staleStartedStage, '{}', { flag: 'wx' }),
        writeFile(staleDenyStage, '{}', { flag: 'wx' }),
        writeFile(liveDenyStage, '{}', { flag: 'wx' }),
        writeFile(staleWarmupLog, '', { flag: 'wx' }),
      ]);
      const staleTime = new Date(Date.now() - 120_000);
      await Promise.all([
        utimes(staleStartedStage, staleTime, staleTime),
        utimes(staleDenyStage, staleTime, staleTime),
        utimes(liveDenyStage, staleTime, staleTime),
      ]);
      await execFile(windowsPowerShell(), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(corruption, 'utf16le').toString('base64'),
      ], {
        env: { ...process.env, KODAX_CONTROL_TEST_PATH: control },
        windowsHide: true,
      });
      const before = await doctorSandboxRuntime({ refresh: true });
      expect(before).toMatchObject({ ready: false, setupRequired: true });
      expect(() => verifyWindowsSandboxControlDirectory()).toThrow(/exact|unexpected|host\/SYSTEM/i);

      await expect(setupSandboxRuntime()).rejects.toThrow(
        /control state verification and setup repair both failed/i,
      );
      await expect(stat(staleRequest)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(staleStartedStage)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(staleDenyStage)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(staleWarmupLog)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(liveRequest)).resolves.toBeDefined();
      await expect(stat(liveDenyStage)).resolves.toBeDefined();
      await rm(liveRequest, { force: true });

      await expect(setupSandboxRuntime()).rejects.toThrow(
        /control state verification and setup repair both failed/i,
      );
      await expect(stat(liveDenyStage)).resolves.toBeDefined();
      await rm(liveDenyStage, { force: true });

      const repaired = await setupSandboxRuntime();
      expect(repaired).toMatchObject({ ready: true, setupRequired: false });
      expect(verifyWindowsSandboxControlDirectory()).toBe(control);
    } finally {
      await Promise.all([
        rm(staleRequest, { force: true }),
        rm(liveRequest, { force: true }),
        rm(staleStartedStage, { force: true }),
        rm(staleDenyStage, { force: true }),
        rm(liveDenyStage, { force: true }),
        rm(staleWarmupLog, { force: true }),
      ].map(async (cleanup) => cleanup.catch(() => undefined)));
      try {
        verifyWindowsSandboxControlDirectory();
      } catch {
        repairWindowsSandboxControlDirectory();
      }
    }
  }, 360_000);

  it('returns the original timeout only after the native Job and descendants drain', async () => {
    const root = await createWindowsV2TestRoot('kodax-v2-timeout-drain-');
    roots.push(root);
    const markerPath = path.join(root, 'processes.json');
    const targetScript = [
      'const fs=require("node:fs")',
      'const {spawn}=require("node:child_process")',
      'const descendant=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true})',
      'if(!descendant.pid) process.exit(71)',
      'fs.writeFileSync(process.argv[1],JSON.stringify({targetPid:process.pid,runnerPid:process.ppid,descendantPid:descendant.pid}))',
      'setInterval(()=>{},1000)',
    ].join(';');
    const running = runKodaXSandboxed({
      command: process.execPath,
      args: ['-e', targetScript, markerPath],
      cwd: root,
      filesystem: { allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [] },
      network: { mode: 'allow' },
      timeoutMs: 10_000,
      inheritEnvironment: true,
    });
    void running.catch(() => undefined);

    const markerDeadline = Date.now() + 20_000;
    let marker: SandboxProcessMarker | undefined;
    while (marker === undefined && Date.now() < markerDeadline) {
      try {
        marker = parseSandboxProcessMarker(JSON.parse(await readFile(markerPath, 'utf8')) as unknown);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
          throw error;
        }
        await delay(50);
      }
    }
    if (marker === undefined) throw new Error('Timed sandbox target did not publish its process marker.');
    const identities = await queryWindowsProcessIds([
      marker.targetPid,
      marker.runnerPid,
      marker.descendantPid,
    ]);
    expect(identities).toHaveLength(3);

    await expect(running).rejects.toThrow(/exceeded its .* ms timeout/i);
    await waitForExactProcessesToExit(identities);

    const subsequent = await runKodaXSandboxed({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("after-timeout-ok")'],
      cwd: root,
      filesystem: { allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [] },
      network: { mode: 'allow' },
      timeoutMs: 30_000,
      inheritEnvironment: true,
    });
    expect(subsequent).toMatchObject({
      status: 'completed', sandboxed: true, exitCode: 0, stdout: 'after-timeout-ok',
    });
  }, 60_000);

  it('returns the original cancellation only after the native Job and descendants drain', async () => {
    const root = await createWindowsV2TestRoot('kodax-v2-cancel-drain-');
    roots.push(root);
    const markerPath = path.join(root, 'processes.json');
    const targetScript = [
      'const fs=require("node:fs")',
      'const {spawn}=require("node:child_process")',
      'const descendant=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true})',
      'if(!descendant.pid) process.exit(71)',
      'fs.writeFileSync(process.argv[1],JSON.stringify({targetPid:process.pid,runnerPid:process.ppid,descendantPid:descendant.pid}))',
      'setInterval(()=>{},1000)',
    ].join(';');
    const controller = new AbortController();
    const running = runKodaXSandboxed({
      command: process.execPath,
      args: ['-e', targetScript, markerPath],
      cwd: root,
      filesystem: { allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [] },
      network: { mode: 'allow' },
      timeoutMs: 30_000,
      inheritEnvironment: true,
      signal: controller.signal,
    });
    void running.catch(() => undefined);

    const markerDeadline = Date.now() + 20_000;
    let marker: SandboxProcessMarker | undefined;
    while (marker === undefined && Date.now() < markerDeadline) {
      try {
        marker = parseSandboxProcessMarker(JSON.parse(await readFile(markerPath, 'utf8')) as unknown);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
          throw error;
        }
        await delay(50);
      }
    }
    if (marker === undefined) throw new Error('Cancelled sandbox target did not publish its process marker.');
    const identities = await queryWindowsProcessIds([
      marker.targetPid,
      marker.runnerPid,
      marker.descendantPid,
    ]);
    expect(identities).toHaveLength(3);

    controller.abort(new Error('injected native cancellation'));
    await expect(running).rejects.toThrow('injected native cancellation');
    await waitForExactProcessesToExit(identities);
  }, 60_000);

  it('allows policy A in A but denies policy B from writing A', async () => {
    const parent = await createWindowsV2TestRoot('kodax-v2-policy-ab-');
    roots.push(parent);
    await protectPrivateTestDirectory(parent);
    const rootA = path.join(parent, 'A');
    const rootB = path.join(parent, 'B');
    await Promise.all([mkdir(rootA), mkdir(rootB)]);
    const owned = path.join(rootA, 'owned.txt');
    const escape = path.join(rootA, 'escape.txt');
    const policyBMarker = path.join(rootB, 'policy-b-reached.txt');
    const policyDenialSentinel = `KODAX_EXPECTED_POLICY_DENIAL:${randomUUID()}`;
    const run = (allowWrite: string, target: string, content: string) => runKodaXSandboxed({
      command: process.execPath,
      args: [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], process.argv[2])',
        target,
        content,
      ],
      cwd: allowWrite,
      filesystem: { allowRead: [], allowWrite: [allowWrite], denyRead: [], denyWrite: [] },
      network: { mode: 'allow' },
      timeoutMs: 15_000,
      inheritEnvironment: true,
    });

    const policyA = await run(rootA, owned, 'A_OK');
    if (policyA.status !== 'completed') {
      throw new Error(`Windows v2 smoke unavailable: ${JSON.stringify(policyA.doctor)}`);
    }
    expect(policyA).toMatchObject({ status: 'completed', sandboxed: true, exitCode: 0 });
    await expect(readFile(owned, 'utf8')).resolves.toBe('A_OK');

    const policyB = await runKodaXSandboxed({
      command: process.execPath,
      args: [
        '-e',
        [
          'const fs=require("node:fs")',
          'fs.writeFileSync(process.argv[1],"B_SELF_OK")',
          'try {',
          '  fs.writeFileSync(process.argv[2],"B_ESCAPE")',
          '  process.exit(42)',
          '} catch(error) {',
          '  if(error && (error.code==="EACCES" || error.code==="EPERM") && error.path===process.argv[2]) {',
          '    process.stderr.write(process.argv[3]+"\\n")',
          '    process.exit(1)',
          '  }',
          '  throw error',
          '}',
        ].join(';'),
        policyBMarker,
        escape,
        policyDenialSentinel,
      ],
      cwd: rootB,
      filesystem: { allowRead: [], allowWrite: [rootB], denyRead: [], denyWrite: [] },
      network: { mode: 'allow' },
      timeoutMs: 15_000,
      inheritEnvironment: true,
    });
    assertExpectedWindowsPolicyWriteDenial(policyB, policyDenialSentinel);
    await expect(readFile(policyBMarker, 'utf8')).resolves.toBe('B_SELF_OK');
    await expect(stat(escape)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 45_000);

  it.each([
    ['the exact same write root', 'same-root'],
    ['an ancestor read plus a child write root', 'ancestor-read-child-write'],
  ] as const)('starts two cold Runtime processes with %s and keeps the first active', async (
    _label,
    scenario,
  ) => {
    const parent = await createWindowsV2TestRoot('kodax-v2-policy-concurrent-');
    roots.push(parent);
    const rootA = path.join(parent, 'A');
    const rootB = path.join(parent, 'B');
    await Promise.all([mkdir(rootA), mkdir(rootB)]);
    const readyA = path.join(rootA, 'ready');
    const readyB = path.join(rootB, 'ready');
    const verifyA = path.join(rootA, 'verify');
    const verifiedA = path.join(rootA, 'verified');
    const releaseA = path.join(rootA, 'release');
    const sandboxRuntimeUrl = new URL('../src/sandbox-runtime.ts', import.meta.url).href;
    const targetScript = [
      'const fs=require("node:fs")',
      'fs.writeFileSync(process.argv[1],"ready")',
      'const wait=new Int32Array(new SharedArrayBuffer(4))',
      'const verify=process.argv[2]',
      'const verified=process.argv[3]',
      'const release=process.argv[4]',
      'if(verify){',
      '  const deadline=Date.now()+120000',
      '  while(!fs.existsSync(verify)&&Date.now()<deadline) Atomics.wait(wait,0,0,25)',
      '  if(!fs.existsSync(verify)) process.exit(40)',
      '  fs.writeFileSync(verified,"still-writable")',
      '}',
      'if(release){',
      '  const deadline=Date.now()+120000',
      '  while(!fs.existsSync(release)&&Date.now()<deadline) Atomics.wait(wait,0,0,25)',
      '  if(!fs.existsSync(release)) process.exit(41)',
      '}',
      'process.stdout.write("target-ready")',
    ].join(';');
    const runtimeScript = [
      `import { runKodaXSandboxed } from ${JSON.stringify(sandboxRuntimeUrl)}`,
      'const input=JSON.parse(Buffer.from(process.argv[1],"base64url").toString("utf8"))',
      'const result=await runKodaXSandboxed(input)',
      'process.stdout.write(JSON.stringify(result))',
    ].join(';');
    const runRuntime = async (
      root: string,
      ownReady: string,
      verify: string,
      verified: string,
      release: string,
      writeRoot: string,
    ) => {
      const request = Buffer.from(JSON.stringify({
        command: process.execPath,
        args: ['-e', targetScript, ownReady, verify, verified, release],
        cwd: root,
        filesystem: {
          allowRead: [parent],
          allowWrite: [writeRoot],
          denyRead: [],
          denyWrite: [],
        },
        network: { mode: 'allow' },
        timeoutMs: release.length > 0 ? 130_000 : 20_000,
        inheritEnvironment: true,
      }), 'utf8').toString('base64url');
      const { stdout } = await execFile(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', runtimeScript, request],
        { cwd: process.cwd(), env: process.env, timeout: 140_000, maxBuffer: 1024 * 1024 },
      );
      return JSON.parse(stdout) as {
        readonly status: string;
        readonly sandboxed?: boolean;
        readonly exitCode?: number;
        readonly stdout?: string;
        readonly doctor?: unknown;
      };
    };

    let holderSettled = false;
    const policyAPromise = runRuntime(
      rootA,
      readyA,
      verifyA,
      verifiedA,
      releaseA,
      parent,
    ).finally(() => {
      holderSettled = true;
    });
    let policyBOutcome: Promise<{ result: Awaited<ReturnType<typeof runRuntime>> } | { error: unknown }>
      | undefined;
    let primaryFailure: unknown;
    try {
      const readyDeadline = Date.now() + 30_000;
      while (Date.now() < readyDeadline) {
        try {
          await stat(readyA);
          break;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (holderSettled) {
          try {
            const earlyResult = await policyAPromise;
            throw new Error(
              `The first Runtime exited before its target became ready: ${JSON.stringify(earlyResult)}`,
            );
          } catch (error: unknown) {
            throw new AggregateError(
              [error],
              'The first Runtime failed before its target became ready.',
            );
          }
        }
        await delay(25);
      }
      await expect(stat(readyA)).resolves.toBeDefined();

      const policyBStartedAt = Date.now();
      const policyBWriteRoot = scenario === 'same-root' ? parent : rootB;
      policyBOutcome = runRuntime(rootB, readyB, '', '', '', policyBWriteRoot).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      const policyB = await policyBOutcome;
      if ('error' in policyB) throw policyB.error;
      const policyBElapsedMs = Date.now() - policyBStartedAt;
      expect(holderSettled).toBe(false);
      expect(policyBElapsedMs).toBeLessThan(15_000);
      expect(policyB.result).toMatchObject({
        status: 'completed',
        sandboxed: true,
        exitCode: 0,
        stdout: 'target-ready',
      });
      await writeFile(verifyA, 'verify', 'utf8');
      const verifyDeadline = Date.now() + 15_000;
      while (Date.now() < verifyDeadline) {
        try {
          await stat(verifiedA);
          break;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (holderSettled) break;
        await delay(25);
      }
      await expect(readFile(verifiedA, 'utf8')).resolves.toBe('still-writable');
    } catch (error: unknown) {
      primaryFailure = error;
    } finally {
      await writeFile(releaseA, 'release', 'utf8');
      if (policyBOutcome !== undefined) await policyBOutcome;
    }

    let policyA: Awaited<typeof policyAPromise> | undefined;
    let holderFailure: unknown;
    try {
      policyA = await policyAPromise;
    } catch (error: unknown) {
      holderFailure = error;
    }
    if (primaryFailure !== undefined && holderFailure !== undefined) {
      throw new AggregateError(
        [primaryFailure, holderFailure],
        'Both Windows v2 concurrent Runtime paths failed.',
      );
    }
    if (holderFailure !== undefined) throw holderFailure;
    if (primaryFailure !== undefined) throw primaryFailure;
    if (policyA === undefined) throw new Error('The first Runtime returned no result.');
    for (const result of [policyA]) {
      if (result.status !== 'completed') {
        throw new Error(`Windows v2 concurrent smoke unavailable: ${JSON.stringify(result.doctor)}`);
      }
      expect(result).toMatchObject({
        status: 'completed',
        sandboxed: true,
        exitCode: 0,
      });
      expect(result.stdout).toContain('target-ready');
    }
  }, 180_000);

  it.each([
    ['the exact same write root', 'same-root'],
    ['an ancestor read plus child write roots', 'ancestor-read-child-write'],
  ] as const)('starts two truly cold Runtime processes against a 24k-entry tree with %s', async (
    _label,
    scenario,
  ) => {
    const cutoverValue: unknown = JSON.parse(await readFile(
      path.join(windowsNativeArtifactCacheRoot(), 'windows-v2-cutover.json'),
      'utf8',
    ));
    if (
      cutoverValue === null
      || typeof cutoverValue !== 'object'
      || typeof Reflect.get(cutoverValue, 'sandboxGroupSid') !== 'string'
    ) {
      throw new Error('Windows v2 cutover marker omitted the sandbox group SID.');
    }
    resolveWindowsSandboxV2Executable({
      sandboxReadSid: Reflect.get(cutoverValue, 'sandboxGroupSid') as string,
      provision: true,
    });
    const parent = await createWindowsV2TestRoot('kodax-v2-policy-cold-24k-');
    roots.push(parent);
    await protectPrivateTestDirectory(parent);
    const rootA = scenario === 'same-root' ? parent : path.join(parent, 'A');
    const rootB = scenario === 'same-root' ? parent : path.join(parent, 'B');
    if (scenario !== 'same-root') await Promise.all([mkdir(rootA), mkdir(rootB)]);
    await populateWideWindowsTestTree(parent);
    const gate = path.join(parent, 'release-runtime-admission');
    const releaseA = path.join(parent, 'release-runtime-a');
    const runtimeReadyA = path.join(parent, 'runtime-a-ready');
    const runtimeReadyB = path.join(parent, 'runtime-b-ready');
    const outputA = path.join(rootA, 'output-a.txt');
    const outputB = path.join(rootB, 'output-b.txt');
    const sandboxRuntimeUrl = new URL('../src/sandbox-runtime.ts', import.meta.url).href;
    const runtimeScript = [
      'import fs from "node:fs"',
      `import { runKodaXSandboxed } from ${JSON.stringify(sandboxRuntimeUrl)}`,
      'const ready=process.argv[1]',
      'const gate=process.argv[2]',
      'const request=JSON.parse(Buffer.from(process.argv[3],"base64url").toString("utf8"))',
      'fs.writeFileSync(ready,"ready")',
      'const wait=new Int32Array(new SharedArrayBuffer(4))',
      'const deadline=Date.now()+30000',
      'while(!fs.existsSync(gate)&&Date.now()<deadline) Atomics.wait(wait,0,0,10)',
      'if(!fs.existsSync(gate)) throw new Error("cold admission gate timed out")',
      'const result=await runKodaXSandboxed(request)',
      'process.stdout.write(JSON.stringify(result))',
    ].join(';');
    const targetScript = [
      'const fs=require("node:fs")',
      'fs.writeFileSync(process.argv[1],process.argv[2])',
      'const release=process.argv[3]',
      'if(release){',
      '  const wait=new Int32Array(new SharedArrayBuffer(4))',
      '  const deadline=Date.now()+120000',
      '  while(!fs.existsSync(release)&&Date.now()<deadline) Atomics.wait(wait,0,0,10)',
      '  if(!fs.existsSync(release)) process.exit(42)',
      '}',
    ].join(';');
    const request = (
      cwd: string,
      output: string,
      content: string,
      release: string,
    ) => Buffer.from(JSON.stringify({
      command: process.execPath,
      args: ['-e', targetScript, output, content, release],
      cwd,
      filesystem: {
        allowRead: scenario === 'same-root' ? [] : [parent],
        allowWrite: [cwd],
        denyRead: [],
        denyWrite: [],
      },
      network: { mode: 'allow' },
      timeoutMs: release.length > 0 ? 130_000 : 20_000,
      inheritEnvironment: true,
    }), 'utf8').toString('base64url');
    const launch = (
      ready: string,
      cwd: string,
      output: string,
      content: string,
      release: string,
    ) => execFile(
      process.execPath,
      [
        '--import', 'tsx', '--input-type=module', '-e', runtimeScript,
        ready, gate, request(cwd, output, content, release),
      ],
      { cwd: process.cwd(), env: process.env, timeout: 140_000, maxBuffer: 1024 * 1024 },
    );

    let runtimeASettled = false;
    const runtimeA = launch(runtimeReadyA, rootA, outputA, 'A', releaseA).finally(() => {
      runtimeASettled = true;
    });
    const runtimeB = launch(runtimeReadyB, rootB, outputB, 'B', '');
    const readyDeadline = Date.now() + 15_000;
    while (Date.now() < readyDeadline) {
      const observations = await Promise.all([runtimeReadyA, runtimeReadyB].map(async (file) => {
        try {
          await stat(file);
          return true;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      }));
      if (observations.every(Boolean)) break;
      await delay(10);
    }
    await expect(Promise.all([stat(runtimeReadyA), stat(runtimeReadyB)])).resolves.toBeDefined();

    let completionB: Awaited<typeof runtimeB> | undefined;
    let completionA: Awaited<typeof runtimeA> | undefined;
    let primaryFailure: unknown;
    try {
      const releasedAt = Date.now();
      await writeFile(gate, 'release', 'utf8');
      completionB = await runtimeB;
      expect(Date.now() - releasedAt).toBeLessThan(15_000);
      if (runtimeASettled) {
        const early = await runtimeA;
        throw new Error(
          `The first cold Runtime settled before the second completed: stdout=${JSON.stringify(early.stdout)} stderr=${JSON.stringify(early.stderr)}`,
        );
      }
      const outputDeadline = Date.now() + 15_000;
      while (Date.now() < outputDeadline) {
        try {
          await stat(outputA);
          break;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (runtimeASettled) break;
        await delay(10);
      }
      if (runtimeASettled) {
        const early = await runtimeA;
        throw new Error(
          `The first cold Runtime settled before release: stdout=${JSON.stringify(early.stdout)} stderr=${JSON.stringify(early.stderr)}`,
        );
      }
      await expect(readFile(outputA, 'utf8')).resolves.toBe('A');
      await expect(readFile(outputB, 'utf8')).resolves.toBe('B');
    } catch (error: unknown) {
      primaryFailure = error;
    } finally {
      await writeFile(releaseA, 'release', 'utf8');
      completionA = await runtimeA;
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (completionA === undefined || completionB === undefined) {
      throw new Error('Cold Runtime completion was unavailable.');
    }
    const results = [completionA, completionB].map((completion) => JSON.parse(
      completion.stdout,
    ) as KodaXSandboxRunResult);
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'completed',
        sandboxed: true,
        exitCode: 0,
      });
    }
  }, 180_000);

  it('keeps real background Bash, a second Runtime Bash, and trusted text writes concurrent', async () => {
    const parent = await createWindowsV2TestRoot('kodax-v2-tool-bash-concurrent-');
    roots.push(parent);
    const holderRoot = path.join(parent, 'holder');
    const workerRoot = path.join(parent, 'worker');
    await Promise.all([mkdir(holderRoot), mkdir(workerRoot)]);
    const holderScript = path.join(holderRoot, 'holder.cjs');
    const holderReady = path.join(holderRoot, 'ready');
    const holderStop = path.join(holderRoot, 'stop');
    const target = path.join(workerRoot, 'hello.md');
    await Promise.all([
      writeFile(holderScript, [
        'const fs=require("node:fs")',
        'fs.writeFileSync(process.argv[2],"ready")',
        'const wait=new Int32Array(new SharedArrayBuffer(4))',
        'const deadline=Date.now()+120000',
        'while(!fs.existsSync(process.argv[3])&&Date.now()<deadline) Atomics.wait(wait,0,0,25)',
        'if(!fs.existsSync(process.argv[3])) process.exit(41)',
        'process.stdout.write("BACKGROUND_DONE")',
      ].join(';'), 'utf8'),
      writeFile(target, 'before', 'utf8'),
    ]);

    const holderSandbox = createAsrtShellSandbox({
      workspaceRoot: holderRoot,
      shouldSandbox: () => true,
    });
    const holderResult = await toolBash({
      command: `"${process.execPath}" "${holderScript}" "${holderReady}" "${holderStop}"`,
      run_in_background: true,
      timeout: 130,
    }, {
      backups: new Map(),
      executionCwd: holderRoot,
      gitRoot: holderRoot,
      toolCallId: 'real-background-holder',
      shellSandbox: holderSandbox,
    });
    expect(holderResult).toContain('Command started in background');
    const holderOutput = /Output:\s*(.+)/.exec(holderResult)?.[1]?.trim();
    if (holderOutput === undefined) throw new Error(`Missing background output path: ${holderResult}`);

    const readyDeadline = Date.now() + 15_000;
    while (Date.now() < readyDeadline) {
      try {
        await stat(holderReady);
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await delay(25);
    }
    await expect(stat(holderReady)).resolves.toBeDefined();

    const bashUrl = new URL('../packages/coding/src/tools/bash.ts', import.meta.url).href;
    const sandboxUrl = new URL('../src/sandbox-runtime.ts', import.meta.url).href;
    const workerScript = [
      `import { toolBash } from ${JSON.stringify(bashUrl)}`,
      `import { createAsrtShellSandbox } from ${JSON.stringify(sandboxUrl)}`,
      'const input=JSON.parse(Buffer.from(process.argv[1],"base64url").toString("utf8"))',
      'const observations=[]',
      'const result=await toolBash({command:input.command,timeout:30},{',
      'backups:new Map(),executionCwd:input.root,gitRoot:input.root,',
      'toolCallId:"second-runtime-bash",',
      'shellSandbox:createAsrtShellSandbox({workspaceRoot:input.root,shouldSandbox:()=>true}),',
      'reportToolSandboxObservation:(observation)=>observations.push(observation)',
      '})',
      'process.stdout.write(JSON.stringify({result,observations}))',
    ].join('\n');
    const workerInput = Buffer.from(JSON.stringify({
      root: workerRoot,
      command: `del /f /q "${target}" && echo SECOND_RUNTIME_OK`,
    }), 'utf8').toString('base64url');

    let primaryFailure: unknown;
    try {
      const workerStartedAt = Date.now();
      const { stdout } = await execFile(process.execPath, [
        '--import', 'tsx', '--input-type=module', '-e', workerScript, workerInput,
      ], {
        cwd: process.cwd(),
        env: process.env,
        timeout: 45_000,
        maxBuffer: 1024 * 1024,
      });
      const workerElapsedMs = Date.now() - workerStartedAt;
      const worker = JSON.parse(stdout) as {
        readonly result: string;
        readonly observations: readonly { readonly state?: string }[];
      };
      expect(workerElapsedMs).toBeLessThan(15_000);
      expect(worker.result).toContain('SECOND_RUNTIME_OK');
      expect(worker.observations.some((item) => item.state === 'applied')).toBe(true);
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });

      const textHost = createWindowsTrustedTextMutationHost(
        () => [workerRoot],
        assertTrustedTextMutationPolicy,
      );
      const textContext: KodaXToolExecutionContext = {
        backups: new Map(),
        executionCwd: workerRoot,
        gitRoot: workerRoot,
        trustedTextMutationHost: textHost,
      };
      const writeStartedAt = Date.now();
      await expect(toolWrite({ path: target, content: 'after' }, textContext))
        .resolves.toContain('File created');
      expect(Date.now() - writeStartedAt).toBeLessThan(15_000);
      await expect(readFile(target, 'utf8')).resolves.toBe('after');
      expect(await readFile(holderOutput, 'utf8')).not.toContain('[Exit:');
    } catch (error: unknown) {
      primaryFailure = error;
    } finally {
      await writeFile(holderStop, 'stop', 'utf8');
    }

    const footerDeadline = Date.now() + 30_000;
    let holderLog = '';
    while (Date.now() < footerDeadline) {
      holderLog = await readFile(holderOutput, 'utf8').catch(() => '');
      if (holderLog.includes('[Exit:')) break;
      await delay(25);
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    expect(holderLog).toContain('BACKGROUND_DONE');
    expect(holderLog).toContain('[Exit: 0]');
  }, 180_000);

  it('shares one same-policy proxy when fixed Windows proxy ports are under pressure', async () => {
    const root = await createWindowsV2TestRoot('kodax-v2-shared-proxy-');
    roots.push(root);
    await delay(1_200);
    const [firstProxyPort] = DEFAULT_WINDOWS_PROXY_PORT_RANGE;
    const occupied = await Promise.all(
      [firstProxyPort, firstProxyPort + 1, firstProxyPort + 2].map(occupyLoopbackPort),
    );
    const ownedServers = occupied.filter((server): server is Server => server !== undefined);
    const targetScript = [
      'const fs=require("node:fs")',
      'fs.writeFileSync(process.argv[1],"ready")',
      'const wait=new Int32Array(new SharedArrayBuffer(4))',
      'const deadline=Date.now()+15000',
      'while(fs.readdirSync(process.argv[2]).filter(name=>name.startsWith("ready-")).length<4&&Date.now()<deadline) Atomics.wait(wait,0,0,25)',
      'if(fs.readdirSync(process.argv[2]).filter(name=>name.startsWith("ready-")).length<4) process.exit(41)',
      'process.stdout.write("shared-proxy-ready")',
    ].join(';');
    try {
      const results = await Promise.all(Array.from({ length: 4 }, (_, index) => (
        runKodaXSandboxed({
          command: process.execPath,
          args: ['-e', targetScript, path.join(root, `ready-${index}`), root],
          cwd: root,
          filesystem: { allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [] },
          network: { mode: 'allow' },
          timeoutMs: 25_000,
          inheritEnvironment: true,
        })
      )));
      for (const result of results) {
        expect(result).toMatchObject({
          status: 'completed',
          sandboxed: true,
          exitCode: 0,
          stdout: 'shared-proxy-ready',
        });
      }
    } finally {
      await Promise.all(ownedServers.map(closeServer));
    }
  }, 60_000);

  it('fails concurrent denyRead policies closed without starting targets or writing receipts', async () => {
    const root = await createWindowsV2TestRoot('kodax-v2-concurrent-deny-read-');
    roots.push(root);
    const deniedRoots = await Promise.all(Array.from({ length: 15 }, async (_, index) => {
      const denied = path.join(root, `denied-${index}`);
      await mkdir(denied);
      await writeFile(path.join(denied, 'secret.txt'), 'secret', 'utf8');
      return denied;
    }));
    const secret = path.join(deniedRoots[0]!, 'secret.txt');
    const deniedDacl = await windowsDaclSddl(deniedRoots[0]!);
    const receiptsBefore = (await readdir(windowsSandboxControlDirectory()))
      .filter((name) => name.startsWith('windows-deny-') && name.endsWith('.json'))
      .sort();
    const targetScript = [
      'const fs=require("node:fs")',
      'fs.writeFileSync(process.argv[1],"ready")',
      'const wait=new Int32Array(new SharedArrayBuffer(4))',
      'const deadline=Date.now()+15000',
      'while(fs.readdirSync(process.argv[2]).filter(name=>name.startsWith("ready-")).length<4&&Date.now()<deadline) Atomics.wait(wait,0,0,25)',
      'if(fs.readdirSync(process.argv[2]).filter(name=>name.startsWith("ready-")).length<4) process.exit(41)',
      'try{fs.readFileSync(process.argv[3]);process.exit(74)}catch(error){if(!error||!["EACCES","EPERM"].includes(error.code))throw error}',
      'process.stdout.write("deny-read-held")',
    ].join(';');
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => (
      runKodaXSandboxed({
        command: process.execPath,
        args: ['-e', targetScript, path.join(root, `ready-${index}`), root, secret],
        cwd: root,
        filesystem: {
          allowRead: [root], allowWrite: [root], denyRead: deniedRoots, denyWrite: [],
        },
        network: { mode: 'allow' },
        timeoutMs: 90_000,
        inheritEnvironment: true,
      })
    )));
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'unavailable',
        sandboxed: false,
        reason: 'unsupported_policy',
      });
    }
    for (let index = 0; index < 4; index += 1) {
      await expect(stat(path.join(root, `ready-${index}`))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await windowsDaclSddl(deniedRoots[0]!)).toBe(deniedDacl);
    const receiptsAfter = (await readdir(windowsSandboxControlDirectory()))
      .filter((name) => name.startsWith('windows-deny-') && name.endsWith('.json'))
      .sort();
    expect(receiptsAfter).toEqual(receiptsBefore);
  }, 180_000);

  it('keeps every trusted text tool available while a different-file shell stays alive', async () => {
    const root = await createWindowsV2TestRoot('kodax-v2-shell-write-');
    roots.push(root);
    const ready = path.join(root, 'shell.ready');
    const stop = path.join(root, 'shell.stop');
    const written = path.join(root, 'written-by-tool.md');
    const targetScript = [
      'const fs=require("node:fs")',
      'fs.writeFileSync(process.argv[1],"ready")',
      'const wait=new Int32Array(new SharedArrayBuffer(4))',
      'const deadline=Date.now()+20000',
      'while(!fs.existsSync(process.argv[2])&&Date.now()<deadline) Atomics.wait(wait,0,0,25)',
      'if(!fs.existsSync(process.argv[2])) process.exit(41)',
    ].join(';');
    const shellRun = runKodaXSandboxed({
      command: process.execPath,
      args: ['-e', targetScript, ready, stop],
      cwd: root,
      filesystem: { allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [] },
      network: { mode: 'deny' },
      timeoutMs: 30_000,
      inheritEnvironment: true,
    });
    let earlyResult: Awaited<typeof shellRun> | undefined;
    let earlyFailure: unknown;
    void shellRun.then(
      (result) => { earlyResult = result; },
      (error: unknown) => { earlyFailure = error; },
    );
    try {
      const readyDeadline = Date.now() + 10_000;
      while (Date.now() < readyDeadline) {
        try {
          await stat(ready);
          break;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (earlyFailure !== undefined) throw earlyFailure;
        if (earlyResult !== undefined) {
          throw new Error(`Windows v2 background shell smoke unavailable: ${JSON.stringify(earlyResult)}`);
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      await expect(stat(ready)).resolves.toBeDefined();

      const textHost = createWindowsTrustedTextMutationHost(
        () => [root],
        assertTrustedTextMutationPolicy,
      );
      const ctx: KodaXToolExecutionContext = {
        backups: new Map(),
        executionCwd: root,
        gitRoot: root,
        trustedTextMutationHost: textHost,
      };
      await expect(toolWrite({ path: written, content: 'hello' }, ctx))
        .resolves.toContain('File created');
      await expect(toolEdit({
        path: written,
        old_string: 'hello',
        new_string: 'edited',
      }, ctx)).resolves.toContain('File edited');
      await expect(toolMultiEdit({
        path: written,
        edits: [{ old_string: 'edited', new_string: 'anchor' }],
      }, ctx)).resolves.toContain('File edited');
      await expect(toolInsertAfterAnchor({
        path: written,
        anchor: 'anchor',
        content: 'inserted',
      }, ctx)).resolves.toContain('Content inserted');
      await expect(readFile(written, 'utf8')).resolves.toBe('anchor\ninserted');
      await expect(toolUndo({}, ctx)).resolves.toContain('Restored');
      await expect(readFile(written, 'utf8')).resolves.toBe('anchor');
    } finally {
      await writeFile(stop, 'stop', 'utf8');
      await Promise.allSettled([shellRun]);
    }
    const shellResult = await shellRun;
    expect(shellResult).toMatchObject({ status: 'completed', sandboxed: true, exitCode: 0 });
  }, 60_000);

  it.each(['target', 'runner', 'host'] as const)(
    'drains the real sandbox Job after terminating its %s and keeps trusted Write available',
    async (terminatedRole) => {
      const root = await createWindowsV2TestRoot(`kodax-v2-kill-${terminatedRole}-`);
      roots.push(root);
      const markerPath = path.join(root, 'processes.json');
      const written = path.join(root, `after-${terminatedRole}.md`);
      const executionReceiptsBefore = terminatedRole === 'host'
        ? (await readdir(windowsSandboxControlDirectory()))
            .filter((name) => name.startsWith('windows-deny-') && name.endsWith('.json'))
            .sort()
        : [];
      const runtime = launchSandboxRuntime(
        root,
        markerPath,
        undefined,
        [],
      );
      let runtimeSettled = false;
      let tracked: readonly WindowsProcessIdentity[] = [];
      try {
        const runtimePid = runtime.child.pid;
        if (runtimePid === undefined) throw new Error('Sandbox Runtime did not expose a PID.');
        const marker = await waitForSandboxProcessMarker(markerPath, runtime);
        const host = await waitForNativeHost(runtimePid, runtime);
        const observed = await queryWindowsProcessIds([
          marker.targetPid,
          marker.runnerPid,
          marker.descendantPid,
        ]);
        const requireIdentity = (pid: number, label: string): WindowsProcessIdentity => {
          const identity = observed.find((candidate) => candidate.pid === pid);
          if (identity === undefined || identity.created === '') {
            throw new Error(`Cannot attest the live sandbox ${label} process ${pid}.`);
          }
          return identity;
        };
        const target = requireIdentity(marker.targetPid, 'target');
        const runner = requireIdentity(marker.runnerPid, 'runner');
        const descendant = requireIdentity(marker.descendantPid, 'descendant');
        expect(target.parentPid).toBe(runner.pid);
        expect(descendant.parentPid).toBe(target.pid);
        expect(runner.name.toLowerCase()).toBe('kodax-windows-sandbox.exe');
        expect(host.created).not.toBe('');
        tracked = [target, descendant, runner, host];

        const selected = terminatedRole === 'target'
          ? target
          : terminatedRole === 'runner'
            ? runner
            : host;
        await terminateExactProcess(selected);
        await waitForExactProcessesToExit(tracked);
        const completion = await waitForRuntimeCompletion(runtime);
        runtimeSettled = true;
        expect(completion).toMatchObject({ code: 0, signal: null });
        expect(completion.stdout).toContain('TERMINAL:');

        const textHost = createWindowsTrustedTextMutationHost(
          () => [root],
          assertTrustedTextMutationPolicy,
        );
        const ctx: KodaXToolExecutionContext = {
          backups: new Map(),
          executionCwd: root,
          gitRoot: root,
          trustedTextMutationHost: textHost,
        };
        await expect(toolWrite({ path: written, content: `after ${terminatedRole}` }, ctx))
          .resolves.toContain('File created');
        await expect(readFile(written, 'utf8')).resolves.toBe(`after ${terminatedRole}`);

        if (terminatedRole === 'host') {
          const receiptsAfterCrash = (await readdir(windowsSandboxControlDirectory()))
            .filter((name) => name.startsWith('windows-deny-') && name.endsWith('.json'))
            .sort();
          expect(receiptsAfterCrash).toEqual(executionReceiptsBefore);
          const subsequent = await runKodaXSandboxed({
            command: process.execPath,
            args: ['-e', 'process.stdout.write("subsequent")'],
            cwd: root,
            filesystem: {
              allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [],
            },
            network: { mode: 'allow' },
            timeoutMs: 15_000,
            inheritEnvironment: true,
          });
          expect(subsequent).toMatchObject({
            status: 'completed', sandboxed: true, exitCode: 0, stdout: 'subsequent',
          });
          const receiptsAfterSubsequentRun = (await readdir(windowsSandboxControlDirectory()))
            .filter((name) => name.startsWith('windows-deny-') && name.endsWith('.json'))
            .sort();
          expect(receiptsAfterSubsequentRun).toEqual(executionReceiptsBefore);
        }
      } finally {
        for (const identity of [...tracked].reverse()) {
          await terminateIfStillExact(identity);
        }
        if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
          runtime.child.kill('SIGKILL');
        }
        if (!runtimeSettled) await waitForRuntimeCompletion(runtime);
      }
    },
    120_000,
  );

  it('fails closed on controller loss, drains the active Job, and recreates a broker', async () => {
    const root = await createWindowsV2TestRoot('kodax-v2-kill-controller-');
    roots.push(root);
    const markerPath = path.join(root, 'processes.json');
    const recoveryReady = path.join(root, 'recovery.ready');
    const recoveryStop = path.join(root, 'recovery.stop');
    const runtime = launchSandboxRuntime(root, markerPath, {
      readyPath: recoveryReady,
      stopPath: recoveryStop,
    });
    let runtimeSettled = false;
    let tracked: readonly WindowsProcessIdentity[] = [];
    try {
      const runtimePid = runtime.child.pid;
      if (runtimePid === undefined) throw new Error('Sandbox Runtime did not expose a PID.');
      const marker = await waitForSandboxProcessMarker(markerPath, runtime);
      const host = await waitForNativeHost(runtimePid, runtime);
      const { broker, controller } = await waitForNativeController(runtimePid, runtime);
      const observed = await queryWindowsProcessIds([
        marker.targetPid,
        marker.runnerPid,
        marker.descendantPid,
      ]);
      const requireIdentity = (pid: number, label: string): WindowsProcessIdentity => {
        const identity = observed.find((candidate) => candidate.pid === pid);
        if (identity === undefined || identity.created === '') {
          throw new Error(`Cannot attest the live sandbox ${label} process ${pid}.`);
        }
        return identity;
      };
      tracked = [
        requireIdentity(marker.targetPid, 'target'),
        requireIdentity(marker.descendantPid, 'descendant'),
        requireIdentity(marker.runnerPid, 'runner'),
        host,
        controller,
        broker,
      ];

      await terminateExactProcess(controller);
      await waitForExactProcessesToExit(tracked);
      await waitForRecoveryReady(recoveryReady, runtime);
      const replacement = await waitForNativeController(runtimePid, runtime);
      const replacementHost = await waitForNativeHost(runtimePid, runtime);
      expect(sameProcess(replacement.broker, broker)).toBe(false);
      expect(sameProcess(replacement.controller, controller)).toBe(false);
      expect(sameProcess(replacementHost, host)).toBe(false);
      const replacementProcesses = [
        replacementHost,
        replacement.controller,
        replacement.broker,
      ];
      tracked = [...tracked, ...replacementProcesses];
      await writeFile(recoveryStop, 'stop', 'utf8');
      const completion = await waitForRuntimeCompletion(runtime);
      runtimeSettled = true;
      expect(completion).toMatchObject({ code: 0, signal: null });
      const first = decodeRuntimeProbeRecord(completion.stdout, 'FIRST');
      if (first.kind === 'result') {
        expect(first.result).toMatchObject({ status: 'completed', sandboxed: true });
        expect(first.result.exitCode).not.toBe(0);
      } else {
        expect(first).toMatchObject({ kind: 'error' });
      }
      expect(decodeRuntimeProbeRecord(completion.stdout, 'SECOND')).toMatchObject({
        kind: 'result',
        result: { status: 'completed', sandboxed: true, exitCode: 0 },
      });
      await waitForExactProcessesToExit(replacementProcesses);
    } finally {
      for (const identity of [...tracked].reverse()) {
        await terminateIfStillExact(identity);
      }
      if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
        runtime.child.kill('SIGKILL');
      }
      if (!runtimeSettled) await waitForRuntimeCompletion(runtime);
    }
  }, 120_000);

  it('does not let a restricted shell open host text or ACL namespaces', async () => {
    const root = await createWindowsV2TestRoot('kodax-v2-private-namespace-');
    roots.push(root);
    const target = path.join(root, 'initialize.txt');
    const textHost = createWindowsTrustedTextMutationHost(
      () => [root],
      assertTrustedTextMutationPolicy,
    );
    const observed = await textHost.snapshot({
      path: target,
      createParentDirectories: false,
    });
    await expect(textHost.commit({
      path: target,
      expectedRevision: observed.revision,
      content: 'namespace initialized',
      createParentDirectories: false,
    })).resolves.toMatchObject({ status: 'written' });

    const system32 = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32');
    const { stdout: whoami } = await execFile(
      path.join(system32, 'whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
    );
    const hostSid = /"(S-\d+(?:-\d+)+)"\s*$/m.exec(whoami)?.[1];
    if (hostSid === undefined) throw new Error(`Cannot resolve host SID: ${whoami}`);

    const probeExecutable = path.join(root, 'namespace-probe.exe');
    await execFile(process.env.RUSTC ?? 'rustc', [
      path.resolve('tests/fixtures/windows-private-namespace-probe.rs'),
      '--edition=2021',
      '-O',
      '-o',
      probeExecutable,
    ]);

    const result = await runKodaXSandboxed({
      command: probeExecutable,
      args: [
        hostSid,
        'KodaX-TextTx-Boundary-v2',
        'KodaXTextTxV2',
        'KodaX-Sandbox-ACL-Boundary-v2',
        'KodaXSandboxAclV2',
      ],
      cwd: root,
      filesystem: { allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [] },
      network: { mode: 'deny' },
      timeoutMs: 30_000,
      inheritEnvironment: true,
    });
    if (result.status !== 'completed') {
      throw new Error(`Windows v2 private namespace smoke unavailable: ${JSON.stringify(result.doctor)}`);
    }
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'completed',
      sandboxed: true,
      exitCode: 0,
    });
    expect(result.stdout).toContain('DENIED:KodaXTextTxV2:5');
    expect(result.stdout).toMatch(
      /(?:DENIED:KodaXSandboxAclV2:5|UNAVAILABLE:KodaXSandboxAclV2:[23])/,
    );
    expect(result.stdout).not.toContain('OPENED');
  }, 60_000);

  it('does not let one policy open another policy private desktop', async () => {
    const parent = await createWindowsV2TestRoot('kodax-v2-desktop-policy-');
    roots.push(parent);
    const rootA = path.join(parent, 'A');
    const rootB = path.join(parent, 'B');
    await Promise.all([mkdir(rootA), mkdir(rootB)]);
    const probeExecutable = path.join(parent, 'desktop-policy-probe.exe');
    const desktopNamePath = path.join(rootB, 'desktop-name.txt');
    const releasePath = path.join(rootB, 'release');
    await execFile(process.env.RUSTC ?? 'rustc', [
      path.resolve('tests/fixtures/windows-desktop-policy-probe.rs'),
      '--edition=2021',
      '-O',
      '-o',
      probeExecutable,
    ]);

    const policyBPromise = runKodaXSandboxed({
      command: probeExecutable,
      args: ['publish', desktopNamePath, releasePath],
      cwd: rootB,
      filesystem: { allowRead: [parent], allowWrite: [rootB], denyRead: [], denyWrite: [] },
      network: { mode: 'deny' },
      timeoutMs: 45_000,
      inheritEnvironment: true,
    });
    let policyB: Awaited<typeof policyBPromise> | undefined;
    try {
      const deadline = Date.now() + 20_000;
      let desktopName: string | undefined;
      while (Date.now() < deadline) {
        try {
          desktopName = (await readFile(desktopNamePath, 'utf8')).trim();
          if (desktopName !== '') break;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await delay(50);
      }
      if (desktopName === undefined || desktopName === '') {
        throw new Error('Policy B did not publish its private desktop name.');
      }

      const policyA = await runKodaXSandboxed({
        command: probeExecutable,
        args: ['open', desktopName],
        cwd: rootA,
        filesystem: { allowRead: [parent], allowWrite: [rootA], denyRead: [], denyWrite: [] },
        network: { mode: 'deny' },
        timeoutMs: 30_000,
        inheritEnvironment: true,
      });
      if (policyA.status !== 'completed') {
        throw new Error(`Windows v2 desktop isolation smoke unavailable: ${JSON.stringify(policyA.doctor)}`);
      }
      expect(policyA, JSON.stringify(policyA)).toMatchObject({
        status: 'completed',
        sandboxed: true,
        exitCode: 0,
      });
      expect(policyA.stdout).toContain('DENIED:5');
      expect(policyA.stdout).not.toContain('OPENED');
    } finally {
      await writeFile(releasePath, 'release', 'utf8');
      policyB = await policyBPromise;
    }
    if (policyB.status !== 'completed') {
      throw new Error(`Policy B desktop publisher unavailable: ${JSON.stringify(policyB.doctor)}`);
    }
    expect(policyB, JSON.stringify(policyB)).toMatchObject({
      status: 'completed',
      sandboxed: true,
      exitCode: 0,
    });
  }, 90_000);
});
