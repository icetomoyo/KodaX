import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runKodaX } from './agent.js';
import type {
  KodaXEvents,
  KodaXOptions,
  KodaXReasoningMode,
  KodaXResult,
} from './types.js';

export type OrchestrationTaskExecution = 'serial' | 'parallel';
export type OrchestrationTaskStatus = 'completed' | 'failed' | 'blocked';

export interface OrchestrationTaskBudget {
  maxIter?: number;
  reasoningMode?: KodaXReasoningMode;
  thinking?: boolean;
}

export interface OrchestrationArtifact {
  kind: 'json' | 'text' | 'markdown';
  path: string;
  description?: string;
}

export interface OrchestrationWorkerSpec<TInput = unknown> {
  id: string;
  title: string;
  input?: TInput;
  dependsOn?: string[];
  execution?: OrchestrationTaskExecution;
  timeoutMs?: number;
  budget?: OrchestrationTaskBudget;
  agent?: string;
  metadata?: Record<string, unknown>;
  beforeToolExecute?: KodaXEvents['beforeToolExecute'];
}

export interface OrchestrationWorkerResult<TOutput = unknown> {
  success: boolean;
  output?: TOutput;
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  artifacts?: OrchestrationArtifact[];
}

export interface OrchestrationCompletedTask<TTask extends OrchestrationWorkerSpec = OrchestrationWorkerSpec, TOutput = unknown> {
  id: string;
  title: string;
  task: TTask;
  status: OrchestrationTaskStatus;
  taskDir: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  result: OrchestrationWorkerResult<TOutput>;
}

export interface OrchestrationTaskContext<TTask extends OrchestrationWorkerSpec = OrchestrationWorkerSpec, TOutput = unknown> {
  runId: string;
  workspaceDir: string;
  taskDir: string;
  dependencyResults: Record<string, OrchestrationCompletedTask<TTask, TOutput>>;
  emit: (message: string) => Promise<void>;
  signal?: AbortSignal;
}

export type OrchestrationWorkerRunner<TTask extends OrchestrationWorkerSpec = OrchestrationWorkerSpec, TOutput = unknown> =
  (task: TTask, context: OrchestrationTaskContext<TTask, TOutput>) => Promise<OrchestrationWorkerResult<TOutput>>;

/**
 * Trace event emitted by `runOrchestration` while stepping through a task DAG
 * (run/task start/message/complete/failed/blocked). Persisted as JSONL via
 * `appendTrace` to `{workspaceDir}/orchestration-trace.jsonl`.
 *
 * @deprecated FEATURE_083 (v0.7.24) originally superseded this by
 * `AgentSpan` / `HandoffSpan` in `@kodax/tracing`. **FEATURE_086 (v0.7.27)
 * evaluated removal and kept it**: AgentSpan is scoped to a single Runner
 * lifecycle, whereas OrchestrationTraceEvent spans across Tasks scheduled
 * by `runOrchestration` — no cross-task span equivalent exists yet, and
 * `runOrchestration` + this type are part of the `@kodax/coding` public
 * surface. The `@deprecated` tag is kept as a signal that new code
 * targeting in-Runner tracing should prefer `@kodax/tracing` spans;
 * cross-task orchestration code is free to continue using this event.
 */
export interface OrchestrationTraceEvent {
  type:
    | 'run_started'
    | 'task_started'
    | 'task_message'
    | 'task_completed'
    | 'task_failed'
    | 'task_blocked'
    | 'run_completed';
  timestamp: string;
  runId: string;
  taskId?: string;
  message?: string;
  status?: OrchestrationTaskStatus;
  metadata?: Record<string, unknown>;
}

export interface OrchestrationRunEvents<TTask extends OrchestrationWorkerSpec = OrchestrationWorkerSpec, TOutput = unknown> {
  onRunStart?: (info: { runId: string; workspaceDir: string; taskCount: number }) => void | Promise<void>;
  onTaskStart?: (task: TTask) => void | Promise<void>;
  onTaskMessage?: (task: TTask, message: string) => void | Promise<void>;
  onTaskComplete?: (task: TTask, completed: OrchestrationCompletedTask<TTask, TOutput>) => void | Promise<void>;
  onRunComplete?: (result: OrchestrationRunResult<TTask, TOutput>) => void | Promise<void>;
}

export interface OrchestrationRunOptions<TTask extends OrchestrationWorkerSpec = OrchestrationWorkerSpec, TOutput = unknown> {
  tasks: TTask[];
  workspaceDir: string;
  runner: OrchestrationWorkerRunner<TTask, TOutput>;
  runId?: string;
  maxParallel?: number;
  signal?: AbortSignal;
  events?: OrchestrationRunEvents<TTask, TOutput>;
}

export interface OrchestrationRunResult<TTask extends OrchestrationWorkerSpec = OrchestrationWorkerSpec, TOutput = unknown> {
  runId: string;
  workspaceDir: string;
  tasks: Array<OrchestrationCompletedTask<TTask, TOutput>>;
  taskResults: Record<string, OrchestrationCompletedTask<TTask, TOutput>>;
  summary: {
    total: number;
    completed: number;
    failed: number;
    blocked: number;
  };
}

export interface KodaXAgentWorkerSpec extends OrchestrationWorkerSpec<string> {
  prompt: string;
  provider?: string;
  model?: string;
}

export interface CreateKodaXTaskRunnerOptions<TTask extends KodaXAgentWorkerSpec = KodaXAgentWorkerSpec> {
  baseOptions: KodaXOptions;
  runAgent?: (options: KodaXOptions, prompt: string) => Promise<KodaXResult>;
  rateLimit?: <T>(operation: () => Promise<T>) => Promise<T>;
  buildPrompt?: (task: TTask, context: OrchestrationTaskContext<TTask, string>) => string;
  createEvents?: (task: TTask, context: OrchestrationTaskContext<TTask, string>) => KodaXEvents;
  createOptions?: (
    task: TTask,
    context: OrchestrationTaskContext<TTask, string>,
    defaultOptions: KodaXOptions,
  ) => KodaXOptions;
  onResult?: (
    task: TTask,
    context: OrchestrationTaskContext<TTask, string>,
    result: KodaXResult,
  ) => KodaXResult | void | Promise<KodaXResult | void>;
  runTask?: (
    task: TTask,
    context: OrchestrationTaskContext<TTask, string>,
    preparedOptions: KodaXOptions,
    prompt: string,
    executeDefault: () => Promise<KodaXResult>,
  ) => Promise<KodaXResult>;
}

interface InternalTaskRecord<TTask extends OrchestrationWorkerSpec> {
  task: TTask;
  index: number;
  taskDir: string;
}

function toSerializableTask(task: OrchestrationWorkerSpec): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    dependsOn: task.dependsOn ?? [],
    execution: task.execution ?? 'serial',
    timeoutMs: task.timeoutMs ?? null,
    budget: task.budget ?? null,
    agent: task.agent ?? null,
    metadata: task.metadata ?? null,
  };
}

function createTaskDirectoryName(id: string, index: number): string {
  const safeId = id.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || `task-${index + 1}`;
  return `${String(index + 1).padStart(2, '0')}-${safeId}`;
}

function truncateText(value: string, maxLength = 1600): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

const DEPENDENCY_OUTPUT_MAX_LENGTH = 8000;
const DEPENDENCY_PROMPT_EXCERPT_MAX_LENGTH = 1200;

function createErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function summarizeFailedDependencies(
  task: OrchestrationWorkerSpec,
  completed: Map<string, OrchestrationCompletedTask>
): string[] {
  const failures: string[] = [];

  for (const dependencyId of task.dependsOn ?? []) {
    const dependency = completed.get(dependencyId);
    if (!dependency || dependency.status === 'completed') {
      continue;
    }
    failures.push(`${dependencyId} (${dependency.status})`);
  }

  return failures;
}

function validateTasks<TTask extends OrchestrationWorkerSpec>(tasks: TTask[]): void {
  const seenIds = new Set<string>();

  for (const task of tasks) {
    if (!task.id?.trim()) {
      throw new Error('Orchestration tasks must have a non-empty id.');
    }
    if (seenIds.has(task.id)) {
      throw new Error(`Duplicate orchestration task id: ${task.id}`);
    }
    seenIds.add(task.id);
  }

  const taskIds = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependencyId of task.dependsOn ?? []) {
      if (!taskIds.has(dependencyId)) {
        throw new Error(`Task ${task.id} depends on unknown task ${dependencyId}`);
      }
      if (dependencyId === task.id) {
        throw new Error(`Task ${task.id} cannot depend on itself`);
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const taskMap = new Map(tasks.map((task) => [task.id, task]));

  function visit(taskId: string): void {
    if (visited.has(taskId)) {
      return;
    }
    if (visiting.has(taskId)) {
      throw new Error(`Detected orchestration dependency cycle involving ${taskId}`);
    }

    visiting.add(taskId);
    const task = taskMap.get(taskId);
    for (const dependencyId of task?.dependsOn ?? []) {
      visit(dependencyId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const task of tasks) {
    visit(task.id);
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function appendTrace(filePath: string, event: OrchestrationTraceEvent): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
}

function createDependencyHandoffBundle<TTask extends OrchestrationWorkerSpec, TOutput>(
  taskDir: string,
  dependencyResults: Record<string, OrchestrationCompletedTask<TTask, TOutput>>,
): {
  taskDir: string;
  generatedAt: string;
  dependencies: Array<{
    id: string;
    title: string;
    status: OrchestrationTaskStatus;
    taskDir: string;
    summary: string;
    resultArtifact: string;
    summaryArtifact?: string;
    artifacts: OrchestrationArtifact[];
    outputExcerpt?: string;
  }>;
} {
  return {
    taskDir,
    generatedAt: new Date().toISOString(),
    dependencies: Object.values(dependencyResults).map((dependency) => {
      const output = typeof dependency.result.output === 'string'
        ? dependency.result.output
        : undefined;
      const summary = dependency.result.summary
        ?? dependency.result.error
        ?? 'No summary available.';
      return {
        id: dependency.id,
        title: dependency.title,
        status: dependency.status,
        taskDir: dependency.taskDir,
        summary,
        resultArtifact: path.join(dependency.taskDir, 'result.json'),
        summaryArtifact: dependency.result.summary
          ? path.join(dependency.taskDir, 'summary.md')
          : undefined,
        artifacts: dependency.result.artifacts ?? [],
        outputExcerpt: output
          ? truncateText(output, DEPENDENCY_OUTPUT_MAX_LENGTH)
          : undefined,
      };
    }),
  };
}

function renderDependencyHandoffMarkdown(
  bundle: ReturnType<typeof createDependencyHandoffBundle>,
): string {
  if (bundle.dependencies.length === 0) {
    return '# Dependency Handoff\n\nNo upstream dependencies.\n';
  }

  return [
    '# Dependency Handoff',
    '',
    ...bundle.dependencies.flatMap((dependency) => [
      `## ${dependency.id} (${dependency.title})`,
      `- Status: ${dependency.status}`,
      `- Result artifact: ${dependency.resultArtifact}`,
      dependency.summaryArtifact
        ? `- Summary artifact: ${dependency.summaryArtifact}`
        : undefined,
      dependency.artifacts.length > 0
        ? ['- Additional artifacts:', ...dependency.artifacts.map((artifact) => `  - ${artifact.kind}: ${artifact.path}${artifact.description ? ` (${artifact.description})` : ''}`)].join('\n')
        : undefined,
      `- Summary: ${dependency.summary}`,
      dependency.outputExcerpt
        ? ['- Output excerpt:', '```text', dependency.outputExcerpt, '```'].join('\n')
        : undefined,
      '',
    ].filter((line): line is string => Boolean(line))),
  ].join('\n');
}

async function writeDependencyHandoffArtifacts<TTask extends OrchestrationWorkerSpec, TOutput>(
  taskDir: string,
  dependencyResults: Record<string, OrchestrationCompletedTask<TTask, TOutput>>,
): Promise<void> {
  const bundle = createDependencyHandoffBundle(taskDir, dependencyResults);
  await writeJsonFile(path.join(taskDir, 'handoff.json'), bundle);
  await writeFile(
    path.join(taskDir, 'handoff.md'),
    `${renderDependencyHandoffMarkdown(bundle).trimEnd()}\n`,
    'utf8',
  );
}

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(activeSignals);
  }

  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abortWithReason = (signal: AbortSignal): void => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(signal.reason ?? new Error('Operation aborted.'));
    for (const entry of listeners) {
      entry.signal.removeEventListener('abort', entry.listener);
    }
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abortWithReason(signal);
      break;
    }
    const listener = () => abortWithReason(signal);
    listeners.push({ signal, listener });
    signal.addEventListener('abort', listener, { once: true });
  }

  return controller.signal;
}

function formatAbortMessage(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message.trim()) {
    return `Orchestration cancelled: ${reason.message}`;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return `Orchestration cancelled: ${reason}`;
  }
  return 'Orchestration cancelled by user.';
}

function shouldSuppressLifecycleEvents(signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted);
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number | undefined,
  controller: AbortController
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return operation();
  }

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Task timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function buildBlockedTaskResult<TTask extends OrchestrationWorkerSpec, TOutput>(
  record: InternalTaskRecord<TTask>,
  dependencyFailures: string[],
  startedAt: string,
  completedAt: string
): OrchestrationCompletedTask<TTask, TOutput> {
  const error = `Blocked by failed dependencies: ${dependencyFailures.join(', ')}`;
  return {
    id: record.task.id,
    title: record.task.title,
    task: record.task,
    status: 'blocked',
    taskDir: record.taskDir,
    startedAt,
    completedAt,
    durationMs: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
    result: {
      success: false,
      error,
      summary: error,
      metadata: {
        blockedBy: dependencyFailures,
      },
    },
  };
}

function buildCancelledTaskResult<TTask extends OrchestrationWorkerSpec, TOutput>(
  record: InternalTaskRecord<TTask>,
  startedAt: string,
  completedAt: string,
  message: string,
): OrchestrationCompletedTask<TTask, TOutput> {
  return {
    id: record.task.id,
    title: record.task.title,
    task: record.task,
    status: 'blocked',
    taskDir: record.taskDir,
    startedAt,
    completedAt,
    durationMs: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
    result: {
      success: false,
      error: message,
      summary: message,
      metadata: {
        signal: 'BLOCKED',
        signalReason: message,
        cancelled: true,
      },
    },
  };
}

function normalizeWorkerResult<TOutput>(
  task: OrchestrationWorkerSpec,
  result: OrchestrationWorkerResult<TOutput>
): OrchestrationWorkerResult<TOutput> {
  if (result.success) {
    return {
      ...result,
      summary: result.summary ?? (typeof result.output === 'string' ? truncateText(result.output) : undefined),
    };
  }

  return {
    ...result,
    error: result.error ?? `${task.title} failed without an explicit error.`,
    summary: result.summary ?? result.error ?? `${task.title} failed.`,
  };
}

async function prepareWorkspace<TTask extends OrchestrationWorkerSpec>(
  workspaceDir: string,
  runId: string,
  maxParallel: number,
  records: InternalTaskRecord<TTask>[]
): Promise<string> {
  await mkdir(workspaceDir, { recursive: true });
  const tracePath = path.join(workspaceDir, 'trace.ndjson');

  await writeJsonFile(path.join(workspaceDir, 'run.json'), {
    runId,
    createdAt: new Date().toISOString(),
    maxParallel,
    tasks: records.map((record) => ({
      ...toSerializableTask(record.task),
      taskDir: path.relative(workspaceDir, record.taskDir).replace(/\\/g, '/'),
    })),
  });

  await writeFile(tracePath, '', 'utf8');

  for (const record of records) {
    await mkdir(record.taskDir, { recursive: true });
    await writeJsonFile(path.join(record.taskDir, 'spec.json'), {
      ...toSerializableTask(record.task),
      input: record.task.input ?? null,
    });
    await writeFile(
      path.join(record.taskDir, 'log.md'),
      `# ${record.task.title}\n\n- Task ID: ${record.task.id}\n- Execution: ${record.task.execution ?? 'serial'}\n`,
      'utf8'
    );
  }

  return tracePath;
}

async function executeTaskRecord<TTask extends OrchestrationWorkerSpec, TOutput>(
  record: InternalTaskRecord<TTask>,
  options: OrchestrationRunOptions<TTask, TOutput>,
  runId: string,
  tracePath: string,
  completed: Map<string, OrchestrationCompletedTask<TTask, TOutput>>
): Promise<OrchestrationCompletedTask<TTask, TOutput>> {
  if (options.signal?.aborted) {
    const startedAt = new Date().toISOString();
    const blocked = buildCancelledTaskResult<TTask, TOutput>(
      record,
      startedAt,
      new Date().toISOString(),
      formatAbortMessage(options.signal),
    );
    await writeDependencyHandoffArtifacts(record.taskDir, {});
    await writeJsonFile(path.join(record.taskDir, 'result.json'), blocked);
    await writeFile(path.join(record.taskDir, 'summary.md'), `${blocked.result.summary}\n`, 'utf8');
    await appendTrace(tracePath, {
      type: 'task_blocked',
      timestamp: blocked.completedAt,
      runId,
      taskId: record.task.id,
      status: 'blocked',
      message: blocked.result.summary,
    });
    return blocked;
  }

  const startedAt = new Date().toISOString();
  const dependencyResults = Object.fromEntries(
    (record.task.dependsOn ?? [])
      .map((dependencyId) => {
        const dependency = completed.get(dependencyId);
        return dependency ? [dependencyId, dependency] : undefined;
      })
      .filter((entry): entry is [string, OrchestrationCompletedTask<TTask, TOutput>] => Boolean(entry))
  );

  await writeDependencyHandoffArtifacts(record.taskDir, dependencyResults);
  await appendTrace(tracePath, {
    type: 'task_started',
    timestamp: startedAt,
    runId,
    taskId: record.task.id,
    metadata: {
      dependsOn: record.task.dependsOn ?? [],
      execution: record.task.execution ?? 'serial',
    },
  });
  if (!shouldSuppressLifecycleEvents(options.signal)) {
    await options.events?.onTaskStart?.(record.task);
  }

  const emit = async (message: string): Promise<void> => {
    const timestamp = new Date().toISOString();
    await appendFile(path.join(record.taskDir, 'log.md'), `- [${timestamp}] ${message}\n`, 'utf8');
    await appendTrace(tracePath, {
      type: 'task_message',
      timestamp,
      runId,
      taskId: record.task.id,
      message,
    });
    if (!shouldSuppressLifecycleEvents(options.signal)) {
      await options.events?.onTaskMessage?.(record.task, message);
    }
  };

  const controller = new AbortController();
  const executionSignal = mergeAbortSignals(options.signal, controller.signal);
  let normalizedResult: OrchestrationWorkerResult<TOutput>;
  let status: OrchestrationTaskStatus;

  try {
    normalizedResult = normalizeWorkerResult(
      record.task,
      await withTimeout(
        () => options.runner(record.task, {
          runId,
          workspaceDir: options.workspaceDir,
          taskDir: record.taskDir,
          dependencyResults,
          emit,
          signal: executionSignal,
        }),
        record.task.timeoutMs,
        controller
      )
    );
    status = normalizedResult.success ? 'completed' : 'failed';
  } catch (error) {
    const message = createErrorMessage(error);
    normalizedResult = {
      success: false,
      error: message,
      summary: message,
    };
    status = 'failed';
    await emit(`Worker failed: ${message}`);
  }

  const completedAt = new Date().toISOString();
  const finished: OrchestrationCompletedTask<TTask, TOutput> = {
    id: record.task.id,
    title: record.task.title,
    task: record.task,
    status,
    taskDir: record.taskDir,
    startedAt,
    completedAt,
    durationMs: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
    result: normalizedResult,
  };

  await writeJsonFile(path.join(record.taskDir, 'result.json'), finished);
  if (normalizedResult.summary) {
    await writeFile(path.join(record.taskDir, 'summary.md'), `${normalizedResult.summary}\n`, 'utf8');
  }

  await appendTrace(tracePath, {
    type: status === 'completed' ? 'task_completed' : 'task_failed',
    timestamp: completedAt,
    runId,
    taskId: record.task.id,
    status,
    message: normalizedResult.summary ?? normalizedResult.error,
  });
  if (!shouldSuppressLifecycleEvents(options.signal)) {
    await options.events?.onTaskComplete?.(record.task, finished);
  }
  return finished;
}

export async function runOrchestration<TTask extends OrchestrationWorkerSpec, TOutput = unknown>(
  options: OrchestrationRunOptions<TTask, TOutput>
): Promise<OrchestrationRunResult<TTask, TOutput>> {
  validateTasks(options.tasks);

  const runId = options.runId ?? `run-${randomUUID()}`;
  const workspaceDir = path.resolve(options.workspaceDir);
  const maxParallel = Math.max(1, options.maxParallel ?? 1);
  const records = options.tasks.map((task, index) => ({
    task,
    index,
    taskDir: path.join(workspaceDir, 'tasks', createTaskDirectoryName(task.id, index)),
  }));

  const tracePath = await prepareWorkspace(workspaceDir, runId, maxParallel, records);
  await appendTrace(tracePath, {
    type: 'run_started',
    timestamp: new Date().toISOString(),
    runId,
    metadata: {
      workspaceDir,
      taskCount: records.length,
      maxParallel,
    },
  });
  await options.events?.onRunStart?.({
    runId,
    workspaceDir,
    taskCount: records.length,
  });

  const pending = new Set(records.map((record) => record.task.id));
  const completed = new Map<string, OrchestrationCompletedTask<TTask, TOutput>>();

  while (pending.size > 0) {
    if (options.signal?.aborted) {
      const message = formatAbortMessage(options.signal);
      for (const record of records) {
        if (!pending.has(record.task.id)) {
          continue;
        }
        const startedAt = new Date().toISOString();
        const blocked = buildCancelledTaskResult<TTask, TOutput>(
          record,
          startedAt,
          new Date().toISOString(),
          message,
        );
        await writeJsonFile(path.join(record.taskDir, 'result.json'), blocked);
        await writeFile(path.join(record.taskDir, 'summary.md'), `${blocked.result.summary}\n`, 'utf8');
        await appendTrace(tracePath, {
          type: 'task_blocked',
          timestamp: blocked.completedAt,
          runId,
          taskId: record.task.id,
          status: 'blocked',
          message: blocked.result.summary,
        });
        if (!shouldSuppressLifecycleEvents(options.signal)) {
          await options.events?.onTaskComplete?.(record.task, blocked);
        }
        completed.set(record.task.id, blocked);
        pending.delete(record.task.id);
      }
      break;
    }

    let blockedAny = false;

    for (const record of records) {
      if (!pending.has(record.task.id)) {
        continue;
      }

      const dependencyFailures = summarizeFailedDependencies(record.task, completed);
      if (dependencyFailures.length === 0) {
        continue;
      }

      const startedAt = new Date().toISOString();
      const blocked = buildBlockedTaskResult<TTask, TOutput>(
        record,
        dependencyFailures,
        startedAt,
        new Date().toISOString()
      );
      await writeDependencyHandoffArtifacts(
        record.taskDir,
        Object.fromEntries(
          (record.task.dependsOn ?? [])
            .map((dependencyId) => {
              const dependency = completed.get(dependencyId);
              return dependency ? [dependencyId, dependency] : undefined;
            })
            .filter((entry): entry is [string, OrchestrationCompletedTask<TTask, TOutput>] => Boolean(entry))
        ),
      );
      await writeJsonFile(path.join(record.taskDir, 'result.json'), blocked);
      await writeFile(path.join(record.taskDir, 'summary.md'), `${blocked.result.summary}\n`, 'utf8');
      await appendTrace(tracePath, {
        type: 'task_blocked',
        timestamp: blocked.completedAt,
        runId,
        taskId: record.task.id,
        status: 'blocked',
        message: blocked.result.summary,
      });
      if (!shouldSuppressLifecycleEvents(options.signal)) {
        await options.events?.onTaskComplete?.(record.task, blocked);
      }
      completed.set(record.task.id, blocked);
      pending.delete(record.task.id);
      blockedAny = true;
    }

    const ready = records.filter((record) => {
      if (!pending.has(record.task.id)) {
        return false;
      }
      return (record.task.dependsOn ?? []).every((dependencyId) => completed.get(dependencyId)?.status === 'completed');
    });

    if (ready.length === 0) {
      if (blockedAny) {
        continue;
      }
      throw new Error('No runnable orchestration tasks remain. Check dependency configuration.');
    }

    const parallelReady = ready.filter((record) => (record.task.execution ?? 'serial') === 'parallel');
    const batch = parallelReady.length > 0 && maxParallel > 1
      ? parallelReady.slice(0, maxParallel)
      : [ready[0]!];

    if (options.signal?.aborted) {
      continue;
    }

    const results = await Promise.all(
      batch.map((record) => executeTaskRecord(record, options, runId, tracePath, completed))
    );

    for (const result of results) {
      completed.set(result.id, result);
      pending.delete(result.id);
    }
  }

  const orderedTasks = records
    .map((record) => completed.get(record.task.id))
    .filter((task): task is OrchestrationCompletedTask<TTask, TOutput> => Boolean(task));

  const summary = {
    total: orderedTasks.length,
    completed: orderedTasks.filter((task) => task.status === 'completed').length,
    failed: orderedTasks.filter((task) => task.status === 'failed').length,
    blocked: orderedTasks.filter((task) => task.status === 'blocked').length,
  };

  const result: OrchestrationRunResult<TTask, TOutput> = {
    runId,
    workspaceDir,
    tasks: orderedTasks,
    taskResults: Object.fromEntries(orderedTasks.map((task) => [task.id, task])),
    summary,
  };

  await writeJsonFile(path.join(workspaceDir, 'summary.json'), {
    runId,
    completedAt: new Date().toISOString(),
    summary,
    tasks: orderedTasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      durationMs: task.durationMs,
      taskDir: path.relative(workspaceDir, task.taskDir).replace(/\\/g, '/'),
      summary: task.result.summary ?? null,
    })),
  });
  await appendTrace(tracePath, {
    type: 'run_completed',
    timestamp: new Date().toISOString(),
    runId,
    metadata: summary,
  });
  await options.events?.onRunComplete?.(result);
  return result;
}

function formatDependencyHandoff<TTask extends KodaXAgentWorkerSpec>(
  context: OrchestrationTaskContext<TTask, string>
): string | undefined {
  const dependencies = Object.values(context.dependencyResults);
  if (dependencies.length === 0) {
    return undefined;
  }

  return [
    'Dependency handoff artifacts:',
    `- Read structured bundle first: ${path.join(context.taskDir, 'handoff.json')}`,
    `- Read human summary next: ${path.join(context.taskDir, 'handoff.md')}`,
    'Dependency summary preview:',
    ...dependencies.map((dependency) => {
      const summary = dependency.result.summary
        ?? dependency.result.error
        ?? 'No summary available.';
      return [
        `- ${dependency.id} (${dependency.title})`,
        `  Status: ${dependency.status}`,
        `  Summary: ${truncateText(summary, 600)}`,
        `  Result artifact: ${path.join(dependency.taskDir, 'result.json')}`,
        dependency.result.summary
          ? `  Summary artifact: ${path.join(dependency.taskDir, 'summary.md')}`
          : undefined,
        dependency.result.artifacts?.length
          ? `  Additional artifacts: ${dependency.result.artifacts.map((artifact) => artifact.path).join(', ')}`
          : undefined,
        typeof dependency.result.output === 'string'
          ? `  Output excerpt: ${truncateText(dependency.result.output, DEPENDENCY_PROMPT_EXCERPT_MAX_LENGTH)}`
          : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n');
    }),
  ].join('\n');
}

function buildDefaultKodaXPrompt<TTask extends KodaXAgentWorkerSpec>(
  task: TTask,
  context: OrchestrationTaskContext<TTask, string>
): string {
  return [
    task.agent ? `Preferred agent: ${task.agent}` : undefined,
    formatDependencyHandoff(context),
    task.prompt,
  ].filter((value): value is string => Boolean(value && value.trim())).join('\n\n');
}

function mergeBeforeToolExecute(
  baseHook: KodaXEvents['beforeToolExecute'] | undefined,
  taskHook: KodaXEvents['beforeToolExecute'] | undefined
): KodaXEvents['beforeToolExecute'] | undefined {
  if (!baseHook && !taskHook) {
    return undefined;
  }

  return async (tool, input) => {
    if (taskHook) {
      const taskDecision = await taskHook(tool, input);
      if (taskDecision !== true) {
        return taskDecision;
      }
    }

    if (baseHook) {
      return baseHook(tool, input);
    }

    return true;
  };
}

export function createKodaXTaskRunner<TTask extends KodaXAgentWorkerSpec = KodaXAgentWorkerSpec>(
  options: CreateKodaXTaskRunnerOptions<TTask>
): OrchestrationWorkerRunner<TTask, string> {
  const runAgent = options.runAgent ?? runKodaX;

  return async (task, context) => {
    const prompt = (options.buildPrompt ?? buildDefaultKodaXPrompt)(task, context);
    const taskEvents = options.createEvents?.(task, context) ?? {};
    const baseEvents = options.baseOptions.events ?? {};

    await context.emit(
      `Launching worker with reasoning=${task.budget?.reasoningMode ?? options.baseOptions.reasoningMode ?? 'auto'} maxIter=${task.budget?.maxIter ?? options.baseOptions.maxIter ?? 'default'}`
    );

    const effectiveAbortSignal = mergeAbortSignals(options.baseOptions.abortSignal, context.signal);
    const mergedEvents: KodaXEvents = {
      ...baseEvents,
      ...taskEvents,
      beforeToolExecute: mergeBeforeToolExecute(baseEvents.beforeToolExecute, task.beforeToolExecute),
      onToolResult: (result) => {
        baseEvents.onToolResult?.(result);
        taskEvents.onToolResult?.(result);
      },
    };

    const runOptions: KodaXOptions = {
      ...options.baseOptions,
      provider: task.provider ?? options.baseOptions.provider,
      model: task.model ?? options.baseOptions.model,
      maxIter: task.budget?.maxIter ?? options.baseOptions.maxIter,
      thinking: task.budget?.thinking ?? options.baseOptions.thinking,
      reasoningMode: task.budget?.reasoningMode ?? options.baseOptions.reasoningMode,
      abortSignal: effectiveAbortSignal,
      events: mergedEvents,
    };
    const preparedRunOptions = options.createOptions
      ? options.createOptions(task, context, runOptions)
      : runOptions;

    const execute = () => runAgent(preparedRunOptions, prompt);
    const executeDefault = () => options.rateLimit
      ? options.rateLimit(execute)
      : execute();
    const result = options.runTask
      ? await options.runTask(task, context, preparedRunOptions, prompt, executeDefault)
      : await executeDefault();
    const transformedResult = await options.onResult?.(task, context, result) ?? result;

    if (transformedResult.interrupted && effectiveAbortSignal?.aborted) {
      const message = formatAbortMessage(effectiveAbortSignal);
      return {
        success: false,
        output: transformedResult.lastText,
        summary: message,
        error: message,
        metadata: {
          sessionId: transformedResult.sessionId,
          signal: 'BLOCKED',
          signalReason: message,
          interrupted: true,
          limitReached: transformedResult.limitReached ?? false,
        },
      };
    }

    await context.emit(
      transformedResult.signal
        ? `Worker finished with signal=${transformedResult.signal}${transformedResult.signalReason ? ` (${transformedResult.signalReason})` : ''}`
        : 'Worker finished successfully'
    );

    return {
      success: transformedResult.success,
      output: transformedResult.lastText,
      summary: truncateText(
        transformedResult.lastText
          || transformedResult.signalReason
          || (transformedResult.interrupted ? 'Worker interrupted before producing a textual result.' : 'No textual output produced.'),
      ),
      metadata: {
        sessionId: transformedResult.sessionId,
        signal: transformedResult.signal ?? null,
        signalReason: transformedResult.signalReason ?? null,
        interrupted: transformedResult.interrupted ?? false,
        limitReached: transformedResult.limitReached ?? false,
      },
    };
  };
}
