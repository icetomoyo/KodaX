/**
 * FEATURE_308 — what the host does with the note memory after a run ends, in the
 * background and never awaited by the run:
 *
 *   1. count the notes the agent opened during the run (usage signal),
 *   2. reflect on the session when it qualifies (gate, cursor, daily cap), then
 *      on what other sessions of the project left pending,
 *   3. when reflection ran, tidy the stores and drop revisions past retention.
 *
 * The reflection call uses the session's own provider and model: the run just
 * finished with it, so its credentials are known to work. Passes run one at a
 * time so two finishing runs never write the same store together.
 */
import {
  addMemoryStats,
  drainPendingReflections,
  emitKodaXDiagnostic,
  NOTE_SCOPES,
  organizeStore,
  pruneRevisions,
  recordNoteReads,
  reflectSession,
  type ReflectionJudge,
  type ReflectSessionResult,
} from '@kodax-ai/agent';
import { withProviderRequestCredential, type KodaXBaseProvider, type KodaXMessage } from '@kodax-ai/llm';

import { noteStoresFor, projectKeyOf, type NotePlace } from './note-memory.js';
import { buildReflectionRequest, parseReflectionCall, REFLECT_TOOL_NAME } from './note-reflection.js';
import { enqueueNoteWork } from './note-work-queue.js';

const REFLECTION_TIMEOUT_MS = 120_000;
/** The size the reflection prompt was evaluated at (FEATURE_308 Phase 2b to 3). */
const REFLECTION_MAX_OUTPUT_TOKENS = 8192;

export interface NoteRunFinish {
  readonly place: NotePlace;
  /** False when the host supplied its own learning reviewer: it owns what is learned, so only reads are counted. */
  readonly reflect: boolean;
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
    return result.toolBlocks.flatMap((block) => (block.name === REFLECT_TOOL_NAME ? parseReflectionCall(block.input) ?? [] : []));
  };
}

/**
 * A CLI bridge (codex, gemini) drops the request's tools and system prompt and
 * runs its own agent with full permissions, so a reflection request sent there
 * would start an unsupervised agent on the session text instead of answering.
 */
function canReflectWith(provider: KodaXBaseProvider, model: string | undefined): boolean {
  const profile = provider.getCapabilityProfile?.(model);
  return profile === undefined || (profile.transport === 'native-api' && profile.toolCallingFidelity === 'full');
}

export async function finishNoteRun(run: NoteRunFinish, judge?: ReflectionJudge): Promise<void> {
  const stores = noteStoresFor(run.place);
  const reads = await recordNoteReads({ stores, messages: run.messages, ignoreCalls: run.earlierCalls });
  await addMemoryStats(stores.user.root, { reads });
  if (!run.reflect || !canReflectWith(run.provider, run.model)) return;
  const input = {
    sessionId: run.sessionId,
    project: projectKeyOf(run.place),
    stores,
    cursorRoot: stores.user.root,
    judge: judge ?? createProviderJudge(run.provider, run.model),
  };
  const outcome = await reflectSession({ ...input, messages: run.messages });
  let reflected = await recordOutcome(stores, outcome);
  if (outcome.status !== 'skipped' || outcome.reason !== 'daily-cap') {
    for (const drained of await drainPendingReflections(input)) reflected = await recordOutcome(stores, drained) || reflected;
  }
  if (!reflected) return;
  for (const scope of NOTE_SCOPES) {
    await organizeStore(stores[scope]);
    await pruneRevisions(stores[scope].root);
  }
}

/** Counts one pass in the local stats; true when the pass ran. */
async function recordOutcome(stores: ReturnType<typeof noteStoresFor>, outcome: ReflectSessionResult): Promise<boolean> {
  if (outcome.status !== 'done') return false;
  await addMemoryStats(stores.user.root, { reflections: 1, rejected: outcome.rejected.length, ...outcome.appliedByOperation });
  if (outcome.rejected.length > 0) {
    emitKodaXDiagnostic({
      source: 'coding:note-reflection',
      level: 'info',
      message: 'The host rejected some reflection operations.',
      detail: { applied: outcome.applied, rejected: outcome.rejected },
    });
  }
  return true;
}

/** Queues a finish behind the earlier ones. The returned promise never rejects; failures go to diagnostics. */
export function scheduleNoteRunFinish(run: NoteRunFinish, judge?: ReflectionJudge): Promise<void> {
  return enqueueNoteWork(() => finishNoteRun(run, judge).catch((error: unknown) => {
    emitKodaXDiagnostic({
      source: 'coding:note-reflection',
      level: 'warn',
      message: `Note memory follow-up failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }));
}
