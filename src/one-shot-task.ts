/**
 * One-shot CLI execution on the Host over v2. The Host owns the Session, the
 * input and the Run; this module picks the Session, applies the invocation's
 * flags for this Run only, shows the Run's progress from the Session view and
 * turns the Run's outcome into the result the CLI reports.
 */
import type { KodaXOptions, KodaXResult } from '@kodax-ai/coding';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import { mapLegacyReasoningModeToEffortIntent } from '@kodax-ai/llm';
import { getGitRoot } from '@kodax-ai/repl';

import { HostProtocolError } from './host-protocol/codec.js';
import {
  createRequestId,
  type HostCallParams,
  type HostCallResult,
  type HostSessionObservation,
  type KodaXHostClient,
} from './host-protocol/host-client.js';
import type { LocalSessionView } from './host-protocol/view.js';
import { createOneShotProgress } from './one-shot-progress.js';
import type { ReplLeases } from './repl-host/leases.js';

type HostRun = HostCallResult<'run.get', 'local'>['run'];
type SettingsPatch = HostCallParams<'session.settings.update'>['patch'];
type Settings = HostCallResult<'session.settings.get', 'local'>['settings'];

/** The longest wait the Host allows in one `run.wait`. */
const RUN_WAIT_MS = 60_000;
/** Sessions read per page while looking for the one to continue. */
const LIST_PAGE = 200;

const NO_APPROVAL = 'The non-interactive CLI cannot approve permission requests. Run interactively to review this action.';

function hasCode(error: unknown, code: string): boolean {
  return error instanceof HostProtocolError && error.kodaxCode === code;
}

/**
 * A Run's outcome as the CLI's result. A Run that ended with an answer gives
 * it, whether or not it succeeded; a Run stopped part-way is interrupted; one
 * that failed without an answer, or whose end the Host cannot confirm, throws
 * the reason, so it is never taken for success.
 */
export function projectOneShotOutcome(run: HostRun): KodaXResult {
  const outcome = run.outcome;
  const status = outcome?.status ?? 'unknown';
  const answer = {
    sessionId: run.sessionId,
    messages: [],
    lastText: outcome?.finalText ?? '',
    ...(outcome?.signal !== undefined ? { signal: outcome.signal.toUpperCase() as KodaXResult['signal'] } : {}),
    ...(outcome?.signalReason !== undefined ? { signalReason: outcome.signalReason } : {}),
    ...(outcome?.limitReached === true ? { limitReached: true } : {}),
  };
  if (status === 'completed') return { ...answer, success: true };
  if (status === 'cancelled' || status === 'interrupted') {
    return { ...answer, success: false, interrupted: true, signal: 'BLOCKED', signalReason: answer.signalReason ?? 'Runtime run cancelled.' };
  }
  const answered = outcome?.signal !== undefined || outcome?.limitReached === true;
  if (status === 'failed' && outcome?.failure === undefined && answered) return { ...answer, success: false };
  throw new Error(outcome?.failure?.safeMessage ?? outcome?.message ?? `Run ${run.id} ended without a known outcome.`);
}

export interface OneShotSessionPlan {
  readonly sessionId: string;
  readonly resumed: boolean;
  /** The Host deletes a temporary Session when its Run ends, so its settings need no restoring. */
  readonly temporary: boolean;
}

/** The newest Session of the project that has a conversation, as `-c` continues it. */
async function newestConversation(client: KodaXHostClient<'local'>, projectRoot: string): Promise<string | undefined> {
  let cursor: string | undefined;
  do {
    const page = await client.call('session.list', { projectRoot, limit: LIST_PAGE, ...(cursor !== undefined ? { cursor } : {}) });
    const found = page.items.find(session => (session.messageCount ?? 0) > 0);
    if (found !== undefined) return found.id;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return undefined;
}

export async function resolveOneShotSession(
  client: KodaXHostClient<'local'>,
  options: KodaXOptions,
  prompt: string,
): Promise<OneShotSessionPlan> {
  const cwd = process.cwd();
  const temporary = options.session === undefined;
  const create = async (): Promise<string> => (await client.call('session.create', {
    requestId: createRequestId(), title: prompt.slice(0, 50), projectRoot: cwd, surface: 'cli',
    ...(temporary ? { temporary: true } : {}),
  })).session.id;

  const named = options.session?.id;
  if (named !== undefined) {
    try {
      const { session } = await client.call('session.get', { sessionId: named });
      if (session.archived === true) throw new Error(`Session is archived: ${session.id}`);
      return { sessionId: session.id, resumed: true, temporary: false };
    } catch (error: unknown) {
      if (!hasCode(error, 'not_found')) throw error;
      throw new Error(`Session not found: ${named}`);
    }
  }
  if (options.session?.resume === true || options.session?.autoResume === true) {
    const recent = await newestConversation(client, (await getGitRoot(cwd)) ?? cwd);
    if (recent !== undefined) return { sessionId: recent, resumed: true, temporary: false };
  }
  return { sessionId: await create(), resumed: false, temporary };
}

/** The flags that shape this Run, as Session settings. v2 has only `effort`, so `--reasoning` and `--thinking` become one. */
function settingsPatch(options: KodaXOptions): SettingsPatch {
  const effort = options.effort
    ?? (options.reasoningMode !== undefined ? mapLegacyReasoningModeToEffortIntent(options.reasoningMode) : undefined);
  return {
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(options.workMode !== undefined ? { workMode: options.workMode } : {}),
    ...(options.maxIter !== undefined ? { maxIter: options.maxIter } : {}),
    ...(options.context?.repoIntelligenceMode !== undefined ? { repoIntelligenceMode: options.context.repoIntelligenceMode } : {}),
    ...(options.context?.repoIntelligenceTrace !== undefined ? { repoIntelligenceTrace: options.context.repoIntelligenceTrace } : {}),
  } as SettingsPatch;
}

/** Puts back what the Session had before this invocation. Work mode stays: it belongs to the Session once a Run starts. */
function restorePatch(previous: Settings, applied: SettingsPatch): SettingsPatch {
  const restore: Record<string, unknown> = {};
  for (const key of Object.keys(applied)) {
    if (key === 'workMode') continue;
    restore[key] = (previous as Record<string, unknown>)[key] ?? null;
  }
  return restore as SettingsPatch;
}

export interface OneShotClientTaskInput {
  readonly client: KodaXHostClient<'local'>;
  /** The keys the CLI lends the Run. */
  readonly leases: ReplLeases;
  readonly options: KodaXOptions;
  readonly prompt: string;
  /** Abort asks the Host to stop the Run; how it ended still decides the result. */
  readonly abortSignal?: AbortSignal;
}

/**
 * Exit-code contract for the one-shot CLI: success 0, interrupted 130
 * (SIGINT convention), anything else — limit reached or failed — 1.
 */
export { exitCodeForOneShotResult } from './one-shot-exit-code.js';

/** Turns down every question and approval of `runId`: nobody is there to answer. */
function createUnattended(client: KodaXHostClient<'local'>, events: KodaXOptions['events']) {
  const answered = new Set<string>();
  let runId: string | undefined;
  let view: LocalSessionView | undefined;
  const decline = (): void => {
    for (const interaction of view?.interactions ?? []) {
      if (runId === undefined || interaction.runId !== runId || answered.has(interaction.id)) continue;
      answered.add(interaction.id);
      const response = interaction.kind === 'permission'
        ? { kind: 'permission' as const, decision: { type: 'reject' as const, reason: NO_APPROVAL } }
        : { kind: 'skip' as const, reason: 'non_interactive' as const };
      void client.call('interaction.respond', { requestId: createRequestId(), interactionId: interaction.id, response })
        .catch((error: unknown) => {
          emitKodaXDiagnostic({ source: 'kodax.one-shot', level: 'error', message: 'Failed to dismiss an unattended interaction.', detail: error });
          events?.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
    }
  };
  return {
    view(next: LocalSessionView) { view = next; decline(); },
    follow(id: string) { runId = id; decline(); },
  };
}

async function awaitRun(client: KodaXHostClient<'local'>, runId: string): Promise<HostRun> {
  for (;;) {
    try {
      const { run } = await client.call('run.wait', { runId, timeoutMs: RUN_WAIT_MS });
      if (run.outcome !== undefined) return run;
    } catch (error: unknown) {
      if (!hasCode(error, 'timeout')) throw error;
    }
  }
}

export async function runOneShotClientTask(input: OneShotClientTaskInput): Promise<KodaXResult> {
  const { client, options, prompt } = input;
  const plan = await resolveOneShotSession(client, options, prompt);
  const patch = settingsPatch(options);
  // The flags hold for this Run only: a kept Session gets back what it had,
  // unless another client changed its settings meanwhile, whose change stands.
  const restore = Object.keys(patch).length > 0 && !plan.temporary;
  const previous = restore ? await client.call('session.settings.get', { sessionId: plan.sessionId }) : undefined;
  let appliedRevision: string | undefined;
  if (Object.keys(patch).length > 0) {
    const applied = await client.call('session.settings.update', {
      requestId: createRequestId(), sessionId: plan.sessionId, patch,
      ...(previous !== undefined ? { ifRevision: previous.revision } : {}),
    });
    appliedRevision = applied.revision;
  }

  const progress = createOneShotProgress(client, plan.sessionId, options.events);
  const unattended = createUnattended(client, options.events);
  let observation: HostSessionObservation | undefined;
  try {
    observation = await client.observeSession(plan.sessionId, {
      onView: (view) => { progress.view(view); unattended.view(view); },
    });
    const inputId = createRequestId();
    const leased = await input.leases({ kind: 'input', input: { sessionId: plan.sessionId, inputId, text: prompt, delivery: 'immediate' } });
    const { input: accepted } = await client.call('input.submit', {
      requestId: inputId, sessionId: plan.sessionId, text: prompt, delivery: 'immediate',
      ...(leased !== undefined ? { leases: leased } : {}),
    });
    const runId = accepted.runId;
    if (runId === undefined) throw new Error(`One-shot input ${inputId} was not attached to a run (state ${accepted.state}).`);
    unattended.follow(runId);

    const requestStop = (): void => {
      void client.call('run.stop', { requestId: createRequestId(), runId }).catch((error: unknown) => {
        // The Run would go on using the provider while the caller reports it stopped.
        emitKodaXDiagnostic({ source: 'kodax.one-shot', level: 'warn',
          message: `The stop request for run ${runId} failed; the run may still be executing.`, detail: error });
      });
    };
    input.abortSignal?.addEventListener('abort', requestStop, { once: true });
    if (input.abortSignal?.aborted === true) requestStop();
    try {
      const run = await awaitRun(client, runId);
      await progress.settled();
      const result = projectOneShotOutcome(run);
      if (result.success) options.events?.onComplete?.();
      return result;
    } finally {
      input.abortSignal?.removeEventListener('abort', requestStop);
    }
  } finally {
    observation?.close();
    if (previous !== undefined && appliedRevision !== undefined) {
      await client.call('session.settings.update', {
        requestId: createRequestId(), sessionId: plan.sessionId,
        patch: restorePatch(previous.settings, patch), ifRevision: appliedRevision,
      }).catch((error: unknown) => {
        // The invocation's flags would stay on the Session: say so instead of dropping it.
        emitKodaXDiagnostic({ source: 'kodax.one-shot', level: 'warn',
          message: `Failed to restore settings for session ${plan.sessionId}; invocation flags may remain active.`, detail: error });
        options.events?.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    }
  }
}
