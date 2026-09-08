import chalk from 'chalk';
import type {
  WorkflowModule,
  WorkflowProcessSource,
} from '@kodax-ai/agent';
import {
  buildApprovalSummary,
  generateWorkflowFromOptions,
  getBuiltinWorkflow,
  type WorkflowScriptSnapshotInput,
  type WorkflowRunProcessMetadata,
} from '@kodax-ai/coding';

import type { CommandCallbacks } from './types.js';
import {
  detectWorkflowLocale,
  formatWorkflowLaunchAnswer,
  renderApprovalPrompt,
  resolveConfirm,
} from './workflow-command-helpers.js';
import {
  createWorkflowLiveUpdateEmitter,
  emitWorkflowRunMessage,
  observeHostWorkflowDone,
  type GeneratedWorkflowStartOutcome,
  type StartGeneratedWorkflowFromRequestOptions,
  type WorkflowBuilderEvent,
} from './workflow-command-live.js';

function emitWorkflowBuilderEvent(
  input: StartGeneratedWorkflowFromRequestOptions,
  event: WorkflowBuilderEvent,
): void {
  input.onBuilderEvent?.(event);
  if (event.stage === 'failed') {
    emitWorkflowRunMessage(input.callbacks, {
      type: 'error',
      text: `Workflow builder failed: ${event.message}`,
    });
    return;
  }
  if (!input.onBuilderEvent && (
    event.stage === 'started'
    || event.stage === 'generating'
    || event.stage === 'validating'
    || event.stage === 'ready'
  )) {
    console.log(chalk.dim(`\n[workflow] ${event.message}\n`));
  }
}

export function buildWorkflowProcessMetadata(input: {
  readonly source: WorkflowProcessSource;
  readonly displayName: string;
  readonly goal?: string;
  readonly savedWorkflowName?: string;
  readonly sourceRunId?: string;
  readonly sourceWorkflowName?: string;
  readonly revisionOf?: string;
  readonly hostMetadata?: Record<string, string>;
}): WorkflowRunProcessMetadata {
  return {
    source: input.source,
    displayName: input.displayName,
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
    ...(input.savedWorkflowName !== undefined ? { savedWorkflowName: input.savedWorkflowName } : {}),
    ...(input.sourceRunId !== undefined ? { sourceRunId: input.sourceRunId } : {}),
    ...(input.sourceWorkflowName !== undefined ? { sourceWorkflowName: input.sourceWorkflowName } : {}),
    ...(input.revisionOf !== undefined ? { revisionOf: input.revisionOf } : {}),
    ...(input.hostMetadata !== undefined ? { hostMetadata: { ...input.hostMetadata } } : {}),
  };
}

interface PreparedWorkflowLaunch {
  readonly module: WorkflowModule;
  readonly args: unknown;
  readonly approvalDescription: string;
  readonly mayUseWorktree: boolean;
  readonly sandbox: string;
  readonly scriptSnapshot?: WorkflowScriptSnapshotInput;
  readonly rawScript?: string;
}

export async function startGeneratedWorkflowFromRequest(
  input: StartGeneratedWorkflowFromRequestOptions,
): Promise<GeneratedWorkflowStartOutcome> {
  const confirm = input.approval === 'required' ? resolveConfirm(input.callbacks) : undefined;
  if (input.approval === 'required' && !confirm) {
    console.log(
      chalk.red('\n[workflow] refusing to start a workflow without an interactive approval channel.\n'),
    );
    return 'failed';
  }

  const createOptions = input.callbacks.createKodaXOptions;
  if (!createOptions) {
    console.log(chalk.red('\n[workflow] cannot start - REPL options unavailable in this context.\n'));
    return 'failed';
  }

  const locale = detectWorkflowLocale(input.request);
  let options: ReturnType<NonNullable<CommandCallbacks['createKodaXOptions']>>;
  let prepared: PreparedWorkflowLaunch;
  try {
    emitWorkflowBuilderEvent(input, {
      stage: 'started',
      message: 'Workflow builder started',
    });
    options = createOptions();
    if (input.builtin) {
      const module = getBuiltinWorkflow(input.builtin.name);
      if (!module) {
        throw new Error(`unknown built-in workflow: ${input.builtin.name}`);
      }
      prepared = {
        module,
        args: input.builtin.args,
        approvalDescription: module.meta.description,
        mayUseWorktree: false,
        sandbox: 'built-in',
      };
    } else {
      emitWorkflowBuilderEvent(input, {
        stage: 'generating',
        message: 'Workflow - generating harness',
      });
      const generateWorkflow = input.generateWorkflow ?? generateWorkflowFromOptions;
      const generated = await generateWorkflow({
        request: input.request,
        options,
      });
      if (generated.kind === 'declined') {
        emitWorkflowBuilderEvent(input, {
          stage: 'declined',
          message: generated.reason,
        });
        console.log(chalk.dim(`\nWorkflow not created: ${generated.reason}\n`));
        return 'declined';
      }
      prepared = {
        module: generated.module,
        args: { request: input.request },
        approvalDescription: generated.approvalSummary,
        mayUseWorktree: generated.manifest.mayUseWorktree === true,
        sandbox: 'capability-generated',
        scriptSnapshot: generated.scriptSnapshot,
        rawScript: generated.scriptSnapshot.source,
      };
    }
    emitWorkflowBuilderEvent(input, {
      stage: 'validating',
      message: 'Workflow - validating harness',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitWorkflowBuilderEvent(input, {
      stage: 'failed',
      message,
    });
    return 'failed';
  }

  emitWorkflowBuilderEvent(input, {
    stage: 'ready',
    message: 'Workflow - harness ready',
  });
  const presentation = input.presentation ?? 'command';
  const approvalSummary = buildApprovalSummary(prepared.module);
  if (presentation !== 'agentic') {
    emitWorkflowRunMessage(input.callbacks, {
      type: 'info',
      text: `${input.builtin ? 'Built-in' : 'Generated'} workflow: ${prepared.approvalDescription}`,
    });
  }
  if (confirm) {
    const approved = await confirm(
      renderApprovalPrompt(approvalSummary, {
        source: input.sourceLabel ?? 'generated',
        sandbox: prepared.sandbox,
        mayUseWorktree: prepared.mayUseWorktree,
        ...(prepared.rawScript !== undefined ? { rawScript: prepared.rawScript } : {}),
      }),
    );
    if (!approved) {
      emitWorkflowBuilderEvent(input, {
        stage: 'cancelled',
        message: 'Workflow cancelled',
      });
      emitWorkflowRunMessage(input.callbacks, { type: 'info', text: 'Workflow cancelled.' });
      return 'cancelled';
    }
  } else {
    if (presentation !== 'agentic') {
      emitWorkflowRunMessage(input.callbacks, {
        type: 'info',
        text: renderApprovalPrompt(approvalSummary, {
          source: input.sourceLabel ?? 'generated',
          sandbox: prepared.sandbox,
          mayUseWorktree: prepared.mayUseWorktree,
        }),
      });
      emitWorkflowRunMessage(input.callbacks, {
        type: 'info',
        text: `Auto-started ${input.builtin ? 'built-in' : 'generated'} workflow (${prepared.sandbox}); normal permission gates still apply.`,
      });
    }
  }

  // FEATURE_298 T22 — the approved launch is declarative: the generated
  // capsule travels inline (built-ins travel by name); the Host validates,
  // mints the runId, and owns the run. There is no local run.
  const hostControl = input.callbacks.workflows;
  if (hostControl === undefined) {
    emitWorkflowBuilderEvent(input, {
      stage: 'failed',
      message: 'Workflow Host runtime is unavailable in this session',
    });
    emitWorkflowRunMessage(input.callbacks, {
      type: 'error',
      text: 'The workflow Host runtime is unavailable in this session; cannot start.',
    });
    return 'failed';
  }
  const capsule = prepared.scriptSnapshot;
  if (input.builtin === undefined && capsule === undefined) {
    // Unreachable today: the generated branch always attaches a capsule.
    emitWorkflowBuilderEvent(input, {
      stage: 'failed',
      message: 'Generated workflow is missing its script capsule',
    });
    return 'failed';
  }
  const started = await hostControl.start({
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    projectRoot: options.context?.gitRoot ?? process.cwd(),
    source: input.builtin !== undefined
      ? { kind: 'name', name: input.builtin.name }
      : {
        kind: 'inline',
        manifest: capsule?.manifest,
        source: capsule?.source ?? '',
      },
    args: prepared.args,
    // NOTE: workflowAuthorship is deliberately NOT sent — startManagedWorkflow
    // strips client-declared authorship for inline sources (anti-forgery);
    // the Host mints it only for request-kind starts it generates itself.
    metadata: buildWorkflowProcessMetadata({
      source: input.processSource ?? 'command',
      displayName: prepared.module.meta.name,
      goal: input.request,
    }),
  });
  if (started.kind === 'declined') {
    emitWorkflowBuilderEvent(input, {
      stage: 'declined',
      message: started.reason,
    });
    emitWorkflowRunMessage(input.callbacks, {
      type: 'error',
      text: `Host declined to start: ${started.reason}`,
    });
    return 'declined';
  }
  const runId = started.runId;
  if (presentation === 'agentic') {
    emitWorkflowRunMessage(input.callbacks, {
      type: 'assistant',
      text: formatWorkflowLaunchAnswer({
        runId,
        summary: approvalSummary,
        approvalSummary: prepared.approvalDescription,
        locale,
      }),
      final: false,
    });
  } else {
    emitWorkflowRunMessage(input.callbacks, {
      type: 'info',
      text: `Started workflow ${prepared.module.meta.name} (${runId}). Use /workflow show ${runId} for status.`,
    });
  }
  const live = createWorkflowLiveUpdateEmitter(input.callbacks, runId, prepared.module.meta, locale);
  live.running(`Use /workflow show ${runId} for status or /workflow stop ${runId} to stop.`);
  observeHostWorkflowDone(hostControl, input.callbacks, runId, live, {
    canRerun: true,
    presentation,
    locale,
  });
  emitWorkflowBuilderEvent(input, {
    stage: 'launched',
    message: `Workflow ${prepared.module.meta.name} started`,
  });
  return 'started';
}

