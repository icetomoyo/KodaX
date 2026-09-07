import fs from 'node:fs';
import path from 'node:path';

import { A2A_PRINCIPAL_KEY_SCHEME } from './principal-key.js';
import { isRecord, parseA2AMessage, parseA2ATask } from './schemas.js';
import type { A2AMessage, A2ATask } from './types.js';

export interface A2AServerTaskRecord {
  readonly taskId: string;
  readonly contextId: string;
  readonly principalKey: string;
  readonly principalKeyScheme?: typeof A2A_PRINCIPAL_KEY_SCHEME;
  readonly runtimeIdentity: string;
  readonly sessionId: string;
  readonly workspaceRoot?: string;
  readonly executionPolicyRevision?: string;
  readonly messageDigests: Readonly<Record<string, string>>;
  readonly runIds: readonly string[];
  readonly task: A2ATask;
  readonly history: readonly A2AMessage[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly eventSeq: number;
  readonly runtimeEventCount: number;
  readonly runtimeEventBytes: number;
  readonly acceptedOutputModes?: readonly string[];
  readonly pendingUserInput?: {
    readonly requestId: string;
    readonly revision: number;
    readonly runId: string;
    readonly kind: string;
  };
}

type TaskListener = (record: A2AServerTaskRecord) => void;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parseRecord(value: unknown): A2AServerTaskRecord {
  if (!isRecord(value)) throw new Error('A2A task store record must be an object.');
  for (const key of ['taskId', 'contextId', 'principalKey', 'runtimeIdentity', 'sessionId', 'createdAt', 'updatedAt']) {
    if (typeof value[key] !== 'string') throw new Error(`A2A task store record has invalid ${key}.`);
  }
  if (!isRecord(value.messageDigests) || !Object.values(value.messageDigests).every((item) => typeof item === 'string')) {
    throw new Error('A2A task store message digests are invalid.');
  }
  if (!Array.isArray(value.runIds) || !value.runIds.every((item) => typeof item === 'string')) {
    throw new Error('A2A task store run IDs are invalid.');
  }
  if (!Array.isArray(value.history)) throw new Error('A2A task store history is invalid.');
  if (value.principalKeyScheme !== undefined && value.principalKeyScheme !== A2A_PRINCIPAL_KEY_SCHEME) {
    throw new Error('A2A task store principal key scheme is unsupported.');
  }
  if (!Number.isSafeInteger(value.eventSeq)) {
    throw new Error('A2A task store event cursors are invalid.');
  }
  // FEATURE_298 T20 — legacy Runtime session cursor checkpoints are dropped
  // on load; task state now maps from the current Run and pending inputs.
  const pendingUserInput = value.pendingUserInput;
  if (pendingUserInput !== undefined && (
    !isRecord(pendingUserInput)
    || typeof pendingUserInput.requestId !== 'string'
    || !Number.isSafeInteger(pendingUserInput.revision)
    || typeof pendingUserInput.runId !== 'string'
    || typeof pendingUserInput.kind !== 'string'
  )) {
    throw new Error('A2A task store pending user input is invalid.');
  }
  if (value.acceptedOutputModes !== undefined && (
    !Array.isArray(value.acceptedOutputModes)
    || !value.acceptedOutputModes.every((mode) => typeof mode === 'string')
  )) throw new Error('A2A task store accepted output modes are invalid.');
  return {
    taskId: value.taskId as string,
    contextId: value.contextId as string,
    principalKey: value.principalKey as string,
    ...(value.principalKeyScheme === A2A_PRINCIPAL_KEY_SCHEME
      ? { principalKeyScheme: A2A_PRINCIPAL_KEY_SCHEME }
      : {}),
    runtimeIdentity: value.runtimeIdentity as string,
    sessionId: value.sessionId as string,
    ...(typeof value.workspaceRoot === 'string' ? { workspaceRoot: value.workspaceRoot } : {}),
    ...(typeof value.executionPolicyRevision === 'string'
      ? { executionPolicyRevision: value.executionPolicyRevision }
      : {}),
    messageDigests: value.messageDigests as Record<string, string>,
    runIds: value.runIds as string[],
    task: parseA2ATask(value.task),
    history: value.history.map(parseA2AMessage),
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
    eventSeq: value.eventSeq as number,
    runtimeEventCount: Number.isSafeInteger(value.runtimeEventCount) ? value.runtimeEventCount as number : 0,
    runtimeEventBytes: Number.isSafeInteger(value.runtimeEventBytes) ? value.runtimeEventBytes as number : 0,
    ...(value.acceptedOutputModes !== undefined
      ? { acceptedOutputModes: value.acceptedOutputModes as string[] }
      : {}),
    ...(pendingUserInput !== undefined ? {
      pendingUserInput: {
        requestId: pendingUserInput.requestId as string,
        revision: pendingUserInput.revision as number,
        runId: pendingUserInput.runId as string,
        kind: pendingUserInput.kind as string,
      },
    } : {}),
  };
}

export class A2AFileTaskStore {
  readonly #records = new Map<string, A2AServerTaskRecord>();
  readonly #listeners = new Map<string, Set<TaskListener>>();
  readonly #file: string;
  readonly #lockPath: string;
  readonly #lockFd: number;

  constructor(root: string) {
    const resolved = path.resolve(root);
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    this.#file = path.join(resolved, 'tasks.json');
    this.#lockPath = path.join(resolved, '.server.lock');
    this.#lockFd = this.acquireLock();
    try {
      this.load();
    } catch (error: unknown) {
      fs.closeSync(this.#lockFd);
      fs.rmSync(this.#lockPath, { force: true });
      throw error;
    }
    // FEATURE_298 T20 — the store exclusively owns its dataDir (lock above),
    // so retired Runtime cursor checkpoints are garbage-collected on open.
    fs.rmSync(path.join(resolved, 'runtime-cursors'), { recursive: true, force: true });
  }

  get(taskId: string): A2AServerTaskRecord | undefined {
    const record = this.#records.get(taskId);
    return record ? clone(record) : undefined;
  }

  findByMessage(principalKey: string, messageId: string): A2AServerTaskRecord | undefined {
    for (const record of this.#records.values()) {
      if (record.principalKey === principalKey && record.messageDigests[messageId] !== undefined) {
        return clone(record);
      }
    }
    return undefined;
  }

  list(principalKey: string): readonly A2AServerTaskRecord[] {
    return [...this.#records.values()]
      .filter((record) => record.principalKey === principalKey)
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt)
        || right.taskId.localeCompare(left.taskId)
      ))
      .map(clone);
  }

  all(): readonly A2AServerTaskRecord[] {
    return [...this.#records.values()].map(clone);
  }

  save(record: A2AServerTaskRecord): A2AServerTaskRecord {
    const next = clone(record);
    const previous = this.#records.get(record.taskId);
    this.#records.set(record.taskId, next);
    try {
      this.persist();
    } catch (error: unknown) {
      if (previous) this.#records.set(record.taskId, previous);
      else this.#records.delete(record.taskId);
      throw error;
    }
    for (const listener of this.#listeners.get(record.taskId) ?? []) listener(clone(next));
    return clone(next);
  }

  pruneTerminal(principalKey: string, maxRecords: number): readonly A2AServerTaskRecord[] {
    const records = [...this.#records.values()]
      .filter((record) => record.principalKey === principalKey)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const removed: A2AServerTaskRecord[] = [];
    while (records.length > maxRecords) {
      const index = records.findIndex((record) => (
        record.task.status.state === 'TASK_STATE_COMPLETED'
        || record.task.status.state === 'TASK_STATE_FAILED'
        || record.task.status.state === 'TASK_STATE_CANCELED'
        || record.task.status.state === 'TASK_STATE_REJECTED'
      ));
      if (index < 0) break;
      const [record] = records.splice(index, 1);
      if (!record) break;
      this.#records.delete(record.taskId);
      this.#listeners.delete(record.taskId);
      removed.push(clone(record));
    }
    if (removed.length > 0) this.persist();
    return removed;
  }

  migrateUnversionedPrincipalKeys(input: {
    readonly legacyToCurrent: ReadonlyMap<string, string>;
    readonly currentKeys: ReadonlySet<string>;
    readonly apply: boolean;
  }): {
    readonly matchedLegacyTaskCount: number;
    readonly matchedCurrentTaskCount: number;
    readonly unmatchedUnversionedTaskCount: number;
  } {
    let matchedLegacyTaskCount = 0;
    let matchedCurrentTaskCount = 0;
    let unmatchedUnversionedTaskCount = 0;
    const updates: Array<readonly [string, A2AServerTaskRecord]> = [];
    for (const [taskId, record] of this.#records) {
      if (record.principalKeyScheme !== undefined) continue;
      const currentKey = input.legacyToCurrent.get(record.principalKey);
      if (currentKey !== undefined) {
        matchedLegacyTaskCount += 1;
        updates.push([taskId, {
          ...record,
          principalKey: currentKey,
          principalKeyScheme: A2A_PRINCIPAL_KEY_SCHEME,
        }]);
      } else if (input.currentKeys.has(record.principalKey)) {
        matchedCurrentTaskCount += 1;
        updates.push([taskId, { ...record, principalKeyScheme: A2A_PRINCIPAL_KEY_SCHEME }]);
      } else {
        unmatchedUnversionedTaskCount += 1;
      }
    }
    if (input.apply && updates.length > 0) {
      for (const [taskId, record] of updates) this.#records.set(taskId, record);
      this.persist();
    }
    return { matchedLegacyTaskCount, matchedCurrentTaskCount, unmatchedUnversionedTaskCount };
  }

  subscribe(taskId: string, listener: TaskListener): () => void {
    const listeners = this.#listeners.get(taskId) ?? new Set<TaskListener>();
    listeners.add(listener);
    this.#listeners.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(taskId);
    };
  }

  close(): void {
    this.#listeners.clear();
    fs.closeSync(this.#lockFd);
    fs.rmSync(this.#lockPath, { force: true });
  }

  private acquireLock(): number {
    const attempt = (): number => {
      const fd = fs.openSync(this.#lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
      fs.fsyncSync(fd);
      return fd;
    };
    try {
      return attempt();
    } catch (error: unknown) {
      let stale = false;
      try {
        const pid = Number.parseInt(fs.readFileSync(this.#lockPath, 'utf8').trim(), 10);
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (probeError: unknown) {
            stale = (probeError as NodeJS.ErrnoException).code === 'ESRCH';
          }
        }
      } catch {
        stale = false;
      }
      if (!stale) throw new Error('A2A task store is already owned by another server.', { cause: error });
      fs.rmSync(this.#lockPath, { force: true });
      return attempt();
    }
  }

  private load(): void {
    if (!fs.existsSync(this.#file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.#file, 'utf8')) as unknown;
    } catch (error: unknown) {
      throw new Error(`Failed to read A2A task store: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(parsed)) throw new Error('A2A task store root must be an array.');
    for (const value of parsed) {
      const record = parseRecord(value);
      this.#records.set(record.taskId, record);
    }
  }

  private persist(): void {
    const temporary = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify([...this.#records.values()], null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, this.#file);
  }
}
