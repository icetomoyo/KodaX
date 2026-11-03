import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { emitKodaXDiagnostic, tryAcquireStorageFileLock, withStorageFileLock } from '@kodax-ai/agent';

import type {
  AgentExecutorPlaneStore,
  AgentTaskEvent,
  AgentTaskSnapshot,
  ExternalAgentRegistration,
} from '@kodax-ai/agent';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRegistration(value: unknown): value is ExternalAgentRegistration {
  if (!isRecord(value)) return false;
  return typeof value.agentId === 'string'
    && typeof value.displayName === 'string'
    && (value.managementOwner === undefined
      || (typeof value.managementOwner === 'string' && value.managementOwner.length > 0))
    && typeof value.enabled === 'boolean'
    && typeof value.executorId === 'string'
    && (value.protocol === 'a2a' || value.protocol === 'mcp' || value.protocol === 'http')
    && typeof value.configurationRevision === 'string'
    && typeof value.endpointIdentityHash === 'string'
    && isRecord(value.capabilities)
    && isRecord(value.effects);
}

function isTask(value: unknown): value is AgentTaskSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.taskId === 'string'
    && (value.route === 'local' || value.route === 'external')
    && typeof value.agentId === 'string'
    && typeof value.objective === 'string'
    && typeof value.state === 'string'
    && typeof value.cancellation === 'string'
    && isRecord(value.registration)
    && typeof value.idempotencyKey === 'string'
    && typeof value.dispatchAttempt === 'number'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isEvent(value: unknown): value is AgentTaskEvent {
  if (!isRecord(value)) return false;
  return typeof value.taskId === 'string'
    && Number.isSafeInteger(value.seq)
    && typeof value.timestamp === 'string'
    && typeof value.type === 'string';
}

export function parseRuntimeAgentTaskSnapshot(raw: string, taskId: string): AgentTaskSnapshot {
  const task: unknown = JSON.parse(raw);
  if (!isTask(task) || task.taskId !== taskId) throw new Error('Runtime agent task snapshot does not match its storage binding.');
  // Explicit replacement must satisfy the operational contract. Keep the
  // historical scan predicate separate; never invent missing captured authority.
  const registration = task.registration;
  if (!isRecord(registration) || !isRecord(registration.capabilities) || !isRecord(registration.effects)) {
    throw new Error('Recovery snapshot requires a complete task registration.');
  }
  const capabilities = registration.capabilities, effects = registration.effects;
  if (!['agentId', 'executorId', 'configurationRevision'].every(key => typeof registration[key] === 'string' && registration[key].length > 0)
    || !['native', 'constructed', 'external'].includes(registration.origin)
    || !['native', 'a2a', 'mcp', 'http'].includes(registration.protocol)
    || (registration.endpointIdentityHash !== undefined && typeof registration.endpointIdentityHash !== 'string')
    || !['streaming', 'durableTasks', 'inputRequired', 'cancellation', 'artifacts']
      .every(key => ['supported', 'unsupported', 'conditional'].includes(capabilities[key] as string))
    || !['none', 'read', 'write', 'unknown'].includes(effects.remote)
    || !['none', 'proposal', 'direct'].includes(effects.workspace)
    || !['submitted', 'working', 'input-required', 'auth-required', 'completed', 'failed', 'canceled', 'rejected', 'unknown'].includes(task.state)
    || !['none', 'requested', 'confirmed', 'unsupported', 'failed', 'unknown'].includes(task.cancellation)) {
    throw new Error('Recovery snapshot has an invalid task registration or state.');
  }
  return task;
}

export function parseRuntimeAgentEventLedger(content: string, taskId: string): readonly AgentTaskEvent[] {
  const raw = content.trim();
  if (!raw) return [];
  let previousSequence = 0;
  return raw.split(/\r?\n/).map((line, index) => {
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; }
    catch { throw new Error(`Invalid Runtime agent event JSON at line ${index + 1}`); }
    if (!isEvent(parsed)) throw new Error(`Invalid Runtime agent event shape at line ${index + 1}`);
    if (parsed.taskId !== taskId) throw new Error(`Runtime agent event taskId does not match its ledger at line ${index + 1}`);
    if (parsed.seq <= previousSequence) throw new Error(`Runtime agent events require a strictly increasing positive sequence at line ${index + 1}`);
    previousSequence = parsed.seq;
    return parsed;
  });
}

function parseJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse Runtime agent store file ${file}: ${message}`);
  }
}

function readList<T>(
  file: string,
  guard: (value: unknown) => value is T,
): readonly T[] {
  if (!fs.existsSync(file)) return [];
  const parsed = parseJson(file);
  if (!Array.isArray(parsed) || !parsed.every(guard)) {
    throw new Error(`Runtime agent store file has an invalid array shape: ${file}`);
  }
  return structuredClone(parsed);
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function taskDirectory(root: string, taskId: string): string {
  const directoryKey = createHash('sha256').update(taskId).digest('hex');
  return path.join(root, directoryKey);
}

function readLedger(file: string, taskId: string): { events: readonly AgentTaskEvent[]; needsSeparator: boolean } {
  let content: string;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], needsSeparator: false }; throw error; }
  return { events: parseRuntimeAgentEventLedger(content, taskId), needsSeparator: content.length > 0 && !content.endsWith('\n') };
}

export function createRuntimeAgentExecutorPlaneStore(
  agentStoreDir: string,
  options: { exclusive?: boolean } = {},
): AgentExecutorPlaneStore & { close(): void } {
  const root = path.resolve(agentStoreDir);
  const lockFile = path.join(root, '.store.lock');
  const lease = options.exclusive ? tryAcquireStorageFileLock(lockFile) : undefined;
  if (options.exclusive && !lease) throw new Error(`Runtime agent storage is busy or already owned: ${lockFile}`);
  let closed = false;
  const mutate = async (operation: () => void): Promise<void> => {
    if (closed) throw new Error('Runtime agent storage is closed.');
    if (lease) operation();
    else await withStorageFileLock(lockFile, async () => { if (closed) throw new Error('Runtime agent storage is closed.'); operation(); });
  };
  const registrationsFile = path.join(root, 'registrations.json');
  const taskRegistrationSnapshotsFile = path.join(root, 'task-registration-snapshots.json');
  const tasksDir = path.join(root, 'tasks');
  const ledgerCursors = new Map<string, { size: number; mtimeMs: number; ino: number; seq: number }>();
  const assertTaskWritable = (taskId: string): void => {
    const fence = path.join(taskDirectory(tasksDir, taskId), '.repair-fence');
    try { fs.lstatSync(fence); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    throw new Error(`Runtime agent storage repair requires verified reconciliation; task remains unknown: ${fence}`);
  };
  return {
    close() { if (closed) return; lease?.release(); closed = true; },
    async loadRegistrations() {
      return readList(registrationsFile, isRegistration);
    },
    async saveRegistrations(registrations) {
      await mutate(() => writeJsonAtomic(registrationsFile, registrations));
    },
    async loadTaskRegistrationSnapshots() {
      return readList(taskRegistrationSnapshotsFile, isRegistration);
    },
    async saveTaskRegistrationSnapshots(registrations) {
      await mutate(() => writeJsonAtomic(taskRegistrationSnapshotsFile, registrations));
    },
    async loadTasks() {
      if (!fs.existsSync(tasksDir)) return [];
      const snapshots: Array<{
        directoryName: string;
        file: string;
        task: AgentTaskSnapshot;
      }> = [];
      for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(tasksDir, entry.name, 'snapshot.json');
        if (!fs.existsSync(file)) continue;
        let parsed: unknown;
        try {
          parsed = parseJson(file);
        } catch (error: unknown) {
          // An fs-level unreadable snapshot (disk-sector failure, filter
          // state, EIO) must never fail the store scan — this feeds Runtime
          // creation, so one corrupt historical snapshot would brick every
          // startup for external-agent embedders. Skip it visibly instead.
          emitKodaXDiagnostic({
            source: 'runtime.agent-store',
            level: 'warn',
            message: `Unreadable Runtime agent task snapshot skipped: ${file} `
              + '(the snapshot stays on disk untouched)',
            detail: error,
          });
          continue;
        }
        if (!isTask(parsed)) throw new Error(`Invalid Runtime agent task shape: ${file}`);
        snapshots.push({ directoryName: entry.name, file, task: parsed });
      }
      const taskIds = new Set<string>();
      for (const { task } of snapshots) {
        if (taskIds.has(task.taskId)) {
          throw new Error(`Duplicate Runtime agent taskId: ${task.taskId}`);
        }
        taskIds.add(task.taskId);
      }
      for (const { directoryName, file, task } of snapshots) {
        const expectedDirectoryName = path.basename(taskDirectory(tasksDir, task.taskId));
        if (directoryName !== expectedDirectoryName) {
          throw new Error(`Runtime agent task directory does not match taskId hash: ${file}`);
        }
      }
      return snapshots.map(({ task }) => task);
    },
    async saveTask(task) {
      await mutate(() => { assertTaskWritable(task.taskId); writeJsonAtomic(path.join(taskDirectory(tasksDir, task.taskId), 'snapshot.json'), task); });
    },
    async loadEvents(taskId) {
      assertTaskWritable(taskId);
      const { events } = readLedger(path.join(taskDirectory(tasksDir, taskId), 'events.jsonl'), taskId);
      assertTaskWritable(taskId);
      return events;
    },
    async appendEvent(event) {
      await mutate(() => {
      assertTaskWritable(event.taskId);
      const file = path.join(taskDirectory(tasksDir, event.taskId), 'events.jsonl');
      let observed: fs.Stats | undefined;
      try { observed = fs.statSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const cursor = ledgerCursors.get(event.taskId);
      const unchanged = observed && cursor && cursor.size === observed.size && cursor.mtimeMs === observed.mtimeMs && cursor.ino === observed.ino;
      const ledger = unchanged ? undefined : readLedger(file, event.taskId);
      const previous = unchanged ? cursor.seq : ledger!.events.at(-1)?.seq ?? 0;
      if (!Number.isSafeInteger(event.seq) || event.seq <= previous) throw new Error('Runtime agent event sequence must increase before appending.');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${ledger?.needsSeparator ? '\n' : ''}${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
      const after = fs.statSync(file);
      ledgerCursors.set(event.taskId, { size: after.size, mtimeMs: after.mtimeMs, ino: after.ino, seq: event.seq });
      });
    },
  };
}
