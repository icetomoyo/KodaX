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
    expect(Object.keys(handoff)).toEqual(['research', 'review']);

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
});

describe('createKodaXTaskRunner', () => {
  it('assembles preferred-agent and dependency handoff context before calling runKodaX', async () => {
    const workspaceDir = await createTempDir('kodax-runner-');
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
          output: 'dependency output',
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
    expect(String(capturedPrompt)).toContain('Dependency handoff:');
    expect(String(capturedPrompt)).toContain('dependency summary');
    expect(String(capturedPrompt)).toContain('Write the final summary.');
  });
});
