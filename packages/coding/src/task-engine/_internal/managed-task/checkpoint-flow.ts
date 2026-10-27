/**
 * Pre-run checkpoint flow + structural resume seed + per-role checkpoint
 * writer — FEATURE_171 v0.7.41 split extracted verbatim from
 * `task-engine/runner-driven.ts` (Shard 6c + structural resume).
 * No behavior change.
 *
 * Public surface:
 *   - `handlePreRunCheckpoint(options)` — pre-run dialog driving the
 *     resume / restart / cancel decision. Returns `{ resumeFrom }` when
 *     the caller should seed the recorder; `undefined` otherwise.
 *   - `buildResumePreamble(checkpoint)` — reconstruct a human-readable
 *     preamble from a validated checkpoint so the resumed run sees prior
 *     Scout findings, contract, and last verdict in plain text.
 *   - `buildStructuralResumeSeed(validated)` — resume marker for the
 *     runner. Harness-tier replay is retired; it always reports H0_DIRECT.
 *   - `writeCurrentCheckpoint(args)` — crash-safe per-role checkpoint
 *     writer; best-effort, returns the workspaceDir or `undefined`.
 *
 * Re-exported by `runner-driven.ts` so callers continue to reach these
 * helpers from the original import path.
 */

import path from 'node:path';

import { asSingleSelection, isAskUserUnanswered } from '@kodax-ai/agent';
import type {
  KodaXHarnessProfile,
  KodaXManagedTask,
  KodaXOptions,
  KodaXTaskRole,
} from '../../../types.js';
import type {
  ManagedTaskCheckpoint,
  ValidatedCheckpoint,
} from './checkpoint.js';
import {
  deleteCheckpoint,
  findValidCheckpoint,
  getCheckpointSessionId,
  getGitHeadCommit,
  writeCheckpoint,
} from './checkpoint.js';
import {
  getManagedTaskSurface,
  getManagedTaskWorkspaceRoot,
} from './workspace.js';

/**
 * Shard 6c + structural resume (v0.7.26).
 *
 * Legacy behaviour (task-engine.ts:~6644 + `resumeManagedTask`): ask the
 * user whether to continue or restart, then either replay the partial
 * state (seeded plan, scoutDecision, budget) or drop the checkpoint.
 *
 *   - "restart" → delete stale checkpoint, start fresh.
 *   - "resume" → keep the checkpoint, return `{ resumeFrom }` so the
 *     caller can seed the recorder via `buildStructuralResumeSeed` and
 *     (depending on what roles already completed) start Runner.run at
 *     planner / generator / evaluator instead of scout. The textual
 *     preamble (`buildResumePreamble`) is still prepended for readability
 *     and to give any resumed-scout retries the prior findings in plain
 *     text.
 *   - "cancel" → delete the checkpoint + throw — the user asked to abort.
 *   - no askUser callback → silently clean up; non-interactive contexts
 *     can't prompt for a decision.
 */
export async function handlePreRunCheckpoint(
  options: KodaXOptions,
): Promise<{ resumeFrom: ValidatedCheckpoint } | undefined> {
  let validated: ValidatedCheckpoint | undefined;
  try {
    validated = await findValidCheckpoint(options);
  } catch {
    return undefined;
  }
  if (!validated) return undefined;

  const deleteSafely = async (): Promise<void> => {
    try {
      await deleteCheckpoint(validated!.workspaceDir);
    } catch {
      // Delete failure is non-fatal; the next run will see the same
      // stale checkpoint and reach this branch again.
    }
  };

  if (!options.events?.askUser) {
    await deleteSafely();
    return undefined;
  }

  const useChinese = /[一-鿿]/.test(validated.managedTask.contract.objective ?? '');
  const result = await options.events.askUser({
    question: useChinese ? '发现未完成的任务' : 'Found incomplete task',
    allowCustomInput: false,
    options: [
      {
        // H1 parity (v0.7.26) — text-level resume. The next run's prompt
        // receives a reconstructed preamble (Scout findings, contract,
        // last verdict) so the LLM can pick up where it left off
        // without re-investigating. Full structural replay of the
        // recorder state is deliberately out of scope for this MVP.
        label: useChinese ? '继续未完成的工作' : 'Resume',
        value: 'resume',
        description: useChinese
          ? '在先前 Scout/执行结果的基础上继续（上下文保留）'
          : 'Continue with preserved prior Scout / execution context',
      },
      {
        label: useChinese ? '重新开始' : 'Restart',
        value: 'restart',
        description: useChinese ? '丢弃之前的进度，重新开始' : 'Discard previous progress and start fresh',
      },
      {
        label: useChinese ? '取消' : 'Cancel',
        value: 'cancel',
        description: useChinese ? '中止当前请求' : 'Abort the current request',
      },
    ],
    default: 'resume',
  });
  // Leave the earlier task untouched; the current request has not chosen it.
  if (isAskUserUnanswered(result)) return undefined;
  const answer = asSingleSelection(result);
  if (answer === 'cancel') {
    await deleteSafely();
    throw new Error('Runner-driven path: user cancelled due to pre-existing checkpoint');
  }
  if (answer === 'resume') {
    // Keep the checkpoint in place — it gets rewritten fresh on the
    // next role emit. The caller builds a preamble from the validated
    // state and feeds it into the prompt.
    return { resumeFrom: validated };
  }
  if (answer === 'restart') await deleteSafely();
  return undefined;
}

/**
 * H1 parity (v0.7.26) — reconstruct a human-readable preamble from the
 * checkpoint's managedTask state. The next run pre-pends this onto the
 * user prompt so Scout / Generator / Evaluator see the prior
 * investigation + findings and can pick up the work instead of
 * rediscovering it. Text-level resume — not a full structural replay
 * of the recorder — but a meaningful quality-of-life improvement over
 * the prior "restart from scratch" behaviour.
 */
export function buildResumePreamble(checkpoint: ValidatedCheckpoint): string {
  const task = checkpoint.managedTask;
  const lines: string[] = [
    '=== RESUMING INCOMPLETE TASK ===',
    `Checkpoint from: ${checkpoint.checkpoint.createdAt}`,
    `Original objective: ${task.contract.objective}`,
    `Roles already executed: ${checkpoint.checkpoint.completedWorkerIds.join(', ') || 'none'}`,
  ];
  // FEATURE_193 (v0.7.43) deep V1 cleanup: the "Scout findings" preamble
  // block — read from the V1-only `task.runtime?.scoutDecision` SDK field
  // — was deleted alongside the deprecated field. Pre-F193 checkpoints
  // resume with the contract / verdict preamble blocks below; the prior
  // Scout findings narrative is no longer surfaced (its information was
  // already absorbed into the contract summary that the V1 Planner role
  // produced from Scout output).
  const contract = task.contract.contractSummary;
  if (contract) {
    lines.push('', '--- Contract (already produced) ---');
    lines.push(contract);
    if (task.contract.successCriteria.length > 0) {
      lines.push('Success criteria:');
      for (const c of task.contract.successCriteria) lines.push(`  - ${c}`);
    }
  }
  if (task.verdict?.summary) {
    lines.push('', '--- Last verdict ---');
    lines.push(`Status: ${task.verdict.status}`);
    lines.push(`Summary: ${task.verdict.summary}`);
  }
  lines.push(
    '',
    'Use this preserved context to avoid redundant investigation. Continue the work from where it was interrupted.',
    '=== END RESUME CONTEXT ===',
    '',
  );
  return lines.join('\n');
}

/**
 * Structural resume seed — reconstruct the carry-forward marker from a
 * validated checkpoint. Harness-tier replay is retired; V2 resumes always
 * run through the same Worker path and budget cap.
 *
 * FEATURE_193 (v0.7.43): V1 `recorderSlots.scout` / `recorderSlots.contract`
 * population removed alongside the retired Scout/Planner roles. The
 * seed used to also synthesise scout/contract `ProtocolEmitterMetadata`
 * from the checkpoint's `scoutDecision` / `contractSummary` so the
 * V1 chain could skip already-completed roles; on V2 the only entry
 * point is `chain.worker` and the seed carries no recorder slots at
 * all. The `recorderSlots` field is retained on the interface as an
 * empty struct for pre-1.0 SDK compat (callers grep on `seed.recorderSlots`
 * existence to detect resume vs fresh).
 *
 * Pre-F193 checkpoints (carrying `scoutDecision` / `contractSummary`)
 * resume to a fresh Worker turn — the textual preamble
 * (`buildResumePreamble`) still surfaces the prior findings in the
 * Worker prompt so the LLM picks up the work; full structural replay
 * of V1 slot state is no longer meaningful.
 */
export interface StructuralResumeSeed {
  readonly recorderSlots: Record<string, never>;
  readonly harness: KodaXHarnessProfile;
  readonly rolesEmitted: readonly KodaXTaskRole[];
}

export function buildStructuralResumeSeed(_validated: ValidatedCheckpoint): StructuralResumeSeed {
  const rolesEmitted: KodaXTaskRole[] = [];
  // FEATURE_193 (v0.7.43): no recorder slots populated on V2. The
  // empty Record literal carries the structural intent.
  return { recorderSlots: {}, harness: 'H0_DIRECT', rolesEmitted };
}

/**
 * Shard 6c: write a crash-safe checkpoint after each role transition.
 * Allows legacy tools and future resume logic to inspect partial state.
 */
export async function writeCurrentCheckpoint(args: {
  readonly options: KodaXOptions;
  readonly managedTask: KodaXManagedTask;
  readonly currentRound: number;
  readonly completedWorkerIds: readonly string[];
  readonly scoutCompleted: boolean;
}): Promise<string | undefined> {
  const { options, managedTask, currentRound, completedWorkerIds, scoutCompleted } = args;
  try {
    const surface = getManagedTaskSurface(options);
    const workspaceRoot = getManagedTaskWorkspaceRoot(options, surface);
    const workspaceDir = path.join(workspaceRoot, managedTask.contract.taskId);
    const gitCommit = (await getGitHeadCommit(options.context?.gitRoot)) ?? 'unknown';
    const sessionId = getCheckpointSessionId(options);
    const checkpoint: ManagedTaskCheckpoint = {
      version: 1,
      taskId: managedTask.contract.taskId,
      ...(sessionId ? { sessionId } : {}),
      processId: process.pid,
      createdAt: managedTask.contract.createdAt,
      gitCommit,
      objective: managedTask.contract.objective,
      harnessProfile: managedTask.contract.harnessProfile,
      currentRound,
      completedWorkerIds: [...completedWorkerIds],
      scoutCompleted,
    };
    await writeCheckpoint(workspaceDir, checkpoint);
    return workspaceDir;
  } catch {
    // Checkpoint write is best-effort — failures should not abort the run.
    return undefined;
  }
}
