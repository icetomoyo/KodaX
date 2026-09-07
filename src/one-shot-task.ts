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
import type {
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

interface OneShotSessionPlan {
  readonly sessionId: string;
  readonly resumed: boolean;
}

async function resolveOneShotSession(
  client: KodaXProductClient,
  options: KodaXOptions,
  prompt: string,
): Promise<OneShotSessionPlan> {
  const gitRoot = (await getGitRoot()) ?? process.cwd();
  const createInput = (sessionId?: string) => ({
    ...(sessionId !== undefined ? { sessionId } : {}),
    title: prompt.slice(0, 50),
    projectPath: process.cwd(),
    gitRoot,
    surface: 'cli',
    ...(options.session === undefined ? { temporary: true as const } : {}),
  });

  if (options.session?.id !== undefined) {
    try {
      await client.sessions.read(options.session.id);
      return { sessionId: options.session.id, resumed: true };
    } catch (error: unknown) {
      if (!isSessionNotFound(error)) throw error;
      const created = await client.sessions.create(createInput(options.session.id));
      return { sessionId: created.id, resumed: false };
    }
  }
  if (options.session?.resume === true) {
    // Project-scoped like the storage scan this replaces (FEATURE_219).
    const candidates = await client.sessions.list({
      ...(gitRoot !== undefined ? { projectRoot: gitRoot } : {}),
      scope: 'user',
      limit: 1000,
    });
    const recent = candidates.find((session) => session.msgCount > 0);
    if (recent !== undefined) return { sessionId: recent.id, resumed: true };
  }
  const created = await client.sessions.create(createInput());
  return { sessionId: created.id, resumed: false };
}

/** Run-shaping flags the product path expresses as session settings. */
function toOneShotSettingsPatch(
  options: KodaXOptions,
): ClientSessionSettingsPatch {
  return {
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
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
  const previousSettings = Object.keys(patch).length > 0 && plan.resumed
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
  try {
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
    progress.setRunId(accepted.runId);

    const requestStop = (): void => {
      void client.runs.stop(accepted.runId!).catch(() => undefined);
    };
    input.abortSignal?.addEventListener('abort', requestStop, { once: true });
    if (input.abortSignal?.aborted) requestStop();

    const outcome = await client.runs.await(accepted.runId);
    input.abortSignal?.removeEventListener('abort', requestStop);
    if (outcome.error !== undefined) {
      throw new Error(outcome.error);
    }
    if (outcome.result !== undefined) {
      return outcome.result;
    }
    if (outcome.phase === 'cancelled' || outcome.phase === 'interrupted') {
      return interruptedOneShotResult(plan.sessionId);
    }
    throw new Error(
      `Runtime run ${accepted.runId} ended without a result.`,
    );
  } finally {
    progress.close();
    if (previousSettings !== undefined) {
      // A resumed session keeps its own settings once this invocation ends.
      await client.sessions
        .updateSettings(plan.sessionId, restoreSettingsPatch(previousSettings, patch))
        .catch(() => undefined);
    }
  }
}
