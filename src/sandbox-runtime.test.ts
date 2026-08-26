import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
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
import { trustedTextNativeArtifactStateRoots } from './windows-native-artifacts.js';

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
const aclRecoveryGateChildren = vi.hoisted(() => new WeakSet<object>());
const boundedMetadataReadMock = vi.hoisted(() => ({
  trackedPaths: new Set<string>(),
  fullReads: [] as string[],
}));
const processTreeKillMock = vi.hoisted(() => ({
  outcome: 'actual' as 'actual' | 'unknown' | 'close_then_unknown' | 'close_then_reject',
  childPid: undefined as number | undefined,
  releaseUnknown: undefined as (() => void) | undefined,
}));
const windowsEffectJobMock = vi.hoisted(() => ({
  aclRecoveryDrainFailure: undefined as string | undefined,
  containCalls: 0,
  containFailureOnCall: undefined as number | undefined,
  terminateOutcome: 'drained' as 'drained' | 'not_found',
  drainFailure: undefined as string | undefined,
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
  mode: 'attest' as
    | 'attest'
    | 'late_marker'
    | 'missing'
    | 'not_started'
    | 'fallback'
    | 'control_missing'
    | 'control_oversized'
    | 'control_error'
    | 'wrong_invocation'
    | 'spawn_error',
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
  hostUserSid: 'S-1-5-21-9000',
  runnerSource: '',
  nullDeviceReady: true,
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
  uninstallCalls: 0,
  uninstallOptions: [] as Array<Readonly<Record<string, unknown>>>,
  nextInstalledUserSid: undefined as string | undefined,
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
      if (args.length === 1 && args[0] === '__current-user-sid') {
        return {
          status: 0,
          signal: null,
          stdout: `${windowsSandboxMock.hostUserSid}\n`,
          stderr: '',
        };
      }
      if (args.length === 2 && args[0] === '__verify-null-device') {
        return {
          status: windowsSandboxMock.nullDeviceReady ? 0 : 2,
          signal: null,
          stdout: '',
          stderr: windowsSandboxMock.nullDeviceReady ? '' : 'missing exact sandbox-account ACE',
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
            control.end();
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
      const controlledBroker = Array.isArray(argsOrOptions)
        && !standaloneGate
        && (
          argsOrOptions.includes('__asrt-broker')
          || (
            argsOrOptions.includes('--input-type=module')
            && (explicitOptions as { readonly stdio?: readonly string[] } | undefined)
              ?.stdio?.length === 4
          )
        );
      let brokerRequest: Readonly<Record<string, unknown>> | undefined;
      const recordBrokerRequest = (request: Readonly<Record<string, unknown>>): void => {
        brokerRequest = request;
        capturedBrokerRequests.push(request);
        if (
          typeof request.cwd === 'string'
          && path.basename(path.dirname(request.cwd)) === '.kodax-a2a-script'
        ) {
          mkdirSync(path.join(request.cwd, 'outputs'), { recursive: true });
          writeFileSync(path.join(request.cwd, 'outputs', 'report.txt'), 'report');
        }
      };
      const captureRequest = (): void => {
        if (typeof requestFile !== 'string' || !requestFile.endsWith('.json')) return;
        recordBrokerRequest(
          JSON.parse(readFileSync(requestFile, 'utf8')) as Readonly<Record<string, unknown>>,
        );
      };
      const complete = (): void => {
        const writeControl = (observation: Readonly<Record<string, unknown>>): void => {
          if (brokerRequest?.controlInvocationId === undefined) return;
          control.write(`${JSON.stringify({
            version: 1,
            invocationId: sandboxWrapper.mode === 'wrong_invocation'
              ? 'wrong-invocation'
              : brokerRequest.controlInvocationId,
            observation,
          })}\n`);
        };
        if (sandboxWrapper.mode === 'spawn_error') {
          sandboxWrapper.mode = 'attest';
          child.stderr.end('wrapper spawn failed');
          control.end();
          child.emit('error', new Error('wrapper spawn failed'));
          child.emit('close', null, null);
          return;
        }
        child.emit('spawn');
        child.stdout.end('sandbox output');
        if (sandboxWrapper.mode === 'missing') {
          child.stderr.write('sandbox target launch failed before attestation');
        }
        if (sandboxWrapper.mode === 'not_started' && brokerRequest !== undefined) {
          child.stderr.write('sandbox target was proven not to have started');
          writeControl({
            version: 1,
            state: 'not_started',
            diagnostic: 'sandbox target was proven not to have started',
          });
        }
        if (sandboxWrapper.mode === 'fallback') {
          writeControl({
            version: 1,
            state: 'fallback',
            reason: 'backend_failed',
            execution: 'normal_permission_policy',
          });
        }
        if (
          sandboxWrapper.mode === 'attest'
          || sandboxWrapper.mode === 'late_marker'
          || sandboxWrapper.mode === 'wrong_invocation'
          || sandboxWrapper.mode === 'control_missing'
        ) {
          if (sandboxWrapper.mode !== 'control_missing') {
            writeControl({
              version: 1,
              state: 'applied',
              backend: brokerRequest?.observationBackend ?? 'unsupported',
              policyId: 'kodax-workspace-shell-v1',
            });
          }
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
        if (sandboxWrapper.mode === 'control_oversized') {
          control.write(Buffer.alloc(16_385, 0x78));
        }
        if (sandboxWrapper.mode === 'control_error') {
          control.destroy(new Error('injected broker control stream failure'));
        }
        child.stderr.end();
        if (sandboxWrapper.mode !== 'control_error') control.end();
        const failed = sandboxWrapper.mode === 'missing'
          || sandboxWrapper.mode === 'not_started'
          || sandboxWrapper.mode === 'control_oversized'
          || sandboxWrapper.mode === 'control_error';
        child.emit('close', failed ? 1 : 0);
        if (sandboxWrapper.mode !== 'late_marker') {
          child.emit('exit', failed ? 1 : 0, null);
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
      if (controlledBroker) {
        const chunks: Buffer[] = [];
        child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.stdin.once('finish', () => {
          recordBrokerRequest(JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          ) as Readonly<Record<string, unknown>>);
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
      if (windowsSandboxMock.nextInstalledUserSid !== undefined) {
        windowsSandboxMock.user = {
          ...windowsSandboxMock.user,
          provisioned: true,
          sid: windowsSandboxMock.nextInstalledUserSid,
          credPresent: true,
        };
      }
      return {
        cancelled: false,
        wfp: {},
        user: { ...windowsSandboxMock.user },
      };
    },
    uninstallWindowsSandbox: (options?: Readonly<Record<string, unknown>>) => {
      windowsSandboxMock.uninstallCalls += 1;
      windowsSandboxMock.uninstallOptions.push(options ?? {});
      windowsSandboxMock.user = {
        ...windowsSandboxMock.user,
        provisioned: false,
        sid: undefined,
        credPresent: false,
      };
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
  doctorSandboxRuntime,
  clearPreviousBootWindowsSandboxAclMarkers,
  overrideWindowsNullDeviceInstallerForTest,
  prepareSandboxRuntimeForSetup,
  recoverPreviousBootWindowsSandboxAcls,
  recoverWindowsSandboxAclsForRuntimeOwner,
  runKodaXSandboxed,
  runAsrtBrokerProcess,
  setupSandboxRuntime,
  resetSandboxRuntimeForTest,
  resolveSrtWinSourcePath,
  rewriteWindowsGitSafeDirectoryArgv,
  sandboxRuntimeCapability,
  sandboxSetupGuidance,
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
  await mkdir(process.env.KODAX_HOME!, { recursive: true });
  const markerDirectory = path.join(
    path.resolve(process.env.ProgramData!),
    'KodaX',
    'sandbox-runtime',
  );
  await mkdir(markerDirectory, { recursive: true });
  await writeFile(
    path.join(markerDirectory, 'windows-v2-cutover.json'),
    JSON.stringify({
      version: 3,
      protocol: 4,
      hostUserSid: windowsSandboxMock.hostUserSid,
      sandboxUserSid: windowsSandboxMock.user.sid,
      sandboxGroupSid: windowsSandboxMock.user.groupSid,
    }),
    'utf8',
  );
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
  windowsEffectJobMock.drainFailure = undefined;
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
  boundedMetadataReadMock.trackedPaths.clear();
  boundedMetadataReadMock.fullReads.length = 0;
  resetSandboxRuntimeForTest();
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
  windowsSandboxMock.nullDeviceReady = true;
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
  windowsSandboxMock.uninstallCalls = 0;
  windowsSandboxMock.uninstallOptions.length = 0;
  windowsSandboxMock.nextInstalledUserSid = undefined;
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

describe.skipIf(process.platform === 'win32')('portable ASRT shell adapter', () => {
  it('prepares independent per-command brokers without a workspace-session owner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-portable-shell-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const prepare = (toolCallId: string) => sandbox.prepare({
      toolCallId,
      toolInput: { command: 'echo ok' },
      command: 'echo ok',
      executable: '/bin/sh',
      args: ['-c', 'echo ok'],
      cwd: root,
      env: process.env,
      fallbackToNormalExecution: false,
    });

    const [first, second] = await Promise.all([prepare('portable-a'), prepare('portable-b')]);
    if (first === undefined || second === undefined) throw new Error('expected portable brokers');
    expect(first.stdinPrefix).toBeInstanceOf(Uint8Array);
    expect(second.stdinPrefix).toBeInstanceOf(Uint8Array);
    const request = JSON.parse(Buffer.from(first.stdinPrefix!).toString('utf8')) as {
      readonly controlInvocationId: string;
      readonly wrappedInvocation?: unknown;
      readonly config: { readonly filesystem: { readonly allowWrite: readonly string[] } };
    };
    const secondRequest = JSON.parse(Buffer.from(second.stdinPrefix!).toString('utf8')) as {
      readonly controlInvocationId: string;
    };
    expect(request.controlInvocationId).not.toBe(secondRequest.controlInvocationId);
    expect(request.wrappedInvocation).toBeUndefined();
    expect(request.config.filesystem.allowWrite).toContain(root);
    expect(first.args.join(' ')).not.toContain('workspace-session');
    expect(first.controlChannel).toEqual({ fd: 3, maxOutputBytes: 16 * 1024 });
    await Promise.all([
      first.cleanup({ execution: 'not_started' }),
      second.cleanup({ execution: 'not_started' }),
    ]);
  });

  it('leaves a non-admitted call on the normal permission path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-portable-shell-denied-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => false,
    });
    await expect(sandbox.prepare({
      toolCallId: 'portable-denied',
      toolInput: { command: 'echo normal' },
      command: 'echo normal',
      cwd: root,
      env: process.env,
    })).resolves.toBeUndefined();
  });

  it('rejects model Bash read carve-backs into trusted text native state', async () => {
    const protectedRoot = trustedTextNativeArtifactStateRoots().at(-1);
    if (protectedRoot === undefined) throw new Error('expected a protected native text root');
    await mkdir(protectedRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-portable-protected-read-'));
    tempRoots.push(root);
    const alias = path.join(root, 'alias');
    await symlink(protectedRoot, alias, 'dir');
    const protectedLock = path.join(protectedRoot, 'reviewed-slot.lock');
    const readRoots = [
      protectedRoot,
      protectedLock,
      path.parse(protectedRoot).root,
      path.join(alias, 'missing-slot.lock'),
    ];
    const spawnCount = capturedSpawnArgv.length;

    for (const readRoot of readRoots) {
      const sandbox = createAsrtShellSandbox({
        workspaceRoot: root,
        shouldSandbox: () => ({
          filesystemAccess: { read: [readRoot], write: [] },
        }),
      });
      await expect(sandbox.prepare({
        toolCallId: `protected-read-${readRoots.indexOf(readRoot)}`,
        toolInput: { command: 'echo denied' },
        command: 'echo denied',
        executable: '/bin/sh',
        args: ['-c', 'echo denied'],
        cwd: root,
        env: process.env,
        fallbackToNormalExecution: false,
      })).rejects.toThrow(/protected native text state/i);
    }
    expect(capturedSpawnArgv).toHaveLength(spawnCount);
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

  it.skip(
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

  it.skip(
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

  it.skip(
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

  it('reports the v6 split-authority capability', () => {
    const capability = sandboxRuntimeCapability();
    expect(capability.version).toBe(6);
    expect(capability.gitSafeDirectory).toBe('authorized-repo-roots');
    expect(capability.delayedEffectDrainRecovery).toBe('automatic');
    expect(capability.sameBootAclRecovery).toBe('sandbox-user-process-probe');
    expect(capability.trustedTextAuthority).toBe('host-transaction');
    expect(capability.windowsShellAuthority).toBe('native-token-job-v2');
    expect(capability.commandLifetimeFilesystemLease).toBe(false);
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

describe.runIf(process.platform === 'win32')('Windows v2 account cutover', () => {
  function cutoverMarkerFile(): string {
    return path.join(
      path.resolve(process.env.ProgramData!),
      'KodaX',
      'sandbox-runtime',
      'windows-v2-cutover.json',
    );
  }

  it('fails doctor and shell admission before broker launch when the cutover marker is absent', async () => {
    await rm(cutoverMarkerFile(), { force: true });

    await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
      ready: false,
      setupRequired: true,
      diagnostics: expect.arrayContaining([
        expect.stringContaining('[windows_v2_acl_cutover_required]'),
      ]),
    });

    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-v2-cutover-admission-'));
    tempRoots.push(root);
    const sandbox = createAsrtShellSandbox({
      workspaceRoot: root,
      shouldSandbox: () => true,
    });
    const launchesBefore = capturedSpawnArgv.length;
    await expect(sandbox.prepare({
      toolCallId: 'cutover-required',
      toolInput: { command: 'echo denied' },
      command: 'echo denied',
      executable: process.execPath,
      args: ['--version'],
      cwd: root,
      env: process.env,
      fallbackToNormalExecution: false,
    })).rejects.toThrow('[windows_v2_acl_cutover_required]');
    expect(capturedSpawnArgv).toHaveLength(launchesBefore);
  });

  it('rejects a machine cutover recorded by another host user', async () => {
    const marker = JSON.parse(await readFile(cutoverMarkerFile(), 'utf8')) as {
      hostUserSid: string;
    };
    await writeFile(cutoverMarkerFile(), JSON.stringify({
      ...marker,
      hostUserSid: 'S-1-5-21-9999',
    }), 'utf8');

    await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
      ready: false,
      setupRequired: true,
      diagnostics: expect.arrayContaining([
        expect.stringContaining('activated by another host user'),
      ]),
    });
  });

  it('reinstalls a missing NUL compatibility ACE without rotating the current v2 account', async () => {
    windowsSandboxMock.nullDeviceReady = false;
    await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({
      ready: false,
      setupRequired: true,
      diagnostics: expect.arrayContaining([
        expect.stringContaining('NUL-device compatibility ACE is missing or unsafe'),
      ]),
    });

    const restore = overrideWindowsNullDeviceInstallerForTest(() => {
      windowsSandboxMock.nullDeviceReady = true;
    });
    try {
      const outcome = await prepareSandboxRuntimeForSetup();
      expect(outcome).toMatchObject({ status: 'ready', attempted: true });
      expect(windowsSandboxMock.uninstallCalls).toBe(0);
      expect(windowsSandboxMock.installCalls).toBe(1);
    } finally {
      restore();
    }
  });

  it('rotates an existing account SID before recording the v2 cutover', async () => {
    await rm(cutoverMarkerFile(), { force: true });
    const previousSid = windowsSandboxMock.user.sid;
    windowsSandboxMock.sidProcessesActive = false;
    windowsSandboxMock.nextInstalledUserSid = 'S-1-5-21-2000';

    const outcome = await prepareSandboxRuntimeForSetup();

    expect(outcome).toMatchObject({ status: 'ready', attempted: true });
    expect(windowsSandboxMock.uninstallCalls).toBe(1);
    expect(windowsSandboxMock.uninstallOptions.at(-1)).toMatchObject({ keepUser: false });
    expect(windowsSandboxMock.installCalls).toBe(1);
    expect(windowsSandboxMock.user.sid).not.toBe(previousSid);
    await expect(readFile(cutoverMarkerFile(), 'utf8')).resolves.toContain(
      '"sandboxUserSid":"S-1-5-21-2000"',
    );
    await expect(readFile(cutoverMarkerFile(), 'utf8')).resolves.toContain(
      `"hostUserSid":"${windowsSandboxMock.hostUserSid}"`,
    );
  });

  it('does not rotate the account while its SID still owns a live process', async () => {
    await rm(cutoverMarkerFile(), { force: true });
    windowsSandboxMock.sidProcessesActive = true;
    windowsSandboxMock.nextInstalledUserSid = 'S-1-5-21-2000';

    const outcome = await prepareSandboxRuntimeForSetup();

    expect(outcome).toMatchObject({ status: 'unavailable', attempted: true });
    expect(outcome.error).toContain('still has a live process');
    expect(windowsSandboxMock.uninstallCalls).toBe(0);
    expect(windowsSandboxMock.installCalls).toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('legacy ASRT Skill-script adapter', () => {
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
      resetSandboxRuntimeForTest();
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
      resetSandboxRuntimeForTest();
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

      await expect(runAsrtBrokerProcess(requestFile)).resolves.toBe(125);
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

  it('rejects POSIX shell write roots that overlap trusted text native state before spawn', async () => {
    const spawnCount = capturedSpawnArgv.length;
    const [protectedRoot] = trustedTextNativeArtifactStateRoots();
    if (protectedRoot === undefined) throw new Error('expected a protected native text root');

    await expect(runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: path.dirname(protectedRoot),
      filesystem: { allowRead: [], allowWrite: [path.basename(protectedRoot)] },
      network: { mode: 'deny' },
    })).rejects.toThrow(/protected native text state/i);
    expect(capturedSpawnArgv).toHaveLength(spawnCount);
  });

  it.each([
    ['the exact protected root', (protectedRoot: string) => protectedRoot],
    ['a broad filesystem ancestor', (protectedRoot: string) => path.parse(protectedRoot).root],
  ])('rejects POSIX shell read carve-back through %s', async (_name, readRoot) => {
    const spawnCount = capturedSpawnArgv.length;
    const [protectedRoot] = trustedTextNativeArtifactStateRoots();
    if (protectedRoot === undefined) throw new Error('expected a protected native text root');

    await expect(runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: os.tmpdir(),
      filesystem: { allowRead: [readRoot(protectedRoot)], allowWrite: [] },
      network: { mode: 'deny' },
    })).rejects.toThrow(/protected native text state/i);
    expect(capturedSpawnArgv).toHaveLength(spawnCount);
  });

  it('canonicalizes a POSIX symlink ancestor before checking a missing write leaf', async () => {
    const spawnCount = capturedSpawnArgv.length;
    const [protectedRoot] = trustedTextNativeArtifactStateRoots();
    if (protectedRoot === undefined) throw new Error('expected a protected native text root');
    await mkdir(protectedRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-protected-state-alias-'));
    tempRoots.push(root);
    const alias = path.join(root, 'alias');
    await symlink(protectedRoot, alias, 'dir');

    await expect(runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: root,
      filesystem: { allowRead: [], allowWrite: [path.join('alias', 'missing')] },
      network: { mode: 'deny' },
    })).rejects.toThrow(/protected native text state/i);
    expect(capturedSpawnArgv).toHaveLength(spawnCount);
  });

  it('forces trusted text native state into POSIX shell read and write denies', async () => {
    await expect(runKodaXSandboxed({
      command: process.execPath,
      args: ['--version'],
      cwd: os.tmpdir(),
      filesystem: { allowRead: [], allowWrite: [] },
      network: { mode: 'deny' },
    })).resolves.toMatchObject({ status: 'completed', sandboxed: true });

    const request = capturedBrokerRequests.at(-1) as {
      readonly config: {
        readonly filesystem: {
          readonly denyRead: readonly string[];
          readonly denyWrite: readonly string[];
        };
      };
    };
    for (const protectedRoot of trustedTextNativeArtifactStateRoots()) {
      expect(request.config.filesystem.denyRead).toContain(protectedRoot);
      expect(request.config.filesystem.denyWrite).toContain(protectedRoot);
    }
  });

  it.runIf(process.platform !== 'win32')(
    'reports a proven pre-target POSIX backend failure as unavailable',
    async () => {
      sandboxWrapper.mode = 'not_started';

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: os.tmpdir(),
        filesystem: { allowRead: [], allowWrite: [] },
        network: { mode: 'deny' },
      })).resolves.toMatchObject({
        status: 'unavailable',
        sandboxed: false,
        reason: 'backend_launch_failed',
        diagnostic: expect.stringContaining('proven not to have started'),
        doctor: { ready: false, setupRequired: true },
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'never accepts an ordinary-permission fallback as a sandboxed SDK completion',
    async () => {
      sandboxWrapper.mode = 'fallback';

      await expect(runKodaXSandboxed({
        command: process.execPath,
        args: ['--version'],
        cwd: os.tmpdir(),
        filesystem: { allowRead: [], allowWrite: [] },
        network: { mode: 'deny' },
      })).resolves.toMatchObject({
        status: 'execution_uncertain',
        sandboxed: false,
        reason: 'attestation_failed',
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'reports missing or mismatched broker control as execution-uncertain',
    async () => {
      for (const mode of [
        'missing',
        'control_missing',
        'control_oversized',
        'control_error',
        'wrong_invocation',
      ] as const) {
        sandboxWrapper.mode = mode;
        await expect(runKodaXSandboxed({
          command: process.execPath,
          args: ['--version'],
          cwd: os.tmpdir(),
          filesystem: { allowRead: [], allowWrite: [] },
          network: { mode: 'deny' },
        })).resolves.toMatchObject({
          status: 'execution_uncertain',
          sandboxed: false,
          reason: 'attestation_failed',
          diagnostic: expect.any(String),
        });
      }
    },
  );

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
