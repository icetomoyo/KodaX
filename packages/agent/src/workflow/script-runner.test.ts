import { describe, expect, it, vi } from 'vitest';

import { Script } from 'node:vm';

import type {
  WorkflowApi,
  WorkflowArtifactRef,
  WorkflowLogEvent,
  WorkflowTaskHandle,
  WorkflowTaskResult,
  WorkflowTaskSnapshot,
  WorkflowSpawnAgentInput,
} from './index.js';
import {
  createRestrictedWorkflowModule,
  runRestrictedWorkflowScript,
  validateRestrictedWorkflowSource,
  WorkflowScriptExecutionError,
  runWorkflow,
} from './index.js';
import { DEFAULT_WORKFLOW_SCRIPT_SYNC_TIMEOUT_MS } from './script-runner.js';

function notImplemented(name: string): never {
  throw new Error(`${name} not implemented`);
}

function fakeWorkflowApi(): { wf: WorkflowApi; prompts: string[]; phases: string[]; inputs: WorkflowSpawnAgentInput[] } {
  const prompts: string[] = [];
  const phases: string[] = [];
  const inputs: WorkflowSpawnAgentInput[] = [];
  const wf: WorkflowApi = {
    runId: 'run-script',
    args: undefined,
    budget: {
      total: 100,
      spent: () => 0,
      remaining: () => 100,
    },
    phase: async (name, fn) => {
      phases.push(`start:${name}`);
      try {
        return await fn();
      } finally {
        phases.push(`finish:${name}`);
      }
    },
    spawnAgent: async (input): Promise<WorkflowTaskHandle> => {
      inputs.push(input);
      prompts.push(input.prompt);
      return { taskId: 'task-1', name: input.name };
    },
    runAgent: async (input): Promise<WorkflowTaskResult> => {
      inputs.push(input);
      prompts.push(input.prompt);
      return {
        taskId: 'task-1',
        name: input.name,
        status: 'completed',
        finalText: `done:${input.prompt}`,
      };
    },
    wait: async (): Promise<WorkflowTaskResult> => notImplemented('wait'),
    snapshot: async (): Promise<WorkflowTaskSnapshot> => notImplemented('snapshot'),
    output: async (): Promise<WorkflowTaskSnapshot> => notImplemented('output'),
    send: async (): Promise<void> => notImplemented('send'),
    stop: async (): Promise<void> => notImplemented('stop'),
    parallel: async <T>(items: readonly (() => Promise<T>)[]): Promise<T[]> =>
      Promise.all(items.map((item) => item())),
    synthesize: async () => ({ text: 'synthesis' }),
    artifact: async (name): Promise<WorkflowArtifactRef> => ({ name }),
    log: () => {},
  };
  return { wf, prompts, phases, inputs };
}

describe('runRestrictedWorkflowScript', () => {
  it('stops an idle script on its owning Runtime signal without another guest RPC', async () => {
    const abort = new AbortController();
    const module = createRestrictedWorkflowModule({
      manifest: { name: 'idle-cancel', description: 'Cancel idle JS', phases: ['wait'],
        readOnly: true, maxAgents: 1, maxConcurrency: 1, patterns: ['fan-out-and-synthesize'] },
      source: 'async function run(wf) { wf.log("ready"); await new Promise(() => {}); return "done"; }',
      timeoutMs: 500,
    });
    const outcome = await runWorkflow({ runId: 'idle-cancel', args: {}, signal: abort.signal,
      backend: { spawn: async () => notImplemented('spawn'), wait: async () => notImplemented('wait'),
        output: async () => notImplemented('output'), send: async () => {}, stop: async () => {} },
      onEvent: event => { if (event.type === 'workflow_log') abort.abort(); },
    }, module.run);
    expect(outcome.ok).toBe(false);
    expect(outcome.state.status).toBe('stopped');
  });
  it('forwards compact briefing fields through the trusted host boundary', async () => {
    const { wf, inputs } = fakeWorkflowApi();
    await runRestrictedWorkflowScript({
      wf,
      source: `
        async function run(wf) {
          return wf.runAgent({
            name: 'scoped-reader',
            phase: 'review',
            prompt: 'inspect the parser',
            scopeSummary: 'parser boundary',
            constraints: ['read-only', 'preserve public API'],
            readOnly: true,
            target: {
              agentId: 'external:reviewer',
              expectedConfigurationRevision: 'reviewer-v2'
            },
            terseResult: true,
            verification: { requiredReadPaths: ['packet.md'] }
          });
        }
      `,
    });

    expect(inputs[0]).toMatchObject({
      name: 'scoped-reader',
      phase: 'review',
      scopeSummary: 'parser boundary',
      constraints: ['read-only', 'preserve public API'],
      target: {
        agentId: 'external:reviewer',
        expectedConfigurationRevision: 'reviewer-v2',
      },
      terseResult: true,
      verification: { requiredReadPaths: ['packet.md'] },
    });
  });

  it('does not arm node:vm watchdog timeouts for trusted host RPC polling', async () => {
    const { wf } = fakeWorkflowApi();
    const originalRunInContext = Script.prototype.runInContext;
    const optionsSeen: unknown[] = [];
    const spy = vi
      .spyOn(Script.prototype, 'runInContext')
      .mockImplementation(function (
        this: Script,
        context: Parameters<Script['runInContext']>[0],
        options?: Parameters<Script['runInContext']>[1],
      ): ReturnType<Script['runInContext']> {
        optionsSeen.push(options);
        const args = options === undefined ? [context] : [context, options];
        return Reflect.apply(originalRunInContext, this, args) as ReturnType<Script['runInContext']>;
      });

    try {
      await expect(
        runRestrictedWorkflowScript({
          wf,
          source: `
            async function run(wf) {
              const result = await wf.runAgent({
                name: 'reader',
                prompt: 'check rpc timeout usage',
                readOnly: true
              });
              return result.finalText;
            }
          `,
        }),
      ).resolves.toBe('done:check rpc timeout usage');
    } finally {
      spy.mockRestore();
    }

    expect(optionsSeen.length).toBeGreaterThan(2);
    expect(optionsSeen[0]).toBeUndefined();
    expect(optionsSeen[1]).toMatchObject({ timeout: DEFAULT_WORKFLOW_SCRIPT_SYNC_TIMEOUT_MS });
    expect(optionsSeen.slice(2).every((options) => options === undefined)).toBe(true);
  });

  it('runs a generated script through WorkflowApi only', async () => {
    const { wf, prompts } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf,
      args: { question: 'where is the bug?' },
      source: `
        async function run(wf, args) {
          const first = await wf.runAgent({
            name: 'reader',
            prompt: args.question,
            readOnly: true
          });
          return { text: first.finalText, remaining: wf.budget.remaining() };
        }
      `,
    });

    expect(result).toEqual({ text: 'done:where is the bug?', remaining: 100 });
    expect(prompts).toEqual(['where is the bug?']);
  });

  it('rejects reading a workflow command result before awaiting it', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            const result = wf.runAgent({ name: 'reader', prompt: 'inspect', readOnly: true });
            return result.structured;
          }
        `,
      }),
    ).rejects.toThrow(/wf\.runAgent result must be awaited before reading \.structured/);
  });

  it('rejects returning an unawaited workflow command result through JSON serialization', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return { synthesis: wf.synthesize({ inputs: 'notes', rubric: 'merge' }) };
          }
        `,
      }),
    ).rejects.toThrow(/wf\.synthesize result must be awaited before JSON serialization/);
  });

  it('keeps standard Promise combinators working for workflow command results', async () => {
    const { wf } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf,
      source: `
        async function run(wf) {
          const [first, second] = await Promise.all([
            wf.runAgent({ name: 'a', prompt: 'first', readOnly: true }),
            wf.runAgent({ name: 'b', prompt: 'second', readOnly: true })
          ]);
          return [first.finalText, second.finalText];
        }
      `,
    });

    expect(result).toEqual(['done:first', 'done:second']);
  });

  it('routes wf.workflow(name, args) through the host api (FEATURE_246 Part E)', async () => {
    const { wf } = fakeWorkflowApi();
    const calls: Array<{ name: string; args: unknown }> = [];
    const result = await runRestrictedWorkflowScript({
      wf: {
        ...wf,
        workflow: async (name: string, args: unknown) => {
          calls.push({ name, args });
          return { ran: name, got: args };
        },
      },
      source: `
        async function run(wf) {
          return wf.workflow('sub', { k: 'v' });
        }
      `,
    });
    expect(result).toEqual({ ran: 'sub', got: { k: 'v' } });
    expect(calls).toEqual([{ name: 'sub', args: { k: 'v' } }]);
  });

  it('disables Math.random / Date.now / argless new Date (FEATURE_246 Part D determinism)', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({ wf, source: `async function run() { return Math.random(); }` }),
    ).rejects.toThrow(/Math\.random\(\) is disabled/);
    await expect(
      runRestrictedWorkflowScript({ wf, source: `async function run() { return Date.now(); }` }),
    ).rejects.toThrow(/Date\.now\(\) is disabled/);
    await expect(
      runRestrictedWorkflowScript({ wf, source: `async function run() { return new Date().toISOString(); }` }),
    ).rejects.toThrow(/argless new Date\(\) is disabled/);
  });

  it('closes the globalThis.Math / globalThis.Date determinism bypass (incl. AsyncFunction)', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({ wf, source: `async function run() { return globalThis.Math.random(); }` }),
    ).rejects.toThrow(/Math\.random\(\) is disabled/);
    await expect(
      runRestrictedWorkflowScript({ wf, source: `async function run() { return globalThis.Date.now(); }` }),
    ).rejects.toThrow(/Date\.now\(\) is disabled/);
    // AsyncFunction-constructor escape reaches globalThis.Date — now the proxy.
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `async function run() { return (async function(){}).constructor('return globalThis.Date.now()')(); }`,
      }),
    ).rejects.toThrow(/disabled/);
  });

  it('closes the Date.prototype.constructor / Date.constructor determinism bypass', async () => {
    const { wf } = fakeWorkflowApi();
    // Date.prototype.constructor is the real, un-proxied Date; calling .now() on
    // it used to sidestep the guard entirely.
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `async function run() { return Date.prototype.constructor.now(); }`,
      }),
    ).rejects.toThrow(/disabled/);
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `async function run() { return Date.constructor; }`,
      }),
    ).rejects.toThrow(/disabled/);
  });

  it('still allows deterministic Math and new Date(ms) with an explicit value', async () => {
    const { wf } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf,
      args: { now: 1700000000000 },
      source: `
        async function run(wf, args) {
          return { max: Math.max(1, 9, 4), iso: new Date(args.now).toISOString() };
        }
      `,
    });
    expect(result).toEqual({ max: 9, iso: new Date(1700000000000).toISOString() });
  });

  it('sandbox wf.parallel drops a failed thunk to null and keeps siblings (FEATURE_246 Part E)', async () => {
    const { wf } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf: {
        ...wf,
        runAgent: async (input): Promise<WorkflowTaskResult> => {
          if (input.name === 'bad') throw new Error('boom');
          return { taskId: 't', name: input.name, status: 'completed', finalText: `ok:${input.name}` };
        },
      },
      source: `
        async function run(wf) {
          const results = await wf.parallel([
            () => wf.runAgent({ name: 'a', prompt: 'x' }),
            () => wf.runAgent({ name: 'bad', prompt: 'x' }),
            () => wf.runAgent({ name: 'c', prompt: 'x' }),
          ]);
          return results.map((r) => (r === null ? null : r.finalText));
        }
      `,
    });
    expect(result).toEqual(['ok:a', null, 'ok:c']);
  });

  it('sandbox wf.parallel re-throws a run-control (limit) error instead of nulling it', async () => {
    const { wf } = fakeWorkflowApi();
    const limit = Object.assign(new Error('maxConcurrency cap occupied'), { name: 'WorkflowLimitError' });
    await expect(
      runRestrictedWorkflowScript({
        wf: {
          ...wf,
          runAgent: async (): Promise<WorkflowTaskResult> => {
            throw limit;
          },
        },
        source: `
          async function run(wf) {
            return wf.parallel([() => wf.runAgent({ name: 'x', prompt: 'p' })]);
          }
        `,
      }),
    ).rejects.toThrow(/maxConcurrency/);
  });

  it('errors when wf.workflow is called but no resolver is wired', async () => {
    const { wf } = fakeWorkflowApi(); // no `workflow` method on the host api
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `async function run(wf) { return wf.workflow('sub', {}); }`,
      }),
    ).rejects.toThrow(/not available/);
  });

  it('exposes snapshot as the preferred task snapshot alias', async () => {
    const { wf } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf: {
        ...wf,
        snapshot: async (taskId): Promise<WorkflowTaskSnapshot> => ({
          taskId,
          name: 'reader',
          status: 'running',
          lastText: 'partial',
        }),
      },
      source: `
        async function run(wf) {
          const snapshot = await wf.snapshot('task-123');
          return { status: snapshot.status, lastText: snapshot.lastText };
        }
      `,
    });

    expect(result).toEqual({ status: 'running', lastText: 'partial' });
  });

  it('denies direct Node process, require, and dynamic import access', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: 'async function run() { return process.cwd(); }',
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptExecutionError);

    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: 'async function run() { return require("node:fs"); }',
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptExecutionError);

    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: 'async function run() { return await import("node:fs"); }',
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptExecutionError);
  });

  it('denies process access smuggled through globalThis[...] computed member access', async () => {
    // Regression (Space process.cwd report): the source policy strips string
    // literals before scanning, so `globalThis["process"]` evaded the `process`
    // token check and crashed at runtime with a cryptic
    // `Cannot read properties of undefined (reading 'cwd')`. Ban computed
    // globalThis[...] access so it fails LOUD at validation with a forbidden-token
    // error instead of the cryptic runtime TypeError.
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: 'async function run() { return globalThis["process"].cwd(); }',
      }),
    ).rejects.toThrow(/forbidden.*token/);
    // Dot access to determinism-guarded globals (globalThis.Math) is unaffected — bracket only.
    expect(() =>
      validateRestrictedWorkflowSource('async function run() { return globalThis.Math.max(1, 2); }'),
    ).not.toThrow(/globalThis/);
  });

  it('denies process access inside a template-literal ${...} interpolation (Space run-mr4qvtbw)', async () => {
    // Definitive Space repro: a verifier prompt template contained
    // `${process.cwd ? process.cwd() : "…"}`. The literal-stripper blanked the
    // WHOLE template — including the ${...} interpolation code — so the `process`
    // token never reached the forbidden-pattern scan; it passed validation and
    // crashed at runtime with `Cannot read properties of undefined (reading 'cwd')`.
    // Interpolations are code and must be scanned → this fails LOUD at validation.
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: 'async function run() { const scope = `at ${process.cwd()}`; return scope; }',
      }),
    ).rejects.toThrow(/forbidden.*token/);
    // A legit interpolation (plain variables) must still pass — no false positive.
    expect(() =>
      validateRestrictedWorkflowSource('async function run(wf) { const n = "m"; return `report for ${n}`; }'),
    ).not.toThrow();
  });

  it('wraps compile failures as workflow script execution errors', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: [
          'async function run() {',
          '  return "line one',
          'line two";',
          '}',
        ].join('\n'),
      }),
    ).rejects.toThrow(/restricted workflow script failed to compile/);
  });

  it('does not expose host objects through constructor-chain escapes', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return wf.constructor.constructor('return process')().versions.node;
          }
        `,
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptExecutionError);

    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run() {
            return globalThis.constructor.constructor('return process')().versions.node;
          }
        `,
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptExecutionError);
  });

  it('keeps dynamic JavaScript orchestration through wf.parallel', async () => {
    const { wf, prompts } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf,
      args: { targets: ['a', 'b', 'c'] },
      source: `
        async function run(wf, args) {
          const jobs = args.targets.map((target) => async () => {
            const result = await wf.runAgent({
              name: 'check-' + target,
              prompt: 'check ' + target,
              readOnly: true
            });
            return result.finalText;
          });
          const results = await wf.parallel(jobs, { concurrency: 2 });
          return { count: results.length, results };
        }
      `,
    });

    expect(result).toEqual({
      count: 3,
      results: ['done:check a', 'done:check b', 'done:check c'],
    });
    expect(prompts).toEqual(['check a', 'check b', 'check c']);
  });

  it('streams items through wf.pipeline find->verify stages', async () => {
    const { wf, prompts } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf,
      args: { items: ['a', 'b'] },
      source: `
        async function run(wf, args) {
          const out = await wf.pipeline(
            args.items,
            (item) => wf.runAgent({ name: 'find-' + item, prompt: 'find ' + item, readOnly: true }),
            (rev, item) => wf.runAgent({ name: 'verify-' + item, prompt: 'verify ' + rev.finalText, readOnly: true })
              .then((v) => ({ item: item, find: rev.finalText, verify: v.finalText }))
          );
          return { out: out };
        }
      `,
    });

    expect(result).toEqual({
      out: [
        { item: 'a', find: 'done:find a', verify: 'done:verify done:find a' },
        { item: 'b', find: 'done:find b', verify: 'done:verify done:find b' },
      ],
    });
    expect([...prompts].sort()).toEqual(
      ['find a', 'find b', 'verify done:find a', 'verify done:find b'].sort(),
    );
  });

  it('drops a pipeline item to null when a stage throws, keeping siblings', async () => {
    const { wf } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf,
      source: `
        async function run(wf) {
          const out = await wf.pipeline(
            ['keep', 'boom'],
            (item) => { if (item === 'boom') throw new Error('stage failed'); return item; },
            (prev) => 'ok:' + prev
          );
          return { kept: out.filter(Boolean) };
        }
      `,
    });
    expect(result).toEqual({ kept: ['ok:keep'] });
  });

  it('bridges generated phase scopes to the host runtime', async () => {
    const { wf, phases } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf,
      source: `
        async function run(wf) {
          return wf.phase('review', async () => {
            const one = await wf.runAgent({ name: 'r', prompt: 'review', readOnly: true });
            return one.finalText;
          });
        }
      `,
    });

    expect(result).toBe('done:review');
    expect(phases).toEqual(['start:review', 'finish:review']);
  });

  it('propagates host phase failures instead of swallowing them', async () => {
    const { wf } = fakeWorkflowApi();
    const failingPhaseWorkflow: WorkflowApi = {
      ...wf,
      phase: async () => {
        throw new Error('phase writer failed');
      },
    };

    await expect(
      runRestrictedWorkflowScript({
        wf: failingPhaseWorkflow,
        source: `
          async function run(wf) {
            return wf.phase('broken', async () => 'unreached');
          }
        `,
      }),
    ).rejects.toThrow(/phase writer failed/);
  });

  it('fails invalid task commands inside the script boundary', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            void wf.stop('', 'missing task id');
            return 'unreached';
          }
        `,
      }),
    ).rejects.toThrow(/taskId must be a non-empty string/);
  });

  it('coerces a bare string wf.log(...) to { message } instead of aborting the run', async () => {
    // Regression: an AMAW-authored script called `wf.log("Phase 1 …")` with a
    // plain string; the sandbox rejected it as "log input must be an object"
    // and the throw killed the whole run. log is fire-and-forget narration, so
    // a bare string is coerced to { message } rather than aborting.
    const logs: WorkflowLogEvent[] = [];
    const { wf } = fakeWorkflowApi();
    const wfWithLog: WorkflowApi = { ...wf, log: (event) => void logs.push(event) };
    const result = await runRestrictedWorkflowScript({
      wf: wfWithLog,
      source: `async function run(wf) { wf.log('Phase 1: starting'); return 'ok'; }`,
    });
    expect(result).toBe('ok');
    expect(logs).toEqual([{ message: 'Phase 1: starting' }]);
  });

  it('passes an object wf.log payload through unchanged (byte-identity for existing callers)', async () => {
    const logs: WorkflowLogEvent[] = [];
    const { wf } = fakeWorkflowApi();
    const wfWithLog: WorkflowApi = { ...wf, log: (event) => void logs.push(event) };
    const result = await runRestrictedWorkflowScript({
      wf: wfWithLog,
      source: `async function run(wf) { wf.log({ message: 'm', data: { n: 1 } }); return 'ok'; }`,
    });
    expect(result).toBe('ok');
    expect(logs).toEqual([{ message: 'm', data: { n: 1 } }]);
  });

  it('times out synchronous runaway scripts', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        timeoutMs: 10,
        source: 'async function run() { while (true) {} }',
      }),
    ).rejects.toBeInstanceOf(WorkflowScriptExecutionError);
  });

  it('does not use the sync timeout as a 10s wall-clock cap for child waits', async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date('2026-06-13T10:00:00.000Z');
      vi.setSystemTime(startedAt);
      const { wf } = fakeWorkflowApi();
      let resolveAgent: ((result: WorkflowTaskResult) => void) | undefined;
      const slowWorkflowApi: WorkflowApi = {
        ...wf,
        runAgent: async (input): Promise<WorkflowTaskResult> => {
          void input;
          return new Promise<WorkflowTaskResult>((resolve) => {
            resolveAgent = resolve;
          });
        },
      };

      const run = runRestrictedWorkflowScript({
        wf: slowWorkflowApi,
        source: `
          async function run(wf) {
            const result = await wf.runAgent({
              name: 'slow-reader',
              prompt: 'slow but valid',
              readOnly: true
            });
            return result.finalText;
          }
        `,
      });

      await vi.advanceTimersByTimeAsync(1);
      vi.setSystemTime(new Date(startedAt.getTime() + 10_050));
      await vi.advanceTimersByTimeAsync(1);
      resolveAgent?.({
        taskId: 'task-slow',
        name: 'slow-reader',
        status: 'completed',
        finalText: 'done:slow but valid',
      });
      await vi.advanceTimersByTimeAsync(1);
      await expect(run).resolves.toBe('done:slow but valid');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not apply a default total wall-clock timeout to long agent workflows', async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date('2026-06-13T10:00:00.000Z');
      vi.setSystemTime(startedAt);
      const { wf } = fakeWorkflowApi();
      let resolveAgent: ((result: WorkflowTaskResult) => void) | undefined;
      const slowWorkflowApi: WorkflowApi = {
        ...wf,
        runAgent: async (input): Promise<WorkflowTaskResult> => {
          void input;
          return new Promise<WorkflowTaskResult>((resolve) => {
            resolveAgent = resolve;
          });
        },
      };

      const run = runRestrictedWorkflowScript({
        wf: slowWorkflowApi,
        source: `
          async function run(wf) {
            const result = await wf.runAgent({
              name: 'very-slow-reader',
              prompt: 'slow but still valid',
              readOnly: true
            });
            return result.finalText;
          }
        `,
      });

      await vi.advanceTimersByTimeAsync(1);
      vi.setSystemTime(new Date(startedAt.getTime() + 31 * 60 * 1_000));
      await vi.advanceTimersByTimeAsync(1);
      resolveAgent?.({
        taskId: 'task-very-slow',
        name: 'very-slow-reader',
        status: 'completed',
        finalText: 'done:slow but still valid',
      });
      await vi.advanceTimersByTimeAsync(1);
      await expect(run).resolves.toBe('done:slow but still valid');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a runAgent call with a missing prompt instead of spawning a child', async () => {
    const { wf, prompts } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.runAgent({ name: 'reader' });
          }
        `,
      }),
    ).rejects.toThrow(/runAgent input prompt must be a non-empty string/);
    expect(prompts).toEqual([]);
  });

  it('rejects a spawnAgent call with a blank name', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.spawnAgent({ name: '   ', prompt: 'do work' });
          }
        `,
      }),
    ).rejects.toThrow(/spawnAgent input name must be a non-empty string/);
  });

  it('rejects a runAgent call whose readOnly flag is not a boolean', async () => {
    const { wf, prompts } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.runAgent({ name: 'reader', prompt: 'do work', readOnly: 'yes' });
          }
        `,
      }),
    ).rejects.toThrow(/readOnly must be a boolean/);
    expect(prompts).toEqual([]);
  });

  it('rejects malformed external targets before dispatch', async () => {
    const { wf, prompts } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.runAgent({
              name: 'reviewer',
              prompt: 'review',
              target: { agentId: '   ' }
            });
          }
        `,
      }),
    ).rejects.toThrow(/target agentId must be a non-empty string/);
    expect(prompts).toEqual([]);
  });

  it('validates runAgent verification postconditions at the script boundary', async () => {
    const { wf, prompts } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.runAgent({
              name: 'writer',
              prompt: 'write docs',
              readOnly: false,
              verification: { requiresMutation: 'yes' }
            });
          }
        `,
      }),
    ).rejects.toThrow(/verification requiresMutation must be a boolean/);
    expect(prompts).toEqual([]);

    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.runAgent({
              name: 'writer',
              prompt: 'write docs',
              readOnly: false,
              verification: { enforcement: 'loud' }
            });
          }
        `,
      }),
    ).rejects.toThrow(/verification enforcement must be "hard" or "warn"/);

    const seen: Array<unknown> = [];
    const wfWithVerifier: WorkflowApi = {
      ...wf,
      runAgent: async (input): Promise<WorkflowTaskResult> => {
        seen.push(input.verification);
        return {
          taskId: 'task-1',
          name: input.name,
          status: 'completed',
          finalText: 'done',
        };
      },
    };

    await runRestrictedWorkflowScript({
      wf: wfWithVerifier,
      source: `
        async function run(wf) {
          const result = await wf.runAgent({
            name: 'writer',
            prompt: 'write docs',
            readOnly: false,
            verification: {
              requiresMutation: true,
              enforcement: 'warn',
              requiredChangedPaths: ['docs/features/v0.1.16.md'],
              minFinalTextChars: 80,
              rejectPreparatoryFinalText: true
            }
          });
          return result.finalText;
        }
      `,
    });

    expect(seen).toEqual([{
      enforcement: 'warn',
      requiresMutation: true,
      requiredChangedPaths: ['docs/features/v0.1.16.md'],
      minFinalTextChars: 80,
      rejectPreparatoryFinalText: true,
    }]);
  });

  it('rejects a synthesize call with a missing rubric', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.synthesize({ inputs: ['a', 'b'] });
          }
        `,
      }),
    ).rejects.toThrow(/synthesize input rubric must be a non-empty string/);
  });

  it('rejects a synthesize call whose inputs are neither array, string, nor object', async () => {
    const { wf } = fakeWorkflowApi();
    await expect(
      runRestrictedWorkflowScript({
        wf,
        source: `
          async function run(wf) {
            return await wf.synthesize({ inputs: 42, rubric: 'merge' });
          }
        `,
      }),
    ).rejects.toThrow(/synthesize input inputs must be an array, string, or object/);
  });

  it('accepts a synthesize call whose inputs are a single pre-combined string', async () => {
    const { wf } = fakeWorkflowApi();
    const result = await runRestrictedWorkflowScript({
      wf,
      source: `
        async function run(wf) {
          const combined = ['## a', 'finding a', '## b', 'finding b'].join('\\n');
          const syn = await wf.synthesize({ inputs: combined, rubric: 'merge' });
          return syn.text;
        }
      `,
    });
    expect(result).toBe('synthesis');
  });
});

describe('createRestrictedWorkflowModule', () => {
  it('validates generated source before returning a runnable module', () => {
    expect(() =>
      createRestrictedWorkflowModule({
        manifest: {
          name: 'bad-generated-demo',
          description: 'demo',
          phases: ['run'],
          readOnly: true,
          maxAgents: 1,
          maxConcurrency: 1,
          patterns: ['fan-out-and-synthesize'],
        },
        source: 'function run() { return "not the generated async contract"; }',
      }),
    ).toThrow(/async function run/);
  });

  it('turns a manifest + generated source into a WorkflowModule', async () => {
    const { wf } = fakeWorkflowApi();
    const module = createRestrictedWorkflowModule({
      manifest: {
        name: 'generated-demo',
        description: 'demo',
        phases: ['run'],
        readOnly: true,
        maxAgents: 1,
        maxConcurrency: 1,
        patterns: ['fan-out-and-synthesize'],
      },
      source: 'async function run() { return "ok"; }',
    });

    expect(module.meta).toMatchObject({
      name: 'generated-demo',
      readOnly: true,
      maxAgents: 1,
      maxConcurrency: 1,
    });
    expect(await module.run(wf, {})).toBe('ok');
  });
});

describe('validateRestrictedWorkflowSource', () => {
  it('validates the wrapped restricted workflow source', () => {
    expect(() =>
      validateRestrictedWorkflowSource('async function run() { return "ok"; }', {
        requireAsyncRun: true,
      }),
    ).not.toThrow();

    expect(() =>
      validateRestrictedWorkflowSource('async function run() { return "unterminated; }', {
        requireAsyncRun: true,
      }),
    ).toThrow(/failed to compile/);
  });

  it('ignores forbidden words inside strings while rejecting real host access', () => {
    expect(() =>
      validateRestrictedWorkflowSource(
        [
          'async function run(wf) {',
          '  return await wf.runAgent({',
          '    name: "reader",',
          '    prompt: "Review Workflow Process Events and output rendering.",',
          '    readOnly: true',
          '  });',
          '}',
        ].join('\n'),
        { requireAsyncRun: true },
      ),
    ).not.toThrow();

    expect(() =>
      validateRestrictedWorkflowSource('async function run() { return process.cwd(); }', {
        requireAsyncRun: true,
      }),
    ).toThrow(/forbidden restricted workflow token: process/);
  });
});
