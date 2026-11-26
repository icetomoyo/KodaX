import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  createMemoryControlPlane,
  drainPendingEpisodeReviews,
  EpisodeReviewFailure,
  appendMemoryClientNotice,
  appendMemoryOutcomeDigest,
  appendMemoryReviewReceipt,
  createSessionLineage,
  getSessionLineagePath,
  getAgentConfigPath,
  isUnifiedLearningReviewModelInput,
  normalizeUnifiedLearningReview,
  sanitizeUnifiedLearningReviewInput,
  tryGitRemote,
  type MemoryContextIdentity,
  type KodaXMemoryOutcomeDigest,
  type EpisodeReviewDrainOptions,
  type EpisodeReviewDrainEligibility,
  type EpisodeReviewDrainResult,
  type KodaXSessionStorage,
  type LearningReviewEvidencePacket,
  type MemoryController,
  type MemoryEpisodeReviewResult,
  type MemoryReviewPlan,
  type PendingEpisodeReview,
  type PendingEpisodeReviewV2,
  type UnifiedLearningReviewModelInput,
} from '@kodax-ai/agent';

import { emitResilienceDebug } from './agent-runtime/resilience-debug.js';
import { noteWorkSettled } from './memory/note-work-queue.js';
import { runInSessionScope } from './run-scoped-config.js';
import { usesHostMemory } from './host-memory.js';
import { resolveExecutionCwd } from './runtime-paths.js';
import type { KodaXOptions } from './types.js';
import {
  LEARNING_REVIEW_PROMPT_SHA256,
  LEARNING_REVIEW_SCHEMA_SHA256,
} from './learning-reviewer.js';

export async function maybeRunMemoryMaintenanceWindow(options: KodaXOptions): Promise<void> {
  if (!usesHostMemory(options)) return;

  const cwd = resolveExecutionCwd(options.context);
  try {
    const result = await createMemoryControlPlane({
      cwd,
      ...(options.context?.memoryIdentity !== undefined
        ? { identity: options.context.memoryIdentity }
        : {}),
      projectDocs: [],
      discoverSkills: false,
    }).maybeRunAutoCurator();
    if (result.ran || result.skippedReason !== 'not_due') {
      emitResilienceDebug('[memory:maintenance]', {
        cwd,
        ran: result.ran,
        skippedReason: result.skippedReason ?? null,
        reportPath: result.reportPath ?? null,
        nextEligibleAt: result.nextEligibleAt ?? null,
      });
    }
  } catch (error) {
    emitResilienceDebug('[memory:maintenance:error]', {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * FEATURE_298 T36 — the pure root of {@link deriveCodingMemoryIdentity}:
 * derives the Host-owned Memory identity from (configHome, projectRoot)
 * alone, so the runtime Memory service can derive the same identity the
 * run path uses without constructing a full KodaXOptions.
 */
export function deriveCodingMemoryIdentityFromRoot(
  configHome: string,
  cwd: string,
): MemoryContextIdentity {
  const canonicalCwd = path.resolve(cwd).toLowerCase();
  const remote = tryGitRemote(cwd)?.trim();
  const projectId = remote === undefined
    ? `local:${canonicalCwd}`
    : canonicalMemoryProjectId(remote);
  return {
    configHome,
    tenantId: `local:${configHome}`,
    userId: `local:${configHome}`,
    workspaceId: canonicalCwd,
    agentId: 'kodax-coding',
    projectId,
    sessionId: 'runtime-memory-service',
  };
}

/**
 * True for an identity {@link deriveCodingMemoryIdentityFromRoot} made for this machine,
 * as the runner does for every root run, as opposed to one a host named for its tenant.
 */
export function isLocalMemoryIdentity(identity: MemoryContextIdentity): boolean {
  return identity.configHome !== undefined && identity.tenantId === `local:${identity.configHome}`;
}

export function deriveCodingMemoryIdentity(
  options: KodaXOptions,
  cwd: string,
  sessionId: string,
): MemoryContextIdentity {
  const base = deriveCodingMemoryIdentityFromRoot(
    options.context?.configHome ?? getAgentConfigPath(),
    cwd,
  );
  const workspaceId = options.context?.repoRoutingSignals?.workspaceRoot
    ?? options.context?.gitRoot
    ?? base.workspaceId;
  return {
    ...base,
    workspaceId,
    agentId: options.context?.agentProfile?.id ?? 'kodax-coding',
    sessionId,
  };
}

export function canonicalMemoryProjectId(remoteUrl: string): string {
  const value = remoteUrl.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.hostname.length > 0 && parsed.pathname.length > 1) {
        return canonicalRemoteIdentity(
          `${parsed.hostname.toLowerCase()}${parsed.port.length > 0 ? `:${parsed.port}` : ''}`,
          parsed.pathname,
        );
      }
    } catch {
      // Invalid remotes remain scope-stable without persisting their raw bytes.
    }
  }
  const scp = value.match(/^(?:[^@/:]+@)?([^:/]+):(.+)$/);
  if (scp !== null) return canonicalRemoteIdentity(scp[1]!, scp[2]!);
  return `remote-hash:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function canonicalRemoteIdentity(host: string, repositoryPath: string): string {
  const repository = repositoryPath
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '');
  return `remote:${host.toLowerCase()}/${repository}`;
}

export async function persistMemoryOutcomeToSession(
  options: KodaXOptions,
  sessionId: string,
  digest: KodaXMemoryOutcomeDigest,
  persistence: {
    readonly emitEvent?: boolean;
    readonly jobId?: string;
  } = {},
): Promise<void> {
  await mutateSessionLineage(
    options,
    sessionId,
    (lineage) => appendMemoryOutcomeDigest(lineage, digest, persistence.jobId),
  );
  if (persistence.emitEvent !== false) {
    options.events?.onMemoryOutcomeDigest?.(digest, {
      ...(persistence.jobId === undefined ? {} : { jobId: persistence.jobId }),
    });
  }
}

interface MemoryReviewReceiptInput {
  readonly jobId?: string;
  readonly reviewKey: string;
  readonly proposalIds: readonly string[];
  readonly completedAt: string;
  readonly notice?: {
    readonly episodeId: string;
    readonly summaries: readonly string[];
    readonly proposalIds: readonly string[];
  };
}

export async function persistMemoryReviewReceiptToSession(
  options: KodaXOptions,
  sessionId: string,
  input: MemoryReviewReceiptInput,
): Promise<void> {
  await writeMemoryReviewReceiptToSession(options, sessionId, input);
  notifyMemoryReviewReceipt(options, sessionId, input);
}

async function writeMemoryReviewReceiptToSession(
  options: KodaXOptions,
  sessionId: string,
  input: MemoryReviewReceiptInput,
): Promise<void> {
  await mutateSessionLineage(
    options,
    sessionId,
    (lineage) => {
      const withReceipt = appendMemoryReviewReceipt(lineage, input);
      return input.notice === undefined
        ? withReceipt
        : appendMemoryClientNotice(withReceipt, {
            ...input.notice,
            createdAt: input.completedAt,
          });
    },
  );
}

function notifyMemoryReviewReceipt(
  options: KodaXOptions,
  sessionId: string,
  input: MemoryReviewReceiptInput,
): void {
  options.events?.onMemoryReviewReceipt?.({
    jobId: input.jobId,
    reviewKey: input.reviewKey,
    proposalIds: input.proposalIds,
    completedAt: input.completedAt,
    sessionId,
  });
  if (input.notice !== undefined) {
    options.events?.onMemoryNotice?.({ ...input.notice, sessionId });
  }
}

async function mutateSessionLineage(
  options: KodaXOptions,
  sessionId: string,
  mutation: (
    lineage: import('@kodax-ai/agent').KodaXSessionLineage,
  ) => import('@kodax-ai/agent').KodaXSessionLineage,
): Promise<void> {
  const storage = options.session?.storage;
  if (options.session?.persistedByHost === true
    && storage?.mutateLineage === undefined) {
    throw new Error(
      'host-persisted Memory facts require storage atomic lineage mutation',
    );
  }
  if (storage === undefined) return;
  if (storage.mutateLineage !== undefined) {
    const sessionFound = await storage.mutateLineage(sessionId, mutation);
    if (!sessionFound) {
      throw new Error(
        `Memory owner session was not found during atomic lineage mutation: ${sessionId}`,
      );
    }
    return;
  }
  const data = await storage.load(sessionId);
  if (data === null) return;
  const lineage = data.lineage ?? createSessionLineage(data.messages);
  const nextLineage = mutation(lineage);
  if (nextLineage === lineage) return;
  await storage.save(sessionId, { ...data, lineage: nextLineage });
}

export function appliedMemoryReviewSummaries(
  review: MemoryEpisodeReviewResult,
): readonly string[] {
  const applied = new Set(review.appliedProposalIds);
  return review.decisions
    .filter((decision) => (
      decision.proposalId !== undefined
      && applied.has(decision.proposalId)
    ))
    .map((decision) => review.plan.actions[decision.actionIndex]?.summary)
    .filter((summary): summary is string => summary !== undefined)
    .slice(0, 3);
}

export async function revalidatePendingEpisodeReview(
  storage: KodaXSessionStorage | undefined,
  entry: PendingEpisodeReview,
): Promise<EpisodeReviewDrainEligibility> {
  if (storage === undefined) return 'defer';
  const data = await storage.load(entry.ownerSessionRef);
  if (data === null) return 'discard';
  const lineage = data.lineage ?? createSessionLineage(data.messages);
  const digestEntry = lineage.entries.find((candidate) => (
    candidate.type === 'memory_outcome_digest'
    && (entry.version === 2
      ? candidate.jobId === entry.jobId
      : candidate.jobId === undefined
        && candidate.digest.reviewKey === entry.reviewKey
        && candidate.digest.id === entry.digest.id)
  ));
  if (digestEntry !== undefined) {
    const activePathIds = new Set(getSessionLineagePath(lineage).map((candidate) => candidate.id));
    return digestEntry.parentId === null || activePathIds.has(digestEntry.parentId)
      ? 'eligible'
      : 'discard';
  }
  if (entry.version === 2) return 'discard';
  const rewoundAfterDigest = lineage.entries.some((candidate) =>
    candidate.type === 'rewind_marker'
    && candidate.timestamp.localeCompare(entry.digest.createdAt) >= 0);
  return rewoundAfterDigest ? 'discard' : 'eligible';
}

// FEATURE_289 §3.1: the latest truly-started drain so shutdown paths can
// bounded-await it via awaitLatestCodingMemoryReviewDrain.
let latestMemoryReviewDrain: Promise<unknown> | undefined;

/** Own short memory IO separately from the Run's potentially unbounded model work. */
export function runOwnedMemoryWork<T>(
  options: KodaXOptions,
  work: (signal?: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  if (!options.events?.runMemoryWork) return work();
  let result: T | undefined;
  return options.events.runMemoryWork(async (signal) => {
    result = await work(signal);
  }).then(() => result);
}

export function drainCodingMemoryReviewInbox(
  options: KodaXOptions,
  identity: MemoryContextIdentity,
  controller: MemoryController,
  currentSessionId: string,
  drainDeadlineAtMs?: number,
  preferredJobId?: string,
): Promise<EpisodeReviewDrainResult | undefined> {
  if (!usesHostMemory(options)
    || (options.memoryReviewer === undefined && options.learningReviewer === undefined)
    || options.session?.storage === undefined) return Promise.resolve(undefined);
  const drain = runOwnedMemoryWork(options, (abortSignal) => drainStartedCodingMemoryReviewInbox(
    options,
    identity,
    controller,
    currentSessionId,
    drainDeadlineAtMs,
    preferredJobId,
    abortSignal,
  ));
  latestMemoryReviewDrain = drain;
  return drain;
}

/**
 * FEATURE_289 §3.1: bounded await of the latest drain for shutdown cleanup.
 * Also waits for the note memory's queued follow-ups (FEATURE_308), so a
 * one-shot `-p` run does not exit in the middle of writing a note.
 * Never rejects; resolves at once when nothing was started.
 */
export async function awaitLatestCodingMemoryReviewDrain(timeoutMs: number): Promise<void> {
  const drain = latestMemoryReviewDrain;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([drain?.then(() => undefined, () => undefined), noteWorkSettled()]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function drainStartedCodingMemoryReviewInbox(
  options: KodaXOptions,
  identity: MemoryContextIdentity,
  controller: MemoryController,
  currentSessionId: string,
  drainDeadlineAtMs: number | undefined,
  preferredJobId: string | undefined,
  abortSignal?: AbortSignal,
): Promise<EpisodeReviewDrainResult | undefined> {
  const drainOptions: Omit<EpisodeReviewDrainOptions, 'maxEntries'> = {
    ...(abortSignal === undefined ? {} : { abortSignal }),
    ...(drainDeadlineAtMs === undefined ? {} : { deadlineAtMs: drainDeadlineAtMs }),
    revalidate: async (entry) => entry.ownerSessionRef === currentSessionId
      ? 'defer'
      : revalidatePendingEpisodeReview(options.session?.storage, entry),
    // A drained entry may belong to an earlier conversation; its review requests carry that conversation's id.
    review: (entry, signal) => runInSessionScope(entry.ownerSessionRef,
      () => reviewPendingEpisode(options, controller, entry, signal)),
    prepareV2Input: async (entry) => ({
      evidence: await buildUnifiedReviewInput(options, identity, controller, entry),
      promptRevision: `sha256:${LEARNING_REVIEW_PROMPT_SHA256}`,
      schemaRevision: `sha256:${LEARNING_REVIEW_SCHEMA_SHA256}`,
      policyRevision: 'project-scoped-canary-v1',
      providerRevision: `${options.provider}:${options.modelOverride ?? options.model ?? 'default'}`,
    }),
    decideV2: (entry, checkpoint, signal) => runInSessionScope(entry.ownerSessionRef, async () => {
      if (!isUnifiedLearningReviewModelInput(checkpoint.evidence)) {
        throw new Error('frozen unified review input is invalid');
      }
      const raw = options.learningReviewer === undefined
        ? {
            memoryPlan: await options.memoryReviewer?.(checkpoint.evidence.memory, signal),
          }
        : await options.learningReviewer(checkpoint.evidence, signal);
      if (!isReviewEnvelope(raw)) {
        throw new EpisodeReviewFailure(
          'malformed_response',
          'learning reviewer returned no structured decision fields',
        );
      }
      const normalized = normalizeUnifiedLearningReview(checkpoint.evidence, raw);
      return {
        inputHash: checkpoint.evidenceHash,
        memoryProposalIds: [],
        memoryPlan: normalized.memoryPlan,
      };
    }),
    applyV2Action: async (entry, decision, carrier, _claim, commitWithAuthority) => (
      applyUnifiedReviewAction(
        options,
        identity,
        controller,
        entry,
        decision,
        carrier,
        commitWithAuthority,
      )
    ),
    onV2Completed: async (entry, decision, proposalIds) => {
      const completedAt = new Date().toISOString();
      const appliedProposalIds = controller.listHostAppliedEpisodeProposalIds === undefined
        ? []
        : await controller.listHostAppliedEpisodeProposalIds(proposalIds);
      const summaries = appliedProposalIds.length === 0
        ? []
        : (await Promise.all(appliedProposalIds.map(async (proposalId) => (
            (await controller.showProposal(`memory:${proposalId}`))?.preview.summary
          )))).filter((summary): summary is string => summary !== undefined).slice(0, 3);
      const receipt: MemoryReviewReceiptInput = {
        jobId: entry.jobId,
        reviewKey: entry.reviewKey,
        proposalIds,
        completedAt,
        ...(appliedProposalIds.length === 0
          ? {}
          : {
              notice: {
                episodeId: entry.digest.id,
                summaries,
                proposalIds: appliedProposalIds,
              },
            }),
      };
      // The receipt is written before the job completes so recovery cannot
      // replay applied effects; clients hear about it only after completion.
      await writeMemoryReviewReceiptToSession(options, entry.ownerSessionRef, receipt);
      return () => notifyMemoryReviewReceipt(options, entry.ownerSessionRef, receipt);
    },
  };
  const result = {
    reviewed: 0,
    discarded: 0,
    deferred: 0,
    failed: 0,
    failures: [] as Array<EpisodeReviewDrainResult['failures'][number]>,
  };
  const merge = (partial: EpisodeReviewDrainResult) => {
    result.reviewed += partial.reviewed;
    result.discarded += partial.discarded;
    result.deferred += partial.deferred;
    result.failed += partial.failed;
    result.failures.push(...partial.failures);
  };
  if (preferredJobId !== undefined) {
    for (const ownerIdentity of deriveCodingMemoryReviewIdentities(options, identity)) {
      if (abortSignal?.aborted) break;
      const partial = await drainPendingEpisodeReviews(ownerIdentity, {
        ...drainOptions,
        maxEntries: 1,
        preferredJobId,
        onlyPreferred: true,
      });
      merge(partial);
      if (partial.reviewed + partial.discarded + partial.failed > 0) break;
    }
  }
  for (const ownerIdentity of deriveCodingMemoryReviewIdentities(options, identity)) {
    if (abortSignal?.aborted) break;
    const spent = result.reviewed + result.discarded + result.failed;
    if (spent >= 2) break;
    const partial = await drainPendingEpisodeReviews(ownerIdentity, {
      ...drainOptions,
      maxEntries: 2 - spent,
      // The preferred pass already considered this job. Provider-unavailable
      // failures have no backoff, so reclaiming it here can race the next Run.
      ...(preferredJobId === undefined ? {} : { excludedJobId: preferredJobId }),
    });
    merge(partial);
  }
  if (result.reviewed > 0 || result.discarded > 0 || result.failed > 0) {
    emitResilienceDebug('[memory:review-inbox:drain]', { ...result });
  }
  return result;
}

export function deriveCodingMemoryReviewIdentities(
  options: KodaXOptions,
  identity: MemoryContextIdentity,
  cwd = resolveExecutionCwd(options.context),
): readonly MemoryContextIdentity[] {
  if (identity.projectId === undefined) return [identity];
  const localProjectId = `local:${path.resolve(cwd).toLowerCase()}`;
  if (identity.projectId === localProjectId) return [identity];
  return [identity, { ...identity, projectId: localProjectId }];
}

function isReviewEnvelope(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'memoryPlan' in value;
}

async function buildUnifiedReviewInput(
  options: KodaXOptions,
  identity: MemoryContextIdentity,
  controller: MemoryController,
  entry: PendingEpisodeReviewV2,
): Promise<UnifiedLearningReviewModelInput> {
  if (controller.prepareEpisodeReview === undefined) {
    throw new EpisodeReviewFailure(
      'provider_unavailable',
      'memory controller does not support unified episode review preparation',
    );
  }
  const memory = await controller.prepareEpisodeReview(entry.digest);
  const priorDigests = await priorOutcomeDigests(
    options.session?.storage,
    entry,
    resolveExecutionCwd(options.context),
  );
  const evidence = entry.digest.evidence ?? [];
  const expectedVerdict = entry.digest.outcome === 'succeeded' ? 'passed' : 'failed';
  const verifiedOutcome = evidence.some((item) => (
    isTrustedTerminalEvidence(item)
    && item.verdict === expectedVerdict
  ));
  const matchingEpisodes = [entry.digest, ...priorDigests].filter((candidate) => (
    entry.digest.actionSignature !== undefined
    && candidate.actionSignature === entry.digest.actionSignature
    && candidate.outcome === 'succeeded'
    && (candidate.evidence ?? []).some((item) => (
      isTrustedTerminalEvidence(item) && item.verdict === 'passed'
    ))
  ));
  const packet: LearningReviewEvidencePacket = {
    outcomeDigest: entry.digest,
    verifierFacts: evidence
      .filter((item) => (
        isTrustedTerminalEvidence(item)
        && (item.verdict === 'passed' || item.verdict === 'failed')
      ))
      .map((item) => ({ ref: item.ref, verdict: item.verdict as 'passed' | 'failed' })),
    priorDigests,
    qualification: {
      reusableMethodEvidence: entry.digest.actionSignature !== undefined
        && entry.digest.outcome === 'succeeded'
        && (entry.digest.lesson !== undefined || entry.digest.preconditions !== undefined),
      independentEpisodeCount: new Set(matchingEpisodes.map((item) => item.reviewKey)).size,
      verifiedOutcome,
      failedWithLesson: entry.digest.outcome === 'failed' && entry.digest.lesson !== undefined,
    },
  };
  return sanitizeUnifiedLearningReviewInput({
    cacheDomain: 'learning-review',
    memory,
    evidence: packet,
  });
}

async function priorOutcomeDigests(
  storage: KodaXSessionStorage | undefined,
  entry: PendingEpisodeReviewV2,
  projectRoot: string,
): Promise<readonly KodaXMemoryOutcomeDigest[]> {
  if (storage === undefined) return [];
  const sessionIds = [
    entry.ownerSessionRef,
    ...(storage.list === undefined
      ? []
      : (await storage.list(projectRoot, { limit: 20 }))
          .map((session) => session.id)
          .filter((sessionId) => sessionId !== entry.ownerSessionRef)),
  ];
  const prior: KodaXMemoryOutcomeDigest[] = [];
  for (const sessionId of sessionIds) {
    const data = await storage.load(sessionId);
    if (data === null) continue;
    const lineage = data.lineage ?? createSessionLineage(data.messages);
    const activePathIds = new Set(getSessionLineagePath(lineage).map((candidate) => candidate.id));
    const matching = lineage.entries
      .filter((candidate) => (
        candidate.type === 'memory_outcome_digest'
        && (candidate.parentId === null || activePathIds.has(candidate.parentId))
        && candidate.digest.reviewKey !== entry.reviewKey
        && candidate.digest.visibility === 'prompt_safe'
        && entry.digest.actionSignature !== undefined
        && candidate.digest.actionSignature === entry.digest.actionSignature
      ))
      .at(-1);
    if (matching?.type === 'memory_outcome_digest') {
      prior.push(matching.digest);
    }
    if (prior.length >= 2) break;
  }
  return prior;
}

function isTrustedTerminalEvidence(
  evidence: NonNullable<KodaXMemoryOutcomeDigest['evidence']>[number],
): boolean {
  return (evidence.grade === 'verified' || evidence.grade === 'authoritative')
    && evidence.source !== 'agent';
}

async function applyUnifiedReviewAction(
  options: KodaXOptions,
  identity: MemoryContextIdentity,
  controller: MemoryController,
  entry: PendingEpisodeReviewV2,
  decision: import('@kodax-ai/agent').EpisodeReviewDecision,
  carrier: 'memory' | 'skill',
  commitWithAuthority: (
    effect: (revalidateAuthority: () => Promise<void>) => Promise<readonly string[]>,
  ) => Promise<readonly string[]>,
): Promise<readonly string[]> {
  // Learned Skills were removed (FEATURE_309). A review decided before then may still
  // list a skill carrier; it finishes with no effect so the review can complete.
  if (carrier === 'skill') return [];
  const plan = decision.memoryPlan;
  if (!isPersistedMemoryReviewPlan(plan)) {
    throw new Error('committed unified review decision has an invalid Memory plan');
  }
  const applyReviewedEpisode = controller.applyReviewedEpisode?.bind(controller);
  if (applyReviewedEpisode === undefined) {
    throw new Error('memory controller does not support unified episode review apply');
  }
  return commitWithAuthority(async (revalidateAuthority) => {
    const memory = await applyReviewedEpisode(
      plan,
      entry.digest,
      undefined,
      revalidateAuthority,
    );
    return memory.proposalIds;
  });
}

function isPersistedMemoryReviewPlan(value: unknown): value is MemoryReviewPlan {
  return typeof value === 'object'
    && value !== null
    && 'trigger' in value
    && 'actions' in value
    && Array.isArray(value.actions)
    && 'candidateRefs' in value
    && Array.isArray(value.candidateRefs)
    && 'warnings' in value
    && Array.isArray(value.warnings);
}

async function reviewPendingEpisode(
  options: KodaXOptions,
  controller: MemoryController,
  entry: PendingEpisodeReview,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  signal?.throwIfAborted();
  await persistMemoryOutcomeToSession(
    options,
    entry.ownerSessionRef,
    entry.digest,
    { emitEvent: false },
  );
  signal?.throwIfAborted();
  const review = await reviewEpisodeWithTimeout(controller, entry.digest, signal);
  // A successful legacy review may already have applied effects. Finish its
  // receipt even if cancellation arrives now, so recovery cannot replay them.
  const completedAt = new Date().toISOString();
  await persistMemoryReviewReceiptToSession(options, entry.ownerSessionRef, {
    reviewKey: entry.reviewKey,
    proposalIds: review.proposalIds,
    completedAt,
    ...(review.appliedProposalIds.length === 0
      ? {}
      : {
          notice: {
            episodeId: entry.digest.id,
            summaries: appliedMemoryReviewSummaries(review),
            proposalIds: review.appliedProposalIds,
          },
        }),
  });
  return review.proposalIds;
}

async function reviewEpisodeWithTimeout(
  controller: MemoryController,
  digest: KodaXMemoryOutcomeDigest,
  signal?: AbortSignal,
): ReturnType<MemoryController['reviewEpisode']> {
  const abort = new AbortController();
  signal?.throwIfAborted();
  const onAbort = () => abort.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const review = controller.reviewEpisode(digest, abort.signal);
    // Owned reviews retain their promise until cancellation has really unwound.
    if (signal !== undefined) {
      timeout = setTimeout(() => abort.abort(), 30_000);
      return await review;
    }
    return await Promise.race([
      review,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          abort.abort();
          reject(new Error('delayed memory review timed out after 30000ms'));
        }, 30_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

