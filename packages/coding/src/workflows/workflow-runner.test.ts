/**
 * FEATURE_217 (v0.7.49) Phase D — Headless orchestrator tests.
 *
 * Drives `runWorkflowModule` with the built-in parallel-investigation
 * workflow + a fake backend + a temp run dir. Validates the approval
 * gate, durable run-graph output, and terminal outcome shape.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InputGuardrail } from '@kodax-ai/agent';
import type {
  WorkflowAgentBackend,
  WorkflowEvent,
  WorkflowModule,
  WorkflowProcessEvent,
} from '@kodax-ai/agent/workflow';
import { WorkflowAbortError, WorkflowLimitError } from '@kodax-ai/agent/workflow';

import type { KodaXEvents, KodaXOptions, KodaXWorkflowAgentDigestEvent } from '../types.js';
import { CodingActorSession } from '../agent-runtime/actor-runtime.js';
import { parallelInvestigation } from './builtin/parallel-investigation.js';
import { buildApprovalSummary, emitWorkflowAgentDigest, runWorkflowFromOptions, runWorkflowModule } from './workflow-runner.js';

const childExecutorMock = vi.hoisted(() => ({
  calls: [] as Array<{
    readonly bundles: readonly { readonly readOnly?: boolean }[];
    readonly options: {
      readonly guardrails?: readonly unknown[];
      readonly planModeBlockCheck?: unknown;
      readonly parentOptions?: {
        readonly effort?: unknown;
        readonly repoIntelligenceMode?: unknown;
        readonly repoIntelligenceTrace?: unknown;
        readonly contextDiagnostics?: unknown;
        readonly disablePromptCache?: unknown;
      };
    };
  }>,
}));

vi.mock('../child-executor.js', () => ({
  // agent-adapter buildBundle calls this at spawn (FEATURE_246 review); the mock
  // must export it or the call resolves to undefined and every spawn throws.
  assertValidWorkflowEvidenceRefs: () => {},
  executeChildAgents: vi.fn(async (
    bundles: readonly { readonly readOnly?: boolean }[],
    _ctx: unknown,
    options: {
      readonly guardrails?: readonly unknown[];
      readonly planModeBlockCheck?: unknown;
      readonly parentOptions?: {
        readonly effort?: unknown;
        readonly repoIntelligenceMode?: unknown;
        readonly repoIntelligenceTrace?: unknown;
        readonly contextDiagnostics?: unknown;
        readonly disablePromptCache?: unknown;
      };
    },
  ) => {
    childExecutorMock.calls.push({ bundles, options });
    return {
      results: [{
        childId: 'wf-child-1',
        fanoutClass: 'evidence-scan',
        status: 'completed',
        disposition: 'valid',
        summary: 'child ok',
        evidenceRefs: [],
        contradictions: [],
      }],
      mergedFindings: [],
      mergedArtifacts: [],
      totalTokensUsed: 0,
      cancelledChildren: [],
    };
  }),
}));

function fakeBackend(): WorkflowAgentBackend {
  let n = 0;
  const names = new Map<string, string>();
  return {
    spawn: async (input) => {
      n += 1;
      const taskId = `t${n}`;
      names.set(taskId, input.name);
      return { taskId, name: input.name };
    },
    wait: async (taskId) => ({
      taskId,
      name: names.get(taskId) ?? taskId,
      status: 'completed',
      finalText: `result for ${names.get(taskId)}`,
    }),
    output: async (taskId) => ({ taskId, name: names.get(taskId) ?? taskId, status: 'completed' }),
    send: async () => {},
    stop: async () => {},
  };
}

function countingBackend(onSpawn: () => void): WorkflowAgentBackend {
  let n = 0;
  const names = new Map<string, string>();
  return {
    spawn: async (input) => {
      onSpawn();
      n += 1;
      const taskId = `t${n}`;
      names.set(taskId, input.name);
      return { taskId, name: input.name };
    },
    wait: async (taskId) => ({
      taskId,
      name: names.get(taskId) ?? taskId,
      status: 'completed',
      finalText: `result for ${names.get(taskId)}`,
    }),
    output: async (taskId) => ({ taskId, name: names.get(taskId) ?? taskId, status: 'completed' }),
    send: async () => {},
    stop: async () => {},
  };
}

describe('buildApprovalSummary', () => {
  it('reflects read-only + phases from meta', () => {
    const summary = buildApprovalSummary(parallelInvestigation);
    expect(summary.writesFiles).toBe(false);
    expect(summary.phases).toEqual(['investigate', 'synthesize']);
    expect(summary.maxAgents).toBe(8);
    expect(summary.name).toBe('parallel-investigation');
  });

  it('treats tokenBudget: 0 as unbounded (not clamped to 1)', () => {
    const base = { name: 'tb', description: 'token budget', phases: [] };
    // 0 / negative → unbounded (null in the summary), matching an omitted field.
    expect(buildApprovalSummary({ meta: { ...base, tokenBudget: 0 }, run: async () => null }).tokenBudget).toBeNull();
    expect(buildApprovalSummary({ meta: { ...base, tokenBudget: -5 }, run: async () => null }).tokenBudget).toBeNull();
    // omitted → unbounded (unchanged).
    expect(buildApprovalSummary({ meta: base, run: async () => null }).tokenBudget).toBeNull();
    // a positive value is honored (and capped at the system ceiling).
    expect(buildApprovalSummary({ meta: { ...base, tokenBudget: 50_000 }, run: async () => null }).tokenBudget).toBe(50_000);
    expect(buildApprovalSummary({ meta: { ...base, tokenBudget: 999_999_999 }, run: async () => null }).tokenBudget).toBe(200_000);
  });

  it('host-policy tokenBudget: 0 does not clamp an authored budget to 1', () => {
    const module = { meta: { name: 'tb2', description: 'x', phases: [], tokenBudget: 40_000 }, run: async () => null };
    // Host passes 0 meaning "no host ceiling" → the authored 40k survives.
    expect(buildApprovalSummary(module, { tokenBudget: 0 }).tokenBudget).toBe(40_000);
  });
});

describe('runWorkflowModule', () => {
  let dir = '';
  beforeEach(() => {
    childExecutorMock.calls.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'wf-run-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('cancels without running when approval is denied', async () => {
    const outcome = await runWorkflowModule({
      module: parallelInvestigation,
      args: { question: 'Q' },
      runId: 'run-d',
      runDir: dir,
      backend: fakeBackend(),
      approval: () => false,
    });
    expect(outcome.kind).toBe('denied');
    expect(existsSync(join(dir, 'run.json'))).toBe(false);
  });

  it('resumes from a prior run dir end-to-end: unchanged agents hit the cache (0 new spawns, same result) — FEATURE_246 Part D', async () => {
    const twoAgent: WorkflowModule<unknown, unknown> = {
      meta: { name: 'two-agent', description: 'two sequential agents', readOnly: true, maxAgents: 4, maxConcurrency: 2, phases: [] },
      run: async (wf) => {
        const a = await wf.runAgent({ name: 'a', prompt: 'PA', readOnly: true });
        const b = await wf.runAgent({ name: 'b', prompt: 'PB', readOnly: true });
        return [a?.finalText ?? null, b?.finalText ?? null];
      },
    };
    const dir1 = mkdtempSync(join(tmpdir(), 'wf-resume-1-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'wf-resume-2-'));
    try {
      // First run spawns both agents and writes its result cache under dir1.
      let spawns1 = 0;
      const o1 = await runWorkflowModule({
        module: twoAgent, args: {}, runId: 'run-1', runDir: dir1, backend: countingBackend(() => { spawns1 += 1; }),
      });
      expect(o1.kind).toBe('completed');
      expect(spawns1).toBe(2);
      expect(existsSync(join(dir1, 'results'))).toBe(true);

      // Second run resumes from dir1: both agents are content-addressed hits → 0 spawns.
      let spawns2 = 0;
      const o2 = await runWorkflowModule({
        module: twoAgent, args: {}, runId: 'run-2', runDir: dir2, backend: countingBackend(() => { spawns2 += 1; }),
        resumeFromRunDir: dir1,
      });
      expect(o2.kind).toBe('completed');
      expect(spawns2).toBe(0);
      if (o1.kind === 'completed' && o2.kind === 'completed') {
        expect(o2.result).toEqual(o1.result);
      }
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('resume re-runs only the agent whose input changed (content-addressed) — FEATURE_246 Part D', async () => {
    const mod = (promptB: string): WorkflowModule<unknown, unknown> => ({
      meta: { name: 'two-agent', description: 'two agents', readOnly: true, maxAgents: 4, maxConcurrency: 2, phases: [] },
      run: async (wf) => {
        await wf.runAgent({ name: 'a', prompt: 'PA', readOnly: true });
        await wf.runAgent({ name: 'b', prompt: promptB, readOnly: true });
        return null;
      },
    });
    const dir1 = mkdtempSync(join(tmpdir(), 'wf-resume-c1-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'wf-resume-c2-'));
    try {
      await runWorkflowModule({ module: mod('PB'), args: {}, runId: 'r1', runDir: dir1, backend: countingBackend(() => {}) });
      // Edit only agent b's prompt; a is unchanged → cache hit, b → live.
      let spawns2 = 0;
      await runWorkflowModule({
        module: mod('PB-edited'), args: {}, runId: 'r2', runDir: dir2, backend: countingBackend(() => { spawns2 += 1; }),
        resumeFromRunDir: dir1,
      });
      expect(spawns2).toBe(1);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('runs end-to-end and writes the durable run graph when approved', async () => {
    const events: string[] = [];
    const outcome = await runWorkflowModule({
      module: parallelInvestigation,
      args: { question: 'where is the bug?' },
      runId: 'run-e',
      runDir: dir,
      backend: fakeBackend(),
      approval: () => true,
      onEvent: (e) => events.push(e.type),
    });

    expect(outcome.kind).toBe('completed');
    // run.json + events.jsonl + artifacts/ all present.
    expect(existsSync(join(dir, 'run.json'))).toBe(true);
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'artifacts'))).toBe(true);

    const runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(runJson.status).toBe('completed');
    expect(runJson.workflow).toBe('parallel-investigation');
    expect(runJson.totalSpawned).toBe(4); // 3 investigators + 1 gated synthesizer
    expect(runJson.resultSummary).toEqual(expect.stringContaining('result for'));

    // Live event sink saw the same envelope.
    expect(events[0]).toBe('workflow_started');
    expect(events.at(-1)).toBe('workflow_completed');
  });

  it('emits workflow process events for SDK consumers without REPL helpers', async () => {
    const processEvents: WorkflowProcessEvent[] = [];
    const outcome = await runWorkflowModule({
      module: parallelInvestigation,
      args: { question: 'where is the bug?' },
      runId: 'run-process',
      runDir: dir,
      backend: fakeBackend(),
      processMetadata: {
        source: 'sdk',
        displayName: 'SDK audit',
        goal: 'where is the bug?',
        hostMetadata: { sessionId: 'session-1', tag: 'coder' },
      },
      onWorkflowProcessEvent: (event) => processEvents.push(event),
    });

    expect(outcome.kind).toBe('completed');
    expect(processEvents.map((event) => event.type)).toContain('workflow_started');
    expect(processEvents.find((event) => event.type === 'workflow_finished')).toMatchObject({
      type: 'workflow_finished',
      snapshot: {
        runId: 'run-process',
        workflowName: 'parallel-investigation',
        displayName: 'SDK audit',
        goal: 'where is the bug?',
        source: 'sdk',
        hostMetadata: { sessionId: 'session-1', tag: 'coder' },
        status: 'completed',
        resultSummary: expect.stringContaining('result for'),
        progress: {
          spawnedAgents: 4,
          finishedAgents: 4,
        },
      },
    });
    expect(processEvents.at(-1)).toMatchObject({
      type: 'workflow_finished',
      snapshot: {
        resultSummary: expect.stringContaining('result for'),
      },
    });
  });

  it('threads parent guardrails, plan-mode checks, and repo-intelligence config into workflow children', async () => {
    const guardrail: InputGuardrail = {
      kind: 'input',
      name: 'parent-guardrail',
      check: async () => ({ action: 'allow' }),
    };
    const planModeBlockCheck = (_tool: string, _input: Record<string, unknown>): string | null =>
      null;
    const module: WorkflowModule<unknown, string> = {
      meta: {
        name: 'guarded-workflow',
        description: 'Spawns one child',
        readOnly: true,
        phases: ['spawn'],
      },
      run: async (wf) => {
        const task = await wf.spawnAgent({ name: 'child', prompt: 'check guardrails' });
        const result = await wf.wait(task.taskId);
        return result.finalText;
      },
    };
    const options: KodaXOptions = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      modelOverride: 'claude-opus-4-8',
      effort: 'high',
      thinking: false,
      disablePromptCache: false,
      guardrails: [guardrail],
      context: {
        planModeBlockCheck,
        repoIntelligenceMode: 'off',
        repoIntelligenceTrace: true,
        contextDiagnostics: true,
      },
    };

    const outcome = await runWorkflowFromOptions({
      module,
      args: {},
      options,
      runId: 'run-guardrails',
      runDir: dir,
    });

    expect(outcome.kind).toBe('completed');
    expect(childExecutorMock.calls).toHaveLength(1);
    expect(childExecutorMock.calls[0]?.options.guardrails).toBe(options.guardrails);
    expect(childExecutorMock.calls[0]?.options.planModeBlockCheck).toBe(planModeBlockCheck);
    expect(childExecutorMock.calls[0]?.options.parentOptions?.model).toBe('claude-opus-4-8');
    expect(childExecutorMock.calls[0]?.options.parentOptions?.effort).toBe('high');
    expect(childExecutorMock.calls[0]?.options.parentOptions).toMatchObject({ thinking: false });
    expect(childExecutorMock.calls[0]?.options.parentOptions?.repoIntelligenceMode).toBe('off');
    expect(childExecutorMock.calls[0]?.options.parentOptions?.repoIntelligenceTrace).toBe(true);
    expect(childExecutorMock.calls[0]?.options.parentOptions?.contextDiagnostics).toBe(true);
    expect(childExecutorMock.calls[0]?.options.parentOptions?.disablePromptCache).toBe(false);
  });

  it('uses a read-only workflow manifest as the default for child agents', async () => {
    const module: WorkflowModule<unknown, string> = {
      meta: {
        name: 'readonly-default',
        description: 'Spawns one read-only child by default',
        readOnly: true,
        phases: ['review'],
      },
      run: async (wf) => {
        const result = await wf.runAgent({ name: 'reader', prompt: 'review' });
        return result?.finalText ?? '';
      },
    };

    const outcome = await runWorkflowFromOptions({
      module,
      args: {},
      options: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      } as KodaXOptions,
      runId: 'run-readonly-default',
      runDir: dir,
    });

    expect(outcome.kind).toBe('completed');
    expect(childExecutorMock.calls).toHaveLength(1);
    expect(childExecutorMock.calls[0]?.bundles[0]?.readOnly).toBe(true);
  });

  it('settles the zero-slot Workflow owner with a structured terminal outcome', async () => {
    const actorSession = new CodingActorSession();
    await actorSession.initialize();
    const root = actorSession.rootControl();
    const module: WorkflowModule<unknown, { readonly summary: string }> = {
      meta: {
        name: 'owner-outcome',
        description: 'Exposes a stable Workflow owner result',
        readOnly: true,
      },
      run: async (wf) => {
        await wf.runAgent({ name: 'review', prompt: 'review' });
        return { summary: 'Review complete.' };
      },
    };

    const outcome = await runWorkflowFromOptions({
      module,
      args: {},
      options: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        context: { actorControl: root, actorHost: actorSession },
      } as KodaXOptions,
      runId: 'run-owner-outcome',
      runDir: dir,
    });

    expect(outcome.kind).toBe('completed');
    expect(root.output('/root/workflow:run-owner-outcome')).toMatchObject({
      state: 'completed',
      structured: {
        runId: 'run-owner-outcome',
        status: 'completed',
        summary: 'Review complete.',
        coverage: ['review'],
        unresolved: [],
        usage: { totalSpawned: 1 },
      },
    });
    expect(root.get('/root').mailbox.filter((message) => (
      message.senderPath === '/root/workflow:run-owner-outcome'
      && message.kind === 'completion'
    ))).toHaveLength(1);
    await actorSession.close();
  });

  it('forwards each child agent completion to options.events.onWorkflowAgentDigest (ADR-049, end-to-end)', async () => {
    const digests: KodaXWorkflowAgentDigestEvent[] = [];
    const module: WorkflowModule<unknown, string> = {
      meta: {
        name: 'digest-workflow',
        description: 'Spawns one child whose completion reaches the per-agent digest hook',
        readOnly: true,
        phases: ['spawn'],
      },
      run: async (wf) => {
        const task = await wf.spawnAgent({ name: 'reviewer', prompt: 'review' });
        const result = await wf.wait(task.taskId);
        return result.finalText;
      },
    };

    const outcome = await runWorkflowFromOptions({
      module,
      args: {},
      options: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        events: { onWorkflowAgentDigest: (e) => digests.push(e) },
      } as KodaXOptions,
      runId: 'run-digest-e2e',
      runDir: dir,
    });

    expect(outcome.kind).toBe('completed');
    // The child's terminal event reached the per-agent digest hook, tagged with
    // this run's id — so the REPL can write its digest to the transcript. Only the
    // four terminal/summary types are forwarded (emitWorkflowAgentDigest's gate).
    expect(digests.length).toBeGreaterThan(0);
    expect(digests.every((d) => d.runId === 'run-digest-e2e')).toBe(true);
    expect(
      digests.every((d) =>
        d.event.type === 'agent_completed' ||
        d.event.type === 'agent_unverified' ||
        d.event.type === 'agent_failed' ||
        d.event.type === 'agent_summary_updated'),
    ).toBe(true);
  });

  it('writes stopped status for user-aborted workflow runs', async () => {
    const module: WorkflowModule = {
      meta: {
        name: 'abort-test',
        description: 'aborts',
        readOnly: true,
        phases: ['abort'],
      },
      run: async () => {
        throw new WorkflowAbortError();
      },
    };

    const outcome = await runWorkflowModule({
      module,
      args: {},
      runId: 'run-stopped',
      runDir: dir,
      backend: fakeBackend(),
      approval: () => true,
    });

    expect(outcome.kind).toBe('failed');
    expect(outcome.state.status).toBe('stopped');
    const runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { status?: unknown };
    expect(runJson.status).toBe('stopped');
  });

  it('reclaims leftover run worktrees on the terminal path (FEATURE_217 Layer 2/3)', async () => {
    const calls: string[][] = [];
    const baseDir = join(dir, 'worktrees');
    const leftover = join(baseDir, '.kodax-worktree-wf-child-1');
    const runGit = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args[0] === 'worktree' && args[1] === 'list') {
        return [
          'worktree /repo', 'HEAD a', 'branch refs/heads/main', '',
          `worktree ${leftover}`, 'HEAD b', 'branch refs/heads/kodax-wt-workflow-wf-child-1', '',
        ].join('\n');
      }
      return '';
    };

    const outcome = await runWorkflowModule({
      module: parallelInvestigation,
      args: { question: 'Q' },
      runId: 'run-wt',
      runDir: dir,
      backend: fakeBackend(),
      ctx: { backups: new Map(), gitRoot: '/repo' },
      approval: () => true,
      // Fresh mtime → Layer 3 startup prune leaves it; Layer 2 terminal sweep
      // (path-prefix, mtime-agnostic) is what reclaims it.
      worktreeSweepDeps: { runGit, now: () => 0, mtimeMs: () => 0 },
    });

    expect(outcome.kind).toBe('completed');
    const removed = calls
      .filter((c) => c[0] === 'worktree' && c[1] === 'remove')
      .map((c) => c[2]);
    expect(removed).toContain(leftover);
    // The main repo worktree is never touched.
    expect(removed).not.toContain('/repo');
    // Startup prune ran (Layer 3) in addition to the terminal sweep.
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'prune')).toBe(true);
  });

  it('writes a script snapshot when a generated workflow source is provided', async () => {
    const outcome = await runWorkflowModule({
      module: parallelInvestigation,
      args: { question: 'where is the bug?' },
      runId: 'run-s',
      runDir: dir,
      backend: fakeBackend(),
      scriptSnapshot: {
        source: 'async function run() { return "ok"; }',
        manifest: {
          name: 'generated-investigation',
          description: 'generated',
          phases: ['investigate', 'synthesize'],
          readOnly: true,
          maxAgents: 4,
          maxConcurrency: 2,
          patterns: ['fan-out-and-synthesize'],
        },
      },
    });

    expect(outcome.kind).toBe('completed');
    expect(existsSync(join(dir, 'script.js'))).toBe(true);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    const runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(runJson.scriptSnapshotPath).toBe(join(dir, 'script.js'));
    expect(runJson.manifestSnapshotPath).toBe(join(dir, 'manifest.json'));
  });

  it('auto-proceeds with no approval callback (headless)', async () => {
    const outcome = await runWorkflowModule({
      module: parallelInvestigation,
      args: { question: 'Q' },
      runId: 'run-h',
      runDir: dir,
      backend: fakeBackend(),
    });
    expect(outcome.kind).toBe('completed');
  });

  it('throws if neither backend nor ctx+childOptions provided', async () => {
    await expect(
      runWorkflowModule({
        module: parallelInvestigation,
        args: { question: 'Q' },
        runId: 'run-x',
        runDir: dir,
        approval: () => true,
      }),
    ).rejects.toThrow(/requires either a backend/);
  });

  it('clamps manifest caps to system hard limits', async () => {
    let spawns = 0;
    const backend: WorkflowAgentBackend = {
      ...fakeBackend(),
      spawn: async (input) => {
        spawns += 1;
        return { taskId: `t${spawns}`, name: input.name };
      },
    };
    const module: WorkflowModule = {
      meta: {
        name: 'runaway-generated',
        description: 'runaway',
        maxAgents: 999999,
        maxConcurrency: 999999,
      },
      run: async (wf) => {
        for (let i = 0; i < 70; i += 1) {
          await wf.runAgent({ name: `a${i}`, prompt: 'x' });
        }
      },
    };

    const outcome = await runWorkflowModule({
      module,
      args: {},
      runId: 'run-cap',
      runDir: dir,
      backend,
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toBeInstanceOf(WorkflowLimitError);
    }
    expect(spawns).toBeLessThanOrEqual(64);
  });

  it('defaults an unset concurrency to the configured cap (8), never Infinity', () => {
    // A manifest that omits maxConcurrency previously fell through to Infinity in
    // the runtime (bounded only by the 64-agent lifetime cap). It must now resolve
    // to the concurrency ceiling (default 8) so an authored script cannot fan out
    // unbounded.
    const module: WorkflowModule = {
      meta: { name: 'no-concurrency', description: 'omits maxConcurrency', maxAgents: 40 },
      run: async () => undefined,
    };
    expect(buildApprovalSummary(module).maxConcurrency).toBe(8);
  });

  it('clamps a manifest concurrency above the cap down to the cap', () => {
    const module: WorkflowModule = {
      meta: { name: 'greedy', description: 'asks for 32', maxAgents: 64, maxConcurrency: 32 },
      run: async () => undefined,
    };
    // Default cap is 8; a manifest asking for 32 is clamped down, never up.
    expect(buildApprovalSummary(module).maxConcurrency).toBe(8);
  });

  it('normalizes invalid meta caps in approval summaries', () => {
    const module: WorkflowModule = {
      meta: {
        name: 'bad-caps',
        description: 'bad caps',
        maxAgents: Number.NaN,
        maxConcurrency: 0,
        tokenBudget: -1,
      },
      run: async () => undefined,
    };

    expect(buildApprovalSummary(module)).toMatchObject({
      maxAgents: 1,
      maxConcurrency: 1,
      // tokenBudget: -1 (and 0) now means "unbounded" (null), not a 1-token cap —
      // count limits still floor at 1, but a token budget of 0/negative = no cap.
      tokenBudget: null,
    });
  });

  it('lowers approval caps with host policy ceilings', () => {
    const module: WorkflowModule = {
      meta: {
        name: 'host-capped-summary',
        description: 'host capped',
        maxAgents: 10,
        maxConcurrency: 8,
        tokenBudget: 50_000,
      },
      run: async () => undefined,
    };

    expect(buildApprovalSummary(module, {
      maxAgents: 3,
      maxConcurrency: 2,
      tokenBudget: 1_000,
    })).toMatchObject({
      maxAgents: 3,
      maxConcurrency: 2,
      tokenBudget: 1_000,
    });
  });

  it('enforces host policy ceilings at runtime', async () => {
    let spawns = 0;
    const backend: WorkflowAgentBackend = {
      ...fakeBackend(),
      spawn: async (input) => {
        spawns += 1;
        return { taskId: `t${spawns}`, name: input.name };
      },
    };
    const module: WorkflowModule = {
      meta: {
        name: 'host-capped-runtime',
        description: 'host capped runtime',
        maxAgents: 10,
        maxConcurrency: 4,
      },
      run: async (wf) => {
        await wf.runAgent({ name: 'a1', prompt: 'x' });
        await wf.runAgent({ name: 'a2', prompt: 'x' });
        await wf.runAgent({ name: 'a3', prompt: 'x' });
      },
    };

    const outcome = await runWorkflowModule({
      module,
      args: {},
      runId: 'run-host-cap',
      runDir: dir,
      backend,
      hostPolicy: { maxAgents: 2 },
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toBeInstanceOf(WorkflowLimitError);
    }
    expect(spawns).toBe(2);
  });
});

describe('emitWorkflowAgentDigest (ADR-049 per-agent digest forward)', () => {
  function captureDigests(): {
    events: KodaXEvents;
    digests: KodaXWorkflowAgentDigestEvent[];
  } {
    const digests: KodaXWorkflowAgentDigestEvent[] = [];
    return { events: { onWorkflowAgentDigest: (e) => digests.push(e) }, digests };
  }
  const evt = (type: WorkflowEvent['type'], seq = 0): WorkflowEvent => ({
    seq,
    type,
    data: { name: 'reviewer', summary: 'finding: a bug', status: 'completed' },
  });

  it('forwards each agent terminal/summary event with the run id + raw event', () => {
    const { events, digests } = captureDigests();
    for (const type of [
      'agent_completed',
      'agent_unverified',
      'agent_failed',
      'agent_summary_updated',
    ] as const) {
      emitWorkflowAgentDigest(events, 'run-digest-1', evt(type));
    }
    expect(digests).toHaveLength(4);
    expect(digests.every((d) => d.runId === 'run-digest-1')).toBe(true);
    expect(digests[0]?.event.type).toBe('agent_completed');
    expect(digests[0]?.event.data?.summary).toBe('finding: a bug');
  });

  it('ignores non-summary workflow events (no per-agent spam)', () => {
    const { events, digests } = captureDigests();
    for (const type of [
      'workflow_started',
      'phase_started',
      'agent_spawned',
      'agent_message_sent',
      'agent_stopped',
      'workflow_completed',
    ] as const) {
      emitWorkflowAgentDigest(events, 'run-digest-2', evt(type));
    }
    expect(digests).toHaveLength(0);
  });

  it('is a no-op when no onWorkflowAgentDigest hook is wired', () => {
    expect(() => emitWorkflowAgentDigest(undefined, 'run-x', evt('agent_completed'))).not.toThrow();
    expect(() => emitWorkflowAgentDigest({}, 'run-x', evt('agent_completed'))).not.toThrow();
  });
});
