import { ChildProcess, spawnSync } from 'node:child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { cleanupRegisteredManagedChildren, setAgentConfigHome } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KodaXShellSandbox } from '../types.js';
import { toolBash } from './bash.js';
import { toolEdit } from './edit.js';
import { toolWrite } from './write.js';
import { withFileMutation } from './_internal/file-mutation-queue.js';

const windowsEffectJobMock = vi.hoisted(() => ({
  drainFailure: undefined as Error | undefined,
  containFailure: undefined as Error | undefined,
  containCalls: 0,
  recoveryCalls: 0,
}));
const managedRegistrationMock = vi.hoisted(() => ({
  failure: undefined as Error | undefined,
  child: undefined as ChildProcess | undefined,
  unrefCalls: 0,
  killCalls: 0,
  killSyncCalls: 0,
}));

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return {
    ...actual,
    containWindowsEffectProcess: async (pid: number) => {
      windowsEffectJobMock.containCalls += 1;
      if (windowsEffectJobMock.containFailure !== undefined) {
        throw windowsEffectJobMock.containFailure;
      }
      if (windowsEffectJobMock.drainFailure === undefined) {
        return actual.containWindowsEffectProcess(pid);
      }
      const drained = Promise.reject(windowsEffectJobMock.drainFailure);
      void drained.catch(() => undefined);
      return {
        supervisorPid: pid,
        jobName: 'Global\\KodaXEffect-00000000-0000-4000-8000-000000000001',
        drained,
        unref: () => undefined,
      };
    },
    terminateWindowsEffectJob: async (...args: Parameters<typeof actual.terminateWindowsEffectJob>) => {
      if (windowsEffectJobMock.drainFailure === undefined) {
        return actual.terminateWindowsEffectJob(...args);
      }
      windowsEffectJobMock.recoveryCalls += 1;
      return 'drained' as const;
    },
    registerManagedChildProcess: (
      ...args: Parameters<typeof actual.registerManagedChildProcess>
    ) => {
      if (managedRegistrationMock.failure === undefined) {
        return actual.registerManagedChildProcess(...args);
      }
      managedRegistrationMock.child = args[0];
      const originalUnref = args[0].unref.bind(args[0]);
      args[0].unref = () => {
        managedRegistrationMock.unrefCalls += 1;
        originalUnref();
      };
      throw managedRegistrationMock.failure;
    },
    killChildProcessTree: (
      ...args: Parameters<typeof actual.killChildProcessTree>
    ) => {
      managedRegistrationMock.killCalls += 1;
      return managedRegistrationMock.failure === undefined
        ? actual.killChildProcessTree(...args)
        : Promise.resolve({ status: 'unknown' as const });
    },
    killChildProcessTreeSync: (
      child: Parameters<typeof actual.killChildProcessTreeSync>[0],
    ) => {
      managedRegistrationMock.killSyncCalls += 1;
      return managedRegistrationMock.failure === undefined
        ? actual.killChildProcessTreeSync(child)
        : { status: 'unknown' as const };
    },
  };
});

const WINDOWS_PROCESS_TREE_EXIT_WAIT_MS = process.platform === 'win32' ? 30_000 : 15_000;
const WINDOWS_PROCESS_TREE_TEST_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 30_000;
const BACKGROUND_CHILD_MARKER = 'child-pid:';

function nodeOutputCommand(stdout: string, commandMarker = ''): string {
  const encoded = Buffer.from(stdout, 'utf-8').toString('base64');
  return `node -e "const marker='${commandMarker}'; void marker; process.stdout.write(Buffer.from('${encoded}','base64'))"`;
}

function passthroughShellSandbox(): KodaXShellSandbox {
  return {
    prepare: async (input) => {
      const executable = input.executable
        ?? (process.platform === 'win32' ? undefined : (process.env.SHELL ?? '/bin/sh'));
      if (executable === undefined) return undefined;
      return {
        executable,
        args: input.executable === undefined ? ['-c', input.command] : (input.args ?? []),
        env: input.env,
        ...(input.windowsVerbatimArguments === undefined
          ? {}
          : { windowsVerbatimArguments: input.windowsVerbatimArguments }),
        cleanup: async () => undefined,
      };
    },
  };
}

function completedCommandBody(result: string): string {
  return result.split(/\nExit: -?\d+\n/, 2)[1] ?? result;
}

function parentWatchedBackgroundCommand(): string {
  return `${JSON.stringify(process.execPath)} -e "const parent=process.ppid; console.log('child-pid:' + process.pid); setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 1000)"`;
}

function parseBackgroundPid(result: string): number {
  const match = /PID:\s*(\d+)/.exec(result);
  if (!match?.[1]) {
    throw new Error(`background PID missing from result: ${result}`);
  }
  return Number(match[1]);
}

function parseBackgroundOutputPath(result: string): string {
  const match = /Output:\s*(.+)/.exec(result);
  if (!match?.[1]) {
    throw new Error(`background output path missing from result: ${result}`);
  }
  return match[1].trim();
}

function parseRecoveryOutputPath(result: string, stream: 'stdout' | 'stderr'): string {
  const match = new RegExp(`${stream} recovery: (.+)`).exec(result);
  if (!match?.[1]) {
    throw new Error(`${stream} recovery path missing from result: ${result}`);
  }
  return match[1].trim();
}

async function waitForOutputMatch(
  filePath: string,
  pattern: RegExp,
  timeoutMs = 5_000,
): Promise<RegExpExecArray> {
  const deadline = Date.now() + timeoutMs;
  let content = '';
  while (Date.now() < deadline) {
    try {
      content = await fs.readFile(filePath, 'utf-8');
      const match = pattern.exec(content);
      if (match) {
        return match;
      }
    } catch {
      // File may not exist yet on the first poll iteration.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pattern ${pattern} not found in background output: ${content}`);
}

function getWindowsCommandLine(pid: number): string | undefined {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
  ], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  const commandLine = typeof result.stdout === 'string'
    ? result.stdout.trim()
    : undefined;
  return commandLine ? commandLine : undefined;
}

function isPidAlive(pid: number, commandMarker?: string): boolean {
  if (process.platform === 'win32' && commandMarker !== undefined) {
    const commandLine = getWindowsCommandLine(pid);
    return commandLine?.includes(commandMarker) ?? false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(
  pid: number,
  timeoutMs = 5_000,
  commandMarker?: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid, commandMarker)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid, commandMarker);
}

describe('toolBash', () => {
  afterEach(async () => {
    const unregisteredChild = managedRegistrationMock.child;
    managedRegistrationMock.failure = undefined;
    managedRegistrationMock.child = undefined;
    managedRegistrationMock.unrefCalls = 0;
    managedRegistrationMock.killCalls = 0;
    managedRegistrationMock.killSyncCalls = 0;
    unregisteredChild?.kill('SIGKILL');
    windowsEffectJobMock.drainFailure = undefined;
    windowsEffectJobMock.containFailure = undefined;
    windowsEffectJobMock.containCalls = 0;
    windowsEffectJobMock.recoveryCalls = 0;
  });

  it('executes an admitted command through the runtime-owned shell sandbox', async () => {
    const cleanup = vi.fn(async () => ({
      version: 1 as const,
      state: 'applied' as const,
      backend: 'windows-restricted-user' as const,
      policyId: 'kodax-workspace-shell-v1' as const,
    }));
    const reportToolSandboxObservation = vi.fn();
    const prepare = vi.fn(async () => ({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("sandboxed")'],
      env: process.env,
      cleanup,
    }));

    const result = await toolBash({ command: 'echo unsandboxed' }, {
      backups: new Map(),
      toolCallId: 'bash-sandbox-1',
      shellSandbox: { prepare },
      reportToolSandboxObservation,
    });

    expect(completedCommandBody(result)).toContain('sandboxed');
    expect(completedCommandBody(result)).not.toContain('unsandboxed');
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: 'bash-sandbox-1',
      command: 'echo unsandboxed',
    }));
    if (process.platform === 'win32') {
      expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
        env: expect.objectContaining({ NoDefaultCurrentDirectoryInExePath: '1' }),
      }));
    }
    expect(cleanup).toHaveBeenCalledOnce();
    expect(reportToolSandboxObservation).toHaveBeenCalledWith({
      version: 1,
      state: 'applied',
      backend: 'windows-restricted-user',
      policyId: 'kodax-workspace-shell-v1',
    });
  });

  it('starts a native-Job sandbox directly with immediate stdin EOF and no effect lease', async () => {
    const forbiddenLease = {
      bindEffectProcess: vi.fn(async () => {
        throw new Error('filesystem-effect bind must not run');
      }),
      finishEffectProcess: vi.fn(async () => {
        throw new Error('filesystem-effect finish must not run');
      }),
      release: vi.fn(async () => {
        throw new Error('filesystem-effect release must not run');
      }),
    };
    const script = [
      'const chunks=[]',
      "process.stdin.on('data',(chunk)=>chunks.push(chunk))",
      "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({bytes:Buffer.concat(chunks).length,parent:process.ppid})))",
    ].join(';');

    const result = await toolBash({ command: 'native-job-direct' }, {
      backups: new Map(),
      toolCallId: 'native-job-direct',
      shellSandbox: {
        prepare: async () => ({
          executable: process.execPath,
          args: ['-e', script],
          env: process.env,
          processTreeContainment: 'native-job' as const,
          fileSystemEffectLease: forbiddenLease,
          cleanup: async () => undefined,
        }),
      },
    });

    expect(completedCommandBody(result)).toContain(
      JSON.stringify({ bytes: 0, parent: process.pid }),
    );
    expect(forbiddenLease.bindEffectProcess).not.toHaveBeenCalled();
    expect(forbiddenLease.finishEffectProcess).not.toHaveBeenCalled();
    expect(forbiddenLease.release).not.toHaveBeenCalled();
    expect(windowsEffectJobMock.containCalls).toBe(0);
  });

  it('uses persistent native control for timeout without invoking generic process-tree cleanup', async () => {
    const closeInput = vi.fn(async (child: ChildProcess) => {
      child.stdin?.end();
    });
    const terminate = vi.fn(async (child: ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGKILL');
      await closed;
    });

    const result = await toolBash({ command: 'native-timeout', timeout: 0.05 }, {
      backups: new Map(),
      shellSandbox: {
        prepare: async () => ({
          executable: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          env: process.env,
          processTreeContainment: 'native-job',
          processControl: { closeInput, terminate },
          cleanup: async () => undefined,
        }),
      },
    });

    expect(result).toContain('[Timeout] Command interrupted');
    expect(closeInput).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
    expect(managedRegistrationMock.killCalls).toBe(0);
    expect(managedRegistrationMock.killSyncCalls).toBe(0);
  });

  it('delivers broker-only control output to request-scoped cleanup', async () => {
    const cleanup = vi.fn(async (input?: {
      readonly execution: 'not_started' | 'started_or_unknown';
      readonly controlOutput?: Uint8Array;
    }) => {
      expect(input?.execution).toBe('started_or_unknown');
      expect(Buffer.from(input?.controlOutput ?? []).toString('utf8')).toBe('control-frame\n');
      return undefined;
    });
    const script = [
      'const fs=require("node:fs")',
      "process.stdin.resume()",
      "process.stdin.on('end',()=>{fs.writeSync(3,Buffer.from('control-frame\\n'));process.stdout.write('broker-finished')})",
    ].join(';');

    const result = await toolBash({ command: 'broker-control' }, {
      backups: new Map(),
      toolCallId: 'broker-control',
      shellSandbox: {
        prepare: async () => ({
          executable: process.execPath,
          args: ['-e', script],
          env: process.env,
          stdinPrefix: Buffer.from('request'),
          controlChannel: { fd: 3, maxOutputBytes: 1024 },
          cleanup,
        }),
      },
    });

    expect(completedCommandBody(result)).toContain('broker-finished');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('keeps bootstrap pipe errors observed through close after cancellation', async () => {
    const marker = path.join(tempDir, 'native-bootstrap-started');
    const controller = new AbortController();
    const script = [
      'const fs=require("node:fs")',
      `fs.writeFileSync(${JSON.stringify(marker)},'ready')`,
      'setInterval(()=>{},1000)',
    ].join(';');
    const closeInput = vi.fn((
      _child: ChildProcess,
      signal: AbortSignal | undefined,
    ) => new Promise<void>((_resolve, reject) => {
      const abort = (): void => reject(new DOMException('Operation aborted', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    }));
    const terminate = vi.fn(async (child: ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGKILL');
      await closed;
    });
    const running = toolBash({ command: 'cancel-native-bootstrap' }, {
      backups: new Map(),
      abortSignal: controller.signal,
      shellSandbox: {
        prepare: async () => ({
          executable: process.execPath,
          args: ['-e', script],
          env: process.env,
          processTreeContainment: 'native-job' as const,
          processControl: { closeInput, terminate },
          cleanup: async () => undefined,
        }),
      },
    });
    await vi.waitFor(async () => {
      expect(await fs.readFile(marker, 'utf8')).toBe('ready');
    }, { timeout: 5_000 });
    controller.abort();

    await expect(running).resolves.toContain('[Cancelled] Operation cancelled by user');
    expect(closeInput).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
    expect(managedRegistrationMock.killCalls).toBe(0);
    expect(managedRegistrationMock.killSyncCalls).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it('keeps production shell execution outside the legacy filesystem-effect lifecycle', async () => {
    const source = await fs.readFile(new URL('./bash.ts', import.meta.url), 'utf8');

    for (const forbidden of [
      'acquireFileSystemMutationLease',
      'containWindowsEffectProcess',
      'prepareJavaScriptChildLaunch',
      'fileSystemEffectLease',
      'fileSystemEffectPolicyKey',
      'authorizeStart',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toContain("'go\\n'");
    expect(source).toContain('closePreparedShellInput(');
    expect(source).toContain('sandboxInvocation?.stdinPrefix');
    expect(source).toContain("stdin.on('error', onError)");
    expect(source).toContain("stdin.once('close', onClose)");
  });

  it('keeps sandbox cleanup request-scoped and never retires shared shell state', async () => {
    const cleanup = vi.fn(async () => {
      throw new Error('request cleanup failed');
    });
    const retire = vi.fn(async () => {
      throw new Error('shared retirement must not run');
    });

    const result = await toolBash({ command: 'request-scoped-cleanup' }, {
      backups: new Map(),
      shellSandbox: {
        prepare: async () => ({
          executable: process.execPath,
          args: ['-e', "process.stdout.write('ran-once')"],
          env: process.env,
          processTreeContainment: 'native-job' as const,
          cleanup,
          retire,
        }),
      },
    });

    expect(result).toContain('ran-once');
    expect(result).toContain('request cleanup failed');
    expect(cleanup).toHaveBeenCalledOnce();
    expect(retire).not.toHaveBeenCalled();
  });

  it('does not leave a command-lifecycle fence after a native-job invocation exits nonzero', async () => {
    let prepareCount = 0;
    const cleanup = vi.fn(async () => undefined);
    const shellSandbox: KodaXShellSandbox = {
      prepare: async () => {
        prepareCount += 1;
        return {
          executable: process.execPath,
          args: prepareCount === 1
            ? ['-e', 'process.exit(23)']
            : ['-e', "process.stdout.write('second-command-ran')"],
          env: process.env,
          processTreeContainment: 'native-job',
          cleanup,
        };
      },
    };

    const first = await toolBash({ command: 'runner-crash' }, {
      backups: new Map(),
      shellSandbox,
    });
    const textPath = path.join(tempDir, 'after-native-runner-crash.txt');
    const write = await toolWrite(
      { path: textPath, content: 'text-still-available\n' },
      { backups: new Map(), executionCwd: tempDir },
    );
    const second = await toolBash({ command: 'after-runner-crash' }, {
      backups: new Map(),
      shellSandbox,
    });

    expect(first).toContain('Exit: 23');
    expect(write).toContain('File created');
    await expect(fs.readFile(textPath, 'utf8')).resolves.toBe('text-still-available\n');
    expect(completedCommandBody(second)).toContain('second-command-ran');
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('runs different native shell policies concurrently without a shared lifecycle lock', async () => {
    const controller = new AbortController();
    const background = await toolBash({
      command: 'policy-a-background',
      run_in_background: true,
    }, {
      backups: new Map(),
      toolCallId: 'runtime-a-session-a',
      abortSignal: controller.signal,
      shellSandbox: {
        prepare: async () => ({
          executable: process.execPath,
          args: ['-e', "process.stdout.write('a-ready');setInterval(()=>{},1000)"],
          env: { ...process.env, KODAX_TEST_POLICY: 'a' },
          processTreeContainment: 'native-job',
          cleanup: async () => undefined,
        }),
      },
    });
    const backgroundPid = parseBackgroundPid(background);

    try {
      const second = await Promise.race([
        toolBash({ command: 'policy-b-foreground' }, {
          backups: new Map(),
          toolCallId: 'runtime-b-session-b',
          shellSandbox: {
            prepare: async () => ({
              executable: process.execPath,
              args: ['-e', "process.stdout.write('policy-b-ran')"],
              env: { ...process.env, KODAX_TEST_POLICY: 'b' },
              processTreeContainment: 'native-job',
              cleanup: async () => undefined,
            }),
          },
        }),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 5_000)),
      ]);

      expect(second).not.toBe('blocked');
      expect(completedCommandBody(second)).toContain('policy-b-ran');
      expect(isPidAlive(backgroundPid)).toBe(true);
    } finally {
      controller.abort();
      await waitForPidExit(backgroundPid, WINDOWS_PROCESS_TREE_EXIT_WAIT_MS);
    }
  }, WINDOWS_PROCESS_TREE_TEST_TIMEOUT_MS);

  it('falls back to ordinary execution when sandbox preparation unexpectedly fails', async () => {
    const reportToolSandboxObservation = vi.fn();
    const prepare = vi.fn(async () => {
      throw new Error('sandbox preparation failed');
    });
    const command = nodeOutputCommand('ordinary execution completed');

    const result = await toolBash({ command }, {
      backups: new Map(),
      toolCallId: 'bash-sandbox-fallback',
      shellSandbox: { prepare },
      reportToolSandboxObservation,
    });

    expect(completedCommandBody(result)).toContain('ordinary execution completed');
    expect(reportToolSandboxObservation).toHaveBeenCalledWith({
      version: 1,
      state: 'fallback',
      reason: 'prepare_failed',
      execution: 'normal_permission_policy',
    });
  });

  it('uses ordinary authorized execution when sandbox preparation fails', async () => {
    const prepare = vi.fn(async () => {
      throw new Error('sandbox unavailable');
    });
    const command = nodeOutputCommand('authorized fallback completed');

    const result = await toolBash({ command }, {
      backups: new Map(),
      toolCallId: 'bash-sandbox-fallback-after-error',
      shellSandbox: { prepare },
    });

    expect(completedCommandBody(result)).toContain('authorized fallback completed');
  });

  it('uses ordinary authorized execution when sandbox declines the selected call', async () => {
    const command = nodeOutputCommand('declined sandbox fallback completed');
    const result = await toolBash({ command }, {
      backups: new Map(),
      toolCallId: 'bash-sandbox-declined-fallback',
      shellSandbox: { prepare: async () => undefined },
    });

    expect(completedCommandBody(result)).toContain('declined sandbox fallback completed');
  });

  it('keeps Provider credentials out of legacy sandbox input and fallback execution', async () => {
    const originalOpenAI = process.env.OPENAI_API_KEY;
    const originalCustom = process.env.KODAX_TEST_CUSTOM_PROVIDER_AUTH;
    const originalSafe = process.env.KODAX_TEST_SAFE_VALUE;
    process.env.OPENAI_API_KEY = 'built-in-secret';
    process.env.KODAX_TEST_CUSTOM_PROVIDER_AUTH = 'custom-secret';
    process.env.KODAX_TEST_SAFE_VALUE = 'safe';
    let preparedEnvironment: NodeJS.ProcessEnv | undefined;
    const prepare = vi.fn(async (input: Parameters<KodaXShellSandbox['prepare']>[0]) => {
      preparedEnvironment = input.env;
      throw new Error('exercise normal-permission fallback');
    });
    const script = [
      'process.env.OPENAI_API_KEY',
      'process.env.KODAX_TEST_CUSTOM_PROVIDER_AUTH',
      'process.env.KODAX_TEST_SAFE_VALUE',
    ].join(" ?? 'missing',") + " ?? 'missing'";
    const encoded = Buffer.from(`process.stdout.write([${script}].join('|'))`, 'utf8')
      .toString('base64');
    try {
      const result = await toolBash({
        command: `node -e "eval(Buffer.from('${encoded}','base64').toString())"`,
      }, {
        backups: new Map(),
        toolCallId: 'bash-filter-provider-credentials',
        shellSandbox: { prepare },
        providerCredentialEnvironmentNames: ['KODAX_TEST_CUSTOM_PROVIDER_AUTH'],
      });

      expect(preparedEnvironment).not.toHaveProperty('OPENAI_API_KEY');
      expect(preparedEnvironment).not.toHaveProperty('KODAX_TEST_CUSTOM_PROVIDER_AUTH');
      expect(preparedEnvironment).toHaveProperty('KODAX_TEST_SAFE_VALUE', 'safe');
      expect(completedCommandBody(result)).toContain('missing|missing|safe');
    } finally {
      if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAI;
      if (originalCustom === undefined) delete process.env.KODAX_TEST_CUSTOM_PROVIDER_AUTH;
      else process.env.KODAX_TEST_CUSTOM_PROVIDER_AUTH = originalCustom;
      if (originalSafe === undefined) delete process.env.KODAX_TEST_SAFE_VALUE;
      else process.env.KODAX_TEST_SAFE_VALUE = originalSafe;
    }
  });

  it('passes explicitly allowed credentials to sandbox input and fallback execution', async () => {
    const originalPass = process.env.KODAX_SANDBOX_ENV_PASS;
    const originalGitHub = process.env.GITHUB_TOKEN;
    const originalOpenAI = process.env.OPENAI_API_KEY;
    process.env.KODAX_SANDBOX_ENV_PASS = 'OPENAI_API_KEY';
    process.env.GITHUB_TOKEN = 'allowed-secret';
    process.env.OPENAI_API_KEY = 'filtered-secret';
    let preparedEnvironment: NodeJS.ProcessEnv | undefined;
    const prepare = vi.fn(async (input: Parameters<KodaXShellSandbox['prepare']>[0]) => {
      preparedEnvironment = input.env;
      throw new Error('exercise normal-permission fallback');
    });
    const encoded = Buffer.from(
      "process.stdout.write([process.env.GITHUB_TOKEN, process.env.OPENAI_API_KEY ?? 'missing'].join('|'))",
      'utf8',
    ).toString('base64');
    try {
      const result = await toolBash({
        command: `node -e "eval(Buffer.from('${encoded}','base64').toString())"`,
      }, {
        backups: new Map(),
        toolCallId: 'bash-pass-allowed-credential',
        shellSandbox: { prepare },
        sandbox: { envPass: ['GITHUB_TOKEN'] },
      });

      expect(preparedEnvironment).toHaveProperty('GITHUB_TOKEN', 'allowed-secret');
      expect(preparedEnvironment).not.toHaveProperty('OPENAI_API_KEY');
      expect(completedCommandBody(result)).toContain('allowed-secret|missing');
    } finally {
      if (originalPass === undefined) delete process.env.KODAX_SANDBOX_ENV_PASS;
      else process.env.KODAX_SANDBOX_ENV_PASS = originalPass;
      if (originalGitHub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalGitHub;
      if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAI;
    }
  });

  it('does not fall back or spawn after cancellation during sandbox preparation', async () => {
    const controller = new AbortController();
    const reportToolSandboxObservation = vi.fn();
    const shellSandbox: KodaXShellSandbox = {
      prepare: (input) => new Promise((_, reject) => {
        input.signal?.addEventListener('abort', () => {
          reject(new DOMException('Operation aborted', 'AbortError'));
        }, { once: true });
      }),
    };
    const command = nodeOutputCommand('must not execute');
    const running = toolBash({ command }, {
      backups: new Map(),
      toolCallId: 'bash-sandbox-cancelled-prepare',
      shellSandbox,
      abortSignal: controller.signal,
      reportToolSandboxObservation,
    });

    controller.abort();
    await expect(running).resolves.toContain('[Cancelled]');
    expect(reportToolSandboxObservation).not.toHaveBeenCalled();
  });

  it('does not spawn when the command deadline expires during sandbox preparation', async () => {
    const reportToolSandboxObservation = vi.fn();
    const shellSandbox: KodaXShellSandbox = {
      async prepare() {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error('late preparation failure');
      },
    };
    const command = nodeOutputCommand('must not execute');

    const result = await toolBash({ command, timeout: 0.01 }, {
      backups: new Map(),
      toolCallId: 'bash-sandbox-timeout-prepare',
      shellSandbox,
      reportToolSandboxObservation,
    });

    expect(result).toContain('[Timeout] Command was not started');
    expect(reportToolSandboxObservation).not.toHaveBeenCalled();
  });

  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-bash-'));
    setAgentConfigHome(path.join(tempDir, 'agent-home'));
  });

  afterEach(async () => {
    await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });
    setAgentConfigHome(undefined);
    if (tempDir) {
      await fs.rm(tempDir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
      tempDir = '';
    }
  });

  it.runIf(process.platform === 'win32')(
    'does not execute a cwd-shadowed bare command through legacy cmd',
    async () => {
      const marker = 'KODAX_CWD_SHADOW_EXECUTED';
      const comspec = process.env.ComSpec ?? process.env.COMSPEC;
      expect(comspec).toBeTruthy();
      await fs.copyFile(comspec!, path.join(tempDir, 'where.exe'));

      const result = await toolBash({ command: `where /c echo ${marker}` }, {
        backups: new Map(),
        executionCwd: tempDir,
      });

      expect(completedCommandBody(result)).not.toContain(marker);
    },
  );

  it('spills large command output at the Bash byte/line policy', async () => {
    // NOTE: keep this shell-portable — backticks / ${...} inside the double-
    // quoted -e script get interpreted by POSIX `sh` (command substitution +
    // parameter expansion) before node sees them, which on Linux CI produced
    // blank lines instead of "line-N". Use single-quoted string concatenation.
    const command = 'node -e "for (let i = 1; i <= 3000; i++) console.log(\'line-\' + i)"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('KODAX_RESULT_INCOMPLETE');
    expect(result).not.toContain('line-1\n');
    const outputPath = parseRecoveryOutputPath(result, 'stdout');
    const artifact = await fs.readFile(outputPath, 'utf-8');
    expect(artifact).toContain('line-1\n');
    expect(artifact).toContain('line-3000');
  });

  it('captures stdout and stderr from the first byte after the policy threshold is crossed', async () => {
    const command = 'node -e "process.stdout.write(\'stdout-first-byte\\n\'+\'x\'.repeat(600*1024)+\'\\nstdout-last-byte\'); process.stderr.write(\'stderr-first-byte\\n\'+\'y\'.repeat(600*1024)+\'\\nstderr-last-byte\')"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('KODAX_RESULT_INCOMPLETE');
    const stdoutPath = parseRecoveryOutputPath(result, 'stdout');
    const stderrPath = parseRecoveryOutputPath(result, 'stderr');
    await expect(fs.readFile(stdoutPath, 'utf-8')).resolves.toEqual(expect.stringContaining('stdout-first-byte'));
    await expect(fs.readFile(stdoutPath, 'utf-8')).resolves.toEqual(expect.stringContaining('stdout-last-byte'));
    await expect(fs.readFile(stderrPath, 'utf-8')).resolves.toEqual(expect.stringContaining('stderr-first-byte'));
    await expect(fs.readFile(stderrPath, 'utf-8')).resolves.toEqual(expect.stringContaining('stderr-last-byte'));
  });

  it('spills 174,763 continuous A bytes without materializing them inline', async () => {
    const content = 'A'.repeat(174_763);
    const command = 'node -e "process.stdout.write(\'A\'.repeat(174763))"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
      toolCallId: 'dense-bash-output',
    });

    expect(result).toContain('KODAX_RESULT_INCOMPLETE');
    expect(result.length).toBeLessThan(4_096);
    const outputPath = parseRecoveryOutputPath(result, 'stdout');
    const artifact = await fs.readFile(outputPath, 'utf-8');
    expect(artifact).toContain(content);
    expect(artifact).toContain('KODAX_CAPTURE_COMPLETE');
  });

  it('keeps a canonical artifact when raw bytes prove the output cannot fit any request', async () => {
    const command = nodeOutputCommand(`BEGIN_SENTINEL${'x'.repeat(1024)}END_SENTINEL`);
    const recordToolResultArtifact = vi.fn();
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
      shellSandbox: passthroughShellSandbox(),
      maximumInputTokens: 1,
      toolCallId: 'bash-oversize',
      recordToolResultArtifact,
    });

    expect(result).toContain('KODAX_RESULT_INCOMPLETE');
    expect(result).toContain('Full output saved to:');
    expect(result).not.toContain('END_SENTINEL');
    const outputPath = parseRecoveryOutputPath(result, 'stdout');
    const artifact = await fs.readFile(outputPath, 'utf-8');
    expect(artifact).toContain('BEGIN_SENTINEL');
    expect(artifact).toContain('END_SENTINEL');
    expect(artifact).toContain('KODAX_CAPTURE_COMPLETE');
    const manifestPath = /Full output saved to: (.+?)\.\]/.exec(result)?.[1];
    expect(manifestPath).toBeDefined();
    await expect(fs.readFile(manifestPath!, 'utf-8')).resolves.toContain('stderr recovery:');
    expect(recordToolResultArtifact).toHaveBeenCalledWith('bash-oversize', manifestPath);
  });

  it('strips ANSI escape codes from completed command output while preserving the bash header', async () => {
    const command = 'node -e "const e=String.fromCharCode(27); process.stdout.write(e+\'[31mred\'+e+\'[0m\\n\'); process.stderr.write(e+\'[33mwarn\'+e+\'[0m\\n\')"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain(`Command: ${command}`);
    expect(result).toContain('Exit: 0');
    expect(result).toContain('red');
    expect(result).toContain('[stderr]\nwarn');
    expect(result).not.toContain('\u001B[');
  });

  it('preserves the target URL when normalizing an OSC8 hyperlink', async () => {
    const url = 'https://example.test/critical-target?item=42';
    const command = 'node -e "const e=String.fromCharCode(27),b=String.fromCharCode(7); process.stdout.write(e+\']8;;https://example.test/critical-target?item=42\'+b+\'open result\'+e+\']8;;\'+b+\'\\n\')"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    const body = completedCommandBody(result);
    expect(body).toContain('open result');
    expect(body).toContain(url);
    expect(body).not.toContain('\u001B]8;');
  });

  it.each([
    {
      id: 'git log',
      marker: 'git log --oneline --stat',
      critical: 'critical-late-commit',
      output: [
        ...Array.from({ length: 45 }, (_, index) => `${index.toString(16).padStart(7, 'a')} commit-${index}`),
        'fffffff critical-late-commit',
      ].join('\n'),
    },
    {
      id: 'git diff',
      marker: 'git diff',
      critical: '+const criticalDiffValue = 42;',
      output: Array.from({ length: 30 }, (_, index) => [
        `diff --git a/src/value-${index}.ts b/src/value-${index}.ts`,
        'index 1111111..2222222 100644',
        `--- a/src/value-${index}.ts`,
        `+++ b/src/value-${index}.ts`,
        '@@ -1,2 +1,2 @@',
        `-const oldValue${index} = ${index};`,
        index === 29 ? '+const criticalDiffValue = 42;' : `+const newValue${index} = ${index + 1};`,
      ].join('\n')).join('\n'),
    },
    {
      id: 'git status',
      marker: 'git status',
      critical: 'critical-status-path.ts',
      output: [
        'On branch main',
        'Changes not staged for commit:',
        ...Array.from({ length: 100 }, (_, index) => `\tmodified:   src/file-${index}.ts`),
        '\tmodified:   src/critical-status-path.ts',
      ].join('\n'),
    },
    {
      id: 'test runner',
      marker: 'npm test',
      critical: 'critical-root-cause-after-context-window',
      output: [
        'FAIL src/example.test.ts',
        ...Array.from({ length: 12 }, (_, index) => `failure-context-${index}`),
        'critical-root-cause-after-context-window',
        ...Array.from({ length: 80 }, (_, index) => `progress-${index}`),
        'Tests 1 failed | 99 passed',
      ].join('\n'),
    },
    {
      id: 'JSON',
      marker: 'curl https://example.test/data',
      critical: 'critical-json-value',
      output: JSON.stringify({
        critical: 'critical-json-value',
        padding: 'x'.repeat(2200),
      }),
    },
    {
      id: 'compound command',
      marker: 'git diff && npm test',
      critical: 'critical-compound-test-failure',
      output: [
        'diff --git a/src/value.ts b/src/value.ts',
        '--- a/src/value.ts',
        '+++ b/src/value.ts',
        '@@ -1,100 +1,100 @@',
        ...Array.from({ length: 100 }, (_, index) => `-old-${index}`),
        ...Array.from({ length: 100 }, (_, index) => `+new-${index}`),
        'FAIL src/compound.test.ts',
        'critical-compound-test-failure',
      ].join('\n'),
    },
  ])('does not apply a lossy $id semantic filter by default', async ({ marker, output, critical }) => {
    const command = nodeOutputCommand(output, marker);
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    const body = completedCommandBody(result);
    expect(body).toContain(critical);
    expect(body).not.toContain('[Bash output compressed');
  });

  it('does not fail a completed command when live progress rendering throws', async () => {
    const command = 'node -e "console.log(\'progress-output\')"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
      reportToolProgress: () => {
        throw new Error('renderer unavailable');
      },
    });

    expect(result).toContain(`Command: ${command}`);
    expect(result).toContain('Exit: 0');
    expect(result).toContain('progress-output');
  });

  it('includes stderr in timeout previews', async () => {
    const command = 'node -e "process.stderr.write(\'timeout-error\\n\'); setTimeout(() => {}, 5000)"';
    const result = await toolBash({ command, timeout: 1 }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result).toContain('[Timeout]');
    expect(result).toContain('timeout-error');
  });

  it('returns an explicit command-scoped cancellation for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const command = 'node -e "console.log(\'should-not-complete\')"';

    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
      abortSignal: controller.signal,
    });

    expect(result).toContain(`Command: ${command}`);
    expect(result).toContain('[Cancelled] Operation cancelled by user');
  });

  it('preserves captured stdout and stderr when a running command is aborted', async () => {
    const controller = new AbortController();
    const command = 'node -e "process.stdout.write(\'partial-stdout\\n\'); process.stderr.write(\'partial-stderr\\n\'); setTimeout(() => console.log(\'ready-to-abort\'), 150); setInterval(() => {}, 1000)"';
    let aborted = false;
    const recoveryPaths: string[] = [];

    try {
      const result = await toolBash({ command, timeout: 60 }, {
        backups: new Map(),
        executionCwd: tempDir,
        abortSignal: controller.signal,
        reportToolProgress: (progress) => {
          if (!aborted && progress.includes('ready-to-abort')) {
            aborted = true;
            controller.abort();
          }
        },
      });

      expect(aborted).toBe(true);
      expect(result).toContain('[Cancelled] Operation cancelled by user');
      if (result.includes('Partial output:')) {
        expect(result).toContain('partial-stdout');
        expect(result).toContain('[stderr]');
        expect(result).toContain('partial-stderr');
        return;
      }

      expect(result).toContain('KODAX_CAPTURE_INCOMPLETE');
      const stdoutPath = parseRecoveryOutputPath(result, 'stdout');
      const stderrPath = parseRecoveryOutputPath(result, 'stderr');
      recoveryPaths.push(stdoutPath, stderrPath);
      await waitForOutputMatch(stdoutPath, /KODAX_CAPTURE_COMPLETE/, 10_000);
      await waitForOutputMatch(stderrPath, /KODAX_CAPTURE_COMPLETE/, 10_000);
      expect(await fs.readFile(stdoutPath, 'utf-8')).toContain('partial-stdout');
      expect(await fs.readFile(stderrPath, 'utf-8')).toContain('partial-stderr');
    } finally {
      controller.abort();
      await Promise.all(recoveryPaths.map((filePath) => fs.rm(filePath, { force: true })));
    }
  });

  it('waits for a cancelled command to release its execution cwd before returning', async () => {
    const controller = new AbortController();
    const commandCwd = path.join(tempDir, 'cancelled-command-cwd');
    await fs.mkdir(commandCwd);
    const command = process.platform === 'win32'
      ? 'echo ready-to-abort & set /p KODAX_WAIT='
      : 'printf "ready-to-abort\\n"; read KODAX_WAIT';
    let aborted = false;

    const result = await toolBash({ command, timeout: 10 }, {
      backups: new Map(),
      executionCwd: commandCwd,
      abortSignal: controller.signal,
      reportToolProgress: (progress) => {
        if (!aborted && progress.includes('ready-to-abort')) {
          aborted = true;
          controller.abort();
        }
      },
    });

    expect(aborted).toBe(true);
    expect(result).toContain('[Cancelled] Operation cancelled by user');
    await expect(fs.rm(commandCwd, { recursive: true, force: true })).resolves.toBeUndefined();
  });

  it('hands delayed stream drain to recoverable artifacts without dropping late chunks', async () => {
    const marker = `delayed-close-${Date.now()}`;
    const command = `node -e "console.log('${marker}'); setInterval(() => {}, 1000)"`;
    const controller = new AbortController();
    const delayedCloseMs = process.platform === 'win32' ? 2_800 : 1_800;
    const lateChunkMs = process.platform === 'win32' ? 2_200 : 1_200;
    const abortWatchdog = setTimeout(() => controller.abort(), 5_000);
    const originalEmit = ChildProcess.prototype.emit;
    const delayedPids = new Set<number>();
    const recoveryPaths: string[] = [];
    const emitSpy = vi.spyOn(ChildProcess.prototype, 'emit').mockImplementation(function (
      this: ChildProcess,
      event: string | symbol,
      ...args: unknown[]
    ): boolean {
      const shouldDelay = event === 'close'
        && this.pid !== undefined
        && !delayedPids.has(this.pid);
      if (!shouldDelay) {
        return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
      }

      delayedPids.add(this.pid as number);
      setTimeout(() => {
        this.stdout?.emit('data', Buffer.from('late-after-deadline\n'));
      }, lateChunkMs);
      setTimeout(() => {
        Reflect.apply(originalEmit, this, [event, ...args]);
      }, delayedCloseMs);
      return true;
    });

    try {
      const result = await toolBash({ command, timeout: 60 }, {
        backups: new Map(),
        executionCwd: tempDir,
        shellSandbox: passthroughShellSandbox(),
        abortSignal: controller.signal,
        reportToolProgress: (progress) => {
          if (progress.includes(marker)) controller.abort();
        },
      });

      expect(result).toContain('KODAX_CAPTURE_INCOMPLETE');
      const stdoutPath = parseRecoveryOutputPath(result, 'stdout');
      const stderrPath = parseRecoveryOutputPath(result, 'stderr');
      recoveryPaths.push(stdoutPath, stderrPath);
      await waitForOutputMatch(stdoutPath, /KODAX_CAPTURE_COMPLETE/, delayedCloseMs + 5_000);
      const recovered = await fs.readFile(stdoutPath, 'utf-8');
      expect(recovered).toContain('late-after-deadline');
    } finally {
      clearTimeout(abortWatchdog);
      controller.abort();
      emitSpy.mockRestore();
      await Promise.all(recoveryPaths.map((filePath) => fs.rm(filePath, { force: true })));
    }
  }, 30_000);

  it('passes sessionScratchDir to commands as KODAX_SESSION_TMP', async () => {
    const scratchDir = path.join(tempDir, '.agent', 'tmp', 'sessions', 'session-1');
    const command = 'node -e "console.log(process.env.KODAX_SESSION_TMP || \'missing\')"';

    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
      sessionScratchDir: scratchDir,
    });

    expect(result).toContain(scratchDir);
  });

  it('runs command in background and returns output file path', async () => {
    const command = 'node -e "console.log(\'bg-output\')"';
    const result = await toolBash({ command, run_in_background: true }, {
      backups: new Map(),
      executionCwd: tempDir,
      shellSandbox: passthroughShellSandbox(),
    });

    expect(result).toContain('Command started in background');
    expect(result).toContain('PID:');
    expect(result).toContain('Output:');
    expect(result).toContain('kodax-bg-');

    const outputMatch = result.match(/Output:\s*(.+)/);
    expect(outputMatch).toBeTruthy();
    const outputPath = outputMatch![1]!.trim();

    const deadline = Date.now() + 5_000;
    let content = '';
    while (Date.now() < deadline) {
      try {
        content = await fs.readFile(outputPath, 'utf-8');
        if (content.includes('[Exit:')) break;
      } catch {
        // File may not exist yet on the first poll iteration.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(content).toContain('bg-output');
    expect(content).toContain('[Exit:');
    await expect(withFileMutation(path.join(tempDir, 'after-fast-background.txt'), async () => 'ready'))
      .resolves.toBe('ready');
  });

  it('keeps a long-running background command alive while write and edit complete', async () => {
    const controller = new AbortController();
    const filePath = path.join(tempDir, 'background-concurrency.txt');
    const result = await toolBash({
      command: parentWatchedBackgroundCommand(),
      run_in_background: true,
    }, {
      backups: new Map(),
      executionCwd: tempDir,
      shellSandbox: passthroughShellSandbox(),
      abortSignal: controller.signal,
    });
    const pid = parseBackgroundPid(result);
    const outputPath = parseBackgroundOutputPath(result);
    await waitForOutputMatch(outputPath, /child-pid:(\d+)/);

    try {
      const ctx = {
        backups: new Map<string, string>(),
        executionCwd: tempDir,
      };
      await expect(toolWrite({ path: filePath, content: 'alpha\n' }, ctx))
        .resolves.toContain('File created');
      await expect(toolEdit({
        path: filePath,
        old_string: 'alpha',
        new_string: 'beta',
      }, ctx)).resolves.toContain('File edited');
      await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('beta\n');
      expect(isPidAlive(pid)).toBe(true);
    } finally {
      controller.abort();
      await waitForPidExit(pid, WINDOWS_PROCESS_TREE_EXIT_WAIT_MS);
    }
  }, WINDOWS_PROCESS_TREE_TEST_TIMEOUT_MS);

  it('records an unattested background execution without replaying it', async () => {
    const executionCount = path.join(tempDir, 'background-execution-count.txt');
    const script = [
      "const fs=require('node:fs')",
      `const file=${JSON.stringify(executionCount)}`,
      "const count=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0",
      "fs.writeFileSync(file,String(count+1))",
      "process.stdout.write('background-ran-once')",
    ].join(';');
    const shellSandbox: KodaXShellSandbox = {
      prepare: async () => ({
        executable: process.execPath,
        args: ['-e', script],
        env: process.env,
        cleanup: async () => {
          throw new Error('sandbox attestation missing');
        },
      }),
    };

    const result = await toolBash({
      command: 'background-unattested',
      run_in_background: true,
    }, {
      backups: new Map(),
      toolCallId: 'bash-background-unattested',
      shellSandbox,
    });
    const outputPath = parseBackgroundOutputPath(result);
    await waitForOutputMatch(outputPath, /Required OS sandbox execution could not be verified/);

    expect(await fs.readFile(executionCount, 'utf8')).toBe('1');
    const output = await fs.readFile(outputPath, 'utf8');
    expect(output).toContain('background-ran-once');
    expect(output).toContain('sandbox attestation missing');
    expect(output).toContain('was not retried');
    await fs.rm(outputPath, { force: true });
  });

  it.runIf(process.platform === 'win32')(
    'does not leak the retired effect-gate payload into the command environment',
    async () => {
      const command = 'node -e "process.stdout.write(process.env.KODAX_EFFECT_COMMAND_JSON===undefined?\'absent\':\'leaked\')"';
      const result = await toolBash({ command }, {
        backups: new Map(),
        executionCwd: tempDir,
      });

      expect(completedCommandBody(result)).toBe('absent');
    },
    WINDOWS_PROCESS_TREE_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform === 'win32')(
    'restores Electron Node mode only for a prepared JavaScript broker child',
    async () => {
      const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
      Object.defineProperty(process.versions, 'electron', {
        configurable: true,
        value: 'test-electron',
      });
      try {
        const shellSandbox: KodaXShellSandbox = {
          prepare: async () => ({
            executable: process.execPath,
            args: ['-e', "process.stdout.write(process.env.ELECTRON_RUN_AS_NODE??'absent')"],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            cleanup: async () => undefined,
          }),
        };
        const result = await toolBash({ command: 'prepared-electron-broker' }, {
          backups: new Map(),
          executionCwd: tempDir,
          toolCallId: 'prepared-electron-broker',
          shellSandbox,
        });

        expect(completedCommandBody(result)).toBe('1');

        const commandShell = process.env.COMSPEC ?? 'cmd.exe';
        const externalSandbox: KodaXShellSandbox = {
          prepare: async () => ({
            executable: commandShell,
            args: [
              '/d',
              '/s',
              '/c',
              'if defined ELECTRON_RUN_AS_NODE (echo leaked) else (echo absent)',
            ],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            cleanup: async () => undefined,
          }),
        };
        const externalResult = await toolBash({ command: 'prepared-external-child' }, {
          backups: new Map(),
          executionCwd: tempDir,
          toolCallId: 'prepared-external-child',
          shellSandbox: externalSandbox,
        });

        expect(completedCommandBody(externalResult).trim()).toBe('absent');
      } finally {
        if (electronDescriptor === undefined) delete process.versions.electron;
        else Object.defineProperty(process.versions, 'electron', electronDescriptor);
      }
    },
    WINDOWS_PROCESS_TREE_TEST_TIMEOUT_MS,
  );

  it('does not block the next shell when background log creation fails', async () => {
    const originalTemp = process.env.TEMP;
    const originalTmp = process.env.TMP;
    const originalTmpdir = process.env.TMPDIR;
    const blockedTemp = path.join(tempDir, 'background-temp-is-a-file');
    await fs.writeFile(blockedTemp, 'not a directory', 'utf8');
    process.env.TEMP = blockedTemp;
    process.env.TMP = blockedTemp;
    process.env.TMPDIR = blockedTemp;
    try {
      const failed = await toolBash({
        command: nodeOutputCommand('must-not-start'),
        run_in_background: true,
      }, {
        backups: new Map(),
        executionCwd: tempDir,
      });
      expect(failed).toContain('output file could not be created');
    } finally {
      if (originalTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = originalTemp;
      if (originalTmp === undefined) delete process.env.TMP;
      else process.env.TMP = originalTmp;
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    }

    const result = await toolBash({ command: nodeOutputCommand('next-shell-ran') }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(completedCommandBody(result)).toContain('next-shell-ran');
  });

  it('registers background commands for managed cleanup', async () => {
    const command = parentWatchedBackgroundCommand();
    const result = await toolBash({ command, run_in_background: true }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });
    const pid = parseBackgroundPid(result);
    const outputPath = parseBackgroundOutputPath(result);
    const childPid = Number((await waitForOutputMatch(outputPath, /child-pid:(\d+)/))[1]);
    expect(isPidAlive(pid)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    const summary = await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });

    expect(summary.killed).toBe(1);
    await Promise.all([
      expect(
        waitForPidExit(pid, WINDOWS_PROCESS_TREE_EXIT_WAIT_MS),
      ).resolves.toBe(true),
      expect(
        waitForPidExit(childPid, WINDOWS_PROCESS_TREE_EXIT_WAIT_MS, BACKGROUND_CHILD_MARKER),
      ).resolves.toBe(true),
    ]);
  }, WINDOWS_PROCESS_TREE_TEST_TIMEOUT_MS);

  it('cleans one sandbox request when durable child registration fails', async () => {
    managedRegistrationMock.failure = new Error('injected durable child registration failure');
    const cleanupSandbox = vi.fn(async () => undefined);
    const terminate = vi.fn(async (child: ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGKILL');
      await closed;
    });
    await expect(toolBash({ command: 'registration-failure', run_in_background: true }, {
      backups: new Map(),
      toolCallId: 'bash-registration-failure',
      shellSandbox: {
        prepare: async () => ({
          executable: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          env: process.env,
          processTreeContainment: 'native-job',
          processControl: {
            closeInput: async () => undefined,
            terminate,
          },
          cleanup: cleanupSandbox,
        }),
      },
    })).rejects.toThrow('injected durable child registration failure');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(managedRegistrationMock.unrefCalls).toBe(0);
    expect(terminate).toHaveBeenCalledOnce();
    expect(managedRegistrationMock.killCalls).toBe(0);
    expect(managedRegistrationMock.killSyncCalls).toBe(0);
    const childPid = managedRegistrationMock.child?.pid;
    if (childPid === undefined) throw new Error('expected unregistered child PID');
    await expect(waitForPidExit(childPid, 5_000)).resolves.toBe(true);
    await expect.poll(() => cleanupSandbox.mock.calls.length).toBe(1);
  });

  it('uses native process control when aborting a background command', async () => {
    const controller = new AbortController();
    const terminate = vi.fn(async (child: ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGKILL');
      await closed;
    });
    const result = await toolBash({ command: 'native-background', run_in_background: true }, {
      backups: new Map(),
      executionCwd: process.cwd(),
      abortSignal: controller.signal,
      shellSandbox: {
        prepare: async () => ({
          executable: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          env: process.env,
          processTreeContainment: 'native-job',
          processControl: {
            closeInput: async (child) => { child.stdin?.end(); },
            terminate,
          },
          cleanup: async () => undefined,
        }),
      },
    });
    const pid = parseBackgroundPid(result);
    controller.abort();

    await expect(waitForPidExit(pid, 5_000)).resolves.toBe(true);
    expect(terminate).toHaveBeenCalledOnce();
    expect(managedRegistrationMock.killCalls).toBe(0);
    expect(managedRegistrationMock.killSyncCalls).toBe(0);
  });

  it('stops background commands when the caller aborts', async () => {
    const controller = new AbortController();
    const command = parentWatchedBackgroundCommand();
    const result = await toolBash({ command, run_in_background: true }, {
      backups: new Map(),
      executionCwd: process.cwd(),
      abortSignal: controller.signal,
    });
    const pid = parseBackgroundPid(result);
    const outputPath = parseBackgroundOutputPath(result);
    const childPid = Number((await waitForOutputMatch(outputPath, /child-pid:(\d+)/))[1]);
    expect(isPidAlive(pid)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    controller.abort();

    await Promise.all([
      expect(
        waitForPidExit(pid, WINDOWS_PROCESS_TREE_EXIT_WAIT_MS),
      ).resolves.toBe(true),
      expect(
        waitForPidExit(childPid, WINDOWS_PROCESS_TREE_EXIT_WAIT_MS, BACKGROUND_CHILD_MARKER),
      ).resolves.toBe(true),
    ]);
  }, WINDOWS_PROCESS_TREE_TEST_TIMEOUT_MS);

  describe('live progress reporting (FEATURE_149)', () => {
    it('calls reportToolProgress with stdout tail during execution', async () => {
      const progressEvents: string[] = [];
      const command = `node -e "const lines=['alpha','beta','gamma','delta','epsilon']; (async()=>{ for(const l of lines){ console.log(l); await new Promise(r=>setTimeout(r,30)); }})()"`;
      const result = await toolBash({ command }, {
        backups: new Map(),
        executionCwd: tempDir,
        reportToolProgress: (msg) => {
          progressEvents.push(msg);
        },
      });

      expect(result).toContain('alpha');
      expect(result).toContain('epsilon');
      expect(progressEvents.length).toBeGreaterThan(0);
      const allEvents = progressEvents.join('\n');
      expect(allEvents).toContain('epsilon');
    });

    it('does not throw when reportToolProgress is undefined (back-compat)', async () => {
      const command = `node -e "console.log('quiet')"`;
      const result = await toolBash({ command }, {
        backups: new Map(),
        executionCwd: tempDir,
      });

      expect(result).toContain('quiet');
    });

    it('includes stderr in live progress', async () => {
      const progressEvents: string[] = [];
      const command = `node -e "process.stderr.write('warn-msg\\n'); console.log('done')"`;
      const result = await toolBash({ command }, {
        backups: new Map(),
        executionCwd: tempDir,
        reportToolProgress: (msg) => {
          progressEvents.push(msg);
        },
      });

      expect(result).toContain('done');
      const allEvents = progressEvents.join('\n');
      expect(allEvents).toMatch(/warn-msg|done/);
    });
  });
});
