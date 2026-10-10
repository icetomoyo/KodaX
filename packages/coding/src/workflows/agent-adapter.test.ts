/**
 * FEATURE_217 (v0.7.49) Phase B — Coding workflow backend tests.
 *
 * Injects a fake child executor into an in-memory Actor session. No provider
 * calls run; lifecycle, mailbox, output, and interruption remain real.
 */

import { describe, expect, it, vi } from 'vitest';

import type { WorkflowTaskSummaryEventUpdate } from '@kodax-ai/agent';

import {
  createCodingWorkflowBackend,
  type WorkflowChildOptions,
} from './agent-adapter.js';
import type { ChildExecutorOptions } from '../child-executor.js';
import { CodingActorSession } from '../agent-runtime/actor-runtime.js';
import { registerConstructedAgent } from '../construction/agent-resolver.js';
import type {
  KodaXChildAgentResult,
  KodaXChildContextBundle,
  KodaXChildExecutionResult,
  KodaXToolExecutionContext,
} from '../types.js';

function execResult(
  over: Partial<KodaXChildAgentResult> = {},
  extra: Partial<KodaXChildExecutionResult> = {},
): KodaXChildExecutionResult {
  const child: KodaXChildAgentResult = {
    childId: 'c',
    fanoutClass: 'evidence-scan',
    status: 'completed',
    disposition: 'valid',
    summary: 'the answer',
    evidenceRefs: [],
    contradictions: [],
    ...over,
  };
  return {
    results: [child],
    mergedFindings: [],
    mergedArtifacts: [],
    totalTokensUsed: 0,
    cancelledChildren: [],
    ...extra,
  };
}

function fakeCtx(): KodaXToolExecutionContext {
  return actorContext().ctx;
}

function actorContext(maxConcurrentThreadsPerSession = 4): {
  readonly ctx: KodaXToolExecutionContext;
  readonly session: CodingActorSession;
} {
  const ctx = { backups: new Map<string, string>() } as KodaXToolExecutionContext;
  const session = new CodingActorSession({ maxConcurrentThreadsPerSession });
  ctx.actorHost = session;
  ctx.actorControl = session.attach(ctx, { provider: 'anthropic' });
  return { ctx, session };
}

const childOptions: WorkflowChildOptions = {
  maxIterationsPerChild: 50,
  parentRole: 'worker',
  parentHarness: 'workflow',
  parentOptions: {},
};

describe('createCodingWorkflowBackend — spawn + wait', () => {
  it('registers a zero-slot Workflow owner and leaves no ghost on global-cap rejection', async () => {
    const { ctx, session } = actorContext(4);
    ctx.actorControl = await session.createWorkflowOwner('/root', 'run-cap');
    const releases: Array<(result: KodaXChildExecutionResult) => void> = [];
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions,
      runChild: () => new Promise<KodaXChildExecutionResult>((resolve) => releases.push(resolve)),
    });

    const handles = await Promise.all([
      backend.spawn({ name: 'one', prompt: 'x', readOnly: true }),
      backend.spawn({ name: 'two', prompt: 'x', readOnly: true }),
      backend.spawn({ name: 'three', prompt: 'x', readOnly: true }),
    ]);
    await expect(backend.spawn({ name: 'four', prompt: 'x', readOnly: true }))
      .rejects.toMatchObject({ code: 'agent_limit_reached', retryable: true });

    const tree = ctx.actorControl.list();
    expect(tree.activeNonRootTurns).toBe(3);
    expect(tree.actors.filter((actor) => actor.kind === 'workflow')).toHaveLength(1);
    expect(tree.actors.filter((actor) => actor.currentTurnId !== undefined)).toHaveLength(4);
    expect(tree.actors.some((actor) => actor.taskName.includes('four'))).toBe(false);

    await vi.waitFor(() => expect(releases).toHaveLength(3));
    for (const release of releases) release(execResult());
    await Promise.all(handles.map((handle) => backend.wait(handle.taskId)));
  });

  it('spawns and maps a completed child result', async () => {
    const ctx = fakeCtx();
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'full child report',
        digest: '- Found 3 workflow UX risks.',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      }),
      generateId: () => 'task-x',
    });
    const handle = await backend.spawn({ name: 'security', prompt: 'audit', readOnly: true });
    expect(handle).toEqual({ taskId: 'task-x', name: 'security' });
    const result = await backend.wait(handle.taskId);
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('full child report');
    expect(result.digest).toBe('- Found 3 workflow UX risks.');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-5');
    expect(result.name).toBe('security');
  });

  it('throws loudly on wait/output/send/stop for an unknown task id (review A2)', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({ status: 'completed', summary: 'ok' }),
      generateId: () => 'task-known',
    });
    await backend.spawn({ name: 'a', prompt: 'p', readOnly: true });
    // Known id: no throw (in-flight output returns a running snapshot).
    await expect(backend.output('task-known')).resolves.toBeDefined();
    // Unknown id: every task-targeted method fails loudly instead of silently
    // fabricating a snapshot / dropping the message / no-op'ing the abort.
    await expect(backend.wait('task-bogus')).rejects.toThrow(/unknown workflow task: task-bogus/);
    await expect(backend.output('task-bogus')).rejects.toThrow(/unknown workflow task: task-bogus/);
    await expect(backend.send('task-bogus', 'hi')).rejects.toThrow(/unknown workflow task: task-bogus/);
    await expect(backend.stop('task-bogus')).rejects.toThrow(/unknown workflow task: task-bogus/);
  });

  it('surfaces a child structured output on the workflow result (FEATURE_246 Part B)', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'report',
        structured: { lens: 'correctness', findings: [{ severity: 'high', title: 'x' }] },
      }),
      generateId: () => 'task-s',
    });
    const handle = await backend.spawn({
      name: 'review',
      prompt: 'review',
      readOnly: true,
      outputSchema: { type: 'object', required: ['lens'], properties: { lens: { type: 'string' } } },
    });
    const result = await backend.wait(handle.taskId);
    expect(result.structured).toEqual({
      lens: 'correctness',
      findings: [{ severity: 'high', title: 'x' }],
    });
  });

  it('passes outputSchema into the child bundle (FEATURE_246 Part B)', async () => {
    let seenSchema: unknown;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async (bundles) => {
        seenSchema = bundles[0]?.outputSchema;
        return execResult({ status: 'completed', summary: 'ok' });
      },
    });
    const schema = { type: 'object', required: ['x'], properties: { x: { type: 'string' } } };
    const handle = await backend.spawn({ name: 'r', prompt: 'p', readOnly: true, outputSchema: schema });
    await backend.wait(handle.taskId);
    expect(seenSchema).toEqual(schema);
  });

  it('passes per-child effort into the bundle (FEATURE_246 Part E)', async () => {
    let seenEffort: unknown;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async (bundles) => {
        seenEffort = bundles[0]?.effort;
        return execResult({ status: 'completed', summary: 'ok' });
      },
    });
    const handle = await backend.spawn({ name: 'r', prompt: 'p', readOnly: true, effort: 'high' });
    await backend.wait(handle.taskId);
    expect(seenEffort).toBe('high');
  });

  it('passes scope summaries and binding constraints into the child bundle (FEATURE_259)', async () => {
    let seenBundle: { scopeSummary?: string; constraints?: readonly string[] } | undefined;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async (bundles) => {
        const bundle = bundles[0];
        seenBundle = {
          scopeSummary: bundle?.scopeSummary,
          constraints: bundle?.constraints,
        };
        return execResult({ status: 'completed', summary: 'ok' });
      },
    });
    const handle = await backend.spawn({
      name: 'scoped-reader',
      prompt: 'inspect parser',
      readOnly: true,
      scopeSummary: 'parser boundary',
      constraints: ['do not mutate', 'preserve API'],
    });
    await backend.wait(handle.taskId);

    expect(seenBundle).toEqual({
      scopeSummary: 'parser boundary',
      constraints: ['do not mutate', 'preserve API'],
    });
  });

  it('stamps digest-reuse provenance only for KodaX-generated workflows', async () => {
    const seen: unknown[] = [];
    for (const kodaxAuthored of [false, true]) {
      const backend = createCodingWorkflowBackend({
        ctx: fakeCtx(),
        childOptions,
        kodaxAuthored,
        runChild: async (bundles) => {
          seen.push(bundles[0]?.workflowOutputContract);
          return execResult({ status: 'completed', summary: 'full report' });
        },
      });
      const handle = await backend.spawn({
        name: 'terse',
        prompt: 'report',
        readOnly: true,
        terseResult: true,
      });
      await backend.wait(handle.taskId);
    }
    expect(seen).toEqual([undefined, { kodaxAuthored: true, terseResult: true }]);
  });

  it('preserves full finalText when a zero-token reusable digest is present', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'Full audit report with detailed evidence that remains recoverable.',
        digest: 'No regression found.',
        structured: { summary: 'No regression found.' },
      }),
    });
    const handle = await backend.spawn({ name: 'review', prompt: 'review', readOnly: true });
    const result = await backend.wait(handle.taskId);
    expect(result.finalText).toContain('Full audit report');
    expect(result.digest).toBe('No regression found.');
  });

  it('maps a failed child to status=failed', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({ status: 'failed', summary: '[Crash] boom' }),
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x', readOnly: true });
    expect((await backend.wait(handle.taskId)).status).toBe('failed');
  });

  it('does not replace a failed child diagnostic with a partial structured summary', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({
        status: 'failed',
        summary: '[Crash] parser failed',
        structured: { summary: 'looks healthy' },
      }),
      generateId: () => 'task-failed-structured',
    });
    const handle = await backend.spawn({ name: 'failed', prompt: 'run', readOnly: true });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('failed');
    expect(result.finalText).toBe('[Crash] parser failed');
  });

  it('maps a cancelled child to status=stopped', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({}, { cancelledChildren: ['task-c'] }),
      generateId: () => 'task-c',
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x', readOnly: true });
    expect((await backend.wait(handle.taskId)).status).toBe('stopped');
  });

  it('honors wait timeout and aborts the in-flight child', async () => {
    const ctx = fakeCtx();
    let seenSignal: AbortSignal | undefined;
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions,
      generateId: () => 'task-timeout',
      runChild: (_bundles, _ctx, opts) => {
        seenSignal = opts.abortSignal;
        return new Promise<KodaXChildExecutionResult>(() => {});
      },
    });

    const handle = await backend.spawn({ name: 'slow', prompt: 'x', readOnly: true });

    await expect(backend.wait(handle.taskId, { timeoutMs: 5 })).rejects.toThrow(
      /timed out after 5ms/,
    );
    expect(seenSignal?.aborted).toBe(true);
  });

  it('keeps an unbounded wait alive across the Actor polling window', async () => {
    vi.useFakeTimers();
    try {
      let resolveChild: (result: KodaXChildExecutionResult) => void = () => {};
      let seenSignal: AbortSignal | undefined;
      const backend = createCodingWorkflowBackend({
        ctx: fakeCtx(),
        childOptions,
        generateId: () => 'task-unbounded',
        runChild: (_bundles, _ctx, options) => {
          seenSignal = options.abortSignal;
          return new Promise<KodaXChildExecutionResult>((resolve) => {
            resolveChild = resolve;
          });
        },
      });
      const handle = await backend.spawn({ name: 'slow', prompt: 'x', readOnly: true });
      const outcome = backend.wait(handle.taskId).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(settled).toBe(false);
      expect(seenSignal?.aborted).toBe(false);

      resolveChild(execResult({ childId: 'task-unbounded', summary: 'done' }));
      await vi.advanceTimersByTimeAsync(0);
      await expect(outcome).resolves.toMatchObject({
        ok: true,
        result: { taskId: 'task-unbounded', status: 'completed', finalText: 'done' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles from Actor output when its terminal event was acknowledged', async () => {
    vi.useFakeTimers();
    try {
      const ctx = fakeCtx();
      const backend = createCodingWorkflowBackend({
        ctx,
        childOptions,
        generateId: () => 'task-acknowledged',
        runChild: async () => execResult({
          childId: 'task-acknowledged',
          summary: 'done from output',
        }),
      });
      const handle = await backend.spawn({ name: 'acknowledged', prompt: 'x', readOnly: true });
      await vi.advanceTimersByTimeAsync(0);
      const actor = ctx.actorControl?.list().actors.find(
        (candidate) => candidate.path === '/root/acknowledged-1',
      );
      const turnId = actor?.latestTurn?.turnId;
      expect(actor?.latestTurn?.state).toBe('completed');
      expect(turnId).toBeDefined();
      await expect(ctx.actorControl?.acknowledgeCompletions([turnId!])).resolves.toBe(1);
      expect(ctx.actorControl?.eventSnapshot().some(
        (event) => event.turnId === turnId && event.kind === 'turn_completed',
      )).toBe(false);

      const outcome = backend.wait(handle.taskId).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(outcome).resolves.toMatchObject({
        ok: true,
        result: {
          taskId: 'task-acknowledged',
          status: 'completed',
          finalText: 'done from output',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks every child as a workflow child so the self-distill digest fires (FEATURE_217)', async () => {
    let seenWorkflowChild: boolean | undefined;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      generateId: () => 'task-wf-child',
      runChild: (_bundles, _ctx, opts) => {
        seenWorkflowChild = opts.workflowChild;
        return Promise.resolve(execResult());
      },
    });

    await backend.spawn({ name: 'x', prompt: 'x', readOnly: true });
    // The backend stamps `workflowChild` regardless of parentHarness, so the
    // digest fires in production where parentHarness stays 'tool-dispatch'
    // (write children must not be dropped by validateWriteBundles).
    expect(seenWorkflowChild).toBe(true);
  });

  it('enables async digest updates when the runtime subscribes', async () => {
    let seenDigestMode: ChildExecutorOptions['workflowDigestMode'];
    let seenDigestCallback: ChildExecutorOptions['onWorkflowChildDigest'];
    const updates: Array<{
      readonly taskId: string;
      readonly update: WorkflowTaskSummaryEventUpdate;
    }> = [];
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      generateId: () => 'task-async',
      runChild: (_bundles, _ctx, opts) => {
        seenDigestMode = opts.workflowDigestMode;
        seenDigestCallback = opts.onWorkflowChildDigest;
        opts.onWorkflowChildDigest?.({
          childId: 'task-async',
          digest: '- Finding: adapter forwarded digest.',
          totalTokensUsed: 9,
        });
        return Promise.resolve(execResult({
          childId: 'task-async',
          status: 'completed',
          summary: 'full report',
          digestPending: true,
        }, { totalTokensUsed: 12 }));
      },
    });
    backend.subscribeTaskSummaryUpdates?.((taskId, update) => updates.push({ taskId, update }));

    const handle = await backend.spawn({ name: 'x', prompt: 'x', readOnly: true });
    const result = await backend.wait(handle.taskId);

    expect(seenDigestMode).toBe('async');
    expect(seenDigestCallback).toBeDefined();
    expect(result.digestPending).toBe(true);
    expect(result.digest).toBeUndefined();
    expect(updates).toEqual([
      {
        taskId: 'task-async',
        update: {
          summary: '- Finding: adapter forwarded digest.',
          summaryKind: 'digest',
          usage: { totalTokens: 9 },
        },
      },
    ]);
  });

  it('passes workflow correlation into child executor options', async () => {
    let seenCorrelation: ChildExecutorOptions['workflowCorrelation'];
    let seenChildActivityName: ChildExecutorOptions['childActivityName'];
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runId: 'run-correlation',
      generateId: () => 'task-correlation',
      runChild: (_bundles, _ctx, opts) => {
        seenCorrelation = opts.workflowCorrelation;
        seenChildActivityName = opts.childActivityName;
        return Promise.resolve(execResult({
          childId: 'task-correlation',
          status: 'completed',
          summary: 'done',
        }));
      },
    });

    const handle = await backend.spawn({ name: 'x', prompt: 'x', readOnly: true });
    await backend.wait(handle.taskId);

    expect(seenCorrelation).toEqual({
      workflowRunId: 'run-correlation',
      childAgentId: 'task-correlation',
      itemId: 'agent:task-correlation',
    });
    expect(seenChildActivityName).toBe('x');
  });

  it('uses the admitted Workflow Actor path as logical context identity across backends', async () => {
    const ctx = fakeCtx();
    const identities: string[] = [];
    const parents: Array<string | undefined> = [];
    const runChild = (
      _bundles: KodaXChildContextBundle[],
      _ctx: KodaXToolExecutionContext,
      opts: ChildExecutorOptions,
    ): Promise<KodaXChildExecutionResult> => {
      identities.push(opts.contextAgentId ?? '');
      parents.push(opts.contextParentAgentId);
      expect(opts.actorControl).toBeUndefined();
      return Promise.resolve(execResult());
    };
    const first = createCodingWorkflowBackend({
      ctx,
      childOptions,
      runId: 'identity-first',
      runChild,
    });
    const second = createCodingWorkflowBackend({
      ctx,
      childOptions,
      runId: 'identity-second',
      runChild,
    });

    const firstHandle = await first.spawn({ name: 'first', prompt: 'x', readOnly: true });
    const secondHandle = await second.spawn({ name: 'second', prompt: 'x', readOnly: true });
    await Promise.all([
      first.wait(firstHandle.taskId),
      second.wait(secondHandle.taskId),
    ]);

    expect(identities).toHaveLength(2);
    expect(new Set(identities).size).toBe(2);
    expect(identities.every((identity) => identity.startsWith('/root/'))).toBe(true);
    expect(parents.every((parent) => parent === '/root')).toBe(true);
  });

  it('passes the admitted parent-specialist capability ceiling to an actorless Workflow leaf', async () => {
    const unregister = registerConstructedAgent({
      kind: 'agent',
      name: 'workflow-reader',
      version: '1.0.0',
      createdAt: '2026-07-26T00:00:00.000Z',
      content: {
        instructions: 'Read repository evidence without mutation.',
        tools: [{ ref: 'builtin:read' }, { ref: 'builtin:spawn_agent' }],
      },
      testedAt: '2026-07-26T00:00:00.000Z',
      testReport: { passed: true, results: [] },
    });
    const ctx = { backups: new Map<string, string>() } as KodaXToolExecutionContext;
    const session = new CodingActorSession({
      executor: {
        execute: async () => ({ output: 'parent ready' }),
      },
    });
    ctx.actorHost = session;
    ctx.actorControl = session.attach(ctx, { provider: 'anthropic' });

    try {
      const parent = await ctx.actorControl.spawn({
        taskName: 'limited-parent',
        objective: 'Own a restricted Workflow.',
        kind: 'external',
        capabilities: {
          tools: ['read'],
          providers: ['deepseek'],
        },
      });
      await vi.waitFor(() => {
        expect(ctx.actorControl?.get(parent.actorPath).turns[0]?.state).toBe('completed');
      });
      ctx.actorControl = session.bindActor(parent.actorPath);

      let seenCapabilities: ChildExecutorOptions['actorCapabilities'];
      const backend = createCodingWorkflowBackend({
        ctx,
        childOptions,
        runChild: async (_bundles, _ctx, options) => {
          seenCapabilities = options.actorCapabilities;
          expect(options.actorControl).toBeUndefined();
          expect(options.actorHost).toBeUndefined();
          return execResult();
        },
      });
      const handle = await backend.spawn({
        name: 'leaf',
        prompt: 'Inspect one boundary.',
        readOnly: true,
        subagentType: 'workflow-reader',
      });
      await backend.wait(handle.taskId);

      expect(seenCapabilities).toMatchObject({
        tools: ['read'],
        providers: ['deepseek'],
        filesystem: 'read',
      });
    } finally {
      unregister();
      await session.close();
    }
  });

  it('passes readOnly + specialist + modelHint + isolation into the bundle', async () => {
    let seenBundle:
      | {
          readOnly: boolean;
          specialistName?: string;
          modelHint?: string;
          isolation?: string;
          objective: string;
        }
      | undefined;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async (bundles) => {
        const b = bundles[0]!;
        seenBundle = {
          readOnly: b.readOnly,
          specialistName: b.specialistName,
          modelHint: b.modelHint,
          isolation: b.isolation,
          objective: b.objective,
        };
        return execResult();
      },
    });
    const h = await backend.spawn({
      name: 'r', prompt: 'review sql', readOnly: true, subagentType: 'db-reviewer', modelHint: 'deep', isolation: 'worktree',
    });
    await backend.wait(h.taskId);
    expect(seenBundle).toEqual({
      readOnly: true,
      specialistName: 'db-reviewer',
      modelHint: 'deep',
      isolation: 'worktree',
      objective: 'review sql',
    });
  });

  it('defaults child readOnly from a read-only workflow manifest', async () => {
    const snapshots: readonly string[][] = [[], []];
    let index = 0;
    let seenReadOnly: boolean | undefined;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      defaultChildReadOnly: true,
      listChangedFiles: async () => snapshots[Math.min(index++, snapshots.length - 1)]!,
      runChild: async (bundles) => {
        seenReadOnly = bundles[0]?.readOnly;
        return execResult({
          status: 'completed',
          summary: 'Read-only review completed with a sufficiently detailed terminal report.',
        });
      },
    });

    const handle = await backend.spawn({ name: 'reader', prompt: 'review only' });
    const result = await backend.wait(handle.taskId);

    expect(seenReadOnly).toBe(true);
    expect(index).toBe(0);
    expect(result.status).toBe('completed');
    expect(result.verification).toBeUndefined();
  });

  it('rejects write-capable children inside a read-only workflow manifest', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      defaultChildReadOnly: true,
      runChild: async () => execResult(),
    });

    await expect(
      backend.spawn({ name: 'writer', prompt: 'write files', readOnly: false }),
    ).rejects.toThrow(/readOnly=true/);
  });

  it('uses a digest instead of preparatory last text as the workflow finalText', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'Let me create the implementation plan and start building.',
        digest: '- Implemented the requested workflow verification changes.',
      }),
    });

    const handle = await backend.spawn({ name: 'writer', prompt: 'implement', readOnly: true });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('- Implemented the requested workflow verification changes.');
  });

  it('marks an implicit write-capable child unverified when no mutation evidence is observed', async () => {
    const snapshots: readonly string[][] = [[], []];
    let index = 0;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => snapshots[Math.min(index++, snapshots.length - 1)]!,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'Implementation completed with a sufficiently detailed terminal report for the parent workflow.',
      }),
    });

    const handle = await backend.spawn({ name: 'writer', prompt: 'write files', readOnly: false });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed_unverified');
    expect(result.verification?.ok).toBe(false);
    expect(result.verification?.enforcement).toBe('warn');
    expect(result.verification?.reasons.join('\n')).toContain('expected file mutations');
    expect(result.finalText).toContain('completed without verification');
  });

  it('fails explicit mutation verification when no mutation evidence is observed', async () => {
    const snapshots: readonly string[][] = [[], []];
    let index = 0;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => snapshots[Math.min(index++, snapshots.length - 1)]!,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'Implementation completed with a detailed terminal report for the parent workflow.',
      }),
    });

    const handle = await backend.spawn({
      name: 'writer',
      prompt: 'write files',
      readOnly: false,
      verification: { requiresMutation: true },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('failed');
    expect(result.verification?.ok).toBe(false);
    expect(result.verification?.enforcement).toBe('hard');
    expect(result.verification?.reasons.join('\n')).toContain('expected file mutations');
  });

  it.each([7, 0, undefined])('repairs a hard write verification failure with repair output usage %s', async (repairOutput) => {
    let attempts = 0;
    const objectives: string[] = [];
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => [],
      runChild: async (bundles, _ctx, opts) => {
        attempts += 1;
        objectives.push(bundles[0]?.objective ?? '');
        if (attempts === 2) {
          opts.parentOptions.events?.onToolUseStart?.({
            id: 'tool-1',
            name: 'write',
            input: { path: 'docs/FEATURE_LIST.md' },
          });
          opts.parentOptions.events?.onToolResult?.({
            id: 'tool-1',
            name: 'write',
            content: 'ok',
          });
          return execResult({
            status: 'completed',
            summary: 'Updated docs/FEATURE_LIST.md with the requested feature entry.',
            routeFacts: {
              requestedTier: 'balanced',
              tierOutcome: 'selected',
              providerSource: 'tier',
              initialProvider: 'repair-provider',
              finalProvider: 'repair-provider',
              fallbackReason: 'first route unavailable',
              iterations: 3,
              inputTokens: 15,
              ...(repairOutput === undefined ? {} : { outputTokens: repairOutput }),
              cacheReadTokens: 2,
              durationMs: 150,
            },
          }, { totalTokensUsed: 30 });
        }
        return execResult({
          status: 'completed',
          summary: 'I now understand the docs. Let me set up a plan and execute.',
          routeFacts: {
            requestedTier: 'balanced',
            tierOutcome: 'inherited',
            providerSource: 'parent',
            initialProvider: 'initial-provider',
            finalProvider: 'initial-provider',
            iterations: 2,
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 1,
            durationMs: 100,
          },
        }, { totalTokensUsed: 20 });
      },
    });

    const handle = await backend.spawn({
      name: 'feature-tracker-writer',
      prompt: 'Add the feature to docs/FEATURE_LIST.md.',
      readOnly: false,
      verification: { requiresMutation: true },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed');
    expect(result.verification?.ok).toBe(true);
    expect(result.verification?.mutationToolCalls).toEqual(['write']);
    expect(attempts).toBe(2);
    expect(objectives[1]).toContain('[Workflow verification repair]');
    expect(objectives[1]).toContain('expected file mutations');
    expect(result).toMatchObject({
      initialProvider: 'initial-provider',
      finalProvider: 'repair-provider',
      fallbackReason: 'first route unavailable',
      iterations: 5,
      durationMs: 250,
      usage: {
        totalTokens: 50,
        inputTokens: 25,
        cacheReadTokens: 3,
      },
    });
    expect(result.usage?.outputTokens).toBe(repairOutput === undefined ? undefined : 5 + repairOutput);
  });

  it('stops repairing after two hard verification repair attempts', async () => {
    let attempts = 0;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => [],
      runChild: async () => {
        attempts += 1;
        return execResult({
          status: 'completed',
          summary: `Attempt ${attempts}: I will start writing the files now.`,
        });
      },
    });

    const handle = await backend.spawn({
      name: 'feature-tracker-writer',
      prompt: 'Add the feature to docs/FEATURE_LIST.md.',
      readOnly: false,
      verification: { requiresMutation: true },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('failed');
    expect(result.verification?.ok).toBe(false);
    expect(attempts).toBe(3);
    expect(result.finalText).toContain('[Workflow task verification failed]');
  });

  it('uses one wait timeout budget across verification repair attempts', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      let latestSignal: AbortSignal | undefined;
      const ctx = fakeCtx();
      const backend = createCodingWorkflowBackend({
        ctx,
        childOptions,
        generateId: () => 'task-repair-timeout',
        listChangedFiles: async () => [],
        runChild: (_bundles, _ctx, options) => {
          attempts += 1;
          latestSignal = options.abortSignal;
          return new Promise<KodaXChildExecutionResult>((resolve) => {
            setTimeout(() => {
              resolve(execResult({
                status: 'completed',
                summary: `Attempt ${attempts}: I will start writing the files now.`,
              }));
            }, 10);
          });
        },
      });

      const handle = await backend.spawn({
        name: 'feature-tracker-writer',
        prompt: 'Add the feature to docs/FEATURE_LIST.md.',
        readOnly: false,
        verification: { requiresMutation: true },
      });
      const waitPromise = backend.wait(handle.taskId, { timeoutMs: 15 });
      const waitRejection = expect(waitPromise).rejects.toThrow(/timed out after 15ms/);

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(5);

      await waitRejection;
      expect(attempts).toBe(2);
      expect(latestSignal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes a write-capable child when required changed paths appear', async () => {
    const snapshots: readonly string[][] = [[], ['docs/features/v0.1.16.md', 'docs/FEATURE_LIST.md']];
    let index = 0;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => snapshots[Math.min(index++, snapshots.length - 1)]!,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'Implemented the requested feature documentation and updated the feature list with the new version entries.',
      }),
    });

    const handle = await backend.spawn({
      name: 'feature-design-author',
      prompt: 'write feature docs',
      readOnly: false,
      verification: {
        requiresMutation: true,
        requiredChangedPaths: ['docs/features/v0.1.16.md', 'docs/FEATURE_LIST.md'],
      },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed');
    expect(result.verification?.ok).toBe(true);
    expect(result.verification?.changedPaths).toContain('docs/features/v0.1.16.md');
  });

  it('allows successful shared-cwd write tools as mutation evidence', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => [],
      runChild: async (_bundles, _ctx, opts) => {
        opts.parentOptions.events?.onToolUseStart?.({
          id: 'tool-1',
          name: 'write',
          input: { path: 'docs/features/v0.1.16.md' },
        });
        opts.parentOptions.events?.onToolResult?.({
          id: 'tool-1',
          name: 'write',
          content: 'ok',
        });
        return execResult({
          status: 'completed',
          summary: 'Wrote the requested feature design document, updated the tracked workspace target, and reported the changed files.',
        });
      },
    });

    const handle = await backend.spawn({
      name: 'writer',
      prompt: 'write docs',
      readOnly: false,
      verification: {
        requiresMutation: true,
        requiredChangedPaths: ['docs/features/v0.1.16.md'],
      },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed');
    expect(result.verification?.mutationToolCalls).toEqual(['write']);
  });

  it('accepts a review verdict only after every required packet path was read', async () => {
    const required = ['C:/tmp/packet.md', 'C:/tmp/packet.chunk.diff'];
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async (_bundles, _ctx, opts) => {
        for (const [index, targetPath] of required.entries()) {
          opts.parentOptions.events?.onToolUseStart?.({
            id: `read-${index}`,
            name: 'read',
            input: { path: targetPath },
          });
          opts.parentOptions.events?.onToolResult?.({
            id: `read-${index}`,
            name: 'read',
            content: 'packet evidence',
          });
        }
        return execResult({ status: 'completed', summary: 'verified verdict' });
      },
    });
    const handle = await backend.spawn({
      name: 'reviewer',
      prompt: 'review packet',
      readOnly: true,
      verification: { requiredReadPaths: required },
    });
    const result = await backend.wait(handle.taskId);
    expect(result.status).toBe('completed');
    expect(result.verification).toMatchObject({ ok: true, readPaths: required });
  });

  it('hard-fails a review verdict when a required packet chunk was not read', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async (_bundles, _ctx, opts) => {
        opts.parentOptions.events?.onToolUseStart?.({ id: 'read-1', name: 'read', input: { path: 'packet.md' } });
        opts.parentOptions.events?.onToolResult?.({ id: 'read-1', name: 'read', content: 'manifest' });
        return execResult({ status: 'completed', summary: 'premature approval' });
      },
    });
    const handle = await backend.spawn({
      name: 'reviewer',
      prompt: 'review packet',
      readOnly: true,
      verification: { requiredReadPaths: ['packet.md', 'missing.diff'] },
    });
    const result = await backend.wait(handle.taskId);
    expect(result.status).toBe('failed');
    expect(result.verification?.reasons).toContain('required review evidence was not read: missing.diff');
  });

  it('does not treat isolated worktree write tools as delivered workspace changes', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => [],
      runChild: async (_bundles, _ctx, opts) => {
        opts.parentOptions.events?.onToolUseStart?.({
          id: 'tool-1',
          name: 'write',
          input: { path: 'docs/features/v0.1.16.md' },
        });
        opts.parentOptions.events?.onToolResult?.({
          id: 'tool-1',
          name: 'write',
          content: 'ok',
        });
        return execResult({
          status: 'completed',
          summary: 'Wrote the requested feature design document inside the isolated workspace.',
        });
      },
    });

    const handle = await backend.spawn({
      name: 'isolated-writer',
      prompt: 'write docs',
      readOnly: false,
      isolation: 'worktree',
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed_unverified');
    expect(result.verification?.reasons.join('\n')).toContain('isolated worktree');
    expect(result.verification?.mutationToolCalls).toEqual(['write']);
  });

  it('marks an implicit read-only child unverified after reaching the iteration limit', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'Partial result after running out of iterations.',
        limitReached: true,
      }),
    });

    const handle = await backend.spawn({ name: 'limited', prompt: 'finish', readOnly: true });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed_unverified');
    expect(result.limitReached).toBe(true);
    expect(result.verification).toMatchObject({
      ok: false,
      enforcement: 'warn',
      reasons: ['workflow child reached its iteration limit before satisfying the task'],
      mutationEvidence: false,
    });
    expect(result.finalText).toContain('completed without verification');
  });

  it('keeps explicit verification as a hard failure when limitReached has no evidence', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'Partial result after running out of iterations.',
        limitReached: true,
      }),
    });

    const handle = await backend.spawn({
      name: 'limited',
      prompt: 'finish',
      readOnly: true,
      verification: { rejectPreparatoryFinalText: true },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('failed');
    expect(result.limitReached).toBe(true);
    expect(result.verification).toMatchObject({
      ok: false,
      enforcement: 'hard',
      reasons: ['workflow child reached its iteration limit before satisfying the task'],
      mutationEvidence: false,
    });
  });

  it('does not fail a write-capable child solely for short finalText when mutation evidence exists', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => [],
      runChild: async (_bundles, _ctx, opts) => {
        opts.parentOptions.events?.onToolUseStart?.({
          id: 'tool-1',
          name: 'write',
          input: { path: 'docs/features/v0.1.16.md' },
        });
        opts.parentOptions.events?.onToolResult?.({
          id: 'tool-1',
          name: 'write',
          content: 'ok',
        });
        return execResult({ status: 'completed', summary: 'Done.' });
      },
    });

    const handle = await backend.spawn({
      name: 'writer',
      prompt: 'write docs',
      readOnly: false,
      verification: {
        requiresMutation: true,
        minFinalTextChars: 80,
      },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed');
    expect(result.verification?.ok).toBe(true);
  });

  it('does not fail a write-capable child solely for limitReached when mutation evidence exists', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => [],
      runChild: async (_bundles, _ctx, opts) => {
        opts.parentOptions.events?.onToolUseStart?.({
          id: 'tool-1',
          name: 'write',
          input: { path: 'docs/features/v0.1.16.md' },
        });
        opts.parentOptions.events?.onToolResult?.({
          id: 'tool-1',
          name: 'write',
          content: 'ok',
        });
        return execResult({
          status: 'completed',
          summary: 'Partial files were written before the child hit its iteration limit.',
          limitReached: true,
        });
      },
    });

    const handle = await backend.spawn({
      name: 'writer',
      prompt: 'write docs',
      readOnly: false,
      verification: { requiresMutation: true },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed');
    expect(result.limitReached).toBe(true);
    expect(result.verification?.ok).toBe(true);
  });
});

describe('createCodingWorkflowBackend — output snapshot', () => {
  it('reports running before completion and completed after', async () => {
    const ctx = fakeCtx();
    let release: (r: KodaXChildExecutionResult) => void = () => {};
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions,
      generateId: () => 'task-o',
      runChild: () => new Promise<KodaXChildExecutionResult>((r) => { release = r; }),
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x', readOnly: true });
    const mid = await backend.output(handle.taskId);
    expect(mid.status).toBe('running');

    release(execResult({ status: 'completed', summary: 'done text' }));
    await backend.wait(handle.taskId);
    const final = await backend.output(handle.taskId);
    expect(final.status).toBe('completed');
    expect(final.lastText).toBe('done text');
  });
});

describe('createCodingWorkflowBackend — stop + send', () => {
  it('stop aborts the in-flight child signal', async () => {
    const ctx = fakeCtx();
    let seenSignal: AbortSignal | undefined;
    let release: (r: KodaXChildExecutionResult) => void = () => {};
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions,
      generateId: () => 'task-s',
      runChild: (_b, _c, opts) => {
        seenSignal = opts.abortSignal;
        return new Promise<KodaXChildExecutionResult>((r) => { release = r; });
      },
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x', readOnly: true });
    await backend.stop(handle.taskId, 'user cancel');
    expect(seenSignal?.aborted).toBe(true);
    release(execResult());
    await backend.wait(handle.taskId);
  });

  it('send delivers an internal message through the child Actor mailbox', async () => {
    const ctx = fakeCtx();
    let release: (r: KodaXChildExecutionResult) => void = () => {};
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions,
      generateId: () => 'task-m',
      runChild: () => new Promise<KodaXChildExecutionResult>((r) => { release = r; }),
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x', readOnly: true });
    await backend.send(handle.taskId, 'keep going');
    const actor = ctx.actorControl?.list().actors.find((candidate) => candidate.path !== '/root');
    expect(actor).toBeDefined();
    expect(ctx.actorControl?.get(actor?.path ?? '').mailbox).toEqual([
      expect.objectContaining({
        senderPath: '/root',
        content: 'keep going',
        classification: 'internal',
        kind: 'message',
      }),
    ]);
    release(execResult());
    await backend.wait(handle.taskId);
  });
});

// `synthesize` is no longer a backend method — it runs as a gated agent in
// the runtime (see runtime.test.ts + parallel-investigation.test.ts).
