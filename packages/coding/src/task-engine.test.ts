import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAmaControllerDecision, type ReasoningPlan } from './reasoning.js';
import type { KodaXManagedTaskStatusEvent, KodaXRepoRoutingSignals, KodaXTaskRoutingDecision } from './types.js';

const {
  mockCreateReasoningPlan,
  mockAnalyzeChangedScope,
  mockGetImpactEstimate,
  mockGetModuleContext,
  mockGetRepoOverview,
  mockRenderChangedScope,
  mockRenderImpactEstimate,
  mockRenderModuleContext,
  mockRenderRepoOverview,
  mockResolveProvider,
  mockRunDirectKodaX,
} = vi.hoisted(() => ({
  mockAnalyzeChangedScope: vi.fn(),
  mockCreateReasoningPlan: vi.fn(),
  mockGetImpactEstimate: vi.fn(),
  mockGetModuleContext: vi.fn(),
  mockGetRepoOverview: vi.fn(),
  mockRenderChangedScope: vi.fn(() => 'Changed scope summary'),
  mockRenderImpactEstimate: vi.fn(() => 'Impact estimate summary'),
  mockRenderModuleContext: vi.fn(() => 'Module context summary'),
  mockRenderRepoOverview: vi.fn(() => 'Repository overview summary'),
  mockResolveProvider: vi.fn(() => ({ name: 'anthropic' })),
  mockRunDirectKodaX: vi.fn(),
}));

vi.mock('./agent.js', async () => {
  const actual = await vi.importActual<typeof import('./agent.js')>('./agent.js');
  return {
    ...actual,
    runKodaX: mockRunDirectKodaX,
  };
});

vi.mock('./providers/index.js', async () => {
  const actual = await vi.importActual<typeof import('./providers/index.js')>('./providers/index.js');
  return {
    ...actual,
    resolveProvider: mockResolveProvider,
  };
});

vi.mock('./reasoning.js', async () => {
  const actual = await vi.importActual<typeof import('./reasoning.js')>('./reasoning.js');
  return {
    ...actual,
    createReasoningPlan: mockCreateReasoningPlan,
  };
});

vi.mock('./repo-intelligence/index.js', async () => {
  const actual = await vi.importActual<typeof import('./repo-intelligence/index.js')>('./repo-intelligence/index.js');
  return {
    ...actual,
    analyzeChangedScope: mockAnalyzeChangedScope,
    getRepoOverview: mockGetRepoOverview,
    renderChangedScope: mockRenderChangedScope,
    renderRepoOverview: mockRenderRepoOverview,
  };
});

vi.mock('./repo-intelligence/query.js', async () => {
  const actual = await vi.importActual<typeof import('./repo-intelligence/query.js')>('./repo-intelligence/query.js');
  return {
    ...actual,
    renderImpactEstimate: mockRenderImpactEstimate,
    renderModuleContext: mockRenderModuleContext,
  };
});

vi.mock('./repo-intelligence/runtime.js', async () => {
  const actual = await vi.importActual<typeof import('./repo-intelligence/runtime.js')>('./repo-intelligence/runtime.js');
  return {
    ...actual,
    getImpactEstimate: mockGetImpactEstimate,
    getModuleContext: mockGetModuleContext,
  };
});

import { runManagedTask } from './task-engine.js';

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function removeDirWithRetries(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !/EBUSY|EPERM/i.test(error.message)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (lastError) {
    throw lastError;
  }
}

function buildPlan(
  overrides: Partial<KodaXTaskRoutingDecision> = {},
): ReasoningPlan {
  const decision: KodaXTaskRoutingDecision = {
    primaryTask: 'edit',
    taskFamily: 'implementation',
    actionability: 'actionable',
    executionPattern: 'direct',
    confidence: 0.9,
    riskLevel: 'low',
    recommendedMode: 'implementation',
    recommendedThinkingDepth: 'low',
    complexity: 'simple',
    workIntent: 'new',
    requiresBrainstorm: false,
    harnessProfile: 'H0_DIRECT',
    reason: 'Default direct plan.',
    routingSource: 'model',
    routingAttempts: 1,
    needsIndependentQA: false,
    soloBoundaryConfidence: 0.9,
    ...overrides,
  };
  return {
    mode: 'auto',
    depth: 'low',
    promptOverlay: '[Routing] test',
    decision,
    amaControllerDecision: buildAmaControllerDecision(decision),
  };
}

function buildRepoRoutingSignals(
  overrides: Partial<KodaXRepoRoutingSignals> = {},
): KodaXRepoRoutingSignals {
  return {
    changedFileCount: 1,
    changedLineCount: 10,
    addedLineCount: 6,
    deletedLineCount: 4,
    touchedModuleCount: 1,
    changedModules: ['src/task-engine.ts'],
    crossModule: false,
    riskHints: [],
    plannerBias: false,
    investigationBias: false,
    lowConfidence: false,
    ...overrides,
  };
}

function buildAssistantResult(text: string, extras: Record<string, unknown> = {}) {
  return {
    success: true,
    lastText: text,
    messages: [{ role: 'assistant' as const, content: text }],
    sessionId: 'session-test',
    ...extras,
  };
}

function buildScoutResponse(
  visibleText: string,
  confirmedHarness: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL',
  options?: {
    harnessRationale?: string;
    blockingEvidence?: string[];
    directCompletionReady?: 'yes' | 'no';
    skillSummary?: string;
    projectionConfidence?: 'high' | 'medium' | 'low';
    executionObligations?: string[];
    verificationObligations?: string[];
    ambiguities?: string[];
    scope?: string[];
    reviewFilesOrAreas?: string[];
  },
): string {
  const harnessRationale = options?.harnessRationale
    ?? (confirmedHarness === 'H0_DIRECT'
      ? 'Evidence is already sufficient to finish safely on the direct path.'
      : 'Additional verification or coordination is still required before final delivery.');
  const directCompletionReady = options?.directCompletionReady
    ?? (confirmedHarness === 'H0_DIRECT' ? 'yes' : 'no');
  const blockingEvidence = options?.blockingEvidence
    ?? (confirmedHarness === 'H0_DIRECT' ? ['none'] : ['Need additional evidence before direct completion.']);
  const scope = options?.scope ?? ['Confirm task intent and scope.'];
  const reviewFilesOrAreas = options?.reviewFilesOrAreas;
  return [
    visibleText,
    '```kodax-task-scout',
    `summary: ${visibleText}`,
    `confirmed_harness: ${confirmedHarness}`,
    `harness_rationale: ${harnessRationale}`,
    `direct_completion_ready: ${directCompletionReady}`,
    'blocking_evidence:',
    ...blockingEvidence.map((item) => `- ${item}`),
    scope.length > 0
      ? ['scope:', ...scope.map((item) => `- ${item}`)].join('\n')
      : 'scope:',
    reviewFilesOrAreas?.length
      ? ['review_files_or_areas:', ...reviewFilesOrAreas.map((item) => `- ${item}`)].join('\n')
      : undefined,
    'required_evidence:',
    '- Minimal evidence required for the next stage.',
    options?.skillSummary ? `skill_summary: ${options.skillSummary}` : undefined,
    options?.projectionConfidence ? `projection_confidence: ${options.projectionConfidence}` : undefined,
    options?.executionObligations?.length
      ? ['execution_obligations:', ...options.executionObligations.map((item) => `- ${item}`)].join('\n')
      : undefined,
    options?.verificationObligations?.length
      ? ['verification_obligations:', ...options.verificationObligations.map((item) => `- ${item}`)].join('\n')
      : undefined,
    options?.ambiguities?.length
      ? ['ambiguities:', ...options.ambiguities.map((item) => `- ${item}`)].join('\n')
      : undefined,
    '```',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function buildContractResponse(visibleText: string): string {
  return [
    visibleText,
    '```kodax-task-contract',
    `summary: ${visibleText}`,
    'success_criteria:',
    '- Complete the requested task and provide a correct final answer.',
    'required_evidence:',
    '- Concrete supporting evidence from the inspected files or checks.',
    'constraints:',
    '- Stay focused on the scoped task.',
    '```',
  ].join('\n');
}

function buildHandoffResponse(
  visibleText: string,
  status: 'ready' | 'incomplete' | 'blocked' = 'ready',
): string {
  return [
    visibleText,
    '```kodax-task-handoff',
    `status: ${status}`,
    `summary: ${visibleText}`,
    'evidence:',
    '- Completed the assigned work and gathered the necessary evidence.',
    'followup:',
    '- none',
    '```',
  ].join('\n');
}

function buildVerdictResponse(
  visibleText: string,
  status: 'accept' | 'revise' | 'blocked',
  reason: string,
  options?: {
    followups?: string[];
    nextHarness?: 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL';
    userAnswer?: string;
  },
): string {
  const followups = options?.followups?.length ? options.followups : ['none'];
  return [
    visibleText,
    '```kodax-task-verdict',
    `status: ${status}`,
    `reason: ${reason}`,
    ...(options?.userAnswer === undefined
      ? []
      : [
        'user_answer:',
        ...options.userAnswer.split('\n'),
      ]),
    ...(options?.nextHarness ? [`next_harness: ${options.nextHarness}`] : []),
    'followup:',
    ...followups.map((item) => `- ${item}`),
    '```',
  ].join('\n');
}

function buildRawVerdictResponse(
  visibleText: string,
  statusText: string,
  reason: string,
  options?: {
    followups?: string[];
    userAnswer?: string;
  },
): string {
  const followups = options?.followups?.length ? options.followups : ['none'];
  return [
    visibleText,
    '```kodax-task-verdict',
    `status: ${statusText}`,
    `reason: ${reason}`,
    ...(options?.userAnswer === undefined
      ? []
      : [
        'user_answer:',
        ...options.userAnswer.split('\n'),
      ]),
    'followup:',
    ...followups.map((item) => `- ${item}`),
    '```',
  ].join('\n');
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForFileContent(filePath: string, attempts = 40): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${filePath}`);
}

async function waitForFileContentContaining(
  filePath: string,
  expectedFragments: string[],
  attempts = 120,
): Promise<string> {
  let lastContent = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lastContent = await readFile(filePath, 'utf8');
      if (expectedFragments.every((fragment) => lastContent.includes(fragment))) {
        return lastContent;
      }
    } catch {
      // Keep retrying until the background write completes.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath} to contain: ${expectedFragments.join(', ')}\nLast content:\n${lastContent}`);
}


describe('runManagedTask', () => {
  it('keeps SA fully outside AMA and applies direct-path shaping', async () => {
    const onManagedTaskStatus = vi.fn();
    mockRunDirectKodaX.mockResolvedValue(
      buildAssistantResult('状态栏在 packages/repl/src/ui/components/StatusBar.tsx。'),
    );

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'sa',
        events: { onManagedTaskStatus },
        context: {
          promptOverlay: '[Base Overlay]',
        },
      },
      '现在状态栏是在哪个文件管理的？',
    );

    expect(mockCreateReasoningPlan).not.toHaveBeenCalled();
    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(1);
    expect(onManagedTaskStatus).not.toHaveBeenCalled();
    expect(result.managedTask).toBeUndefined();
    expect(mockRunDirectKodaX.mock.calls[0]?.[0].context?.promptOverlay).toContain(
      'Return a concise factual answer with the relevant file path(s)',
    );
  });

});
