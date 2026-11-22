import { describe, expect, it } from 'vitest';
import type { KodaXExtensionRuntime } from '@kodax-ai/coding';
import type { ClientCommandInput } from '@kodax-ai/coding/client-contract';

import { createRuntimeProductCommandService } from './runtime-product-commands.js';
import type { RuntimePreparedCommand } from './runtime-invocations.js';

type Handler = (args: string[]) => unknown;

/**
 * A command service over a Host that knows the prompt command `release` and
 * the configuration commands in `handlers`. `busy` is what an idle Session is
 * asked to be; `changes` is whether `/review` finds a diff. `started` holds
 * the Run each input id started and `typed` what was typed for it; `prepared`
 * names each review and AGENTS.md check the Host prepared.
 */
function makeCommands(handlers: Record<string, Handler> = {}) {
  const started = new Map<string, string>();
  const typed = new Map<string, string>();
  const handled: string[] = [];
  const prepared: string[] = [];
  const state = { busy: false, changes: true };
  const start = async (input: ClientCommandInput): Promise<{ readonly runId: string }> => {
    if (!started.has(input.inputId)) {
      started.set(input.inputId, `run-of-${input.inputId}`);
      typed.set(input.inputId, [`/${input.name}`, ...(input.args ?? [])].join(' '));
    }
    return { runId: started.get(input.inputId)! };
  };
  const service = createRuntimeProductCommandService({
    extensionRuntime: {
      getCommand: (name: string) => handlers[name] === undefined ? undefined : {
        name, description: `The ${name}`, execution: 'configuration',
        handler: async (args: string[]) => { handled.push([name, ...args].join(' ')); return handlers[name]!(args); },
      },
    } as unknown as KodaXExtensionRuntime,
    prepareCommand: async ({ name }): Promise<RuntimePreparedCommand> => name === 'release'
      ? { kind: 'prepared', invocation: { prompt: 'Check the release.', source: 'prompt', displayName: 'release' } }
      : { kind: 'unknown' },
    reviewPreparation: {
      prepareReview: async ({ args }) => {
        prepared.push(['/review', ...args].join(' '));
        return state.changes
          ? { kind: 'prepared', invocation: { prompt: 'Review the diff.', source: 'prompt', displayName: '/review' } }
          : { kind: 'empty' };
      },
      prepareAgentsLean: async () => {
        prepared.push('/agents lean');
        return { kind: 'prepared', invocation: { prompt: 'Trim AGENTS.md.', source: 'prompt', displayName: '/agents lean' } };
      },
    },
    startReviewWorkflow: async () => ({ kind: 'completed', success: false }),
    startInvocation: start,
    startToolInvocation: start,
    startedRun: async (_sessionId, inputId) => started.get(inputId),
    acceptedRun: async ({ inputId, text }) => {
      if (started.has(inputId) && typed.get(inputId) !== text) {
        throw Object.assign(new Error('Input ID already belongs to a different intent.'), { code: 'conflict' });
      }
      return started.get(inputId);
    },
    withSession: (_sessionId, read) => read({ projectRoot: '/work/app', workingDirectory: '/work/app' }),
    withIdleSession: async (_sessionId, execute) => {
      if (state.busy) throw Object.assign(new Error('Session is busy.'), { code: 'conflict' });
      return execute({ projectRoot: '/work/app', workingDirectory: '/work/app' });
    },
  });
  return { service, started, typed, handled, prepared, state };
}

const SESSION = 'session-1';

describe('a command sent again under the id it was first sent with', () => {
  it('is answered with the Run it started, also while that Run keeps the Session busy', async () => {
    const { service, state } = makeCommands();
    const command = { sessionId: SESSION, inputId: 'command-1', name: 'release', args: ['auth'] };

    const first = await service.executeCommand(command);
    expect(first).toEqual({ kind: 'started', runId: 'run-of-command-1' });
    state.busy = true;
    expect(await service.executeCommand(command)).toEqual(first);
    // Another command still has to wait for the Session.
    await expect(service.executeCommand({ ...command, inputId: 'command-2' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('runs a command the Host finishes itself once', async () => {
    const { service, handled } = makeCommands({ note: args => ({ message: `Noted ${args.join(' ')}` }) });
    const command = { sessionId: SESSION, inputId: 'command-1', name: 'note', args: ['first'] };

    const both = await Promise.all([service.executeCommand(command), service.executeCommand(command)]);
    expect(both).toEqual([
      { kind: 'completed', success: true, message: 'Noted first' },
      { kind: 'completed', success: true, message: 'Noted first' },
    ]);
    expect(await service.executeCommand(command)).toEqual(both[0]);
    expect(handled).toEqual(['note first']);

    // The id names one intent: another command under it is refused, and under another id it runs.
    await expect(service.executeCommand({ ...command, args: ['second'] })).rejects.toMatchObject({ code: 'conflict' });
    await expect(service.executeCommand({ ...command, name: 'release' })).rejects.toMatchObject({ code: 'conflict' });
    await service.executeCommand({ ...command, inputId: 'command-2', args: ['second'] });
    // The same id in another Session is another command.
    await service.executeCommand({ ...command, sessionId: 'session-2' });
    expect(handled).toEqual(['note first', 'note second', 'note first']);
  });

  it('may be tried again after it failed', async () => {
    let attempts = 0;
    const { service, handled } = makeCommands({
      flaky: () => { attempts += 1; if (attempts === 1) throw new Error('The disk was full.'); return { message: 'Saved' }; },
    });
    const command = { sessionId: SESSION, inputId: 'command-1', name: 'flaky' };

    await expect(service.executeCommand(command)).rejects.toThrow('The disk was full.');
    expect(await service.executeCommand(command)).toEqual({ kind: 'completed', success: true, message: 'Saved' });
    expect(handled).toEqual(['flaky', 'flaky']);
    // A command that said it did not succeed did answer: it is not run again.
    const refused = makeCommands({ strict: () => ({ success: false, message: 'Not allowed here.' }) });
    const answer = await refused.service.executeCommand({ ...command, name: 'strict' });
    expect(answer).toEqual({ kind: 'completed', success: false, message: 'Not allowed here.' });
    expect(await refused.service.executeCommand({ ...command, name: 'strict' })).toEqual(answer);
    expect(refused.handled).toEqual(['strict']);
  });

  it('does not run the handler again for a Run a Host started before it restarted', async () => {
    const before = makeCommands({ plan: () => ({ invocation: { prompt: 'Plan the release.' }, message: 'Planning' }) });
    const command = { sessionId: SESSION, inputId: 'command-1', name: 'plan' };
    expect(await before.service.executeCommand(command)).toEqual({ kind: 'started', runId: 'run-of-command-1', message: 'Planning' });

    // The Host that restarted kept the Run and nothing else.
    const after = makeCommands({ plan: () => ({ invocation: { prompt: 'Plan the release.' }, message: 'Planning' }) });
    after.started.set('command-1', 'run-of-command-1');
    after.state.busy = true;
    expect(await after.service.executeCommand(command)).toEqual({ kind: 'started', runId: 'run-of-command-1' });
    expect(after.handled).toEqual([]);
  });

  it('keeps a bounded number of answers', async () => {
    const { service, handled } = makeCommands({ note: () => ({ message: 'Noted' }) });
    const send = (inputId: string) => service.executeCommand({ sessionId: SESSION, inputId, name: 'note' });

    await send('oldest');
    for (let sent = 0; sent < 300; sent += 1) await send(`later-${sent}`);
    await send('later-299');
    expect(handled).toHaveLength(301);
    // The oldest answer was let go, so the Host no longer recognises its id.
    await send('oldest');
    expect(handled).toHaveLength(302);
  });
});

describe('a review sent again under the id it was first sent with', () => {
  it('is answered with the Run it started, without capturing the changes again', async () => {
    const { service, prepared, state } = makeCommands();
    const review = { sessionId: SESSION, inputId: 'review-1', args: ['--staged'] };

    const both = await Promise.all([service.startReview(review), service.startReview(review)]);
    expect(both).toEqual([{ kind: 'started', runId: 'run-of-review-1' }, { kind: 'started', runId: 'run-of-review-1' }]);
    state.busy = true;
    expect(await service.startReview(review)).toEqual(both[0]);
    expect(prepared).toEqual(['/review --staged']);
    await expect(service.startReview({ ...review, args: [] })).rejects.toMatchObject({ code: 'conflict' });
    // Another review still has to wait for the Session.
    await expect(service.startReview({ ...review, inputId: 'review-2' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('finds the Run a Host started before it restarted, though the changes are gone', async () => {
    const before = makeCommands();
    const review = { sessionId: SESSION, inputId: 'review-1', args: ['--staged'] };
    await before.service.startReview(review);

    // The Host that restarted kept the Run and what was typed for it, and the changes were committed since.
    const after = makeCommands();
    after.started.set('review-1', 'run-of-review-1');
    after.typed.set('review-1', '/review --staged');
    after.state.changes = false;
    expect(await after.service.startReview(review)).toEqual({ kind: 'started', runId: 'run-of-review-1' });
    expect(after.prepared).toEqual([]);
    await expect(after.service.startReview({ ...review, args: ['main'] })).rejects.toMatchObject({ code: 'conflict' });
    // A review that started nothing reviews what is there now.
    expect(await after.service.startReview({ ...review, inputId: 'review-2' }))
      .toEqual({ kind: 'completed', success: true, message: 'No changes to review.' });
  });

  it('holds for the AGENTS.md review too, and keeps it apart from a command under the same id', async () => {
    const { service, prepared, state } = makeCommands();
    const lean = { sessionId: SESSION, inputId: 'lean-1' };

    expect(await service.startAgentsLean(lean)).toEqual({ kind: 'started', runId: 'run-of-lean-1' });
    state.busy = true;
    expect(await service.startAgentsLean(lean)).toEqual({ kind: 'started', runId: 'run-of-lean-1' });
    expect(prepared).toEqual(['/agents lean']);
    await expect(service.startReview(lean)).rejects.toMatchObject({ code: 'conflict' });
    await expect(service.executeCommand({ ...lean, name: 'agents', args: ['lean'] })).rejects.toMatchObject({ code: 'conflict' });
  });
});
