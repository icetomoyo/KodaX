import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ClientExitReceipt } from '@kodax-ai/coding/client-contract';
import type { KodaXRuntime } from '../sdk-runtime.js';
import { cleanupClientWork, settleClientWork } from '../runtime-client-work.js';
import type { RuntimeDaemonManagementController } from './management.js';
import { readRuntimeDaemonLockOwner, readRuntimeOwnerProcessStartIdentity, type RuntimeDaemonPaths } from './state.js';
import { isRuntimeDaemonPidAlive } from './lifecycle.js';
import { waitForRuntimeDaemonShutdown } from './shutdown-verifier.js';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';

export function runtimeClientPrincipal(instanceId: string, instanceSecret: string): string {
  return `client_${createHash('sha256').update(JSON.stringify([instanceId, instanceSecret])).digest('hex')}`;
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const directory = (paths: RuntimeDaemonPaths, principal: string): string => path.join(paths.rootDir, 'client-exits', digest(principal));
function writeReceipt(paths: RuntimeDaemonPaths, receipt: ClientExitReceipt): void {
  const dir = directory(paths, receipt.clientId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${digest(receipt.requestId)}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
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
  const identity = isRuntimeDaemonPidAlive(owner.pid) ? readRuntimeOwnerProcessStartIdentity(owner.pid) : undefined;
  const ownerActive = current?.runtimeId === owner.runtimeId && current.pid === owner.pid
    && isRuntimeDaemonPidAlive(owner.pid)
    && (owner.processStartIdentity === undefined || identity === undefined || identity === owner.processStartIdentity);
  const recovered = !ownerActive && receipt.cleanup.state === 'pending'
    ? { ...receipt, cleanup: { ...receipt.cleanup, state: 'unknown' as const,
      issues: [...receipt.cleanup.issues, 'Original Host stopped before client cleanup was confirmed.'] } }
    : receipt;
  if (!receipt.host.requested || (ownerActive && (receipt.host.state === 'pending' || receipt.host.state === 'protected'))) return recovered;
  const verification = await waitForRuntimeDaemonShutdown({ configHome: paths.configHome, profile: paths.profile,
    owner, timeoutMs: 1, pollIntervalMs: 1 });
  // The owner can finish cleanup while process verification yields. Keep its
  // latest durable receipt rather than returning our pre-probe snapshot.
  const latest = readExitReceipts(paths, receipt.clientId).find(row => row.requestId === receipt.requestId && row.runtimeId === receipt.runtimeId);
  const result = latest && latest.updatedAt !== receipt.updatedAt ? latest : recovered;
  if (verification.status === 'succeeded' || verification.status === 'replacement_running') return {
    ...result, host: { ...result.host, state: 'succeeded', cleanup: 'succeeded',
      ...(verification.status === 'replacement_running' ? { replacementRunning: true } : {}) },
  };
  if (verification.status === 'failed') return { ...result,
    host: { ...result.host, state: 'failed', cleanup: 'failed', message: verification.outcome.error } };
  return { ...result, host: { ...result.host,
    state: ownerActive && receipt.host.state === 'accepted'
      ? 'accepted' : 'unknown',
    message: verification.status === 'unverified' ? verification.reason : 'outcome_missing' } };
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
  const drive = async (receipt: ClientExitReceipt): Promise<void> => {
    let current = receipt;
    try {
      // Recovery never applies an old owner's quit request to replacement work.
      if (current.runtimeId !== runtimeId) {
        if (current.cleanup.state !== 'succeeded') current = { ...current, cleanup: { ...current.cleanup, state: 'unknown',
          issues: [...current.cleanup.issues, 'Original Host stopped before client cleanup was confirmed.'] } };
      } else {
        const cleanup = await cleanupClientWork(input.runtime, current.clientId);
        await settleClientWork([...(admissions.get(current.clientId) ?? [])]);
        const finalCleanup = await cleanupClientWork(input.runtime, current.clientId);
        input.retireClientLeases(current.clientId);
        const admissionUnsettled = (admissions.get(current.clientId)?.size ?? 0) > 0;
        current = { ...current, updatedAt: new Date().toISOString(), cleanup: {
          ...finalCleanup, operationIds: [...new Set([...current.cleanup.operationIds, ...cleanup.operationIds, ...finalCleanup.operationIds])],
          ...(admissionUnsettled ? { state: 'unknown', issues: [...finalCleanup.issues, 'Accepted client operations remain unconfirmed.'] } : {}),
          actorTurns: [...new Map([...current.cleanup.actorTurns, ...cleanup.actorTurns, ...finalCleanup.actorTurns].map(turn => [turn.turnId, turn])).values()],
          runIds: [...new Set([...current.cleanup.runIds, ...cleanup.runIds, ...finalCleanup.runIds])],
          withdrawnInputs: [...current.cleanup.withdrawnInputs, ...cleanup.withdrawnInputs, ...finalCleanup.withdrawnInputs],
        } };
      }
      writeReceipt(input.paths, current);
      if (current.host.requested && current.cleanup.state !== 'failed' && current.runtimeId === runtimeId) {
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
    } catch (error: unknown) {
      writeReceipt(input.paths, { ...current, updatedAt: new Date().toISOString(), cleanup: {
        ...current.cleanup, state: 'failed', issues: [...current.cleanup.issues, error instanceof Error ? error.message : String(error)],
      } });
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
      const now = new Date().toISOString();
      const receipt: ClientExitReceipt = existing ?? { requestId: request.requestId, clientId: principal, runtimeId,
        accepted: true, requestedAt: now, updatedAt: now,
        cleanup: { state: 'pending', runIds: [], operationIds: [], actorTurns: [], withdrawnInputs: [], issues: [] },
        host: { requested: request.shutdownHost === true, state: request.shutdownHost ? 'pending' : 'not_requested', owner: owner! } };
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
      return receipts.filter(receipt => receipt.cleanup.state !== 'succeeded'
        || (receipt.host.requested && receipt.host.state !== 'succeeded'));
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
