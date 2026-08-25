import { EventEmitter, once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { readProcessStartIdentity, SkillRegistry } from '@kodax-ai/agent';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetFileSystemEffectLeasesForTests,
  acquireExclusiveFileSystemEffectLease,
  acquireFileSystemMutationLease,
  acquireHostFileSystemMutationLease,
} from '../packages/coding/src/tools/_internal/file-mutation-queue.js';
import { withTextFileMutation } from '../packages/coding/src/tools/_internal/text-file-mutation.js';
import type { KodaXToolExecutionContext } from '../packages/coding/src/types.js';

const capturedBrokerRequests = vi.hoisted(
  () => [] as Array<Readonly<Record<string, unknown>>>,
);
const capturedSpawnEnvironments = vi.hoisted(
  () => [] as NodeJS.ProcessEnv[],
);
const capturedSpawnArgv = vi.hoisted(
  () => [] as string[][],
);
const capturedSpawnCwds = vi.hoisted(
  () => [] as Array<string | undefined>,
);
const capturedSyncSpawns = vi.hoisted(
  () => [] as Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly input?: string;
  }>,
);
const capturedWrappedCommands = vi.hoisted(
  () => [] as string[],
);
const capturedWorkspaceSessionConfigs = vi.hoisted(
  () => [] as Array<Readonly<Record<string, unknown>>>,
);
const capturedWorkspaceRequests = vi.hoisted(
  () => [] as Array<Readonly<Record<string, unknown>>>,
);
const capturedStandaloneGateLaunches = vi.hoisted(
  () => [] as Array<{
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
  }>,
);
const capturedSandboxWrapConfigs = vi.hoisted(
  () => [] as Array<Readonly<Record<string, unknown>>>,
);
const capturedKillSignals = vi.hoisted(
  () => [] as Array<NodeJS.Signals | number | undefined>,
);
const capturedProcessTreeKillOptions = vi.hoisted(
  () => [] as Array<Readonly<Record<string, unknown>>>,
);
const capturedDiagnostics = vi.hoisted(
  () => [] as Array<Readonly<Record<string, unknown>>>,
);
const textMutationChildren = vi.hoisted(() => new WeakSet<object>());
const aclRecoveryGateChildren = vi.hoisted(() => new WeakSet<object>());
const textMutationStdinMock = vi.hoisted(() => ({
  failNext: false,
  observedErrorListener: false,
}));
const boundedMetadataReadMock = vi.hoisted(() => ({
  trackedPaths: new Set<string>(),
  fullReads: [] as string[],
}));
const processTreeKillMock = vi.hoisted(() => ({
  outcome: 'actual' as 'actual' | 'unknown' | 'close_then_unknown' | 'close_then_reject',
  childPid: undefined as number | undefined,
  releaseUnknown: undefined as (() => void) | undefined,
}));
const textMutationEffectLeaseMock = vi.hoisted(() => ({
  bindFailure: undefined as string | undefined,
  releaseFailureOnCall: undefined as number | undefined,
  bindCalls: 0,
  releaseCalls: 0,
}));
const windowsEffectJobMock = vi.hoisted(() => ({
  aclRecoveryDrainFailure: undefined as string | undefined,
  containCalls: 0,
  containFailureOnCall: undefined as number | undefined,
  terminateOutcome: 'drained' as 'drained' | 'not_found',
  drainFailure: undefined as string | undefined,
  textMutationDrainFailure: undefined as string | undefined,
  drainFailureOnCall: undefined as number | undefined,
  drainPending: false,
  releaseDrain: undefined as (() => void) | undefined,
  unrefCalls: 0,
  latestChild: undefined as (EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdio: [PassThrough, PassThrough, PassThrough, PassThrough];
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  }) | undefined,
  containedChild: undefined as (EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdio: [PassThrough, PassThrough, PassThrough, PassThrough];
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  }) | undefined,
  aclRecoveryUncontainedStarts: 0,
}));
const standaloneBrokerDetachMock = vi.hoisted(() => ({
  childUnrefCalls: 0,
  stdinUnrefCalls: 0,
  stdoutUnrefCalls: 0,
  stderrUnrefCalls: 0,
}));
const standaloneFenceReleaseMock = vi.hoisted(() => ({ failures: 0 }));
const processIdentityMock = vi.hoisted(() => ({
  windowsBootIdentity: 'windows-boot-100' as string | undefined,
  pid4StartIdentity: '13370000000000' as string | undefined,
  unreadablePids: new Set<number>(),
}));
const recoveryLockMock = vi.hoisted(() => ({
  timeoutFailures: 0,
  timeoutOnCall: undefined as number | undefined,
  calls: 0,
  releaseFailures: 0,
  effectCalls: 0,
  effectFailureStartCall: undefined as number | undefined,
  beforeOperation: undefined as (() => void | Promise<void>) | undefined,
}));
const fileSystemMock = vi.hoisted(() => ({
  rmFailurePath: undefined as string | undefined,
  writeBrokerRequestFailure: false,
  writeAclPoisonMarkerFailure: false,
  renameAclPoisonMarkerFailures: 0,
  aclPoisonMarkerWriteTargets: [] as string[],
}));
const stubbornBroker = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'silent' | 'overflow',
}));
const deferredBrokerRead = vi.hoisted(() => ({
  enabled: false,
  missing: false,
}));
const sandboxInitialize = vi.hoisted(
  () => vi.fn<() => Promise<void>>(() => Promise.resolve()),
);
const sandboxWrapper = vi.hoisted(() => ({
  mode: 'attest' as 'attest' | 'late_marker' | 'missing' | 'spawn_error',
}));
const workspaceSessionControl = vi.hoisted(() => ({
  delayReady: false,
  releaseReady: undefined as (() => void) | undefined,
  delayWrap: false,
  releaseWrap: undefined as (() => void) | undefined,
  wrapFailure: undefined as string | undefined,
  cleanupFailure: undefined as string | undefined,
  cleanupFailureOnCall: undefined as number | undefined,
  delayCleanup: false,
  releaseCleanup: undefined as (() => void) | undefined,
  afterWrapResponse: undefined as (() => void) | undefined,
  cleanupRequests: 0,
  malformedReady: false,
  beforeReady: undefined as (() => void) | undefined,
  malformedResponseFor: undefined as 'wrap' | 'cleanup' | undefined,
  delayClose: false,
  releaseClose: undefined as (() => void) | undefined,
  closeExitCode: 0,
}));
const windowsSandboxMock = vi.hoisted(() => ({
  runnerSource: '',
  wfpOutcome: 'blocked' as 'blocked' | 'access_denied' | 'timeout',
  aclRecoveryOutcome: 'success' as 'success' | 'failure' | 'malformed',
  aclRecoveryOutcomes: [] as Array<'success' | 'failure' | 'malformed'>,
  sidProcessesActive: true,
  sidInspectionCalls: 0,
  sidProbeLaunches: [] as Array<Readonly<Record<string, unknown>>>,
  sidInspectionFailure: undefined as string | undefined,
  guardReady: true,
  user: {
    provisioned: true,
    sid: 'S-1-5-21-1000',
    groupExists: true,
    groupSid: 'S-1-5-21-1001',
    inBuiltinUsers: true,
    inSandboxGroup: true,
    hiddenFromLogon: true,
    credPresent: true,
    markerVersion: 1,
    realUserSid: 'S-1-5-21-1002',
  },
  grantFailure: undefined as string | undefined,
  grants: [] as Array<Readonly<Record<string, unknown>>>,
  revokes: [] as Array<Readonly<Record<string, unknown>>>,
  installCalls: 0,
  installOptions: [] as Array<Readonly<Record<string, unknown>>>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: vi.fn(async (target: string | URL, options?: Parameters<typeof actual.rm>[1]) => {
      if (typeof target === 'string' && target === fileSystemMock.rmFailurePath) {
        throw Object.assign(new Error('injected rm EPERM'), { code: 'EPERM' });
      }
      await actual.rm(target, options);
    }),
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      const target = args[0];
      if (
        fileSystemMock.writeBrokerRequestFailure
        && typeof target === 'string'
        && path.basename(target).startsWith('kodax-asrt-')
      ) {
        throw Object.assign(new Error('injected broker request write failure'), { code: 'EPERM' });
      }
      await actual.writeFile(...args);
    }),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
      const target = args[0];
      if (typeof target === 'string' && boundedMetadataReadMock.trackedPaths.has(path.resolve(target))) {
        boundedMetadataReadMock.fullReads.push(path.resolve(target));
      }
      return actual.readFileSync(...args);
    }),
    renameSync: vi.fn((
      oldPath: Parameters<typeof actual.renameSync>[0],
      newPath: Parameters<typeof actual.renameSync>[1],
    ) => {
      if (
        fileSystemMock.renameAclPoisonMarkerFailures > 0
        && typeof newPath === 'string'
        && path.basename(newPath).startsWith('recovery-owner-')
      ) {
        fileSystemMock.renameAclPoisonMarkerFailures -= 1;
        throw Object.assign(new Error('injected ACL poison marker rename failure'), { code: 'EPERM' });
      }
      return actual.renameSync(oldPath, newPath);
    }),
    writeFileSync: vi.fn((
      target: Parameters<typeof actual.writeFileSync>[0],
      data: Parameters<typeof actual.writeFileSync>[1],
      options?: Parameters<typeof actual.writeFileSync>[2],
    ) => {
      if (
        typeof target === 'string'
        && path.basename(path.dirname(target)).startsWith('acl-poison')
      ) {
        fileSystemMock.aclPoisonMarkerWriteTargets.push(target);
      }
      if (
        fileSystemMock.writeAclPoisonMarkerFailure
        && typeof target === 'string'
        && path.basename(path.dirname(target)).startsWith('acl-poison')
      ) {
        throw Object.assign(new Error('injected ACL poison marker write failure'), { code: 'EPERM' });
      }
      return actual.writeFileSync(target, data, options);
    }),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn((
      command: string,
      args: readonly string[] = [],
      options?: { readonly cwd?: string; readonly input?: string },
    ) => {
      capturedSyncSpawns.push({
        command,
        args: [...args],
        cwd: options?.cwd,
        input: options?.input,
      });
      if (command === process.execPath && args.length === 1 && args[0] === '--version') {
        return {
          status: 0,
          signal: null,
          stdout: `${process.version}\n`,
          stderr: '',
        };
      }
      const encodedIndex = args.indexOf('-EncodedCommand');
      if (encodedIndex >= 0) {
        const script = Buffer.from(args[encodedIndex + 1] ?? '', 'base64').toString('utf16le');
        if (script.includes('KodaXWindowsBootIdentity-v1')) {
          return {
            status: processIdentityMock.windowsBootIdentity === undefined ? 1 : 0,
            signal: null,
            stdout: processIdentityMock.windowsBootIdentity?.replace('windows-boot-', '') ?? '',
            stderr: '',
          };
        }
        if (script.includes('KodaXAsrtAclGuard-v1')) {
          const payload = JSON.parse(options?.input ?? '{}') as {
            readonly install?: boolean;
            readonly paths?: readonly { readonly path: string }[];
          };
          const missing = windowsSandboxMock.guardReady || payload.install === true
            ? []
            : (payload.paths ?? []).map((entry) => entry.path);
          if (payload.install === true) windowsSandboxMock.guardReady = true;
          return {
            status: 0,
            signal: null,
            stdout: JSON.stringify({ missing }),
            stderr: '',
          };
        }
      }
      if (args.includes('wfp') && args.includes('verify')) {
        if (windowsSandboxMock.wfpOutcome === 'timeout') {
          return {
            status: null,
            signal: 'SIGTERM',
            stdout: '',
            stderr: '',
            error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
          };
        }
        if (windowsSandboxMock.wfpOutcome === 'access_denied') {
          return {
            status: 1,
            signal: null,
            stdout: '',
            stderr: 'CreateProcessWithLogonW(srt-sandbox): 拒绝访问。 (0x80070005)',
          };
        }
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({
            egress_probe: 'blocked',
            target: '127.0.0.1:49152',
            runner_exit: 0,
          }),
          stderr: 'BLOCKED',
        };
      }
      if (args.includes('acl') && args.includes('recover')) {
        const outcome = windowsSandboxMock.aclRecoveryOutcomes.shift()
          ?? windowsSandboxMock.aclRecoveryOutcome;
        if (outcome === 'failure') {
          return {
            status: 1,
            signal: null,
            stdout: '',
            stderr: 'injected ACL recovery failure',
          };
        }
        return {
          status: 0,
          signal: null,
          stdout: outcome === 'malformed'
            ? 'not-json'
            : JSON.stringify({ deadBrokers: 1, acesRevoked: 2 }),
          stderr: '',
        };
      }
      return actual.spawnSync(command, args, options);
    }),
    spawn: vi.fn((
      command: string,
      argsOrOptions?: readonly string[] | object,
      explicitOptions?: object,
    ) => {
      if (Array.isArray(argsOrOptions)) {
        capturedSpawnArgv.push([command, ...argsOrOptions]);
      }
      const options = Array.isArray(argsOrOptions) ? explicitOptions : argsOrOptions;
      if (options !== undefined) {
        const environment = (options as { readonly env?: NodeJS.ProcessEnv }).env;
        if (environment !== undefined) capturedSpawnEnvironments.push(environment);
        capturedSpawnCwds.push((options as { readonly cwd?: string }).cwd);
      }
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        stdio: [PassThrough, PassThrough, PassThrough, PassThrough];
        kill: ReturnType<typeof vi.fn>;
        ref: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
        pid: number | undefined;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const control = new PassThrough();
      child.stdio = [child.stdin, child.stdout, child.stderr, control];
      child.ref = vi.fn();
      child.unref = vi.fn(() => { standaloneBrokerDetachMock.childUnrefCalls += 1; });
      Reflect.set(
        child.stdin,
        'unref',
        vi.fn(() => { standaloneBrokerDetachMock.stdinUnrefCalls += 1; }),
      );
      Reflect.set(
        child.stdout,
        'unref',
        vi.fn(() => { standaloneBrokerDetachMock.stdoutUnrefCalls += 1; }),
      );
      Reflect.set(
        child.stderr,
        'unref',
        vi.fn(() => { standaloneBrokerDetachMock.stderrUnrefCalls += 1; }),
      );
      child.pid = processTreeKillMock.childPid;
      child.exitCode = null;
      child.signalCode = null;
      windowsEffectJobMock.latestChild = child;
      child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
        capturedKillSignals.push(signal);
        if (signal === 'SIGKILL') {
          queueMicrotask(() => {
            child.signalCode = 'SIGKILL';
            child.stdout.end();
            child.stderr.end();
            child.emit('close', null, 'SIGKILL');
            child.emit('exit', null, 'SIGKILL');
          });
        }
        return true;
      });
      const spawnArgs = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      if (spawnArgs.includes('acl') && spawnArgs.includes('recover')) {
        capturedSyncSpawns.push({
          command,
          args: [...spawnArgs],
          cwd: (explicitOptions as { readonly cwd?: string } | undefined)?.cwd,
        });
        const outcome = windowsSandboxMock.aclRecoveryOutcomes.shift()
          ?? windowsSandboxMock.aclRecoveryOutcome;
        queueMicrotask(() => {
          child.emit('spawn');
          if (outcome === 'failure') {
            child.stderr.end('injected ACL recovery failure');
            child.stdout.end();
            child.exitCode = 1;
            child.emit('close', 1, null);
            child.emit('exit', 1, null);
            return;
          }
          child.stdout.end(outcome === 'malformed'
            ? 'not-json'
            : JSON.stringify({ deadBrokers: 1, acesRevoked: 2 }));
          child.stderr.end();
          child.exitCode = 0;
          child.emit('close', 0, null);
          child.emit('exit', 0, null);
        });
        return child;
      }
      let requestFile = Array.isArray(argsOrOptions) ? argsOrOptions.at(-1) : undefined;
      const standaloneGate = typeof requestFile === 'string'
        && path.basename(requestFile).startsWith('kodax-asrt-gate-');
      let aclRecoveryGate = false;
      if (standaloneGate) {
        child.pid ??= process.pid;
        const gate = JSON.parse(readFileSync(requestFile, 'utf8')) as {
          readonly command: string;
          readonly args: readonly string[];
          readonly cwd?: string;
          readonly env: NodeJS.ProcessEnv;
        };
        aclRecoveryGate = gate.args.includes('acl') && gate.args.includes('recover');
        if (aclRecoveryGate) {
          capturedSyncSpawns.push({
            command: gate.command,
            args: [...gate.args],
            cwd: gate.cwd,
          });
        } else {
          capturedStandaloneGateLaunches.push(gate);
        }
        requestFile = gate.args.at(-1);
      }
      if (aclRecoveryGate) {
        aclRecoveryGateChildren.add(child);
        let gateInput = '';
        child.stdin.on('data', (chunk: Buffer) => { gateInput += chunk.toString('utf8'); });
        child.stdin.once('finish', () => {
          if (gateInput.trim() !== 'go') {
            child.emit('close', 125, null);
            child.emit('exit', 125, null);
            return;
          }
          if (windowsEffectJobMock.containedChild !== child) {
            windowsEffectJobMock.aclRecoveryUncontainedStarts += 1;
          }
          const outcome = windowsSandboxMock.aclRecoveryOutcomes.shift()
            ?? windowsSandboxMock.aclRecoveryOutcome;
          queueMicrotask(() => {
            child.emit('spawn');
            if (outcome === 'failure') {
              child.stderr.end('injected ACL recovery failure');
              child.stdout.end();
              child.exitCode = 1;
              child.emit('close', 1, null);
              child.emit('exit', 1, null);
              return;
            }
            child.stdout.end(outcome === 'malformed'
              ? 'not-json'
              : JSON.stringify({ deadBrokers: 1, acesRevoked: 2 }));
            child.stderr.end();
            child.exitCode = 0;
            child.emit('close', 0, null);
            child.emit('exit', 0, null);
          });
        });
        return child;
      }
      const workspaceSession = Array.isArray(argsOrOptions)
        && typeof requestFile === 'string'
        && path.basename(requestFile).startsWith('workspace-')
        && requestFile.endsWith('.json');
      if (workspaceSession) {
        child.pid ??= process.pid;
        if (typeof requestFile === 'string') {
          const init = JSON.parse(readFileSync(requestFile, 'utf8')) as {
            readonly config: Readonly<Record<string, unknown>>;
          };
          capturedWorkspaceSessionConfigs.push(init.config);
          rmSync(requestFile, { force: true });
        }
        let input = '';
        let workspaceGateAuthorized = !standaloneGate;
        child.stdin.on('data', (chunk: Buffer) => {
          input += chunk.toString('utf8');
          let newline = input.indexOf('\n');
          while (newline >= 0) {
            const line = input.slice(0, newline);
            input = input.slice(newline + 1);
            if (!workspaceGateAuthorized && line === 'go') {
              workspaceGateAuthorized = true;
              newline = input.indexOf('\n');
              continue;
            }
            const message = JSON.parse(line) as {
              readonly id: string;
              readonly type: 'wrap' | 'cleanup';
              readonly request?: Readonly<Record<string, unknown>> & {
                readonly targetStartedMarker?: string;
              };
            };
            if (message.type === 'wrap' && message.request !== undefined) {
              capturedWorkspaceRequests.push(message.request);
            }
            if (message.type === 'cleanup') workspaceSessionControl.cleanupRequests += 1;
            const cleanupFailure = workspaceSessionControl.cleanupFailure
              ?? (workspaceSessionControl.cleanupFailureOnCall
                === workspaceSessionControl.cleanupRequests
                ? 'injected transient cleanup failure'
                : undefined);
            const response = message.type === 'wrap'
              ? workspaceSessionControl.wrapFailure === undefined ? {
                  id: message.id,
                  type: 'result',
                  ok: true,
                  invocation: {
                    executable: process.execPath,
                    args: ['--version'],
                    env: {},
                    shell: false,
                  },
                } : {
                  id: message.id,
                  type: 'result',
                  ok: false,
                  error: workspaceSessionControl.wrapFailure,
                }
              : cleanupFailure === undefined
                ? { id: message.id, type: 'result', ok: true }
                : {
                    id: message.id,
                    type: 'result',
                    ok: false,
                    error: cleanupFailure,
                  };
            const reportResponse = (): void => {
              control.write(workspaceSessionControl.malformedResponseFor === message.type
                ? `${JSON.stringify({ type: 'unexpected' })}\n`
                : `${JSON.stringify(response)}\n`);
              if (message.type === 'wrap') workspaceSessionControl.afterWrapResponse?.();
            };
            if (message.type === 'wrap' && workspaceSessionControl.delayWrap) {
              workspaceSessionControl.releaseWrap = reportResponse;
            } else if (message.type === 'cleanup' && workspaceSessionControl.delayCleanup) {
              workspaceSessionControl.releaseCleanup = reportResponse;
            } else {
              reportResponse();
            }
            newline = input.indexOf('\n');
          }
        });
        child.stdin.once('finish', () => {
          if (stubbornBroker.mode !== 'none') return;
          const completeClose = (): void => {
            control.end();
            child.exitCode = workspaceSessionControl.closeExitCode;
            child.emit('exit', workspaceSessionControl.closeExitCode, null);
            child.emit('close', workspaceSessionControl.closeExitCode, null);
          };
          if (workspaceSessionControl.delayClose) {
            workspaceSessionControl.releaseClose = completeClose;
          } else {
            completeClose();
          }
        });
        queueMicrotask(() => {
          child.emit('spawn');
          const reportReady = (): void => {
            workspaceSessionControl.beforeReady?.();
            control.write(workspaceSessionControl.malformedReady
              ? '{malformed\n'
              : `${JSON.stringify({ type: 'ready', ok: true })}\n`);
          };
          if (workspaceSessionControl.delayReady) {
            workspaceSessionControl.releaseReady = reportReady;
          } else {
            reportReady();
          }
        });
        return child;
      }
      let brokerRequest: Readonly<Record<string, unknown>> | undefined;
      const captureRequest = (): void => {
        if (typeof requestFile !== 'string' || !requestFile.endsWith('.json')) return;
        const request = JSON.parse(readFileSync(requestFile, 'utf8')) as { readonly cwd?: string };
        brokerRequest = request;
        capturedBrokerRequests.push(request);
        if (request.cwd) {
          mkdirSync(path.join(request.cwd, 'outputs'), { recursive: true });
          writeFileSync(path.join(request.cwd, 'outputs', 'report.txt'), 'report');
        }
      };
      const complete = (): void => {
        if (sandboxWrapper.mode === 'spawn_error') {
          sandboxWrapper.mode = 'attest';
          child.stderr.end('wrapper spawn failed');
          child.emit('error', new Error('wrapper spawn failed'));
          child.emit('close', null, null);
          return;
        }
        child.emit('spawn');
        child.stdout.end('sandbox output');
        if (
          sandboxWrapper.mode === 'attest'
          || sandboxWrapper.mode === 'late_marker'
        ) {
          const wrappedCommand = capturedWrappedCommands.at(-1);
          const encoded = wrappedCommand?.trim().split(/\s+/).at(-1);
          if (encoded !== undefined) {
            const payload = JSON.parse(
              Buffer.from(encoded, 'base64').toString('utf8'),
            ) as { readonly targetStartedMarker?: string };
            if (payload.targetStartedMarker !== undefined) {
              if (sandboxWrapper.mode === 'late_marker') {
                child.emit('exit', 0, null);
              }
              child.stderr.write(payload.targetStartedMarker);
            }
          }
        }
        child.stderr.end();
        child.emit('close', sandboxWrapper.mode === 'missing' ? 1 : 0);
        if (sandboxWrapper.mode !== 'late_marker') {
          child.emit('exit', sandboxWrapper.mode === 'missing' ? 1 : 0, null);
        }
      };
      if (standaloneGate) {
        let gateInput = '';
        child.stdin.on('data', (chunk: Buffer) => { gateInput += chunk.toString('utf8'); });
        child.stdin.once('finish', () => {
          if (gateInput.trim() !== 'go') {
            child.emit('close', 125, null);
            child.emit('exit', 125, null);
            return;
          }
          captureRequest();
          if (stubbornBroker.mode !== 'none') {
            queueMicrotask(() => child.emit('spawn'));
            if (stubbornBroker.mode === 'overflow') {
              queueMicrotask(() => child.stdout.write('output-over-limit'));
            }
            return;
          }
          queueMicrotask(complete);
        });
        return child;
      }
      if (deferredBrokerRead.enabled && typeof requestFile === 'string') {
        setImmediate(() => {
          try {
            captureRequest();
          } catch {
            deferredBrokerRead.missing = true;
          }
          complete();
        });
        return child;
      }
      captureRequest();
      const textMutationRequest = brokerRequest as {
        readonly args?: readonly string[];
        readonly observationFile?: string;
        readonly targetStartedMarker?: string;
      } | undefined;
      if (textMutationRequest?.args?.some((arg) => arg.includes('Text mutation target'))) {
        textMutationChildren.add(child);
        let stdin = '';
        child.stdin.on('data', (chunk: Buffer) => { stdin += chunk.toString('utf8'); });
        child.stdin.once('finish', () => {
          if (textMutationStdinMock.failNext) {
            textMutationStdinMock.failNext = false;
            textMutationStdinMock.observedErrorListener = child.stdin.listenerCount('error') > 0;
            child.stdout.end();
            child.stderr.end('injected text helper stdin failure');
            if (textMutationStdinMock.observedErrorListener) {
              child.stdin.emit('error', new Error('injected text helper stdin failure'));
            }
            child.emit('close', 1, null);
            child.emit('exit', 1, null);
            return;
          }
          const attest = (): void => {
            if (textMutationRequest.observationFile !== undefined) {
              writeFileSync(textMutationRequest.observationFile, JSON.stringify({
                version: 1,
                state: 'applied',
                backend: process.platform === 'win32' ? 'windows-restricted-user' : 'linux-bubblewrap',
                policyId: 'kodax-workspace-shell-v1',
              }));
            }
            if (textMutationRequest.targetStartedMarker !== undefined) {
              child.stderr.write(textMutationRequest.targetStartedMarker);
            }
          };
          try {
          const payload = JSON.parse(stdin) as {
            readonly action: 'read' | 'write';
            readonly path: string;
            readonly content?: string;
            readonly expectedRevision?: string;
            readonly createParentDirectories?: boolean;
          };
          const assertSingleLink = (stats: { readonly nlink: number | bigint }): void => {
            if (BigInt(stats.nlink) !== 1n) {
              throw new Error('Text mutation target must not be hard-linked.');
            }
          };
          const revision = (content: string, stats: ReturnType<typeof fstatSync>): string => (
            `present:${createHash('sha256')
              .update(stats.dev.toString())
              .update(':')
              .update(stats.ino.toString())
              .update(':')
              .update(stats.nlink.toString())
              .update('\0')
              .update(content)
              .digest('hex')}`
          );
          const snapshot = () => {
            let descriptor: number;
            try {
              descriptor = openSync(payload.path, 'r');
            } catch (error: unknown) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return {
                  state: 'missing' as const,
                  content: '',
                  revision: 'missing',
                  backupPath: path.resolve(payload.path),
                };
              }
              throw error;
            }
            try {
              const content = readFileSync(descriptor, 'utf8');
              const stats = fstatSync(descriptor, { bigint: true });
              assertSingleLink(stats);
              const backupPath = realpathSync.native(payload.path);
              const canonicalDescriptor = openSync(backupPath, 'r');
              try {
                const canonicalStats = fstatSync(canonicalDescriptor, { bigint: true });
                assertSingleLink(canonicalStats);
                if (canonicalStats.dev !== stats.dev || canonicalStats.ino !== stats.ino) {
                  throw new Error('Text mutation target identity changed while reading.');
                }
              } finally {
                closeSync(canonicalDescriptor);
              }
              return {
                state: 'present' as const,
                content,
                revision: revision(content, stats),
                backupPath,
              };
            } finally {
              closeSync(descriptor);
            }
          };
          const writeFully = (descriptor: number, content: string): void => {
            const encoded = Buffer.from(content, 'utf8');
            let written = 0;
            while (written < encoded.length) {
              const count = writeSync(
                descriptor,
                encoded,
                written,
                encoded.length - written,
                written,
              );
              if (count === 0) throw new Error('Text mutation write made no progress.');
              written += count;
            }
            ftruncateSync(descriptor, encoded.length);
          };
          const writeMutation = (): 'conflict' | 'written' => {
            if (payload.createParentDirectories) {
              mkdirSync(path.dirname(payload.path), { recursive: true });
            }
            let descriptor: number | undefined;
            try {
              if (payload.expectedRevision === 'missing') {
                descriptor = openSync(payload.path, 'wx');
                assertSingleLink(fstatSync(descriptor, { bigint: true }));
              } else {
                descriptor = openSync(payload.path, 'r+');
                const content = readFileSync(descriptor, 'utf8');
                const stats = fstatSync(descriptor, { bigint: true });
                assertSingleLink(stats);
                if (revision(content, stats) !== payload.expectedRevision) return 'conflict';
              }
              writeFully(descriptor, payload.content ?? '');
              return 'written';
            } catch (error: unknown) {
              if (
                payload.expectedRevision === 'missing'
                && (error as NodeJS.ErrnoException).code === 'EEXIST'
              ) return 'conflict';
              throw error;
            } finally {
              if (descriptor !== undefined) closeSync(descriptor);
            }
          };
          child.emit('spawn');
          if (payload.action === 'read') {
            child.stdout.end(JSON.stringify({ status: 'ok', snapshot: snapshot() }));
          } else if (writeMutation() === 'conflict') {
            child.stdout.end(JSON.stringify({ status: 'conflict' }));
          } else {
            child.stdout.end(JSON.stringify({ status: 'written' }));
          }
          attest();
          child.stderr.end();
          child.emit('close', 0, null);
          child.emit('exit', 0, null);
          } catch (error: unknown) {
            attest();
            child.stdout.end();
            child.stderr.end(error instanceof Error ? error.message : String(error));
            child.emit('close', 1, null);
            child.emit('exit', 1, null);
          }
        });
        return child;
      }
      if (stubbornBroker.mode !== 'none') {
        queueMicrotask(() => child.emit('spawn'));
        if (stubbornBroker.mode === 'overflow') {
          queueMicrotask(() => child.stdout.write('output-over-limit'));
        }
        return child;
      }
      queueMicrotask(complete);
      return child;
    }),
  };
});

function capturedWorkspaceOwnerArgv(): string[][] {
  const isWorkspaceOwner = (argv: readonly string[]): boolean => argv.some((arg) => (
    arg.includes('sandbox-workspace-session')
    || arg === '__asrt-workspace-session'
  ));
  return [
    ...capturedSpawnArgv.filter(isWorkspaceOwner),
    ...capturedStandaloneGateLaunches
      .map((launch) => [process.execPath, ...launch.args])
      .filter(isWorkspaceOwner),
  ];
}

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return {
    ...actual,
    emitKodaXDiagnostic: (diagnostic: Readonly<Record<string, unknown>>) => {
      capturedDiagnostics.push(diagnostic);
      actual.emitKodaXDiagnostic(diagnostic);
    },
    acquireKodaXFileLock: async (
      lockPath: string,
      acquireTimeoutMs?: number,
    ) => {
      if (lockPath.endsWith('model-filesystem-effects.lock')) {
        recoveryLockMock.effectCalls += 1;
        if (
          recoveryLockMock.effectFailureStartCall !== undefined
          && recoveryLockMock.effectCalls >= recoveryLockMock.effectFailureStartCall
        ) {
          throw new Error('injected filesystem-effect coordinator failure');
        }
      }
      return actual.acquireKodaXFileLock(lockPath, acquireTimeoutMs);
    },
    containWindowsEffectProcess: (pid: number) => {
      windowsEffectJobMock.containCalls += 1;
      if (windowsEffectJobMock.containFailureOnCall === windowsEffectJobMock.containCalls) {
        return Promise.reject(new Error('injected Windows Job containment failure'));
      }
      const containedChild = windowsEffectJobMock.latestChild;
      windowsEffectJobMock.containedChild = containedChild;
      const drainFailure = containedChild !== undefined && aclRecoveryGateChildren.has(containedChild)
        ? windowsEffectJobMock.aclRecoveryDrainFailure
        : containedChild !== undefined && textMutationChildren.has(containedChild)
          ? windowsEffectJobMock.textMutationDrainFailure
          : windowsEffectJobMock.drainFailureOnCall === undefined
            || windowsEffectJobMock.drainFailureOnCall === windowsEffectJobMock.containCalls
            ? windowsEffectJobMock.drainFailure
            : undefined;
      const drainPending = containedChild !== undefined
        && !aclRecoveryGateChildren.has(containedChild)
        && windowsEffectJobMock.drainPending;
      const drained = drainPending
        ? new Promise<void>((resolve) => { windowsEffectJobMock.releaseDrain = resolve; })
        : drainFailure === undefined
          ? new Promise<void>((resolve) => {
              if (
                containedChild === undefined
                || containedChild.exitCode !== null
                || containedChild.signalCode !== null
              ) {
                resolve();
              } else {
                containedChild.once('exit', () => resolve());
              }
            })
          : Promise.reject(new Error(drainFailure));
      void drained.catch(() => undefined);
      return Promise.resolve({
        drained,
        supervisorPid: pid,
        jobName: 'Global\\KodaXEffect-00000000-0000-4000-8000-000000000001',
        unref: () => { windowsEffectJobMock.unrefCalls += 1; },
      });
    },
    terminateWindowsEffectJob: () => {
      windowsEffectJobMock.releaseDrain?.();
      const containedChild = windowsEffectJobMock.containedChild;
      if (
        windowsEffectJobMock.terminateOutcome === 'drained'
        && containedChild !== undefined
        && containedChild.exitCode === null
        && containedChild.signalCode === null
      ) {
        queueMicrotask(() => {
          containedChild.signalCode = 'SIGKILL';
          containedChild.stdout.end();
          containedChild.stderr.end();
          containedChild.stdio[3].end();
          containedChild.emit('exit', null, 'SIGKILL');
          containedChild.emit('close', null, 'SIGKILL');
        });
      }
      return Promise.resolve(windowsEffectJobMock.terminateOutcome);
    },
    windowsSandboxSidHasOtherProcesses: (
      sid: string,
      launcher: Readonly<Record<string, unknown>>,
    ) => {
      windowsSandboxMock.sidInspectionCalls += 1;
      windowsSandboxMock.sidProbeLaunches.push({ sid, launcher });
      if (windowsSandboxMock.sidInspectionFailure !== undefined) {
        return Promise.reject(new Error(windowsSandboxMock.sidInspectionFailure));
      }
      return Promise.resolve(windowsSandboxMock.sidProcessesActive);
    },
    readProcessStartIdentity: (pid: number) => (
      processIdentityMock.unreadablePids.has(pid)
        ? undefined
        : pid === 4
        ? processIdentityMock.pid4StartIdentity
        : actual.readProcessStartIdentity(pid)
    ),
    killChildProcessTree: (
      child: Parameters<typeof actual.killChildProcessTree>[0],
      options: Parameters<typeof actual.killChildProcessTree>[1] = {},
    ) => {
      capturedProcessTreeKillOptions.push({ ...options });
      if (
        textMutationChildren.has(child)
        && processTreeKillMock.outcome === 'actual'
        && child.stdout?.readableEnded
      ) {
        return Promise.resolve({ status: 'already-exited' as const });
      }
      if (processTreeKillMock.outcome === 'unknown') {
        processTreeKillMock.releaseUnknown = () => {
          child.emit('exit', null, 'SIGKILL');
          child.emit('close', null, 'SIGKILL');
        };
        return Promise.resolve({ status: 'unknown' as const });
      }
      if (
        processTreeKillMock.outcome === 'close_then_unknown'
        || processTreeKillMock.outcome === 'close_then_reject'
      ) {
        const outcome = processTreeKillMock.outcome;
        queueMicrotask(() => {
          child.emit('close', null, 'SIGTERM');
          child.emit('exit', null, 'SIGTERM');
        });
        return new Promise<{ readonly status: 'unknown' }>((resolve, reject) => {
          processTreeKillMock.releaseUnknown = () => {
            if (outcome === 'close_then_reject') {
              reject(new Error('injected delayed process-tree termination failure'));
            } else {
              resolve({ status: 'unknown' });
            }
          };
        });
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // Synthetic children still record the termination attempt.
      }
      try {
        child.kill('SIGKILL');
      } catch {
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      }
      return Promise.resolve({ status: 'terminated' as const });
    },
    withKodaXFileLock: async <T>(
      lockPath: string,
      operation: () => Promise<T>,
      acquireTimeoutMs?: number,
    ): Promise<T> => {
      if (lockPath.endsWith('acl-recovery.lock')) {
        recoveryLockMock.calls += 1;
        if (
          recoveryLockMock.timeoutFailures > 0
          || recoveryLockMock.timeoutOnCall === recoveryLockMock.calls
        ) {
          recoveryLockMock.timeoutFailures = Math.max(0, recoveryLockMock.timeoutFailures - 1);
          throw new actual.KodaXFileLockTimeoutError(lockPath);
        }
        await recoveryLockMock.beforeOperation?.();
      }
      const result = await actual.withKodaXFileLock(lockPath, operation, acquireTimeoutMs);
      if (lockPath.endsWith('acl-recovery.lock') && recoveryLockMock.releaseFailures > 0) {
        recoveryLockMock.releaseFailures -= 1;
        throw new Error(`injected recovery lock release failure: ${lockPath}`);
      }
      return result;
    },
  };
});

vi.mock('@kodax-ai/coding/internal/file-system-effects', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@kodax-ai/coding/internal/file-system-effects')
  >();
  return {
    ...actual,
    finishAndReleaseFileSystemEffectLease: async (
      lease: Parameters<typeof actual.finishAndReleaseFileSystemEffectLease>[0],
    ) => {
      if (standaloneFenceReleaseMock.failures > 0) {
        standaloneFenceReleaseMock.failures -= 1;
        throw new Error('injected standalone fence release failure');
      }
      await actual.finishAndReleaseFileSystemEffectLease(lease);
    },
    acquireFileSystemMutationLease: async (sandboxPolicyKey?: string) => {
      const lease = await actual.acquireFileSystemMutationLease(sandboxPolicyKey);
      return Object.assign(
        async () => {
          textMutationEffectLeaseMock.releaseCalls += 1;
          if (
            textMutationEffectLeaseMock.releaseFailureOnCall
            === textMutationEffectLeaseMock.releaseCalls
          ) {
            throw new Error('injected text mutation effect lease release failure');
          }
          await lease();
        },
        {
          bindEffectProcess: async (pid: number, windowsJobContained: boolean) => {
            textMutationEffectLeaseMock.bindCalls += 1;
            if (textMutationEffectLeaseMock.bindFailure !== undefined) {
              throw new Error(textMutationEffectLeaseMock.bindFailure);
            }
            await lease.bindEffectProcess(pid, windowsJobContained);
          },
          finishEffectProcess: () => lease.finishEffectProcess(),
          released: lease.released,
        },
      );
    },
  };
});

vi.mock('@anthropic-ai/sandbox-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sandbox-runtime')>();
  return {
    ...actual,
    SandboxManager: {
      isSupportedPlatform: () => true,
      checkDependencies: vi.fn(() => ({ errors: [], warnings: [] })),
      cleanupAfterCommand: () => undefined,
      reset: () => Promise.resolve(),
      initialize: sandboxInitialize,
      wrapWithSandbox: (command: string) => {
        capturedWrappedCommands.push(command);
        return Promise.resolve(command);
      },
      wrapWithSandboxArgv: (
        command: string,
        _binShell?: string,
        customConfig?: Readonly<Record<string, unknown>>,
      ) => {
        capturedWrappedCommands.push(command);
        if (customConfig) capturedSandboxWrapConfigs.push(customConfig);
        return Promise.resolve({
          argv: [
            process.execPath,
            'exec',
            '--quiet',
            '--env',
            'Path=wrapper-path',
            '--env',
            'PATHEXT=.EXE',
            '--env',
            'WRAPPED_ONLY=yes',
            '--',
            process.execPath,
            '-e',
            command,
          ],
          env: process.env,
        });
      },
    },
    getSrtWinPath: () => windowsSandboxMock.runnerSource || process.execPath,
    resolveSrtWin: (config?: { readonly path?: string }) => ({
      exe: config?.path ?? windowsSandboxMock.runnerSource ?? process.execPath,
      prependArgs: ['--srt-win'],
    }),
    grantWindowsAcl: (options: Readonly<Record<string, unknown>>) => {
      windowsSandboxMock.grants.push(options);
      if (windowsSandboxMock.grantFailure !== undefined) {
        throw new Error(windowsSandboxMock.grantFailure);
      }
    },
    revokeWindowsAcl: (options: Readonly<Record<string, unknown>>) => {
      windowsSandboxMock.revokes.push(options);
      return [];
    },
    getWindowsSandboxUserStatus: () => ({ ...windowsSandboxMock.user }),
    verifyWindowsWfpEgress: () => Promise.resolve(),
    installWindowsSandbox: (options?: Readonly<Record<string, unknown>>) => {
      windowsSandboxMock.installCalls += 1;
      windowsSandboxMock.installOptions.push(options ?? {});
      return { cancelled: false };
    },
  };
});

import {
  KODAX_ASRT_VERSION,
  bundledSrtWinSidecarPath,
  clearWindowsSandboxAclMarkersForRuntimeOwner,
  createAsrtShellSandbox,
  createAsrtSkillScriptRunner,
  createAsrtTextFileMutationSandbox,
  doctorSandboxRuntime,
  clearPreviousBootWindowsSandboxAclMarkers,
  overrideStandaloneBrokerSettlementTimeoutForTest,
  overrideWorkspaceSessionRpcTimeoutsForTest,
  prepareSandboxRuntimeForSetup,
  recoverPreviousBootWindowsSandboxAcls,
  recoverWindowsSandboxAclsForRuntimeOwner,
  runKodaXSandboxed,
  runAsrtBrokerProcess,
  setupSandboxRuntime,
  resetAsrtWorkspaceSessionsForTest,
  resolveSrtWinSourcePath,
  rewriteWindowsGitSafeDirectoryArgv,
  sandboxRuntimeCapability,
  sandboxSetupGuidance,
  shutdownAsrtWorkspaceSessions,
  waitForStandaloneBrokerSettlementsForTest,
  waitForWorkspaceSessionResetsForTest,
  windowsGitTrustRoots,
  withWindowsSandboxChildEnvironment,
} from './sandbox-runtime.js';

const tempRoots: string[] = [];

async function readDirectoryIfPresent(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error: unknown) {
    if (
      error instanceof Error
      && 'code' in error
      && Reflect.get(error, 'code') === 'ENOENT'
    ) return [];
    throw error;
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function hasQueuedFileSystemCleanup(): boolean {
  const workerScope = process.env.VITEST_WORKER_ID === undefined
    ? undefined
    : `${process.env.VITEST_WORKER_ID}-${process.pid}`.replace(/[^a-z0-9_-]/gi, '_');
  const statePath = path.join(
    path.resolve(process.env.ProgramData!),
    'KodaX',
    'sandbox-runtime',
    'runtime',
    ...(workerScope === undefined ? [] : [`test-filesystem-effects-${workerScope}`]),
    'model-filesystem-effects.json',
  );
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      readonly namespaces: readonly { readonly cleanupTransition?: boolean }[];
    };
    return state.namespaces.some((owner) => owner.cleanupTransition === true);
  } catch {
    return false;
  }
}

beforeEach(async () => {
  processIdentityMock.windowsBootIdentity = 'windows-boot-100';
  processIdentityMock.pid4StartIdentity = '13370000000000';
  processIdentityMock.unreadablePids.clear();
  recoveryLockMock.timeoutFailures = 0;
  recoveryLockMock.timeoutOnCall = undefined;
  recoveryLockMock.calls = 0;
  recoveryLockMock.releaseFailures = 0;
  recoveryLockMock.effectCalls = 0;
  recoveryLockMock.effectFailureStartCall = undefined;
  recoveryLockMock.beforeOperation = undefined;
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-runner-'));
  tempRoots.push(root);
  const source = path.join(root, 'package', 'srt-win.exe');
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, 'trusted-test-runner', 'utf8');
  windowsSandboxMock.runnerSource = source;
  vi.stubEnv('ProgramData', path.join(root, 'program-data'));
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
});

afterEach(async () => {
  fileSystemMock.rmFailurePath = undefined;
  fileSystemMock.writeBrokerRequestFailure = false;
  fileSystemMock.writeAclPoisonMarkerFailure = false;
  fileSystemMock.renameAclPoisonMarkerFailures = 0;
  fileSystemMock.aclPoisonMarkerWriteTargets.length = 0;
  processTreeKillMock.releaseUnknown?.();
  processTreeKillMock.releaseUnknown = undefined;
  processTreeKillMock.outcome = 'actual';
  processTreeKillMock.childPid = undefined;
  textMutationEffectLeaseMock.bindFailure = undefined;
  textMutationEffectLeaseMock.releaseFailureOnCall = undefined;
  textMutationEffectLeaseMock.bindCalls = 0;
  textMutationEffectLeaseMock.releaseCalls = 0;
  windowsEffectJobMock.drainFailure = undefined;
  windowsEffectJobMock.textMutationDrainFailure = undefined;
  windowsEffectJobMock.drainFailureOnCall = undefined;
  windowsEffectJobMock.aclRecoveryDrainFailure = undefined;
  windowsEffectJobMock.containCalls = 0;
  windowsEffectJobMock.containFailureOnCall = undefined;
  windowsEffectJobMock.terminateOutcome = 'drained';
  windowsEffectJobMock.releaseDrain?.();
  windowsEffectJobMock.drainPending = false;
  windowsEffectJobMock.releaseDrain = undefined;
  windowsEffectJobMock.unrefCalls = 0;
  windowsEffectJobMock.latestChild = undefined;
  windowsEffectJobMock.containedChild = undefined;
  windowsEffectJobMock.aclRecoveryUncontainedStarts = 0;
  standaloneBrokerDetachMock.childUnrefCalls = 0;
  standaloneBrokerDetachMock.stdinUnrefCalls = 0;
  standaloneBrokerDetachMock.stdoutUnrefCalls = 0;
  standaloneBrokerDetachMock.stderrUnrefCalls = 0;
  standaloneFenceReleaseMock.failures = 0;
  processIdentityMock.windowsBootIdentity = 'windows-boot-100';
  processIdentityMock.pid4StartIdentity = '13370000000000';
  workspaceSessionControl.releaseReady?.();
  workspaceSessionControl.releaseWrap?.();
  workspaceSessionControl.delayReady = false;
  workspaceSessionControl.releaseReady = undefined;
  workspaceSessionControl.delayWrap = false;
  workspaceSessionControl.releaseWrap = undefined;
  workspaceSessionControl.wrapFailure = undefined;
  workspaceSessionControl.cleanupFailure = undefined;
  workspaceSessionControl.cleanupFailureOnCall = undefined;
  workspaceSessionControl.delayCleanup = false;
  workspaceSessionControl.releaseCleanup?.();
  workspaceSessionControl.releaseCleanup = undefined;
  workspaceSessionControl.afterWrapResponse = undefined;
  workspaceSessionControl.cleanupRequests = 0;
  workspaceSessionControl.malformedReady = false;
  workspaceSessionControl.beforeReady = undefined;
  workspaceSessionControl.malformedResponseFor = undefined;
  workspaceSessionControl.delayClose = false;
  workspaceSessionControl.releaseClose?.();
  workspaceSessionControl.releaseClose = undefined;
  workspaceSessionControl.closeExitCode = 0;
  stubbornBroker.mode = 'none';
  textMutationStdinMock.failNext = false;
  textMutationStdinMock.observedErrorListener = false;
  boundedMetadataReadMock.trackedPaths.clear();
  boundedMetadataReadMock.fullReads.length = 0;
  await waitForStandaloneBrokerSettlementsForTest();
  await resetAsrtWorkspaceSessionsForTest();
  await _resetFileSystemEffectLeasesForTests();
  capturedBrokerRequests.length = 0;
  capturedSpawnEnvironments.length = 0;
  capturedSpawnArgv.length = 0;
  capturedSpawnCwds.length = 0;
  capturedSyncSpawns.length = 0;
  capturedWrappedCommands.length = 0;
  capturedWorkspaceSessionConfigs.length = 0;
  capturedWorkspaceRequests.length = 0;
  capturedStandaloneGateLaunches.length = 0;
  capturedSandboxWrapConfigs.length = 0;
  capturedKillSignals.length = 0;
  capturedProcessTreeKillOptions.length = 0;
  deferredBrokerRead.enabled = false;
  deferredBrokerRead.missing = false;
  sandboxInitialize.mockReset();
  sandboxInitialize.mockResolvedValue();
  windowsSandboxMock.runnerSource = '';
  windowsSandboxMock.wfpOutcome = 'blocked';
  windowsSandboxMock.aclRecoveryOutcome = 'success';
  windowsSandboxMock.aclRecoveryOutcomes.length = 0;
  windowsSandboxMock.sidProcessesActive = true;
  windowsSandboxMock.sidInspectionCalls = 0;
  windowsSandboxMock.sidProbeLaunches.length = 0;
  windowsSandboxMock.sidInspectionFailure = undefined;
  capturedDiagnostics.length = 0;
  windowsSandboxMock.guardReady = true;
  windowsSandboxMock.user = {
    provisioned: true,
    sid: 'S-1-5-21-1000',
    groupExists: true,
    groupSid: 'S-1-5-21-1001',
    inBuiltinUsers: true,
    inSandboxGroup: true,
    hiddenFromLogon: true,
    credPresent: true,
    markerVersion: 1,
    realUserSid: 'S-1-5-21-1002',
  };
  windowsSandboxMock.grantFailure = undefined;
  windowsSandboxMock.grants.length = 0;
  windowsSandboxMock.revokes.length = 0;
  windowsSandboxMock.installCalls = 0;
  windowsSandboxMock.installOptions.length = 0;
  sandboxWrapper.mode = 'attest';
  vi.unstubAllEnvs();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 50,
  })));
});

async function createRegistry(script = 'hello.mjs'): Promise<SkillRegistry> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-test-'));
  tempRoots.push(root);
  const skillRoot = path.join(root, 'skills', 'demo');
  await mkdir(path.join(skillRoot, 'scripts'), { recursive: true });
  await writeFile(
    path.join(skillRoot, 'SKILL.md'),
    '---\nname: demo\ndescription: Test isolated scripts\n---\n\nUse the admitted script.\n',
    'utf8',
  );
  await writeFile(path.join(skillRoot, 'scripts', script), 'process.stdout.write("hello")', 'utf8');
  const registry = new SkillRegistry(root, {
    projectPaths: [], userPaths: [path.join(root, 'skills')], pluginPaths: [], builtinPath: path.join(root, 'builtin'),
  });
  await registry.discover();
  return registry;
}

async function markSandboxRuntimeUnavailable(): Promise<void> {
  if (process.platform === 'win32') {
    windowsSandboxMock.user.provisioned = false;
  } else {
    const asrt = await import('@anthropic-ai/sandbox-runtime');
    vi.mocked(asrt.SandboxManager.checkDependencies).mockReturnValueOnce({
      errors: ['bubblewrap is unavailable'],
      warnings: [],
    });
  }
  await doctorSandboxRuntime({ refresh: true });
}

describe('ASRT workspace shell adapter', () => {
  it('observes helper stdin failures and rejects only the text mutation operation', async () => {
    processTreeKillMock.childPid = process.pid;
    textMutationStdinMock.failNext = true;
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-text-stdin-'));
    tempRoots.push(root);
    const target = path.join(root, 'target.txt');
    await writeFile(target, 'before', 'utf8');
    const sandbox = createAsrtTextFileMutationSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });

    await expect(sandbox.read({
      toolCallId: 'stdin-failure-read',
      toolName: 'edit',
      toolInput: { path: target },
      path: target,
    })).rejects.toThrow(/text mutation|stdin failure/i);
    expect(textMutationStdinMock.observedErrorListener).toBe(true);
    await expect(readFile(target, 'utf8')).resolves.toBe('before');
  });

  it('reads and compare-writes direct text tools through the workspace sandbox', async () => {
    processTreeKillMock.childPid = process.pid;
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-text-mutation-'));
    tempRoots.push(root);
    const target = path.join(root, 'target.txt');
    await writeFile(target, 'before', 'utf8');
    const shouldSandbox = vi.fn(() => true);
    const liveShell = createAsrtShellSandbox({ workspaceRoot: root, shouldSandbox });
    const preparedShell = await liveShell.prepare({
      toolCallId: 'background-shell-1',
      toolInput: { command: 'long-running-service' },
      command: 'long-running-service',
      cwd: root,
      env: process.env,
    });
    if (preparedShell === undefined) throw new Error('expected background shell preparation');
    const sandbox = createAsrtTextFileMutationSandbox({
      workspaceRoot: root,
      shouldSandbox,
    });
    const request = {
      toolCallId: 'edit-text-1',
      toolName: 'edit' as const,
      toolInput: { path: target, old_string: 'before', new_string: 'after' },
      path: target,
    };

    try {
      const readResult = await sandbox.read(request);
      expect(readResult.status).toBe('ok');
      if (readResult.status !== 'ok') throw new Error('expected sandboxed snapshot');
      expect(readResult.snapshot.content).toBe('before');
      await expect(sandbox.write({
        ...request,
        content: 'after',
        createParentDirectories: false,
        expectedRevision: readResult.snapshot.revision,
      })).resolves.toEqual({ status: 'written' });

      await expect(readFile(target, 'utf8')).resolves.toBe('after');
      expect(shouldSandbox).toHaveBeenCalledWith(expect.objectContaining({
        id: 'edit-text-1',
        name: 'edit',
      }));
      const requests = capturedBrokerRequests.slice(-2) as Array<{
        readonly fallbackToNormalExecution?: boolean;
      }>;
      expect(requests).toHaveLength(2);
      expect(requests.every((item) => item.fallbackToNormalExecution === false)).toBe(true);
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
    } finally {
      await preparedShell.cleanup();
    }
  });

  it('shares a newly registered workspace root between a live shell and direct text mutations', async () => {
    processTreeKillMock.childPid = process.pid;
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-dynamic-root-'));
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-dynamic-worktree-'));
    tempRoots.push(root, worktree);
    const target = path.join(worktree, 'target.txt');
    await writeFile(target, 'before', 'utf8');
    const workspaceRoots = new Set<string>();
    const additionalWorkspaceRoots = () => [...workspaceRoots];
    const shouldSandbox = vi.fn(() => true);
    const liveShell = createAsrtShellSandbox({
      workspaceRoot: root,
      additionalWorkspaceRoots,
      shouldSandbox,
    });
    const textSandbox = createAsrtTextFileMutationSandbox({
      workspaceRoot: root,
      additionalWorkspaceRoots,
      shouldSandbox,
    });

    expect(textSandbox.canHandlePath?.(target)).toBe(false);
    workspaceRoots.add(worktree);
    expect(textSandbox.canHandlePath?.(target)).toBe(true);

    const preparedShell = await liveShell.prepare({
      toolCallId: 'dynamic-worktree-shell',
      toolInput: { command: 'long-running-service' },
      command: 'long-running-service',
      cwd: worktree,
      env: process.env,
    });
    if (preparedShell?.fileSystemEffectPolicyKey === undefined) {
      throw new Error('expected a sandboxed dynamic-worktree shell');
    }
    const releaseShell = await acquireFileSystemMutationLease(
      preparedShell.fileSystemEffectPolicyKey,
    );
    try {
      await expect(textSandbox.read({
        toolCallId: 'dynamic-worktree-edit',
        toolName: 'edit',
        toolInput: { path: target },
        path: target,
      })).resolves.toMatchObject({ status: 'ok' });
      // POSIX constructions pre-warm a baseline workspace session that excludes
      // the dynamically registered roots, so the scoped shell session is the
      // last captured config on every platform and the text mutation reuses it
      // instead of starting a third session.
      expect(capturedWorkspaceSessionConfigs).toHaveLength(
        process.platform === 'win32' ? 1 : 2,
      );
      const config = capturedWorkspaceSessionConfigs.at(-1) as {
        readonly filesystem: {
          readonly allowRead: readonly string[];
          readonly allowWrite: readonly string[];
        };
      };
      expect(config.filesystem.allowRead).toContain(path.resolve(worktree));
      expect(config.filesystem.allowWrite).toContain(path.resolve(worktree));
    } finally {
      await releaseShell();
      await preparedShell.cleanup();
    }

    workspaceRoots.delete(worktree);
    expect(textSandbox.canHandlePath?.(target)).toBe(false);
  });

  it.runIf(process.platform !== 'win32')(
    'starts a workspace text session beside a live POSIX shell with additional scopes',
    async () => {
      processTreeKillMock.childPid = process.pid;
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-text-posix-policy-'));
      const extraRead = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-text-extra-read-'));
      tempRoots.push(root, extraRead);
      const target = path.join(root, 'target.txt');
      await writeFile(target, 'before', 'utf8');
      const shouldSandbox = vi.fn((call: { readonly id: string }) => (
        call.id === 'scoped-background-shell'
          ? { filesystemAccess: { read: [extraRead], write: [] } }
          : true
      ));
      const liveShell = createAsrtShellSandbox({ workspaceRoot: root, shouldSandbox });
      const preparedShell = await liveShell.prepare({
        toolCallId: 'scoped-background-shell',
        toolInput: { command: 'long-running-service' },
        command: 'long-running-service',
        cwd: root,
        env: process.env,
      });
      if (preparedShell?.fileSystemEffectPolicyKey === undefined) {
        throw new Error('expected scoped background shell policy');
      }
      const releaseShell = await acquireFileSystemMutationLease(
        preparedShell.fileSystemEffectPolicyKey,
      );
      const sandbox = createAsrtTextFileMutationSandbox({ workspaceRoot: root, shouldSandbox });
      try {
        await expect(sandbox.read({
          toolCallId: 'edit-beside-scoped-shell',
          toolName: 'edit',
          toolInput: { path: target },
          path: target,
        })).resolves.toMatchObject({ status: 'ok' });
      } finally {
        await releaseShell();
        await preparedShell.cleanup();
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'keeps POSIX workspace session startup behind a real namespace mutation',
    async () => {
      processTreeKillMock.childPid = process.pid;
      const blockedRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-text-posix-namespace-start-'));
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-text-posix-namespace-'));
      tempRoots.push(blockedRoot, root);
      const blockedTarget = path.join(blockedRoot, 'target.txt');
      const target = path.join(root, 'target.txt');
      await writeFile(blockedTarget, 'before', 'utf8');
      await writeFile(target, 'before', 'utf8');
      const releaseStartupNamespace = await acquireExclusiveFileSystemEffectLease();
      try {
        const blocked = createAsrtTextFileMutationSandbox({
          workspaceRoot: blockedRoot,
          shouldSandbox: () => true,
        });
        await expect(blocked.read({
          toolCallId: 'edit-behind-namespace-startup',
          toolName: 'edit',
          toolInput: { path: blockedTarget },
          path: blockedTarget,
        })).resolves.toMatchObject({ status: 'unavailable' });
        expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
      } finally {
        await releaseStartupNamespace();
      }

      const sandbox = createAsrtTextFileMutationSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      await vi.waitFor(() => expect(capturedWorkspaceSessionConfigs).not.toHaveLength(0));
      const releaseNamespace = await vi.waitFor(
        () => acquireExclusiveFileSystemEffectLease(),
        { timeout: 5_000 },
      );
      try {
        await expect(sandbox.read({
          toolCallId: 'edit-behind-namespace',
          toolName: 'edit',
          toolInput: { path: target },
          path: target,
        })).rejects.toThrow('filesystem effect is already active');
      } finally {
        await releaseNamespace();
      }
      await expect(sandbox.read({
        toolCallId: 'edit-after-namespace',
        toolName: 'edit',
        toolInput: { path: target },
        path: target,
      })).resolves.toMatchObject({ status: 'ok' });
    },
  );

  it('keeps canonical backup paths eligible for undo through a workspace junction', async () => {
    processTreeKillMock.childPid = process.pid;
    const actualWorkspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-text-real-'));
    const junctionRoot = path.join(os.tmpdir(), `kodax-asrt-text-link-${randomUUID()}`);
    tempRoots.push(actualWorkspace, junctionRoot);
    await symlink(
      actualWorkspace,
      junctionRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const lexicalTarget = path.join(junctionRoot, 'target.txt');
    const canonicalTarget = path.join(actualWorkspace, 'target.txt');
    await writeFile(canonicalTarget, 'before', 'utf8');
    const sandbox = createAsrtTextFileMutationSandbox({
      workspaceRoot: junctionRoot,
      shouldSandbox: () => true,
    });
    const editRequest = {
      toolCallId: 'junction-edit-1',
      toolName: 'edit' as const,
      toolInput: { path: lexicalTarget },
      path: lexicalTarget,
    };

    expect(sandbox.canHandlePath?.(lexicalTarget)).toBe(true);
    expect(sandbox.canHandlePath?.(canonicalTarget)).toBe(true);
    const edited = await sandbox.read(editRequest);
    expect(edited.status).toBe('ok');
    if (edited.status !== 'ok') throw new Error('expected sandboxed snapshot');
    expect(edited.snapshot.backupPath).toBe(await realpath(canonicalTarget));
    await expect(sandbox.write({
      ...editRequest,
      content: 'after',
      createParentDirectories: false,
      expectedRevision: edited.snapshot.revision,
    })).resolves.toEqual({ status: 'written' });

    const undoRequest = {
      toolCallId: 'junction-undo-1',
      toolName: 'undo' as const,
      toolInput: {},
      path: edited.snapshot.backupPath,
    };
    const undo = await sandbox.read(undoRequest);
    expect(undo.status).toBe('ok');
    if (undo.status !== 'ok') throw new Error('expected sandboxed undo snapshot');
    await expect(sandbox.write({
      ...undoRequest,
      content: 'before',
      createParentDirectories: false,
      expectedRevision: undo.snapshot.revision,
    })).resolves.toEqual({ status: 'written' });
    await expect(readFile(canonicalTarget, 'utf8')).resolves.toBe('before');
  });

  it('keeps pathless Agent Home undo outside the concurrent workspace capability', async () => {
    processTreeKillMock.childPid = process.pid;
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-text-undo-'));
    tempRoots.push(workspace);
    const target = path.join(process.env.KODAX_HOME!, 'agents', 'notes.txt');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'current', 'utf8');
    const shouldSandbox = vi.fn(() => true);
    const sandbox = createAsrtTextFileMutationSandbox({
      workspaceRoot: workspace,
      shouldSandbox,
    });
    const request = {
      toolCallId: 'undo-agent-home-1',
      toolName: 'undo' as const,
      toolInput: {},
      path: target,
    };

    await expect(sandbox.read(request)).resolves.toMatchObject({ status: 'unavailable' });
    await expect(readFile(target, 'utf8')).resolves.toBe('current');
    expect(shouldSandbox).not.toHaveBeenCalled();
    expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
  });

  it('fails closed when the workspace root identity cannot be resolved', () => {
    const missingWorkspace = path.join(os.tmpdir(), `kodax-missing-workspace-${randomUUID()}`);

    expect(() => createAsrtTextFileMutationSandbox({
      workspaceRoot: missingWorkspace,
      shouldSandbox: () => true,
    })).toThrow();
  });

  it('rejects a workspace hard link before sandboxed text is read', async () => {
    processTreeKillMock.childPid = process.pid;
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-hardlink-workspace-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-hardlink-outside-'));
    tempRoots.push(workspace, outside);
    const outsideTarget = path.join(outside, 'secret.txt');
    const workspaceTarget = path.join(workspace, 'target.txt');
    await writeFile(outsideTarget, 'outside-before', 'utf8');
    await link(outsideTarget, workspaceTarget);
    const sandbox = createAsrtTextFileMutationSandbox({
      workspaceRoot: workspace,
      shouldSandbox: () => true,
    });

    await expect(sandbox.read({
      toolCallId: 'hardlink-read-1',
      toolName: 'edit',
      toolInput: { path: workspaceTarget },
      path: workspaceTarget,
    })).rejects.toThrow(/hard.?link/i);
    await expect(readFile(outsideTarget, 'utf8')).resolves.toBe('outside-before');
  });

  it('rejects a hard link added between sandboxed read and write', async () => {
    processTreeKillMock.childPid = process.pid;
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-hardlink-race-workspace-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-hardlink-race-outside-'));
    tempRoots.push(workspace, outside);
    const workspaceTarget = path.join(workspace, 'target.txt');
    const outsideAlias = path.join(outside, 'alias.txt');
    await writeFile(workspaceTarget, 'before', 'utf8');
    const sandbox = createAsrtTextFileMutationSandbox({
      workspaceRoot: workspace,
      shouldSandbox: () => true,
    });
    const request = {
      toolCallId: 'hardlink-write-1',
      toolName: 'edit' as const,
      toolInput: { path: workspaceTarget },
      path: workspaceTarget,
    };
    const snapshot = await sandbox.read(request);
    if (snapshot.status !== 'ok') throw new Error('expected sandboxed snapshot');
    await link(workspaceTarget, outsideAlias);

    await expect(sandbox.write({
      ...request,
      content: 'must-not-write',
      createParentDirectories: false,
      expectedRevision: snapshot.snapshot.revision,
    })).rejects.toThrow(/hard.?link/i);
    await expect(readFile(workspaceTarget, 'utf8')).resolves.toBe('before');
    await expect(readFile(outsideAlias, 'utf8')).resolves.toBe('before');
  });

  it('rejects canonical backup authority outside the workspace capability', async () => {
    processTreeKillMock.childPid = process.pid;
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-backup-workspace-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-backup-outside-'));
    tempRoots.push(workspace, outside);
    const redirectedDirectory = path.join(workspace, 'redirected');
    await symlink(outside, redirectedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    const outsideTarget = path.join(outside, 'target.txt');
    const workspaceTarget = path.join(redirectedDirectory, 'target.txt');
    await writeFile(outsideTarget, 'outside-before', 'utf8');
    const sandbox = createAsrtTextFileMutationSandbox({
      workspaceRoot: workspace,
      shouldSandbox: () => true,
    });

    await expect(sandbox.read({
      toolCallId: 'outside-backup-1',
      toolName: 'edit',
      toolInput: { path: workspaceTarget },
      path: workspaceTarget,
    })).rejects.toThrow('invalid snapshot');
    await expect(readFile(outsideTarget, 'utf8')).resolves.toBe('outside-before');
  });

  it.runIf(process.platform === 'win32')(
    'keeps the text effect lease until delayed Windows Job drain recovery completes',
    async () => {
      processTreeKillMock.childPid = process.pid;
      windowsEffectJobMock.textMutationDrainFailure = 'injected Windows Job drain failure';
      textMutationEffectLeaseMock.releaseFailureOnCall = 1;
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-job-drain-'));
      tempRoots.push(workspace);
      const target = path.join(workspace, 'target.txt');
      await writeFile(target, 'before', 'utf8');
      const sandbox = createAsrtTextFileMutationSandbox({
        workspaceRoot: workspace,
        shouldSandbox: () => true,
      });
      try {
        await expect(sandbox.read({
          toolCallId: 'job-drain-read-1',
          toolName: 'edit',
          toolInput: { path: target },
          path: target,
        })).rejects.toThrow(/Job drain|cleanup/i);
        windowsEffectJobMock.textMutationDrainFailure = undefined;
        await vi.waitFor(
          () => {
            expect(workspaceSessionControl.cleanupRequests).toBe(1);
            expect(textMutationEffectLeaseMock.releaseCalls).toBe(2);
          },
          { timeout: 3_000 },
        );
        const releaseRecoveredLease = await acquireHostFileSystemMutationLease();
        await releaseRecoveredLease();
      } finally {
        windowsEffectJobMock.textMutationDrainFailure = undefined;
        await _resetFileSystemEffectLeasesForTests();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'recovers delayed text cleanup after consuming attestation before a transient workspace cleanup failure',
    async () => {
      processTreeKillMock.childPid = process.pid;
      windowsEffectJobMock.textMutationDrainFailure = 'injected Windows Job drain failure';
      workspaceSessionControl.cleanupFailureOnCall = 1;
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-cleanup-retry-'));
      tempRoots.push(workspace);
      const target = path.join(workspace, 'target.txt');
      await writeFile(target, 'before', 'utf8');
      const sandbox = createAsrtTextFileMutationSandbox({
        workspaceRoot: workspace,
        shouldSandbox: () => true,
      });
      try {
        await expect(sandbox.read({
          toolCallId: 'cleanup-retry-read-1',
          toolName: 'edit',
          toolInput: { path: target },
          path: target,
        })).rejects.toThrow(/Job drain|cleanup/i);
        windowsEffectJobMock.textMutationDrainFailure = undefined;
        await vi.waitFor(
          () => expect(workspaceSessionControl.cleanupRequests).toBe(2),
          { timeout: 3_000 },
        );
        const releaseRecoveredLease = await acquireHostFileSystemMutationLease();
        await releaseRecoveredLease();
      } finally {
        windowsEffectJobMock.textMutationDrainFailure = undefined;
        await _resetFileSystemEffectLeasesForTests();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'retries a transient workspace cleanup after the text process already drained',
    async () => {
      processTreeKillMock.childPid = process.pid;
      workspaceSessionControl.cleanupFailureOnCall = 1;
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-drained-cleanup-retry-'));
      tempRoots.push(workspace);
      const target = path.join(workspace, 'target.txt');
      await writeFile(target, 'before', 'utf8');
      const sandbox = createAsrtTextFileMutationSandbox({
        workspaceRoot: workspace,
        shouldSandbox: () => true,
      });
      try {
        await expect(sandbox.read({
          toolCallId: 'drained-cleanup-retry-read-1',
          toolName: 'edit',
          toolInput: { path: target },
          path: target,
        })).rejects.toThrow(/cleanup/i);
        await vi.waitFor(
          () => expect(workspaceSessionControl.cleanupRequests).toBe(2),
          { timeout: 3_000 },
        );
        const releaseRecoveredLease = await acquireHostFileSystemMutationLease();
        await releaseRecoveredLease();
      } finally {
        await _resetFileSystemEffectLeasesForTests();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'retains text sandbox ownership when effect binding and process drain both fail',
    async () => {
      processTreeKillMock.childPid = process.pid;
      processTreeKillMock.outcome = 'unknown';
      textMutationEffectLeaseMock.bindFailure = 'injected text effect binding failure';
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-bind-drain-'));
      tempRoots.push(workspace);
      const target = path.join(workspace, 'target.txt');
      await writeFile(target, 'before', 'utf8');
      const sandbox = createAsrtTextFileMutationSandbox({
        workspaceRoot: workspace,
        shouldSandbox: () => true,
      });

      try {
        await expect(sandbox.read({
          toolCallId: 'bind-drain-read-1',
          toolName: 'edit',
          toolInput: { path: target },
          path: target,
        })).rejects.toThrow(/cleanup/i);
        expect(textMutationEffectLeaseMock.bindCalls).toBe(1);
        expect(workspaceSessionControl.cleanupRequests).toBe(0);
        expect(textMutationEffectLeaseMock.releaseCalls).toBe(0);
      } finally {
        await _resetFileSystemEffectLeasesForTests();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'settles text sandbox cleanup after effect binding fails but process drain succeeds',
    async () => {
      processTreeKillMock.childPid = process.pid;
      textMutationEffectLeaseMock.bindFailure = 'injected text effect binding failure';
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-bind-drained-'));
      tempRoots.push(workspace);
      const target = path.join(workspace, 'target.txt');
      await writeFile(target, 'before', 'utf8');
      const sandbox = createAsrtTextFileMutationSandbox({
        workspaceRoot: workspace,
        shouldSandbox: () => true,
      });

      const operation = sandbox.read({
        toolCallId: 'bind-drained-read-1',
        toolName: 'edit',
        toolInput: { path: target },
        path: target,
      }).then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      const outcome = await Promise.race([
        operation,
        new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 5_000)),
      ]);

      expect(outcome).toBe('rejected');
      expect(textMutationEffectLeaseMock.bindCalls).toBe(1);
      expect(workspaceSessionControl.cleanupRequests).toBe(1);
      expect(textMutationEffectLeaseMock.releaseCalls).toBe(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'recovers only exact daemon-owned primary and legacy ACL markers without force',
    async () => {
      const configHome = path.resolve(process.env.KODAX_HOME!);
      const primaryDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      const legacyDirectory = path.join(configHome, 'sandbox-runtime', 'acl-poison');
      const basename = 'unconfirmed-owner-exact-runtime.json';
      const payload = JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 4101,
        holderProcessStartIdentity: 'process-start-4101',
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      });
      await mkdir(primaryDirectory, { recursive: true });
      await mkdir(legacyDirectory, { recursive: true });
      await writeFile(path.join(primaryDirectory, basename), payload, 'utf8');
      await writeFile(path.join(legacyDirectory, basename), payload, 'utf8');

      const recovered = await recoverWindowsSandboxAclsForRuntimeOwner(configHome, {
        pid: 4101,
        processStartIdentity: 'process-start-4101',
      }, processIdentityMock.windowsBootIdentity!);

      expect(recovered).toBe(2);
      await expect(readdir(primaryDirectory)).resolves.toEqual([basename]);
      await expect(readdir(legacyDirectory)).resolves.toEqual([basename]);
      const cleared = await clearWindowsSandboxAclMarkersForRuntimeOwner(configHome, {
        pid: 4101,
        processStartIdentity: 'process-start-4101',
      }, processIdentityMock.windowsBootIdentity!);
      expect(cleared).toBe(2);
      await expect(readdir(primaryDirectory)).resolves.toEqual([]);
      await expect(readdir(legacyDirectory)).resolves.toEqual([]);
      const calls = capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      ));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).not.toContain('--force');
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps every marker when exact daemon ACL recovery finds a foreign owner',
    async () => {
      const configHome = path.resolve(process.env.KODAX_HOME!);
      const primaryDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(primaryDirectory, { recursive: true });
      const exact = path.join(primaryDirectory, 'unconfirmed-owner-exact.json');
      const foreign = path.join(primaryDirectory, 'unconfirmed-owner-foreign.json');
      await writeFile(exact, JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 4101,
        holderProcessStartIdentity: 'process-start-4101',
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      await writeFile(foreign, JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 5101,
        holderProcessStartIdentity: 'process-start-5101',
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');

      await expect(recoverWindowsSandboxAclsForRuntimeOwner(configHome, {
        pid: 4101,
        processStartIdentity: 'process-start-4101',
      }, processIdentityMock.windowsBootIdentity!)).rejects.toThrow(/foreign or unverifiable owner marker/i);

      await expect(stat(exact)).resolves.toBeDefined();
      await expect(stat(foreign)).resolves.toBeDefined();
      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      ))).toHaveLength(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'recovers every verified previous-boot ACL marker under one recovery lock',
    async () => {
      const configHome = path.resolve(process.env.KODAX_HOME!);
      const primaryDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      const legacyDirectory = path.join(configHome, 'sandbox-runtime', 'acl-poison');
      await mkdir(primaryDirectory, { recursive: true });
      await mkdir(legacyDirectory, { recursive: true });
      await writeFile(path.join(primaryDirectory, 'unconfirmed-owner-a.json'), JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 4101,
        holderProcessStartIdentity: 'process-start-4101',
        windowsBootIdentity: 'windows-boot-90',
      }), 'utf8');
      await writeFile(path.join(legacyDirectory, 'unconfirmed-owner-b.json'), JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 5101,
        holderProcessStartIdentity: 'process-start-5101',
        windowsBootIdentity: 'windows-boot-80',
      }), 'utf8');

      const recovered = await recoverPreviousBootWindowsSandboxAcls(configHome);

      expect(recovered).toBe(2);
      await expect(readdir(primaryDirectory)).resolves.toHaveLength(1);
      await expect(readdir(legacyDirectory)).resolves.toHaveLength(1);
      const cleared = await clearPreviousBootWindowsSandboxAclMarkers(configHome);
      expect(cleared).toBe(2);
      await expect(readdir(primaryDirectory)).resolves.toEqual([]);
      await expect(readdir(legacyDirectory)).resolves.toEqual([]);
      expect(recoveryLockMock.calls).toBe(2);
      expect(windowsSandboxMock.installCalls).toBe(0);
      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      ))).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32').each([
    ['current-boot', 'windows-boot-100', 'automatic-retry'],
    ['unverifiable', undefined, 'automatic-retry'],
    ['malformed', 'not-a-windows-boot', 'automatic-retry'],
  ] as const)(
    'keeps all ACL markers when previous-boot recovery finds a %s owner',
    async (_label, markerBootIdentity, expectedRecoveryAction) => {
      const configHome = path.resolve(process.env.KODAX_HOME!);
      const primaryDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(primaryDirectory, { recursive: true });
      const oldMarker = path.join(primaryDirectory, 'unconfirmed-owner-old.json');
      const unsafeMarker = path.join(primaryDirectory, 'unconfirmed-owner-unsafe.json');
      await writeFile(oldMarker, JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 4101,
        holderProcessStartIdentity: 'process-start-4101',
        windowsBootIdentity: 'windows-boot-90',
      }), 'utf8');
      await writeFile(unsafeMarker, JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 5101,
        holderProcessStartIdentity: 'process-start-5101',
        windowsBootIdentity: markerBootIdentity,
      }), 'utf8');

      const error = await recoverPreviousBootWindowsSandboxAcls(configHome).then(
        () => undefined,
        (candidate: unknown) => candidate,
      );

      expect(error).toBeInstanceOf(Error);
      expect(Reflect.get(error as object, 'recoveryAction')).toBe(expectedRecoveryAction);
      await expect(stat(oldMarker)).resolves.toBeDefined();
      await expect(stat(unsafeMarker)).resolves.toBeDefined();
      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      ))).toHaveLength(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps previous-boot ACL markers when native recovery fails',
    async () => {
      const configHome = path.resolve(process.env.KODAX_HOME!);
      const primaryDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(primaryDirectory, { recursive: true });
      const marker = path.join(primaryDirectory, 'unconfirmed-owner-old.json');
      await writeFile(marker, JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 4101,
        holderProcessStartIdentity: 'process-start-4101',
        windowsBootIdentity: 'windows-boot-90',
      }), 'utf8');
      windowsSandboxMock.aclRecoveryOutcome = 'failure';

      await expect(recoverPreviousBootWindowsSandboxAcls(configHome))
        .rejects.toThrow(/ACL recovery failed/i);

      await expect(stat(marker)).resolves.toBeDefined();
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps every marker when a current-boot owner appears before durable clear',
    async () => {
      const configHome = path.resolve(process.env.KODAX_HOME!);
      const primaryDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(primaryDirectory, { recursive: true });
      const oldMarker = path.join(primaryDirectory, 'unconfirmed-owner-old.json');
      const currentMarker = path.join(primaryDirectory, 'unconfirmed-owner-current.json');
      await writeFile(oldMarker, JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 4101,
        holderProcessStartIdentity: 'process-start-4101',
        windowsBootIdentity: 'windows-boot-90',
      }), 'utf8');
      await expect(recoverPreviousBootWindowsSandboxAcls(configHome)).resolves.toBe(1);
      await writeFile(currentMarker, JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 5101,
        holderProcessStartIdentity: 'process-start-5101',
        windowsBootIdentity: 'windows-boot-100',
      }), 'utf8');

      await expect(clearPreviousBootWindowsSandboxAclMarkers(configHome))
        .rejects.toThrow(/current-boot owner marker/i);

      await expect(stat(oldMarker)).resolves.toBeDefined();
      await expect(stat(currentMarker)).resolves.toBeDefined();
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects an exact PID identity marker from a different Windows boot',
    async () => {
      const configHome = path.resolve(process.env.KODAX_HOME!);
      const primaryDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(primaryDirectory, { recursive: true });
      const marker = path.join(primaryDirectory, 'unconfirmed-owner-other-boot.json');
      await writeFile(marker, JSON.stringify({
        version: 1,
        state: 'unconfirmed',
        holderPid: 4101,
        holderProcessStartIdentity: 'process-start-4101',
        windowsBootIdentity: 'windows-boot-100',
      }), 'utf8');

      await expect(recoverWindowsSandboxAclsForRuntimeOwner(configHome, {
        pid: 4101,
        processStartIdentity: 'process-start-4101',
      }, 'windows-boot-200')).rejects.toThrow(/foreign or unverifiable owner marker/i);

      await expect(stat(marker)).resolves.toBeDefined();
      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      ))).toHaveLength(0);
    },
  );

  it('avoids an eager Windows ACL owner and starts POSIX warm-up with a fresh KODAX_HOME', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-shell-warm-'));
    tempRoots.push(root);

    createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });

    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
      return;
    }
    await vi.waitFor(() => {
      const sessions = capturedSpawnArgv.filter((argv) => argv.some((arg) => (
        arg.includes('sandbox-workspace-session')
        || arg === '__asrt-workspace-session'
      )));
      expect(sessions).toHaveLength(1);
      const importIndex = sessions[0]!.indexOf('--import');
      if (importIndex >= 0) {
        expect(sessions[0]![importIndex + 1]).toMatch(/^file:\/\//);
      }
    }, { timeout: 5_000 });
  });

  it.skipIf(process.platform === 'win32').each(['abort', 'timeout'] as const)(
    'honors a Shell %s while waiting for POSIX workspace warm-up',
    async (stopKind) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `kodax-asrt-warm-${stopKind}-`));
      tempRoots.push(root);
      workspaceSessionControl.delayReady = true;
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      await vi.waitFor(() => expect(workspaceSessionControl.releaseReady).toBeDefined());
      const controller = new AbortController();
      const preparing = sandbox.prepare({
        toolCallId: `bash-warm-${stopKind}`,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
        signal: controller.signal,
        ...(stopKind === 'timeout' ? { deadlineAt: Date.now() + 25 } : {}),
      });
      if (stopKind === 'abort') controller.abort();

      await expect(preparing).rejects.toMatchObject({
        name: stopKind === 'abort' ? 'AbortError' : 'TimeoutError',
      });
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
      workspaceSessionControl.delayReady = false;
      workspaceSessionControl.releaseReady?.();
      workspaceSessionControl.releaseReady = undefined;
    },
  );

  it.skipIf(process.platform === 'win32')(
    "does not wait for another workspace's POSIX warm-up",
    async () => {
      const slowRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-warm-slow-'));
      const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-warm-other-'));
      tempRoots.push(slowRoot, otherRoot);
      workspaceSessionControl.delayReady = true;
      createAsrtShellSandbox({
        workspaceRoot: slowRoot,
        shouldSandbox: () => true,
      });
      await vi.waitFor(() => expect(workspaceSessionControl.releaseReady).toBeDefined());
      workspaceSessionControl.delayReady = false;
      const otherSandbox = createAsrtShellSandbox({
        workspaceRoot: otherRoot,
        shouldSandbox: () => true,
      });

      let otherSettled = false;
      let otherResult: unknown;
      let otherFailure: unknown;
      const otherPreparation = otherSandbox.prepare({
        toolCallId: 'bash-other-warm-up',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: otherRoot,
        env: process.env,
      }).then((result) => {
        otherResult = result;
        otherSettled = true;
      }, (error: unknown) => {
        otherFailure = error;
        otherSettled = true;
      });
      await vi.waitFor(
        () => expect(otherSettled).toBe(true),
        { timeout: 30_000 },
      );

      await otherPreparation;
      expect(otherFailure).toBeUndefined();
      expect(otherResult).toEqual(expect.objectContaining({
        executable: process.execPath,
        cleanup: expect.any(Function),
      }));
      expect(workspaceSessionControl.releaseReady).toBeDefined();
      try {
        await (otherResult as { cleanup: () => Promise<unknown> }).cleanup();
      } finally {
        workspaceSessionControl.releaseReady?.();
        workspaceSessionControl.releaseReady = undefined;
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'falls back without initializing ACLs while an ordinary filesystem effect is active',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-acl-fence-'));
      tempRoots.push(root);
      const releaseActiveEffect = await acquireFileSystemMutationLease();
      let preparing: ReturnType<ReturnType<typeof createAsrtShellSandbox>['prepare']>;
      let preparedPrematurely = false;
      let sessionCountWhileBlocked = 0;
      try {
        const sandbox = createAsrtShellSandbox({
          workspaceRoot: root,
          shouldSandbox: () => true,
        });
        preparing = sandbox.prepare({
          toolCallId: 'acl-fence',
          toolInput: { command: 'echo safe' },
          command: 'echo safe',
          cwd: root,
          env: process.env,
        });
        preparedPrematurely = await Promise.race([
          preparing.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 300)),
        ]);
        sessionCountWhileBlocked = capturedWorkspaceSessionConfigs.length;
      } finally {
        await releaseActiveEffect();
      }

      const invocation = await preparing!;
      try {
        expect(preparedPrematurely).toBe(true);
        expect(sessionCountWhileBlocked).toBe(0);
        expect(invocation).toBeUndefined();
      } finally {
        await invocation?.cleanup();
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'starts a POSIX workspace session while an ordinary shell effect is active',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-posix-shell-overlap-'));
      tempRoots.push(root);
      const releaseActiveEffect = await acquireFileSystemMutationLease();
      let preparing: ReturnType<ReturnType<typeof createAsrtShellSandbox>['prepare']>;
      let preparedPrematurely = false;
      let sessionCountWhileBlocked = 0;
      try {
        const sandbox = createAsrtShellSandbox({
          workspaceRoot: root,
          shouldSandbox: () => true,
        });
        preparing = sandbox.prepare({
          toolCallId: 'posix-shell-overlap',
          toolInput: { command: 'echo safe' },
          command: 'echo safe',
          cwd: root,
          env: process.env,
        });
        preparedPrematurely = await Promise.race([
          preparing.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 300)),
        ]);
        sessionCountWhileBlocked = capturedWorkspaceSessionConfigs.length;
      } finally {
        await releaseActiveEffect();
      }

      const invocation = await preparing!;
      try {
        expect(preparedPrematurely).toBe(true);
        expect(sessionCountWhileBlocked).toBe(1);
        expect(invocation).toEqual(expect.objectContaining({
          executable: process.execPath,
          cleanup: expect.any(Function),
        }));
      } finally {
        await invocation?.cleanup();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not materialize workspace grants before an admitted Windows command',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-shell-lean-warm-'));
      const agentHome = path.join(root, 'agent-home');
      const workspace = path.join(root, 'workspace');
      tempRoots.push(root);
      await mkdir(workspace, { recursive: true });
      vi.stubEnv('KODAX_HOME', agentHome);

      createAsrtShellSandbox({
        workspaceRoot: workspace,
        shouldSandbox: () => true,
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'scopes workspace sessions to the actual command toolchain paths',
    async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-path-workspace-'));
      const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-path-profile-'));
      const externalToolRoot = await mkdtemp(path.join(process.cwd(), '.kodax-asrt-path-external-'));
      tempRoots.push(workspace, profileRoot, externalToolRoot);
      const roamingRoot = path.join(profileRoot, 'Roaming');
      const localRoot = path.join(profileRoot, 'Local');
      const programsRoot = path.join(localRoot, 'Programs');
      const commandTempRoot = path.join(localRoot, 'Temp');
      const managerRoot = path.join(roamingRoot, 'fnm');
      const nodeVersionsRoot = path.join(managerRoot, 'node-versions');
      const versionReleaseRoot = path.join(nodeVersionsRoot, 'v1');
      const versionRoot = path.join(versionReleaseRoot, 'installation');
      const externalVersionReleaseRoot = path.join(nodeVersionsRoot, 'v2');
      const externalLinkVersionRoot = path.join(externalVersionReleaseRoot, 'installation');
      const nvmRoot = path.join(roamingRoot, 'nvm');
      const nvmVersionRoot = path.join(nvmRoot, 'v22');
      const pyenvRoot = path.join(programsRoot, 'pyenv');
      const pyenvVersionsRoot = path.join(pyenvRoot, 'versions');
      const pythonVersionRoot = path.join(pyenvVersionsRoot, '3.12');
      const pythonScripts = path.join(pythonVersionRoot, 'Scripts');
      const miseRoot = path.join(localRoot, 'mise');
      const miseInstallsRoot = path.join(miseRoot, 'installs');
      const miseToolRoot = path.join(miseInstallsRoot, 'python');
      const miseVersionRoot = path.join(miseToolRoot, '3.13');
      const miseBin = path.join(miseVersionRoot, 'bin');
      const activeToolRoot = path.join(localRoot, 'fnm_multishells');
      const activeToolchain = path.join(activeToolRoot, 'active-toolchain');
      const activeNvmToolchain = path.join(activeToolRoot, 'active-nvm');
      const externalActiveToolchain = path.join(externalToolRoot, 'active-toolchain');
      const sensitiveToolchain = path.join(localRoot, 'sensitive-toolchain');
      const missingToolchain = path.join(localRoot, 'missing-toolchain');
      const systemToolchain = path.join(localRoot, 'system-toolchain');
      const shimRoot = path.join(roamingRoot, '.tool-manager');
      const shimDirectory = path.join(shimRoot, 'shims');
      const packageRoot = path.join(roamingRoot, 'node_modules');
      const packageBin = path.join(packageRoot, '.bin');
      const shellManager = path.join(programsRoot, '.shell-manager');
      const shellDirectory = path.join(shellManager, 'bin');
      const shellExecutable = path.join(shellDirectory, 'shell.exe');
      const documentsScripts = path.join(profileRoot, 'Documents', 'venv', 'Scripts');
      const windowsApps = path.join(localRoot, 'Microsoft', 'WindowsApps');
      const sensitiveTarget = path.resolve(process.env.KODAX_HOME!);
      await mkdir(versionRoot, { recursive: true });
      await mkdir(externalLinkVersionRoot, { recursive: true });
      await mkdir(nvmVersionRoot, { recursive: true });
      await mkdir(pythonScripts, { recursive: true });
      await mkdir(miseBin, { recursive: true });
      await mkdir(activeToolRoot, { recursive: true });
      await mkdir(shimDirectory, { recursive: true });
      await mkdir(packageBin, { recursive: true });
      await mkdir(shellDirectory, { recursive: true });
      await mkdir(documentsScripts, { recursive: true });
      await mkdir(windowsApps, { recursive: true });
      await mkdir(sensitiveTarget, { recursive: true });
      await writeFile(path.join(versionRoot, 'tool.exe'), 'tool', 'utf8');
      await writeFile(shellExecutable, 'shell', 'utf8');
      await symlink(versionRoot, activeToolchain, 'junction');
      await symlink(nvmVersionRoot, activeNvmToolchain, 'junction');
      await symlink(externalLinkVersionRoot, externalActiveToolchain, 'junction');
      await symlink(
        path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
        systemToolchain,
        'junction',
      );
      expect(realpathSync(sensitiveTarget)).toBe(sensitiveTarget);
      await symlink(sensitiveTarget, sensitiveToolchain, 'junction');
      vi.stubEnv('APPDATA', roamingRoot);
      vi.stubEnv('LOCALAPPDATA', localRoot);

      const sandbox = createAsrtShellSandbox({
        workspaceRoot: workspace,
        shouldSandbox: () => true,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);

      const commandPath = [
        activeToolchain,
        activeNvmToolchain,
        externalActiveToolchain,
        pythonScripts,
        miseBin,
        shimDirectory,
        packageBin,
        documentsScripts,
        windowsApps,
        missingToolchain,
        systemToolchain,
        sensitiveToolchain,
        path.join(sensitiveTarget, 'bin'),
      ];
      const commandEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'),
      );
      commandEnvironment.APPDATA = path.join(profileRoot, 'forged-roaming');
      commandEnvironment.LOCALAPPDATA = path.join(profileRoot, 'forged-local');
      commandEnvironment.TEMP = commandTempRoot;
      commandEnvironment.TMP = commandTempRoot;
      commandEnvironment.pAtH = commandPath.join(path.delimiter);
      const first = await sandbox.prepare({
        toolCallId: 'profile-toolchain-path-1',
        toolInput: { command: 'tool --version' },
        command: 'tool --version',
        executable: shellExecutable,
        args: ['/c', 'tool --version'],
        cwd: workspace,
        env: commandEnvironment,
      });
      if (!first) throw new Error('expected a command-scoped workspace invocation');
      await first.cleanup();

      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
      const scopedConfig = capturedWorkspaceSessionConfigs[0] as {
        readonly filesystem: { readonly allowRead: readonly string[] };
      };
      expect(scopedConfig.filesystem.allowRead).toEqual(expect.arrayContaining([
        path.resolve(activeToolchain),
        path.resolve(versionRoot),
        path.resolve(versionReleaseRoot),
        path.resolve(nodeVersionsRoot),
        path.resolve(externalLinkVersionRoot),
        path.resolve(externalVersionReleaseRoot),
        path.resolve(activeNvmToolchain),
        path.resolve(nvmVersionRoot),
        path.resolve(pythonScripts),
        path.resolve(miseBin),
        path.resolve(shimDirectory),
        path.resolve(packageBin),
        path.resolve(shellDirectory),
        path.resolve(documentsScripts),
        path.resolve(windowsApps),
        path.dirname(process.execPath),
      ]));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(roamingRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(localRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(programsRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(commandTempRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(activeToolRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(managerRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(nvmRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(pyenvRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(miseRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(shimRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(packageRoot));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(shellManager));
      expect(scopedConfig.filesystem.allowRead).not.toContain(
        path.resolve(profileRoot, 'Documents'),
      );
      expect(scopedConfig.filesystem.allowRead).not.toContain(
        path.resolve(localRoot, 'Microsoft'),
      );
      expect(scopedConfig.filesystem.allowRead).not.toContain(
        path.resolve(profileRoot, 'forged-local'),
      );
      expect(scopedConfig.filesystem.allowRead).toContain(path.resolve(systemToolchain));
      expect(scopedConfig.filesystem.allowRead).not.toContain(path.resolve(missingToolchain));
      expect(scopedConfig.filesystem.allowRead).not.toContain(
        path.resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
      );
      expect(scopedConfig.filesystem.allowRead).not.toContain(
        path.resolve(sensitiveTarget, 'bin'),
      );
      expect(scopedConfig.filesystem.allowRead).not.toContain(
        path.resolve(sensitiveToolchain),
      );
      expect(scopedConfig.filesystem.allowRead).not.toContain(
        path.resolve(externalActiveToolchain),
      );

      commandEnvironment.pAtH = [...commandPath].reverse().join(path.delimiter);
      const second = await sandbox.prepare({
        toolCallId: 'profile-toolchain-path-2',
        toolInput: { command: 'tool --version' },
        command: 'tool --version',
        executable: shellExecutable,
        args: ['/c', 'tool --version'],
        cwd: workspace,
        env: commandEnvironment,
      });
      if (!second) throw new Error('expected the normalized toolchain scope to remain available');
      await second.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'resets the previous Windows toolchain scope before admitting another one',
    async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-path-switch-'));
      const toolchainA = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-tool-a-'));
      const toolchainB = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-tool-b-'));
      tempRoots.push(workspace, toolchainA, toolchainB);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: workspace,
        shouldSandbox: () => true,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);

      const first = await sandbox.prepare({
        toolCallId: 'toolchain-scope-a',
        toolInput: { command: 'tool-a --version' },
        command: 'tool-a --version',
        windowsVerbatimArguments: true,
        cwd: workspace,
        env: { PATH: toolchainA },
      });
      if (!first) throw new Error('expected first toolchain invocation');
      workspaceSessionControl.delayClose = true;
      const firstCleanup = first.cleanup();
      await vi.waitFor(() => expect(workspaceSessionControl.releaseClose).toBeTypeOf('function'));
      expect(capturedWorkspaceRequests.at(-1)?.windowsVerbatimArguments).toBe(true);
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);

      const secondPending = sandbox.prepare({
        toolCallId: 'toolchain-scope-b',
        toolInput: { command: 'tool-b --version' },
        command: 'tool-b --version',
        cwd: workspace,
        env: { PATH: toolchainB },
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
      workspaceSessionControl.delayClose = false;
      workspaceSessionControl.releaseClose?.();
      workspaceSessionControl.releaseClose = undefined;
      await firstCleanup;
      await waitForWorkspaceSessionResetsForTest();

      await expect(secondPending).resolves.toBeUndefined();
      const second = await sandbox.prepare({
        toolCallId: 'toolchain-scope-b-after-reset',
        toolInput: { command: 'tool-b --version' },
        command: 'tool-b --version',
        cwd: workspace,
        env: { PATH: toolchainB },
      });
      if (!second) throw new Error('expected second toolchain invocation after reset');
      await second.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
      const firstConfig = capturedWorkspaceSessionConfigs[0] as {
        readonly filesystem: { readonly allowRead: readonly string[] };
      };
      const secondConfig = capturedWorkspaceSessionConfigs[1] as {
        readonly filesystem: { readonly allowRead: readonly string[] };
      };
      expect(firstConfig.filesystem.allowRead).toContain(path.resolve(toolchainA));
      expect(secondConfig.filesystem.allowRead).toContain(path.resolve(toolchainB));
      expect(secondConfig.filesystem.allowRead).not.toContain(path.resolve(toolchainA));
    },
  );

  it.runIf(process.platform === 'win32')(
    'waits for command-scoped ACL initialization before returning an invocation',
    async () => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-path-race-'));
      const toolchain = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-path-race-tool-'));
      tempRoots.push(workspace, toolchain);
      workspaceSessionControl.delayReady = true;
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: workspace,
        shouldSandbox: () => true,
      });
      const preparing = sandbox.prepare({
        toolCallId: 'profile-toolchain-path-race',
        toolInput: { command: 'tool --version' },
        command: 'tool --version',
        cwd: workspace,
        env: { PATH: toolchain },
      });

      await vi.waitFor(() => {
        expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
        expect(workspaceSessionControl.releaseReady).toBeTypeOf('function');
      }, { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
      workspaceSessionControl.delayReady = false;
      workspaceSessionControl.releaseReady?.();
      workspaceSessionControl.releaseReady = undefined;

      const prepared = await preparing;
      if (!prepared) throw new Error('expected a command-scoped workspace invocation');
      await prepared.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
    },
  );

  it('prepares only an admitted concrete call with workspace/temp writes and normal local network', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-shell-'));
    const additionalReadRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-read-'));
    const additionalWriteRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-write-'));
    tempRoots.push(root, additionalReadRoot, additionalWriteRoot);
    const home = path.resolve(os.homedir());
    const customAgentHome = path.join(root, 'custom-agent-home');
    vi.stubEnv('KODAX_HOME', customAgentHome);
    const agentsDirectory = path.join(customAgentHome, 'agents');
    const sessionsDirectory = path.join(customAgentHome, 'sessions');
    const runtimeDirectory = path.join(customAgentHome, 'runtime');
    const legacyProcessesDirectory = path.join(customAgentHome, 'processes');
    const learnedDirectory = path.join(customAgentHome, 'learned');
    const brokenAgentHomeLink = path.join(customAgentHome, 'broken-link');
    const nestedBrokenContainer = path.join(customAgentHome, 'broken-container');
    const nestedBrokenAgentHomeLink = path.join(nestedBrokenContainer, 'broken-link');
    const agentHomeRootAlias = path.join(customAgentHome, 'root-alias');
    const ordinaryWorkingDirectory = path.join(customAgentHome, 'work-output');
    const newOrdinaryOutput = path.join(ordinaryWorkingDirectory, 'nested', 'result.txt');
    await mkdir(agentsDirectory, { recursive: true });
    await mkdir(sessionsDirectory, { recursive: true });
    await mkdir(runtimeDirectory, { recursive: true });
    await mkdir(legacyProcessesDirectory, { recursive: true });
    await mkdir(learnedDirectory, { recursive: true });
    await mkdir(ordinaryWorkingDirectory, { recursive: true });
    await mkdir(nestedBrokenContainer, { recursive: true });
    const reviewableConfig = path.join(customAgentHome, 'config.json');
    const reviewableToken = path.join(customAgentHome, 'mcp-tokens', 'token.json');
    await mkdir(path.dirname(reviewableToken), { recursive: true });
    await writeFile(reviewableConfig, '{}', 'utf8');
    await writeFile(reviewableToken, 'reviewed-token', 'utf8');
    if (process.platform === 'win32') {
      await symlink(
        path.join(customAgentHome, 'missing-target'),
        brokenAgentHomeLink,
        'junction',
      );
      await symlink(
        path.join(customAgentHome, 'missing-nested-target'),
        nestedBrokenAgentHomeLink,
        'junction',
      );
      await symlink(customAgentHome, agentHomeRootAlias, 'junction');
    }
    const homePathEntry = process.platform === 'win32'
      ? `${home[0]!.toLowerCase()}${home.slice(1)}`
      : home;
    const sensitivePathEntry = path.join(home, '.ssh', 'bin');
    const ordinaryHomePathEntry = path.join(root, 'tools', 'bin');
    await mkdir(ordinaryHomePathEntry, { recursive: true });
    vi.stubEnv('PATH', [
      homePathEntry,
      sensitivePathEntry,
      ordinaryHomePathEntry,
      process.env.PATH,
    ].filter((entry): entry is string => entry !== undefined).join(path.delimiter));
    const shouldSandbox = vi.fn(() => ({
      agentHomeAccess: {
        read: [reviewableConfig, reviewableToken],
        write: [
          agentsDirectory,
          sessionsDirectory,
          newOrdinaryOutput,
          customAgentHome,
          runtimeDirectory,
          brokenAgentHomeLink,
          nestedBrokenAgentHomeLink,
          agentHomeRootAlias,
        ],
      },
      filesystemAccess: {
        read: [additionalReadRoot],
        write: [additionalWriteRoot],
      },
    }));
    const reportObservation = vi.fn();
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox,
    });
    const childControlledTemp = path.join(path.parse(root).root, 'kodax-child-temp');

    const prepared = await sandbox.prepare({
      toolCallId: 'bash-1',
      toolInput: { command: 'copy a.txt b.txt' },
      command: 'copy a.txt b.txt',
      cwd: root,
      env: {
        PATH: process.env.PATH,
        TEMP: childControlledTemp,
        TEST_API_KEY: 'must-not-cross-the-broker',
        AWS_ACCESS_KEY_ID: 'must-not-cross-the-broker-either',
      },
      reportObservation,
    });

    expect(prepared).toBeDefined();
    if (!prepared) throw new Error('expected an admitted workspace invocation');
    let cleanupResult: Awaited<ReturnType<typeof prepared.cleanup>> | undefined;
    try {
      expect(shouldSandbox).toHaveBeenCalledWith(expect.objectContaining({
        id: 'bash-1',
        name: 'bash',
      }));
      const requestFile = prepared.args.find((arg) => arg.endsWith('.json'));
      expect(requestFile).toBeDefined();
      const request = JSON.parse(readFileSync(requestFile!, 'utf8')) as {
        readonly fallbackToNormalExecution?: boolean;
        readonly config: {
          readonly filesystem: {
            readonly allowRead: readonly string[];
            readonly allowWrite: readonly string[];
            readonly denyRead: readonly string[];
            readonly denyWrite: readonly string[];
          };
          readonly network: {
            readonly allowedDomains: readonly string[];
            readonly strictAllowlist: boolean;
          };
          readonly windows?: {
            readonly srtWin?: { readonly path?: string };
          };
        };
        readonly env: Readonly<Record<string, string>>;
        readonly allowAllNetwork?: boolean;
        readonly observationFile: string;
      };
      if (process.platform === 'win32') {
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(root));
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(customAgentHome));
        expect(request.config.filesystem.allowWrite).toEqual(expect.arrayContaining([
          path.resolve(agentsDirectory),
          path.resolve(sessionsDirectory),
        ]));
        expect(request.config.filesystem.allowWrite).not.toContain(
          path.resolve(reviewableToken),
        );
        expect(request.config.filesystem.allowWrite).toContain(
          path.resolve(ordinaryWorkingDirectory),
        );
        expect(request.config.filesystem.allowWrite).not.toContain(
          path.resolve(customAgentHome),
        );
        expect(request.config.filesystem.allowRead).toEqual(expect.arrayContaining([
          path.resolve(reviewableConfig),
          path.resolve(reviewableToken),
        ]));
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(runtimeDirectory));
        expect(request.config.filesystem.allowWrite).not.toContain(
          path.resolve(brokenAgentHomeLink),
        );
        expect(request.config.filesystem.allowWrite).not.toContain(
          path.resolve(nestedBrokenContainer),
        );
        expect(request.config.filesystem.allowWrite).not.toContain(
          path.resolve(agentHomeRootAlias),
        );
        expect(request.config.filesystem.allowWrite)
          .not.toContain(path.resolve(legacyProcessesDirectory));
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(learnedDirectory));
      } else {
        expect(request.config.filesystem.allowWrite).toContain(path.resolve(customAgentHome));
      }
      expect(request.config.filesystem.allowWrite).not.toContain(childControlledTemp);
      expect(request.config.filesystem.allowRead).toContain(path.resolve(additionalReadRoot));
      expect(request.config.filesystem.allowWrite).toContain(path.resolve(additionalWriteRoot));
      const sensitiveHomeReads = [
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
        path.join('AppData', 'Roaming', 'Microsoft', 'Credentials'),
        path.join('AppData', 'Roaming', 'Microsoft', 'Protect'),
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
      ].map((relative) => path.join(home, relative));
      if (process.platform === 'win32') {
        expect(request.config.filesystem.denyRead).toEqual([]);
        expect(request.config.filesystem.denyWrite).toEqual([]);
        const guardCall = capturedSyncSpawns.find((call) => {
          const encodedIndex = call.args.indexOf('-EncodedCommand');
          if (encodedIndex < 0) return false;
          return Buffer.from(call.args[encodedIndex + 1] ?? '', 'base64')
            .toString('utf16le')
            .includes('KodaXAsrtAclGuard-v1');
        });
        expect(guardCall?.input).toBeDefined();
        const guarded = JSON.parse(guardCall!.input!) as {
          readonly paths: readonly {
            readonly path: string;
            readonly directory: boolean;
            readonly mode: string;
          }[];
        };
        expect(guarded.paths).toContainEqual({
          path: path.resolve(customAgentHome),
          directory: true,
          mode: 'read',
        });
        if (statSync(path.join(home, '.ssh'), { throwIfNoEntry: false })) {
          expect(guarded.paths).toContainEqual({
            path: path.resolve(home, '.ssh'),
            directory: true,
            mode: 'read',
          });
        }
      } else {
        expect(request.config.filesystem.denyRead).toEqual(
          expect.arrayContaining(sensitiveHomeReads),
        );
        expect(request.config.filesystem.denyWrite)
          .toContain(path.resolve(customAgentHome, 'runtime'));
        expect(request.config.filesystem.denyWrite)
          .toContain(path.resolve(customAgentHome, 'processes'));
        expect(request.config.filesystem.denyWrite)
          .toContain(path.resolve(customAgentHome, 'learned'));
      }
      expect(request.config.filesystem.denyRead).not.toContain(path.resolve(reviewableToken));
      expect(request.config.filesystem.denyWrite)
        .not.toContain(path.resolve(customAgentHome));
      expect(request.config.filesystem.allowRead).not.toContain(homePathEntry);
      expect(request.config.filesystem.allowRead).not.toContain(sensitivePathEntry);
      if (isPathInside(home, ordinaryHomePathEntry)) {
        expect(request.config.filesystem.allowRead).toContain(ordinaryHomePathEntry);
      } else {
        expect(request.config.filesystem.allowRead).not.toContain(ordinaryHomePathEntry);
      }
      const sessionConfig = capturedWorkspaceSessionConfigs.at(-1) as {
        readonly filesystem: {
          readonly allowRead: readonly string[];
          readonly denyRead: readonly string[];
          readonly denyWrite: readonly string[];
        };
        readonly windows?: {
          readonly srtWin?: { readonly path?: string };
        };
      };
      expect(sessionConfig.filesystem.denyRead).toEqual(
        request.config.filesystem.denyRead,
      );
      if (process.platform === 'win32') {
        const runnerDirectory = request.config.filesystem.allowRead.find(
          (entry) => entry.includes(path.join('sandbox-runtime', 'runner')),
        );
        expect(runnerDirectory).toBeDefined();
        expect(request.config.filesystem.denyWrite).not.toContain(runnerDirectory);
        expect(request.config.windows?.srtWin?.path).toBe(
          path.join(runnerDirectory!, 'srt-win.exe'),
        );
        expect(sessionConfig.filesystem.allowRead).toContain(runnerDirectory);
        expect(sessionConfig.filesystem.denyWrite).not.toContain(runnerDirectory);
        expect(sessionConfig.windows?.srtWin?.path).toBe(
          path.join(runnerDirectory!, 'srt-win.exe'),
        );
        expect(capturedSpawnCwds).toContain(runnerDirectory);
        expect(request.config.filesystem.allowRead).not.toContain(
          path.resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
        );
        expect(request.config.filesystem.allowWrite).not.toContain(
          path.resolve(process.env.SystemRoot ?? 'C:\\Windows', 'Temp'),
        );
      }
      expect(requestFile).toContain(`${path.sep}sandbox-runtime${path.sep}`);
      expect(request).toHaveProperty('wrappedInvocation');
      expect(request.config.network.allowedDomains).toEqual([]);
      expect(request.config.network.strictAllowlist).toBe(false);
      expect(request.allowAllNetwork).toBe(true);
      expect(request.fallbackToNormalExecution).toBe(true);
      expect(request.env.TEST_API_KEY).toBe('must-not-cross-the-broker');
      expect(request.env.AWS_ACCESS_KEY_ID).toBe('must-not-cross-the-broker-either');
      if (process.platform === 'win32') {
        expect(request.env.TEMP).toContain(`${path.sep}kodax-sandbox${path.sep}`);
        expect(request.env.TMP).toBe(request.env.TEMP);
        expect(request.env.TMPDIR).toBe(request.env.TEMP);
        expect(request.env.TEMP).not.toBe(childControlledTemp);
        expect(request.env.GIT_CONFIG_GLOBAL).toBe('NUL');
        expect(request.env.GIT_CONFIG_NOSYSTEM).toBe('1');
      }
      await writeFile(request.observationFile, JSON.stringify({
        version: 1,
        state: 'applied',
        backend: sandboxRuntimeCapability().backend,
        policyId: 'kodax-workspace-shell-v1',
      }), 'utf8');
      expect(reportObservation).not.toHaveBeenCalled();
    } finally {
      cleanupResult = await prepared.cleanup();
    }
    expect(cleanupResult).toMatchObject({
      state: 'applied',
      backend: sandboxRuntimeCapability().backend,
      policyId: 'kodax-workspace-shell-v1',
    });
  });

  it.runIf(process.platform === 'win32')(
    'uses ordinary permission fallback for a missing external write target',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-missing-write-'));
      const missingTarget = path.join(root, '..', `${path.basename(root)}-missing`, 'output.txt');
      tempRoots.push(root);
      const reportObservation = vi.fn();
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          filesystemAccess: { read: [], write: [missingTarget] },
        }),
      });

      await expect(sandbox.prepare({
        toolCallId: 'missing-external-write',
        toolInput: { command: 'echo content > output.txt' },
        command: 'echo content > output.txt',
        cwd: root,
        env: process.env,
        reportObservation,
      })).resolves.toBeUndefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
      expect(reportObservation).toHaveBeenCalledWith({
        version: 1,
        state: 'fallback',
        reason: 'not_ready',
        execution: 'normal_permission_policy',
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps persistent Windows sensitive-root guards outside ASRT startup propagation',
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-home-'));
      tempRoots.push(home);
      vi.stubEnv('USERPROFILE', home);
      const agentHome = path.join(home, '.kodax');
      await Promise.all(['', 'runtime', 'processes', 'learned'].map((directory) => (
        mkdir(path.join(agentHome, directory), { recursive: true })
      )));
      await Promise.all([
        mkdir(path.join(home, '.ssh')),
        mkdir(path.join(home, 'AppData')),
      ]);
      vi.stubEnv('KODAX_HOME', agentHome);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: home,
        shouldSandbox: () => true,
      });

      const prepared = await sandbox.prepare({
        toolCallId: 'bash-home-workspace',
        toolInput: { command: 'echo safe' },
        command: 'echo safe',
        cwd: home,
        env: { Path: process.env.Path ?? process.env.PATH },
      });
      if (!prepared) throw new Error('expected home workspace invocation');
      try {
        const requestFile = prepared.args.find((arg) => arg.endsWith('.json'));
        if (!requestFile) throw new Error('expected broker request');
        const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
          readonly config: { readonly filesystem: { readonly denyRead: readonly string[] } };
        };
        expect(request.config.filesystem.denyRead).toEqual([]);
        const guardedPaths = capturedSyncSpawns.flatMap((call) => {
          const encodedIndex = call.args.indexOf('-EncodedCommand');
          if (encodedIndex < 0) return [];
          const script = Buffer.from(call.args[encodedIndex + 1] ?? '', 'base64')
            .toString('utf16le');
          if (!script.includes('KodaXAsrtAclGuard-v1') || !call.input) return [];
          return (JSON.parse(call.input) as {
            readonly paths: readonly { readonly path: string }[];
          }).paths.map((entry) => entry.path);
        });
        expect(guardedPaths).toContain(path.join(home, '.ssh'));
        const guardScript = capturedSyncSpawns
          .map((call) => {
            const encodedIndex = call.args.indexOf('-EncodedCommand');
            return encodedIndex < 0
              ? ''
              : Buffer.from(call.args[encodedIndex + 1] ?? '', 'base64')
                .toString('utf16le');
          })
          .find((script) => script.includes('KodaXAsrtAclGuard-v1'));
        expect(guardScript).toContain('icacls.exe');
        expect(guardScript).toContain('Add-KodaXAsrtWriteAclRule');
        expect(guardScript).toContain('PropagationFlags]::InheritOnly');
      } finally {
        await prepared.cleanup();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'canonicalizes a junction workspace before granting Agent Home write roots',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-workspace-link-'));
      tempRoots.push(root);
      const physicalWorkspace = path.join(root, 'physical-workspace');
      const workspaceAlias = path.join(root, 'alias-parent', 'workspace-link');
      const agentHome = path.join(physicalWorkspace, 'custom-agent-home');
      const agentsDirectory = path.join(agentHome, 'agents');
      const runtimeDirectory = path.join(agentHome, 'runtime');
      await mkdir(agentsDirectory, { recursive: true });
      await mkdir(runtimeDirectory, { recursive: true });
      await mkdir(path.dirname(workspaceAlias), { recursive: true });
      await symlink(physicalWorkspace, workspaceAlias, 'junction');
      vi.stubEnv('KODAX_HOME', agentHome);

      const sandbox = createAsrtShellSandbox({
        workspaceRoot: workspaceAlias,
        shouldSandbox: () => ({
          agentHomeAccess: { read: [], write: [agentsDirectory] },
        }),
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-junction-workspace',
        toolInput: { command: 'echo safe' },
        command: 'echo safe',
        cwd: workspaceAlias,
        env: process.env,
      });
      if (!prepared) throw new Error('expected junction workspace invocation');
      try {
        const requestFile = prepared.args.find((arg) => arg.endsWith('.json'));
        if (!requestFile) throw new Error('expected junction broker request');
        const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
          readonly config: { readonly filesystem: { readonly allowWrite: readonly string[] } };
        };
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(workspaceAlias));
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(physicalWorkspace));
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(agentHome));
        expect(request.config.filesystem.allowWrite).not.toContain(path.resolve(runtimeDirectory));
        expect(request.config.filesystem.allowWrite).toContain(path.resolve(agentsDirectory));
      } finally {
        await prepared.cleanup();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'installs write-only Git metadata guards before stripping ASRT denies',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-git-guards-'));
      tempRoots.push(root);
      const gitDirectory = path.join(root, '.git');
      const gitConfig = path.join(gitDirectory, 'config');
      const gitHooks = path.join(gitDirectory, 'hooks');
      await mkdir(gitHooks, { recursive: true });
      await writeFile(gitConfig, '[core]\n', 'utf8');

      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-git-guards',
        toolInput: { command: 'git status --short' },
        command: 'git status --short',
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected Git guard workspace invocation');
      const concurrent = await sandbox.prepare({
        toolCallId: 'bash-git-guards-concurrent',
        toolInput: { command: 'git status --short' },
        command: 'git status --short',
        cwd: root,
        env: process.env,
      });
      try {
        expect(concurrent).toBeDefined();
        const guardPayloads = capturedSyncSpawns.flatMap((call) => {
          const encodedIndex = call.args.indexOf('-EncodedCommand');
          if (encodedIndex < 0 || !call.input) return [];
          const script = Buffer.from(call.args[encodedIndex + 1] ?? '', 'base64')
            .toString('utf16le');
          return script.includes('KodaXAsrtAclGuard-v1')
            ? [JSON.parse(call.input) as {
                readonly install: boolean;
                readonly paths: readonly { readonly path: string; readonly mode: string }[];
              }]
            : [];
        });
        expect(guardPayloads).toContainEqual(expect.objectContaining({
          install: true,
          paths: expect.arrayContaining([
            { path: gitConfig, mode: 'write', directory: false },
            { path: gitHooks, mode: 'write', directory: true },
          ]),
        }));
        const sessionConfig = capturedWorkspaceSessionConfigs.at(-1) as {
          readonly filesystem: { readonly denyWrite: readonly string[] };
        };
        expect(sessionConfig.filesystem.denyWrite).toEqual([]);
      } finally {
        await concurrent?.cleanup();
        await prepared.cleanup();
      }
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'recovers orphaned Windows ACLs before starting the first workspace session',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-acl-recovery-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-workspace-acl-recovery',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected recovered workspace invocation');
      const requestFile = prepared.args.find((arg) => arg.endsWith('.json'));
      if (!requestFile) throw new Error('expected recovered broker request');
      const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
        readonly observationFile: string;
      };
      await writeFile(request.observationFile, JSON.stringify({
        version: 1,
        state: 'applied',
        backend: sandboxRuntimeCapability().backend,
        policyId: 'kodax-workspace-shell-v1',
      }), 'utf8');
      await prepared.cleanup();

      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover') && args.includes('--json')
      ))).toHaveLength(2);
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'falls back without spawning a workspace owner when its durable ACL poison marker cannot be written',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-marker-failure-'));
      tempRoots.push(root);
      await doctorSandboxRuntime({ refresh: true });
      const ownerSpawnCount = capturedWorkspaceOwnerArgv().length;
      fileSystemMock.writeAclPoisonMarkerFailure = true;
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });

      await expect(prepare('bash-workspace-marker-failure')).resolves.toBeUndefined();
      expect(capturedWorkspaceOwnerArgv()).toHaveLength(ownerSpawnCount);
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);

      fileSystemMock.writeAclPoisonMarkerFailure = false;
      const recovered = await prepare('bash-workspace-marker-recovered');
      expect(recovered).toBeDefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
      await recovered?.cleanup();
    },
  );

  it.runIf(process.platform === 'win32')(
    'confirms a clean workspace owner EOF without requiring uncertain tree capture',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-shutdown-'));
      tempRoots.push(root);
      processTreeKillMock.outcome = 'unknown';
      processTreeKillMock.childPid = 91234;
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-workspace-shutdown',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected workspace invocation before shutdown');
      await prepared.cleanup();
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await expect(readdir(poisonDirectory)).resolves.toEqual([]);
      expect(fileSystemMock.aclPoisonMarkerWriteTargets).not.toEqual([]);
      expect(fileSystemMock.aclPoisonMarkerWriteTargets.every(
        (target) => path.basename(path.dirname(target)) === 'acl-poison-staging',
      )).toBe(true);

      await shutdownAsrtWorkspaceSessions();

      await expect(readdir(poisonDirectory)).resolves.toEqual([]);
      expect(capturedProcessTreeKillOptions).toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'releases the Windows workspace owner when command cleanup completes',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-command-owner-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const globalPoisonDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );

      const first = await prepare('bash-command-owner-first');
      if (!first) throw new Error('expected first workspace invocation');
      await expect(readdir(poisonDirectory)).resolves.toHaveLength(1);
      await expect(readdir(globalPoisonDirectory)).resolves.toHaveLength(1);
      await first.cleanup();
      await expect(readdir(poisonDirectory)).resolves.toEqual([]);
      await expect(readdir(globalPoisonDirectory)).resolves.toEqual([]);

      const second = await prepare('bash-command-owner-second');
      if (!second) throw new Error('expected second workspace invocation');
      await second.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps a shared Runtime close pending until workspace ACL reset is confirmed',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shared-runtime-shutdown-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-shared-runtime-shutdown',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected workspace invocation before Runtime close');
      workspaceSessionControl.delayClose = true;
      const { createKodaXRuntime } = await import('./sdk-runtime.js');
      const runtime = await createKodaXRuntime({
        homeDir: root,
        sharedDaemonHost: true,
      });
      let closeCompleted = false;
      const closing = runtime.close().then(() => { closeCompleted = true; });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(closeCompleted).toBe(false);
      const cleanup = prepared.cleanup();
      await vi.waitFor(
        () => expect(workspaceSessionControl.releaseClose).toBeDefined(),
        { timeout: 5_000 },
      );
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      expect(closeCompleted).toBe(false);
      await expect(readdir(poisonDirectory)).resolves.toHaveLength(1);

      workspaceSessionControl.delayClose = false;
      workspaceSessionControl.releaseClose?.();
      workspaceSessionControl.releaseClose = undefined;
      await Promise.all([cleanup, closing]);

      await expect(readdir(poisonDirectory)).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'clears ACL owner markers after a timed-out cleanup later converges',
    async () => {
      let now = performance.now();
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-deferred-workspace-cleanup-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-deferred-workspace-cleanup',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected workspace invocation');
      const blocker = await acquireFileSystemMutationLease('deferred-cleanup-blocker');
      await blocker.bindEffectProcess(process.pid, false);
      const poisonDirectories = [
        path.join(path.resolve(process.env.KODAX_HOME!), 'sandbox-runtime', 'acl-poison'),
        path.join(
          path.resolve(process.env.ProgramData!),
          'KodaX',
          'sandbox-runtime',
          'acl-poison',
        ),
      ];

      const cleanup = prepared.cleanup();
      await vi.waitFor(() => expect(hasQueuedFileSystemCleanup()).toBe(true));
      now += 131_000;
      // The caller-visible cleanup resolves after its bounded idle-close wait;
      // the queued close keeps converging in the background without poisoning.
      await cleanup;
      for (const directory of poisonDirectories) {
        const entries = await readdir(directory);
        expect(entries.some((entry) => entry.startsWith('unconfirmed-owner-'))).toBe(false);
      }

      await blocker.finishEffectProcess();
      await blocker();
      await vi.waitFor(async () => {
        for (const directory of poisonDirectories) {
          await expect(readdir(directory)).resolves.toEqual([]);
        }
      }, { timeout: 10_000 });
      const afterCleanup = await acquireFileSystemMutationLease();
      await afterCleanup();
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not recreate ACL poison after reset succeeds but coordinator settlement fails',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-clean-reset-settlement-failure-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-clean-reset-settlement-failure',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected workspace invocation');
      recoveryLockMock.effectFailureStartCall = recoveryLockMock.effectCalls + 4;

      // Close failures surface as diagnostics now; the caller-visible cleanup
      // resolves after its bounded idle-close wait without creating poison.
      await prepared.cleanup();
      const poisonDirectories = [
        path.join(path.resolve(process.env.KODAX_HOME!), 'sandbox-runtime', 'acl-poison'),
        path.join(
          path.resolve(process.env.ProgramData!),
          'KodaX',
          'sandbox-runtime',
          'acl-poison',
        ),
      ];
      for (const directory of poisonDirectories) {
        const entries = await readdir(directory);
        expect(entries.some((entry) => entry.startsWith('unconfirmed-owner-'))).toBe(false);
      }
      const effectCallsAfterFailure = recoveryLockMock.effectCalls;
      const cleanupRequestsAfterFailure = workspaceSessionControl.cleanupRequests;
      recoveryLockMock.effectFailureStartCall = undefined;
      // The background close convergence retries the coordinator on its own;
      // no new session cleanup RPCs may be issued for that recovery.
      await vi.waitFor(() => {
        expect(recoveryLockMock.effectCalls).toBeGreaterThan(effectCallsAfterFailure);
      }, { timeout: 10_000 });
      await expect(Promise.all([
        prepared.cleanup(),
        prepared.cleanup(),
      ])).resolves.toEqual([undefined, undefined]);
      expect(workspaceSessionControl.cleanupRequests).toBe(cleanupRequestsAfterFailure);
      const effectCallsAfterRecovery = recoveryLockMock.effectCalls;
      await prepared.cleanup();
      expect(recoveryLockMock.effectCalls).toBe(effectCallsAfterRecovery);
    },
  );

  it.runIf(process.platform === 'win32')(
    'retries post-session ACL recovery and restores sandbox admission automatically',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-reset-recovery-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      const first = await prepare('bash-before-reset-recovery-failure');
      if (!first) throw new Error('expected first workspace invocation');
      windowsSandboxMock.aclRecoveryOutcome = 'malformed';
      // The failed close recovery surfaces as a diagnostic now; the cleanup
      // itself resolves after its bounded idle-close wait, and admission stays
      // failed closed until the automatic recovery converges.
      await first.cleanup();
      await expect(prepare('bash-after-reset-recovery-failure')).resolves.toBeUndefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
      windowsSandboxMock.aclRecoveryOutcome = 'success';
      let recovered: Awaited<ReturnType<typeof prepare>> = undefined;
      for (let attempt = 0; recovered === undefined && attempt < 10; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        recovered = await prepare(`bash-after-reset-recovery-success-${attempt}`);
      }
      if (!recovered) throw new Error('expected automatic ACL recovery to restore sandbox admission');
      await recovered.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'fails sandbox admission closed while a workspace session reset is pending',
    async () => {
      // Mirrors the 0.7.95 field report: a long-lived background command
      // (e.g. `kodax run` with a background bash) parks a cached workspace
      // session close that cannot finish, so pendingWorkspaceSessionResets
      // stays non-empty and every subsequent sandboxed text mutation fails
      // closed as unavailable instead of waiting.
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-text-pending-reset-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      const first = await prepare('bash-before-pending-reset');
      if (!first) throw new Error('expected first workspace invocation');

      workspaceSessionControl.delayClose = true;
      // Park the session close the way a long-lived background command does:
      // the close is tracked as a pending reset but cannot finish while the
      // command holds its cleanup fence.
      const parkedCleanup = first.cleanup();
      await vi.waitFor(() => expect(workspaceSessionControl.releaseClose).toBeTypeOf('function'));

      const startedAt = Date.now();
      await expect(prepare('bash-during-pending-reset')).resolves.toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      workspaceSessionControl.delayClose = false;
      workspaceSessionControl.releaseClose?.();
      workspaceSessionControl.releaseClose = undefined;
      await parkedCleanup;
      // Command cleanup no longer blocks on session close convergence (the
      // close is fire-and-forget behind the fence), so drain the reset here.
      await waitForWorkspaceSessionResetsForTest();

      const after = await prepare('bash-after-pending-reset');
      if (!after) throw new Error('expected admission to recover after the reset settled');
      await after.cleanup();
    },
  );

  it.runIf(process.platform === 'win32')(
    'reuses a cached workspace session while its close waits behind a held fence',
    async () => {
      // Issue 304 core acceptance: a long-lived command holds the exclusive
      // durable fence; an idle session's close parks in admission WITHOUT
      // evicting the cache, so same-policy admissions reuse the live session.
      // Releasing the fence converges the deferred close automatically.
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-text-fence-reuse-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      const first = await prepare('bash-under-held-fence-1');
      if (!first) throw new Error('expected first invocation');
      const releaseFence = await acquireExclusiveFileSystemEffectLease();
      try {
        await first.cleanup();
        const second = await prepare('bash-under-held-fence-2');
        if (!second) throw new Error('expected cached session reuse while the close waits on the fence');
        expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
        await second.cleanup();
      } finally {
        await releaseFence();
      }
      await releaseFence();
      // The parked close converges asynchronously once the fence frees; keep
      // preparing until the cached session is retired and a fresh one starts.
      let third: Awaited<ReturnType<typeof prepare>> = undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        await waitForWorkspaceSessionResetsForTest();
        const candidate = await prepare(`bash-after-fence-release-${attempt}`);
        if (candidate) {
          if (capturedWorkspaceSessionConfigs.length >= 2) {
            third = candidate;
            break;
          }
          await candidate.cleanup().then(
            () => undefined,
            () => undefined,
          );
        }
      }
      if (!third) throw new Error('expected a fresh session after the fence was released');
      await third.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps workspace admission working after a cleanup request times out behind live work',
    async () => {
      // A cleanup RPC that legitimately queues behind live work must time out
      // without failing the whole session: only the request is retired.
      const restoreTimeouts = overrideWorkspaceSessionRpcTimeoutsForTest({ cleanupMs: 60 });
      try {
        const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-cleanup-timeout-'));
        tempRoots.push(root);
        const sandbox = createAsrtShellSandbox({
          workspaceRoot: root,
          shouldSandbox: () => true,
        });
        const prepare = (toolCallId: string) => sandbox.prepare({
          toolCallId,
          toolInput: { command: 'node --version' },
          command: 'node --version',
          executable: process.execPath,
          args: ['--version'],
          cwd: root,
          env: process.env,
        });
        const first = await prepare('bash-cleanup-timeout-1');
        if (!first) throw new Error('expected first invocation');
        workspaceSessionControl.delayCleanup = true;
        await first.cleanup().then(
          () => undefined,
          () => undefined,
        );
        workspaceSessionControl.delayCleanup = false;
        workspaceSessionControl.releaseCleanup?.();
        workspaceSessionControl.releaseCleanup = undefined;
        await waitForWorkspaceSessionResetsForTest();
        const second = await prepare('bash-cleanup-timeout-2');
        if (!second) throw new Error('expected admission after a cleanup request timeout');
        await second.cleanup();
      } finally {
        restoreTimeouts();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'fails standalone admission structuredly while a leased workspace session is active',
    async () => {
      // A live lease keeps its session cached; standalone SDK admission must
      // fail with a clear contention error instead of terminating the lease.
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-standalone-leased-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      // A prepared-but-not-yet-cleaned-up invocation holds its session lease,
      // exactly like a live background bash.
      const first = await prepare('bash-leased-1');
      if (!first) throw new Error('expected leased invocation');
      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).rejects.toThrow(/leased workspace sandbox session/i);
      expect(capturedBrokerRequests).toHaveLength(0);
      await first.cleanup().then(
        () => undefined,
        () => undefined,
      );
    },
  );

  it.runIf(process.platform === 'win32')(
    'reports a structured session_reset_pending reason for sandboxed text mutations',
    async () => {
      // The 304 user-facing contract: while this policy's session reset is
      // parked mid-action, a sandboxed text mutation must fail closed with a
      // structured reason, not a bare unavailable.
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-text-pending-reason-'));
      tempRoots.push(root);
      const sandbox = createAsrtTextFileMutationSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const shellSandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const first = await shellSandbox.prepare({
        toolCallId: 'bash-before-pending-reason',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!first) throw new Error('expected first workspace invocation');
      const target = path.join(root, 'hello.md');
      workspaceSessionControl.delayClose = true;
      const parkedCleanup = first.cleanup();
      await vi.waitFor(() => expect(workspaceSessionControl.releaseClose).toBeTypeOf('function'));
      const denied = await sandbox.read({
        toolCallId: 'read-during-pending-reason',
        toolName: 'write',
        toolInput: { path: target, content: 'hello' },
        path: target,
      });
      expect(denied).toMatchObject({
        status: 'unavailable',
        reason: 'session_reset_pending',
      });
      workspaceSessionControl.delayClose = false;
      workspaceSessionControl.releaseClose?.();
      workspaceSessionControl.releaseClose = undefined;
      await parkedCleanup;
      await waitForWorkspaceSessionResetsForTest();
    },
  );

  it.runIf(process.platform === 'win32')(
    'blocks admission globally while a forced session reset is pending',
    async () => {
      // Forced (shutdown-path) resets carry no policy key, so they stay
      // account-wide blockers: the scoped gate must still fail closed for the
      // same policy while a forced close parks mid-action.
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-forced-pending-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      const first = await prepare('bash-before-forced-reset');
      if (!first) throw new Error('expected first invocation');
      const releaseFence = await acquireExclusiveFileSystemEffectLease();
      await first.cleanup();
      const shutdown = shutdownAsrtWorkspaceSessions();
      // The forced close parks behind the held fence and registers its
      // account-wide pending reset; admission must fail closed meanwhile.
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      const startedAt = Date.now();
      await expect(prepare('bash-during-forced-reset')).resolves.toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await releaseFence();
      await shutdown.then(
        () => undefined,
        () => undefined,
      );
      await waitForWorkspaceSessionResetsForTest();
      let after: Awaited<ReturnType<typeof prepare>> = undefined;
      for (let attempt = 0; after === undefined && attempt < 20; attempt += 1) {
        after = await prepare(`bash-after-forced-reset-${attempt}`);
        if (after === undefined) {
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
      }
      if (!after) throw new Error('expected admission to recover after the forced reset settled');
      await after.cleanup();
    },
  );

  it.runIf(process.platform === 'win32')(
    'resets a cached workspace owner before standalone SDK admission',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-cached-poison-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      const first = await prepare('bash-before-standalone-poison');
      if (!first) throw new Error('expected cached workspace invocation');
      workspaceSessionControl.delayClose = true;
      const firstCleanup = first.cleanup();
      await vi.waitFor(() => expect(workspaceSessionControl.releaseClose).toBeTypeOf('function'));
      const standalone = runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });
      await vi.waitFor(() => expect(workspaceSessionControl.releaseClose).toBeTypeOf('function'));
      expect(capturedBrokerRequests).toHaveLength(0);
      workspaceSessionControl.releaseClose?.();
      workspaceSessionControl.delayClose = false;
      await firstCleanup;
      await expect(standalone).resolves.toMatchObject({ status: 'completed', exitCode: 0 });

      const second = await prepare('bash-after-standalone');
      if (!second) throw new Error('expected cached workspace invocation after contention');
      await second.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it('uses one Windows workspace owner per command and retains POSIX session reuse', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-reuse-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const prepare = async (toolCallId: string) => sandbox.prepare({
      toolCallId,
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    const first = await prepare('bash-session-1');
    if (!first) throw new Error('expected first workspace invocation');
    const firstRequestFile = first.args.find((arg) => arg.endsWith('.json'));
    if (!firstRequestFile) throw new Error('expected first broker request');
    const firstRequest = JSON.parse(readFileSync(firstRequestFile, 'utf8')) as {
      readonly observationFile: string;
    };
    await writeFile(firstRequest.observationFile, JSON.stringify({
      version: 1,
      state: 'applied',
      backend: sandboxRuntimeCapability().backend,
      policyId: 'kodax-workspace-shell-v1',
    }), 'utf8');
    await first.cleanup();

    const second = await prepare('bash-session-2');
    if (!second) throw new Error('expected second workspace invocation');
    const secondRequestFile = second.args.find((arg) => arg.endsWith('.json'));
    if (!secondRequestFile) throw new Error('expected second broker request');
    const secondRequest = JSON.parse(readFileSync(secondRequestFile, 'utf8')) as {
      readonly observationFile: string;
    };
    await writeFile(secondRequest.observationFile, JSON.stringify({
      version: 1,
      state: 'applied',
      backend: sandboxRuntimeCapability().backend,
      policyId: 'kodax-workspace-shell-v1',
    }), 'utf8');
    await second.cleanup();

    expect(capturedWorkspaceOwnerArgv()).toHaveLength(process.platform === 'win32' ? 2 : 1);
  });

  it.runIf(process.platform !== 'win32')(
    'keeps ordinary POSIX workspace sessions outside the scoped-session cache quota',
    async () => {
    const roots: string[] = [];
      for (let index = 0; index < 9; index += 1) {
        const root = await mkdtemp(path.join(os.tmpdir(), `kodax-posix-workspace-${index}-`));
        roots.push(root);
        tempRoots.push(root);
        const sandbox = createAsrtShellSandbox({
          workspaceRoot: root,
          shouldSandbox: () => true,
        });
        const prepared = await sandbox.prepare({
          toolCallId: `bash-posix-workspace-${index}`,
          toolInput: { command: 'node --version' },
          command: 'node --version',
          cwd: root,
          env: process.env,
        });
        if (!prepared) throw new Error(`expected ordinary POSIX workspace invocation ${index}`);
        await prepared.cleanup();
      }

      const scopedSandbox = createAsrtShellSandbox({
        workspaceRoot: roots[0]!,
        shouldSandbox: () => ({
          filesystemAccess: { read: [roots[1]!], write: [] },
        }),
      });
      const scoped = await scopedSandbox.prepare({
        toolCallId: 'bash-posix-scoped',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        cwd: roots[0]!,
        env: process.env,
      });
      if (!scoped) throw new Error('expected scoped POSIX workspace invocation');
      await scoped.cleanup();

      const firstWorkspaceAgain = createAsrtShellSandbox({
        workspaceRoot: roots[0]!,
        shouldSandbox: () => true,
      });
      const reused = await firstWorkspaceAgain.prepare({
        toolCallId: 'bash-posix-workspace-reused',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        cwd: roots[0]!,
        env: process.env,
      });
      if (!reused) throw new Error('expected reused POSIX workspace invocation');
      await reused.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(10);
    },
  );

  it('shares one workspace owner across concurrent commands with the same policy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-parallel-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const reportObservation = vi.fn();
    const prepare = (toolCallId: string) => sandbox.prepare({
      toolCallId,
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
      reportObservation,
    });

    const [first, second] = await Promise.all([
      prepare('bash-parallel-1'),
      prepare('bash-parallel-2'),
    ]);
    if (!first || !second) throw new Error('expected parallel workspace invocations');
    if (process.platform === 'win32') {
      const poisonDirectories = [
        path.join(process.env.KODAX_HOME!, 'sandbox-runtime', 'acl-poison'),
        path.join(process.env.ProgramData!, 'KodaX', 'sandbox-runtime', 'acl-poison'),
      ];
      for (const directory of poisonDirectories) {
        await expect(readdir(directory)).resolves.toHaveLength(1);
      }
      await first.cleanup();
      for (const directory of poisonDirectories) {
        await expect(readdir(directory)).resolves.toHaveLength(1);
      }
      await second.cleanup();
      for (const directory of poisonDirectories) {
        await expect(readdir(directory)).resolves.toEqual([]);
      }
    } else {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }

    expect(capturedWorkspaceOwnerArgv()).toHaveLength(1);
  });

  it.runIf(process.platform === 'win32')(
    'keeps an incompatible local policy as retryable fallback instead of sticky poison',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-local-policy-contention-'));
      const otherToolchain = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-local-policy-other-'));
      tempRoots.push(root, otherToolchain);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string, env: NodeJS.ProcessEnv = process.env) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env,
      });

      const first = await prepare('bash-local-policy-a');
      if (!first) throw new Error('expected first local policy invocation');
      await expect(prepare('bash-local-policy-b', {
        ...process.env,
        PATH: otherToolchain,
      })).resolves.toBeUndefined();
      await first.cleanup();

      const retry = await prepare('bash-local-policy-a-retry');
      if (!retry) throw new Error('expected original policy to remain retryable');
      await retry.cleanup();
    },
  );

  it.runIf(process.platform === 'win32')(
    'drains an incompatible permission fallback before retiring its sandbox owner',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-policy-retirement-'));
      const otherToolchain = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-policy-fallback-'));
      tempRoots.push(root, otherToolchain);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string, env: NodeJS.ProcessEnv = process.env) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env,
      });

      const owner = await prepare('bash-policy-owner');
      if (!owner) throw new Error('expected sandbox policy owner');
      await expect(prepare('bash-policy-fallback', {
        ...process.env,
        PATH: otherToolchain,
      })).resolves.toBeUndefined();

      const releaseFallback = await acquireFileSystemMutationLease();
      const retirement = owner.cleanup();
      const earlyRetirement = await Promise.race([
        retirement.then(() => 'settled' as const, () => 'settled' as const),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 100)),
      ]);
      expect(earlyRetirement).toBe('waiting');

      let laterFallbackSettled = false;
      const laterFallback = acquireFileSystemMutationLease().finally(() => {
        laterFallbackSettled = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(laterFallbackSettled).toBe(false);

      await releaseFallback();
      await expect(retirement).resolves.toBeUndefined();
      const releaseLaterFallback = await laterFallback;
      await releaseLaterFallback();

      const poisonDirectories = [
        path.join(process.env.KODAX_HOME!, 'sandbox-runtime', 'acl-poison'),
        path.join(process.env.ProgramData!, 'KodaX', 'sandbox-runtime', 'acl-poison'),
      ];
      for (const directory of poisonDirectories) {
        await expect(readdir(directory)).resolves.toEqual([]);
      }

      const retry = await prepare('bash-policy-owner-retry');
      if (!retry) throw new Error('expected policy retry after clean retirement');
      await retry.cleanup();
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not share a sandbox owner when the host temp policy base differs',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-temp-policy-'));
      const tempA = path.join(root, 'temp-a');
      const tempB = path.join(root, 'temp-b');
      await mkdir(tempA, { recursive: true });
      await mkdir(tempB, { recursive: true });
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });

      vi.stubEnv('TEMP', tempA);
      vi.stubEnv('TMP', tempA);
      const first = await prepare('bash-temp-policy-a');
      if (!first) throw new Error('expected first temp policy invocation');
      vi.stubEnv('TEMP', tempB);
      vi.stubEnv('TMP', tempB);
      const incompatible = await prepare('bash-temp-policy-b');
      try {
        expect(incompatible).toBeUndefined();
      } finally {
        await incompatible?.cleanup();
        await first.cleanup();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not share a policy after a reviewed junction target changes',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-policy-junction-'));
      const physicalA = path.join(root, 'physical-a');
      const physicalB = path.join(root, 'physical-b');
      const reviewedLink = path.join(root, 'reviewed-link');
      await mkdir(physicalA, { recursive: true });
      await mkdir(physicalB, { recursive: true });
      await symlink(physicalA, reviewedLink, 'junction');
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          filesystemAccess: { read: [reviewedLink], write: [] },
        }),
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });

      const first = await prepare('bash-policy-junction-a');
      if (!first) throw new Error('expected first junction policy invocation');
      await rm(reviewedLink, { recursive: true, force: true });
      await symlink(physicalB, reviewedLink, 'junction');
      const incompatible = await prepare('bash-policy-junction-b');
      try {
        expect(incompatible).toBeUndefined();
      } finally {
        await incompatible?.cleanup();
        await first.cleanup();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'shares an exact policy across independent Windows owner processes and falls back for a different policy',
    async () => {
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-cross-process-policy-'));
      const otherToolchain = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-other-policy-'));
      tempRoots.push(root, otherToolchain);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string, env: NodeJS.ProcessEnv = process.env) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env,
      });
      const primaryDirectory = path.join(
        process.env.ProgramData!,
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      const first = await prepare('bash-policy-probe');
      if (!first) throw new Error('expected policy probe invocation');
      const [localMarkerName] = await readdir(primaryDirectory);
      if (!localMarkerName) throw new Error('expected local policy marker');
      const localOwner = JSON.parse(await readFile(
        path.join(primaryDirectory, localMarkerName),
        'utf8',
      )) as { readonly policyKey?: string };
      expect(localOwner.policyKey).toMatch(/^[a-f0-9]{64}$/);
      await first.cleanup();
      await resetAsrtWorkspaceSessionsForTest({ preserveAclPoison: true });

      const holder = actualChildProcess.spawn(process.execPath, [
        '-e',
        'process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      await once(holder.stdout!, 'data');
      if (holder.pid === undefined) throw new Error('policy holder PID missing');
      const holderIdentity = readProcessStartIdentity(holder.pid);
      if (holderIdentity === undefined) throw new Error('policy holder identity missing');
      const foreignMarker = path.join(primaryDirectory, 'foreign-compatible-policy.json');
      await writeFile(foreignMarker, JSON.stringify({
        version: 1,
        state: 'active',
        policyKey: localOwner.policyKey,
        holderPid: holder.pid,
        holderProcessStartIdentity: holderIdentity,
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      const releaseForeignCompatibleEffect = await acquireFileSystemMutationLease(
        localOwner.policyKey,
      );
      let foreignCompatibleEffectReleased = false;
      try {
        processIdentityMock.unreadablePids.add(holder.pid);
        await expect(prepare('bash-unverified-foreign-policy')).resolves.toBeUndefined();
        processIdentityMock.unreadablePids.delete(holder.pid);

        const recoveriesBeforeCompatible = capturedSyncSpawns.filter((spawn) => (
          spawn.args.includes('acl') && spawn.args.includes('recover')
        )).length;
        const compatible = await prepare('bash-compatible-foreign-policy');
        if (!compatible) throw new Error('expected compatible cross-process policy admission');
        expect(compatible.fileSystemEffectPolicyKey).toBe(localOwner.policyKey);
        let compatibleCleanupSettled = false;
        const compatibleCleanup = compatible.cleanup().finally(() => {
          compatibleCleanupSettled = true;
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(compatibleCleanupSettled).toBe(false);
        await releaseForeignCompatibleEffect();
        foreignCompatibleEffectReleased = true;
        await compatibleCleanup;
        expect(capturedSyncSpawns.filter((spawn) => (
          spawn.args.includes('acl') && spawn.args.includes('recover')
        ))).toHaveLength(recoveriesBeforeCompatible);
        expect(statSync(foreignMarker).isFile()).toBe(true);

        const observation = vi.fn();
        const incompatible = await sandbox.prepare({
          toolCallId: 'bash-incompatible-foreign-policy',
          toolInput: { command: 'node --version' },
          command: 'node --version',
          executable: process.execPath,
          args: ['--version'],
          cwd: root,
          env: { ...process.env, PATH: otherToolchain },
          reportObservation: observation,
        });
        expect(incompatible).toBeUndefined();
        expect(observation).toHaveBeenCalledWith(expect.objectContaining({
          state: 'fallback',
          execution: 'normal_permission_policy',
        }));
        const ordinaryFallbackEffect = await acquireFileSystemMutationLease();
        await ordinaryFallbackEffect();
      } finally {
        processIdentityMock.unreadablePids.delete(holder.pid);
        if (!foreignCompatibleEffectReleased) await releaseForeignCompatibleEffect();
        const holderClosed = once(holder, 'close');
        holder.kill('SIGKILL');
        await holderClosed;
        await rm(foreignMarker, { force: true });
      }
    },
  );

  it('retires a workspace session when sandbox execution cannot be attested', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-unattested-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const prepare = (toolCallId: string) => sandbox.prepare({
      toolCallId,
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });

    const first = await prepare('bash-unattested-1');
    if (!first) throw new Error('expected first workspace invocation');
    await expect(first.cleanup({ execution: 'started_or_unknown' }))
      .rejects.toThrow('could not be attested');
    await first.retire?.();

    const second = await prepare('bash-unattested-2');
    if (!second) throw new Error('expected replacement workspace invocation');
    const requestFile = second.args.find((arg) => arg.endsWith('.json'));
    if (!requestFile) throw new Error('expected replacement broker request');
    const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
      readonly observationFile: string;
    };
    await writeFile(request.observationFile, JSON.stringify({
      version: 1,
      state: 'applied',
      backend: sandboxRuntimeCapability().backend,
      policyId: 'kodax-workspace-shell-v1',
    }), 'utf8');
    await second.cleanup();

    expect(capturedWorkspaceOwnerArgv()).toHaveLength(2);
  });

  it.skipIf(process.platform === 'win32')(
    'evicts an unattested POSIX workspace session without waiting for another active lease',
    async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-retire-active-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const prepare = (toolCallId: string) => sandbox.prepare({
      toolCallId,
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });

    const [unattested, active] = await Promise.all([
      prepare('bash-retire-unattested'),
      prepare('bash-retire-active'),
    ]);
    if (!unattested || !active) throw new Error('expected parallel workspace invocations');
    const activeEffect = await acquireFileSystemMutationLease();
    workspaceSessionControl.delayClose = true;
    await expect(unattested.cleanup({ execution: 'started_or_unknown' }))
      .rejects.toThrow('could not be attested');

    const retirement = unattested.retire?.() ?? Promise.resolve();
    const retirementState = await Promise.race([
      retirement.then(() => 'retired' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await activeEffect();
    await active.cleanup();
    await retirement;
    const closeDeadline = Date.now() + 500;
    while (workspaceSessionControl.releaseClose === undefined && Date.now() < closeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const releaseRetiredSession = workspaceSessionControl.releaseClose;
    releaseRetiredSession?.();
    const replacement = await prepare('bash-retire-replacement');
    if (!replacement) throw new Error('expected replacement workspace invocation');
    await replacement.cleanup();

    expect(retirementState).toBe('retired');
    expect(releaseRetiredSession).toBeTypeOf('function');
    expect(capturedWorkspaceOwnerArgv()).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'allows a later replacement after externally recovering a nonzero owner exit',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-retire-unclean-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });

      const unattested = await prepare('bash-retire-unclean');
      if (!unattested) throw new Error('expected workspace invocation');
      workspaceSessionControl.delayClose = true;
      workspaceSessionControl.closeExitCode = 1;
      const cleanup = unattested.cleanup({ execution: 'started_or_unknown' }).then(
        () => undefined,
        async (cleanupError: unknown) => {
          try {
            await unattested.retire?.();
            return cleanupError;
          } catch (retirementError: unknown) {
            return new AggregateError(
              [cleanupError, retirementError],
              'Sandbox cleanup and workspace-session retirement both failed.',
            );
          }
        },
      );
      await vi.waitFor(() => expect(workspaceSessionControl.releaseClose).toBeDefined());
      const replacementPending = prepare('bash-retire-after-unclean');
      workspaceSessionControl.releaseClose?.();
      workspaceSessionControl.releaseClose = undefined;

      const cleanupFailure = await cleanup;
      expect(cleanupFailure).toBeInstanceOf(AggregateError);
      const cleanupMessages = (cleanupFailure as AggregateError).errors.map(String);
      expect(cleanupMessages).toEqual(expect.arrayContaining([
        expect.stringContaining('could not be attested'),
      ]));
      workspaceSessionControl.delayClose = false;
      await expect(replacementPending).resolves.toBeUndefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);

      workspaceSessionControl.closeExitCode = 0;
      const replacement = await prepare('bash-retire-after-recovery');
      if (!replacement) throw new Error('expected replacement after verified ACL recovery');
      await replacement.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it.each(['wrap', 'cleanup'] as const)(
    'retires a workspace session after a %s RPC failure',
    async (failurePoint) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `kodax-asrt-${failurePoint}-failure-`));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });

      if (failurePoint === 'wrap') {
        workspaceSessionControl.wrapFailure = 'injected wrap failure';
        await expect(prepare('bash-wrap-rpc-failed')).resolves.toBeUndefined();
        workspaceSessionControl.wrapFailure = undefined;
      } else {
        const first = await prepare('bash-cleanup-rpc-failed');
        if (!first) throw new Error('expected cleanup failure workspace invocation');
        workspaceSessionControl.cleanupFailure = 'injected cleanup failure';
        await expect(first.cleanup()).rejects.toThrow('request cleanup failed');
        await first.retire?.();
        workspaceSessionControl.cleanupFailure = undefined;
      }

      const recovered = await prepare(`bash-after-${failurePoint}-failure`);
      if (!recovered) throw new Error('expected replacement workspace invocation');
      await recovered.cleanup();
      if (failurePoint === 'wrap') {
        // The failed wrap retired the session; the replacement starts a fresh owner.
        expect(capturedWorkspaceOwnerArgv()).toHaveLength(2);
      } else {
        // The failed command cleanup leaves the lease held, so the session's
        // close defers and the session stays reusable: the replacement reuses
        // the same owner instead of terminating it underneath a live lease.
        expect(capturedWorkspaceOwnerArgv()).toHaveLength(1);
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'retires a timed-out cleanup request through an orderly session close without poisoning the ACL owner',
    async () => {
      const restoreTimeouts = overrideWorkspaceSessionRpcTimeoutsForTest({
        rpcMs: 60,
        cleanupMs: 60,
      });
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-cleanup-timeout-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      try {
        const first = await prepare('bash-cleanup-timeout');
        if (!first) throw new Error('expected workspace invocation');
        workspaceSessionControl.delayCleanup = true;
        await expect(first.cleanup()).rejects.toThrow('request cleanup failed');
        const globalPoisonDirectory = path.join(
          path.resolve(process.env.ProgramData!),
          'KodaX',
          'sandbox-runtime',
          'acl-poison',
        );
        // The orderly retire must confirm the ACL reset and remove the active
        // owner marker instead of renaming it to unconfirmed-owner-*.json.
        await vi.waitFor(async () => {
          await expect(readdir(globalPoisonDirectory)).resolves.toEqual([]);
        });
        await first.retire?.();
        workspaceSessionControl.delayCleanup = false;
        workspaceSessionControl.releaseCleanup?.();
        workspaceSessionControl.releaseCleanup = undefined;
        const replacement = await prepare('bash-after-cleanup-timeout');
        if (!replacement) throw new Error('expected replacement workspace invocation');
        await replacement.cleanup();
        expect(capturedKillSignals).toHaveLength(0);
        expect(capturedProcessTreeKillOptions).toHaveLength(0);
        expect(capturedWorkspaceOwnerArgv()).toHaveLength(2);
      } finally {
        workspaceSessionControl.delayCleanup = false;
        restoreTimeouts();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'retires a timed-out wrap request without force-killing the session or poisoning the ACL owner',
    async () => {
      const restoreTimeouts = overrideWorkspaceSessionRpcTimeoutsForTest({ rpcMs: 60 });
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-wrap-timeout-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      try {
        workspaceSessionControl.delayWrap = true;
        await expect(prepare('bash-wrap-timeout')).resolves.toBeUndefined();
        const globalPoisonDirectory = path.join(
          path.resolve(process.env.ProgramData!),
          'KodaX',
          'sandbox-runtime',
          'acl-poison',
        );
        await vi.waitFor(async () => {
          await expect(readdir(globalPoisonDirectory)).resolves.toEqual([]);
        });
        workspaceSessionControl.releaseWrap?.();
        workspaceSessionControl.delayWrap = false;
        const replacement = await prepare('bash-after-wrap-timeout');
        if (!replacement) throw new Error('expected replacement workspace invocation');
        await replacement.cleanup();
        expect(capturedKillSignals).toHaveLength(0);
        expect(capturedProcessTreeKillOptions).toHaveLength(0);
        expect(capturedWorkspaceOwnerArgv()).toHaveLength(2);
      } finally {
        workspaceSessionControl.delayWrap = false;
        restoreTimeouts();
      }
    },
  );

  it('gives cleanup requests a longer deadline than wrap requests', async () => {
    const restoreTimeouts = overrideWorkspaceSessionRpcTimeoutsForTest({ rpcMs: 60 });
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-cleanup-deadline-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const invocation = await sandbox.prepare({
      toolCallId: 'bash-cleanup-deadline',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    if (!invocation) throw new Error('expected workspace invocation');
    try {
      workspaceSessionControl.delayCleanup = true;
      const stalled = invocation.cleanup();
      await vi.waitFor(() => {
        expect(workspaceSessionControl.releaseCleanup).toBeTypeOf('function');
      });
      // The stalled cleanup outlives the wrap deadline but stays inside the
      // dedicated cleanup deadline, so it must resolve instead of retiring.
      await new Promise((resolve) => setTimeout(resolve, 200));
      workspaceSessionControl.releaseCleanup?.();
      await expect(stalled).resolves.toBeUndefined();
      expect(workspaceSessionControl.cleanupRequests).toBe(1);
      expect(capturedKillSignals).toHaveLength(0);
    } finally {
      workspaceSessionControl.delayCleanup = false;
      restoreTimeouts();
    }
  });

  it('releases a workspace lease even when broker request-file cleanup fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-request-cleanup-failure-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const invocation = await sandbox.prepare({
      toolCallId: 'bash-request-cleanup-failure',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    if (!invocation) throw new Error('expected workspace invocation');
    const requestFile = invocation.args.find((arg) => arg.endsWith('.json'));
    if (!requestFile) throw new Error('expected broker request file');

    fileSystemMock.rmFailurePath = requestFile;
    let cleanupFailure: unknown;
    try {
      await invocation.cleanup();
    } catch (error: unknown) {
      cleanupFailure = error;
    }
    const cleanupRequestsAfterFailure = workspaceSessionControl.cleanupRequests;
    fileSystemMock.rmFailurePath = undefined;
    await invocation.cleanup();

    expect(cleanupFailure).toBeInstanceOf(Error);
    expect((cleanupFailure as Error).message).toContain('request cleanup failed');
    expect(cleanupRequestsAfterFailure).toBe(1);
  });

  it('preserves missing-attestation diagnostics when request cleanup also fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-attestation-cleanup-failure-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const invocation = await sandbox.prepare({
      toolCallId: 'bash-attestation-cleanup-failure',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    if (!invocation) throw new Error('expected workspace invocation');
    const requestFile = invocation.args.find((arg) => arg.endsWith('.json'));
    if (!requestFile) throw new Error('expected broker request file');

    fileSystemMock.rmFailurePath = requestFile;
    try {
      await expect(invocation.cleanup({ execution: 'started_or_unknown' })).rejects.toThrow(
        /could not be attested.*request cleanup failed/i,
      );
    } finally {
      fileSystemMock.rmFailurePath = undefined;
      await invocation.retire?.();
    }
  });

  it('retires a workspace session when request construction and lease cleanup both fail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-request-write-failure-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const reportObservation = vi.fn();
    const prepare = (toolCallId: string) => sandbox.prepare({
      toolCallId,
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
      reportObservation,
    });
    const first = await prepare('bash-before-request-write-failure');
    if (!first) throw new Error('expected initial workspace invocation');
    await first.cleanup();

    fileSystemMock.writeBrokerRequestFailure = true;
    workspaceSessionControl.cleanupFailure = 'injected cleanup after request write failure';
    await expect(prepare('bash-request-write-failure')).resolves.toBeUndefined();
    expect(reportObservation).toHaveBeenLastCalledWith({
      version: 1,
      state: 'fallback',
      reason: 'prepare_failed',
      execution: 'normal_permission_policy',
    });
    fileSystemMock.writeBrokerRequestFailure = false;
    workspaceSessionControl.cleanupFailure = undefined;

    const replacement = await prepare('bash-after-request-write-failure');
    if (!replacement) throw new Error('expected replacement after request write failure');
    await replacement.cleanup();
    expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
  });

  it.runIf(process.platform === 'win32')(
    'releases the Windows owner when preparation fails after lease acquisition',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-request-write-cleanup-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const poisonDirectories = [
        path.join(process.env.KODAX_HOME!, 'sandbox-runtime', 'acl-poison'),
        path.join(process.env.ProgramData!, 'KodaX', 'sandbox-runtime', 'acl-poison'),
      ];
      fileSystemMock.writeBrokerRequestFailure = true;

      await expect(sandbox.prepare({
        toolCallId: 'bash-request-write-cleanup',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      })).resolves.toBeUndefined();
      for (const directory of poisonDirectories) {
        await expect(readDirectoryIfPresent(directory)).resolves.toEqual([]);
      }

      fileSystemMock.writeBrokerRequestFailure = false;
      const recovered = await sandbox.prepare({
        toolCallId: 'bash-after-request-write-cleanup',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!recovered) throw new Error('expected preparation after owner cleanup');
      await recovered.cleanup();
    },
  );

  it.runIf(process.platform === 'win32')(
    'preserves the prepare error while rolling back an ephemeral Windows owner',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-review-write-cleanup-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          agentHomeAccess: { read: [], write: [], ephemeral: true },
        }),
      });
      fileSystemMock.writeBrokerRequestFailure = true;

      await expect(sandbox.prepare({
        toolCallId: 'bash-review-request-write-cleanup',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      })).resolves.toBeUndefined();
      await expect(readDirectoryIfPresent(path.join(
        process.env.ProgramData!,
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      ))).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not reuse a rejected Windows workspace owner for a later command',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-warmup-recovery-'));
      const agentHome = path.join(root, 'agent-home');
      const safeDirectory = path.join(agentHome, 'tool-results');
      await mkdir(safeDirectory, { recursive: true });
      vi.stubEnv('KODAX_HOME', agentHome);
      tempRoots.push(root);
      workspaceSessionControl.malformedReady = true;
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          agentHomeAccess: {
            read: [path.join(safeDirectory, 'result.txt')],
            write: [],
          },
        }),
      });

      const rejectedOwner = sandbox.prepare({
        toolCallId: 'bash-warmup-failed',
        toolInput: { command: 'echo first' },
        command: 'echo first',
        cwd: root,
        env: process.env,
      });
      await expect(Promise.race([
        rejectedOwner,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('rejected workspace owner did not settle')),
          3_000,
        )),
      ])).resolves.toBeUndefined();

      workspaceSessionControl.malformedReady = false;
      const recovered = await sandbox.prepare({
        toolCallId: 'bash-warmup-recovered',
        toolInput: { command: 'echo second' },
        command: 'echo second',
        cwd: root,
        env: process.env,
      });
      if (!recovered) throw new Error('expected a fresh workspace session after warm-up failure');
      const requestFile = recovered.args.find((arg) => arg.endsWith('.json'));
      if (!requestFile) throw new Error('expected recovered broker request');
      const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
        readonly observationFile: string;
      };
      await writeFile(request.observationFile, JSON.stringify({
        version: 1,
        state: 'applied',
        backend: sandboxRuntimeCapability().backend,
        policyId: 'kodax-workspace-shell-v1',
      }), 'utf8');
      await recovered.cleanup();

      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'uses command-scoped owners for bounded safe and review-only Agent Home access',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-scoped-session-'));
      const agentHome = path.join(root, 'agent-home');
      const safeDirectory = path.join(agentHome, 'tool-results');
      const reviewedConfig = path.join(agentHome, 'config.json');
      await mkdir(safeDirectory, { recursive: true });
      await writeFile(reviewedConfig, '{}', 'utf8');
      vi.stubEnv('KODAX_HOME', agentHome);
      tempRoots.push(root);

      let access: {
        read: string[];
        write: string[];
        ephemeral?: boolean;
      } = {
        read: [path.join(safeDirectory, 'result.txt')],
        write: [],
      };
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({ agentHomeAccess: access }),
      });
      const prepare = async (id: string): Promise<void> => {
        const invocation = await sandbox.prepare({
          toolCallId: id,
          toolInput: { command: 'echo safe' },
          command: 'echo safe',
          cwd: root,
          env: process.env,
        });
        if (!invocation) throw new Error('expected scoped sandbox invocation');
        await invocation.cleanup();
      };

      await prepare('safe-1');
      await prepare('safe-2');
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);

      access = {
        read: [reviewedConfig],
        write: [],
        ephemeral: true,
      };
      await prepare('reviewed-1');
      await prepare('reviewed-2');
      expect(capturedWorkspaceSessionConfigs).toHaveLength(4);
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps ordinary authorized shell effects available while a review-only ACL is live',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-exclusive-review-'));
      const agentHome = path.join(root, 'agent-home');
      const reviewedConfig = path.join(agentHome, 'config.json');
      await mkdir(agentHome, { recursive: true });
      await writeFile(reviewedConfig, '{}', 'utf8');
      vi.stubEnv('KODAX_HOME', agentHome);
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          agentHomeAccess: { read: [reviewedConfig], write: [], ephemeral: true },
        }),
      });

      const invocation = await sandbox.prepare({
        toolCallId: 'review-exclusive',
        toolInput: { command: 'type config.json' },
        command: 'type config.json',
        cwd: root,
        env: process.env,
      });
      if (!invocation) throw new Error('expected review-only sandbox invocation');
      const overlappingLease = await acquireFileSystemMutationLease();
      await overlappingLease();

      await invocation.cleanup();
      const admittedAfterCleanup = await acquireFileSystemMutationLease();
      await admittedAfterCleanup();
    },
  );

  it.runIf(process.platform === 'win32')(
    'isolates and removes each workspace-session temp directory',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-temp-'));
      const agentHome = path.join(root, 'agent-home');
      const safeDirectory = path.join(agentHome, 'tool-results');
      await mkdir(safeDirectory, { recursive: true });
      await writeFile(path.join(safeDirectory, 'one.txt'), '', 'utf8');
      await writeFile(path.join(safeDirectory, 'two.txt'), '', 'utf8');
      vi.stubEnv('KODAX_HOME', agentHome);
      tempRoots.push(root);
      let selectedPath = path.join(safeDirectory, 'one.txt');
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          agentHomeAccess: { read: [], write: [selectedPath] },
        }),
      });
      const prepare = async (id: string): Promise<void> => {
        const invocation = await sandbox.prepare({
          toolCallId: id,
          toolInput: { command: 'echo safe' },
          command: 'echo safe',
          cwd: root,
          env: process.env,
        });
        if (!invocation) throw new Error('expected scoped sandbox invocation');
        await invocation.cleanup();
      };

      await prepare('temp-one');
      selectedPath = path.join(safeDirectory, 'two.txt');
      await prepare('temp-two');
      const sessionTemps = capturedWorkspaceRequests.map((request) => (
        (request.env as NodeJS.ProcessEnv | undefined)?.TEMP
      )).filter((candidate): candidate is string => (
        candidate?.includes(`${path.sep}kodax-sandbox${path.sep}`) === true
      ));
      expect(sessionTemps).toHaveLength(capturedWorkspaceSessionConfigs.length);
      expect(new Set(sessionTemps).size).toBe(sessionTemps.length);

      await resetAsrtWorkspaceSessionsForTest();
      await expect(Promise.all(sessionTemps.map(async (directory) => {
        await expect(stat(directory)).rejects.toThrow();
      }))).resolves.toBeDefined();
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not poison Windows ACL state when only session temp cleanup fails',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-temp-cleanup-failure-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      const first = await prepare('bash-before-temp-cleanup-failure');
      if (!first) throw new Error('expected first workspace invocation');
      const config = capturedWorkspaceSessionConfigs.at(-1) as {
        readonly filesystem: { readonly allowWrite: readonly string[] };
      };
      const tempDirectory = config.filesystem.allowWrite.find((candidate) => (
        candidate.includes(`${path.sep}kodax-sandbox${path.sep}`)
      ));
      if (!tempDirectory) throw new Error('expected workspace session temp directory');

      fileSystemMock.rmFailurePath = tempDirectory;
      await first.cleanup();
      const replacement = await prepare('bash-after-temp-cleanup-failure');
      if (!replacement) throw new Error('expected replacement after temp cleanup failure');
      await replacement.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps only the current safe Agent Home ACL scope',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-scope-cap-'));
      const agentHome = path.join(root, 'agent-home');
      const safeDirectory = path.join(agentHome, 'tool-results');
      await mkdir(safeDirectory, { recursive: true });
      for (let index = 0; index < 9; index += 1) {
        await writeFile(path.join(safeDirectory, `${index}.txt`), '', 'utf8');
      }
      vi.stubEnv('KODAX_HOME', agentHome);
      tempRoots.push(root);

      let selectedPath = path.join(safeDirectory, '0.txt');
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          agentHomeAccess: { read: [], write: [selectedPath] },
        }),
      });
      const prepare = async (index: number): Promise<void> => {
        selectedPath = path.join(safeDirectory, `${index}.txt`);
        const invocation = await sandbox.prepare({
          toolCallId: `scope-${index}`,
          toolInput: { command: 'echo safe' },
          command: 'echo safe',
          cwd: root,
          env: process.env,
        });
        if (!invocation) throw new Error('expected bounded scoped invocation');
        await invocation.cleanup();
      };

      for (let index = 0; index < 8; index += 1) await prepare(index);
      expect(capturedWorkspaceSessionConfigs).toHaveLength(8);

      workspaceSessionControl.delayClose = true;
      const ninth = prepare(8);
      await vi.waitFor(
        () => expect(workspaceSessionControl.releaseClose).toBeDefined(),
        { timeout: 5_000 },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(capturedWorkspaceSessionConfigs).toHaveLength(9);
      workspaceSessionControl.delayClose = false;
      workspaceSessionControl.releaseClose?.();
      workspaceSessionControl.releaseClose = undefined;
      await ninth;
      expect(capturedWorkspaceSessionConfigs).toHaveLength(9);

      await prepare(8);
      expect(capturedWorkspaceSessionConfigs).toHaveLength(10);
      await prepare(0);
      expect(capturedWorkspaceSessionConfigs).toHaveLength(11);
    },
  );

  it.runIf(process.platform === 'win32')(
    'replaces an Agent Home scope after externally recovering a nonzero owner exit',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-reset-fail-'));
      const agentHome = path.join(root, 'agent-home');
      const safeDirectory = path.join(agentHome, 'tool-results');
      await mkdir(safeDirectory, { recursive: true });
      for (let index = 0; index < 9; index += 1) {
        await writeFile(path.join(safeDirectory, `${index}.txt`), '', 'utf8');
      }
      vi.stubEnv('KODAX_HOME', agentHome);
      tempRoots.push(root);

      let selectedPath = path.join(safeDirectory, '0.txt');
      const reportObservation = vi.fn();
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          agentHomeAccess: { read: [], write: [selectedPath] },
        }),
      });
      const prepare = async (index: number) => {
        selectedPath = path.join(safeDirectory, `${index}.txt`);
        const invocation = await sandbox.prepare({
          toolCallId: `reset-fail-${index}`,
          toolInput: { command: 'echo safe' },
          command: 'echo safe',
          cwd: root,
          env: process.env,
          reportObservation,
        });
        await invocation?.cleanup();
        return invocation;
      };

      for (let index = 0; index < 8; index += 1) {
        expect(await prepare(index)).toBeDefined();
      }
      expect(capturedWorkspaceSessionConfigs).toHaveLength(8);

      workspaceSessionControl.closeExitCode = 1;
      expect(await prepare(8)).toBeDefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(9);
      expect(reportObservation).not.toHaveBeenCalled();

      workspaceSessionControl.closeExitCode = 0;
      await expect(prepare(8)).resolves.toBeDefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(10);
    },
  );

  it.runIf(process.platform === 'win32')(
    'cancels a session startup promptly but closes the late Windows owner before replacement',
    async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-cancel-'));
    tempRoots.push(root);
    workspaceSessionControl.delayReady = true;
    workspaceSessionControl.delayClose = true;
    const controller = new AbortController();
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const preparing = sandbox.prepare({
      toolCallId: 'bash-session-cancel',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(workspaceSessionControl.releaseReady).toBeTypeOf('function');
    }, { timeout: 5_000 });

    controller.abort();
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    const poisonDirectory = path.join(
      path.resolve(process.env.KODAX_HOME!),
      'sandbox-runtime',
      'acl-poison',
    );
    const globalPoisonDirectory = path.join(
      path.resolve(process.env.ProgramData!),
      'KodaX',
      'sandbox-runtime',
      'acl-poison',
    );
    await expect(readdir(poisonDirectory)).resolves.toHaveLength(1);
    await expect(readdir(globalPoisonDirectory)).resolves.toHaveLength(1);
    workspaceSessionControl.delayReady = false;
    workspaceSessionControl.releaseReady?.();
    workspaceSessionControl.releaseReady = undefined;
    await vi.waitFor(() => expect(workspaceSessionControl.releaseClose).toBeDefined());
    await expect(readdir(poisonDirectory)).resolves.toHaveLength(1);
    await expect(readdir(globalPoisonDirectory)).resolves.toHaveLength(1);
    let effectDuringResetSettled = false;
    const effectDuringResetPending = acquireFileSystemMutationLease().finally(() => {
      effectDuringResetSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(effectDuringResetSettled).toBe(false);
    const replacementPending = sandbox.prepare({
      toolCallId: 'bash-after-session-cancel',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    await expect(replacementPending).resolves.toBeUndefined();
    expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
    workspaceSessionControl.delayClose = false;
    workspaceSessionControl.releaseClose?.();
    workspaceSessionControl.releaseClose = undefined;
    const effectDuringReset = await effectDuringResetPending;
    await effectDuringReset();
    await vi.waitFor(async () => {
      await expect(readdir(poisonDirectory)).resolves.toEqual([]);
      await expect(readdir(globalPoisonDirectory)).resolves.toEqual([]);
    });
    const replacement = await sandbox.prepare({
      toolCallId: 'bash-after-session-cancel-reset',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    if (!replacement) throw new Error('expected replacement after cancelled startup cleanup');
    await replacement.cleanup();
    const effectAfterCleanup = await acquireFileSystemMutationLease();
    await effectAfterCleanup();
    await expect(readdir(poisonDirectory)).resolves.toEqual([]);
    await expect(readdir(globalPoisonDirectory)).resolves.toEqual([]);
    expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'times out a session startup promptly and closes the late Windows owner',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-timeout-'));
      tempRoots.push(root);
      workspaceSessionControl.delayReady = true;
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const preparing = sandbox.prepare({
        toolCallId: 'bash-session-timeout',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
        deadlineAt: Date.now() + 250,
      });
      const timeoutOutcome = preparing.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.waitFor(() => {
        expect(workspaceSessionControl.releaseReady).toBeTypeOf('function');
      }, { timeout: 5_000 });
      await expect(timeoutOutcome).resolves.toMatchObject({ name: 'TimeoutError' });
      workspaceSessionControl.releaseReady?.();
      workspaceSessionControl.releaseReady = undefined;
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const globalPoisonDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      // The late owner close converges asynchronously after the session
      // admission resolves, so poll for the marker cleanup.
      await vi.waitFor(async () => {
        await expect(readdir(poisonDirectory)).resolves.toEqual([]);
        await expect(readdir(globalPoisonDirectory)).resolves.toEqual([]);
      }, { timeout: 10_000 });
    },
  );

  it.runIf(process.platform === 'win32')(
    'recovers a late cancelled owner after a nonzero reset exit',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-cancel-unclean-'));
      tempRoots.push(root);
      workspaceSessionControl.delayReady = true;
      workspaceSessionControl.delayClose = true;
      workspaceSessionControl.closeExitCode = 1;
      const controller = new AbortController();
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const preparing = sandbox.prepare({
        toolCallId: 'bash-session-cancel-unclean',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
        signal: controller.signal,
      });
      await vi.waitFor(
        () => expect(workspaceSessionControl.releaseReady).toBeTypeOf('function'),
        { timeout: 5_000 },
      );
      controller.abort();
      await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
      workspaceSessionControl.delayReady = false;
      workspaceSessionControl.releaseReady?.();
      workspaceSessionControl.releaseReady = undefined;
      await vi.waitFor(
        () => expect(workspaceSessionControl.releaseClose).toBeTypeOf('function'),
        { timeout: 5_000 },
      );
      const cleanupFencePending = acquireFileSystemMutationLease();
      workspaceSessionControl.delayClose = false;
      workspaceSessionControl.releaseClose?.();
      workspaceSessionControl.releaseClose = undefined;
      const releaseCleanupFence = await cleanupFencePending;
      await releaseCleanupFence();
      const globalPoisonDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      await vi.waitFor(async () => {
        await expect(readdir(globalPoisonDirectory)).resolves.toEqual([]);
      });
      workspaceSessionControl.closeExitCode = 0;
      const recovered = await sandbox.prepare({
        toolCallId: 'bash-after-session-cancel-unclean',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!recovered) throw new Error('expected recovery after verified ACL cleanup');
      await recovered.cleanup();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
    },
  );

  it('cancels a delayed wrap promptly and cleans up its late response', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-wrap-cancel-'));
    tempRoots.push(root);
    workspaceSessionControl.delayWrap = true;
    const controller = new AbortController();
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const preparing = sandbox.prepare({
      toolCallId: 'bash-wrap-cancel',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
      signal: controller.signal,
    });
    await vi.waitFor(
      () => expect(workspaceSessionControl.releaseWrap).toBeTypeOf('function'),
      { timeout: 5_000 },
    );

    const cancelledAt = Date.now();
    controller.abort();
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - cancelledAt).toBeLessThan(500);

    workspaceSessionControl.cleanupFailure = 'injected late cleanup failure';
    workspaceSessionControl.delayWrap = false;
    workspaceSessionControl.releaseWrap?.();
    workspaceSessionControl.releaseWrap = undefined;
    await vi.waitFor(() => expect(workspaceSessionControl.cleanupRequests).toBe(1));
    workspaceSessionControl.cleanupFailure = undefined;
    if (process.platform === 'win32') {
      await vi.waitFor(async () => {
        await expect(readdir(path.join(
          path.resolve(process.env.ProgramData!),
          'KodaX',
          'sandbox-runtime',
          'acl-poison',
        ))).resolves.toEqual([]);
      });
    }
    let next = await sandbox.prepare({
      toolCallId: 'bash-after-wrap-cancel',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    for (let attempt = 0; next === undefined && attempt < 10; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      next = await sandbox.prepare({
        toolCallId: `bash-after-wrap-cancel-${attempt}`,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
    }
    if (!next) throw new Error('expected replacement after failed late cleanup');
    await next.cleanup();
    expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
  });

  it('retires a workspace session when cancellation races with a failed cleanup response', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-wrap-cancelled-cleanup-'));
    tempRoots.push(root);
    const controller = new AbortController();
    workspaceSessionControl.cleanupFailure = 'injected cancelled cleanup failure';
    workspaceSessionControl.afterWrapResponse = () => controller.abort();
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });

    await expect(sandbox.prepare({
      toolCallId: 'bash-wrap-cancelled-cleanup',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    await vi.waitFor(() => expect(workspaceSessionControl.cleanupRequests).toBe(1));
    workspaceSessionControl.cleanupFailure = undefined;
    workspaceSessionControl.afterWrapResponse = undefined;
    if (process.platform === 'win32') {
      await vi.waitFor(async () => {
        await expect(readdir(path.join(
          path.resolve(process.env.ProgramData!),
          'KodaX',
          'sandbox-runtime',
          'acl-poison',
        ))).resolves.toEqual([]);
      });
    }
    let next = await sandbox.prepare({
      toolCallId: 'bash-after-cancelled-cleanup',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    for (let attempt = 0; next === undefined && attempt < 10; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      next = await sandbox.prepare({
        toolCallId: `bash-after-cancelled-cleanup-${attempt}`,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
    }
    if (!next) throw new Error('expected replacement after cancelled cleanup failure');
    await next.cleanup();
    expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
  });

  it.runIf(process.platform === 'win32')(
    'recovers a workspace Job automatically when process-tree termination is uncertain',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-unknown-kill-'));
      tempRoots.push(root);
      workspaceSessionControl.malformedReady = true;
      processTreeKillMock.outcome = 'unknown';
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepare = (toolCallId: string) => sandbox.prepare({
        toolCallId,
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      await expect(prepare('bash-before-unknown-session-kill')).resolves.toBeUndefined();
      const startedAt = Date.now();
      processTreeKillMock.outcome = 'actual';
      workspaceSessionControl.malformedReady = false;
      const recovered = await prepare('bash-after-unknown-session-kill');
      if (!recovered) throw new Error('expected automatic Job recovery to create a replacement session');
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(capturedWorkspaceSessionConfigs).toHaveLength(2);
      await recovered.cleanup();

      processTreeKillMock.releaseUnknown?.();
      processTreeKillMock.releaseUnknown = undefined;
    },
  );

  it('observes a failed workspace-session termination after a malformed live response', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-live-malformed-'));
    tempRoots.push(root);
    workspaceSessionControl.malformedResponseFor = 'wrap';
    processTreeKillMock.outcome = 'unknown';
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const unhandled: unknown[] = [];
    const observeUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', observeUnhandled);
    try {
      await expect(sandbox.prepare({
        toolCallId: 'bash-live-malformed-response',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      })).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', observeUnhandled);
      processTreeKillMock.releaseUnknown?.();
      processTreeKillMock.releaseUnknown = undefined;
      processTreeKillMock.outcome = 'actual';
      workspaceSessionControl.malformedResponseFor = undefined;
    }
  });

  it('force-terminates a malformed owner and recovers after verified ACL cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-poison-'));
    tempRoots.push(root);
    stubbornBroker.mode = 'silent';
    workspaceSessionControl.malformedReady = true;
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });

    await expect(sandbox.prepare({
      toolCallId: 'bash-poisoned-session',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    })).resolves.toBeUndefined();
    expect(capturedProcessTreeKillOptions).toContainEqual(expect.objectContaining({
      gracefulStdinEnd: false,
      gracefulMs: 1_500,
    }));
    expect(capturedKillSignals).toContain('SIGTERM');
    expect(capturedKillSignals).toContain('SIGKILL');

    stubbornBroker.mode = 'none';
    workspaceSessionControl.malformedReady = false;
    const recovered = await sandbox.prepare({
      toolCallId: 'bash-recovered-session',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    if (!recovered) throw new Error('expected recovery after confirmed forced termination');
    await recovered.cleanup();
    expect(capturedWorkspaceOwnerArgv()).toHaveLength(process.platform === 'win32' ? 2 : 3);
  });

  it.runIf(process.platform === 'win32')(
    'does not recreate ACL poison after a confirmed forced workspace close',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-forced-close-recovery-'));
      tempRoots.push(root);
      stubbornBroker.mode = 'silent';
      workspaceSessionControl.malformedReady = true;
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      await expect(sandbox.prepare({
        toolCallId: 'bash-forced-close-recovery',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      })).resolves.toBeUndefined();
      expect(capturedKillSignals).toContain('SIGKILL');
      for (const directory of [
        path.join(path.resolve(process.env.KODAX_HOME!), 'sandbox-runtime', 'acl-poison'),
        path.join(
          path.resolve(process.env.ProgramData!),
          'KodaX',
          'sandbox-runtime',
          'acl-poison',
        ),
      ]) {
        await expect(readdir(directory)).resolves.toEqual([]);
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not poison a verified-drained workspace when live PID identity is unreadable',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-forced-close-unknown-'));
      tempRoots.push(root);
      stubbornBroker.mode = 'silent';
      workspaceSessionControl.malformedReady = true;
      workspaceSessionControl.beforeReady = () => {
        processIdentityMock.unreadablePids.add(process.pid);
      };
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });

      await expect(sandbox.prepare({
        toolCallId: 'bash-forced-close-unknown',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      })).resolves.toBeUndefined();
      for (const directory of [
        path.join(path.resolve(process.env.KODAX_HOME!), 'sandbox-runtime', 'acl-poison'),
        path.join(
          path.resolve(process.env.ProgramData!),
          'KodaX',
          'sandbox-runtime',
          'acl-poison',
        ),
      ]) {
        await expect(readdir(directory)).resolves.toEqual([]);
      }
    },
  );

  it('closes an outstanding workspace lease without waiting for the Vitest hook budget', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-drain-bound-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const prepared = await sandbox.prepare({
      toolCallId: 'bash-unreleased-lease',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    if (!prepared) throw new Error('expected workspace invocation');
    const startedAt = Date.now();
    await resetAsrtWorkspaceSessionsForTest();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('uses the compiled KodaX internal session entry in bundled builds', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-bundled-'));
    tempRoots.push(root);
    const original = process.env.KODAX_BUNDLED;
    process.env.KODAX_BUNDLED = 'true';
    try {
      vi.stubEnv('KODAX_A2A_NODE', process.execPath);
      await doctorSandboxRuntime({ refresh: true });
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-session-bundled',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected bundled workspace invocation');
      expect(capturedWorkspaceOwnerArgv()).toContainEqual([
        process.execPath,
        '__asrt-workspace-session',
        expect.stringMatching(/workspace-.+\.json$/),
      ]);
      await prepared.cleanup();
    } finally {
      if (original === undefined) delete process.env.KODAX_BUNDLED;
      else process.env.KODAX_BUNDLED = original;
    }
  });

  describe('bundled srt-win sidecar resolution', () => {
    it('returns the sidecar path when it exists next to the executable', async () => {
      const execDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-srtwin-sidecar-'));
      tempRoots.push(execDir);
      const archDirectory = process.arch === 'arm64' ? 'arm64' : 'x64';
      const sidecarDir = path.join(execDir, 'vendor', 'srt-win', archDirectory);
      await mkdir(sidecarDir, { recursive: true });
      await writeFile(path.join(sidecarDir, 'srt-win.exe'), 'stub', 'utf8');
      expect(bundledSrtWinSidecarPath(execDir)).toBe(
        path.join(sidecarDir, 'srt-win.exe'),
      );
    });

    it('returns undefined when the sidecar is missing', async () => {
      const execDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-srtwin-sidecar-'));
      tempRoots.push(execDir);
      expect(bundledSrtWinSidecarPath(execDir)).toBeUndefined();
    });

    it('prefers the sidecar over the library lookup in bundled builds', async () => {
      const execDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-srtwin-sidecar-'));
      tempRoots.push(execDir);
      const archDirectory = process.arch === 'arm64' ? 'arm64' : 'x64';
      const sidecarDir = path.join(execDir, 'vendor', 'srt-win', archDirectory);
      await mkdir(sidecarDir, { recursive: true });
      await writeFile(path.join(sidecarDir, 'srt-win.exe'), 'stub', 'utf8');
      const original = process.env.KODAX_BUNDLED;
      process.env.KODAX_BUNDLED = 'true';
      try {
        expect(resolveSrtWinSourcePath(execDir)).toBe(
          path.join(sidecarDir, 'srt-win.exe'),
        );
      } finally {
        if (original === undefined) delete process.env.KODAX_BUNDLED;
        else process.env.KODAX_BUNDLED = original;
      }
    });

    it('falls back to the library lookup when a bundled build lacks the sidecar', async () => {
      const execDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-srtwin-sidecar-'));
      tempRoots.push(execDir);
      const original = process.env.KODAX_BUNDLED;
      process.env.KODAX_BUNDLED = 'true';
      try {
        windowsSandboxMock.runnerSource = 'C:\\mock\\runner-source.exe';
        expect(resolveSrtWinSourcePath(execDir)).toBe('C:\\mock\\runner-source.exe');
      } finally {
        windowsSandboxMock.runnerSource = '';
        if (original === undefined) delete process.env.KODAX_BUNDLED;
        else process.env.KODAX_BUNDLED = original;
      }
    });

    it('uses the library lookup when not bundled', () => {
      const original = process.env.KODAX_BUNDLED;
      delete process.env.KODAX_BUNDLED;
      try {
        windowsSandboxMock.runnerSource = 'C:\\mock\\runner-source.exe';
        expect(resolveSrtWinSourcePath()).toBe('C:\\mock\\runner-source.exe');
      } finally {
        windowsSandboxMock.runnerSource = '';
        if (original === undefined) delete process.env.KODAX_BUNDLED;
        else process.env.KODAX_BUNDLED = original;
      }
    });

    it.runIf(process.platform === 'win32')(
      'installs the Windows sandbox through the prepared runner srt-win',
      async () => {
        const previousUser = windowsSandboxMock.user;
        windowsSandboxMock.user = { ...previousUser, provisioned: false, credPresent: false };
        try {
          await setupSandboxRuntime();
          expect(windowsSandboxMock.installCalls).toBeGreaterThan(0);
          const installOption = windowsSandboxMock.installOptions.at(-1) as {
            srtWin?: { exe?: string };
          };
          expect(installOption?.srtWin?.exe).toContain('sandbox-runtime');
          expect(installOption?.srtWin?.exe).toContain('runner');
        } finally {
          windowsSandboxMock.user = previousUser;
        }
      },
    );
  });

  it('uses packaged Electron as the sandbox target JavaScript runtime', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-electron-bootstrap-'));
    tempRoots.push(root);
    const originalBundled = process.env.KODAX_BUNDLED;
    vi.stubEnv('PATH', path.join(root, 'isolated-path'));
    const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
    process.env.KODAX_BUNDLED = 'true';
    Object.defineProperty(process.versions, 'electron', {
      configurable: true,
      value: 'test-electron',
    });
    try {
      await doctorSandboxRuntime({ refresh: true });
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const prepared = await sandbox.prepare({
        toolCallId: 'bash-electron-bootstrap',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!prepared) throw new Error('expected packaged Electron workspace invocation');
      try {
        const requestFile = prepared.args.find((arg) => arg.endsWith('.json'));
        if (!requestFile) throw new Error('expected packaged Electron broker request');
        const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
          readonly bootstrapCommand?: string;
          readonly config: {
            readonly filesystem: { readonly allowRead: readonly string[] };
          };
        };
        expect(request.bootstrapCommand).toBe(process.execPath);
        expect(request.config.filesystem.allowRead).toContain(path.dirname(process.execPath));
      } finally {
        await prepared.cleanup();
      }
    } finally {
      if (originalBundled === undefined) delete process.env.KODAX_BUNDLED;
      else process.env.KODAX_BUNDLED = originalBundled;
      if (electronDescriptor === undefined) delete process.versions.electron;
      else Object.defineProperty(process.versions, 'electron', electronDescriptor);
    }
  });

  it('drains an active command before closing its workspace session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-session-drain-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const prepared = await sandbox.prepare({
      toolCallId: 'bash-session-drain',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
    });
    if (!prepared) throw new Error('expected workspace invocation');
    const requestFile = prepared.args.find((arg) => arg.endsWith('.json'));
    if (!requestFile) throw new Error('expected broker request');
    const request = JSON.parse(readFileSync(requestFile, 'utf8')) as {
      readonly observationFile: string;
    };
    await writeFile(request.observationFile, JSON.stringify({
      version: 1,
      state: 'applied',
      backend: sandboxRuntimeCapability().backend,
      policyId: 'kodax-workspace-shell-v1',
    }), 'utf8');

    const closing = resetAsrtWorkspaceSessionsForTest();
    await expect(prepared.cleanup()).resolves.toMatchObject({ state: 'applied' });
    await expect(closing).resolves.toBeUndefined();
  });

  it('falls back to the ordinary execution plan when an optional ASRT is not ready', async () => {
    await markSandboxRuntimeUnavailable();
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: process.cwd(),
      shouldSandbox: () => true,
    });
    const reportObservation = vi.fn();

    await expect(sandbox.prepare({
      toolCallId: 'bash-no-asrt',
      toolInput: { command: 'copy a.txt b.txt' },
      command: 'copy a.txt b.txt',
      cwd: process.cwd(),
      env: process.env,
      reportObservation,
    })).resolves.toBeUndefined();
    expect(reportObservation).toHaveBeenCalledWith({
      version: 1,
      state: 'fallback',
      reason: 'not_ready',
      execution: 'normal_permission_policy',
    });
  });

  it('fails a direct write tool call closed while bash falls back when the runtime is not ready', async () => {
    await markSandboxRuntimeUnavailable();
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-write-not-ready-'));
    tempRoots.push(root);
    const target = path.join(root, 'hello.md');
    const shouldSandbox = vi.fn(() => true);

    const reportObservation = vi.fn();
    await expect(createAsrtShellSandbox({ workspaceRoot: root, shouldSandbox }).prepare({
      toolCallId: 'bash-hello',
      toolInput: { command: 'echo hello > hello.md' },
      command: 'echo hello > hello.md',
      cwd: root,
      env: process.env,
      reportObservation,
    })).resolves.toBeUndefined();
    expect(reportObservation).toHaveBeenCalledWith(expect.objectContaining({
      state: 'fallback',
      reason: 'not_ready',
      execution: 'normal_permission_policy',
    }));

    const sandbox = createAsrtTextFileMutationSandbox({ workspaceRoot: root, shouldSandbox });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      toolCallId: 'write-hello',
      textFileMutationSandbox: sandbox,
    };
    await expect(withTextFileMutation(
      target,
      'write',
      { path: target, content: 'hello' },
      ctx,
      async () => 'unreachable',
    )).rejects.toThrow('The Runtime sandboxed file mutation is unavailable.');
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails a direct write tool call closed when the runtime never selected a sandbox', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-write-not-selected-'));
    tempRoots.push(root);
    const target = path.join(root, 'hello.md');
    const shouldSandbox = vi.fn(() => false);

    const reportObservation = vi.fn();
    await expect(createAsrtShellSandbox({ workspaceRoot: root, shouldSandbox }).prepare({
      toolCallId: 'bash-hello',
      toolInput: { command: 'echo hello > hello.md' },
      command: 'echo hello > hello.md',
      cwd: root,
      env: process.env,
      reportObservation,
    })).resolves.toBeUndefined();
    expect(reportObservation).toHaveBeenCalledWith({ version: 1, state: 'not_selected' });

    const sandbox = createAsrtTextFileMutationSandbox({ workspaceRoot: root, shouldSandbox });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      toolCallId: 'write-hello',
      textFileMutationSandbox: sandbox,
    };
    await expect(withTextFileMutation(
      target,
      'write',
      { path: target, content: 'hello' },
      ctx,
      async () => 'unreachable',
    )).rejects.toThrow('The Runtime sandboxed file mutation is unavailable.');
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not expose a fail-closed mode when an admitted call is unavailable', async () => {
    await markSandboxRuntimeUnavailable();
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: process.cwd(),
      shouldSandbox: () => true,
    });
    const reportObservation = vi.fn();

    await expect(sandbox.prepare({
      toolCallId: 'bash-no-asrt-required',
      toolInput: { command: 'node --version' },
      command: 'node --version',
      cwd: process.cwd(),
      env: process.env,
      reportObservation,
    })).resolves.toBeUndefined();
    expect(sandbox).not.toHaveProperty('failClosed');
    expect(sandbox.processTreeContainment).toBe(
      process.platform === 'linux' ? 'root-exit-drains' : undefined,
    );
    expect(reportObservation).toHaveBeenCalledWith(expect.objectContaining({
      state: 'fallback',
      reason: 'not_ready',
    }));
  });

  it('returns structured unavailability for a standalone SDK sandbox run', async () => {
    await markSandboxRuntimeUnavailable();

    await expect(runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: process.cwd(),
      filesystem: {
        allowRead: [process.cwd()],
        allowWrite: [],
      },
    })).resolves.toMatchObject({
      status: 'unavailable',
      sandboxed: false,
      doctor: { ready: false },
    });
  });

  it.runIf(process.platform === 'win32')(
    'recovers Windows ACLs before startup and after each standalone SDK execution',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-acl-recovery-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });

      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });

      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover') && args.includes('--json')
      ))).toHaveLength(3);
      expect(fileSystemMock.aclPoisonMarkerWriteTargets.some((target) => (
        target.startsWith(path.join(path.resolve(process.env.ProgramData!), 'KodaX'))
      ))).toBe(true);
      expect(fileSystemMock.aclPoisonMarkerWriteTargets.some((target) => (
        target.startsWith(path.resolve(process.env.KODAX_HOME!))
      ))).toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    'retires a workspace owner before admitting a standalone owner in the same module',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-owner-singleton-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const invocation = await sandbox.prepare({
        toolCallId: 'bash-active-workspace-owner',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      });
      if (!invocation) throw new Error('expected workspace invocation');
      await invocation.cleanup();

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    },
  );

  it.runIf(process.platform === 'win32')(
    'restores sandbox admission automatically after transient ACL recovery failure',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-acl-recovery-failure-'));
      tempRoots.push(root);
      windowsSandboxMock.aclRecoveryOutcome = 'failure';
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });

      await expect(run()).rejects.toThrow('Windows sandbox ACL recovery failed');
      expect(capturedBrokerRequests).toHaveLength(0);

      windowsSandboxMock.aclRecoveryOutcome = 'success';
      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      expect(capturedBrokerRequests).toHaveLength(1);
      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      )).length).toBeGreaterThanOrEqual(2);
      expect(windowsEffectJobMock.aclRecoveryUncontainedStarts).toBe(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not spawn a standalone owner when its durable ACL poison marker cannot be written',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-marker-write-failure-'));
      tempRoots.push(root);
      await doctorSandboxRuntime({ refresh: true });
      const standaloneGateCount = capturedStandaloneGateLaunches.length;
      fileSystemMock.writeAclPoisonMarkerFailure = true;

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).rejects.toThrow('injected ACL poison marker write failure');
      expect(capturedStandaloneGateLaunches).toHaveLength(standaloneGateCount);
      expect(capturedBrokerRequests).toHaveLength(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'recovers automatically when standalone Job containment fails before target authorization',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-preauth-containment-'));
      tempRoots.push(root);
      await doctorSandboxRuntime({ refresh: true });
      windowsEffectJobMock.containFailureOnCall = windowsEffectJobMock.containCalls + 1;
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });

      await expect(run()).rejects.toThrow('injected Windows Job containment failure');
      await waitForStandaloneBrokerSettlementsForTest();
      expect(capturedBrokerRequests).toHaveLength(0);
      for (const directory of [
        path.join(path.resolve(process.env.KODAX_HOME!), 'sandbox-runtime', 'acl-poison'),
        path.join(process.env.ProgramData!, 'KodaX', 'sandbox-runtime', 'acl-poison'),
      ]) {
        await expect(readDirectoryIfPresent(directory)).resolves.toEqual([]);
      }

      windowsEffectJobMock.containFailureOnCall = undefined;
      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      expect(capturedBrokerRequests).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not authorize a standalone broker before durable effect binding',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-gated-owner-'));
      tempRoots.push(root);
      const requestCount = capturedBrokerRequests.length;
      recoveryLockMock.effectFailureStartCall = recoveryLockMock.effectCalls + 3;

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).rejects.toThrow('injected filesystem-effect coordinator failure');
      expect(capturedBrokerRequests).toHaveLength(requestCount);
      recoveryLockMock.effectFailureStartCall = undefined;
      await waitForStandaloneBrokerSettlementsForTest();
      for (const directory of [
        path.join(path.resolve(process.env.KODAX_HOME!), 'sandbox-runtime', 'acl-poison'),
        path.join(process.env.ProgramData!, 'KodaX', 'sandbox-runtime', 'acl-poison'),
      ]) {
        await expect(readDirectoryIfPresent(directory)).resolves.toEqual([]);
      }
      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    },
  );

  it.runIf(process.platform === 'win32')(
    'preserves packaged interpreter environment across the standalone gate',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-gate-environment-'));
      tempRoots.push(root);
      const originalBundled = process.env.KODAX_BUNDLED;
      const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
      process.env.KODAX_BUNDLED = 'true';
      try {
        Object.defineProperty(process.versions, 'electron', {
          configurable: true,
          value: 'test-electron',
        });
        await expect(runKodaXSandboxed({
          command: process.execPath,
          args: ['--version'],
          cwd: root,
          filesystem: { allowRead: [], allowWrite: [] },
        })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
        expect(capturedStandaloneGateLaunches.at(-1)?.env.ELECTRON_RUN_AS_NODE).toBe('1');
        expect(capturedSpawnArgv.some((argv) => argv.some((arg) => (
          arg.includes('env: launch.env')
        )))).toBe(true);

        delete process.versions.electron;
        await expect(runKodaXSandboxed({
          command: process.execPath,
          args: ['--version'],
          cwd: root,
          filesystem: { allowRead: [], allowWrite: [] },
        })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
        expect(capturedStandaloneGateLaunches.at(-1)?.env.BUN_BE_BUN).toBeUndefined();
        expect(capturedSpawnEnvironments.at(-1)?.BUN_BE_BUN).toBe('1');
      } finally {
        if (originalBundled === undefined) delete process.env.KODAX_BUNDLED;
        else process.env.KODAX_BUNDLED = originalBundled;
        if (electronDescriptor === undefined) delete process.versions.electron;
        else Object.defineProperty(process.versions, 'electron', electronDescriptor);
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'retries post-execution ACL recovery and restores SDK runs automatically',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-reset-recovery-failure-'));
      tempRoots.push(root);
      windowsSandboxMock.aclRecoveryOutcomes.push('success', 'failure');
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });

      await expect(run()).rejects.toThrow('Windows sandbox ACL recovery failed');
      expect(capturedBrokerRequests).toHaveLength(1);
      windowsSandboxMock.aclRecoveryOutcome = 'success';
      await vi.waitFor(() => {
        expect(capturedSyncSpawns.filter(({ args }) => (
          args.includes('acl') && args.includes('recover')
        )).length).toBeGreaterThanOrEqual(3);
      }, { timeout: 3_000 });
      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      expect(capturedBrokerRequests).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'persists a live standalone owner when process-tree termination is unconfirmed',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-live-owner-poison-'));
      tempRoots.push(root);
      processTreeKillMock.childPid = process.pid;
      processTreeKillMock.outcome = 'unknown';
      windowsEffectJobMock.drainPending = true;
      stubbornBroker.mode = 'silent';
      const run = (timeoutMs?: number) => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });

      await expect(run(10)).rejects.toThrow('termination was not confirmed');
      const laterMutation = acquireFileSystemMutationLease();
      await expect(Promise.race([
        laterMutation.then(() => 'acquired'),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
      ])).resolves.toBe('pending');
      const poisonDirectories = [
        path.join(path.resolve(process.env.KODAX_HOME!), 'sandbox-runtime', 'acl-poison'),
        path.join(
          path.resolve(process.env.ProgramData!),
          'KodaX',
          'sandbox-runtime',
          'acl-poison',
        ),
      ];
      for (const directory of poisonDirectories) {
        const entries = await readdir(directory);
        expect(entries).toHaveLength(1);
        expect(entries[0]).not.toMatch(/^unconfirmed-owner-/);
      }

      processTreeKillMock.releaseUnknown?.();
      processTreeKillMock.releaseUnknown = undefined;
      processTreeKillMock.childPid = undefined;
      windowsEffectJobMock.releaseDrain?.();
      windowsEffectJobMock.releaseDrain = undefined;
      windowsEffectJobMock.drainPending = false;
      const laterRelease = await laterMutation;
      await laterRelease();
      await vi.waitFor(async () => {
        for (const directory of poisonDirectories) {
          await expect(readdir(directory)).resolves.toEqual([]);
        }
      });

      processTreeKillMock.outcome = 'actual';
      stubbornBroker.mode = 'none';
      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    },
  );

  it.runIf(process.platform === 'win32')(
    'waits for delayed standalone Job settlement in test cleanup',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-reset-waits-drain-'));
      tempRoots.push(root);
      windowsEffectJobMock.drainPending = true;
      stubbornBroker.mode = 'silent';

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
        timeoutMs: 10,
      })).rejects.toThrow('Sandboxed command exceeded its 10 ms timeout.');

      let resetSettled = false;
      const reset = waitForStandaloneBrokerSettlementsForTest().then(() => {
        resetSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(resetSettled).toBe(false);

      windowsEffectJobMock.releaseDrain?.();
      windowsEffectJobMock.releaseDrain = undefined;
      windowsEffectJobMock.drainPending = false;
      await reset;
      expect(resetSettled).toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    'bounds shutdown while a deferred standalone Job settlement remains pending',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-shutdown-pending-drain-'));
      tempRoots.push(root);
      windowsEffectJobMock.drainPending = true;
      stubbornBroker.mode = 'silent';
      const restoreShutdownTimeout = overrideStandaloneBrokerSettlementTimeoutForTest(25);

      try {
        await expect(runKodaXSandboxed({
          command: process.execPath,
          args: ['--version'],
          cwd: root,
          filesystem: { allowRead: [], allowWrite: [] },
          timeoutMs: 10,
        })).rejects.toThrow('Sandboxed command exceeded its 10 ms timeout.');

        await expect(shutdownAsrtWorkspaceSessions()).rejects.toThrow(
          'automatic recovery remains in progress',
        );
        expect(windowsEffectJobMock.unrefCalls).toBe(1);
        expect(standaloneBrokerDetachMock).toMatchObject({
          childUnrefCalls: 1,
          stdinUnrefCalls: 1,
          stdoutUnrefCalls: 1,
          stderrUnrefCalls: 1,
        });
        for (const directory of [
          path.join(path.resolve(process.env.KODAX_HOME!), 'sandbox-runtime', 'acl-poison'),
          path.join(
            path.resolve(process.env.ProgramData!),
            'KodaX',
            'sandbox-runtime',
            'acl-poison',
          ),
        ]) {
          const entries = await readdir(directory);
          expect(entries).toHaveLength(1);
          expect(entries[0]).not.toMatch(/^unconfirmed-owner-/);
        }
      } finally {
        restoreShutdownTimeout();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'returns a successful standalone result while fence release finishes automatically',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-success-release-retry-'));
      tempRoots.push(root);
      standaloneFenceReleaseMock.failures = 2;

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });

      await waitForStandaloneBrokerSettlementsForTest();
      const laterMutation = await acquireFileSystemMutationLease();
      await laterMutation();
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps retrying a deferred coordinator release until shutdown can finish safely',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-release-auto-recovery-'));
      tempRoots.push(root);
      stubbornBroker.mode = 'silent';
      standaloneFenceReleaseMock.failures = 2;
      const restoreShutdownTimeout = overrideStandaloneBrokerSettlementTimeoutForTest(25);

      try {
        await expect(runKodaXSandboxed({
          command: process.execPath,
          args: ['--version'],
          cwd: root,
          filesystem: { allowRead: [], allowWrite: [] },
          timeoutMs: 10,
        })).rejects.toThrow('Sandboxed command exceeded its 10 ms timeout.');

        await expect(shutdownAsrtWorkspaceSessions()).rejects.toThrow(
          'automatic recovery remains in progress',
        );
        await waitForStandaloneBrokerSettlementsForTest();
        await expect(shutdownAsrtWorkspaceSessions()).resolves.toBeUndefined();
        const laterMutation = await acquireFileSystemMutationLease();
        await laterMutation();
      } finally {
        standaloneFenceReleaseMock.failures = 0;
        restoreShutdownTimeout();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps ACL poison when a standalone Job cannot prove its process tree drained',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-job-drain-failure-'));
      tempRoots.push(root);
      windowsEffectJobMock.drainFailure = 'injected standalone Job drain failure';
      stubbornBroker.mode = 'silent';
      const recoveryCountBefore = capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      )).length;

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
        timeoutMs: 10,
      })).rejects.toThrow('Sandboxed command exceeded its 10 ms timeout.');
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await vi.waitFor(async () => {
        await expect(readdir(poisonDirectory)).resolves.toEqual([
          expect.stringMatching(/^recovery-owner-/),
        ]);
      });
      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      ))).toHaveLength(recoveryCountBefore + 1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'atomically persists fallback recovery evidence and then clears it automatically',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-unconfirmed-fallback-'));
      tempRoots.push(root);
      fileSystemMock.renameAclPoisonMarkerFailures = 1;
      processTreeKillMock.outcome = 'unknown';
      windowsEffectJobMock.drainFailure = 'injected standalone Job drain failure';
      stubbornBroker.mode = 'silent';

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
        timeoutMs: 10,
      })).rejects.toThrow('termination was not confirmed');

      const poisonDirectories = [
        path.join(path.resolve(process.env.KODAX_HOME!), 'sandbox-runtime', 'acl-poison'),
        path.join(
          path.resolve(process.env.ProgramData!),
          'KodaX',
          'sandbox-runtime',
          'acl-poison',
        ),
      ];
      expect(fileSystemMock.aclPoisonMarkerWriteTargets.some((target) => (
        path.basename(path.dirname(target)) === 'acl-poison-staging'
      ))).toBe(true);
      expect(fileSystemMock.aclPoisonMarkerWriteTargets.some((target) => (
        path.basename(path.dirname(target)) === 'acl-poison'
      ))).toBe(false);
      processTreeKillMock.releaseUnknown?.();
      processTreeKillMock.releaseUnknown = undefined;
      processTreeKillMock.outcome = 'actual';
      windowsEffectJobMock.drainFailure = undefined;
      for (const directory of poisonDirectories) {
        await vi.waitFor(async () => {
          await expect(readDirectoryIfPresent(directory)).resolves.toEqual([]);
        }, { timeout: 5_000 });
      }
      stubbornBroker.mode = 'none';
      const laterMutation = await acquireFileSystemMutationLease();
      await laterMutation();
    },
  );

  it.runIf(process.platform === 'win32').each([
    'close_then_unknown',
    'close_then_reject',
  ] as const)(
    'waits for standalone termination proof after root close when kill ends with %s',
    async (outcome) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `kodax-sdk-close-before-${outcome}-`));
      tempRoots.push(root);
      processTreeKillMock.outcome = outcome;
      stubbornBroker.mode = 'silent';
      const recoveryCountBefore = capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      )).length;
      const running = runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
        timeoutMs: 10,
      });

      await vi.waitFor(
        () => expect(processTreeKillMock.releaseUnknown).toBeTypeOf('function'),
        { timeout: 5_000 },
      );
      const premature = await Promise.race([
        running.then(() => 'settled', () => 'settled'),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
      ]);
      const recoveryCountWhilePending = capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      )).length;
      expect(premature).toBe('pending');
      expect(recoveryCountWhilePending).toBe(recoveryCountBefore + 1);

      processTreeKillMock.releaseUnknown?.();
      processTreeKillMock.releaseUnknown = undefined;
      await expect(running).rejects.toThrow(/termination (?:was not confirmed|failed)/);
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await vi.waitFor(async () => {
        await expect(readdir(poisonDirectory)).resolves.toEqual([]);
      });
      expect(capturedSyncSpawns.filter(({ args }) => (
        args.includes('acl') && args.includes('recover')
      ))).toHaveLength(recoveryCountBefore + 2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'fails closed on an active sandbox owner from another process using the same KodaX home',
    async () => {
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const holder = actualChildProcess.spawn(process.execPath, [
        '-e',
        'process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      await once(holder.stdout!, 'data');
      if (holder.pid === undefined) throw new Error('active marker holder PID missing');
      const holderIdentity = readProcessStartIdentity(holder.pid);
      if (holderIdentity === undefined) throw new Error('active marker holder identity missing');
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'foreign-profile-owner.json');
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(marker, JSON.stringify({
        version: 1,
        state: 'active',
        holderPid: holder.pid,
        holderProcessStartIdentity: holderIdentity,
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-foreign-profile-owner-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });
      try {
        await rm(marker, { force: true });
        await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
        await writeFile(marker, JSON.stringify({
          version: 1,
          state: 'active',
          holderPid: holder.pid,
          holderProcessStartIdentity: holderIdentity,
          windowsBootIdentity: processIdentityMock.windowsBootIdentity,
        }), 'utf8');
        await expect(run()).rejects.toThrow(/sandbox owner.*active/i);
        await expect(stat(marker)).resolves.toBeDefined();
        expect(capturedBrokerRequests).toHaveLength(1);

        await rm(marker, { force: true });
        await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      } finally {
        const holderClosed = once(holder, 'close');
        holder.kill('SIGKILL');
        await holderClosed;
        await rm(marker, { force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'releases a cancelled admission fence after retryable foreign owner contention',
    async () => {
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const holder = actualChildProcess.spawn(process.execPath, [
        '-e',
        'process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      await once(holder.stdout!, 'data');
      if (holder.pid === undefined) throw new Error('active marker holder PID missing');
      const holderIdentity = readProcessStartIdentity(holder.pid);
      if (holderIdentity === undefined) throw new Error('active marker holder identity missing');
      const poisonDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'foreign-cancelled-owner.json');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-foreign-owner-cancel-'));
      tempRoots.push(root);
      await mkdir(poisonDirectory, { recursive: true });
      const controller = new AbortController();
      let releaseAdmission: (() => void) | undefined;
      recoveryLockMock.beforeOperation = async () => {
        recoveryLockMock.beforeOperation = undefined;
        await new Promise<void>((resolve) => { releaseAdmission = resolve; });
      };
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const preparing = sandbox.prepare({
        toolCallId: 'bash-cancelled-foreign-owner',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
        signal: controller.signal,
      });
      try {
        await vi.waitFor(() => expect(releaseAdmission).toBeTypeOf('function'));
        await writeFile(marker, JSON.stringify({
          version: 1,
          state: 'active',
          holderPid: holder.pid,
          holderProcessStartIdentity: holderIdentity,
          windowsBootIdentity: processIdentityMock.windowsBootIdentity,
        }), 'utf8');
        controller.abort();
        await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
        releaseAdmission?.();
        releaseAdmission = undefined;
        await vi.waitFor(async () => {
          const effectLease = await acquireFileSystemMutationLease();
          await effectLease();
        });
        expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
        expect(capturedBrokerRequests).toHaveLength(0);
        await expect(stat(marker)).resolves.toBeDefined();
        await rm(marker, { force: true });
        const retry = await sandbox.prepare({
          toolCallId: 'bash-after-cancelled-foreign-owner',
          toolInput: { command: 'node --version' },
          command: 'node --version',
          executable: process.execPath,
          args: ['--version'],
          cwd: root,
          env: process.env,
        });
        if (!retry) throw new Error('expected retry after foreign owner contention');
        await retry.cleanup();
      } finally {
        releaseAdmission?.();
        const holderClosed = once(holder, 'close');
        holder.kill('SIGKILL');
        await holderClosed;
        await rm(marker, { force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'migrates a stale legacy owner automatically after its sandbox SID is idle',
    async () => {
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const holder = actualChildProcess.spawn(process.execPath, [
        '-e',
        'process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      await once(holder.stdout!, 'data');
      if (holder.pid === undefined) throw new Error('active marker holder PID missing');
      const holderIdentity = readProcessStartIdentity(holder.pid);
      if (holderIdentity === undefined) throw new Error('active marker holder identity missing');
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'dead-profile-owner.json');
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(marker, JSON.stringify({
        version: 1,
        state: 'active',
        holderPid: holder.pid,
        holderProcessStartIdentity: holderIdentity,
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-dead-profile-owner-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });

      await expect(run()).rejects.toThrow(/sandbox owner.*active/i);
      const holderClosed = once(holder, 'close');
      holder.kill('SIGKILL');
      await holderClosed;
      windowsSandboxMock.sidProcessesActive = false;
      await vi.waitFor(async () => {
        await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      }, { timeout: 3_000 });
      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      expect(capturedBrokerRequests).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'recovers a current recovery ticket without Job evidence after its sandbox SID is idle',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'recovery-owner-without-job.json');
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(marker, JSON.stringify({
        version: 3,
        state: 'recovery_pending',
        ticketId: randomUUID(),
        holderPid: 2_147_000_000,
        holderProcessStartIdentity: 'gone-recovery-owner',
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      windowsSandboxMock.sidProcessesActive = false;
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-idle-recovery-owner-'));
      tempRoots.push(root);

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(capturedBrokerRequests).toHaveLength(1);
      expect(windowsSandboxMock.sidProbeLaunches).toContainEqual({
        sid: windowsSandboxMock.user.sid,
        launcher: expect.objectContaining({
          executable: expect.stringMatching(/[\\/]sandbox-runtime[\\/]runner[\\/].*srt-win\.exe$/i),
          prependArgs: ['--srt-win'],
        }),
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'automatically clears a same-boot unconfirmed owner after its sandbox SID becomes idle',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'unconfirmed-owner-same-boot.json');
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(marker, JSON.stringify({
        version: 3,
        state: 'unconfirmed',
        ticketId: randomUUID(),
        holderPid: 2_147_000_000,
        holderProcessStartIdentity: 'gone-unconfirmed-owner',
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-unconfirmed-owner-retry-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });

      await expect(run()).rejects.toThrow(/sandbox owner|recovery/i);
      await expect(stat(marker)).resolves.toBeDefined();

      windowsSandboxMock.sidProcessesActive = false;
      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(capturedBrokerRequests).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'reports a failed sandbox-user SID probe while keeping ACL recovery fenced',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'recovery-owner-sid-probe-failed.json');
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(marker, JSON.stringify({
        version: 3,
        state: 'recovery_pending',
        ticketId: randomUUID(),
        holderPid: 2_147_000_000,
        holderProcessStartIdentity: 'gone-recovery-owner',
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      windowsSandboxMock.sidInspectionFailure = 'injected sandbox-user SID probe failure';
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-sid-probe-failed-'));
      tempRoots.push(root);

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).rejects.toThrow(/sandbox owner|recovery/i);
      await expect(stat(marker)).resolves.toBeDefined();
      expect(capturedDiagnostics).toContainEqual(expect.objectContaining({
        source: 'runtime:sandbox-acl-recovery',
        level: 'warn',
        detail: expect.objectContaining({
          message: 'injected sandbox-user SID probe failure',
        }),
      }));
    },
  );

  it.runIf(process.platform === 'win32')(
    'recovers a current Global Job ticket without requiring sandbox SID inspection',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'recovery-owner-global-job.json');
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(marker, JSON.stringify({
        version: 3,
        state: 'recovery_pending',
        ticketId: randomUUID(),
        holderPid: 2_147_000_000,
        holderProcessStartIdentity: 'gone-global-job-owner',
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
        containment: {
          kind: 'windows-job',
          jobName: 'Global\\KodaXEffect-00000000-0000-4000-8000-000000000009',
          sandboxSid: 'S-1-5-21-1000',
          supervisorPid: 2_147_000_001,
          supervisorProcessStartIdentity: 'gone-global-job-supervisor',
        },
      }), 'utf8');
      windowsEffectJobMock.terminateOutcome = 'not_found';
      windowsSandboxMock.sidInspectionFailure = 'SID inspection requires elevation';
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-global-job-recovery-'));
      tempRoots.push(root);

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(windowsSandboxMock.sidInspectionCalls).toBe(0);
      expect(capturedBrokerRequests).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps an unreadable live owner as retryable contention',
    async () => {
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const holder = actualChildProcess.spawn(process.execPath, [
        '-e',
        'process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      await once(holder.stdout!, 'data');
      if (holder.pid === undefined) throw new Error('active marker holder PID missing');
      const holderIdentity = readProcessStartIdentity(holder.pid);
      if (holderIdentity === undefined) throw new Error('active marker holder identity missing');
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'unreadable-profile-owner.json');
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(marker, JSON.stringify({
        version: 1,
        state: 'active',
        holderPid: holder.pid,
        holderProcessStartIdentity: holderIdentity,
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-unreadable-owner-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });
      try {
        processIdentityMock.unreadablePids.add(holder.pid);
        await expect(run()).rejects.toThrow(/sandbox owner.*active/i);
        processIdentityMock.unreadablePids.delete(holder.pid);
        await rm(marker, { force: true });
        await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      } finally {
        processIdentityMock.unreadablePids.delete(holder.pid);
        const holderClosed = once(holder, 'close');
        holder.kill('SIGKILL');
        await holderClosed;
        await rm(marker, { force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects an active sandbox owner from another SDK module copy in the same process',
    async () => {
      const holderIdentity = readProcessStartIdentity(process.pid);
      if (holderIdentity === undefined) throw new Error('current process identity missing');
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'same-process-module-owner.json');
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(marker, JSON.stringify({
        version: 1,
        state: 'active',
        holderPid: process.pid,
        holderProcessStartIdentity: holderIdentity,
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-same-process-owner-'));
      tempRoots.push(root);

      try {
        await expect(runKodaXSandboxed({
          command: process.execPath,
          args: ['--version'],
          cwd: root,
          filesystem: { allowRead: [], allowWrite: [] },
        })).rejects.toThrow(/sandbox owner.*active/i);
        expect(capturedBrokerRequests).toHaveLength(0);

        await rm(marker, { force: true });
        await expect(runKodaXSandboxed({
          command: process.execPath,
          args: ['--version'],
          cwd: root,
          filesystem: { allowRead: [], allowWrite: [] },
        })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      } finally {
        await rm(marker, { force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'coordinates one Windows sandbox SID across different KODAX_HOME values',
    async () => {
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const holder = actualChildProcess.spawn(process.execPath, [
        '-e',
        'process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      await once(holder.stdout!, 'data');
      if (holder.pid === undefined) throw new Error('active marker holder PID missing');
      const holderIdentity = readProcessStartIdentity(holder.pid);
      if (holderIdentity === undefined) throw new Error('active marker holder identity missing');
      const poisonDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'different-home-owner.json');
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(marker, JSON.stringify({
        version: 1,
        state: 'active',
        holderPid: holder.pid,
        holderProcessStartIdentity: holderIdentity,
        windowsBootIdentity: processIdentityMock.windowsBootIdentity,
      }), 'utf8');
      const secondHome = path.join(path.dirname(process.env.KODAX_HOME!), 'second-home');
      vi.stubEnv('KODAX_HOME', secondHome);
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-different-home-owner-'));
      tempRoots.push(root);

      try {
        await expect(runKodaXSandboxed({
          command: process.execPath,
          args: ['--version'],
          cwd: root,
          filesystem: { allowRead: [], allowWrite: [] },
        })).rejects.toThrow(/sandbox owner.*active/i);
        expect(capturedBrokerRequests).toHaveLength(0);
      } finally {
        const holderClosed = once(holder, 'close');
        holder.kill('SIGKILL');
        await holderClosed;
        await rm(marker, { force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'cleans workspace launch artifacts when another module owns the Windows sandbox SID',
    async () => {
      const holderIdentity = readProcessStartIdentity(process.pid);
      if (holderIdentity === undefined) throw new Error('current process identity missing');
      const poisonDirectory = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-poison',
      );
      const marker = path.join(poisonDirectory, 'module-owner-before-workspace.json');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-workspace-owner-contention-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      await doctorSandboxRuntime({ refresh: true });
      recoveryLockMock.calls = 0;
      recoveryLockMock.beforeOperation = async () => {
        if (recoveryLockMock.calls !== 3) return;
        recoveryLockMock.beforeOperation = undefined;
        await mkdir(poisonDirectory, { recursive: true });
        await writeFile(marker, JSON.stringify({
          version: 1,
          state: 'active',
          holderPid: process.pid,
          holderProcessStartIdentity: holderIdentity,
          windowsBootIdentity: processIdentityMock.windowsBootIdentity,
        }), 'utf8');
      };

      try {
        await expect(sandbox.prepare({
          toolCallId: 'bash-module-owner-contention',
          toolInput: { command: 'node --version' },
          command: 'node --version',
          executable: process.execPath,
          args: ['--version'],
          cwd: root,
          env: process.env,
        })).resolves.toBeUndefined();
        expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
        const controlDirectory = path.join(path.resolve(process.env.KODAX_HOME!), 'sandbox-runtime');
        await expect(readdir(controlDirectory)).resolves.not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^workspace-.*\.json$/)]),
        );
      } finally {
        await rm(marker, { force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'ignores a partial marker in the backward-compatible staging directory',
    async () => {
      const stagingDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison-staging',
      );
      await mkdir(stagingDirectory, { recursive: true });
      await writeFile(path.join(stagingDirectory, 'owner-in-progress.tmp'), '{', 'utf8');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-partial-marker-'));
      tempRoots.push(root);

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      await expect(readdir(stagingDirectory)).resolves.toEqual(['owner-in-progress.tmp']);
    },
  );

  it.runIf(process.platform === 'win32')(
    'recovers a corrupt marker automatically after its sandbox SID becomes idle',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(poisonDirectory, { recursive: true });
      const marker = path.join(poisonDirectory, 'owner-corrupt.json');
      await writeFile(marker, '{', 'utf8');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-corrupt-marker-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });

      await expect(run()).rejects.toThrow('unreadable');
      windowsSandboxMock.sidProcessesActive = false;
      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(capturedBrokerRequests).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'waits for a recovery lock held by another KodaX process',
    async () => {
      await doctorSandboxRuntime({ refresh: true });
      const actualChildProcess = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const lockFile = path.join(
        path.resolve(process.env.ProgramData!),
        'KodaX',
        'sandbox-runtime',
        'acl-recovery.lock',
      );
      const holderScript = [
        "const fs=require('node:fs')",
        "const path=require('node:path')",
        `const lock=${JSON.stringify(lockFile)}`,
        "fs.mkdirSync(path.dirname(lock),{recursive:true})",
        "const fd=fs.openSync(lock,'wx')",
        "fs.writeSync(fd,process.pid+' 00000000-0000-4000-8000-000000000000\\n')",
        "process.stdout.write('ready\\n')",
        "process.stdin.once('data',()=>{fs.closeSync(fd);fs.rmSync(lock,{force:true});process.exit(0)})",
        'process.stdin.resume()',
      ].join(';');
      const holder = actualChildProcess.spawn(process.execPath, ['-e', holderScript], {
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });
      await once(holder.stdout!, 'data');
      const holderClosed = once(holder, 'close');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-cross-process-recovery-lock-'));
      tempRoots.push(root);
      const running = runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });
      const recoveriesBeforeRelease = capturedSyncSpawns.filter((spawn) => (
        spawn.args.includes('acl') && spawn.args.includes('recover')
      )).length;

      try {
        const premature = await Promise.race([
          running.then(() => 'settled', () => 'settled'),
          new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100)),
        ]);
        expect(premature).toBe('pending');
        expect(capturedSyncSpawns.filter((spawn) => (
          spawn.args.includes('acl') && spawn.args.includes('recover')
        ))).toHaveLength(recoveriesBeforeRelease);
        expect(capturedBrokerRequests).toHaveLength(0);
        holder.stdin!.end('release');
        await expect(running).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
        await holderClosed;
      } finally {
        if (holder.exitCode === null) holder.kill('SIGKILL');
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'allows a safe admission to retry after ordinary ACL recovery lock contention',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-recovery-lock-retry-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });
      recoveryLockMock.timeoutFailures = 1;

      await expect(run()).rejects.toThrow('KodaX file lock timed out');
      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    },
  );

  it.runIf(process.platform === 'win32')(
    'automatically recovers a write-ahead ticket after cleanup lock contention',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-cleanup-lock-timeout-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });
      recoveryLockMock.timeoutOnCall = 4;

      await expect(run()).rejects.toThrow('KodaX file lock timed out');
      expect(capturedBrokerRequests).toHaveLength(1);
      recoveryLockMock.timeoutOnCall = undefined;
      recoveryLockMock.calls = 0;
      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      expect(capturedBrokerRequests).toHaveLength(2);
    },
  );

  it.runIf(process.platform === 'win32')(
    'removes an unspawned active marker when recovery lock release fails after admission',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-admission-release-failure-'));
      tempRoots.push(root);
      const run = () => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      });
      recoveryLockMock.releaseFailures = 1;

      await expect(run()).rejects.toThrow('injected recovery lock release failure');
      expect(capturedBrokerRequests).toHaveLength(0);
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await expect(readDirectoryIfPresent(poisonDirectory)).resolves.not.toContainEqual(
        expect.stringMatching(/\.json$/),
      );
      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    },
  );

  it.runIf(process.platform === 'win32')(
    'recovers a contained process tree automatically after its root PID is gone',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-gone-root-poison-'));
      tempRoots.push(root);
      processTreeKillMock.childPid = 2_147_000_000;
      processTreeKillMock.outcome = 'unknown';
      windowsEffectJobMock.drainFailure = 'injected standalone Job drain failure';
      stubbornBroker.mode = 'silent';
      const run = (timeoutMs?: number) => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });

      await expect(run(10)).rejects.toThrow('termination was not confirmed');
      const spawnCount = capturedSpawnArgv.length;
      processTreeKillMock.releaseUnknown?.();
      processTreeKillMock.releaseUnknown = undefined;
      processTreeKillMock.outcome = 'actual';
      windowsEffectJobMock.drainFailure = undefined;
      stubbornBroker.mode = 'none';

      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
      expect(capturedSpawnArgv.length).toBeGreaterThan(spawnCount);
    },
  );

  it.runIf(process.platform === 'win32')(
    'recovers an unconfirmed owner without a root PID only after a verified Windows reboot',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-reboot-poison-'));
      tempRoots.push(root);
      processTreeKillMock.outcome = 'unknown';
      windowsEffectJobMock.drainFailure = 'injected standalone Job drain failure';
      stubbornBroker.mode = 'silent';
      const run = (timeoutMs?: number) => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });

      await expect(run(10)).rejects.toThrow('termination was not confirmed');
      processTreeKillMock.releaseUnknown?.();
      processTreeKillMock.releaseUnknown = undefined;
      await resetAsrtWorkspaceSessionsForTest({ preserveAclPoison: true });
      await _resetFileSystemEffectLeasesForTests();
      processTreeKillMock.outcome = 'actual';
      windowsEffectJobMock.drainFailure = undefined;
      stubbornBroker.mode = 'none';
      processIdentityMock.windowsBootIdentity = 'windows-boot-200';

      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    },
  );

  it.runIf(process.platform === 'win32')(
    'recovers a contained owner automatically without a Windows boot identity',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-unverifiable-boot-'));
      tempRoots.push(root);
      processIdentityMock.windowsBootIdentity = undefined;
      processTreeKillMock.outcome = 'unknown';
      windowsEffectJobMock.drainFailure = 'injected standalone Job drain failure';
      stubbornBroker.mode = 'silent';
      const run = (timeoutMs?: number) => runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });

      await expect(run(10)).rejects.toThrow('termination was not confirmed');
      processTreeKillMock.releaseUnknown?.();
      processTreeKillMock.releaseUnknown = undefined;
      processTreeKillMock.outcome = 'actual';
      windowsEffectJobMock.drainFailure = undefined;
      stubbornBroker.mode = 'none';

      await expect(run()).resolves.toMatchObject({ status: 'completed', exitCode: 0 });
    },
  );

  it.runIf(process.platform === 'win32')(
    'reports automatic legacy-ticket recovery through doctor without requesting setup',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(
        path.join(poisonDirectory, 'legacy-owner.json'),
        JSON.stringify({ version: 1 }),
        'utf8',
      );

      const doctor = await doctorSandboxRuntime({ refresh: true });

      expect(doctor.ready).toBe(false);
      expect(doctor.setupRequired).toBe(false);
      expect(doctor.diagnostics.join('\n')).toContain('retry recovery automatically');

      const setup = await prepareSandboxRuntimeForSetup();
      expect(setup).toMatchObject({ status: 'unavailable', attempted: false });
      expect(setup.guidance.join('\n')).toContain('retry recovery automatically');
    },
  );

  it.runIf(process.platform === 'win32')(
    'reports a corrupt recovery ticket as an automatic retry',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(path.join(poisonDirectory, 'corrupt-owner.json'), '{', 'utf8');

      const doctor = await doctorSandboxRuntime({ refresh: true });

      expect(doctor.ready).toBe(false);
      expect(doctor.diagnostics.join('\n')).toContain('retry automatically');
      const setup = await prepareSandboxRuntimeForSetup();
      expect(setup).toMatchObject({ status: 'unavailable', attempted: false });
      expect(setup.guidance.join('\n')).toContain('retry automatically');
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not repair missing setup while a legacy ACL poison marker is unresolved',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(
        path.join(poisonDirectory, 'legacy-owner.json'),
        JSON.stringify({ version: 1 }),
        'utf8',
      );
      windowsSandboxMock.guardReady = false;

      const setup = await prepareSandboxRuntimeForSetup();

      expect(setup).toMatchObject({ status: 'unavailable', attempted: false });
      expect(setup.guidance.join('\n')).toContain('retry recovery automatically');
      expect(windowsSandboxMock.guardReady).toBe(false);
      expect(windowsSandboxMock.installCalls).toBe(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'rechecks ACL poison under the recovery lock before mutating sandbox setup',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      windowsSandboxMock.guardReady = false;
      recoveryLockMock.beforeOperation = async () => {
        recoveryLockMock.beforeOperation = undefined;
        await mkdir(poisonDirectory, { recursive: true });
        await writeFile(
          path.join(poisonDirectory, 'concurrent-legacy-owner.json'),
          JSON.stringify({ version: 1 }),
          'utf8',
        );
      };

      const setup = await prepareSandboxRuntimeForSetup();

      expect(setup.status).toBe('unavailable');
      expect(setup.guidance.join('\n')).toContain('retry recovery automatically');
      expect(windowsSandboxMock.guardReady).toBe(false);
      expect(windowsSandboxMock.installCalls).toBe(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not mutate sandbox setup while this process has an active workspace owner',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-setup-active-owner-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });
      const active = await sandbox.prepare({
        toolCallId: 'active-owner-during-setup',
        toolInput: { command: 'echo active' },
        command: 'echo active',
        cwd: root,
        env: process.env,
      });
      if (!active) throw new Error('expected active workspace owner');
      expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
      windowsSandboxMock.guardReady = false;

      const setup = await prepareSandboxRuntimeForSetup();

      expect(setup).toMatchObject({ status: 'unavailable', attempted: true });
      expect(setup.guidance.join('\n')).toContain('sandbox owner is active');
      expect(windowsSandboxMock.guardReady).toBe(false);
      expect(windowsSandboxMock.installCalls).toBe(0);
      await active.cleanup();
      await shutdownAsrtWorkspaceSessions();
      expect(await sandbox.prepare({
        toolCallId: undefined,
        toolInput: { command: 'echo not-selected' },
        command: 'echo not-selected',
        cwd: root,
        env: process.env,
      })).toBeUndefined();
    },
  );

  it.runIf(process.platform === 'win32')(
    'surfaces legacy ACL recovery guidance through a required workspace shell',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(
        path.join(poisonDirectory, 'legacy-owner.json'),
        JSON.stringify({ version: 1 }),
        'utf8',
      );
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shell-legacy-poison-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });

      await expect(sandbox.prepare({
        toolCallId: 'bash-legacy-acl-poison',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      })).resolves.toBeUndefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'surfaces a corrupt ACL marker through a required workspace shell',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      await mkdir(poisonDirectory, { recursive: true });
      await writeFile(path.join(poisonDirectory, 'corrupt-owner.json'), '{', 'utf8');
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shell-corrupt-poison-'));
      tempRoots.push(root);
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => true,
      });

      await expect(sandbox.prepare({
        toolCallId: 'bash-corrupt-acl-poison',
        toolInput: { command: 'node --version' },
        command: 'node --version',
        executable: process.execPath,
        args: ['--version'],
        cwd: root,
        env: process.env,
      })).resolves.toBeUndefined();
      expect(capturedWorkspaceSessionConfigs).toHaveLength(0);
    },
  );

  it.runIf(process.platform === 'win32')(
    'surfaces a corrupt ACL marker created during owner admission',
    async () => {
      const poisonDirectory = path.join(
        path.resolve(process.env.KODAX_HOME!),
        'sandbox-runtime',
        'acl-poison',
      );
      recoveryLockMock.beforeOperation = async () => {
        recoveryLockMock.beforeOperation = undefined;
        await mkdir(poisonDirectory, { recursive: true });
        await writeFile(path.join(poisonDirectory, 'concurrent-corrupt-owner.json'), '{', 'utf8');
      };
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-concurrent-corrupt-'));
      tempRoots.push(root);

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: { allowRead: [], allowWrite: [] },
      })).rejects.toThrow('temporarily unreadable');
      expect(capturedBrokerRequests).toHaveLength(0);
    },
  );

  it('runs a standalone SDK command with the caller-owned containment policy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-sandbox-'));
    tempRoots.push(root);
    await mkdir(path.join(root, 'output', 'protected'), { recursive: true });
    await doctorSandboxRuntime({ refresh: true });

    await expect(runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      filesystem: {
        allowRead: ['input'],
        allowWrite: ['output'],
        denyRead: [path.join(os.homedir(), '.ssh')],
        denyWrite: ['output/protected'],
      },
      network: {
        mode: 'allowlist',
        origins: ['https://api.example.com'],
      },
      env: {
        KODAX_SDK_SANDBOX_TEST: '1',
        ...(process.platform === 'win32' ? { Path: 'sdk-command-path' } : {}),
      },
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    })).resolves.toEqual({
      status: 'completed',
      sandboxed: true,
      exitCode: 0,
      stdout: 'sandbox output',
      stderr: '',
    });

    const request = capturedBrokerRequests.at(-1) as {
      readonly config: {
        readonly filesystem: {
          readonly allowRead: readonly string[];
          readonly allowWrite: readonly string[];
          readonly denyRead: readonly string[];
          readonly denyWrite: readonly string[];
        };
        readonly network: { readonly strictAllowlist: boolean };
        readonly windows?: {
          readonly srtWin?: { readonly path?: string };
        };
      };
      readonly endpoints: ReadonlyArray<{ readonly host: string; readonly port: number }>;
      readonly env: Readonly<Record<string, string>>;
      readonly allowAllNetwork?: boolean;
    };
    const protectedRunnerDirectory = request.config.filesystem.allowRead.find(
      (entry) => entry.includes(path.join('sandbox-runtime', 'runner')),
    );
    expect(request.config.filesystem.allowRead).toContain(path.join(root, 'input'));
    expect(request.config.filesystem.allowWrite).toEqual([path.join(root, 'output')]);
    if (process.platform === 'win32') {
      expect(request.config.filesystem.denyRead).toEqual([]);
      expect(request.config.filesystem.denyWrite).toEqual([
        path.join(root, 'output', 'protected'),
      ]);
      expect(protectedRunnerDirectory).toBeDefined();
      expect(request.config.windows?.srtWin?.path).toBe(
        path.join(protectedRunnerDirectory!, 'srt-win.exe'),
      );
      expect(capturedSpawnCwds).toContain(protectedRunnerDirectory);
      const guardedPaths = capturedSyncSpawns.flatMap((call) => {
        const encodedIndex = call.args.indexOf('-EncodedCommand');
        if (encodedIndex < 0) return [];
        const script = Buffer.from(call.args[encodedIndex + 1] ?? '', 'base64')
          .toString('utf16le');
        if (!script.includes('KodaXAsrtAclGuard-v1') || !call.input) return [];
        return (JSON.parse(call.input) as {
          readonly paths: readonly { readonly path: string }[];
        }).paths.map((entry) => entry.path);
      });
      expect(guardedPaths).toContain(path.join(os.homedir(), '.ssh'));
      expect(guardedPaths).not.toContain(path.join(root, 'output', 'protected'));
    } else {
      expect(request.config.filesystem.denyRead).toContain(path.join(os.homedir(), '.ssh'));
      expect(request.config.filesystem.denyWrite).toContain(
        path.join(root, 'output', 'protected'),
      );
      expect(protectedRunnerDirectory).toBeUndefined();
      expect(request.config.windows).toBeUndefined();
    }
    expect(request.config.network.strictAllowlist).toBe(false);
    expect(request.endpoints).toEqual([{ host: 'api.example.com', port: 443 }]);
    expect(request.allowAllNetwork).toBe(false);
    expect(request.env.KODAX_SDK_SANDBOX_TEST).toBe('1');
    if (process.platform === 'win32') {
      const environmentNames = Object.keys(request.env).map((name) => name.toLowerCase());
      expect(new Set(environmentNames).size).toBe(environmentNames.length);
      expect(Object.entries(request.env).filter(([name]) => name.toLowerCase() === 'path'))
        .toEqual([['Path', 'sdk-command-path']]);
    }
  });

  it('fails a standalone SDK run when sandbox target launch is not attested', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-sandbox-unattested-'));
    tempRoots.push(root);
    await doctorSandboxRuntime({ refresh: true });
    sandboxWrapper.mode = 'missing';

    await expect(runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      filesystem: { allowRead: [], allowWrite: [] },
    })).resolves.toMatchObject({
      status: 'completed',
      sandboxed: true,
      exitCode: 1,
    });
  });

  it('keeps the Windows ASRT state location in the isolated broker environment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-state-env-'));
    tempRoots.push(root);
    const original = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local';
    try {
      await doctorSandboxRuntime({ refresh: true });
      await runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        filesystem: {
          allowRead: [root, process.execPath],
          allowWrite: [os.tmpdir()],
        },
      });

      expect(capturedSpawnEnvironments.at(-1)?.LOCALAPPDATA)
        .toBe('C:\\Users\\tester\\AppData\\Local');
    } finally {
      if (original === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = original;
    }
  });

  it('keeps the broker request alive until a delayed broker reads it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-deferred-read-'));
    tempRoots.push(root);
    deferredBrokerRead.enabled = true;

    await expect(runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      filesystem: {
        allowRead: [root, process.execPath],
        allowWrite: [os.tmpdir()],
      },
    })).resolves.toMatchObject({
      status: 'completed',
      sandboxed: true,
      exitCode: 0,
    });

    expect(deferredBrokerRead.missing).toBe(false);
    expect(capturedBrokerRequests).toHaveLength(1);
  });

  it('leaves non-admitted shell calls on the existing permission path', async () => {
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: process.cwd(),
      shouldSandbox: () => false,
    });
    const reportObservation = vi.fn();
    await expect(sandbox.prepare({
      toolCallId: 'bash-2',
      toolInput: { command: 'echo ok' },
      command: 'echo ok',
      cwd: process.cwd(),
      env: process.env,
      reportObservation,
    })).resolves.toBeUndefined();
    expect(reportObservation).toHaveBeenCalledWith({
      version: 1,
      state: 'not_selected',
    });
  });
});

interface BrokerGitHelpers {
  readonly rewriteWindowsGitSafeDirectoryArgv: (
    argv: readonly string[],
    trustRoots: readonly string[],
  ) => string[];
  readonly windowsGitTrustRoots: (input: {
    readonly cwd?: string;
    readonly config: {
      readonly filesystem: {
        readonly allowWrite?: readonly string[];
        readonly allowRead?: readonly string[];
      };
    };
  }) => string[];
}

async function buildMinifiedWindowsGitBrokerHelpers(): Promise<BrokerGitHelpers> {
  const moduleUrl = new URL('./windows-git-sandbox.ts', import.meta.url);
  const result = await build({
    stdin: {
      contents: readFileSync(moduleUrl, 'utf8'),
      loader: 'ts',
      resolveDir: path.dirname(fileURLToPath(moduleUrl)),
      sourcefile: 'windows-git-sandbox.ts',
    },
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    minify: true,
    keepNames: true,
    write: false,
    logLevel: 'silent',
  });
  const bundledModule: { exports: unknown } = { exports: {} };
  Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    createRequire(import.meta.url),
    bundledModule,
    bundledModule.exports,
  );
  const api = bundledModule.exports as { windowsGitBrokerHelpersSource: () => string };
  const helperSource = api.windowsGitBrokerHelpersSource();
  return Function(
    'realpathSync',
    'statSync',
    'path',
    `${helperSource}\nreturn { windowsGitTrustRoots, rewriteWindowsGitSafeDirectoryArgv };`,
  )(realpathSync, statSync, path) as BrokerGitHelpers;
}

async function capturedSandboxReadRoots(
  workspaceRoot: string,
  toolCallId: string,
): Promise<readonly string[]> {
  const prepared = await createAsrtShellSandbox({
    workspaceRoot,
    shouldSandbox: () => true,
  }).prepare({
    toolCallId,
    toolInput: { command: 'git status' },
    command: 'git status',
    cwd: workspaceRoot,
    env: { PATH: process.env.PATH },
  });
  if (!prepared) throw new Error('expected a sandbox invocation');
  try {
    const config = capturedWorkspaceSessionConfigs.at(-1) as {
      readonly filesystem: { readonly allowRead: readonly string[] };
    };
    return config.filesystem.allowRead;
  } finally {
    await prepared.cleanup();
  }
}

describe('Windows git safe.directory argv takeover', () => {
  const envAssignments = (result: readonly string[]): string[] => {
    const assignments: string[] = [];
    for (let index = 0; index < result.length; index += 1) {
      if (result[index] === '--env' && index + 1 < result.length) {
        assignments.push(result[index + 1]!);
      }
    }
    return assignments;
  };

  it.runIf(process.platform === 'win32')(
    'derives bounded trust roots from the cwd, write roots, and repo-bearing read roots',
    async () => {
      const base = await mkdtemp(path.join(os.tmpdir(), 'kodax-git-trust-'));
      tempRoots.push(base);
      const repo = path.join(base, 'repo');
      const plain = path.join(base, 'plain');
      const missing = path.join(base, 'missing');
      await mkdir(repo);
      await mkdir(path.join(repo, '.git'));
      await mkdir(plain);
      const expected = realpathSync(repo).replaceAll('\\', '/').replace(/\/+$/, '');
      expect(windowsGitTrustRoots(repo, [repo, missing], [plain, repo])).toEqual([expected]);
      const many: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        const root = path.join(base, `root-${index}`);
        await mkdir(root);
        many.push(root);
      }
      expect(windowsGitTrustRoots(undefined, many, [])).toHaveLength(8);
      expect(windowsGitTrustRoots(plain, many, [repo])).toContain(expected);
    },
  );

  it('rewrites the ASRT directory collapse to exact authorized roots', () => {
    const argv = [
      'wrapper.exe', 'exec', '--quiet',
      '--env', 'Path=wrapper-path',
      '--env', 'GIT_CONFIG_COUNT=2',
      '--env', 'GIT_CONFIG_KEY_0=safe.directory',
      '--env', 'GIT_CONFIG_VALUE_0=*',
      '--env', 'GIT_CONFIG_KEY_1=http.schannelUseSSLCAInfo',
      '--env', 'GIT_CONFIG_VALUE_1=0',
      '--', 'git.exe', 'status',
    ];
    const rewritten = rewriteWindowsGitSafeDirectoryArgv(argv, ['C:/ws/main', 'C:/ws/other']);
    expect(envAssignments(rewritten)).toEqual([
      'Path=wrapper-path',
      'GIT_CONFIG_KEY_0=safe.directory',
      'GIT_CONFIG_VALUE_0=C:/ws/main',
      'GIT_CONFIG_KEY_1=safe.directory',
      'GIT_CONFIG_VALUE_1=C:/ws/main/*',
      'GIT_CONFIG_KEY_2=safe.directory',
      'GIT_CONFIG_VALUE_2=C:/ws/other',
      'GIT_CONFIG_KEY_3=safe.directory',
      'GIT_CONFIG_VALUE_3=C:/ws/other/*',
      'GIT_CONFIG_KEY_4=http.schannelUseSSLCAInfo',
      'GIT_CONFIG_VALUE_4=0',
      'GIT_CONFIG_COUNT=5',
    ]);
    expect(rewritten.slice(rewritten.lastIndexOf('--'))).toEqual(['--', 'git.exe', 'status']);
  });

  it('appends the trust set when the vendored ASRT emitted no git env', () => {
    const argv = [
      'wrapper.exe', 'exec', '--quiet',
      '--env', 'Path=wrapper-path',
      '--', 'git.exe', 'status',
    ];
    const rewritten = rewriteWindowsGitSafeDirectoryArgv(argv, ['C:/ws/main']);
    const separator = rewritten.lastIndexOf('--');
    expect(rewritten.slice(0, separator)).toEqual([
      'wrapper.exe', 'exec', '--quiet',
      '--env', 'Path=wrapper-path',
      '--env', 'GIT_CONFIG_KEY_0=safe.directory',
      '--env', 'GIT_CONFIG_VALUE_0=C:/ws/main',
      '--env', 'GIT_CONFIG_KEY_1=safe.directory',
      '--env', 'GIT_CONFIG_VALUE_1=C:/ws/main/*',
      '--env', 'GIT_CONFIG_COUNT=2',
    ]);
    expect(rewritten.slice(separator)).toEqual(['--', 'git.exe', 'status']);
  });

  it('removes ASRT wildcard trust when no authorized root survives', () => {
    const argv = [
      'wrapper.exe',
      '--env', 'GIT_CONFIG_COUNT=2',
      '--env', 'GIT_CONFIG_KEY_0=safe.directory',
      '--env', 'GIT_CONFIG_VALUE_0=*',
      '--env', 'GIT_CONFIG_KEY_1=http.schannelUseSSLCAInfo',
      '--env', 'GIT_CONFIG_VALUE_1=0',
      '--', 'git.exe', 'status',
    ];

    expect(envAssignments(withWindowsSandboxChildEnvironment(argv, {}, []))).toEqual([
      'GIT_CONFIG_KEY_0=http.schannelUseSSLCAInfo',
      'GIT_CONFIG_VALUE_0=0',
      'GIT_CONFIG_COUNT=1',
    ]);
  });

  it('fails closed on unexpected ASRT git env shapes', () => {
    const incomplete = [
      'wrapper.exe',
      '--env', 'GIT_CONFIG_COUNT=2',
      '--env', 'GIT_CONFIG_KEY_0=safe.directory',
      '--env', 'GIT_CONFIG_VALUE_0=*',
      '--', 'git.exe',
    ];
    expect(() => withWindowsSandboxChildEnvironment(incomplete, {}, ['C:/ws']))
      .toThrow('unexpected shape');
    const duplicatedCount = [
      'wrapper.exe',
      '--env', 'GIT_CONFIG_COUNT=1',
      '--env', 'GIT_CONFIG_COUNT=1',
      '--', 'git.exe',
    ];
    expect(() => withWindowsSandboxChildEnvironment(duplicatedCount, {}, ['C:/ws']))
      .toThrow('unexpected shape');
  });

  it('ignores git env names on the child side of the separator', () => {
    const argv = [
      'wrapper.exe',
      '--env', 'Path=wrapper-path',
      '--', 'child.exe',
      '--env', 'GIT_CONFIG_COUNT=9',
      '--env', 'GIT_CONFIG_VALUE_0=child-owned',
    ];
    const rewritten = rewriteWindowsGitSafeDirectoryArgv(argv, ['C:/ws']);
    const separator = rewritten.lastIndexOf('--');
    expect(rewritten.slice(separator)).toEqual(argv.slice(argv.lastIndexOf('--')));
    expect(envAssignments(rewritten.slice(0, separator))).toContain('GIT_CONFIG_COUNT=2');
  });

  it('injects the trust set through the wrapper environment path', () => {
    const wrapped = [
      process.execPath, 'exec', '--quiet',
      '--env', 'Path=wrapper-path',
      '--env', 'PATHEXT=.EXE',
      '--env', 'WRAPPED_ONLY=yes',
      '--', process.execPath, '-e', 'code',
    ];
    const result = withWindowsSandboxChildEnvironment(wrapped, {
      USERPROFILE: 'C:/Users/admin',
      PATHEXT: '.COM',
    }, ['C:/ws/main']);
    const assignments = envAssignments(result);
    expect(assignments).toContain('USERPROFILE=C:/Users/admin');
    expect(assignments).toContain('PATHEXT=.COM');
    expect(assignments).toContain('WRAPPED_ONLY=yes');
    expect(assignments).toContain('GIT_CONFIG_VALUE_0=C:/ws/main');
    expect(assignments).toContain('GIT_CONFIG_VALUE_1=C:/ws/main/*');
    expect(result.slice(result.lastIndexOf('--'))).toEqual(['--', process.execPath, '-e', 'code']);
  });

  it.runIf(process.platform === 'win32')(
    'grants a linked worktree read access to the main .git and denies gitfile edits',
    async () => {
      const base = await mkdtemp(path.join(os.tmpdir(), 'kodax-git-worktree-'));
      tempRoots.push(base);
      const mainRepo = path.join(base, 'main-repo');
      const worktree = path.join(base, 'linked-wt');
      const mainGit = path.join(mainRepo, '.git');
      await mkdir(path.join(mainGit, 'worktrees', 'linked-wt'), { recursive: true });
      await writeFile(path.join(mainGit, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await mkdir(worktree);
      const gitfile = path.join(worktree, '.git');
      await writeFile(gitfile, `gitdir: ${mainGit}\\worktrees\\linked-wt\n`, 'utf8');
      await writeFile(
        path.join(mainGit, 'worktrees', 'linked-wt', 'gitdir'),
        `${gitfile}\n`,
        'utf8',
      );
      await writeFile(
        path.join(mainGit, 'worktrees', 'linked-wt', 'commondir'),
        '../..\n',
        'utf8',
      );
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: worktree,
        shouldSandbox: () => true,
      });
      const hostileWorkspace = path.join(base, 'hostile-wt');
      const innocentDirectory = path.join(base, 'innocent-dir');
      await mkdir(innocentDirectory);
      await mkdir(hostileWorkspace);
      await writeFile(
        path.join(hostileWorkspace, '.git'),
        `gitdir: ${innocentDirectory}\n`,
        'utf8',
      );
      const prepared = await sandbox.prepare({
        toolCallId: 'linked-worktree-git',
        toolInput: { command: 'git status' },
        command: 'git status',
        cwd: worktree,
        env: { PATH: process.env.PATH },
      });
      if (!prepared) throw new Error('expected a linked-workspace invocation');
      try {
        expect(capturedWorkspaceSessionConfigs).toHaveLength(1);
        const config = capturedWorkspaceSessionConfigs[0] as {
          readonly filesystem: {
            readonly allowRead: readonly string[];
            readonly denyWrite: readonly string[];
          };
        };
        expect(config.filesystem.allowRead).toContain(path.resolve(mainGit));
        expect(config.filesystem.denyWrite).toContain(path.resolve(gitfile));
        expect(windowsGitTrustRoots(
          worktree,
          [worktree],
          config.filesystem.allowRead,
        )).toContain(realpathSync(mainGit).replaceAll('\\', '/'));
      } finally {
        await prepared.cleanup();
      }
      const hostileSandbox = createAsrtShellSandbox({
        workspaceRoot: hostileWorkspace,
        shouldSandbox: () => true,
      });
      const hostilePrepared = await hostileSandbox.prepare({
        toolCallId: 'hostile-gitfile-rejected',
        toolInput: { command: 'git status' },
        command: 'git status',
        cwd: hostileWorkspace,
        env: { PATH: process.env.PATH },
      });
      if (!hostilePrepared) throw new Error('expected a hostile-workspace invocation');
      try {
        const hostileConfig = capturedWorkspaceSessionConfigs.at(-1) as {
          readonly filesystem: {
            readonly allowRead: readonly string[];
          };
        };
        expect(hostileConfig.filesystem.allowRead).not.toContain(
          path.resolve(innocentDirectory),
        );
      } finally {
        await hostilePrepared.cleanup();
      }

      const foreignRepo = path.join(base, 'foreign-repo');
      const foreignGit = path.join(foreignRepo, '.git');
      const forgedWorkspace = path.join(base, 'forged-wt');
      await mkdir(foreignGit, { recursive: true });
      await writeFile(path.join(foreignGit, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await mkdir(forgedWorkspace);
      await writeFile(path.join(forgedWorkspace, '.git'), `gitdir: ${foreignGit}\n`, 'utf8');
      const forgedSandbox = createAsrtShellSandbox({
        workspaceRoot: forgedWorkspace,
        shouldSandbox: () => true,
      });
      const forgedPrepared = await forgedSandbox.prepare({
        toolCallId: 'foreign-real-gitdir-rejected',
        toolInput: { command: 'git status' },
        command: 'git status',
        cwd: forgedWorkspace,
        env: { PATH: process.env.PATH },
      });
      if (!forgedPrepared) throw new Error('expected a forged-workspace invocation');
      try {
        const forgedConfig = capturedWorkspaceSessionConfigs.at(-1) as {
          readonly filesystem: { readonly allowRead: readonly string[] };
        };
        expect(forgedConfig.filesystem.allowRead).not.toContain(path.resolve(foreignGit));
      } finally {
        await forgedPrepared.cleanup();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'bounds linked-worktree relationship metadata before granting main .git access',
    async () => {
      const base = await mkdtemp(path.join(os.tmpdir(), 'kodax-git-metadata-bound-'));
      tempRoots.push(base);
      const mainGit = path.join(base, 'main', '.git');
      const workspace = path.join(base, 'linked');
      const linkedGit = path.join(mainGit, 'worktrees', 'linked');
      const gitfile = path.join(workspace, '.git');
      const commondir = path.join(linkedGit, 'commondir');
      const backlink = path.join(linkedGit, 'gitdir');
      await mkdir(linkedGit, { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(path.join(mainGit, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await writeFile(gitfile, `gitdir: ${linkedGit}\n`, 'utf8');
      await writeFile(commondir, `${'x'.repeat(4_097)}\n`, 'utf8');
      await writeFile(backlink, `${gitfile}\n`, 'utf8');
      boundedMetadataReadMock.trackedPaths.add(path.resolve(gitfile));
      boundedMetadataReadMock.trackedPaths.add(path.resolve(commondir));
      boundedMetadataReadMock.trackedPaths.add(path.resolve(backlink));

      const readRoots = await capturedSandboxReadRoots(workspace, 'oversized-linked-metadata');

      expect(readRoots).not.toContain(path.resolve(mainGit));
      expect(boundedMetadataReadMock.fullReads).toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'binds nested submodule metadata through its core.worktree backlink',
    async () => {
      const base = await mkdtemp(path.join(os.tmpdir(), 'kodax-nested-submodule-'));
      tempRoots.push(base);
      const superproject = path.join(base, 'super');
      const workspace = path.join(superproject, 'A', 'B');
      const forgedWorkspace = path.join(superproject, 'A', 'modules', 'B');
      const gitdir = path.join(superproject, '.git', 'modules', 'A', 'modules', 'B');
      await mkdir(workspace, { recursive: true });
      await mkdir(forgedWorkspace, { recursive: true });
      await mkdir(gitdir, { recursive: true });
      await writeFile(path.join(gitdir, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await writeFile(
        path.join(gitdir, 'config'),
        `[core]\n\tworktree = ${path.relative(gitdir, workspace)}\n`,
        'utf8',
      );
      await writeFile(path.join(workspace, '.git'), `gitdir: ${gitdir}\n`, 'utf8');
      await writeFile(path.join(forgedWorkspace, '.git'), `gitdir: ${gitdir}\n`, 'utf8');

      expect(await capturedSandboxReadRoots(workspace, 'nested-submodule-valid'))
        .toContain(path.resolve(gitdir));
      expect(await capturedSandboxReadRoots(forgedWorkspace, 'nested-submodule-forged'))
        .not.toContain(path.resolve(gitdir));
    },
  );

  it('reports the v5 capability with automatic drain and same-boot ACL recovery', () => {
    const capability = sandboxRuntimeCapability();
    expect(capability.version).toBe(5);
    expect(capability.gitSafeDirectory).toBe('authorized-repo-roots');
    expect(capability.delayedEffectDrainRecovery).toBe('automatic');
    expect(capability.sameBootAclRecovery).toBe('sandbox-user-process-probe');
    expect(capability.controls).toEqual([
      'filesystem', 'network', 'environment', 'timeout', 'output',
    ]);
  });

  it('executes the broker helpers after the production minify settings', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'kodax-git-broker-minify-'));
    tempRoots.push(base);
    const cwd = path.join(base, 'cwd');
    const repo = path.join(base, 'review-repo');
    await mkdir(cwd);
    await mkdir(path.join(repo, '.git'), { recursive: true });
    const writes: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const root = path.join(base, `write-${index}`);
      await mkdir(root);
      writes.push(root);
    }
    const broker = await buildMinifiedWindowsGitBrokerHelpers();
    expect(broker.windowsGitTrustRoots({
      cwd,
      config: { filesystem: { allowWrite: writes, allowRead: [repo] } },
    })).toEqual(windowsGitTrustRoots(cwd, writes, [repo]));
    const wildcard = ['wrapper', '--env', 'GIT_CONFIG_COUNT=1',
      '--env', 'GIT_CONFIG_KEY_0=safe.directory', '--env', 'GIT_CONFIG_VALUE_0=*',
      '--', 'git.exe'];
    expect(broker.rewriteWindowsGitSafeDirectoryArgv(wildcard, []))
      .toEqual(rewriteWindowsGitSafeDirectoryArgv(wildcard, []));
    expect(() => broker.rewriteWindowsGitSafeDirectoryArgv([
      'wrapper', '--env', 'GIT_CONFIG_COUNT=1', '--', 'git.exe',
    ], [])).toThrow('unexpected shape');
  });
});

describe('ASRT setup guidance', () => {
  it.each([
    ['win32', 'UAC'],
    ['darwin', 'brew install ripgrep'],
    ['linux', 'apt install bubblewrap socat ripgrep'],
  ] as const)('provides actionable %s activation guidance', (platform, expected) => {
    const lines = sandboxSetupGuidance({
      ready: false,
      platform,
      version: KODAX_ASRT_VERSION,
      diagnostics: ['missing dependency'],
      setupRequired: true,
    });
    expect(lines.join('\n')).toContain(expected);
  });
});

describe('ASRT Skill-script adapter', () => {
  it.runIf(process.platform === 'win32')(
    'stages a user-installed Windows runner in a protected KodaX directory',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-global-npm-'));
      tempRoots.push(root);
      const source = path.join(root, 'npm', 'node_modules', 'kodax', 'srt-win.exe');
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, 'trusted-runner', 'utf8');
      windowsSandboxMock.runnerSource = source;
      const relativeAgentHome = path.relative(process.cwd(), path.join(root, '.kodax'));
      vi.stubEnv('KODAX_HOME', relativeAgentHome);

      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: true,
        setupRequired: false,
      });

      const grant = windowsSandboxMock.grants.at(-1) as {
        readonly read: readonly string[];
        readonly write: readonly string[];
        readonly sandboxUserSid: string;
      };
      const stagedDirectory = grant.read[0]!;
      const stagedRunner = path.join(stagedDirectory, 'srt-win.exe');
      expect(path.isAbsolute(stagedDirectory)).toBe(true);
      expect(stagedDirectory).toContain(path.resolve(relativeAgentHome));
      expect(stagedDirectory).toContain(path.join('.kodax', 'sandbox-runtime', 'runner'));
      expect(stagedRunner).not.toBe(source);
      await expect(readFile(stagedRunner, 'utf8')).resolves.toBe('trusted-runner');
      expect(grant.read).toContain(stagedRunner);
      expect(grant.write).toEqual([]);
      expect(grant.sandboxUserSid).toBe(windowsSandboxMock.user.sid);
      expect(capturedSyncSpawns).toContainEqual(expect.objectContaining({
        command: stagedRunner,
        cwd: stagedDirectory,
      }));
      await doctorSandboxRuntime({ refresh: true });
      expect(windowsSandboxMock.grants).toHaveLength(1);
      await resetAsrtWorkspaceSessionsForTest();
      expect(windowsSandboxMock.revokes).toHaveLength(1);
    },
  );

  it.runIf(process.platform === 'win32')(
    'uses the staged runner instead of ASRT packaged-binary dependency probes',
    async () => {
      const asrt = await import('@anthropic-ai/sandbox-runtime');
      vi.mocked(asrt.SandboxManager.checkDependencies).mockReturnValueOnce({
        errors: [
          'srt-win user status failed: spawnSync C:\\packaged\\app.asar\\vendor\\srt-win.exe ENOENT',
        ],
        warnings: [],
      });

      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: true,
        setupRequired: false,
        diagnostics: [],
      });
      expect(windowsSandboxMock.grants).toHaveLength(1);
      expect(capturedSyncSpawns.some(({ command, args }) => (
        command.includes(path.join('sandbox-runtime', 'runner'))
        && args.includes('wfp')
        && args.includes('verify')
      ))).toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    'fails closed quickly when persistent ACL guards require explicit setup',
    async () => {
      windowsSandboxMock.guardReady = false;

      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: false,
        setupRequired: true,
        diagnostics: expect.arrayContaining([
          expect.stringContaining('[acl_guards_missing]'),
        ]),
      });
      const guardPayloads = capturedSyncSpawns.flatMap((call) => {
        const encodedIndex = call.args.indexOf('-EncodedCommand');
        if (encodedIndex < 0 || !call.input) return [];
        const script = Buffer.from(call.args[encodedIndex + 1] ?? '', 'base64')
          .toString('utf16le');
        return script.includes('KodaXAsrtAclGuard-v1')
          ? [JSON.parse(call.input) as { readonly install: boolean }]
          : [];
      });
      expect(guardPayloads).toEqual([expect.objectContaining({ install: false })]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'uses PowerShell 7 for Windows ACL guards when it is installed',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-pwsh-acl-'));
      tempRoots.push(root);
      const pwsh = path.join(root, 'PowerShell', '7', 'pwsh.exe');
      await mkdir(path.dirname(pwsh), { recursive: true });
      await writeFile(pwsh, '', 'utf8');
      const original = process.env.ProgramFiles;
      process.env.ProgramFiles = root;
      try {
        await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
          ready: true,
          setupRequired: false,
        });
        expect(capturedSyncSpawns.some(({ command, args }) => (
          command === pwsh && args.includes('-EncodedCommand')
        ))).toBe(true);
      } finally {
        if (original === undefined) delete process.env.ProgramFiles;
        else process.env.ProgramFiles = original;
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'reports an incomplete Windows account before attempting the WFP runner',
    async () => {
      windowsSandboxMock.user.inBuiltinUsers = false;

      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: false,
        setupRequired: true,
        diagnostics: expect.arrayContaining([
          expect.stringMatching(/built-in Users group/i),
        ]),
      });
      expect(windowsSandboxMock.grants).toHaveLength(0);
      expect(capturedSyncSpawns.some(({ args }) => (
        args.includes('wfp') && args.includes('verify')
      ))).toBe(false);
    },
  );

  it.runIf(process.platform === 'win32')(
    'distinguishes a Windows runner access failure from account and WFP policy failures',
    async () => {
      windowsSandboxMock.wfpOutcome = 'access_denied';

      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: false,
        setupRequired: true,
        diagnostics: expect.arrayContaining([
          expect.stringContaining('[runner_launch_access_denied]'),
        ]),
      });
      expect(windowsSandboxMock.grants).toHaveLength(1);
      const probe = capturedSyncSpawns.find(({ args }) => (
        args.includes('wfp') && args.includes('verify')
      ));
      expect(probe?.cwd).toContain(path.join('sandbox-runtime', 'runner'));
    },
  );

  it.runIf(process.platform === 'win32')(
    'reports a bounded Windows WFP verification timeout distinctly',
    async () => {
      windowsSandboxMock.wfpOutcome = 'timeout';

      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: false,
        setupRequired: true,
        diagnostics: expect.arrayContaining([
          expect.stringContaining('[wfp_probe_timeout]'),
        ]),
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'revokes a partial Windows runner ACL grant before a bounded retry',
    async () => {
      windowsSandboxMock.grantFailure = 'partial ACL grant failed';

      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: false,
        setupRequired: true,
        diagnostics: expect.arrayContaining([
          expect.stringContaining('partial ACL grant failed'),
        ]),
      });
      expect(windowsSandboxMock.grants).toHaveLength(1);
      expect(windowsSandboxMock.revokes).toHaveLength(1);

      windowsSandboxMock.grantFailure = undefined;
      await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
        ready: true,
        setupRequired: false,
      });
      expect(windowsSandboxMock.grants).toHaveLength(2);
      await resetAsrtWorkspaceSessionsForTest();
      expect(windowsSandboxMock.revokes).toHaveLength(2);
    },
  );

  it('checks the exact installed version and required JavaScript interpreter', async () => {
    await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
      ready: true,
      version: KODAX_ASRT_VERSION,
      setupRequired: false,
    });
  });

  it('fails closed when configuration admits a script absent from the pinned Skill snapshot', async () => {
    const registry = await createRegistry();
    const snapshotRoot = path.join(tempRoots[0]!, 'snapshots');

    await expect(createAsrtSkillScriptRunner({
      registry,
      admissions: { demo: ['scripts/missing.mjs'] },
      snapshotRoot,
      workspaceAccess: 'none',
      network: { mode: 'deny' },
    })).rejects.toThrow(/has no script/i);
    await expect(readdir(snapshotRoot)).resolves.toEqual([]);
  });

  it('rejects call-time scripts outside the exact prepared admission', async () => {
    const registry = await createRegistry();
    const snapshotRoot = path.join(tempRoots[0]!, 'snapshots');
    const runner = await createAsrtSkillScriptRunner({
      registry,
      admissions: { demo: ['scripts/hello.mjs'] },
      snapshotRoot,
      workspaceAccess: 'none',
      network: { mode: 'deny' },
    });
    try {
      await expect(runner.run({
        skill: 'demo', script: 'scripts/other.mjs', args: [], inputs: [], outputs: [],
      }, {
        workspaceRoot: tempRoots[0]!,
      })).rejects.toThrow(/not admitted/i);
    } finally {
      await runner.dispose();
    }
  });

  it('runs one exact admission with a clean broker contract and promotes declared output', async () => {
    const registry = await createRegistry();
    const root = tempRoots[0]!;
    const runner = await createAsrtSkillScriptRunner({
      registry,
      admissions: { demo: ['scripts/hello.mjs'] },
      snapshotRoot: path.join(root, 'snapshots'),
      workspaceAccess: 'write',
      network: { mode: 'allowlist', origins: ['https://reports.example.com'] },
    });
    try {
      await expect(runner.run({
        skill: 'demo', script: 'scripts/hello.mjs', args: [], inputs: [],
        outputs: [{ path: 'report.txt', target: 'result/report.txt' }],
      }, { workspaceRoot: root })).resolves.toBe(JSON.stringify({
        stdout: 'sandbox output', outputs: [path.join('result', 'report.txt')],
      }));
      expect(readFileSync(path.join(root, 'result', 'report.txt'), 'utf8')).toBe('report');
      const request = capturedBrokerRequests.at(-1) as {
        readonly config: {
          readonly filesystem: {
            readonly allowRead: readonly string[];
            readonly denyWrite: readonly string[];
          };
          readonly windows?: {
            readonly srtWin?: { readonly path?: string };
          };
        };
      };
      const runnerDirectory = request.config.filesystem.allowRead.find(
        (entry) => entry.includes(path.join('sandbox-runtime', 'runner')),
      );
      if (process.platform === 'win32') {
        expect(runnerDirectory).toBeDefined();
        expect(request.config.filesystem.allowRead).toContain(path.dirname(process.execPath));
        expect(request.config.filesystem.denyWrite).toEqual([]);
        expect(request.config.windows?.srtWin?.path).toBe(
          path.join(runnerDirectory!, 'srt-win.exe'),
        );
      } else {
        expect(runnerDirectory).toBeUndefined();
        expect(request.config.windows).toBeUndefined();
      }
    } finally {
      await runner.dispose();
    }
  });

  it('enforces argument, mapping, cancellation, and workspace-access bounds before execution', async () => {
    const registry = await createRegistry();
    const root = tempRoots[0]!;
    const runner = await createAsrtSkillScriptRunner({
      registry,
      admissions: { demo: ['scripts/hello.mjs'] },
      snapshotRoot: path.join(root, 'snapshots'),
      workspaceAccess: 'none',
      network: { mode: 'deny' },
    });
    const base = { skill: 'demo', script: 'scripts/hello.mjs', args: [], inputs: [], outputs: [] };
    try {
      await expect(runner.run({ ...base, args: Array.from({ length: 65 }, () => 'x') }, {
        workspaceRoot: root,
      })).rejects.toThrow(/arguments exceed/i);
      await expect(runner.run({
        ...base, inputs: Array.from({ length: 33 }, (_, index) => ({ path: `input-${index}` })),
      }, { workspaceRoot: root })).rejects.toThrow(/file mappings exceed/i);
      await expect(runner.run({ ...base, inputs: [{ path: 'input.txt' }] }, {
        workspaceRoot: root,
      })).rejects.toThrow(/require workspace read/i);
      const controller = new AbortController();
      controller.abort(new Error('cancelled by caller'));
      await expect(runner.run(base, {
        workspaceRoot: root, signal: controller.signal,
      })).rejects.toThrow(/cancelled by caller/i);
    } finally {
      await runner.dispose();
    }
  });

  it('rejects sensitive, escaping, existing, and over-quota workspace outputs', async () => {
    const registry = await createRegistry();
    const root = tempRoots[0]!;
    const inputPath = path.join(root, 'input.txt');
    await writeFile(inputPath, 'input', 'utf8');
    const runner = await createAsrtSkillScriptRunner({
      registry,
      admissions: { demo: ['scripts/hello.mjs'] },
      snapshotRoot: path.join(root, 'snapshots'),
      workspaceAccess: 'write',
      workspaceByteLimit: 1,
      network: { mode: 'deny' },
    });
    const base = { skill: 'demo', script: 'scripts/hello.mjs', args: [], outputs: [] };
    try {
      await expect(runner.run({ ...base, inputs: [{ path: '../outside.txt' }] }, {
        workspaceRoot: root,
      })).rejects.toThrow(/safe relative path/i);
      await expect(runner.run({ ...base, inputs: [{ path: '.env' }] }, {
        workspaceRoot: root,
      })).rejects.toThrow();
      await expect(runner.run({
        ...base, inputs: [{ path: 'input.txt', as: '../escape.txt' }],
      }, { workspaceRoot: root })).rejects.toThrow(/safe relative path/i);
      await expect(runner.run({
        ...base, inputs: [], outputs: [{ path: 'report.txt', target: 'result/report.txt' }],
      }, { workspaceRoot: root })).rejects.toThrow(/byte quota/i);
    } finally {
      await runner.dispose();
    }
  });

  it('rejects unsafe admission paths and unsupported script types', async () => {
    const registry = await createRegistry('notes.txt');
    const root = tempRoots[0]!;
    await expect(createAsrtSkillScriptRunner({
      registry,
      admissions: { demo: ['../notes.txt'] },
      snapshotRoot: path.join(root, 'bad-snapshots'),
      workspaceAccess: 'none',
      network: { mode: 'deny' },
    })).rejects.toThrow(/safe relative path/i);
    const runner = await createAsrtSkillScriptRunner({
      registry,
      admissions: { demo: ['scripts/notes.txt'] },
      snapshotRoot: path.join(root, 'snapshots'),
      workspaceAccess: 'none',
      network: { mode: 'deny' },
    });
    try {
      await expect(runner.run({
        skill: 'demo', script: 'scripts/notes.txt', args: [], inputs: [], outputs: [],
      }, { workspaceRoot: root })).rejects.toThrow(/unsupported admitted/i);
    } finally {
      await runner.dispose();
    }
  });

  it('runs the standalone broker entry with the same pinned request shape', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-broker-test-'));
    tempRoots.push(root);
    const requestFile = path.join(root, 'request.json');
    const observationFile = path.join(root, 'observation.json');
    const sensitiveRead = path.join(os.homedir(), '.ssh');
    await writeFile(requestFile, JSON.stringify({
      config: {
        network: {
          allowedDomains: [], deniedDomains: [], strictAllowlist: true,
          allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
        },
        filesystem: { denyRead: [sensitiveRead], allowRead: [], allowWrite: [], denyWrite: [] },
      },
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      env: { REPORT_FORMAT: 'pdf' },
      endpoints: [],
      observationBackend: sandboxRuntimeCapability().backend,
      observationFile,
    }), 'utf8');
    await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(0);
    expect(JSON.parse(readFileSync(observationFile, 'utf8'))).toMatchObject({
      state: 'applied',
      backend: sandboxRuntimeCapability().backend,
    });
    if (process.platform === 'win32') {
      const childArgv = capturedSpawnArgv.at(-1) ?? [];
      expect(childArgv).toContain('--env');
      expect(childArgv).toContain('REPORT_FORMAT=pdf');
      expect(capturedSandboxWrapConfigs.at(-1)).toMatchObject({
        filesystem: {
          denyRead: [sensitiveRead],
          allowRead: [],
          allowWrite: [],
        },
      });
    } else {
      expect(capturedSpawnEnvironments.at(-1)).toMatchObject({
        REPORT_FORMAT: 'pdf',
      });
    }
  });

  it('falls back before target launch when the local workspace sandbox backend fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-broker-fallback-'));
    tempRoots.push(root);
    const requestFile = path.join(root, 'request.json');
    const observationFile = path.join(root, 'observation.json');
    await writeFile(requestFile, JSON.stringify({
      config: {
        network: {
          allowedDomains: [], deniedDomains: [], strictAllowlist: false,
          allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
        },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
      },
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      env: { KODAX_FALLBACK_VISIBLE: 'yes' },
      endpoints: [],
      fallbackToNormalExecution: true,
      observationFile,
    }), 'utf8');
    sandboxInitialize.mockRejectedValueOnce(new Error('backend initialization failed'));

    await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(0);
    expect(capturedSpawnArgv.at(-1)).toEqual([process.execPath, '--version']);
    expect(capturedSpawnEnvironments.at(-1)?.KODAX_FALLBACK_VISIBLE).toBe('yes');
    expect(JSON.parse(readFileSync(observationFile, 'utf8'))).toEqual({
      version: 1,
      state: 'fallback',
      reason: 'backend_failed',
      execution: 'normal_permission_policy',
    });
  });

  it(
    'does not replay when a spawned wrapper exits without target attestation',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-attestation-fallback-'));
      tempRoots.push(root);
      const requestFile = path.join(root, 'request.json');
      const observationFile = path.join(root, 'observation.json');
      await writeFile(requestFile, JSON.stringify({
        config: {
          network: {
            allowedDomains: [], deniedDomains: [], strictAllowlist: false,
            allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
          },
          filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
        },
        command: process.execPath,
        args: ['--version'],
        cwd: root,
        env: {},
        endpoints: [],
        fallbackToNormalExecution: true,
        observationFile,
      }), 'utf8');
      sandboxWrapper.mode = 'missing';

      await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(1);
      expect(capturedSpawnArgv.filter(
        (argv) => JSON.stringify(argv) === JSON.stringify([process.execPath, '--version']),
      )).toHaveLength(0);
      await expect(readFile(observationFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('falls back once when the sandbox wrapper is proven not to have spawned', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-wrapper-spawn-fallback-'));
    tempRoots.push(root);
    const requestFile = path.join(root, 'request.json');
    const observationFile = path.join(root, 'observation.json');
    await writeFile(requestFile, JSON.stringify({
      config: {
        network: {
          allowedDomains: [], deniedDomains: [], strictAllowlist: false,
          allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
        },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
      },
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      env: {},
      endpoints: [],
      fallbackToNormalExecution: true,
      observationFile,
    }), 'utf8');
    sandboxWrapper.mode = 'spawn_error';

    await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(0);
    expect(capturedSpawnArgv.filter(
      (argv) => JSON.stringify(argv) === JSON.stringify([process.execPath, '--version']),
    )).toHaveLength(1);
    expect(JSON.parse(readFileSync(observationFile, 'utf8'))).toEqual({
      version: 1,
      state: 'fallback',
      reason: 'backend_failed',
      execution: 'normal_permission_policy',
    });
  });

  it('drains target attestation before deciding whether fallback is safe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-attestation-race-'));
    tempRoots.push(root);
    const requestFile = path.join(root, 'request.json');
    const observationFile = path.join(root, 'observation.json');
    await writeFile(requestFile, JSON.stringify({
      config: {
        network: {
          allowedDomains: [], deniedDomains: [], strictAllowlist: false,
          allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
        },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [root], denyWrite: [] },
      },
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      env: {},
      endpoints: [],
      fallbackToNormalExecution: true,
      observationBackend: sandboxRuntimeCapability().backend,
      observationFile,
    }), 'utf8');
    sandboxWrapper.mode = 'late_marker';

    await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(0);
    expect(capturedSpawnArgv).not.toContainEqual([process.execPath, '--version']);
    expect(JSON.parse(readFileSync(observationFile, 'utf8'))).toMatchObject({
      state: 'applied',
      backend: sandboxRuntimeCapability().backend,
    });
  });

  it('does not re-inject host secrets into a POSIX broker child environment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-broker-env-test-'));
    tempRoots.push(root);
    const requestFile = path.join(root, 'request.json');
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    process.env.KODAX_HOST_ONLY_SECRET = 'must-not-reach-sandbox';
    await writeFile(requestFile, JSON.stringify({
      config: {
        network: {
          allowedDomains: [], deniedDomains: [], strictAllowlist: true,
          allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
        },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      },
      command: '/usr/bin/node',
      args: ['--version'],
      cwd: root,
      env: { KODAX_CHILD_VISIBLE: 'yes' },
      endpoints: [],
    }), 'utf8');
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
      await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(0);
      const childEnvironment = capturedSpawnEnvironments.at(-1);
      expect(childEnvironment?.KODAX_CHILD_VISIBLE).toBe('yes');
      expect(childEnvironment?.KODAX_HOST_ONLY_SECRET).toBeUndefined();
      expect(Object.keys(childEnvironment ?? {})).toEqual(['KODAX_CHILD_VISIBLE']);
    } finally {
      delete process.env.KODAX_HOST_ONLY_SECRET;
      if (platformDescriptor !== undefined) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
    }
  });

  it.runIf(process.platform === 'win32')(
    'keeps Windows command arguments exact behind an encoded argv bootstrap',
    async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-broker-argv-test-'));
    tempRoots.push(root);
    const requestFile = path.join(root, 'request.json');
    const exactArgs = [
      '--probe',
      '%KODAX_ENV_PROBE%',
      'a&b',
      'quoted"value',
      'space separated',
    ];
    await writeFile(requestFile, JSON.stringify({
      config: {
        network: {
          allowedDomains: [], deniedDomains: [], strictAllowlist: true,
          allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
        },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      },
      command: process.execPath,
      args: exactArgs,
      windowsVerbatimArguments: true,
      cwd: root,
      env: { PATH: 'command-path', PATHEXT: '.COM;.EXE;.CMD' },
      endpoints: [],
      bootstrapCommand: process.execPath,
    }), 'utf8');

    await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(0);
    const wrapped = capturedWrappedCommands.at(-1) ?? '';
    const payload = wrapped.trim().split(/\s+/).at(-1);
    if (payload === undefined) throw new Error('expected encoded argv payload');
    expect(JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))).toMatchObject({
      command: process.execPath,
      args: exactArgs,
      windowsVerbatimArguments: true,
      cwd: root,
      targetStartedMarker: expect.stringContaining('KODAX_ASRT_TARGET_STARTED'),
    });
    expect(wrapped).not.toContain('%KODAX_ENV_PROBE%');
    expect(wrapped).not.toContain('a&b');
    const spawned = capturedSpawnArgv.at(-1) ?? [];
    const injectedEnvironment = spawned.flatMap((value, index) => (
      value === '--env' ? [spawned[index + 1] ?? ''] : []
    ));
    expect(injectedEnvironment.filter((value) => /^path=/i.test(value)))
      .toEqual(['PATH=command-path']);
    expect(injectedEnvironment.filter((value) => /^pathext=/i.test(value)))
      .toEqual(['PATHEXT=.COM;.EXE;.CMD']);
    expect(injectedEnvironment).toContain('WRAPPED_ONLY=yes');
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects case-ambiguous Windows child environment names before spawn',
    async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-asrt-broker-env-test-'));
    tempRoots.push(root);
    const requestFile = path.join(root, 'request.json');
    await writeFile(requestFile, JSON.stringify({
      config: {
        network: {
          allowedDomains: [], deniedDomains: [], strictAllowlist: true,
          allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false,
        },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      },
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      env: { PATH: 'first', Path: 'second' },
      endpoints: [],
      bootstrapCommand: process.execPath,
    }), 'utf8');
    const spawnCount = capturedSpawnArgv.length;

    await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(1);
    expect(capturedSpawnArgv).toHaveLength(spawnCount);
    },
  );

  it.each([
    {
      name: 'timeout',
      mode: 'silent' as const,
      options: { timeoutMs: 10 },
      expected: /exceeded its 10 ms timeout/i,
    },
    {
      name: 'output overflow',
      mode: 'overflow' as const,
      options: { maxOutputBytes: 1 },
      expected: /output exceeded 1 bytes/i,
    },
  ])('force-terminates a broker that ignores SIGTERM after $name', async ({
    mode,
    options,
    expected,
  }) => {
    stubbornBroker.mode = mode;
    await expect(runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: os.tmpdir(),
      filesystem: { allowRead: [], allowWrite: [] },
      network: { mode: 'deny' },
      ...options,
    })).rejects.toThrow(expected);
  });

  it('force-terminates a broker that ignores cancellation', async () => {
    stubbornBroker.mode = 'silent';
    const controller = new AbortController();
    const running = runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: os.tmpdir(),
      filesystem: { allowRead: [], allowWrite: [] },
      network: { mode: 'deny' },
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled by SDK caller'));
    await expect(running).rejects.toThrow(/cancelled by SDK caller/i);
  });
});
