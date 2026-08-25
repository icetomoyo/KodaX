import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentTaskEvent,
  AgentTaskSnapshot,
  ExternalAgentRegistration,
} from '@kodax-ai/agent';
import { createRuntimeAgentExecutorPlaneStore } from './runtime-agent-store.js';

let tempDir: string | undefined;

function createTaskSnapshot(taskId: string): AgentTaskSnapshot {
  return {
    taskId,
    route: 'external',
    agentId: 'external:durable',
    objective: 'test',
    state: 'working',
    cancellation: 'none',
    registration: {
      agentId: 'external:durable',
      origin: 'external',
      executorId: 'reference-http',
      protocol: 'http',
      configurationRevision: 'rev-1',
      endpointIdentityHash: 'sha256:endpoint',
      capabilities: {
        streaming: 'supported',
        durableTasks: 'supported',
        inputRequired: 'supported',
        cancellation: 'supported',
        artifacts: 'supported',
      },
      effects: { remote: 'read', workspace: 'proposal' },
    },
    idempotencyKey: 'idem-1',
    dispatchAttempt: 1,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:01.000Z',
  };
}

function writeTaskSnapshot(
  root: string,
  directoryName: string,
  task: AgentTaskSnapshot,
): void {
  const directory = path.join(root, 'tasks', directoryName);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'snapshot.json'),
    `${JSON.stringify(task, null, 2)}\n`,
    'utf8',
  );
}

function writeTaskEvents(root: string, taskId: string, events: readonly AgentTaskEvent[]): void {
  const directoryName = createHash('sha256').update(taskId).digest('hex');
  const directory = path.join(root, 'tasks', directoryName);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'events.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
}

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('FEATURE_258 Runtime agent store', () => {
  it('durably round-trips registrations, snapshots and append-only events', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-agent-store-'));
    const store = createRuntimeAgentExecutorPlaneStore(tempDir);
    const registration: ExternalAgentRegistration = {
      agentId: 'external:durable',
      displayName: 'Durable',
      managementOwner: 'runtime-config-test',
      enabled: true,
      executorId: 'reference-http',
      protocol: 'http',
      configurationRevision: 'rev-1',
      endpointIdentityHash: 'sha256:endpoint',
      credentialRef: 'credential:durable',
      capabilities: {
        streaming: 'supported',
        durableTasks: 'supported',
        inputRequired: 'supported',
        cancellation: 'supported',
        artifacts: 'supported',
      },
      effects: { remote: 'read', workspace: 'proposal' },
    };
    const task: AgentTaskSnapshot = {
      taskId: '../task/with:path',
      route: 'external',
      agentId: registration.agentId,
      objective: 'test',
      state: 'working',
      cancellation: 'none',
      registration: {
        agentId: registration.agentId,
        origin: 'external',
        executorId: registration.executorId,
        protocol: registration.protocol,
        configurationRevision: registration.configurationRevision,
        endpointIdentityHash: registration.endpointIdentityHash,
        capabilities: registration.capabilities,
        effects: registration.effects,
      },
      idempotencyKey: 'idem-1',
      dispatchAttempt: 1,
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:01.000Z',
      remoteTaskId: 'remote-1',
    };
    const event: AgentTaskEvent = {
      taskId: task.taskId,
      seq: 1,
      timestamp: task.updatedAt,
      type: 'state',
      state: 'working',
      cancellation: 'none',
    };

    await store.saveRegistrations([registration]);
    await store.saveTaskRegistrationSnapshots?.([registration]);
    await store.saveTask(task);
    await store.appendEvent(event);

    const reopened = createRuntimeAgentExecutorPlaneStore(tempDir);
    expect(await reopened.loadRegistrations()).toEqual([registration]);
    expect(await reopened.loadTaskRegistrationSnapshots?.()).toEqual([registration]);
    expect(await reopened.loadTasks()).toEqual([task]);
    expect(await reopened.loadEvents(task.taskId)).toEqual([event]);
    const taskDirectory = createHash('sha256').update(task.taskId).digest('hex');
    expect(fs.readFileSync(
      path.join(tempDir, 'tasks', taskDirectory, 'events.jsonl'),
      'utf8',
    ).trim().split(/\r?\n/)).toHaveLength(1);
    expect(fs.existsSync(path.join(tempDir, 'snapshot.json'))).toBe(false);
  });

  it('rejects a task snapshot whose directory does not match its taskId hash', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-agent-store-'));
    const task = createTaskSnapshot('task-in-the-wrong-directory');
    writeTaskSnapshot(tempDir, 'wrong-directory', task);

    const store = createRuntimeAgentExecutorPlaneStore(tempDir);
    await expect(store.loadTasks()).rejects.toThrow(
      /Runtime agent task directory does not match taskId hash/,
    );
  });

  it('rejects duplicate persisted taskIds instead of silently selecting one', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-agent-store-'));
    const task = createTaskSnapshot('duplicate-task');
    const canonicalDirectory = createHash('sha256').update(task.taskId).digest('hex');
    writeTaskSnapshot(tempDir, canonicalDirectory, task);
    writeTaskSnapshot(tempDir, 'copied-snapshot', task);

    const store = createRuntimeAgentExecutorPlaneStore(tempDir);
    await expect(store.loadTasks()).rejects.toThrow(
      /Duplicate Runtime agent taskId: duplicate-task/,
    );
  });

  it('rejects an event ledger entry belonging to a different task', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-agent-store-'));
    const task = createTaskSnapshot('event-owner');
    await createRuntimeAgentExecutorPlaneStore(tempDir).saveTask(task);
    writeTaskEvents(tempDir, task.taskId, [{
      taskId: 'different-task',
      seq: 1,
      timestamp: task.updatedAt,
      type: 'state',
      state: 'working',
    }]);

    const store = createRuntimeAgentExecutorPlaneStore(tempDir);
    await expect(store.loadEvents(task.taskId)).rejects.toThrow(/event taskId does not match/i);
  });

  it('rejects a non-positive or non-increasing event sequence', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-agent-store-'));
    const task = createTaskSnapshot('invalid-event-sequence');
    await createRuntimeAgentExecutorPlaneStore(tempDir).saveTask(task);
    writeTaskEvents(tempDir, task.taskId, [
      {
        taskId: task.taskId,
        seq: 1,
        timestamp: task.updatedAt,
        type: 'state',
        state: 'working',
      },
      {
        taskId: task.taskId,
        seq: 1,
        timestamp: task.updatedAt,
        type: 'state',
        state: 'working',
      },
    ]);

    const store = createRuntimeAgentExecutorPlaneStore(tempDir);
    await expect(store.loadEvents(task.taskId)).rejects.toThrow(/strictly increasing positive sequence/i);
  });

  it('skips an unreadable task snapshot instead of failing the store scan', async () => {
    // An fs-level unreadable snapshot (disk-sector failure, filter state,
    // EIO/EISDIR) must never fail loadTasks — the store scan feeds Runtime
    // creation, so a corrupt historical snapshot would brick every startup.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-agent-store-'));
    const healthy = createTaskSnapshot('healthy-task');
    writeTaskSnapshot(
      tempDir,
      createHash('sha256').update(healthy.taskId).digest('hex'),
      healthy,
    );
    const unreadableDirectory = createHash('sha256').update('unreadable-task').digest('hex');
    // A directory named snapshot.json makes every read attempt fail at the
    // fs level — the same failure shape as a bad disk sector.
    fs.mkdirSync(
      path.join(tempDir, 'tasks', unreadableDirectory, 'snapshot.json'),
      { recursive: true },
    );

    const store = createRuntimeAgentExecutorPlaneStore(tempDir);
    const tasks = await store.loadTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.taskId).toBe('healthy-task');
  });
});
