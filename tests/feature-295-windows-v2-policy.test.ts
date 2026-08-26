import {
  execFile as execFileCallback,
  spawn,
  type ChildProcess,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertTrustedTextMutationPolicy,
  toolWrite,
  type KodaXToolExecutionContext,
} from '@kodax-ai/coding';

import {
  runKodaXSandboxed,
  type KodaXSandboxRunResult,
} from '../src/sandbox-runtime.js';
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

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

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
    `${identity.name}:${identity.pid}`
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
    'const input=JSON.parse(Buffer.from(process.argv[1],"base64url").toString("utf8"))',
    'try {',
    '  const result=await runKodaXSandboxed(input)',
    '  process.stdout.write("TERMINAL:"+Buffer.from(JSON.stringify({kind:"result",result})).toString("base64url"))',
    '} catch(error) {',
    '  const message=error instanceof Error?error.message:String(error)',
    '  process.stdout.write("TERMINAL:"+Buffer.from(JSON.stringify({kind:"error",message})).toString("base64url"))',
    '}',
  ].join(';');
  const request = Buffer.from(JSON.stringify({
    command: process.execPath,
    args: ['-e', targetScript, markerPath],
    cwd: root,
    filesystem: { allowRead: [root], allowWrite: [root], denyRead: [], denyWrite: [] },
    network: { mode: 'allow' },
    timeoutMs: 60_000,
    inheritEnvironment: true,
  }), 'utf8').toString('base64url');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', runtimeScript, request],
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-v2-loader-'));
    roots.push(root);
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
  }, 45_000);

  it('allows policy A in A but denies policy B from writing A', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'kodax-v2-policy-ab-'));
    roots.push(parent);
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

  it('lets different Runtime processes and policies reach the target concurrently', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'kodax-v2-policy-concurrent-'));
    roots.push(parent);
    const rootA = path.join(parent, 'A');
    const rootB = path.join(parent, 'B');
    await Promise.all([mkdir(rootA), mkdir(rootB)]);
    const readyA = path.join(rootA, 'ready');
    const readyB = path.join(rootB, 'ready');
    const sandboxRuntimeUrl = new URL('../src/sandbox-runtime.ts', import.meta.url).href;
    const targetScript = [
      'const fs=require("node:fs")',
      'fs.writeFileSync(process.argv[1],"ready")',
      'const wait=new Int32Array(new SharedArrayBuffer(4))',
      'const deadline=Date.now()+10000',
      'while(!fs.existsSync(process.argv[2])&&Date.now()<deadline) Atomics.wait(wait,0,0,25)',
      'if(!fs.existsSync(process.argv[2])) process.exit(41)',
      'process.stdout.write("peer-ready")',
    ].join(';');
    const runtimeScript = [
      `import { runKodaXSandboxed } from ${JSON.stringify(sandboxRuntimeUrl)}`,
      'const input=JSON.parse(Buffer.from(process.argv[1],"base64url").toString("utf8"))',
      'const result=await runKodaXSandboxed(input)',
      'process.stdout.write(JSON.stringify(result))',
    ].join(';');
    const runRuntime = async (root: string, ownReady: string, peerReady: string) => {
      const request = Buffer.from(JSON.stringify({
        command: process.execPath,
        args: ['-e', targetScript, ownReady, peerReady],
        cwd: root,
        filesystem: {
          allowRead: [parent],
          allowWrite: [root],
          denyRead: [],
          denyWrite: [],
        },
        network: { mode: 'allow' },
        timeoutMs: 20_000,
        inheritEnvironment: true,
      }), 'utf8').toString('base64url');
      const { stdout } = await execFile(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', runtimeScript, request],
        { cwd: process.cwd(), env: process.env, timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
      return JSON.parse(stdout) as {
        readonly status: string;
        readonly sandboxed?: boolean;
        readonly exitCode?: number;
        readonly stdout?: string;
        readonly doctor?: unknown;
      };
    };

    const [policyA, policyB] = await Promise.all([
      runRuntime(rootA, readyA, readyB),
      runRuntime(rootB, readyB, readyA),
    ]);

    for (const result of [policyA, policyB]) {
      if (result.status !== 'completed') {
        throw new Error(`Windows v2 concurrent smoke unavailable: ${JSON.stringify(result.doctor)}`);
      }
      expect(result).toMatchObject({
        status: 'completed',
        sandboxed: true,
        exitCode: 0,
      });
      expect(result.stdout).toContain('peer-ready');
    }
  }, 60_000);

  it('keeps trusted Write available while a different-file shell stays alive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-v2-shell-write-'));
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
      await expect(readFile(written, 'utf8')).resolves.toBe('hello');
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
      const root = await mkdtemp(path.join(os.tmpdir(), `kodax-v2-kill-${terminatedRole}-`));
      roots.push(root);
      const markerPath = path.join(root, 'processes.json');
      const written = path.join(root, `after-${terminatedRole}.md`);
      const runtime = launchSandboxRuntime(root, markerPath);
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

  it('does not let a restricted shell open host text or ACL namespaces', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-v2-private-namespace-'));
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
    expect(result.stdout).toContain('DENIED:KodaXSandboxAclV2:5');
    expect(result.stdout).not.toContain('OPENED');
  }, 60_000);

  it('does not let one policy open another policy private desktop', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'kodax-v2-desktop-policy-'));
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
