/**
 * FEATURE_217/229 /workflow slash command wiring.
 * Parser, formatting, live updates, and builder helpers live beside this file.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import chalk from 'chalk';
import { buildWorkflowCapsuleIntent, getAgentConfigPath, isFinalWorkflowProcessStatus } from '@kodax-ai/agent';
import type {
  WorkflowModule,
  WorkflowCapsule,
  WorkflowProcessSnapshot,
  WorkflowScriptManifest,
} from '@kodax-ai/agent';
import {
  buildApprovalSummary,
  createWorkflowLifecycleController,
  getBuiltinWorkflow,
  listBuiltinWorkflows,
  listWorkflowPatternTemplates,
  discoverSavedWorkflows,
  generateWorkflowFromOptions,
  getDefaultWorkflowRunManager,
  requestSessionWorkflowStop,
  loadGeneratedWorkflowFromRun,
  loadSavedWorkflow,
  loadSavedWorkflowCapsule,
  preflightWorkflowCapsule,
  renameSavedWorkflow,
  replaceSavedWorkflow,
  saveGeneratedWorkflow,
  saveGeneratedWorkflowFromRun,
  buildScoutThenAuthorPrompt,
  type SavedWorkflowRef,
} from '@kodax-ai/coding';

import { deriveProjectKeyFromRoot } from '../interactive/project-key.js';
import {
  printLearningPendingForFilter,
  resolveLearningCommandCwd,
} from './learning-inbox.js';
import type { Command, CommandResultData } from './types.js';
import {
  buildWorkflowProcessMetadata,
} from './workflow-command-builder.js';
export { startGeneratedWorkflowFromRequest } from './workflow-command-builder.js';
import {
  createWorkflowLiveUpdateEmitter,
  emitWorkflowRunMessage,
  observeManagedWorkflowDone,
  subscribeWorkflowLiveProcess,
  workflowEventSink,
} from './workflow-command-live.js';
import { unsubscribeWorkflowLiveProcessOnDone } from './workflow-command-cleanup.js';
export { unsubscribeWorkflowLiveProcessOnDone } from './workflow-command-cleanup.js';
export {
  createWorkflowLiveUpdateEmitter,
  observeManagedWorkflowDone,
  type GeneratedWorkflowApprovalMode,
  type GeneratedWorkflowStartOutcome,
  type StartGeneratedWorkflowFromRequestOptions,
  type WorkflowBuilderEvent,
  type WorkflowBuilderStage,
  type WorkflowLiveUpdateEmitter,
} from './workflow-command-live.js';
import {
  buildWorkflowRevisionProvenance,
  canRerunWorkflowRun,
  currentWorkflowPreflightEnv,
  detectWorkflowLocale,
  ensureSafeRunId,
  formatManagedRunsList,
  formatRunsList,
  formatSavedList,
  formatWorkflowList,
  formatWorkflowNextActions,
  formatWorkflowPruneCandidates,
  formatWorkflowRunSnapshot,
  inferWorkflowLocaleFromParts,
  isActiveManagedWorkflowRun,
  isTerminalWorkflowStatus,
  nextRevisionWorkflowName,
  prepareSavedWorkflow,
  printPreflightFailure,
  printPreflightWarnings,
  printWorkflowHelp,
  readWorkflowRunDetail,
  readWorkflowRuns,
  renderApprovalPrompt,
  resolveConfirm,
  savedWorkflowDirs,
  selectDefaultActiveWorkflowRunId,
  selectDefaultWorkflowRunId,
  type WorkflowApprovalRenderContext,
  type WorkflowPruneCandidate,
  type WorkflowRunLocale,
  type WorkflowRunPresentation,
  type WorkflowRunSummary,
} from './workflow-command-helpers.js';
export {
  createWorkflowAgentDigestLimiter,
  formatFinalEventSummary,
  formatManagedRunsList,
  formatResult,
  formatRunsList,
  formatSavedList,
  formatWorkflowAgentDigest,
  formatWorkflowList,
  formatWorkflowPruneCandidates,
  formatWorkflowRunSnapshot,
  isActiveManagedWorkflowRun,
  isSafeWorkflowRunId,
  isTerminalWorkflowStatus,
  readWorkflowRunDetail,
  readWorkflowRuns,
  renderApprovalPrompt,
  renderWorkflowHelp,
  resolveConfirm,
  savedWorkflowDirs,
  selectDefaultActiveWorkflowRunId,
  selectDefaultWorkflowRunId,
  selectWorkflowPruneCandidates,
  type WorkflowApprovalRenderContext,
  type WorkflowPruneCandidate,
  type WorkflowRunDetail,
  type WorkflowRunLocale,
  type WorkflowRunPresentation,
  type WorkflowRunSnapshotFormatOptions,
  type WorkflowRunSummary,
  type WorkflowRunsListFormatOptions,
} from './workflow-command-helpers.js';
import {
  buildWorkflowRevisionRequest,
  parseWorkflowArgs,
  parseWorkflowInvocation,
  parseWorkflowPruneOptions,
  parseWorkflowRunsOptions,
  type WorkflowPruneOptions,
} from './workflow-command-parse.js';
export {
  buildWorkflowRevisionRequest,
  DEFAULT_WORKFLOW_PRUNE_KEEP,
  DEFAULT_WORKFLOW_RUNS_LIMIT,
  parseWorkflowArgs,
  parseWorkflowInvocation,
  parseWorkflowPruneOptions,
  parseWorkflowRunsOptions,
  type WorkflowInvocation,
  type WorkflowPruneOptions,
  type WorkflowRunsOptions,
} from './workflow-command-parse.js';

/* ----------------------------- pure helpers ----------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

function processSnapshotsByRunId(
  snapshots: readonly WorkflowProcessSnapshot[],
): ReadonlyMap<string, WorkflowProcessSnapshot> {
  return new Map(snapshots.map((snapshot) => [snapshot.runId, snapshot]));
}

function workflowPruneRetentionOptions(options: WorkflowPruneOptions): {
  readonly dryRun?: boolean;
  readonly keep?: number;
  readonly olderThanDays?: number;
} {
  return {
    dryRun: options.dryRun,
    ...(options.keep !== undefined ? { keep: options.keep } : {}),
    ...(options.olderThanMs !== undefined ? { olderThanDays: options.olderThanMs / DAY_MS } : {}),
  };
}

function workflowPruneCandidateSummaries(
  runSummaries: readonly WorkflowRunSummary[],
  candidateRunIds: readonly string[],
): readonly WorkflowPruneCandidate[] {
  const byRunId = new Map(runSummaries.map((run) => [run.runId, run]));
  return candidateRunIds.map((runId) => {
    const run = byRunId.get(runId);
    return {
      runId,
      workflow: run?.workflow ?? '?',
      status: run?.status ?? '?',
      endedAt: run?.endedAt ?? 0,
    };
  });
}

function buildSavedWorkflowProcessMetadata(input: {
  readonly displayName: string;
  readonly savedWorkflowName: string;
  readonly provenance?: WorkflowCapsule['provenance'];
}) {
  return buildWorkflowProcessMetadata({
    source: 'capsule',
    displayName: input.displayName,
    savedWorkflowName: input.savedWorkflowName,
    sourceRunId: input.provenance?.fromRunId,
    sourceWorkflowName: input.provenance?.fromWorkflowName ?? input.savedWorkflowName,
    revisionOf: input.provenance?.revisionOf,
  });
}

export const workflowCommand: Command = {
  name: 'workflow',
  description: 'Run a dynamic multi-agent workflow (FEATURE_217)',
  usage: '/workflow [help | list | pending | runs | show | pause | resume | stop | delete | prune | rerun | save | rename | revise | create | <name> [args] | <request>]',
  argumentHint: 'help | list | pending | runs [--all|--limit N] | show [runId] | pause <runId> | resume <runId> | stop [runId] | delete [--force] [--run|--saved] <runId|savedName> | prune --dry-run|--keep N|--older-than Nd | rerun <runId|savedName> [args] | save <runId> <name> | rename <runId|alias|savedName> <newName> | revise [--replace] <runId|alias|savedName> <change> | create <request> | <name> [args]',
  detailedHelp: printWorkflowHelp,
  handler: async (args, context, callbacks, currentConfig) => {
    if ((args[0] ?? '').toLowerCase() === 'pending') {
      await printLearningPendingForFilter(resolveLearningCommandCwd(context), 'workflow');
      return;
    }

    const invocation = parseWorkflowInvocation(args);

    // FEATURE_246: Solo (SA) mode is a single agent — it runs no workflows and
    // spawns no sub-agents. Reject the execution-class subcommands (create / run
    // a workflow by name / rerun); read-only and management subcommands (list,
    // runs, show, save, rename, revise, delete, prune, pause/resume/stop) stay so
    // a user can still inspect and tidy runs left by an earlier AMA/AMAW session.
    if (
      currentConfig.agentMode === 'sa'
      && (invocation.kind === 'create' || invocation.kind === 'rerun' || invocation.kind === 'start')
    ) {
      console.log(
        chalk.yellow(
          '\n[workflow] Workflows run multiple agents, which Solo (SA) mode does not support.\n'
          + 'Switch with /agent-mode ama, then request it explicitly via /workflow.\n',
        ),
      );
      return;
    }

    const projectKey = deriveProjectKeyFromRoot(process.cwd()).key;
    const baseDir = getAgentConfigPath('workflow-runs', projectKey);
    const manager = getDefaultWorkflowRunManager();

    const dirs = savedWorkflowDirs(process.cwd());
    const lifecycle = createWorkflowLifecycleController({
      runManager: manager,
      runBaseDir: baseDir,
      savedWorkflowDirs: dirs,
    });

    // FEATURE_246 (ADR-047): turn a free-text request into a workflow. The Worker
    // authors it itself (scout-then-author via run_workflow), returned as an
    // agent-turn invocation. Shared by the explicit `create` subcommand and the
    // bare `/workflow <prompt>` form. Only reached in AMA — Solo (SA) mode
    // rejects execution-class workflow commands upstream (see the guard below).
    // The command carries a structured explicit-intent marker; there is no hidden
    // mode elevation and task complexity alone cannot activate a Workflow.
    const createWorkflowFromText = async (request: string): Promise<CommandResultData | undefined> => {
      return {
        invocation: {
          source: 'prompt',
          displayName: 'workflow create',
          disableModelInvocation: false,
          workflowIntent: 'explicit',
          // FEATURE_246 — shared with the SDK `authorWorkflowViaWorker` entrypoint
          // so both produce a byte-identical scout-then-author turn.
          prompt: buildScoutThenAuthorPrompt(request),
        },
      };
    };

    if (invocation.kind === 'help') {
      printWorkflowHelp();
      return;
    }

    if (invocation.kind === 'list') {
      console.log(chalk.bold('\nBuilt-in workflows:'));
      console.log(formatWorkflowList(listBuiltinWorkflows()));
      console.log(chalk.bold('\nPattern templates:'));
      for (const template of listWorkflowPatternTemplates()) {
        console.log(`  ${chalk.cyan(template.name)} ${chalk.dim(`(${template.pattern})`)} - ${template.description}`);
      }
      const saved = await discoverSavedWorkflows(dirs);
      if (saved.length > 0) {
        console.log(chalk.bold('\nSaved workflows:'));
        console.log(formatSavedList(saved));
      }
      console.log(chalk.dim('\n  Run one with: /workflow <name> <question or JSON args>'));
      console.log(chalk.dim('  Show usage with: /workflow help\n'));
      return;
    }

    if (invocation.kind === 'runs') {
      const options = parseWorkflowRunsOptions(invocation.rawArgs);
      if (options.error) {
        console.log(chalk.yellow(`\nUsage: /workflow runs [--all] [--limit N]\n${options.error}\n`));
        return;
      }
      const processSnapshots = processSnapshotsByRunId(lifecycle.listWorkflowProcessSnapshots({ activeOnly: false }));
      const active = manager.list().filter(isActiveManagedWorkflowRun);
      if (active.length > 0) {
        console.log(chalk.bold('\nActive workflow runs:'));
        console.log(formatManagedRunsList(active, { processSnapshots }));
      }
      console.log(chalk.bold('\nWorkflow runs:'));
      console.log(formatRunsList(readWorkflowRuns(baseDir), {
        limit: options.all ? undefined : options.limit,
        showLimitHint: !options.all,
        processSnapshots,
      }));
      console.log();
      return;
    }

    if (invocation.kind === 'show') {
      const persistedRuns = readWorkflowRuns(baseDir);
      const runId = invocation.runId
        || selectDefaultWorkflowRunId(manager.list(), persistedRuns);
      if (!runId) {
        console.log(chalk.yellow('\nNo workflow runs yet. Start one with /workflow create <request>.\n'));
        return;
      }
      if (!ensureSafeRunId(runId)) return;
      const managed = manager.get(runId);
      const detail = readWorkflowRunDetail(baseDir, runId);
      const processSnapshot = lifecycle.getWorkflowProcessSnapshot(runId);
      console.log(chalk.bold('\nWorkflow run:'));
      console.log(formatWorkflowRunSnapshot(managed, detail, {
        full: invocation.full === true,
        ...(processSnapshot ? { processSnapshot } : {}),
      }));
      console.log();
      return;
    }

    if (invocation.kind === 'pause') {
      if (!ensureSafeRunId(invocation.runId)) return;
      const ok = manager.pause(invocation.runId);
      console.log(ok ? chalk.dim(`Paused workflow ${invocation.runId}.\n`) : chalk.yellow(`No running workflow ${invocation.runId}.\n`));
      return;
    }

    if (invocation.kind === 'resume') {
      if (!ensureSafeRunId(invocation.runId)) return;
      const ok = manager.resume(invocation.runId);
      console.log(ok ? chalk.dim(`Resumed workflow ${invocation.runId}.\n`) : chalk.yellow(`No paused workflow ${invocation.runId}.\n`));
      return;
    }

    if (invocation.kind === 'stop') {
      const runId = invocation.runId || selectDefaultActiveWorkflowRunId(manager.list().filter((run) =>
        manager.getWorkflowProcessSnapshot(run.runId)?.hostMetadata?.ownerSessionId === context.sessionId));
      if (!runId) {
        console.log(chalk.yellow('\nNo active workflow to stop.\n'));
        return;
      }
      if (!ensureSafeRunId(runId)) return;
      const snapshot = manager.get(runId);
      let ok = false;
      if (snapshot && isActiveManagedWorkflowRun(snapshot)) {
        try { ok = requestSessionWorkflowStop(manager, context.sessionId ?? '', runId).accepted; }
        catch (error) {
          process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
          return;
        }
      }
      const detail = readWorkflowRunDetail(baseDir, runId);
      const processSnapshot = lifecycle.getWorkflowProcessSnapshot(runId);
      const status = snapshot?.status ?? detail?.status ?? processSnapshot?.status;
      const alreadyTerminal = snapshot
        ? !isActiveManagedWorkflowRun(snapshot)
        : detail
          ? isTerminalWorkflowStatus(detail.status)
          : processSnapshot !== undefined && isFinalWorkflowProcessStatus(processSnapshot.status);
      const nextActions = formatWorkflowNextActions(
        runId,
        canRerunWorkflowRun(snapshot, detail),
      );
      console.log(ok
        ? chalk.dim(`Stop requested for workflow ${runId}; waiting for cleanup.\n`)
        : status && alreadyTerminal
          ? chalk.yellow(`Workflow ${runId} is already ${status}. Next: ${nextActions}.\n`)
          : chalk.yellow(`No active workflow ${runId}.\n`));
      return;
    }

    if (invocation.kind === 'delete') {
      if (!invocation.target) {
        console.log(chalk.yellow('\nUsage: /workflow delete [--force] [--run|--saved] <runId|savedName>\n'));
        return;
      }
      if (invocation.scope === 'conflict') {
        console.log(chalk.red('\n[workflow] choose only one delete scope: --run or --saved.\n'));
        return;
      }
      const deleteSavedWorkflowTarget = async (
        name: string,
        source?: SavedWorkflowRef['source'],
      ): Promise<void> => {
        try {
          const deleted = await lifecycle.deleteSavedWorkflow(name, source);
          if (!deleted) {
            console.log(chalk.red('\n[workflow] saved workflow deletion is unavailable in this context.\n'));
            return;
          }
          console.log(chalk.dim(`\nDeleted saved workflow ${deleted.name}.\n`));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(chalk.red(`\n[workflow] delete failed: ${message}\n`));
        }
      };
      if (invocation.scope === 'saved') {
        await deleteSavedWorkflowTarget(invocation.target);
        return;
      }
      const activeSnapshot = manager.getWorkflowProcessSnapshot(invocation.target);
      const resolution = activeSnapshot
        ? undefined
        : await lifecycle.resolveWorkflowIdentity(invocation.target);
      let resolvedRunId: string | undefined;
      if (resolution?.kind === 'ambiguous') {
        if (resolution.run) {
          resolvedRunId = resolution.run.runId;
        } else {
          console.log(
            chalk.red(
              `\n[workflow] ambiguous delete target: ${invocation.target} matches multiple workflow run/display names${resolution.matches.includes('saved') ? ' and a saved workflow name' : ''}. Use the concrete run id, or --saved when deleting a generated saved capsule.\n`,
            ),
          );
          return;
        }
      }
      if (resolution?.kind === 'saved') {
        if (invocation.scope === 'run') {
          console.log(chalk.yellow(`\nNo persisted workflow run ${invocation.target}. Use --saved to delete the saved workflow.\n`));
          return;
        }
        await deleteSavedWorkflowTarget(
          resolution.savedWorkflow.name,
          resolution.savedWorkflow.source,
        );
        return;
      }
      if (resolution?.kind === 'missing') {
        console.log(chalk.yellow(`\nNo persisted workflow run or generated saved workflow ${invocation.target}.\n`));
        return;
      }
      const runId = resolution?.kind === 'run'
        ? resolution.runId
        : resolvedRunId ?? invocation.target;
      if (!ensureSafeRunId(runId)) return;
      const deleted = await lifecycle.deleteWorkflowRun(runId, { force: invocation.force });
      if (deleted) {
        console.log(chalk.dim(`\nDeleted workflow run ${runId}${invocation.force ? ' with --force' : ''}.\n`));
        return;
      }
      const currentActiveSnapshot = activeSnapshot ?? manager.getWorkflowProcessSnapshot(runId);
      const processSnapshot = lifecycle.getWorkflowProcessSnapshot(runId);
      if (!processSnapshot && !existsSync(join(baseDir, runId, 'run.json'))) {
        console.log(chalk.yellow(`\nNo persisted workflow run or generated saved workflow ${invocation.target}.\n`));
        return;
      }
      if (currentActiveSnapshot && !isFinalWorkflowProcessStatus(currentActiveSnapshot.status)) {
        console.log(chalk.yellow(`\nWorkflow ${runId} is ${currentActiveSnapshot.status}. Stop it before deleting the run record.\n`));
        return;
      }
      if (processSnapshot && !isFinalWorkflowProcessStatus(processSnapshot.status)) {
        console.log(chalk.yellow(`\nWorkflow ${runId} is a non-terminal persisted ${processSnapshot.status} record. If it is stale, run /workflow delete --force ${runId}.\n`));
        return;
      }
      console.log(chalk.yellow(`\nWorkflow ${runId} is not a deletable terminal run.\n`));
      return;
    }

    if (invocation.kind === 'prune') {
      const options = parseWorkflowPruneOptions(invocation.rawArgs);
      if (options.error) {
        console.log(chalk.yellow(`\nUsage: /workflow prune --dry-run | --keep N | --older-than Nd\n${options.error}\n`));
        return;
      }
      if (!options.dryRun && options.keep === undefined && options.olderThanMs === undefined) {
        console.log(chalk.yellow('\nUsage: /workflow prune --dry-run | --keep N | --older-than Nd\nNo cleanup rule was provided.\n'));
        return;
      }
      // Keep display metadata before prune deletes candidate directories.
      const runSummaries = readWorkflowRuns(baseDir);
      const retention = await lifecycle.pruneWorkflowRuns(workflowPruneRetentionOptions(options));
      const candidates = workflowPruneCandidateSummaries(runSummaries, retention.candidates);
      console.log(chalk.bold(options.dryRun ? '\nWorkflow prune preview:' : '\nWorkflow prune:'));
      console.log(formatWorkflowPruneCandidates(candidates));
      if (retention.protectedRuns > 0) {
        console.log(
          chalk.dim(
            `\nProtected ${retention.protectedRuns} active workflow run${retention.protectedRuns === 1 ? '' : 's'} from pruning.`,
          ),
        );
      }
      if (!options.dryRun) {
        console.log(chalk.dim(`\nDeleted ${retention.deleted} workflow run${retention.deleted === 1 ? '' : 's'}.\n`));
      } else {
        console.log(chalk.dim('\nDry run only. Add --keep N or --older-than Nd without --dry-run to delete.\n'));
      }
      return;
    }

    if (invocation.kind === 'save') {
      if (!invocation.runId || !invocation.name) {
        console.log(chalk.yellow('\nUsage: /workflow save <runId> <name>\n'));
        return;
      }
      if (!ensureSafeRunId(invocation.runId)) return;
      try {
        const ref = await saveGeneratedWorkflowFromRun({
          runDir: join(baseDir, invocation.runId),
          targetDir: dirs.project ?? join(process.cwd(), '.kodax', 'workflows'),
          name: invocation.name,
        });
        console.log(chalk.green(`\nSaved workflow ${ref.name} to ${ref.path}\n`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] save failed: ${message}\n`));
      }
      return;
    }

    if (invocation.kind === 'rename') {
      if (!invocation.target || !invocation.newName) {
        console.log(chalk.yellow('\nUsage: /workflow rename <runId|alias|savedName> <newName>\n'));
        return;
      }
      const resolution = await lifecycle.resolveWorkflowIdentity(invocation.target);
      if (resolution.kind === 'ambiguous') {
        console.log(
          chalk.red(
            `\n[workflow] ambiguous rename target: ${invocation.target} matches both a workflow run id and a saved workflow name.\n`,
          ),
        );
        return;
      }
      if (resolution.kind === 'missing') {
        console.log(chalk.red(`\n[workflow] rename target not found: ${invocation.target}\n`));
        return;
      }
      if (resolution.kind === 'run') {
        if (!await lifecycle.renameWorkflowRun(resolution.runId, invocation.newName)) {
          console.log(chalk.red(`\n[workflow] rename failed: ${resolution.runId}\n`));
          return;
        }
        console.log(chalk.green(`\nRenamed workflow run ${resolution.runId} to ${invocation.newName.trim()}.\n`));
        return;
      }
      try {
        const renamed = await renameSavedWorkflow({
          dirs,
          name: resolution.savedWorkflow.name,
          newName: invocation.newName,
          source: resolution.savedWorkflow.source,
        });
        console.log(chalk.green(`\nRenamed saved workflow ${invocation.target} to ${renamed.name}.\n`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] rename failed: ${message}\n`));
      }
      return;
    }

    if (invocation.kind === 'revise') {
      if (!invocation.target || !invocation.request) {
        console.log(chalk.yellow('\nUsage: /workflow revise [--replace] <runId|alias|savedName> <change request>\n'));
        return;
      }
      const confirm = resolveConfirm(callbacks);
      if (!confirm) {
        console.log(
          chalk.red('\n[workflow] refusing to revise a workflow without an interactive approval channel.\n'),
        );
        return;
      }
      const createOptions = callbacks.createKodaXOptions;
      if (!createOptions) {
        console.log(chalk.red('\n[workflow] cannot revise - REPL options unavailable in this context.\n'));
        return;
      }
      const resolution = await lifecycle.resolveWorkflowIdentity(invocation.target);
      if (resolution.kind === 'ambiguous') {
        console.log(
          chalk.red(
            `\n[workflow] ambiguous revise target: ${invocation.target} matches both a workflow run id and a saved workflow name.\n`,
          ),
        );
        return;
      }
      if (resolution.kind === 'missing') {
        console.log(chalk.red(`\n[workflow] revise target not found: ${invocation.target}\n`));
        return;
      }
      if (invocation.replace === true && resolution.kind !== 'saved') {
        console.log(chalk.red('\n[workflow] revise --replace requires a saved workflow name target.\n'));
        return;
      }
      let capsule: WorkflowCapsule;
      try {
        if (resolution.kind === 'run') {
          capsule = (await loadGeneratedWorkflowFromRun({ runDir: resolution.runDir })).capsule;
        } else {
          if (resolution.savedWorkflow.execution !== 'capability-generated') {
            console.log(chalk.red('\n[workflow] only generated workflow capsules can be revised.\n'));
            return;
          }
          capsule = await loadSavedWorkflowCapsule(resolution.savedWorkflow.path);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] revise failed: ${message}\n`));
        return;
      }

      const revisionRequest = buildWorkflowRevisionRequest({
        target: invocation.target,
        capsule,
        changeRequest: invocation.request,
      });
      let generated: Awaited<ReturnType<typeof generateWorkflowFromOptions>>;
      try {
        generated = await generateWorkflowFromOptions({
          request: revisionRequest,
          options: createOptions(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] revise generation failed: ${message}\n`));
        return;
      }
      if (generated.kind === 'declined') {
        console.log(chalk.dim(`\nWorkflow revision not created: ${generated.reason}\n`));
        return;
      }
      const replaceSavedResolution = invocation.replace === true && resolution.kind === 'saved'
        ? resolution
        : undefined;
      const replaceWorkflowName = replaceSavedResolution?.savedWorkflow.name;
      const savedName = replaceWorkflowName
        ?? await nextRevisionWorkflowName(dirs, generated.manifest.name);
      const manifest = savedName === generated.manifest.name
        ? generated.manifest
        : { ...generated.manifest, name: savedName };
      const approved = await confirm(
        renderApprovalPrompt(buildApprovalSummary({ meta: manifest, run: generated.module.run }), {
          source: replaceWorkflowName
            ? `revision-replace:${replaceWorkflowName}`
            : `revision:${invocation.target}`,
          sandbox: 'capability-generated',
          mayUseWorktree: manifest.mayUseWorktree === true,
          rawScript: generated.source,
        }),
      );
      if (!approved) {
        console.log(chalk.dim('Workflow revision cancelled.\n'));
        return;
      }
      const revisionInput = {
        name: savedName,
        manifest,
        source: generated.source,
        intent: buildWorkflowCapsuleIntent(manifest, { originalRequest: invocation.request }),
        ...(capsule.inputs !== undefined ? { inputs: capsule.inputs } : {}),
        ...(capsule.requires !== undefined ? { requires: capsule.requires } : {}),
        provenance: buildWorkflowRevisionProvenance({
          capsule,
          resolution,
          ...(replaceWorkflowName !== undefined ? { replacesWorkflowName: replaceWorkflowName } : {}),
        }),
      };
      if (replaceSavedResolution) {
        const ref = await replaceSavedWorkflow({
          ...revisionInput,
          dirs,
          savedSource: replaceSavedResolution.savedWorkflow.source,
        });
        console.log(
          chalk.green(
            `\nReplaced saved workflow ${ref.name} with revised capsule at ${ref.path}\n`,
          ),
        );
        console.log(chalk.dim(`Previous capsule archived at ${ref.previousPath}\n`));
        return;
      }

      const ref = await saveGeneratedWorkflow({
        ...revisionInput,
        dir: dirs.project ?? join(process.cwd(), '.kodax', 'workflows'),
      });
      console.log(chalk.green(`\nSaved workflow revision ${ref.name} to ${ref.path}\n`));
      return;
    }

    if (invocation.kind === 'rerun') {
      if (!invocation.runId) {
        console.log(chalk.yellow('\nUsage: /workflow rerun <runId|savedName> [args]\n'));
        return;
      }
      if (!ensureSafeRunId(invocation.runId)) return;
      const confirm = resolveConfirm(callbacks);
      if (!confirm) {
        console.log(
          chalk.red('\n[workflow] refusing to rerun a workflow without an interactive approval channel.\n'),
        );
        return;
      }
      const createOptions = callbacks.createKodaXOptions;
      if (!createOptions) {
        console.log(chalk.red('\n[workflow] cannot start — REPL options unavailable in this context.\n'));
        return;
      }
      const savedRef = (await discoverSavedWorkflows(dirs)).find((r) => r.name === invocation.runId);
      const targetMatchesRun = manager.list().some((run) => run.runId === invocation.runId) ||
        existsSync(join(baseDir, invocation.runId, 'run.json'));
      if (savedRef && targetMatchesRun) {
        console.log(
          chalk.red(
            `\n[workflow] ambiguous rerun target: ${invocation.runId} matches both a workflow run id and a saved workflow name.\n`,
          ),
        );
        console.log(
          chalk.yellow(
            `Use /workflow ${invocation.runId} to run the saved workflow, or rerun a unique run id/name.\n`,
          ),
        );
        return;
      }
      if (savedRef && !targetMatchesRun) {
        const prepared = await prepareSavedWorkflow(savedRef, confirm);
        if (!prepared) return;
        const locale = inferWorkflowLocaleFromParts(
          invocation.rawArgs,
          prepared.module.meta.name,
          prepared.module.meta.description,
          prepared.scriptSnapshot?.source,
        );
        const presentation: WorkflowRunPresentation = 'agentic';
        const approved = await confirm(
          renderApprovalPrompt(buildApprovalSummary(prepared.module), prepared.approvalContext),
        );
        if (!approved) {
          console.log(chalk.dim('Workflow cancelled.\n'));
          return;
        }
        const newRunId = `run-${Date.now().toString(36)}`;
        const newRunDir = join(baseDir, newRunId);
        console.log(chalk.dim(`\nStarted workflow ${prepared.module.meta.name} (${newRunId}). Use /workflow show ${newRunId} for status.\n`));
        const live = createWorkflowLiveUpdateEmitter(callbacks, newRunId, prepared.module.meta, locale);
        live.running(`Use /workflow show ${newRunId} for status or /workflow stop ${newRunId} to stop.`);
        const unsubscribeProcess = subscribeWorkflowLiveProcess(manager, live, newRunId);
        const managed = manager.startFromOptions({
          module: prepared.module,
          args: parseWorkflowArgs(invocation.rawArgs),
          options: createOptions(),
          runId: newRunId,
          runDir: newRunDir,
          ...(prepared.scriptSnapshot ? { scriptSnapshot: prepared.scriptSnapshot } : {}),
          processMetadata: buildSavedWorkflowProcessMetadata({
            displayName: prepared.module.meta.name,
            savedWorkflowName: savedRef.name,
            provenance: prepared.provenance,
          }),
          onEvent: workflowEventSink(callbacks, undefined, { presentation, locale, runId: newRunId }),
        });
        unsubscribeWorkflowLiveProcessOnDone(managed, unsubscribeProcess);
        observeManagedWorkflowDone(managed, callbacks, newRunId, live, {
          canRerun: prepared.scriptSnapshot !== undefined,
          presentation,
          locale,
        });
        return;
      }
      let loaded: Awaited<ReturnType<typeof loadGeneratedWorkflowFromRun>>;
      try {
        loaded = await loadGeneratedWorkflowFromRun({
          runDir: join(baseDir, invocation.runId),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] rerun failed: ${message}\n`));
        return;
      }
      const runDetail = readWorkflowRunDetail(baseDir, invocation.runId);
      const rawScriptPath = runDetail?.scriptSnapshotPath ?? join(baseDir, invocation.runId, 'script.js');
      const locale = inferWorkflowLocaleFromParts(
        invocation.rawArgs,
        loaded.capsule.manifest.name,
        loaded.capsule.manifest.description,
        loaded.capsule.source,
      );
      const presentation: WorkflowRunPresentation = 'agentic';
      const preflight = preflightWorkflowCapsule(loaded.capsule, currentWorkflowPreflightEnv());
      if (!preflight.ok) {
        printPreflightFailure(preflight);
        return;
      }
      printPreflightWarnings(preflight);
      const approved = await confirm(
        renderApprovalPrompt(buildApprovalSummary(loaded.module), {
          source: `run:${invocation.runId}`,
          sandbox: 'capability-generated',
          mayUseWorktree: loaded.capsule.manifest.mayUseWorktree === true,
          rawScriptPath,
          rawScript: loaded.capsule.source,
        }),
      );
      if (!approved) {
        console.log(chalk.dim('Workflow cancelled.\n'));
        return;
      }
      const newRunId = `run-${Date.now().toString(36)}`;
      const newRunDir = join(baseDir, newRunId);
      console.log(chalk.dim(`\nStarted workflow ${loaded.module.meta.name} (${newRunId}). Use /workflow show ${newRunId} for status.\n`));
      const live = createWorkflowLiveUpdateEmitter(callbacks, newRunId, loaded.module.meta, locale);
      live.running(`Use /workflow show ${newRunId} for status or /workflow stop ${newRunId} to stop.`);
      const unsubscribeProcess = subscribeWorkflowLiveProcess(manager, live, newRunId);
      const managed = manager.startFromOptions({
        module: loaded.module,
        args: parseWorkflowArgs(invocation.rawArgs),
        options: createOptions(),
        runId: newRunId,
        runDir: newRunDir,
        scriptSnapshot: {
          manifest: loaded.capsule.manifest,
          source: loaded.capsule.source,
        },
        processMetadata: buildWorkflowProcessMetadata({
          source: 'command',
          displayName: loaded.module.meta.name,
          sourceRunId: invocation.runId,
        }),
        onEvent: workflowEventSink(callbacks, undefined, { presentation, locale, runId: newRunId }),
      });
      unsubscribeWorkflowLiveProcessOnDone(managed, unsubscribeProcess);
      observeManagedWorkflowDone(managed, callbacks, newRunId, live, {
        canRerun: true,
        presentation,
        locale,
      });
      return;
    }

    if (invocation.kind === 'create') {
      if (!invocation.request) {
        console.log(chalk.yellow('\nUsage: /workflow create <request>\n'));
        return;
      }
      return await createWorkflowFromText(invocation.request);
    }

    const confirm = resolveConfirm(callbacks);
    if (!confirm) {
      console.log(
        chalk.red('\n[workflow] refusing to start a workflow without an interactive approval channel.\n'),
      );
      return;
    }
    let approvalContext: WorkflowApprovalRenderContext = {
      source: 'built-in',
      sandbox: 'trusted package',
      mayUseWorktree: false,
    };
    let scriptSnapshot: { readonly manifest: WorkflowScriptManifest; readonly source: string } | undefined;
    let module: WorkflowModule | undefined = getBuiltinWorkflow(invocation.name);
    let savedWorkflowRef: SavedWorkflowRef | undefined;
    let savedWorkflowProvenance: WorkflowCapsule['provenance'];
    if (!module) {
      // Not a built-in — try a saved workflow. Loading EXECUTES local
      // code, so it is hard-gated behind a trusted-local confirmation:
      // with no interactive channel we refuse rather than run unconfirmed.
      const ref = (await discoverSavedWorkflows(dirs)).find((r) => r.name === invocation.name);
      if (!ref) {
        // FEATURE_246 (ADR-047): `/workflow <text>` where <text> is not a known
        // saved/built-in workflow is treated as a create request — the user
        // described a task, not a workflow name. `/workflow` alone still lists.
        const request = [invocation.name, invocation.rawArgs].filter((s) => s && s.length > 0).join(' ').trim();
        return await createWorkflowFromText(request);
      }
      savedWorkflowRef = ref;
      if (ref.execution === 'trusted-local') {
        const trusted = await confirm(
          `Run local workflow file? This EXECUTES local code:\n  ${ref.path}`,
        );
        if (!trusted) {
          console.log(chalk.dim('Workflow cancelled.\n'));
          return;
        }
      }
      try {
        if (ref.execution === 'capability-generated') {
          const capsule = await loadSavedWorkflowCapsule(ref.path);
          const preflight = preflightWorkflowCapsule(capsule, currentWorkflowPreflightEnv());
          if (!preflight.ok) {
            printPreflightFailure(preflight);
            return;
          }
          printPreflightWarnings(preflight);
          approvalContext = {
            source: `saved:${ref.source}`,
            sandbox: ref.execution,
            mayUseWorktree: capsule.manifest.mayUseWorktree === true,
            rawScriptPath: ref.path,
            rawScript: capsule.source,
          };
          scriptSnapshot = {
            manifest: capsule.manifest,
            source: capsule.source,
          };
          savedWorkflowProvenance = capsule.provenance;
        }
        module = await loadSavedWorkflow(ref.path);
        if (ref.execution === 'trusted-local') {
          approvalContext = {
            source: `saved:${ref.source}`,
            sandbox: ref.execution,
            mayUseWorktree: false,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] failed to load ${ref.path}: ${message}\n`));
        return;
      }
    }

    const createOptions = callbacks.createKodaXOptions;
    if (!createOptions) {
      console.log(chalk.red('\n[workflow] cannot start — REPL options unavailable in this context.\n'));
      return;
    }

    const approved = await confirm(renderApprovalPrompt(buildApprovalSummary(module), approvalContext));
    if (!approved) {
      console.log(chalk.dim('Workflow cancelled.\n'));
      return;
    }

    const runId = `run-${Date.now().toString(36)}`;
    const runDir = join(baseDir, runId);
    console.log(chalk.dim(`\nStarted workflow ${module.meta.name} (${runId}). Use /workflow show ${runId} for status.\n`));
    const locale = inferWorkflowLocaleFromParts(
      invocation.rawArgs,
      module.meta.name,
      module.meta.description,
      scriptSnapshot?.source,
    );
    const live = createWorkflowLiveUpdateEmitter(callbacks, runId, module.meta, locale);
    live.running(`Use /workflow show ${runId} for status or /workflow stop ${runId} to stop.`);
    const presentation: WorkflowRunPresentation = 'agentic';
    const unsubscribeProcess = subscribeWorkflowLiveProcess(manager, live, runId);

    const managed = manager.startFromOptions({
      module,
      args: parseWorkflowArgs(invocation.rawArgs),
      options: createOptions(),
      runId,
      runDir,
      ...(scriptSnapshot ? { scriptSnapshot } : {}),
      processMetadata: savedWorkflowRef
        ? buildSavedWorkflowProcessMetadata({
            displayName: module.meta.name,
            savedWorkflowName: savedWorkflowRef.name,
            provenance: savedWorkflowProvenance,
          })
        : buildWorkflowProcessMetadata({
            source: 'command',
            displayName: module.meta.name,
          }),
      onEvent: workflowEventSink(callbacks, undefined, { presentation, locale, runId }),
    });
    unsubscribeWorkflowLiveProcessOnDone(managed, unsubscribeProcess);

    observeManagedWorkflowDone(managed, callbacks, runId, live, {
      canRerun: scriptSnapshot !== undefined,
      presentation,
      locale,
    });
  },
};
