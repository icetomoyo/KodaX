/**
 * The REPL's workflow controls over v2, against a real Host with a scripted model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowProcessEvent } from '@kodax-ai/agent';

import { disposeReplHosts, replHost } from '../../tests/repl-v2-host.js';
import { createReplWorkflows } from './workflows.js';

afterEach(disposeReplHosts, 60_000);

// One Agent, so in `hold` mode the workflow keeps running until the test stops it.
const SCRIPT = {
  kind: 'inline' as const,
  manifest: {
    name: 'repl-audit', description: 'Audit one part', readOnly: true, maxAgents: 1, maxConcurrency: 1,
    phases: ['audit'], patterns: ['fan-out-and-synthesize'],
  },
  source: 'async function run(wf) { const result = await wf.runAgent({ name: "audit", '
    + 'prompt: "Audit the part.", readOnly: true }); return { synthesis: result.finalText }; }',
};

describe('the REPL workflow controls over v2', () => {
  it('starts a workflow in the Session, follows it to its end and reads it in the shapes the REPL reads', async () => {
    const { client, sessionId, homeDir } = await replHost('answer');
    const asked: unknown[] = [];
    const workflows = createReplWorkflows(client, async (request) => { asked.push(request); return undefined; });
    const events: WorkflowProcessEvent[] = [];
    let finished: (event: WorkflowProcessEvent) => void = () => undefined;
    const end = new Promise<WorkflowProcessEvent>((resolve) => { finished = resolve; });
    const errors: unknown[] = [];
    const subscription = workflows.subscribe({ sessionId }, (event) => {
      events.push(event);
      if (event.type === 'workflow_finished') finished(event);
    }, error => errors.push(error));
    await subscription.ready;

    const started = await workflows.start({ sessionId, projectRoot: homeDir, source: SCRIPT });
    expect(started).toEqual({ kind: 'started', runId: expect.any(String) });
    const runId = started.kind === 'started' ? started.runId : '';
    expect(asked).toEqual([{ kind: 'workflow', input: { sessionId, projectRoot: homeDir, source: SCRIPT } }]);

    const last = await end;
    subscription.close();
    expect(last.snapshot).toMatchObject({
      runId, workflowName: 'repl-audit', status: 'completed', hostMetadata: { ownerSessionId: sessionId, ownerRunId: expect.any(String) },
    });
    expect(Date.parse(last.snapshot.startedAt)).toBeGreaterThan(0);
    expect(events.every(event => event.snapshot.runId === runId)).toBe(true);
    expect(errors).toEqual([]);

    expect(await workflows.list({ sessionId })).toEqual([expect.objectContaining({
      runId, workflow: 'repl-audit', status: 'completed', eventCount: 0, runDir: '', startedAt: expect.any(Number),
    })]);
    expect(await workflows.get(runId, { sessionId })).toMatchObject({ runId, status: 'completed' });
    expect(await workflows.get('no-such-workflow', { sessionId })).toBeUndefined();
    await expect(workflows.list()).rejects.toThrow(/Session/);
  }, 90_000);

  it('passes a decline on as the REPL reads one', async () => {
    const { client, sessionId, homeDir } = await replHost('answer');
    const workflows = createReplWorkflows(client, async () => undefined);
    expect(await workflows.start({ sessionId, projectRoot: homeDir, source: { kind: 'name', name: 'no-such-workflow' } }))
      .toEqual({ kind: 'declined', reason: expect.any(String) });
  });

  it('pauses, resumes and stops, and says when there is nothing left to steer', async () => {
    const { client, sessionId, homeDir } = await replHost('hold');
    const workflows = createReplWorkflows(client, async () => undefined);
    const scope = { sessionId };
    const started = await workflows.start({ sessionId, projectRoot: homeDir, source: SCRIPT });
    const runId = started.kind === 'started' ? started.runId : '';

    expect(await workflows.pause(runId, scope)).toBe(true);
    expect((await workflows.get(runId, scope))?.status).toBe('paused');
    expect(await workflows.resume(runId, scope)).toBe(true);
    expect((await workflows.get(runId, scope))?.status).toBe('running');

    expect(await workflows.stop(runId, scope)).toBe(true);
    await expect.poll(async () => (await workflows.get(runId, scope))?.status, { timeout: 15_000 }).toBe('cancelled');
    expect(await workflows.stop(runId, scope)).toBe(false);
    expect(await workflows.pause(runId, scope)).toBe(false);
    expect(await workflows.resume(runId, scope)).toBe(false);
    expect(await workflows.stop('no-such-workflow', scope)).toBe(false);
  }, 90_000);
});
