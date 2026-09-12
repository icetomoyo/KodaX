/**
 * FEATURE_298 T35 — one-shot CLI execution through the product client.
 * Session lifecycle (including temporary deletion), input submission, and
 * run settlement are Host-owned; this module only resolves which session to
 * use, applies the invocation's run shaping, forwards live progress to the
 * CLI output formatters, and projects the outcome back to the legacy shape.
 */
import { randomUUID } from 'node:crypto';
import type {
  KodaXOptions,
  KodaXResult,
} from '@kodax-ai/coding';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import type {
  ClientInteraction,
  ClientObservation,
  ClientSessionSettings,
  ClientSessionSettingsPatch,
  KodaXProductClient,
} from '@kodax-ai/coding/client-contract';
import { getGitRoot } from '@kodax-ai/repl';
import type { KodaXRuntime } from './sdk-runtime.js';
import { attachRunProgressAdapter } from './run-progress-events.js';

function interruptedOneShotResult(sessionId: string): KodaXResult {
  return {
    success: false,
    lastText: '',
    messages: [],
    sessionId,
    interrupted: true,
    signal: 'BLOCKED',
    signalReason: 'Runtime run cancelled.',
  };
}

function isSessionNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith('Session not found:')
  );
}

/**
 * Terminal outcome → legacy result. An executor-produced result passes
 * through untouched; a run that settles cancelled/interrupted without one
 * gets the synthesized interrupted shape; anything else (including the
 * outcome-unconfirmed `unknown` phase) is an error, never success.
 */
export function projectOneShotOutcome(
  outcome: { readonly phase: string; readonly result?: KodaXResult; readonly error?: string },
  runId: string,
  fallbackSessionId: string,
): KodaXResult {
  if (outcome.error !== undefined) {
    throw new Error(outcome.error);
  }
  if (outcome.result !== undefined) {
    return outcome.result;
  }
  if (outcome.phase === 'cancelled' || outcome.phase === 'interrupted') {
    return interruptedOneShotResult(fallbackSessionId);
  }
  throw new Error(`Runtime run ${runId} ended without a result.`);
}

interface OneShotSessionPlan {
  readonly sessionId: string;
  readonly resumed: boolean;
  /** Host deletes temporary sessions at settlement; no restore applies. */
  readonly temporary: boolean;
}

export async function resolveOneShotSession(
  client: KodaXProductClient,
  options: KodaXOptions,
  prompt: string,
): Promise<OneShotSessionPlan> {
  const gitRoot = (await getGitRoot()) ?? process.cwd();
  const temporary = options.session === undefined;
  const createInput = (sessionId?: string) => ({
    ...(sessionId !== undefined ? { sessionId } : {}),
    title: prompt.slice(0, 50),
    projectPath: process.cwd(),
    gitRoot,
    surface: 'cli',
    ...(temporary ? { temporary: true as const } : {}),
  });

  if (options.session?.id !== undefined) {
    try {
      await client.sessions.read(options.session.id);
      return { sessionId: options.session.id, resumed: true, temporary: false };
    } catch (error: unknown) {
      if (!isSessionNotFound(error)) throw error;
      const created = await client.sessions.create(createInput(options.session.id));
      return { sessionId: created.id, resumed: false, temporary: false };
    }
  }
  if (options.session?.resume === true) {
    // Project-scoped like the storage scan this replaces (FEATURE_219).
    const candidates = await client.sessions.list({
      projectRoot: gitRoot,
      scope: 'user',
      limit: 1000,
    });
    const recent = candidates.find((session) => session.msgCount > 0);
    if (recent !== undefined) return { sessionId: recent.id, resumed: true, temporary: false };
  }
  const created = await client.sessions.create(createInput());
  return { sessionId: created.id, resumed: false, temporary };
}

/** Run-shaping flags the product path expresses as session settings. */
function toOneShotSettingsPatch(
  options: KodaXOptions,
): ClientSessionSettingsPatch {
  return {
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.context?.repoIntelligenceMode !== undefined ? { repoIntelligenceMode: options.context.repoIntelligenceMode } : {}),
    ...(options.context?.repoIntelligenceTrace !== undefined ? { repoIntelligenceTrace: options.context.repoIntelligenceTrace } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
    ...(options.reasoningMode !== undefined
      ? { reasoningMode: options.reasoningMode }
      : {}),
    ...(options.agentMode !== undefined ? { agentMode: options.agentMode } : {}),
    ...(options.maxIter !== undefined ? { maxIter: options.maxIter } : {}),
  };
}

function restoreSettingsPatch(
  previous: ClientSessionSettings,
  applied: ClientSessionSettingsPatch,
): ClientSessionSettingsPatch {
  const restore: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(applied)) {
    const value = (previous as Record<string, unknown>)[key];
    restore[key] =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : null;
  }
  return restore as ClientSessionSettingsPatch;
}

export interface OneShotClientTaskInput {
  readonly client: KodaXProductClient;
  readonly runtime: KodaXRuntime;
  readonly options: KodaXOptions;
  readonly prompt: string;
  /** Abort requests a durable Host stop; settlement still decides the result. */
  readonly abortSignal?: AbortSignal;
}

/**
 * Exit-code contract for the one-shot CLI: success 0, interrupted 130
 * (SIGINT convention), anything else — limit reached or failed — 1.
 */
export function exitCodeForOneShotResult(result: KodaXResult): number {
  if (result.success) return 0;
  if (result.interrupted) return 130;
  return 1;
}

export async function runOneShotClientTask(
  input: OneShotClientTaskInput,
): Promise<KodaXResult> {
  const { client, runtime, options, prompt } = input;
  const plan = await resolveOneShotSession(client, options, prompt);

  const patch = toOneShotSettingsPatch(options);
  // Flags stay per-invocation: settings are patched for this run and
  // restored afterwards, for resumed AND freshly created persistent
  // sessions (pre-T35 run options never persisted). A concurrent run
  // another client starts on the same session during this window also
  // observes the patched settings — bounded by this invocation.
  // Temporary sessions are deleted by the Host at settlement; nothing
  // to restore.
  const restoreSettings = Object.keys(patch).length > 0 && !plan.temporary;
  const previousSettings = restoreSettings
    ? await client.sessions.getSettings(plan.sessionId)
    : undefined;
  if (Object.keys(patch).length > 0) {
    await client.sessions.updateSettings(plan.sessionId, patch);
  }

  const progress = attachRunProgressAdapter(runtime, {
    sessionId: plan.sessionId,
    events: options.events,
  });
  const inputId = `cli-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  let observation: ClientObservation | undefined;
  let acceptedRunId: string | undefined;
  let interactions: readonly ClientInteraction[] = [];
  const rejected = new Set<string>();
  const rejectUnattendedPermissions = (): void => {
    for (const interaction of interactions) {
      if (interaction.kind !== 'permission' || interaction.runId !== acceptedRunId || rejected.has(interaction.requestId)) continue;
      rejected.add(interaction.requestId);
      void client.interactions.respond(interaction.requestId, { kind: 'permission', decision: {
        type: 'reject', reason: 'The non-interactive CLI cannot approve permission requests. Run interactively to review this action.',
      } }).catch((error: unknown) => {
        emitKodaXDiagnostic({ source: 'kodax.one-shot', level: 'error',
          message: 'Failed to reject an unattended permission request.', detail: error });
        options.events?.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    }
  };
  try {
    observation = await client.sessions.observe(plan.sessionId, view => {
      interactions = view.interactions;
      rejectUnattendedPermissions();
    });
    const accepted = await client.inputs.submit({
      sessionId: plan.sessionId,
      inputId,
      text: prompt,
      delivery: 'immediate',
    });
    if (accepted.runId === undefined) {
      throw new Error(
        `One-shot input ${inputId} was not attached to a run (state ${accepted.state}).`,
      );
    }
    acceptedRunId = accepted.runId;
    rejectUnattendedPermissions();
    progress.setRunId(accepted.runId);

    const requestStop = (): void => {
      void client.runs.stop(accepted.runId!).catch((error: unknown) => {
        // The abort path must not swallow stop failures: the run would keep
        // consuming Provider work while the caller already reported interrupt.
        emitKodaXDiagnostic({
          source: 'kodax.one-shot',
          level: 'warn',
          message: `The stop request for run ${accepted.runId} failed; the run may still be executing.`,
          detail: error,
        });
      });
    };
    input.abortSignal?.addEventListener('abort', requestStop, { once: true });
    if (input.abortSignal?.aborted) requestStop();
    try {
      const outcome = await client.runs.await(accepted.runId);
      return projectOneShotOutcome(outcome, accepted.runId, plan.sessionId);
    } finally {
      input.abortSignal?.removeEventListener('abort', requestStop);
    }
  } finally {
    observation?.close();
    progress.close();
    if (previousSettings !== undefined) {
      // A failed restore would leave this invocation's flags on the
      // session — surface it instead of swallowing (e.g. disconnect).
      await client.sessions
        .updateSettings(plan.sessionId, restoreSettingsPatch(previousSettings, patch))
        .catch((error: unknown) => {
          emitKodaXDiagnostic({ source: 'kodax.one-shot', level: 'warn',
            message: `Failed to restore settings for session ${plan.sessionId}; invocation flags may remain active.`, detail: error });
          options.events?.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    }
  }
}
