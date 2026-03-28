import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createKodaXTaskRunner,
  runOrchestration,
  type KodaXAgentWorkerSpec,
  type OrchestrationCompletedTask,
} from './orchestration.js';

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('runOrchestration', () => {
  it('runs parallel-safe ready tasks, then hands their outputs to dependent tasks', async () => {
    const workspaceDir = await createTempDir('kodax-orch-');
    let concurrent = 0;
    let maxConcurrent = 0;

    const result = await runOrchestration({
      workspaceDir,
      maxParallel: 2,
      tasks: [
        { id: 'research', title: 'Research', execution: 'parallel' },
        { id: 'review', title: 'Review', execution: 'parallel' },
        { id: 'summarize', title: 'Summarize', dependsOn: ['research', 'review'] },
      ],
      runner: async (task, context) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await context.emit(`started ${task.id}`);
        await delay(task.id === 'summarize' ? 5 : 30);
        concurrent -= 1;

        const handoffIds = Object.keys(context.dependencyResults).sort();
        return {
          success: true,
          output: `${task.id}:${handoffIds.join(',')}`,
          summary: `done ${task.id}`,
        };
      },
    });

    expect(result.summary).toEqual({
      total: 3,
      completed: 3,
      failed: 0,
      blocked: 0,
    });
    expect(maxConcurrent).toBe(2);
    expect(result.taskResults.summarize?.result.output).toBe('summarize:research,review');

    const handoff = JSON.parse(
      await readFile(path.join(workspaceDir, 'tasks', '03-summarize', 'handoff.json'), 'utf8')
    );
    expect(handoff.dependencies.map((dependency: { id: string }) => dependency.id).sort()).toEqual(['research', 'review']);
    expect(await readFile(path.join(workspaceDir, 'tasks', '03-summarize', 'handoff.md'), 'utf8')).toContain('# Dependency Handoff');

    const trace = await readFile(path.join(workspaceDir, 'trace.ndjson'), 'utf8');
    expect(trace).toContain('"type":"task_started"');
    expect(trace).toContain('"type":"run_completed"');
  });

  it('blocks downstream tasks when a dependency fails', async () => {
    const workspaceDir = await createTempDir('kodax-orch-');

    const result = await runOrchestration({
      workspaceDir,
      tasks: [
        { id: 'prepare', title: 'Prepare' },
        { id: 'publish', title: 'Publish', dependsOn: ['prepare'] },
      ],
      runner: async (task) => {
        if (task.id === 'prepare') {
          return {
            success: false,
            error: 'validation failed',
            summary: 'validation failed',
          };
        }
        return {
          success: true,
          output: 'published',
        };
      },
    });

    expect(result.summary).toEqual({
      total: 2,
      completed: 0,
      failed: 1,
      blocked: 1,
    });
    expect(result.taskResults.prepare?.status).toBe('failed');
    expect(result.taskResults.publish?.status).toBe('blocked');
    expect(result.taskResults.publish?.result.error).toContain('prepare (failed)');

    const blockedResult = JSON.parse(
      await readFile(path.join(workspaceDir, 'tasks', '02-publish', 'result.json'), 'utf8')
    );
    expect(blockedResult.status).toBe('blocked');
  });

  it('marks pending tasks as blocked when the orchestration signal is aborted', async () => {
    const workspaceDir = await createTempDir('kodax-orch-');
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));
    const runner = vi.fn(async () => ({
      success: true,
      output: 'should-not-run',
      summary: 'should-not-run',
    }));

    const result = await runOrchestration({
      workspaceDir,
      signal: controller.signal,
      tasks: [
        { id: 'prepare', title: 'Prepare' },
        { id: 'publish', title: 'Publish', dependsOn: ['prepare'] },
      ],
      runner,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(result.summary).toEqual({
      total: 2,
      completed: 0,
      failed: 0,
      blocked: 2,
    });
    expect(result.taskResults.prepare?.status).toBe('blocked');
    expect(result.taskResults.prepare?.result.metadata?.signal).toBe('BLOCKED');
    expect(result.taskResults.publish?.result.summary).toContain('user cancelled');
  });
});

describe('createKodaXTaskRunner', () => {
  it('assembles preferred-agent and dependency handoff context before calling runKodaX', async () => {
    const workspaceDir = await createTempDir('kodax-runner-');
    const dependencyOutput = 'dependency output '.repeat(120);
    let capturedRunOptions: unknown;
    let capturedPrompt: unknown;
    const runAgent = vi.fn(async (runOptions: unknown, prompt: unknown) => {
      capturedRunOptions = runOptions;
      capturedPrompt = prompt;
      return {
      success: true,
      lastText: 'final answer',
      messages: [],
      sessionId: 'session-1',
      };
    });
    const runner = createKodaXTaskRunner({
      baseOptions: {
        provider: 'anthropic',
        reasoningMode: 'balanced',
        thinking: true,
      },
      runAgent,
    });

    const dependencyResults: Record<string, OrchestrationCompletedTask<KodaXAgentWorkerSpec, string>> = {
      research: {
        id: 'research',
        title: 'Research',
        task: {
          id: 'research',
          title: 'Research',
          prompt: 'Research prompt',
        },
        status: 'completed',
        taskDir: path.join(workspaceDir, 'tasks', '01-research'),
        startedAt: '2026-03-17T00:00:00.000Z',
        completedAt: '2026-03-17T00:00:01.000Z',
        durationMs: 1000,
        result: {
          success: true,
          output: dependencyOutput,
          summary: 'dependency summary',
        },
      },
    };

    const result = await runner(
      {
        id: 'writer',
        title: 'Writer',
        prompt: 'Write the final summary.',
        agent: 'Writer',
        budget: {
          reasoningMode: 'deep',
          maxIter: 12,
        },
      },
      {
        runId: 'run-1',
        workspaceDir,
        taskDir: path.join(workspaceDir, 'tasks', '02-writer'),
        dependencyResults,
        emit: async () => {},
      }
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('final answer');
    expect(runAgent).toHaveBeenCalledTimes(1);

    expect(capturedRunOptions).toMatchObject({
      reasoningMode: 'deep',
      maxIter: 12,
    });
    expect(String(capturedPrompt)).toContain('Preferred agent: Writer');
    expect(String(capturedPrompt)).toContain('Dependency handoff artifacts:');
    expect(String(capturedPrompt)).toContain('handoff.json');
    expect(String(capturedPrompt)).toContain('handoff.md');
    expect(String(capturedPrompt)).toContain('dependency summary');
    expect(String(capturedPrompt)).toContain('Result artifact:');
    expect(String(capturedPrompt)).toContain('Output excerpt: dependency output');
    expect(String(capturedPrompt)).toContain('Write the final summary.');
  });

  it('allows callers to customize run options and observe the raw agent result', async () => {
    const workspaceDir = await createTempDir('kodax-runner-');
    let observedResult: unknown;
    const runAgent = vi.fn(async (runOptions: unknown, _prompt: unknown) => ({
      success: true,
      lastText: 'custom result',
      messages: [],
      sessionId: 'session-custom',
      signal: 'COMPLETE' as const,
      signalReason: 'verified',
      observedOptions: runOptions,
    }));

    const runner = createKodaXTaskRunner({
      baseOptions: {
        provider: 'anthropic',
        session: {
          id: 'base-session',
        },
        context: {
          taskSurface: 'repl',
        },
      },
      runAgent,
      createOptions: (_task, _context, defaults) => ({
        ...defaults,
        session: {
          ...defaults.session,
          id: 'worker-session',
        },
        context: {
          ...defaults.context,
          promptOverlay: 'worker overlay',
        },
      }),
      onResult: async (_task, _context, result) => {
        observedResult = result;
      },
    });

    const result = await runner(
      {
        id: 'reviewer',
        title: 'Reviewer',
        prompt: 'Review the output.',
      },
      {
        runId: 'run-2',
        workspaceDir,
        taskDir: path.join(workspaceDir, 'tasks', '01-reviewer'),
        dependencyResults: {},
        emit: async () => {},
      },
    );

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0]?.[0]).toMatchObject({
      session: { id: 'worker-session' },
      context: { promptOverlay: 'worker overlay' },
    });
    expect(observedResult).toMatchObject({
      sessionId: 'session-custom',
      signal: 'COMPLETE',
    });
    expect(result.metadata).toMatchObject({
      sessionId: 'session-custom',
      signal: 'COMPLETE',
      signalReason: 'verified',
    });
  });

  it('merges the outer abort signal into worker runs and reports interrupted workers as blocked', async () => {
    const workspaceDir = await createTempDir('kodax-runner-');
    const outerAbort = new AbortController();
    const innerAbort = new AbortController();
    const runAgent = vi.fn(async (runOptions: { abortSignal?: AbortSignal }) => {
      const signal = runOptions.abortSignal;
      const reason = await new Promise<string>((resolve) => {
        if (signal?.aborted) {
          resolve(signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'aborted'));
          return;
        }
        signal?.addEventListener('abort', () => {
          resolve(signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'aborted'));
        }, { once: true });
      });
      return {
        success: true,
        lastText: `aborted:${reason}`,
        messages: [],
        sessionId: 'session-aborted',
        interrupted: true,
      };
    });

    const runner = createKodaXTaskRunner({
      baseOptions: {
        provider: 'anthropic',
        abortSignal: outerAbort.signal,
      },
      runAgent,
    });

    const runPromise = runner(
      {
        id: 'writer',
        title: 'Writer',
        prompt: 'Write the final summary.',
      },
      {
        runId: 'run-abort',
        workspaceDir,
        taskDir: path.join(workspaceDir, 'tasks', '01-writer'),
        dependencyResults: {},
        emit: async () => {},
        signal: innerAbort.signal,
      },
    );

    outerAbort.abort(new Error('user cancelled'));
    const result = await runPromise;

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.summary).toContain('user cancelled');
    expect(result.metadata).toMatchObject({
      signal: 'BLOCKED',
      interrupted: true,
    });
  });
});
