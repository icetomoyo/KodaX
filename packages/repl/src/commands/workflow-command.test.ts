/**
 * FEATURE_217 (v0.7.49) Phase D.2 — /workflow command pure-helper tests.
 *
 * Covers the testable core (invocation parse, args parse, list/runs
 * formatting, approval prompt, run-graph reading). The live execution
 * path (ctx + real agents) is exercised via the headless
 * `workflow-runner` tests in @kodax-ai/coding.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createWorkflowRunManager,
  type ManagedWorkflowRun,
  type WorkflowGenerationResult,
  type WorkflowRunManager,
} from '@kodax-ai/coding';
import {
  createWorkflowCapsule,
  getAgentConfigPath,
  WorkflowScriptExecutionError,
  type WorkflowCapsuleProvenance,
  type WorkflowEvent,
  type WorkflowProcessSnapshot,
} from '@kodax-ai/agent';

import {
  parseWorkflowInvocation,
  parseWorkflowArgs,
  parseWorkflowRunsOptions,
  parseWorkflowPruneOptions,
  formatWorkflowList,
  renderApprovalPrompt,
  readWorkflowRuns,
  readWorkflowRunDetail,
  formatRunsList,
  formatManagedRunsList,
  formatWorkflowPruneCandidates,
  formatWorkflowRunSnapshot,
  isActiveManagedWorkflowRun,
  selectWorkflowPruneCandidates,
  selectDefaultWorkflowRunId,
  selectDefaultActiveWorkflowRunId,
  savedWorkflowDirs,
  formatSavedList,
  formatWorkflowAgentDigest,
  createWorkflowAgentDigestLimiter,
  formatFinalEventSummary,
  formatResult,
  createWorkflowLiveUpdateEmitter,
  buildWorkflowRevisionRequest,
  observeManagedWorkflowDone,
  isSafeWorkflowRunId,
  renderWorkflowHelp,
  resolveConfirm,
  startGeneratedWorkflowFromRequest,
  workflowCommand,
} from './workflow-command.js';
import { workflowEventSink } from './workflow-command-live.js';
import { deriveProjectKeyFromRoot } from '../interactive/project-key.js';

function writeSavedWorkflowCapsule(
  dir: string,
  name: string,
  options: {
    readonly description?: string;
    readonly source?: string;
    readonly provenance?: WorkflowCapsuleProvenance;
  } = {},
): string {
  const workflowsDir = join(dir, '.kodax', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  const path = join(workflowsDir, `${name}.workflow.json`);
  const source = options.source ?? 'async function run() { return "ok"; }';
  writeFileSync(
    path,
    JSON.stringify({
      format: 'kodax.workflow',
      version: 1,
      workflowApiVersion: 1,
      minKodaxVersion: '0.7.49',
      manifest: {
        name,
        description: options.description ?? 'saved reusable audit workflow',
        phases: ['run'],
        readOnly: true,
        maxAgents: 1,
        maxConcurrency: 1,
        patterns: ['classify-and-act'],
      },
      source,
      ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
    }),
    'utf8',
  );
  return path;
}

function readSingleWorkflowRunJson(baseDir: string): Record<string, unknown> {
  const runIds = readdirSync(baseDir).filter((name) => name.startsWith('run-'));
  expect(runIds).toHaveLength(1);
  return JSON.parse(readFileSync(join(baseDir, runIds[0]!, 'run.json'), 'utf8')) as Record<string, unknown>;
}

async function waitForFinalAssistantMessage(
  runMessages: readonly { readonly type: string; readonly final?: boolean }[],
): Promise<void> {
  await vi.waitFor(() => {
    expect(runMessages.some((event) => event.type === 'assistant' && event.final === true)).toBe(true);
  }, { timeout: 5000 });
}

function writeGeneratedRunSnapshot(baseDir: string, runId: string): void {
  const runDir = join(baseDir, runId);
  mkdirSync(runDir, { recursive: true });
  const manifest = {
    name: 'feature-217-regression-audit',
    description: '仔细审查 feature 217 的代码改动，只做问题探查',
    phases: ['discover-and-map', 'synthesize'],
    readOnly: true,
    maxAgents: 2,
    maxConcurrency: 1,
    patterns: ['fan-out-and-synthesize'],
  };
  const scriptPath = join(runDir, 'script.js');
  const manifestPath = join(runDir, 'manifest.json');
  writeFileSync(scriptPath, 'async function run() { return "完成"; }', 'utf8');
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      runId,
      workflow: manifest.name,
      status: 'completed',
      totalSpawned: 0,
      args: { request: '请检查 feature 217 的 UI 问题' },
      scriptSnapshotPath: scriptPath,
      manifestSnapshotPath: manifestPath,
      endedAt: Date.now(),
    }),
    'utf8',
  );
}

function fakeGeneratedWorkflow(): Extract<WorkflowGenerationResult, { readonly kind: 'generated' }> {
  const manifest = {
    name: 'generated-fast-audit',
    description: 'Generated workflow for fast audit',
    phases: ['investigate', 'synthesize'],
    readOnly: true,
    maxAgents: 2,
    maxConcurrency: 2,
    patterns: ['fan-out-and-synthesize'],
  } as const;
  const source = 'async function run(wf, args) { return { synthesis: String(args.request || "") }; }';
  return {
    kind: 'generated',
    manifest,
    source,
    module: {
      meta: {
        name: manifest.name,
        description: manifest.description,
        phases: manifest.phases,
        readOnly: manifest.readOnly,
        maxAgents: manifest.maxAgents,
        maxConcurrency: manifest.maxConcurrency,
      },
      run: async (_wf, args) => ({ synthesis: String((args as { request?: unknown }).request ?? '') }),
    },
    scriptSnapshot: { manifest, source },
    approvalSummary: 'Generated two-agent audit workflow.',
    rawText: '{}',
  };
}

function fakeArtifactOnlyGeneratedWorkflow(): Extract<WorkflowGenerationResult, { readonly kind: 'generated' }> {
  const manifest = {
    name: 'generated-artifact-audit',
    description: 'Generated workflow that writes an artifact-only report',
    phases: ['investigate', 'synthesize'],
    readOnly: true,
    maxAgents: 2,
    maxConcurrency: 2,
    patterns: ['fan-out-and-synthesize'],
  } as const;
  const source = 'async function run(wf) { await wf.artifact("final-report", { summary: "Artifact-only final report" }); return {}; }';
  return {
    kind: 'generated',
    manifest,
    source,
    module: {
      meta: {
        name: manifest.name,
        description: manifest.description,
        phases: manifest.phases,
        readOnly: manifest.readOnly,
        maxAgents: manifest.maxAgents,
        maxConcurrency: manifest.maxConcurrency,
      },
      run: async (wf) => {
        await wf.artifact('final-report', { summary: 'Artifact-only final report' });
        return {};
      },
    },
    scriptSnapshot: { manifest, source },
    approvalSummary: 'Generated artifact-only audit workflow.',
    rawText: '{}',
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('parseWorkflowInvocation', () => {
  it('defaults to list', () => {
    expect(parseWorkflowInvocation([]).kind).toBe('list');
    expect(parseWorkflowInvocation(['list']).kind).toBe('list');
  });
  it('detects runs', () => {
    expect(parseWorkflowInvocation(['runs']).kind).toBe('runs');
    expect(parseWorkflowInvocation(['runs', '--limit', '5'])).toEqual({
      kind: 'runs',
      rawArgs: ['--limit', '5'],
    });
  });
  it('detects help aliases', () => {
    expect(parseWorkflowInvocation(['help'])).toEqual({ kind: 'help' });
    expect(parseWorkflowInvocation(['--help'])).toEqual({ kind: 'help' });
    expect(parseWorkflowInvocation(['-h'])).toEqual({ kind: 'help' });
  });
  it('detects run-control subcommands', () => {
    expect(parseWorkflowInvocation(['show', 'run-1'])).toEqual({ kind: 'show', runId: 'run-1' });
    expect(parseWorkflowInvocation(['show', '--full', 'run-1'])).toEqual({
      kind: 'show',
      runId: 'run-1',
      full: true,
    });
    expect(parseWorkflowInvocation(['show', 'run-1', '--full'])).toEqual({
      kind: 'show',
      runId: 'run-1',
      full: true,
    });
    expect(parseWorkflowInvocation(['pause', 'run-1'])).toEqual({ kind: 'pause', runId: 'run-1' });
    expect(parseWorkflowInvocation(['resume', 'run-1'])).toEqual({ kind: 'resume', runId: 'run-1' });
    expect(parseWorkflowInvocation(['stop', 'run-1'])).toEqual({ kind: 'stop', runId: 'run-1' });
    expect(parseWorkflowInvocation(['delete', 'run-1'])).toEqual({ kind: 'delete', target: 'run-1' });
    expect(parseWorkflowInvocation(['delete', '--force', 'run-1'])).toEqual({
      kind: 'delete',
      target: 'run-1',
      force: true,
    });
    expect(parseWorkflowInvocation(['delete', 'run-1', '--force'])).toEqual({
      kind: 'delete',
      target: 'run-1',
      force: true,
    });
    expect(parseWorkflowInvocation(['delete', '--saved', 'saved-audit'])).toEqual({
      kind: 'delete',
      target: 'saved-audit',
      scope: 'saved',
    });
    expect(parseWorkflowInvocation(['delete', '--run', 'run-1'])).toEqual({
      kind: 'delete',
      target: 'run-1',
      scope: 'run',
    });
    expect(parseWorkflowInvocation(['delete', '--run', '--saved', 'same-name'])).toEqual({
      kind: 'delete',
      target: 'same-name',
      scope: 'conflict',
    });
    expect(parseWorkflowInvocation(['prune', '--dry-run'])).toEqual({ kind: 'prune', rawArgs: ['--dry-run'] });
    expect(parseWorkflowInvocation(['save', 'run-1', 'audit'])).toEqual({
      kind: 'save',
      runId: 'run-1',
      name: 'audit',
    });
    expect(parseWorkflowInvocation(['rename', 'run-1', 'Readable', 'Audit'])).toEqual({
      kind: 'rename',
      target: 'run-1',
      newName: 'Readable Audit',
    });
    expect(parseWorkflowInvocation(['revise', 'run-1', 'add', 'verification'])).toEqual({
      kind: 'revise',
      target: 'run-1',
      request: 'add verification',
    });
    expect(parseWorkflowInvocation(['revise', '--replace', 'saved-audit', 'add', 'verification'])).toEqual({
      kind: 'revise',
      target: 'saved-audit',
      request: 'add verification',
      replace: true,
    });
    expect(parseWorkflowInvocation(['revise', 'saved-audit', '--replace', 'add', 'verification'])).toEqual({
      kind: 'revise',
      target: 'saved-audit',
      request: 'add verification',
      replace: true,
    });
    expect(parseWorkflowInvocation(['rerun', 'run-1', '{"request":"请复查"}'])).toEqual({
      kind: 'rerun',
      runId: 'run-1',
      rawArgs: '{"request":"请复查"}',
    });
    expect(parseWorkflowInvocation(['create', 'compare', 'three', 'hypotheses'])).toEqual({
      kind: 'create',
      request: 'compare three hypotheses',
    });
  });
  it('treats other first tokens as a start invocation', () => {
    const inv = parseWorkflowInvocation(['parallel-investigation', 'where', 'is', 'the', 'bug']);
    expect(inv).toEqual({ kind: 'start', name: 'parallel-investigation', rawArgs: 'where is the bug' });
  });
});

describe('parseWorkflowArgs', () => {
  it('parses JSON object args', () => {
    expect(parseWorkflowArgs('{"question":"x","maxAgents":3}')).toEqual({ question: 'x', maxAgents: 3 });
  });
  it('wraps bare text as a question', () => {
    expect(parseWorkflowArgs('where is the bug')).toEqual({ question: 'where is the bug' });
  });
  it('falls back to question on malformed JSON', () => {
    expect(parseWorkflowArgs('{not json')).toEqual({ question: '{not json' });
  });
  it('returns empty object for blank', () => {
    expect(parseWorkflowArgs('   ')).toEqual({});
  });
});

describe('buildWorkflowRevisionRequest', () => {
  it('includes original manifest, source, and requested change', () => {
    const capsule = createWorkflowCapsule({
      minKodaxVersion: '0.7.49',
      manifest: {
        name: 'saved-audit',
        description: 'saved audit',
        phases: ['scan'],
        readOnly: true,
        maxAgents: 1,
        maxConcurrency: 1,
        patterns: ['classify-and-act'],
      },
      source: 'export default async function run() { return "old"; }',
    });

    const prompt = buildWorkflowRevisionRequest({
      target: 'saved-audit',
      capsule,
      changeRequest: 'add final verification',
    });

    expect(prompt).toContain('Return a complete revised workflow');
    expect(prompt).toContain('"name": "saved-audit"');
    expect(prompt).toContain('export default async function run()');
    expect(prompt).toContain('add final verification');
  });
});

describe('workflow run cleanup options', () => {
  it('parses run listing flags conservatively', () => {
    expect(parseWorkflowRunsOptions([])).toEqual({ all: false, limit: 20 });
    expect(parseWorkflowRunsOptions(['--all'])).toEqual({ all: true, limit: 20 });
    expect(parseWorkflowRunsOptions(['--limit', '3'])).toEqual({ all: false, limit: 3 });
    expect(parseWorkflowRunsOptions(['--limit', '0']).error).toContain('positive integer');
    expect(parseWorkflowRunsOptions(['--unknown']).error).toContain('unknown option');
  });

  it('parses prune flags and makes dry-run preview useful by default', () => {
    expect(parseWorkflowPruneOptions(['--dry-run'])).toEqual({ dryRun: true, keep: 50 });
    expect(parseWorkflowPruneOptions(['--keep', '2'])).toEqual({ dryRun: false, keep: 2 });
    expect(parseWorkflowPruneOptions(['--older-than', '7d'])).toEqual({
      dryRun: false,
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(parseWorkflowPruneOptions(['--older-than', '12h'])).toEqual({
      dryRun: false,
      olderThanMs: 12 * 60 * 60 * 1000,
    });
    expect(parseWorkflowPruneOptions(['--older-than', 'soon']).error).toContain('older-than');
  });
});

describe('workflow agentic presentation helpers', () => {
  it('formats child-agent completion digests from workflow events', () => {
    expect(formatWorkflowAgentDigest({
      seq: 1,
      type: 'agent_completed',
      data: {
        name: 'layout-auditor',
        status: 'completed',
        summary: 'Found one responsive layout risk.',
      },
    })).toBe([
      'Agent layout-auditor completed. Extracted summary:',
      '- Found one responsive layout risk.',
      'This is a child-agent digest; use /workflow show for the event timeline.',
    ].join('\n'));

    expect(formatWorkflowAgentDigest({
      seq: 2,
      type: 'agent_completed',
      data: {
        name: 'layout-auditor',
        status: 'failed',
        summary: 'failed output',
      },
    })).toBeUndefined();
  });

  it('waits for async child-agent digest updates instead of rendering pending excerpts', () => {
    expect(formatWorkflowAgentDigest({
      seq: 3,
      type: 'agent_completed',
      data: {
        name: 'async-auditor',
        status: 'completed',
        summary: 'Full report while the digest is still running.',
        summaryKind: 'pending',
      },
    }, 'en', 'run-async')).toBeUndefined();

    const digest = formatWorkflowAgentDigest({
      seq: 4,
      type: 'agent_summary_updated',
      data: {
        taskId: 'task-async',
        name: 'async-auditor',
        summary: '- Finding: async digest arrived after child completion.',
        summaryKind: 'digest',
      },
    }, 'en', 'run-async');

    expect(digest).toContain('Agent async-auditor completed. Summary:');
    expect(digest).not.toContain('Extracted summary');
    expect(digest).toContain('async digest arrived after child completion');
    expect(digest).toContain('/workflow show run-async');
  });

  it('emits late async child-agent digests even when the raw workflow event is silent', () => {
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    type WorkflowRunMessage = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunMessage']>>[0];
    const messages: WorkflowRunMessage[] = [];
    const sink = workflowEventSink(
      { onWorkflowRunMessage: (event) => messages.push(event) },
      undefined,
      { presentation: 'agentic', locale: 'en', runId: 'run-async' },
    );

    sink({
      seq: 4,
      type: 'agent_summary_updated',
      data: {
        taskId: 'task-async',
        name: 'async-auditor',
        summary: '- Finding: late digest reached the transcript.',
        summaryKind: 'digest',
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'assistant',
      final: false,
    });
    expect(messages[0]?.text).toContain('Agent async-auditor completed. Summary:');
    expect(messages[0]?.text).toContain('late digest reached the transcript');
    expect(messages[0]?.text).not.toContain('Extracted summary');
  });

  it('suppresses child-agent digests after the workflow terminal event', () => {
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    type WorkflowRunMessage = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunMessage']>>[0];
    const messages: WorkflowRunMessage[] = [];
    const sink = workflowEventSink(
      { onWorkflowRunMessage: (event) => messages.push(event) },
      undefined,
      { presentation: 'agentic', locale: 'en', runId: 'run-complete' },
    );

    sink({
      seq: 1,
      type: 'workflow_completed',
      data: { resultSummary: 'done' },
    });
    sink({
      seq: 2,
      type: 'agent_summary_updated',
      data: {
        taskId: 'task-late',
        name: 'late-summarizer',
        summary: '- Finding: this should not appear after final output.',
        summaryKind: 'digest',
      },
    });

    expect(messages.filter((message) => message.type === 'assistant')).toEqual([]);
  });

  it('emits a bounded fallback child-agent summary when the async digest fails', () => {
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    type WorkflowRunMessage = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunMessage']>>[0];
    const messages: WorkflowRunMessage[] = [];
    const sink = workflowEventSink(
      { onWorkflowRunMessage: (event) => messages.push(event) },
      undefined,
      { presentation: 'agentic', locale: 'en', runId: 'run-digest-failed' },
    );

    sink({
      seq: 3,
      type: 'agent_summary_updated',
      data: {
        taskId: 'task-digest-failed',
        name: 'digest-failed-child',
        summary: 'Fallback report with evidence while digest is unavailable.',
        summaryKind: 'digest-failed',
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'assistant',
      final: false,
    });
    expect(messages[0]?.text).toContain('Agent digest-failed-child completed (smart summary unavailable; local excerpt):');
    expect(messages[0]?.text).toContain('Fallback report with evidence');
  });

  it('labels the excerpt as smart-summary-unavailable when the digest attempt failed (FEATURE_217 risk 2)', () => {
    const out = formatWorkflowAgentDigest({
      seq: 3,
      type: 'agent_completed',
      data: {
        name: 'layout-auditor',
        status: 'completed',
        summary: 'Found one responsive layout risk worth tracking.',
        summaryKind: 'digest-failed',
      },
    }, 'en');
    expect(out).toContain('smart summary unavailable');
    expect(out).toContain('Found one responsive layout risk');

    const zh = formatWorkflowAgentDigest({
      seq: 4,
      type: 'agent_completed',
      data: {
        name: 'layout-auditor',
        status: 'completed',
        summary: '发现一个值得跟踪的响应式布局风险点。',
        summaryKind: 'digest-failed',
      },
    }, 'zh');
    expect(zh).toContain('智能摘要不可用');
  });

  it('emits every child-agent digest because each digest is already bounded', () => {
    const digest = createWorkflowAgentDigestLimiter('run-digests');
    const event = (name: string) => ({
      seq: 1,
      type: 'agent_completed' as const,
      data: {
        name,
        status: 'completed',
        summary: `Finding: ${name} completed a useful bounded review.`,
      },
    });

    expect(digest(event('a'), 'en')).toContain('Agent a completed. Extracted summary:');
    expect(digest(event('b'), 'en')).toContain('Agent b completed. Extracted summary:');
    expect(digest(event('c'), 'en')).toContain('Agent c completed. Extracted summary:');
    expect(digest(event('d'), 'en')).toContain('Agent d completed. Extracted summary:');
  });

  it('keeps fallback final event summaries complete when requested', () => {
    const longSummary = `fallback start\n${'detail '.repeat(1200)}\nfallback end`;
    const event: WorkflowEvent = {
      seq: 9,
      type: 'agent_completed',
      data: {
        name: 'synthesize',
        status: 'completed',
        summary: longSummary,
      },
    };

    const summary = formatFinalEventSummary([event], { full: true });

    expect(summary).toContain('fallback start');
    expect(summary).toContain('fallback end');
    expect(summary).not.toContain('[truncated]');
  });

  it('summarizes long or mismatched child-agent reports with useful localized excerpts', () => {
    const longEnglishReport = [
      'I now have comprehensive evidence across the state machine, durable persistence, concurrency, and UI-state layers.',
      'Here is a long markdown report that should not be copied into the conversational transcript as a half-truncated assistant reply.',
      '## Details',
      'Finding: runtime events should carry enough child output to extract useful digest details.',
      'Evidence: a report preamble can hide the actionable lines after the old 360 character cap.',
      'Risk: users see report headers instead of real workflow progress.',
      'The complete report belongs in the workflow run timeline and final synthesis rather than the live chat stream.',
    ].join('\n\n');

    const digest = formatWorkflowAgentDigest({
      seq: 3,
      type: 'agent_completed',
      data: {
        name: 'state-data-integrity-analyzer',
        status: 'completed',
        summary: longEnglishReport,
      },
    }, 'zh', 'run-fold');

    expect(digest).toContain('Finding: runtime events should carry enough child output');
    expect(digest).toContain('Evidence: a report preamble can hide');
    expect(digest).toContain('Risk: users see report headers');
    expect(digest).toContain('子 Agent state-data-integrity-analyzer 已完成。摘录摘要：');
    expect(digest).not.toContain('智能摘要');
    expect(digest).toContain('/workflow show run-fold');
    expect(digest).toContain('运行事件时间线');
    expect(digest).not.toContain('完整内容');
    expect(digest).not.toContain('I now have comprehensive evidence');
    expect(digest).not.toContain('Here is a long markdown report');
  });

  it('filters legacy workflow handoff marker fragments in fallback excerpts', () => {
    const report = [
      'I now have a complete picture of the files.',
      'Here is my comprehensive report.',
      '[workflow handoff]',
      'Conclusion: token budget accounting is missing from the adapter.',
      'Evidence: packages/coding/src/workflows/agent-adapter.ts returns zero usage.',
      'Next: verify runtime budget tests against real child usage.',
      '[/workflow handoff]',
      '# Full report',
      'Long details follow.',
    ].join('\n');

    const digest = formatWorkflowAgentDigest({
      seq: 4,
      type: 'agent_completed',
      data: {
        name: 'budget-reviewer',
        status: 'completed',
        summary: report,
      },
    }, 'en', 'run-legacy-marker');

    expect(digest).toContain('Conclusion: token budget accounting is missing');
    expect(digest).toContain('Evidence: packages/coding/src/workflows/agent-adapter.ts');
    expect(digest).not.toContain('[workflow handoff]');
    expect(digest).not.toContain('[/workflow handoff]');
    expect(digest).not.toContain('I now have a complete picture');
    expect(digest).not.toContain('Here is my comprehensive report');
  });

  it('labels self-distilled workflow digests as summaries, not extracted summaries', () => {
    const digest = formatWorkflowAgentDigest({
      seq: 4,
      type: 'agent_completed',
      data: {
        name: 'overview-scout',
        summaryKind: 'digest',
        status: 'completed',
        summary: [
          '- 结论：feature 217 的主要风险集中在 workflow 展示链路和 stop 状态映射。',
          '- 证据：runtime 已产出 handoff，但旧摘要只保留报告开头。',
          '- 下一步：优先保证 handoff 进入 agent_completed.summary。',
        ].join('\n'),
      },
    }, 'zh', 'run-digest');

    expect(digest).toContain('子 Agent overview-scout 已完成。摘要：');
    expect(digest).not.toContain('摘录摘要');
    expect(digest).not.toContain('[workflow handoff]');
  });

  it('does not ellipsize valid self-distilled digest lines', () => {
    const longFinding = [
      '发现：用户掌控感的主要缺口不是缺少 run id，而是子 Agent 从启动到完成之间没有可解释的中间反馈，',
      '因此用户只能看到 live surface 的名称变化，却无法判断当前工作是否仍在推进、是否卡住、是否已经产出可验证结论。',
    ].join('');
    const digest = formatWorkflowAgentDigest({
      seq: 4,
      type: 'agent_completed',
      data: {
        name: 'control-sense-reviewer',
        summaryKind: 'digest',
        status: 'completed',
        summary: [
          `- ${longFinding}`,
          '- 证据：agent_completed 之前只有 spawn/phase 事件，缺少 agent_progress 或工具快照摘要。',
        ].join('\n'),
      },
    }, 'zh', 'run-long-digest');

    expect(digest).toContain('子 Agent control-sense-reviewer 已完成。摘要：');
    expect(digest).toContain(longFinding);
    expect(digest).not.toContain('...');
  });

  it('falls back to extracted summaries when legacy marker content is not useful', () => {
    const report = [
      '[workflow handoff]',
      'Here is my report.',
      '[/workflow handoff]',
      'Finding: workflow show is an event timeline, not a child transcript viewer.',
      'Evidence: readWorkflowRunDetail only formats events and artifacts.',
      'Risk: telling users to open show for full child output is misleading.',
    ].join('\n');

    const digest = formatWorkflowAgentDigest({
      seq: 4,
      type: 'agent_completed',
      data: {
        name: 'legacy-marker-quality-checker',
        status: 'completed',
        summary: report,
      },
    }, 'en', 'run-marker-fallback');

    expect(digest).toContain('Agent legacy-marker-quality-checker completed. Extracted summary:');
    expect(digest).toContain('Finding: workflow show is an event timeline');
    expect(digest).toContain('Evidence: readWorkflowRunDetail');
    expect(digest).toContain('Risk: telling users');
    expect(digest).not.toContain('Intelligent summary');
    expect(digest).not.toContain('Here is my report');
  });

  it('does not show collapsed legacy workflow marker fragments as a digest line', () => {
    const digest = formatWorkflowAgentDigest({
      seq: 4,
      type: 'agent_completed',
      data: {
        name: 'legacy-marker-fragment',
        status: 'completed',
        summary: [
          '- [workflow handoff]...[/workflow handoff]',
          '- Finding: users need a real digest, not marker text.',
          '- Evidence: collapsed marker fragments used to leak into chat.',
        ].join('\n'),
      },
    }, 'en', 'run-marker-fragment');

    expect(digest).toContain('Finding: users need a real digest');
    expect(digest).toContain('Evidence: collapsed marker fragments');
    expect(digest).not.toContain('[workflow handoff]');
  });

  it('skips low-information report openers when falling back to local extraction', () => {
    const report = [
      'I now have a comprehensive picture of all changed files.',
      'Let me compile my findings into a systematic report.',
      '# FEATURE_217 Review Report',
      'Scope: reviewed workflow runtime and REPL presentation files.',
      'Confirmed issue: child digest extraction is using report headers instead of findings.',
      'Evidence: workflow-command.ts reads the first non-empty lines from finalText.',
      'Risk: users see mechanical progress instead of useful intermediate results.',
    ].join('\n\n');

    const digest = formatWorkflowAgentDigest({
      seq: 5,
      type: 'agent_completed',
      data: {
        name: 'presentation-reviewer',
        status: 'completed',
        summary: report,
      },
    }, 'en', 'run-fallback');

    expect(digest).toContain('Confirmed issue: child digest extraction');
    expect(digest).toContain('Evidence: workflow-command.ts');
    expect(digest).toContain('Risk: users see mechanical progress');
    expect(digest).toContain('Agent presentation-reviewer completed. Extracted summary:');
    expect(digest).not.toContain('Intelligent summary');
    expect(digest).not.toContain('I now have a comprehensive picture');
    expect(digest).not.toContain('Let me compile my findings');
    expect(digest).not.toContain('FEATURE_217 Review Report');
  });

  it('keeps extracted child-agent summaries bounded to four useful lines', () => {
    const report = [
      'Finding: first concrete issue.',
      'Evidence: first source pointer.',
      'Risk: first user-visible regression.',
      'Next: verify with a focused test.',
      'Decision: this fifth line should stay out of the digest.',
    ].join('\n');

    const digest = formatWorkflowAgentDigest({
      seq: 5,
      type: 'agent_completed',
      data: {
        name: 'bounded-reviewer',
        status: 'completed',
        summary: report,
      },
    }, 'en', 'run-bounded');

    expect(digest).toContain('Finding: first concrete issue');
    expect(digest).toContain('Evidence: first source pointer');
    expect(digest).toContain('Risk: first user-visible regression');
    expect(digest).toContain('Next: verify with a focused test');
    expect(digest).not.toContain('Decision: this fifth line');
  });

  it('does not pretend low-information child output is an extracted summary', () => {
    const digest = formatWorkflowAgentDigest({
      seq: 5,
      type: 'agent_completed',
      data: {
        name: 'empty-reviewer',
        status: 'completed',
        summary: 'Here is my report.',
      },
    }, 'en', 'run-empty');

    expect(digest).toContain('Agent empty-reviewer completed. No useful summary could be extracted.');
    expect(digest).toContain('/workflow show run-empty');
    expect(digest).not.toContain('Extracted summary');
    expect(digest).not.toContain('Here is my report');
  });

  it('treats a stopped managed workflow abort as a stopped run instead of an error', async () => {
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    type WorkflowRunMessage = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunMessage']>>[0];
    const messages: WorkflowRunMessage[] = [];
    const terminalStatuses: string[] = [];
    const managed: ManagedWorkflowRun = {
      runId: 'run-stop',
      getSnapshot: () => ({
        runId: 'run-stop',
        workflow: 'stop-test',
        status: 'stopped',
        runDir: '/tmp/run-stop',
        totalSpawned: 1,
        eventCount: 3,
        startedAt: 1,
        endedAt: 2,
      }),
      done: Promise.resolve({
        kind: 'failed',
        error: new Error('Workflow aborted'),
        state: {
          runId: 'run-stop',
          status: 'failed',
          totalSpawned: 1,
          events: [],
          artifacts: [],
        },
      }),
    };

    observeManagedWorkflowDone(
      managed,
      { onWorkflowRunMessage: (event) => messages.push(event) },
      'run-stop',
      {
        onEvent: () => undefined,
        running: () => undefined,
        complete: (status) => {
          terminalStatuses.push(status);
        },
      },
    );

    await managed.done;
    await Promise.resolve();

    expect(terminalStatuses).toEqual(['stopped']);
    expect(messages.some((event) => event.type === 'error')).toBe(false);
  });

  it('includes completed child partial results when a managed workflow fails later', async () => {
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    type WorkflowRunMessage = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunMessage']>>[0];
    const messages: WorkflowRunMessage[] = [];
    const managed: ManagedWorkflowRun = {
      runId: 'run-partial-failed',
      done: Promise.resolve({
        kind: 'failed',
        error: new Error('unknown workflow task: changelog-extractor'),
        state: {
          runId: 'run-partial-failed',
          status: 'failed',
          totalSpawned: 2,
          events: [
            {
              seq: 1,
              type: 'agent_completed',
              data: {
                taskId: 'wf-child-1',
                name: 'changelog-extractor',
                status: 'completed',
                summary: 'Found release notes gap and SDK migration follow-up.',
              },
            },
          ],
          artifacts: [],
        },
      }),
    };

    observeManagedWorkflowDone(
      managed,
      { onWorkflowRunMessage: (event) => messages.push(event) },
      'run-partial-failed',
      undefined,
      { canRerun: true, presentation: 'agentic' },
    );

    await managed.done;
    await Promise.resolve();

    const errorText = messages.find((event) => event.type === 'error')?.text ?? '';
    const assistantText = messages.find((event) => event.type === 'assistant' && event.final === true)?.text ?? '';
    expect(errorText).toContain('Workflow failed (run-partial-failed): unknown workflow task: changelog-extractor');
    expect(errorText).toContain('/workflow show run-partial-failed');
    expect(errorText).not.toContain('Partial results before failure:');
    expect(assistantText).toContain('Workflow failed (run-partial-failed): unknown workflow task: changelog-extractor');
    expect(assistantText).toContain('Partial results before failure:');
    expect(assistantText).toContain('Found release notes gap and SDK migration follow-up.');
    expect(assistantText).toContain('/workflow revise run-partial-failed');
    expect(assistantText).toContain('/workflow rerun run-partial-failed');
  });

  it('does not treat Chinese report titles or markdown table headers as a digest', () => {
    const report = [
      '# FEATURE_217 变更地图 — Dynamic Workflow Harness Runtime',
      'FEATURE_217 的改动分布在**两个来源**，均属本 feature：',
      '| 层 | 来源 | 规模 | 性质 |',
      '| --- | --- | --- | --- |',
      '| agent runtime | packages/agent/src/workflow/runtime.ts | +180/-20 | 新增 workflow runtime 和事件模型 |',
      '| coding workflow | packages/coding/src/workflows/generator.ts | +220/-40 | 生成器 prompt 与 capsule 接入 |',
      '## 关键发现',
      '- 运行时和 REPL 展示路径耦合在 agent_completed.summary 上，需要保证 bounded finalText。',
      '- saved rerun 复用旧脚本，因此可能缺少结构化 digest。',
      '- fallback 摘要必须跳过结构性标题和表格，保留真实发现。',
    ].join('\n');

    const digest = formatWorkflowAgentDigest({
      seq: 6,
      type: 'agent_completed',
      data: {
        name: 'change-mapper',
        status: 'completed',
        summary: report,
      },
    }, 'zh', 'run-cn');

    expect(digest).toContain('运行时和 REPL 展示路径耦合');
    expect(digest).toContain('saved rerun 复用旧脚本');
    expect(digest).toContain('fallback 摘要必须跳过结构性标题和表格');
    expect(digest).not.toContain('FEATURE_217 变更地图');
    expect(digest).not.toContain('| 层 | 来源 | 规模 | 性质 |');
    expect(digest).not.toContain('agent runtime | packages/agent');
  });
});

describe('formatResult', () => {
  it('renders strings and known result keys directly', () => {
    expect(formatResult('hello')).toBe('hello');
    expect(formatResult({ synthesis: 'done' })).toBe('done');
    expect(formatResult({ synthesis: { text: 'nested' } })).toBe('nested');
    expect(formatResult({ summary: 'sum' })).toBe('sum');
  });

  it('renders an unrecognized non-empty object/array as JSON so it stays visible (FEATURE_217)', () => {
    // Keeps the build-time source lint and runtime formatter in agreement:
    // a non-trivial run() return must produce a visible answer, not a silent
    // content-free completion.
    const obj = formatResult({ findings: ['a'], recommendations: ['b'] });
    expect(obj).toContain('findings');
    expect(obj).toContain('a');
    const arr = formatResult([{ point: 'x' }]);
    expect(arr).toContain('point');
  });

  it('treats truly empty / nullish returns as no displayable result', () => {
    expect(formatResult(undefined)).toBeUndefined();
    expect(formatResult(null)).toBeUndefined();
    expect(formatResult({})).toBeUndefined();
    expect(formatResult([])).toBeUndefined();
    expect(formatResult('')).toBeUndefined();
  });
});

describe('formatWorkflowList', () => {
  it('lists names + descriptions', () => {
    const out = formatWorkflowList([{ name: 'demo', description: 'a demo' }]);
    expect(out).toContain('demo');
    expect(out).toContain('a demo');
  });
  it('handles empty', () => {
    expect(formatWorkflowList([])).toContain('no built-in');
  });
});

describe('renderApprovalPrompt', () => {
  it('shows read-only + phases + caps', () => {
    const text = renderApprovalPrompt({
      name: 'parallel-investigation',
      description: 'fan out',
      phases: ['investigate', 'synthesize'],
      maxAgents: 8,
      maxConcurrency: 4,
      tokenBudget: null,
      writesFiles: false,
    });
    expect(text).toContain('parallel-investigation');
    expect(text).toContain('investigate → synthesize');
    expect(text).toContain('agent total cap: 8');
    expect(text).toContain('token budget: ∞');
    expect(text).toContain('read-only');
  });

  it('shows planned agents separately from the safety cap', () => {
    const text = renderApprovalPrompt({
      name: 'planned-investigation',
      description: 'fan out with a known plan',
      phases: ['inspect', 'synthesize'],
      plannedAgents: 7,
      maxAgents: 14,
      maxConcurrency: 3,
      tokenBudget: null,
      writesFiles: false,
    });

    expect(text).toContain('planned agents: 7');
    expect(text).toContain('agent safety cap: 14');
  });

  it('shows source, sandbox, and worktree context when provided', () => {
    const text = renderApprovalPrompt(
      {
        name: 'generated',
        description: 'generated workflow',
        phases: ['run'],
        maxAgents: 2,
        maxConcurrency: 1,
        tokenBudget: 1000,
        writesFiles: true,
      },
      {
        source: 'generated',
        sandbox: 'capability-generated',
        mayUseWorktree: true,
        rawScript: 'async function run() { return "ok"; }',
      },
    );
    expect(text).toContain('source: generated');
    expect(text).toContain('sandbox/trust: capability-generated');
    expect(text).toContain('worktree isolation: may request worktree');
    expect(text).toContain('raw script:');
    expect(text).toContain('raw script preview:');
    expect(text).toContain('async function run()');
  });

  it('uses source paths instead of inline previews when a raw script path exists', () => {
    const rawScript = Array.from({ length: 80 }, (_, i) => `const line${i} = ${i};`).join('\n');
    const text = renderApprovalPrompt(
      {
        name: 'generated-long',
        description: 'long generated workflow',
        phases: ['plan', 'run'],
        maxAgents: 4,
        maxConcurrency: 2,
        tokenBudget: null,
        writesFiles: false,
      },
      {
        source: 'run:run-long',
        sandbox: 'capability-generated',
        mayUseWorktree: false,
        rawScriptPath: 'C:\\runs\\run-long\\script.js',
        rawScript,
      },
    );

    expect(text).toContain('raw script: C:\\runs\\run-long\\script.js');
    expect(text).not.toContain('raw script preview:');
    expect(text).not.toContain('const line0 = 0;');
    expect(text).not.toContain('const line79 = 79;');
  });
});

describe('readWorkflowRuns + formatRunsList', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-runs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRun(runId: string, data: Record<string, unknown>): void {
    const runDir = join(dir, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(data), 'utf8');
  }

  it('returns empty for a missing dir', () => {
    expect(readWorkflowRuns(join(dir, 'nope'))).toEqual([]);
  });

  it('reads run.json files and sorts by endedAt desc', () => {
    writeRun('run-a', { runId: 'run-a', workflow: 'wf', status: 'completed', totalSpawned: 3, endedAt: 100 });
    writeRun('run-b', { runId: 'run-b', workflow: 'wf', status: 'failed', totalSpawned: 1, endedAt: 200 });
    const runs = readWorkflowRuns(dir);
    expect(runs.map((r) => r.runId)).toEqual(['run-b', 'run-a']);
    expect(runs[0]!.status).toBe('failed');
  });

  it('uses the storage directory name as the authoritative run id', () => {
    writeRun('run-safe', {
      runId: '../../outside',
      workflow: 'wf',
      status: 'completed',
      totalSpawned: 1,
      endedAt: 100,
    });

    const runs = readWorkflowRuns(dir);
    const detail = readWorkflowRunDetail(dir, 'run-safe');

    expect(runs.map((run) => run.runId)).toEqual(['run-safe']);
    expect(detail?.runId).toBe('run-safe');
  });

  it('skips malformed run.json', () => {
    const runDir = join(dir, 'run-bad');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), '{not json', 'utf8');
    expect(readWorkflowRuns(dir)).toEqual([]);
  });

  it('formats runs list', () => {
    const out = formatRunsList([
      { runId: 'r1', workflow: 'wf', status: 'completed', totalSpawned: 2, endedAt: 1 },
    ]);
    expect(out).toContain('wf');
    expect(out).toContain('r1');
    expect(out).toContain('2 agents');
  });

  it('formats workflow process metadata when snapshots are available', () => {
    const snapshot: WorkflowProcessSnapshot = {
      runId: 'r1',
      workflowName: 'wf',
      displayName: 'Customer audit',
      status: 'completed',
      startedAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:01.000Z',
      source: 'sdk',
      savedWorkflowName: 'audit.saved',
      revisionOf: 'audit.base',
      items: [],
      counts: {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        skipped: 0,
      },
      progress: {
        spawnedAgents: 0,
        finishedAgents: 0,
        activeAgents: 0,
        failedAgents: 0,
        stoppedAgents: 0,
      },
    };
    const out = formatRunsList([
      { runId: 'r1', workflow: 'wf', status: 'completed', totalSpawned: 2, endedAt: 1 },
    ], { processSnapshots: new Map([['r1', snapshot]]) });

    expect(out).toContain('display: Customer audit');
    expect(out).toContain('source: sdk');
    expect(out).toContain('saved: audit.saved');
    expect(out).toContain('revision of: audit.base');
  });

  it('limits persisted runs output with a clear hint', () => {
    const out = formatRunsList([
      { runId: 'r3', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: 3 },
      { runId: 'r2', workflow: 'wf', status: 'failed', totalSpawned: 1, endedAt: 2 },
      { runId: 'r1', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: 1 },
    ], { limit: 2, showLimitHint: true });

    expect(out).toContain('r3');
    expect(out).toContain('r2');
    expect(out).not.toContain('r1');
    expect(out).toContain('Showing 2 of 3 persisted runs');
  });

  it('selects prune candidates from terminal runs only and protects keep/age rules', () => {
    const now = 20 * 24 * 60 * 60 * 1000;
    const day = 24 * 60 * 60 * 1000;
    const runs = [
      { runId: 'new', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: now },
      { runId: 'old-failed', workflow: 'wf', status: 'failed', totalSpawned: 1, endedAt: now - 8 * day },
      { runId: 'old-running', workflow: 'wf', status: 'running', totalSpawned: 1, endedAt: now - 9 * day },
      { runId: 'old-completed', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: now - 10 * day },
    ];

    expect(selectWorkflowPruneCandidates(runs, { dryRun: false, keep: 2 }, now).map((run) => run.runId))
      .toEqual(['old-completed']);
    expect(selectWorkflowPruneCandidates(runs, { dryRun: false, olderThanMs: 7 * day }, now).map((run) => run.runId))
      .toEqual(['old-failed', 'old-completed']);
    expect(selectWorkflowPruneCandidates(runs, { dryRun: false, keep: 2, olderThanMs: 7 * day }, now).map((run) => run.runId))
      .toEqual(['old-completed']);
    expect(formatWorkflowPruneCandidates([])).toContain('no workflow runs');
  });

  it('protects newest terminal runs even when prune input is unsorted', () => {
    const runs = [
      { runId: 'old', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: 10 },
      { runId: 'newest', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: 30 },
      { runId: 'middle', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: 20 },
    ];

    expect(selectWorkflowPruneCandidates(runs, { dryRun: false, keep: 1 }).map((run) => run.runId))
      .toEqual(['middle', 'old']);
  });

  it('formats active manager runs and a single run snapshot', () => {
    const run = {
      runId: 'run-active',
      workflow: 'wf',
      status: 'paused' as const,
      runDir: '/tmp/run-active',
      totalSpawned: 2,
      eventCount: 5,
      startedAt: 1,
      resultText: 'final workflow report',
    };
    const processSnapshot: WorkflowProcessSnapshot = {
      runId: 'run-active',
      workflowName: 'wf',
      displayName: 'Paused audit',
      status: 'paused',
      startedAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:01.000Z',
      source: 'command',
      items: [],
      counts: {
        pending: 0,
        running: 1,
        completed: 0,
        failed: 0,
        cancelled: 0,
        skipped: 0,
      },
      progress: {
        spawnedAgents: 2,
        finishedAgents: 1,
        activeAgents: 1,
        failedAgents: 0,
        stoppedAgents: 0,
      },
      resultSummary: 'process result',
    };
    expect(formatManagedRunsList([run])).toContain('paused');
    expect(formatManagedRunsList([run])).toContain('5 events');
    expect(formatManagedRunsList([run], {
      processSnapshots: new Map([['run-active', processSnapshot]]),
    })).toContain('display: Paused audit');
    expect(formatWorkflowRunSnapshot(run)).toContain('/tmp/run-active');
    expect(formatWorkflowRunSnapshot(run)).toContain('final workflow report');
    expect(formatWorkflowRunSnapshot(run, undefined, { processSnapshot })).toContain('display name: Paused audit');
    expect(formatWorkflowRunSnapshot(run, undefined, { processSnapshot })).toContain('source: command');
    expect(formatWorkflowRunSnapshot(run)).not.toContain('/workflow rerun run-active');
    expect(formatWorkflowRunSnapshot(undefined)).toContain('unknown workflow');
  });

  it('keeps workflow show concise by default and can expand full artifact results', () => {
    const runDir = join(dir, 'run-full');
    const artifactsDir = join(runDir, 'artifacts');
    mkdirSync(artifactsDir, { recursive: true });
    const longReport = `full report start\n${'detail '.repeat(1200)}\nfull report end`;
    writeFileSync(join(artifactsDir, 'final-report.json'), JSON.stringify({ report: longReport }), 'utf8');
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({
      runId: 'run-full',
      workflow: 'wf',
      status: 'completed',
      totalSpawned: 2,
      eventCount: 1,
      startedAt: 1,
      endedAt: 2,
      artifacts: ['final-report'],
    }), 'utf8');

    const detail = readWorkflowRunDetail(dir, 'run-full');
    const preview = formatWorkflowRunSnapshot(undefined, detail);
    expect(preview).toContain('result preview');
    expect(preview).toContain('/workflow show --full run-full');
    expect(preview).not.toContain('[truncated]');

    const full = formatWorkflowRunSnapshot(undefined, detail, { full: true });
    expect(full).toContain('result:');
    expect(full).toContain('full report end');
    expect(full).not.toContain('[truncated]');

    const managed = {
      runId: 'run-full',
      workflow: 'wf',
      status: 'completed' as const,
      runDir,
      totalSpawned: 2,
      eventCount: 1,
      startedAt: 1,
      resultText: longReport,
    };
    const managedPreview = formatWorkflowRunSnapshot(managed, detail);
    expect(managedPreview).toContain('result preview');
    expect(managedPreview).toContain('/workflow show --full run-full');
    expect(managedPreview).not.toContain('full report end');
    expect(managedPreview).not.toContain('[truncated]');

    const managedFull = formatWorkflowRunSnapshot(managed, detail, { full: true });
    expect(managedFull).toContain('full report end');
  });

  it('treats cancelled persisted runs as terminal prune candidates', () => {
    expect(selectWorkflowPruneCandidates([
      { runId: 'cancelled', workflow: 'wf', status: 'cancelled', totalSpawned: 1, endedAt: 1 },
    ], { dryRun: false, olderThanMs: 1 }, 10).map((run) => run.runId))
      .toEqual(['cancelled']);
  });

  it('counts persisted workflow events from events.jsonl instead of stale run.json metadata', () => {
    const runDir = join(dir, 'run-stale-count');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({
      runId: 'run-stale-count',
      workflow: 'wf',
      status: 'completed',
      totalSpawned: 1,
      eventCount: 1,
      startedAt: 1,
      endedAt: 2,
      artifacts: [],
    }), 'utf8');
    writeFileSync(join(runDir, 'events.jsonl'), [
      JSON.stringify({ seq: 0, type: 'workflow_started', data: {} }),
      JSON.stringify({ seq: 1, type: 'agent_spawned', data: { taskId: 't1', name: 'reader' } }),
      JSON.stringify({
        seq: 2,
        type: 'agent_summary_updated',
        data: { taskId: 't1', summaryKind: 'digest' },
      }),
      '',
    ].join('\n'), 'utf8');

    expect(readWorkflowRunDetail(dir, 'run-stale-count')?.eventCount).toBe(3);
  });

  it('selects an active run by default, then latest managed, then persisted run', () => {
    const managed = [
      {
        runId: 'run-completed',
        workflow: 'wf',
        status: 'completed' as const,
        runDir: '/tmp/run-completed',
        totalSpawned: 1,
        eventCount: 1,
        startedAt: 20,
      },
      {
        runId: 'run-active',
        workflow: 'wf',
        status: 'running' as const,
        runDir: '/tmp/run-active',
        totalSpawned: 1,
        eventCount: 1,
        startedAt: 10,
      },
    ];
    const persisted = [
      { runId: 'run-persisted', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: 30 },
    ];

    expect(selectDefaultWorkflowRunId(managed, persisted)).toBe('run-active');
    expect(selectDefaultWorkflowRunId([managed[0]!], persisted)).toBe('run-completed');
    expect(selectDefaultWorkflowRunId([], persisted)).toBe('run-persisted');
    expect(selectDefaultWorkflowRunId([], [])).toBeUndefined();
    expect(selectDefaultActiveWorkflowRunId(managed)).toBe('run-active');
    expect(selectDefaultActiveWorkflowRunId([managed[0]!])).toBeUndefined();
  });

  it('reads run details from run.json plus events and surfaces failure context', () => {
    const runDir = join(dir, 'run-detail');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({
      runId: 'run-detail',
      workflow: 'wf',
      status: 'failed',
      totalSpawned: 2,
      eventCount: 4,
      startedAt: 1,
      endedAt: 2,
      artifacts: ['report'],
    }), 'utf8');
    writeFileSync(join(runDir, 'events.jsonl'), [
      JSON.stringify({ seq: 0, type: 'phase_started', data: { name: 'audit' } }),
      JSON.stringify({ seq: 1, type: 'agent_spawned', data: { taskId: 't1', name: 'reader' } }),
      JSON.stringify({ seq: 2, type: 'workflow_failed', data: { error: 'boom' } }),
      '',
    ].join('\n'), 'utf8');

    const detail = readWorkflowRunDetail(dir, 'run-detail');
    expect(detail?.error).toBe('boom');
    expect(detail?.artifacts).toEqual(['report']);
    const out = formatWorkflowRunSnapshot(undefined, detail);
    expect(out).toContain('recent events');
    expect(out).toContain('phase: audit');
    expect(out).toContain('workflow failed: boom');
    expect(out).not.toContain('/workflow rerun run-detail');
  });

  it('shows rerun only for generated runs with script snapshots', () => {
    const runDir = join(dir, 'run-generated');
    mkdirSync(runDir, { recursive: true });
    const scriptPath = join(runDir, 'script.js');
    const manifestPath = join(runDir, 'manifest.json');
    writeFileSync(scriptPath, 'export default {};\n', 'utf8');
    writeFileSync(manifestPath, '{"name":"wf"}\n', 'utf8');
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({
      runId: 'run-generated',
      workflow: 'wf',
      status: 'failed',
      totalSpawned: 1,
      eventCount: 1,
      startedAt: 1,
      endedAt: 2,
      artifacts: [],
      scriptSnapshotPath: scriptPath,
      manifestSnapshotPath: manifestPath,
    }), 'utf8');

    const detail = readWorkflowRunDetail(dir, 'run-generated');
    expect(detail?.canRerun).toBe(true);
    expect(detail?.scriptSnapshotPath).toBe(scriptPath);
    expect(detail?.manifestSnapshotPath).toBe(manifestPath);
    expect(formatWorkflowRunSnapshot(undefined, detail)).toContain('/workflow rerun run-generated');
  });

  it('requires run.json to declare both snapshot paths before offering rerun', () => {
    const runDir = join(dir, 'run-partial-snapshot');
    mkdirSync(runDir, { recursive: true });
    const scriptPath = join(runDir, 'script.js');
    const manifestPath = join(runDir, 'manifest.json');
    writeFileSync(scriptPath, 'export default {};\n', 'utf8');
    writeFileSync(manifestPath, '{"name":"wf"}\n', 'utf8');
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({
      runId: 'run-partial-snapshot',
      workflow: 'wf',
      status: 'completed',
      totalSpawned: 1,
      eventCount: 0,
      startedAt: 1,
      endedAt: 2,
      artifacts: [],
      scriptSnapshotPath: scriptPath,
    }), 'utf8');

    const detail = readWorkflowRunDetail(dir, 'run-partial-snapshot');
    expect(detail?.canRerun).toBe(false);
    expect(formatWorkflowRunSnapshot(undefined, detail)).not.toContain('/workflow rerun run-partial-snapshot');
  });

  it('does not offer rerun for in-progress snapshots before run.json exists', () => {
    const runDir = join(dir, 'run-in-progress');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'script.js'), 'export default {};\n', 'utf8');
    writeFileSync(join(runDir, 'manifest.json'), '{"name":"wf"}\n', 'utf8');
    writeFileSync(join(runDir, 'events.jsonl'), [
      JSON.stringify({ seq: 0, type: 'phase_started', data: { name: 'audit' } }),
      '',
    ].join('\n'), 'utf8');

    const detail = readWorkflowRunDetail(dir, 'run-in-progress');
    expect(detail?.canRerun).toBe(false);
    expect(formatWorkflowRunSnapshot(undefined, detail)).not.toContain('/workflow rerun run-in-progress');
  });

  it('treats only running and paused managed runs as active', () => {
    const base = {
      runId: 'run-x',
      workflow: 'wf',
      runDir: '/tmp/run-x',
      totalSpawned: 1,
      eventCount: 1,
      startedAt: 1,
    };

    expect(isActiveManagedWorkflowRun({ ...base, status: 'running' })).toBe(true);
    expect(isActiveManagedWorkflowRun({ ...base, status: 'paused' })).toBe(true);
    expect(isActiveManagedWorkflowRun({ ...base, status: 'failed' })).toBe(false);
    expect(isActiveManagedWorkflowRun({ ...base, status: 'completed' })).toBe(false);
    expect(isActiveManagedWorkflowRun({ ...base, status: 'stopped' })).toBe(false);
    expect(isActiveManagedWorkflowRun({ ...base, status: 'denied' })).toBe(false);
  });
});

describe('saved workflow dirs + formatting', () => {
  it('derives project + personal dirs from cwd', () => {
    const dirs = savedWorkflowDirs('/repo');
    expect(dirs.project).toContain('.kodax');
    expect(dirs.project).toContain('workflows');
    expect(dirs.personal).toContain('workflows');
  });
  it('formats saved workflow refs with source + path', () => {
    const out = formatSavedList([
      {
        name: 'audit',
        path: '/p/.kodax/workflows/audit.ts',
        source: 'project',
        execution: 'trusted-local',
      },
    ]);
    expect(out).toContain('audit');
    expect(out).toContain('project');
    expect(out).toContain('trusted-local');
  });
  it('handles empty saved list', () => {
    expect(formatSavedList([])).toContain('no saved');
  });
});

describe('renderWorkflowHelp', () => {
  it('documents every workflow subcommand and safety boundary', () => {
    const text = renderWorkflowHelp();
    expect(text).toContain('/workflow create <request>');
    expect(text).toContain('/workflow <name> [args]');
    expect(text).toContain('/workflow runs');
    expect(text).toContain('--limit N');
    expect(text).toContain('/workflow show [--full] [runId]');
    expect(text).toContain('/workflow pause <runId>');
    expect(text).toContain('/workflow resume <runId>');
    expect(text).toContain('/workflow stop [runId]');
    expect(text).toContain('/workflow delete [--force] [--run|--saved] <runId|savedName>');
    expect(text).toContain('/workflow prune');
    expect(text).toContain('/workflow save <runId> <name>');
    expect(text).toContain('/workflow rename <runId|alias|savedName> <newName>');
    expect(text).toContain('/workflow revise [--replace] <runId|alias|savedName> <change>');
    expect(text).toContain('/workflow rerun <runId|savedName> [args]');
    expect(text).toContain('revise --replace');
    expect(text).toContain('run id reruns');
    expect(text).toContain('saved name runs');
    expect(text).toContain('/workflow help');
    expect(text).toContain('workflow capsule');
    expect(text).toContain('capability WorkflowApi runner');
    expect(text).toContain('trusted-local');
  });
});

describe('isSafeWorkflowRunId', () => {
  it('allows generated run ids and rejects path traversal', () => {
    expect(isSafeWorkflowRunId('run-lx3')).toBe(true);
    expect(isSafeWorkflowRunId('run_2026-06-13')).toBe(true);
    expect(isSafeWorkflowRunId('../run-lx3')).toBe(false);
    expect(isSafeWorkflowRunId('..\\run-lx3')).toBe(false);
    expect(isSafeWorkflowRunId('')).toBe(false);
  });
});

describe('resolveConfirm', () => {
  it('prefers callbacks.confirm', async () => {
    const confirm = resolveConfirm({ confirm: async () => true });
    expect(confirm).toBeDefined();
    expect(await confirm!('ok?')).toBe(true);
  });

  it('falls back to a readline (y/N) prompt', async () => {
    const asked: string[] = [];
    const rl = {
      question: (query: string, cb: (answer: string) => void) => {
        asked.push(query);
        cb('y');
      },
    };
    const confirm = resolveConfirm({ readline: rl });
    expect(confirm).toBeDefined();
    expect(await confirm!('proceed?')).toBe(true);
    expect(asked[0]).toContain('(y/N)');
  });

  it('readline fallback treats non-yes as false', async () => {
    const rl = { question: (_q: string, cb: (a: string) => void) => cb('n') };
    expect(await resolveConfirm({ readline: rl })!('x?')).toBe(false);
  });

  it('returns undefined with no confirm channel (caller must fail safe)', () => {
    expect(resolveConfirm({})).toBeUndefined();
  });
});

describe('startGeneratedWorkflowFromRequest launch policy', () => {
  let runBaseDir = '';
  let runManager: WorkflowRunManager;

  beforeEach(() => {
    runBaseDir = mkdtempSync(join(tmpdir(), 'wf-generated-runs-'));
    runManager = createWorkflowRunManager();
  });

  afterEach(() => {
    rmSync(runBaseDir, { recursive: true, force: true });
  });

  function isolatedWorkflowRuntime(): {
    readonly runBaseDir: string;
    readonly runManager: WorkflowRunManager;
  } {
    return { runBaseDir, runManager };
  }

  it('starts a trusted built-in directly without invoking workflow generation', async () => {
    const generateWorkflow = vi.fn(async () => fakeGeneratedWorkflow());
    const builderStages: string[] = [];
    const runMessages: Array<{ readonly type: string; readonly text: string }> = [];
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];

    const outcome = await startGeneratedWorkflowFromRequest({
      ...isolatedWorkflowRuntime(),
      request: 'Review captured packets',
      builtin: { name: 'scoped-review', args: { packets: [] } },
      approval: 'silent',
      presentation: 'agentic',
      processSource: 'review',
      callbacks: {
        createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
        onWorkflowRunMessage: (event) => runMessages.push(event),
      },
      generateWorkflow,
      onBuilderEvent: (event) => builderStages.push(event.stage),
    });

    expect(outcome).toBe('started');
    expect(generateWorkflow).not.toHaveBeenCalled();
    expect(builderStages).toEqual(['started', 'validating', 'ready', 'launched']);
    await vi.waitFor(() => {
      expect(runMessages.some((event) => event.type === 'error')).toBe(true);
    }, { timeout: 5000 });
    const [runId] = readdirSync(runBaseDir);
    const runJson = JSON.parse(
      readFileSync(join(runBaseDir, runId ?? '', 'run.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(runJson).toMatchObject({
      workflow: 'scoped-review',
      source: 'review',
      args: { packets: [] },
      hostMetadata: { workflowAuthorship: 'kodax-generated' },
    });
    expect(runJson).not.toHaveProperty('scriptSnapshotPath');
  });

  it('auto-starts capability-generated workflows without confirmation when approval is silent', async () => {
    const confirm = vi.fn(async () => false);
    const generateWorkflow = vi.fn(async () => fakeGeneratedWorkflow());
    const builderStages: string[] = [];
    const runMessages: Array<{ readonly type: string; readonly text: string; readonly final?: boolean }> = [];
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    type WorkflowRunUpdate = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunUpdate']>>[0];
    const runUpdates: WorkflowRunUpdate[] = [];

    const outcome = await startGeneratedWorkflowFromRequest({
      ...isolatedWorkflowRuntime(),
      request: 'Generate a parallel audit workflow',
      approval: 'silent',
      presentation: 'agentic',
      processSource: 'amaw',
      callbacks: {
        confirm,
        createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
        onWorkflowRunMessage: (event) => runMessages.push(event),
        onWorkflowRunUpdate: (event) => runUpdates.push(event),
      },
      generateWorkflow,
      onBuilderEvent: (event) => builderStages.push(event.stage),
    });

    expect(outcome).toBe('started');
    expect(confirm).not.toHaveBeenCalled();
    expect(generateWorkflow).toHaveBeenCalledOnce();
    expect(builderStages).toEqual(['started', 'generating', 'validating', 'ready', 'launched']);
    await vi.waitFor(() => {
      expect(runMessages.some((event) => event.text.includes('Workflow completed'))).toBe(true);
    }, { timeout: 5000 });
    expect(runUpdates.some((event) => event.status === 'running' && event.workflow === 'generated-fast-audit')).toBe(true);
    expect(runUpdates.some((event) => event.status === 'running' && event.phaseTotal === 2)).toBe(true);
    expect(runUpdates.at(-1)?.status).toBe('completed');
    expect(runMessages.some((event) => event.type === 'info' && event.text.includes('Generated workflow'))).toBe(false);
    expect(runMessages.some((event) => event.type === 'info' && event.text.includes('Run workflow'))).toBe(false);
    expect(runMessages.some((event) => event.type === 'info' && event.text.includes('Auto-started generated workflow'))).toBe(false);
    expect(runMessages.some((event) => (
      event.type === 'assistant'
      && event.final !== true
      && event.text.includes('generated-fast-audit')
      && event.text.includes('Generated two-agent audit workflow.')
    ))).toBe(true);
    expect(runMessages.some((event) => (
      event.type === 'assistant'
      && event.final === true
      && event.text.includes('Generate a parallel audit workflow')
    ))).toBe(true);
    expect(runMessages.some((event) => (
      event.type === 'assistant'
      && event.final === true
      && event.text.includes('/workflow show')
    ))).toBe(false);
    const [runId] = readdirSync(runBaseDir);
    const runJson = JSON.parse(
      readFileSync(join(runBaseDir, runId ?? '', 'run.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(runJson).toMatchObject({
      workflow: 'generated-fast-audit',
      displayName: 'generated-fast-audit',
      source: 'amaw',
      goal: 'Generate a parallel audit workflow',
      hostMetadata: { workflowAuthorship: 'kodax-generated' },
    });
  });

  it('uses artifact content as the agentic completion answer when no synthesis text is returned', async () => {
    const runMessages: Array<{ readonly type: string; readonly text: string; readonly final?: boolean }> = [];
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];

    const outcome = await startGeneratedWorkflowFromRequest({
      ...isolatedWorkflowRuntime(),
      request: '请只输出 artifact 报告',
      approval: 'silent',
      presentation: 'agentic',
      callbacks: {
        createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
        onWorkflowRunMessage: (event) => runMessages.push(event),
      },
      generateWorkflow: async () => fakeArtifactOnlyGeneratedWorkflow(),
    });

    expect(outcome).toBe('started');
    await waitForFinalAssistantMessage(runMessages);
    expect(runMessages.some((event) => (
      event.type === 'assistant'
      && event.final !== true
      && event.text.includes('我会用 workflow')
    ))).toBe(true);
    expect(runMessages.some((event) => event.type === 'info' && event.text.includes('Generated workflow'))).toBe(false);
    const answer = runMessages.find((event) => event.type === 'assistant' && event.final === true)?.text;
    expect(answer).toContain('Artifact-only final report');
    expect(answer).toContain('final-report');
    expect(answer).not.toContain('/workflow show');
  });

  it('emits full long agentic completion results without preview truncation', async () => {
    const runMessages: Array<{ readonly type: string; readonly text: string; readonly final?: boolean }> = [];
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    const longRequest = `full report start\n${'detail '.repeat(1200)}\nfull report end`;

    const outcome = await startGeneratedWorkflowFromRequest({
      ...isolatedWorkflowRuntime(),
      request: longRequest,
      approval: 'silent',
      presentation: 'agentic',
      callbacks: {
        createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
        onWorkflowRunMessage: (event) => runMessages.push(event),
      },
      generateWorkflow: async () => fakeGeneratedWorkflow(),
    });

    expect(outcome).toBe('started');
    await waitForFinalAssistantMessage(runMessages);
    const answer = runMessages.find((event) => event.type === 'assistant' && event.final === true)?.text;
    expect(answer).toContain('full report start');
    expect(answer).toContain('full report end');
    expect(answer).not.toContain('Result preview truncated');
    expect(answer).not.toContain('/workflow show --full');
    expect(answer).not.toContain('[truncated]');
  });

  it('keeps command presentation as success plus info result by default', async () => {
    const runMessages: Array<{ readonly type: string; readonly text: string; readonly final?: boolean }> = [];
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];

    const outcome = await startGeneratedWorkflowFromRequest({
      ...isolatedWorkflowRuntime(),
      request: 'Generate a parallel audit workflow',
      approval: 'silent',
      callbacks: {
        createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
        onWorkflowRunMessage: (event) => runMessages.push(event),
      },
      generateWorkflow: async () => fakeGeneratedWorkflow(),
    });

    expect(outcome).toBe('started');
    await vi.waitFor(() => {
      expect(runMessages.some((event) => event.type === 'success')).toBe(true);
    }, { timeout: 5000 });
    expect(runMessages.some((event) => event.type === 'assistant')).toBe(false);
    expect(runMessages.some((event) => event.type === 'info' && event.text.includes('Generated workflow'))).toBe(true);
    expect(runMessages.some((event) => event.type === 'info' && event.text.includes('Auto-started generated workflow'))).toBe(true);
    expect(runMessages.some((event) => (
      event.type === 'info'
      && event.text.includes('Workflow result:')
      && event.text.includes('Generate a parallel audit workflow')
    ))).toBe(true);
  });

  it('labels zero-child script failures as workflow harness failures', async () => {
    const runMessages: Array<{ readonly type: string; readonly text: string; readonly final?: boolean }> = [];
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    const generated = fakeGeneratedWorkflow();

    const outcome = await startGeneratedWorkflowFromRequest({
      ...isolatedWorkflowRuntime(),
      request: 'Generate a broken audit workflow',
      approval: 'silent',
      callbacks: {
        createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
        onWorkflowRunMessage: (event) => runMessages.push(event),
      },
      generateWorkflow: async () => ({
        ...generated,
        module: {
          ...generated.module,
          run: async () => {
            throw new WorkflowScriptExecutionError(
              'restricted workflow script failed to compile: Invalid or unexpected token',
            );
          },
        },
      }),
    });

    expect(outcome).toBe('started');
    await vi.waitFor(() => {
      expect(runMessages.some((event) => event.type === 'error')).toBe(true);
    }, { timeout: 5000 });
    const errorText = runMessages.find((event) => event.type === 'error')?.text ?? '';
    expect(errorText).toContain('Workflow harness failed before launching child agents');
    expect(errorText).toContain('invalid generated workflow script or saved capsule');
    expect(errorText).toContain('/workflow rerun');
    expect(errorText).toContain('/workflow revise');
    expect(errorText).toContain('repeats it unchanged');
  });

  it('prints agentic completion through console fallback without info result framing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    try {
      const outcome = await startGeneratedWorkflowFromRequest({
        ...isolatedWorkflowRuntime(),
        request: 'Generate a parallel audit workflow',
        approval: 'silent',
        presentation: 'agentic',
        callbacks: {
          createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
        },
        generateWorkflow: async () => fakeGeneratedWorkflow(),
      });

      expect(outcome).toBe('started');
      await vi.waitFor(() => {
        const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
        expect(output).toContain('Workflow completed');
      }, { timeout: 5000 });
      const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('Final result:');
      expect(output).toContain('Generate a parallel audit workflow');
      expect(output).not.toContain('Workflow result:');
      expect(output).not.toContain('Use /workflow show');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('requires confirmation only when the caller asks for approval', async () => {
    const confirm = vi.fn(async () => false);
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];

    const outcome = await startGeneratedWorkflowFromRequest({
      ...isolatedWorkflowRuntime(),
      request: 'Generate a parallel audit workflow',
      approval: 'required',
      callbacks: {
        confirm,
        createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
      },
      generateWorkflow: async () => fakeGeneratedWorkflow(),
    });

    expect(outcome).toBe('cancelled');
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toContain('raw script:');
  });

  it('emits a builder failure event when workflow generation fails', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const builderEvents: Array<{ readonly stage: string; readonly message: string }> = [];
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];

    const outcome = await startGeneratedWorkflowFromRequest({
      ...isolatedWorkflowRuntime(),
      request: 'Generate a parallel audit workflow',
      approval: 'silent',
      callbacks: {
        createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
      },
      generateWorkflow: async () => {
        throw new Error('workflow generation failed (timeout after 120000ms): This operation was aborted');
      },
      onBuilderEvent: (event) => builderEvents.push({ stage: event.stage, message: event.message }),
    });

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    logSpy.mockRestore();
    expect(outcome).toBe('failed');
    expect(builderEvents.at(-1)).toEqual({
      stage: 'failed',
      message: 'workflow generation failed (timeout after 120000ms): This operation was aborted',
    });
    expect(output).toContain('builder failed');
    expect(output).toContain('timeout after 120000ms');
  });

  it('emits builder failure instead of throwing when option creation fails', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const builderEvents: Array<{ readonly stage: string; readonly message: string }> = [];

    const outcome = await startGeneratedWorkflowFromRequest({
      ...isolatedWorkflowRuntime(),
      request: 'Generate a parallel audit workflow',
      approval: 'silent',
      callbacks: {
        createKodaXOptions: () => {
          throw new Error('options unavailable');
        },
      },
      generateWorkflow: async () => fakeGeneratedWorkflow(),
      onBuilderEvent: (event) => builderEvents.push({ stage: event.stage, message: event.message }),
    });

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    logSpy.mockRestore();
    expect(outcome).toBe('failed');
    expect(builderEvents.at(-1)).toEqual({
      stage: 'failed',
      message: 'options unavailable',
    });
    expect(output).toContain('builder failed');
  });

  it('routes builder failures through error messages when a UI callback is available', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const runMessages: Array<{ readonly type: string; readonly text: string }> = [];
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];

    const outcome = await startGeneratedWorkflowFromRequest({
      ...isolatedWorkflowRuntime(),
      request: 'Generate a parallel audit workflow',
      approval: 'silent',
      callbacks: {
        createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
        onWorkflowRunMessage: (event) => runMessages.push(event),
      },
      generateWorkflow: async () => {
        throw new Error('manifest phases must be a non-empty string array');
      },
      onBuilderEvent: () => undefined,
    });

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    logSpy.mockRestore();
    expect(outcome).toBe('failed');
    expect(output).not.toContain('builder failed');
    expect(runMessages).toEqual([{
      type: 'error',
      text: 'Workflow builder failed: manifest phases must be a non-empty string array',
    }]);
  });
});

describe('workflow live update emitter', () => {
  it('does not reopen a terminal workflow when late child events arrive', () => {
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    type WorkflowRunUpdate = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunUpdate']>>[0];
    const updates: WorkflowRunUpdate[] = [];
    const live = createWorkflowLiveUpdateEmitter(
      { onWorkflowRunUpdate: (event) => updates.push(event) },
      'run-late',
      {
        name: 'late-event-workflow',
        description: 'test',
        phases: ['run'],
        readOnly: true,
        maxAgents: 2,
        maxConcurrency: 1,
      },
    );

    live.running();
    live.complete('failed', 'boom');
    live.onEvent({
      seq: 1,
      type: 'agent_spawned',
      data: { taskId: 'late-task', name: 'late-agent' },
    });

    expect(updates.map((event) => event.status)).toEqual(['running', 'failed']);
  });

  it('includes elapsed time and completed child token usage in live updates', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-13T10:00:00.000Z'));
      type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
      type WorkflowRunUpdate = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunUpdate']>>[0];
      const updates: WorkflowRunUpdate[] = [];
      const live = createWorkflowLiveUpdateEmitter(
        { onWorkflowRunUpdate: (event) => updates.push(event) },
        'run-usage',
        {
          name: 'usage-workflow',
          description: 'test',
          phases: ['run'],
          readOnly: true,
          maxAgents: 2,
          maxConcurrency: 1,
          tokenBudget: 50_000,
        },
      );

      live.onEvent({
        seq: 1,
        type: 'agent_spawned',
        data: { taskId: 'task-1', name: 'reader' },
      });
      vi.setSystemTime(new Date('2026-06-13T10:01:05.000Z'));
      live.onEvent({
        seq: 2,
        type: 'agent_completed',
        data: {
          taskId: 'task-1',
          name: 'reader',
          status: 'completed',
          usage: { totalTokens: 12_345 },
        },
      });

      expect(updates.at(-1)).toMatchObject({
        elapsedMs: 65_000,
        tokenBudgetSpent: 12_345,
        tokenBudgetTotal: 50_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries planned agent counts separately from the hard cap', () => {
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    type WorkflowRunUpdate = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunUpdate']>>[0];
    const updates: WorkflowRunUpdate[] = [];
    const live = createWorkflowLiveUpdateEmitter(
      { onWorkflowRunUpdate: (event) => updates.push(event) },
      'run-planned',
      {
        name: 'planned-workflow',
        description: 'test',
        phases: ['inspect', 'synthesize'],
        readOnly: true,
        plannedAgents: 7,
        maxAgents: 14,
        maxConcurrency: 3,
      },
    );

    live.onEvent({
      seq: 1,
      type: 'agent_spawned',
      data: { taskId: 'task-1', name: 'reader' },
    });

    expect(updates.at(-1)).toMatchObject({
      plannedAgents: 7,
      agentCap: 14,
      totalSpawned: 1,
    });
  });
});

describe('workflowCommand registration shape', () => {
  it('exposes name + usage + handler', () => {
    expect(workflowCommand.name).toBe('workflow');
    expect(typeof workflowCommand.handler).toBe('function');
    expect(workflowCommand.usage).toContain('/workflow');
    expect(workflowCommand.argumentHint).toContain('help');
    expect(workflowCommand.argumentHint).toContain('rerun');
    expect(workflowCommand.detailedHelp).toBeDefined();
  });
});

describe('workflowCommand saved capsule preflight', () => {
  let dir = '';
  let previousCwd = '';
  let workflowRunsDir = '';
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-command-'));
    vi.stubEnv('KODAX_HOME', join(dir, '.kodax'));
    workflowRunsDir = getAgentConfigPath('workflow-runs', deriveProjectKeyFromRoot(dir).key);
    previousCwd = process.cwd();
    process.chdir(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
    rmSync(workflowRunsDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('refuses non-terminal persisted workflow runs unless --force is explicit', async () => {
    const runDir = join(workflowRunsDir, 'run-running');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'run-running',
        workflow: 'running-audit',
        status: 'running',
        totalSpawned: 1,
        startedAt: 1,
        endedAt: 0,
        artifacts: [],
      }),
      'utf8',
    );

    await workflowCommand.handler(
      ['delete', 'run-running'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      {} as Parameters<typeof workflowCommand.handler>[2],
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Workflow run-running is a non-terminal persisted running record');
    expect(output).toContain('/workflow delete --force run-running');
    expect(existsSync(runDir)).toBe(true);
  });

  it('force-deletes a stale non-terminal persisted workflow run', async () => {
    const runDir = join(workflowRunsDir, 'run-stale-running');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'run-stale-running',
        workflow: 'running-audit',
        status: 'running',
        totalSpawned: 1,
        startedAt: 1,
        endedAt: 0,
        artifacts: [],
      }),
      'utf8',
    );

    await workflowCommand.handler(
      ['delete', '--force', 'run-stale-running'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      {} as Parameters<typeof workflowCommand.handler>[2],
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Deleted workflow run run-stale-running with --force');
    expect(existsSync(runDir)).toBe(false);
  });

  it('deletes a generated saved workflow capsule when the target is a saved name', async () => {
    const savedPath = writeSavedWorkflowCapsule(dir, 'saved-audit');

    await workflowCommand.handler(
      ['delete', 'saved-audit'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      {} as Parameters<typeof workflowCommand.handler>[2],
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Deleted saved workflow saved-audit');
    expect(existsSync(savedPath)).toBe(false);
  });

  it('prefers deleting a unique workflow run when its display name also matches a saved capsule', async () => {
    const savedPath = writeSavedWorkflowCapsule(dir, 'display-collision');
    const runDir = join(workflowRunsDir, 'run-display-collision');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'run-display-collision',
        workflow: 'display-collision',
        displayName: 'display-collision',
        status: 'completed',
        totalSpawned: 1,
        endedAt: 2,
      }),
      'utf8',
    );

    await workflowCommand.handler(
      ['delete', 'display-collision'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      {} as Parameters<typeof workflowCommand.handler>[2],
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Deleted workflow run run-display-collision');
    expect(existsSync(savedPath)).toBe(true);
    expect(existsSync(join(runDir, 'run.json'))).toBe(false);
  });

  it('uses --saved to delete a saved capsule when an exact run id has the same name', async () => {
    const savedPath = writeSavedWorkflowCapsule(dir, 'same-name');
    const runDir = join(workflowRunsDir, 'same-name');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'same-name',
        workflow: 'same-name',
        status: 'completed',
        totalSpawned: 1,
        endedAt: 2,
      }),
      'utf8',
    );

    await workflowCommand.handler(
      ['delete', '--saved', 'same-name'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      {} as Parameters<typeof workflowCommand.handler>[2],
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Deleted saved workflow same-name');
    expect(existsSync(savedPath)).toBe(false);
    expect(existsSync(join(runDir, 'run.json'))).toBe(true);
  });

  it('prefers deleting an exact workflow run id when a saved capsule has the same name', async () => {
    const savedPath = writeSavedWorkflowCapsule(dir, 'same-name');
    const runDir = join(workflowRunsDir, 'same-name');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'same-name',
        workflow: 'same-name',
        status: 'completed',
        totalSpawned: 1,
        endedAt: 2,
      }),
      'utf8',
    );

    await workflowCommand.handler(
      ['delete', 'same-name'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      {} as Parameters<typeof workflowCommand.handler>[2],
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Deleted workflow run same-name');
    expect(existsSync(savedPath)).toBe(true);
    expect(existsSync(join(runDir, 'run.json'))).toBe(false);
  });

  it('fails closed when a delete display name matches multiple workflow runs', async () => {
    const savedPath = writeSavedWorkflowCapsule(dir, 'shared-display');
    for (const runId of ['run-shared-a', 'run-shared-b']) {
      const runDir = join(workflowRunsDir, runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, 'run.json'),
        JSON.stringify({
          runId,
          workflow: 'shared-display',
          displayName: 'shared-display',
          status: 'completed',
          totalSpawned: 1,
          endedAt: 2,
        }),
        'utf8',
      );
    }

    await workflowCommand.handler(
      ['delete', 'shared-display'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      {} as Parameters<typeof workflowCommand.handler>[2],
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('ambiguous delete target');
    expect(output).toContain('multiple workflow run/display names');
    expect(existsSync(savedPath)).toBe(true);
    expect(existsSync(join(workflowRunsDir, 'run-shared-a', 'run.json'))).toBe(true);
    expect(existsSync(join(workflowRunsDir, 'run-shared-b', 'run.json'))).toBe(true);
  });

  it('shows persisted workflow process identity and result metadata', async () => {
    const runDir = join(workflowRunsDir, 'run-metadata');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'run-metadata',
        workflow: 'generated-audit',
        displayName: 'Customer Audit',
        status: 'completed',
        source: 'capsule',
        savedWorkflowName: 'saved-audit',
        sourceRunId: 'run-source',
        sourceWorkflowName: 'saved-source',
        revisionOf: 'saved-source',
        resultSummary: 'metadata-backed result',
        totalSpawned: 1,
        startedAt: 1,
        endedAt: 2,
        artifacts: ['report'],
      }),
      'utf8',
    );

    await workflowCommand.handler(
      ['show', 'run-metadata'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      {} as Parameters<typeof workflowCommand.handler>[2],
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('display name: Customer Audit');
    expect(output).toContain('source: capsule');
    expect(output).toContain('saved workflow: saved-audit');
    expect(output).toContain('source run: run-source');
    expect(output).toContain('source workflow: saved-source');
    expect(output).toContain('revision of: saved-source');
    expect(output).toContain('metadata-backed result');
  });

  it('reports persisted-only terminal workflow runs as already finished on stop', async () => {
    const runDir = join(workflowRunsDir, 'run-terminal-stop');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'run-terminal-stop',
        workflow: 'terminal-audit',
        status: 'completed',
        totalSpawned: 1,
        startedAt: 1,
        endedAt: 2,
        artifacts: [],
      }),
      'utf8',
    );

    await workflowCommand.handler(
      ['stop', 'run-terminal-stop'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      {} as Parameters<typeof workflowCommand.handler>[2],
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Workflow run-terminal-stop is already completed');
    expect(output).toContain('Next: /workflow show run-terminal-stop');
    expect(output).not.toContain('No active workflow run-terminal-stop');
  });

  it('prints dependency-inventory warnings before saved capsule approval', async () => {
    const workflowsDir = join(dir, '.kodax', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      join(workflowsDir, 'needs-inventory.workflow.json'),
      JSON.stringify({
        format: 'kodax.workflow',
        version: 1,
        workflowApiVersion: 1,
        minKodaxVersion: '0.7.49',
        manifest: {
          name: 'needs-inventory',
          description: 'requires an external shell tool',
          phases: ['run'],
          readOnly: true,
          maxAgents: 1,
          maxConcurrency: 1,
          patterns: ['classify-and-act'],
        },
        source: 'async function run() { return "ok"; }',
        requires: {
          tools: ['bash'],
        },
      }),
      'utf8',
    );
    const prompts: string[] = [];
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    const callbacks = {
      confirm: async (message: string) => {
        prompts.push(message);
        return false;
      },
      createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
    } as WorkflowHandlerCallbacks;

    await workflowCommand.handler(
      ['needs-inventory'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      callbacks,
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('capsule preflight warnings');
    expect(output).toContain('tools:bash');
    expect(prompts[0]).toContain('raw script:');
  });

  it('runs a saved workflow name rerun with the saved workflow locale', async () => {
    writeSavedWorkflowCapsule(dir, 'saved-audit', {
      description: '中文审计 workflow',
      source: 'async function run() { return "完成"; }',
    });
    const prompts: string[] = [];
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    type WorkflowLiveUpdate = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunUpdate']>>[0];
    type WorkflowRunMessage = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunMessage']>>[0];
    const updates: WorkflowLiveUpdate[] = [];
    const runMessages: WorkflowRunMessage[] = [];
    const callbacks = {
      confirm: async (message: string) => {
        prompts.push(message);
        return true;
      },
      createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
      onWorkflowRunMessage: (event) => {
        runMessages.push(event);
      },
      onWorkflowRunUpdate: (event) => {
        updates.push(event);
      },
    } as WorkflowHandlerCallbacks;

    await workflowCommand.handler(
      ['rerun', 'saved-audit', '{"request":"请复查"}'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      callbacks,
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).not.toContain('rerun failed');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('source: saved:project');
    expect(prompts[0]).toContain('raw script:');
    expect(updates[0]).toMatchObject({ locale: 'zh' });
    await waitForFinalAssistantMessage(runMessages);
    expect(runMessages.some((event) => event.type === 'success')).toBe(false);
    expect(runMessages.some((event) => event.type === 'info' && event.text.includes('Workflow result:'))).toBe(false);
  });

  it('persists saved capsule provenance when rerunning a saved workflow name', async () => {
    writeSavedWorkflowCapsule(dir, 'saved-lineage-rerun', {
      source: 'async function run() { return "lineage rerun"; }',
      provenance: {
        fromRunId: 'run-source',
        fromWorkflowName: 'saved-source',
        revisionOf: 'saved-source',
        createdAt: '2026-06-16T00:00:00.000Z',
        kodaxVersion: '0.7.50',
      },
    });
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    type WorkflowRunMessage = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunMessage']>>[0];
    const runMessages: WorkflowRunMessage[] = [];
    const callbacks = {
      confirm: async () => true,
      createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
      onWorkflowRunMessage: (event) => {
        runMessages.push(event);
      },
    } as WorkflowHandlerCallbacks;

    await workflowCommand.handler(
      ['rerun', 'saved-lineage-rerun'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      callbacks,
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    await waitForFinalAssistantMessage(runMessages);
    const runJson = readSingleWorkflowRunJson(workflowRunsDir);
    expect(runJson.source).toBe('capsule');
    expect(runJson.savedWorkflowName).toBe('saved-lineage-rerun');
    expect(runJson.sourceRunId).toBe('run-source');
    expect(runJson.sourceWorkflowName).toBe('saved-source');
    expect(runJson.revisionOf).toBe('saved-source');
  });

  it('preserves locale from a historical generated run when rerunning by run id', async () => {
    writeGeneratedRunSnapshot(workflowRunsDir, 'run-zh-audit');
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    type WorkflowLiveUpdate = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunUpdate']>>[0];
    type WorkflowRunMessage = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunMessage']>>[0];
    const updates: WorkflowLiveUpdate[] = [];
    const runMessages: WorkflowRunMessage[] = [];
    const callbacks = {
      confirm: async () => true,
      createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
      onWorkflowRunMessage: (event) => {
        runMessages.push(event);
      },
      onWorkflowRunUpdate: (event) => {
        updates.push(event);
      },
    } as WorkflowHandlerCallbacks;

    await workflowCommand.handler(
      ['rerun', 'run-zh-audit'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      callbacks,
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).not.toContain('rerun failed');
    expect(updates[0]).toMatchObject({ locale: 'zh' });
    await waitForFinalAssistantMessage(runMessages);
    expect(runMessages.some((event) => event.type === 'success')).toBe(false);
    expect(runMessages.some((event) => event.type === 'info' && event.text.includes('Workflow result:'))).toBe(false);
  });

  it('runs a saved workflow name with agentic completion instead of info result', async () => {
    writeSavedWorkflowCapsule(dir, 'saved-direct', {
      description: 'saved direct workflow',
      source: 'async function run() { return "direct result"; }',
    });
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    type WorkflowRunMessage = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunMessage']>>[0];
    const runMessages: WorkflowRunMessage[] = [];
    const callbacks = {
      confirm: async () => true,
      createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
      onWorkflowRunMessage: (event) => {
        runMessages.push(event);
      },
    } as WorkflowHandlerCallbacks;

    await workflowCommand.handler(
      ['saved-direct'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      callbacks,
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    await waitForFinalAssistantMessage(runMessages);
    const finalText = runMessages.find((event) => event.type === 'assistant' && event.final === true)?.text;
    expect(finalText).toContain('direct result');
    expect(runMessages.some((event) => event.type === 'success')).toBe(false);
    expect(runMessages.some((event) => event.type === 'info' && event.text.includes('Workflow result:'))).toBe(false);
  });

  it('persists saved capsule provenance when starting a saved workflow name', async () => {
    writeSavedWorkflowCapsule(dir, 'saved-lineage-direct', {
      source: 'async function run() { return "lineage direct"; }',
      provenance: {
        fromRunId: 'run-original',
        fromWorkflowName: 'saved-original',
        revisionOf: 'saved-original',
        createdAt: '2026-06-16T00:00:00.000Z',
        kodaxVersion: '0.7.50',
      },
    });
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    type WorkflowRunMessage = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunMessage']>>[0];
    const runMessages: WorkflowRunMessage[] = [];
    const callbacks = {
      confirm: async () => true,
      createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
      onWorkflowRunMessage: (event) => {
        runMessages.push(event);
      },
    } as WorkflowHandlerCallbacks;

    await workflowCommand.handler(
      ['saved-lineage-direct'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      callbacks,
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    await waitForFinalAssistantMessage(runMessages);
    const runJson = readSingleWorkflowRunJson(workflowRunsDir);
    expect(runJson.source).toBe('capsule');
    expect(runJson.savedWorkflowName).toBe('saved-lineage-direct');
    expect(runJson.sourceRunId).toBe('run-original');
    expect(runJson.sourceWorkflowName).toBe('saved-original');
    expect(runJson.revisionOf).toBe('saved-original');
  });

  it('fails closed when a rerun target matches both a run id and saved workflow name', async () => {
    writeSavedWorkflowCapsule(dir, 'same-name');
    const projectKey = deriveProjectKeyFromRoot(dir).key;
    const runDir = join(getAgentConfigPath('workflow-runs', projectKey), 'same-name');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'run.json'),
      JSON.stringify({
        runId: 'same-name',
        workflow: 'same-name',
        status: 'completed',
        totalSpawned: 0,
        endedAt: Date.now(),
      }),
      'utf8',
    );
    const prompts: string[] = [];
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    const callbacks = {
      confirm: async (message: string) => {
        prompts.push(message);
        return true;
      },
      createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
    } as WorkflowHandlerCallbacks;

    await workflowCommand.handler(
      ['rerun', 'same-name'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      callbacks,
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('ambiguous rerun target');
    expect(output).toContain('/workflow same-name');
    expect(prompts).toHaveLength(0);
  });
});

describe('workflowCommand create redirect (FEATURE_246 / ADR-047)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('redirects /workflow create to the Worker in AMA mode with explicit intent', async () => {
      const result = await workflowCommand.handler(
        ['create', 'compare', 'three', 'repos'],
        {} as Parameters<typeof workflowCommand.handler>[1],
        {} as Parameters<typeof workflowCommand.handler>[2],
        { agentMode: 'ama' } as Parameters<typeof workflowCommand.handler>[3],
      );
      expect(result && typeof result === 'object' && 'invocation' in result).toBe(true);
      if (result && typeof result === 'object' && result.invocation) {
        expect(result.invocation.source).toBe('prompt');
        expect(result.invocation.prompt).toContain('run_workflow');
        expect(result.invocation.prompt).toContain('compare three repos');
        // It hands an agent turn to the Worker — it does NOT blind-generate here.
        expect(result.invocation.prompt).toContain('investigate');
        expect(result.invocation.workflowIntent).toBe('explicit');
      }
  });

  for (const [kind, args] of [
    ['create', ['create', 'compare', 'three', 'repos']],
    ['run-by-name', ['some-builtin-workflow']],
    ['rerun', ['rerun', 'run-xyz']],
  ] as const) {
    it(`refuses the execution-class ${kind} subcommand in Solo (SA) mode`, async () => {
      const result = await workflowCommand.handler(
        [...args],
        {} as Parameters<typeof workflowCommand.handler>[1],
        // A confirm channel is offered so a failure to reject can't be masked
        // by the start path's "no approval channel" early return.
        { confirm: async () => true } as Parameters<typeof workflowCommand.handler>[2],
        { agentMode: 'sa' } as Parameters<typeof workflowCommand.handler>[3],
      );
      // No agent-turn invocation is handed back — SA runs no workflows.
      expect(result === undefined || (typeof result === 'object' && !('invocation' in result))).toBe(true);
      const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('Solo (SA) mode does not support');
      expect(output).toContain('/agent-mode ama');
    });
  }

  it('bare /workflow <free-text> (unknown workflow name) is treated as create', async () => {
    const result = await workflowCommand.handler(
      ['compare', 'streaming', 'recovery', 'across', 'repos'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      // The start path resolves a confirm channel before falling through.
      { confirm: async () => true } as Parameters<typeof workflowCommand.handler>[2],
      { agentMode: 'ama' } as Parameters<typeof workflowCommand.handler>[3],
    );
    expect(result && typeof result === 'object' && 'invocation' in result).toBe(true);
    if (result && typeof result === 'object' && result.invocation) {
      expect(result.invocation.prompt).toContain('compare streaming recovery across repos');
      expect(result.invocation.prompt).toContain('run_workflow');
    }
  });

  it('bare /workflow (no args) lists workflows — it does NOT create', async () => {
    const result = await workflowCommand.handler(
      [],
      {} as Parameters<typeof workflowCommand.handler>[1],
      {} as Parameters<typeof workflowCommand.handler>[2],
      { agentMode: 'ama' } as Parameters<typeof workflowCommand.handler>[3],
    );
    expect(result === undefined || (typeof result === 'object' && !('invocation' in result))).toBe(true);
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Built-in workflows:');
  });
});
