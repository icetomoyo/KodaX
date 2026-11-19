import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { KodaXOptions, KodaXResult } from '../types.js';
import type { WorkflowProcessEvent, WorkflowProcessSnapshot } from '@kodax-ai/agent';

// Mock the managed Run entry so startKodaX's real option-merging
// runs but no agent loop executes. Capture the effective options the Run sees.
const runKodaXMock = vi.fn<[KodaXOptions, string], Promise<KodaXResult>>();
vi.mock('../task-engine.js', () => ({
  runManagedTask: (options: KodaXOptions, prompt: string) => runKodaXMock(options, prompt),
}));

const { authorWorkflowViaWorker, buildScoutThenAuthorPrompt, SCOUT_THEN_AUTHOR_PROMPT_LINES } =
  await import('./author-via-worker.js');

const RESULT: KodaXResult = { finalMessage: 'done' } as unknown as KodaXResult;

function startedEvent(runId: string): WorkflowProcessEvent {
  return {
    type: 'workflow_started',
    snapshot: { runId, workflowName: 'w', status: 'running' } as unknown as WorkflowProcessSnapshot,
  };
}

describe('buildScoutThenAuthorPrompt', () => {
  it('produces the exact scout-then-author turn text (byte-identical shared constant)', () => {
    // This literal is the contract shared with the REPL /workflow create path.
    // If it changes, workflow-command.ts must produce the identical string.
    expect(buildScoutThenAuthorPrompt('Review the payment flow')).toBe(
      'Set up and run a multi-agent workflow for this task.\n' +
        'First investigate the relevant files and sub-problems with your own tools, then author and run it with run_workflow — bake the concrete findings (exact paths, the specific dimensions to compare, a real outputSchema) into the child prompts rather than re-delegating the scouting.\n' +
        '\n' +
        'Review the payment flow',
    );
    // The request is appended after a blank line separating instructions from task.
    expect(SCOUT_THEN_AUTHOR_PROMPT_LINES).toHaveLength(2);
  });
});

describe('authorWorkflowViaWorker', () => {
  beforeEach(() => {
    runKodaXMock.mockReset();
    runKodaXMock.mockResolvedValue(RESULT);
  });

  it('throws when workflowRunsBaseDir is missing (run_workflow would not wire)', () => {
    expect(() =>
      authorWorkflowViaWorker({ request: 'x', options: { provider: 'anthropic' } as KodaXOptions }),
    ).toThrow(/workflowRunsBaseDir is required/);
    expect(runKodaXMock).not.toHaveBeenCalled();
  });

  it('uses AMA with explicit Workflow intent and submits the scout-then-author prompt', async () => {
    const handle = authorWorkflowViaWorker({
      request: 'Audit the auth module',
      options: { provider: 'anthropic', agentMode: 'ama', workflowRunsBaseDir: '/tmp/runs' } as KodaXOptions,
    });
    await handle.session.result;
    expect(runKodaXMock).toHaveBeenCalledTimes(1);
    const [passedOptions, passedPrompt] = runKodaXMock.mock.calls[0]!;
    expect(passedOptions.agentMode).toBe('ama');
    expect(passedOptions.context?.workflowIntent).toBe('explicit');
    expect(passedOptions.workflowRunsBaseDir).toBe('/tmp/runs');
    expect(passedPrompt).toBe(buildScoutThenAuthorPrompt('Audit the auth module'));
  });

  it('resolves workflowRunId from the first workflow_started event and still calls the host handler', async () => {
    const hostSpy = vi.fn();
    const handle = authorWorkflowViaWorker({
      request: 'x',
      options: {
        provider: 'anthropic',
        workflowRunsBaseDir: '/tmp/runs',
        events: { onWorkflowProcessEvent: hostSpy },
      } as KodaXOptions,
    });
    const wrapped = runKodaXMock.mock.calls[0]![0].events!.onWorkflowProcessEvent!;
    wrapped(startedEvent('run-42'));
    await expect(handle.workflowRunId).resolves.toBe('run-42');
    // Host's own handler is preserved (composed, not replaced).
    expect(hostSpy).toHaveBeenCalledWith(startedEvent('run-42'));
  });

  it('resolves workflowRunId to undefined when the turn ends without starting a workflow', async () => {
    const handle = authorWorkflowViaWorker({
      request: 'just answer inline',
      options: { provider: 'anthropic', workflowRunsBaseDir: '/tmp/runs' } as KodaXOptions,
    });
    await handle.session.result;
    await expect(handle.workflowRunId).resolves.toBeUndefined();
  });

  it('once the turn ends undefined, a late workflow_started event does not flip or throw (settle race)', async () => {
    const handle = authorWorkflowViaWorker({
      request: 'x',
      options: { provider: 'anthropic', workflowRunsBaseDir: '/tmp/runs' } as KodaXOptions,
    });
    const wrapped = runKodaXMock.mock.calls[0]![0].events!.onWorkflowProcessEvent!;
    // Turn ends WITHOUT a workflow → workflowRunId settles undefined.
    await handle.session.result;
    await expect(handle.workflowRunId).resolves.toBeUndefined();
    // A stray/late event afterwards must not throw or change the settled value.
    expect(() => wrapped(startedEvent('run-late'))).not.toThrow();
    await expect(handle.workflowRunId).resolves.toBeUndefined();
  });
});
