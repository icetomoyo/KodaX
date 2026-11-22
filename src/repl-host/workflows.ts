/**
 * The REPL's workflow controls over a v2 Host. A v2 workflow belongs to the
 * Session that started it, so each call names that Session. v2 pushes no
 * workflow events; the Session's view carries each workflow's summary, and a
 * changed summary is the cue to read the workflow again.
 */
import type { WorkflowProcessEvent, WorkflowProcessSnapshot } from '@kodax-ai/agent';
import type { ManagedWorkflowSnapshot } from '@kodax-ai/coding';
import type { CommandCallbacks } from '@kodax-ai/repl';

import { HostProtocolError } from '../host-protocol/codec.js';
import { createRequestId, type HostCallResult, type KodaXHostClient } from '../host-protocol/host-client.js';
import type { ReplLeases } from './leases.js';

type HostWorkflow = HostCallResult<'workflow.get', 'local'>['workflow'];
type HostSummary = HostCallResult<'workflow.list', 'local'>['items'][number];
type ProcessItem = WorkflowProcessSnapshot['items'][number];
type WorkflowHostControl = NonNullable<CommandCallbacks['workflows']>;
type WorkflowSessionScope = NonNullable<Parameters<WorkflowHostControl['get']>[1]>;

const LIST_PAGE = 200;

/** v2 says `stopped` and `denied` where the REPL's process view says `cancelled` and `failed`. */
const PROCESS_STATUS: Readonly<Record<string, WorkflowProcessSnapshot['status']>> = {
  running: 'running', paused: 'paused', completed: 'completed', failed: 'failed', denied: 'failed', stopped: 'cancelled',
};

const iso = (ms: number): string => new Date(ms).toISOString();

function sessionOf(scope: WorkflowSessionScope | undefined): string {
  if (scope === undefined) throw new Error('A v2 Host reaches a workflow through the Session that started it.');
  return scope.sessionId;
}

/** Refusals that mean the workflow is not there to act on: gone, ended or stopping. */
function notActionable(error: unknown): boolean {
  return error instanceof HostProtocolError && (error.kodaxCode === 'not_found' || error.kodaxCode === 'invalid_state');
}

function toItem({ startedAt, endedAt, kind, status, origin, ...item }: HostWorkflow['items'][number]): ProcessItem {
  return {
    ...item,
    kind: kind as ProcessItem['kind'],
    status: status as ProcessItem['status'],
    ...(origin !== undefined ? { origin: origin as NonNullable<ProcessItem['origin']> } : {}),
    ...(startedAt !== undefined ? { startedAt: iso(startedAt) } : {}),
    ...(endedAt !== undefined ? { endedAt: iso(endedAt) } : {}),
  };
}

function toProcess(sessionId: string, workflow: HostWorkflow): WorkflowProcessSnapshot {
  const {
    id, name, status, startedAt, updatedAt, endedAt, runId, source, resumedFromId, result, items,
    stop: _stop, spawnedAgents: _spawned, runDir: _runDir, ...rest
  } = workflow;
  return {
    ...rest,
    runId: id,
    workflowName: name,
    status: PROCESS_STATUS[status] ?? 'failed',
    startedAt: iso(startedAt),
    updatedAt: iso(updatedAt ?? endedAt ?? startedAt),
    ...(endedAt !== undefined ? { elapsedMs: endedAt - startedAt } : {}),
    ...(source !== undefined ? { source: source as NonNullable<WorkflowProcessSnapshot['source']> } : {}),
    ...(resumedFromId !== undefined ? { resumedFromRunId: resumedFromId } : {}),
    ...(result !== undefined ? { resultSummary: result } : {}),
    // The REPL checks a workflow belongs to its own Session before it stops it.
    hostMetadata: { ownerSessionId: sessionId, ...(runId !== undefined ? { ownerRunId: runId } : {}) },
    items: items.map(toItem),
  };
}

function toManaged({ id, name, status, spawnedAgents, startedAt, endedAt, error, stop }: HostSummary): ManagedWorkflowSnapshot {
  return {
    runId: id,
    workflow: name,
    status: status as ManagedWorkflowSnapshot['status'],
    totalSpawned: spawnedAgents,
    // v2 counts no events and keeps the workflow's folder to itself in a summary; `get` names the folder.
    eventCount: 0,
    runDir: '',
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(stop !== undefined ? { stop: stop as NonNullable<ManagedWorkflowSnapshot['stop']> } : {}),
  };
}

/** What a summary in the view says changed; the same key twice means nothing to read. */
const summaryKey = (summary: HostSummary): string =>
  `${summary.status}|${summary.updatedAt ?? ''}|${summary.spawnedAgents}|${summary.stop?.state ?? ''}`;

const isFinal = (snapshot: WorkflowProcessSnapshot): boolean =>
  snapshot.status !== 'running' && snapshot.status !== 'paused';

export function createReplWorkflows(client: KodaXHostClient<'local'>, leases: ReplLeases): WorkflowHostControl {
  async function get(runId: string, scope?: WorkflowSessionScope): Promise<WorkflowProcessSnapshot | undefined> {
    const sessionId = sessionOf(scope);
    try {
      return toProcess(sessionId, (await client.call('workflow.get', { sessionId, workflowId: runId })).workflow);
    } catch (error: unknown) {
      if (error instanceof HostProtocolError && error.kodaxCode === 'not_found') return undefined;
      throw error;
    }
  }

  /** Runs a pause or resume and reads a workflow that is not there to act on as `false`. */
  async function steer(method: 'workflow.pause' | 'workflow.resume', runId: string, scope?: WorkflowSessionScope): Promise<boolean> {
    try {
      await client.call(method, { requestId: createRequestId(), sessionId: sessionOf(scope), workflowId: runId });
      return true;
    } catch (error: unknown) {
      if (notActionable(error)) return false;
      throw error;
    }
  }

  return {
    async start({ sessionId, source, args, provider, model, ...input }) {
      // v2 runs a workflow in the Session's project and keeps no display lineage, so `projectRoot` and `metadata` stay here.
      if (sessionId === undefined) throw new Error('A v2 Host starts a workflow as a Run of a Session.');
      const leased = await leases({ kind: 'workflow', input: { sessionId, source, ...input,
        ...(args !== undefined ? { args } : {}), ...(provider !== undefined ? { provider } : {}), ...(model !== undefined ? { model } : {}) } });
      try {
        const { runId } = await client.call('workflow.start', {
          requestId: createRequestId(), sessionId,
          ...(source.kind === 'name' ? { name: source.name } : {}),
          ...(source.kind === 'request' ? { request: source.request } : {}),
          ...(source.kind === 'inline' ? { script: { manifest: source.manifest as Record<string, unknown>, source: source.source } } : {}),
          ...(args !== undefined ? { args: args as Record<string, unknown> } : {}),
          ...(provider !== undefined ? { provider } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(leased !== undefined ? { leases: leased } : {}),
        });
        return { kind: 'started', runId };
      } catch (error: unknown) {
        if (error instanceof HostProtocolError && error.reason === 'workflow_declined') return { kind: 'declined', reason: error.message };
        throw error;
      }
    },
    async list(scope) {
      const sessionId = sessionOf(scope);
      const found: ManagedWorkflowSnapshot[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.call('workflow.list', { sessionId, limit: LIST_PAGE, ...(cursor !== undefined ? { cursor } : {}) });
        found.push(...page.items.map(toManaged));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return found;
    },
    get,
    subscribe({ runId, sessionId }, listener, onError) {
      if (sessionId === undefined) throw new Error('A v2 Host follows workflows through the Session that started them.');
      let open = true;
      const seen = new Map<string, string>();
      const fail = (error: unknown): void => { if (open) onError?.(error); };
      const emit = async (workflowId: string): Promise<void> => {
        const snapshot = await get(workflowId, { sessionId });
        if (!open || snapshot === undefined) return;
        const event: WorkflowProcessEvent = isFinal(snapshot)
          ? { type: 'workflow_finished', snapshot }
          : { type: 'workflow_updated', snapshot };
        listener(event);
      };
      // One read at a time, so an older reply never lands after a newer one.
      let reading = Promise.resolve();
      let first = true;
      const observation = client.observeSession(sessionId, {
        onView: (view) => {
          for (const summary of view.workflows) {
            if (runId !== undefined && summary.id !== runId) continue;
            const key = summaryKey(summary);
            if (seen.get(summary.id) === key) continue;
            seen.set(summary.id, key);
            // The first view only records where each workflow stands; the REPL reads the current state itself once ready.
            if (!first) reading = reading.then(() => emit(summary.id)).catch(fail);
          }
          first = false;
        },
        onClosed: reason => fail(new Error(`The Host stopped following the Session's workflows: ${reason}`)),
      });
      observation.catch(fail);
      return {
        ready: observation.then(() => undefined),
        close() {
          open = false;
          void observation.then(found => found.close(), () => undefined);
        },
      };
    },
    pause: (runId, scope) => steer('workflow.pause', runId, scope),
    resume: (runId, scope) => steer('workflow.resume', runId, scope),
    async stop(runId, scope) {
      const sessionId = sessionOf(scope);
      // v2 takes a Stop for an ended workflow as done; the REPL asks to be told there was nothing left to stop.
      const before = await get(runId, scope);
      if (before === undefined || isFinal(before)) return false;
      try {
        await client.call('workflow.stop', { requestId: createRequestId(), sessionId, workflowId: runId });
        return true;
      } catch (error: unknown) {
        if (notActionable(error)) return false;
        throw error;
      }
    },
  };
}
