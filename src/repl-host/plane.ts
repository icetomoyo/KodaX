/**
 * The REPL's client plane over a v2 Host. The REPL names its operations in v1
 * terms; each one here is the v2 call that does the same, with the leases the
 * CLI lends a Run it starts.
 */
import type {
  ClientInteractionResponse,
  ClientRunStopReceipt,
  ClientSessionSettingsPatch,
} from '@kodax-ai/coding/client-contract';
import type { KodaXInputArtifact } from '@kodax-ai/coding';
import type { ClientRoundOutcome, InkClientPlane } from '@kodax-ai/repl';

import { HostProtocolError } from '../host-protocol/codec.js';
import { createRequestId, type HostCallParams, type HostCallResult, type KodaXHostClient } from '../host-protocol/host-client.js';
import { createItemReader } from './item-reader.js';
import type { ReplLeases } from './leases.js';
import { createClientViewMapper, toClientItem, toClientSession, type ClientViewMapper } from './view.js';

type HostRun = HostCallResult<'run.get', 'local'>['run'];
type HostResponse = HostCallParams<'interaction.respond'>['response'];
type HostSettingsPatch = HostCallParams<'session.settings.update'>['patch'];

/** The longest wait the Host allows in one `run.wait`. */
const RUN_WAIT_MS = 60_000;

const LIVE_PHASES = new Set(['queued', 'running', 'waiting_agent', 'recovering', 'waiting_permission', 'waiting_user_input']);

/** v1 settings v2 does not take: `effort` carries what they meant. */
const RETIRED_SETTINGS = new Set(['thinking', 'reasoningMode', 'agentMode']);

function hasCode(error: unknown, code: string): boolean {
  return error instanceof HostProtocolError && error.kodaxCode === code;
}

function toHostSettings(patch: ClientSessionSettingsPatch): HostSettingsPatch {
  return Object.fromEntries(Object.entries(patch).filter(([key]) => !RETIRED_SETTINGS.has(key))) as HostSettingsPatch;
}

function toHostResponse(response: ClientInteractionResponse): HostResponse {
  return (response.kind === 'cancel' ? { ...response, kind: 'dismiss' } : response) as HostResponse;
}

function toLocalAttachments(artifacts: readonly KodaXInputArtifact[] | undefined) {
  if (artifacts === undefined || artifacts.length === 0) return {};
  return {
    localAttachments: artifacts.map(({ kind, path, mediaType, source, description, ...rest }) => ({
      kind, path,
      ...(mediaType !== undefined ? { mediaType } : {}),
      ...('name' in rest && rest.name !== undefined ? { name: rest.name } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(description !== undefined ? { description } : {}),
    })),
  };
}

/** What became of a Run, in the shape the REPL's round loop reads. */
export function toRoundOutcome(run: HostRun): ClientRoundOutcome {
  const status = run.outcome?.status;
  if (status === 'completed') {
    // The Host keeps the conversation; the REPL redraws it from the view, so the result carries no messages.
    return { phase: run.phase, result: { success: true, lastText: '', messages: [], sessionId: run.sessionId } };
  }
  if (status === 'failed' || status === 'unknown') {
    const why = run.outcome?.failure?.safeMessage ?? run.outcome?.message;
    return { phase: run.phase, error: why ?? `Run ${run.id} ended without a known outcome.` };
  }
  return { phase: run.phase };
}

/** A Stop the Host recorded; whether the Run has ended yet is read from the Run. */
function toStopReceipt(run: HostRun): ClientRunStopReceipt {
  return {
    runId: run.id, sessionId: run.sessionId, accepted: true, phase: run.phase,
    state: run.outcome === undefined ? 'unknown' : 'confirmed',
    outcome: run.outcome?.status ?? 'unknown',
  };
}

export function createReplClientPlane(client: KodaXHostClient<'local'>, leases: ReplLeases): InkClientPlane {
  const reader = createItemReader(client);
  /** The newest observation of each Session, for the text version an item read reports. */
  const mappers = new Map<string, ClientViewMapper>();
  /** How items read from saved history were shown, for the same check on their reads. */
  const historyStates = new Map<string, ReturnType<typeof toClientItem>['outputState']>();

  const readRun = async (runId: string): Promise<HostRun> => (await client.call('run.get', { runId })).run;

  return {
    async submit(input) {
      const leased = await leases({ kind: 'input', input });
      const { input: accepted } = await client.call('input.submit', {
        requestId: input.inputId, sessionId: input.sessionId, text: input.text,
        ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
        ...(input.targetRunId !== undefined ? { targetRunId: input.targetRunId } : {}),
        ...toLocalAttachments(input.inputArtifacts),
        ...(leased !== undefined ? { leases: leased } : {}),
      });
      return { state: accepted.state, ...(accepted.runId !== undefined ? { runId: accepted.runId } : {}) };
    },
    async withdraw(sessionId, inputId) {
      try {
        const { input } = await client.call('input.withdraw', { requestId: createRequestId(), sessionId, inputId });
        const artifacts = input.localAttachments as readonly KodaXInputArtifact[] | undefined;
        return { text: input.text, ...(artifacts !== undefined ? { inputArtifacts: artifacts } : {}) };
      } catch (error: unknown) {
        // The REPL reads `undefined` as "not taken back": the input started, or was never queued.
        if (hasCode(error, 'not_found') || hasCode(error, 'conflict')) return undefined;
        throw error;
      }
    },
    async readInput(sessionId, inputId) {
      try {
        return { state: (await client.call('input.get', { sessionId, inputId })).input.state };
      } catch (error: unknown) {
        if (hasCode(error, 'not_found')) return null;
        throw error;
      }
    },
    async awaitRun(_sessionId, runId) {
      for (;;) {
        try {
          return toRoundOutcome((await client.call('run.wait', { runId, timeoutMs: RUN_WAIT_MS })).run);
        } catch (error: unknown) {
          if (!hasCode(error, 'timeout')) throw error;
        }
      }
    },
    async stop(runId) {
      await client.call('run.stop', { requestId: createRequestId(), runId });
      return toStopReceipt(await readRun(runId));
    },
    async cancelSession(input) {
      await client.call('session.cancel', { requestId: input.requestId, sessionId: input.sessionId, ifRunId: input.expectedRunId });
      return { ...input, frontier: 0, receipts: [toStopReceipt(await readRun(input.expectedRunId))] };
    },
    async activeRun(sessionId) {
      const { items } = await client.call('run.list', { sessionId, limit: 20 });
      return items.find(run => LIVE_PHASES.has(run.phase))?.id;
    },
    async executeTool(input) {
      const leased = await leases({ kind: 'tool', input });
      const { run } = await client.call('run.startTool', {
        requestId: input.inputId, sessionId: input.sessionId, tool: input.name, input: input.input, text: input.rawInput,
        ...(leased !== undefined ? { leases: leased } : {}),
      });
      return { runId: run.id, sessionId: run.sessionId };
    },
    async observe(sessionId, onView, options) {
      const map = createClientViewMapper();
      mappers.set(sessionId, map);
      let interrupted = false;
      const stopWatching = client.onConnectionChange((state) => {
        if (state.state !== 'reconnecting' || interrupted) return;
        interrupted = true;
        options?.onStatus?.({ state: 'interrupted', ...(state.error !== undefined ? { message: state.error.message } : {}) });
      });
      const observation = await client.observeSession(sessionId, {
        onView: (view) => {
          onView(map(view));
          if (!interrupted) return;
          interrupted = false;
          options?.onStatus?.({ state: 'live' });
        },
        onClosed: reason => options?.onStatus?.({ state: 'closed', reason: 'unavailable', message: reason }),
      }).catch((error: unknown) => { stopWatching(); throw error; });
      options?.onStatus?.({ state: 'live' });
      return () => {
        stopWatching();
        observation.close();
        if (mappers.get(sessionId) === map) mappers.delete(sessionId);
      };
    },
    readItem: (sessionId, itemId, options) => {
      const read = typeof options === 'number' ? { offset: options } : options ?? {};
      return reader.read(sessionId, itemId, read, mappers.get(sessionId)?.textVersion(itemId));
    },
    async readHistory(sessionId, options) {
      try {
        const page = await client.call('history.read', {
          sessionId,
          ...(options?.limit !== undefined ? { limit: Math.min(options.limit, 200) } : {}),
          ...(options?.cursor !== undefined ? { cursor: options.cursor } : {}),
        });
        const items = page.items.map(item => toClientItem(item));
        for (const item of items) historyStates.set(`${sessionId}\0${item.id}`, item.outputState);
        return {
          items,
          // v2 tells a changed conversation by failing the cursor, so every page is of one revision.
          revision: '', sourceRevision: '',
          status: page.status as 'resolved' | 'partial' | 'ambiguous',
          // v2 counts the entries an issue affects and does not name them.
          issues: page.issues.map(({ code, message, entryCount }) => ({
            code, message, entryCount, occurrenceCount: entryCount, entryIds: [],
          })),
          oversized: [],
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
          ...(page.newerCursor !== undefined ? { newerCursor: page.newerCursor } : {}),
        };
      } catch (error: unknown) {
        // The REPL rereads a window from the start on this code.
        if (hasCode(error, 'resync_required')) throw Object.assign(new Error((error as Error).message), { code: 'resync_required' });
        throw error;
      }
    },
    readHistoryEntry: (sessionId, itemId, options) => reader.read(sessionId, itemId, options ?? {}, {
      textRevision: 0, outputState: historyStates.get(`${sessionId}\0${itemId}`),
    }),
    async respondInteraction(requestId, response) {
      const { status } = await client.call('interaction.respond', {
        requestId: createRequestId(), interactionId: requestId, response: toHostResponse(response),
      });
      return status !== 'already_resolved';
    },
    async updateSettings(sessionId, patch) {
      const settings = toHostSettings(patch);
      if (Object.keys(settings).length === 0) return;
      await client.call('session.settings.update', { requestId: createRequestId(), sessionId, patch: settings });
    },
    async appendNotice(sessionId, { content, source }) {
      await client.call('session.notice.append', {
        requestId: createRequestId(), sessionId, text: content, ...(source !== undefined ? { source } : {}),
      });
    },
    openSide: async sessionId => toClientSession(
      (await client.call('session.side.open', { requestId: createRequestId(), sessionId })).session,
    ),
    async delete(sessionId) {
      await client.call('session.delete', { requestId: createRequestId(), sessionId });
    },
  };
}
