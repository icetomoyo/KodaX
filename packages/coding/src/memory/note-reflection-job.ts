/**
 * FEATURE_306 — what the host does with the note memory after a run ends, in the
 * background and never awaited by the run:
 *
 *   1. count the notes the agent opened during the run (usage signal),
 *   2. reflect on the session when it qualifies (gate, cursor, daily cap),
 *   3. when reflection ran, tidy the stores and drop revisions past retention.
 *
 * The reflection call uses the session's own provider and model: the run just
 * finished with it, so its credentials are known to work. Passes run one at a
 * time so two finishing runs never write the same store together.
 */
import {
  createNoteStore,
  emitKodaXDiagnostic,
  organizeStore,
  pruneRevisions,
  recordNoteReads,
  reflectSession,
  resolveNoteRoot,
  type NoteScope,
  type NoteStore,
  type ReflectionJudge,
} from '@kodax-ai/agent';
import { withProviderRequestCredential, type KodaXBaseProvider, type KodaXMessage } from '@kodax-ai/llm';

import { buildReflectionRequest, parseReflectionCall, REFLECT_TOOL_NAME } from './note-reflection.js';

const REFLECTION_TIMEOUT_MS = 120_000;
/** The size the reflection prompt was evaluated at (FEATURE_306 Phase 2b to 3). */
const REFLECTION_MAX_OUTPUT_TOKENS = 8192;
const NOTE_SCOPES = ['project', 'user'] as const;

export interface NoteRunFinish {
  readonly cwd: string;
  readonly sessionId: string;
  /** The session's messages as the run ended. */
  readonly messages: readonly KodaXMessage[];
  /** Tool call ids that were already in the session when the run began; their reads were counted then. */
  readonly earlierCalls: ReadonlySet<string>;
  readonly provider: KodaXBaseProvider;
  readonly model?: string;
}

export function createProviderJudge(provider: KodaXBaseProvider, model: string | undefined): ReflectionJudge {
  return async ({ evidence, notes }) => {
    const request = buildReflectionRequest(evidence, notes);
    const signal = AbortSignal.timeout(REFLECTION_TIMEOUT_MS);
    const result = await withProviderRequestCredential(provider, 'sidecar', signal, (credentialSignal) => provider.stream(
      [{ role: 'user', content: request.userMessage }],
      [...request.tools],
      request.systemPrompt,
      undefined,
      {
        ...(model === undefined ? {} : { modelOverride: model }),
        maxOutputTokensOverride: REFLECTION_MAX_OUTPUT_TOKENS,
        signal: credentialSignal,
      },
      credentialSignal,
    ));
    return result.toolBlocks
      .filter((block) => block.name === REFLECT_TOOL_NAME)
      .flatMap((block) => parseReflectionCall(block.input) ?? []);
  };
}

function storesFor(cwd: string): Readonly<Record<NoteScope, NoteStore>> {
  return {
    project: createNoteStore(resolveNoteRoot(cwd, 'project'), 'project'),
    user: createNoteStore(resolveNoteRoot(cwd, 'user'), 'user'),
  };
}

export async function finishNoteRun(run: NoteRunFinish, judge: ReflectionJudge = createProviderJudge(run.provider, run.model)): Promise<void> {
  const stores = storesFor(run.cwd);
  await recordNoteReads({ stores, messages: run.messages, ignoreCalls: run.earlierCalls });
  const outcome = await reflectSession({
    sessionId: run.sessionId,
    messages: run.messages,
    stores,
    cursorRoot: stores.user.root,
    judge,
  });
  if (outcome.status !== 'done') return;
  for (const scope of NOTE_SCOPES) {
    await organizeStore(stores[scope]);
    await pruneRevisions(stores[scope].root);
  }
  if (outcome.rejected.length > 0) {
    emitKodaXDiagnostic({
      source: 'coding:note-reflection',
      level: 'info',
      message: 'The host rejected some reflection operations.',
      detail: { applied: outcome.applied, rejected: outcome.rejected },
    });
  }
}

let queue: Promise<void> = Promise.resolve();

/** Queues a finish behind the earlier ones. The returned promise never rejects; failures go to diagnostics. */
export function scheduleNoteRunFinish(run: NoteRunFinish, judge?: ReflectionJudge): Promise<void> {
  const next = queue.then(() => finishNoteRun(run, judge)).catch((error: unknown) => {
    emitKodaXDiagnostic({
      source: 'coding:note-reflection',
      level: 'warn',
      message: `Note memory follow-up failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  });
  queue = next;
  return next;
}
