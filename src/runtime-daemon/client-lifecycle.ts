import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ClientExitReceipt, ClientExitRecovery } from '@kodax-ai/coding/client-contract';
import type { KodaXRuntime } from '../sdk-runtime.js';
import { cleanupClientWork, settleClientWork } from '../runtime-client-work.js';
import type { RuntimeDaemonManagementController } from './management.js';
import { readRuntimeDaemonLockOwner, runtimeOwnerProcessState, type RuntimeDaemonLockOwner, type RuntimeDaemonPaths } from './state.js';
import { isRuntimeDaemonOwnerPidAlive } from './lifecycle.js';
import { waitForRuntimeDaemonShutdown } from './shutdown-verifier.js';
import { emitKodaXDiagnostic, readWindowsJobActiveProcessCount } from '@kodax-ai/agent';
import { readWindowsSandboxBootIdentity } from '../sandbox-runtime.js';

export function runtimeClientPrincipal(instanceId: string, instanceSecret: string): string {
  return `client_${createHash('sha256').update(JSON.stringify([instanceId, instanceSecret])).digest('hex')}`;
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const directory = (paths: RuntimeDaemonPaths, principal: string): string => path.join(paths.rootDir, 'client-exits', digest(principal));
function writeReceipt(paths: RuntimeDaemonPaths, receipt: ClientExitReceipt): void {
  const dir = directory(paths, receipt.clientId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${digest(receipt.requestId)}.json`);
  // Stop can yield while hostCleanup records its result. Do not erase that
  // acknowledgement with the drive loop's earlier snapshot of the same owner.
  const latest = receipt.host.cleanup === undefined && fs.existsSync(file)
    ? readExitReceipts(paths, receipt.clientId).find(row => row.requestId === receipt.requestId) : undefined;
  const value = latest?.host.cleanup !== undefined && latest.runtimeId === receipt.runtimeId
    && sameExitOwner(latest.host.owner, receipt.host.owner)
    ? { ...receipt, updatedAt: latest.updatedAt > receipt.updatedAt ? latest.updatedAt : receipt.updatedAt,
      host: { ...receipt.host, cleanup: latest.host.cleanup, message: latest.host.message } }
    : receipt;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function readExitReceipts(paths: RuntimeDaemonPaths, principal: string): ClientExitReceipt[] {
  const dir = directory(paths, principal);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => {
    const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as ClientExitReceipt;
    if (value.clientId !== principal || value.accepted !== true || !value.requestId || !value.host?.owner
      || !value.cleanup || !Array.isArray(value.cleanup.runIds)) throw new Error('Invalid persisted client exit receipt.');
    return value;
  });
}
export async function verifyExitReceipt(paths: RuntimeDaemonPaths, receipt: ClientExitReceipt): Promise<ClientExitReceipt> {
  const owner = receipt.host.owner;
  const current = readRuntimeDaemonLockOwner(paths.lockFile);
  // A receipt carries no PID namespace; only this owner's own lock record supplies it.
  const ownerActive = isRuntimeDaemonOwnerPidAlive(owner.pid, owner.processStartIdentity,
    current !== undefined && sameExitOwner(current, owner) ? current.pidNamespace : undefined);
  const recovered = ownerActive ? receipt : afterOwnerLoss(receipt);
  if (receipt.runtimeId !== owner.runtimeId) {
    return ownerActive ? withRecovery(recovered, 'blocked', 'owner_identity_mismatch', 'inspect_failure')
      : withRecovery(recovered, 'ready', 'owner_identity_mismatch', 'start_or_connect');
  }
  if (ownerActive) {
    if (receipt.cleanup.state === 'failed' || receipt.host.cleanup === 'failed') {
      return withRecovery(recovered, 'blocked', 'cleanup_failed', 'inspect_failure');
    }
    if (current === undefined || !sameExitOwner(current, owner)) {
      return withRecovery(recovered, 'blocked', 'daemon_active', 'retry_verification');
    }
    if (!receipt.host.requested && receipt.cleanup.state === 'succeeded') {
      return withRecovery(recovered, 'ready', 'client_cleanup_verified', 'start_or_connect');
    }
    if (receipt.host.state === 'protected') return withRecovery(recovered, 'blocked', 'host_protected', 'retry_exit');
    if (receipt.cleanup.state !== 'succeeded') return withRecovery(recovered,
      receipt.cleanup.state === 'pending' ? 'pending' : 'blocked',
      receipt.cleanup.state === 'pending' ? 'client_cleanup_pending' : 'client_cleanup_unknown', 'retry_exit');
    return withRecovery(recovered, 'pending', 'daemon_active', 'retry_verification');
  }
  const verification = await waitForRuntimeDaemonShutdown({ configHome: paths.configHome,
    owner, timeoutMs: 1, pollIntervalMs: 1 }, paths.profile);
  // The owner can finish cleanup while process verification yields. Keep its
  // latest durable receipt rather than returning our pre-probe snapshot.
  const latest = readExitReceipts(paths, receipt.clientId).find(row => row.requestId === receipt.requestId);
  if (latest && (latest.runtimeId !== receipt.runtimeId || latest.host.requested !== receipt.host.requested
    || !sameExitOwner(latest.host.owner, owner))) {
    return withRecovery(recovered, 'blocked', 'owner_identity_mismatch', 'inspect_failure');
  }
  const result = latest ? afterOwnerLoss(latest) : recovered;
  // The original Host process is gone, so the evidence it left can no longer change.
  // Only processes that still run are worth waiting for. Any other gap stays on the
  // receipt as the reason and recovery is ready: the profile lock is what fences a new
  // Host, and a permanent block here would only force the user to delete records.
  if (verification.status === 'unverified'
    && (verification.reason === 'daemon_active' || verification.reason === 'containment_active')) {
    return withRecovery(result, 'blocked', verification.reason, 'retry_verification');
  }
  // Client work (Runs, queued input, actor turns) lived inside the Host process,
  // so its cleanup failure is history, not a reason to wait.
  if (result.host.cleanup === 'failed') return withRecovery(result, 'ready', 'cleanup_failed', 'start_or_connect');
  if (verification.status === 'succeeded' || verification.status === 'replacement_running') {
    if (!owner.processStartIdentity || (owner.processContainment === 'windows-job'
      && !owner.supervisorProcessStartIdentity)) {
      return withRecovery(result, 'ready', 'owner_identity_unverified', 'start_or_connect');
    }
    return withRecovery({ ...result, host: { ...result.host, state: 'succeeded', cleanup: 'succeeded',
      ...(verification.status === 'replacement_running' ? { replacementRunning: true } : {}) },
    }, 'ready', 'host_shutdown_verified', 'start_or_connect');
  }
  if (verification.status === 'failed') return withRecovery({ ...result,
    host: { ...result.host, state: 'failed', cleanup: 'failed', message: verification.outcome.error } },
    'ready', 'cleanup_failed', 'start_or_connect');
  const reason = verification.status === 'unverified' ? verification.reason : 'outcome_missing';
  const crashed = { ...result, host: { ...result.host,
    state: receipt.host.requested ? 'unknown' as const : 'not_requested' as const, message: reason } };
  const windowsHost = reason === 'outcome_missing' ? await terminatedWindowsHostState(owner) : 'unknown';
  // A Job that still has members is a crash whose processes are still running; wait for them.
  if (windowsHost === 'running') return withRecovery(crashed, 'blocked', 'containment_active', 'retry_verification');
  // This never certifies the original exit, its resource cleanup, or the outcome of an
  // interrupted tool/Provider request; it only names how much the crash left unproven.
  return withRecovery(crashed, 'ready', windowsHost === 'terminated' ? 'host_generation_terminated' : reason,
    'start_or_connect');
}

async function terminatedWindowsHostState(
  owner: ClientExitReceipt['host']['owner'],
): Promise<'terminated' | 'running' | 'unknown'> {
  if (process.platform !== 'win32' || owner.kind !== 'daemon' || !owner.processStartIdentity
    || owner.processContainment !== 'windows-job' || !owner.supervisorProcessStartIdentity
    || !Number.isSafeInteger(owner.supervisorPid) || owner.supervisorPid! <= 0
    || runtimeOwnerProcessState(owner) !== 'gone'
    || runtimeOwnerProcessState({ pid: owner.supervisorPid!, processStartIdentity: owner.supervisorProcessStartIdentity }) !== 'gone') return 'unknown';
  const currentBoot = owner.windowsBootIdentity === undefined ? undefined : readWindowsSandboxBootIdentity();
  if (currentBoot !== undefined && /^windows-boot-\d+$/.test(currentBoot)
    && /^windows-boot-\d+$/.test(owner.windowsBootIdentity!) && currentBoot !== owner.windowsBootIdentity) return 'terminated';
  if (owner.windowsJobName === undefined) return 'unknown';
  const active = await readWindowsJobActiveProcessCount(owner.windowsJobName);
  return active === undefined ? 'unknown' : active === 0 ? 'terminated' : 'running';
}

function withRecovery(receipt: ClientExitReceipt, state: ClientExitRecovery['state'],
  reason: ClientExitRecovery['reason'], nextAction: ClientExitRecovery['nextAction']): ClientExitReceipt {
  return { ...receipt, recovery: { state, reason, nextAction, checkedAt: new Date().toISOString() } };
}

function afterOwnerLoss(receipt: ClientExitReceipt): ClientExitReceipt {
  return receipt.cleanup.state === 'pending'
    ? { ...receipt, cleanup: { ...receipt.cleanup, state: 'unknown',
      issues: [...receipt.cleanup.issues, 'Original Host stopped before client cleanup was confirmed.'] } }
    : receipt;
}

/** A receipt is read by clients; the PID namespace stays in the Host lock record. */
function exitOwner({ pidNamespace: _pidNamespace, ...owner }: RuntimeDaemonLockOwner): ClientExitReceipt['host']['owner'] {
  return owner;
}

function sameExitOwner(left: ClientExitReceipt['host']['owner'], right: ClientExitReceipt['host']['owner']): boolean {
  return left.runtimeId === right.runtimeId && left.pid === right.pid && left.kind === right.kind
    && left.processStartIdentity === right.processStartIdentity && left.processContainment === right.processContainment
    && left.supervisorPid === right.supervisorPid && left.supervisorProcessStartIdentity === right.supervisorProcessStartIdentity
    && left.windowsJobName === right.windowsJobName && left.windowsBootIdentity === right.windowsBootIdentity;
}

export interface RuntimeClientLifecycleController {
  admit<T>(principal: string, action: () => Promise<T>): Promise<T>;
  request(principal: string, input: { readonly requestId: string; readonly shutdownHost?: boolean }): Promise<ClientExitReceipt>;
  read(principal: string, requestId: string): Promise<ClientExitReceipt | null>;
  pending(principal: string): Promise<readonly ClientExitReceipt[]>;
  assertAdmission(principal: string): void;
  hostCleanup(state: 'succeeded' | 'failed', message?: string): void;
}
export function createRuntimeClientLifecycleController(input: {
  readonly runtime: KodaXRuntime; readonly paths: RuntimeDaemonPaths; readonly management: RuntimeDaemonManagementController;
  readonly retireClientLeases: (principalId: string) => void;
}): RuntimeClientLifecycleController {
  const exiting = new Set<string>();
  const running = new Set<string>();
  const admissions = new Map<string, Set<Promise<unknown>>>();
  const runtimeId = input.runtime.identity.runtimeId;
  const ownsReceipt = (receipt: ClientExitReceipt): boolean => {
    const owner = readRuntimeDaemonLockOwner(input.paths.lockFile);
    return receipt.runtimeId === runtimeId && owner !== undefined && sameExitOwner(owner, receipt.host.owner);
  };
  const settleCleanup = async (current: ClientExitReceipt): Promise<ClientExitReceipt> => {
    const cleanup = await cleanupClientWork(input.runtime, current.clientId);
    await settleClientWork([...(admissions.get(current.clientId) ?? [])]);
    const finalCleanup = await cleanupClientWork(input.runtime, current.clientId);
    input.retireClientLeases(current.clientId);
    const admissionUnsettled = (admissions.get(current.clientId)?.size ?? 0) > 0;
    return { ...current, updatedAt: new Date().toISOString(), cleanup: {
      ...finalCleanup, operationIds: [...new Set([...current.cleanup.operationIds, ...cleanup.operationIds, ...finalCleanup.operationIds])],
      ...(admissionUnsettled ? { state: 'unknown', issues: [...finalCleanup.issues, 'Accepted client operations remain unconfirmed.'] } : {}),
      actorTurns: [...new Map([...current.cleanup.actorTurns, ...cleanup.actorTurns, ...finalCleanup.actorTurns].map(turn => [turn.turnId, turn])).values()],
      runIds: [...new Set([...current.cleanup.runIds, ...cleanup.runIds, ...finalCleanup.runIds])],
      withdrawnInputs: [...current.cleanup.withdrawnInputs, ...cleanup.withdrawnInputs, ...finalCleanup.withdrawnInputs],
    } };
  };
  const drive = async (receipt: ClientExitReceipt): Promise<void> => {
    let current = receipt;
    try {
      // Recovery never applies an old owner's quit request to replacement work.
      if (!ownsReceipt(current)) return;
      try { current = await settleCleanup(current); }
      catch (error: unknown) {
        // Unknown, not failed: the client work still ends with this Host, and a
        // verified Host exit settles the receipt. A terminal failure would block
        // every later start on a conclusion that can no longer change.
        current = { ...current, updatedAt: new Date().toISOString(), cleanup: { ...current.cleanup, state: 'unknown',
          issues: [...current.cleanup.issues, error instanceof Error ? error.message : String(error)] } };
      }
      writeReceipt(input.paths, current);
      if (current.host.requested && ownsReceipt(current)) {
        try {
          await input.management.stop({ principalId: current.clientId });
          current = { ...current, host: { ...current.host, state: 'accepted' } };
        } catch (error: unknown) {
          current = { ...current, host: { ...current.host,
            state: error instanceof Error && 'code' in error && error.code === 'conflict' ? 'protected' : 'failed',
            message: error instanceof Error ? error.message : String(error) } };
        }
        writeReceipt(input.paths, current);
      }
    // A receipt write or owner read that fails here reaches emitLifecycleFailure;
    // the receipt keeps its last durable state, which settles after Host exit.
    } finally { running.delete(JSON.stringify([receipt.clientId, receipt.requestId])); }
  };
  return {
    async admit(principal, action) {
      this.assertAdmission(principal);
      const pending = Promise.resolve().then(action);
      const work = admissions.get(principal) ?? new Set<Promise<unknown>>();
      work.add(pending); admissions.set(principal, work);
      try { return await pending; }
      finally { work.delete(pending); if (work.size === 0) admissions.delete(principal); }
    },
    async request(principal, request) {
      if (!request.requestId.trim() || request.requestId.length > 256) throw Object.assign(new Error('Exit requestId must contain 1–256 characters.'), { code: 'invalid_params' });
      const existing = readExitReceipts(input.paths, principal).find(receipt => receipt.requestId === request.requestId);
      if (existing && existing.host.requested !== (request.shutdownHost === true)) throw Object.assign(new Error('Exit requestId already has a different intent.'), { code: 'conflict' });
      const owner = readRuntimeDaemonLockOwner(input.paths.lockFile);
      if (!existing && owner?.runtimeId !== runtimeId) throw Object.assign(new Error('Host owner changed.'), { code: 'conflict' });
      if (existing && !ownsReceipt(existing)) return verifyExitReceipt(input.paths, existing);
      const now = new Date().toISOString();
      const receipt: ClientExitReceipt = existing ?? { requestId: request.requestId, clientId: principal, runtimeId,
        accepted: true, requestedAt: now, updatedAt: now,
        cleanup: { state: 'pending', runIds: [], operationIds: [], actorTurns: [], withdrawnInputs: [], issues: [] },
        host: { requested: request.shutdownHost === true, state: request.shutdownHost ? 'pending' : 'not_requested', owner: exitOwner(owner!) } };
      writeReceipt(input.paths, receipt);
      if (receipt.runtimeId === runtimeId) exiting.add(principal);
      const key = JSON.stringify([principal, receipt.requestId]);
      if (!running.has(key)) {
        running.add(key);
        setTimeout(() => { void drive(receipt).catch(error => {
          emitLifecycleFailure(error);
        }); }, 0);
      }
      return receipt;
    },
    async read(principal, requestId) {
      const receipt = readExitReceipts(input.paths, principal).find(value => value.requestId === requestId);
      return receipt ? verifyExitReceipt(input.paths, receipt) : null;
    },
    async pending(principal) {
      const receipts = await Promise.all(readExitReceipts(input.paths, principal).map(receipt => verifyExitReceipt(input.paths, receipt)));
      return receipts.filter(receipt => receipt.recovery?.state !== 'ready');
    },
    assertAdmission(principal) {
      if (exiting.has(principal) || readExitReceipts(input.paths, principal).some(receipt => receipt.runtimeId === runtimeId)) {
        throw Object.assign(new Error('This client has requested exit and cannot admit new work.'), { code: 'conflict' });
      }
    },
    hostCleanup(state, message) {
      const root = path.join(input.paths.rootDir, 'client-exits');
      if (!fs.existsSync(root)) return;
      for (const dir of fs.readdirSync(root)) {
        for (const name of fs.readdirSync(path.join(root, dir)).filter(file => file.endsWith('.json'))) {
          const receipt = JSON.parse(fs.readFileSync(path.join(root, dir, name), 'utf8')) as ClientExitReceipt;
          if (receipt.runtimeId !== runtimeId || !receipt.host.requested || receipt.host.state === 'protected') continue;
          writeReceipt(input.paths, { ...receipt, updatedAt: new Date().toISOString(), host: { ...receipt.host, cleanup: state, message } });
        }
      }
    },
  };
}
function emitLifecycleFailure(error: unknown): void {
  emitKodaXDiagnostic({ source: 'runtime.client-exit', level: 'error', message: 'Client exit persistence failed.', detail: error });
}
