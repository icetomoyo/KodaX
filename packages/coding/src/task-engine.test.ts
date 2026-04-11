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

vi.mock('./agent.js', () => ({
  runKodaX: mockRunDirectKodaX,
}));

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

import { __managedProtocolTestables, runManagedTask } from './task-engine.js';

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
  return [
    visibleText,
    '```kodax-task-scout',
    `summary: ${visibleText}`,
    `confirmed_harness: ${confirmedHarness}`,
    `harness_rationale: ${harnessRationale}`,
    `direct_completion_ready: ${directCompletionReady}`,
    'blocking_evidence:',
    ...blockingEvidence.map((item) => `- ${item}`),
    'scope:',
    '- Confirm task intent and scope.',
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

describe('managed protocol parsers', () => {
  it('accepts scout json blocks with aliases and trailing chatter', () => {
    const directive = __managedProtocolTestables.parseManagedTaskScoutDirective([
      'Scout says the task can stay cheap.',
      '```kodax-task-scout',
      JSON.stringify({
        summary: 'Scout summary',
        confirmedHarness: 'h1',
        evidenceAcquisitionMode: 'bundle',
        skillSummary: 'Use the skill map.',
        projectionConfidence: 'medium',
        scope: ['Confirm task intent.'],
        requiredEvidence: ['Minimal evidence.'],
        reviewFilesOrAreas: ['packages/coding/src/task-engine.ts'],
        executionObligations: ['Inspect the target file.'],
        verificationObligations: ['Verify the parser outcome.'],
        ambiguities: ['Need one more confirmation.'],
      }, null, 2),
      '```',
      'Trailing note.',
    ].join('\n'));

    expect(directive).toMatchObject({
      summary: 'Scout summary',
      confirmedHarness: 'H1_EXECUTE_EVAL',
      evidenceAcquisitionMode: 'diff-bundle',
      scope: ['Confirm task intent.'],
      requiredEvidence: ['Minimal evidence.'],
      reviewFilesOrAreas: ['packages/coding/src/task-engine.ts'],
      userFacingText: 'Scout says the task can stay cheap.',
      skillMap: {
        skillSummary: 'Use the skill map.',
        projectionConfidence: 'medium',
        executionObligations: ['Inspect the target file.'],
        verificationObligations: ['Verify the parser outcome.'],
        ambiguities: ['Need one more confirmation.'],
      },
    });
  });

  it('accepts contract blocks with aliases, inline items, and trailing chatter', () => {
    const directive = __managedProtocolTestables.parseManagedTaskContractDirective([
      'Planner contract visible text.',
      '```kodax-task-contract',
      'summary = Planner summary',
      'successCriteria: complete the task',
      'requiredEvidence:',
      '- supporting diff',
      'constraints: stay focused',
      '```',
      'Planner trailing note.',
    ].join('\n'));

    expect(directive).toEqual({
      summary: 'Planner summary',
      successCriteria: ['complete the task'],
      requiredEvidence: ['supporting diff'],
      constraints: ['stay focused'],
    });
  });

  it('accepts handoff json blocks with aliases and trailing chatter', () => {
    const directive = __managedProtocolTestables.parseManagedTaskHandoffDirective([
      'Validator visible result.',
      '```kodax-task-handoff',
      JSON.stringify({
        status: 'failed.',
        summary: 'Validator summary',
        evidence: ['Observed the bug.'],
        followups: ['Re-run one narrow check.'],
      }, null, 2),
      '```',
      'Trailing note.',
    ].join('\n'));

    expect(directive).toEqual({
      status: 'blocked',
      summary: 'Validator summary',
      evidence: ['Observed the bug.'],
      followup: ['Re-run one narrow check.'],
      userFacingText: 'Validator visible result.',
    });
  });
});

afterEach(async () => {
  delete process.env.KODAX_DEBUG_REPO_INTELLIGENCE;

  mockAnalyzeChangedScope.mockReset();
  mockCreateReasoningPlan.mockReset();
  mockGetImpactEstimate.mockReset();
  mockGetModuleContext.mockReset();
  mockGetRepoOverview.mockReset();
  mockRenderChangedScope.mockClear();
  mockRenderImpactEstimate.mockClear();
  mockRenderModuleContext.mockClear();
  mockRenderRepoOverview.mockClear();
  mockResolveProvider.mockClear();
  mockRunDirectKodaX.mockReset();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await removeDirWithRetries(dir);
    }
  }
});

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

  it('keeps obvious AMA H0 tasks on the direct path without scout', async () => {
    const statuses: KodaXManagedTaskStatusEvent[] = [];
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'lookup',
        taskFamily: 'lookup',
        executionPattern: 'direct',
        recommendedMode: 'lookup',
        harnessProfile: 'H0_DIRECT',
        reason: 'Lookup query should stay direct.',
      }),
    );
    mockRunDirectKodaX.mockResolvedValue(
      buildAssistantResult('状态栏由两个文件管理。'),
    );

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        events: {
          onManagedTaskStatus: (status) => {
            statuses.push(status);
          },
        },
      },
      '现在状态栏是在哪个文件管理的？',
    );

    expect(result.success).toBe(true);
    expect(result.managedTask).toBeUndefined();
    expect(statuses.map((status) => status.phase)).toEqual(['routing']);
    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(1);
  });

  it('keeps foreground AMA workers visible while lifecycle status updates stay compact and non-persistent', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-worker-progress-');
    const statuses: KodaXManagedTaskStatusEvent[] = [];

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
        reason: 'Checked-direct review should surface stable worker progress without streaming full internal text.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        options.events?.onThinkingDelta?.(
          'Tracing the harness boundary and confirming that the review should stay on the checked-direct path.\n',
        );
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H1 for the checked-direct review.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout-worker-progress' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        options.events?.onThinkingDelta?.(
          'Comparing ScrollBox sticky ownership against Claude fullscreen behavior to isolate the most likely gap.\n',
        );
        options.events?.onTextDelta?.(
          'Generator narrowed the issue to sticky viewport budgeting and ScrollBox ownership alignment.\n',
        );
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the checked-direct review pass.'),
          { sessionId: 'session-generator-worker-progress' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Evaluator accepts the checked-direct review.',
            'accept',
            'The checked-direct review is complete and well-supported.',
          ),
          { sessionId: 'session-evaluator-worker-progress' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        events: {
          onManagedTaskStatus: (status) => {
            statuses.push(status);
          },
        },
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Review the current fullscreen transcript behavior and keep the progress visible.',
    );

    expect(result.success).toBe(true);
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'preflight',
          activeWorkerTitle: 'Scout',
          note: 'Scout analyzing task complexity',
        }),
        expect.objectContaining({
          phase: 'worker',
          activeWorkerTitle: 'Generator',
          note: 'Generator starting',
          persistToHistory: false,
          events: expect.arrayContaining([
            expect.objectContaining({
              presentation: 'status',
              persistToHistory: false,
            }),
          ]),
        }),
        expect.objectContaining({
          phase: 'worker',
          activeWorkerTitle: 'Generator',
          note: expect.stringContaining('Generator completed:'),
          persistToHistory: false,
        }),
      ]),
    );
    expect(statuses.some((status) => status.detailNote?.includes('Tracing the harness boundary'))).toBe(false);
    expect(statuses.some((status) => status.detailNote?.includes('sticky viewport budgeting'))).toBe(false);
  });

  it('streams foreground AMA phase content alongside the terminal evaluator answer on coordinated H2 runs', async () => {
    const streamedText: string[] = [];
    const streamedThinking: string[] = [];

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'edit',
        taskFamily: 'implementation',
        executionPattern: 'coordinated',
        recommendedMode: 'implementation',
        complexity: 'complex',
        riskLevel: 'high',
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'code',
        topologyCeiling: 'H2_PLAN_EXECUTE_EVAL',
        upgradeCeiling: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Coordinated H2 runs should surface the terminal evaluator output instead of going silent.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        options.events?.onThinkingDelta?.('SCOUT THINKING SHOULD STAY VISIBLE\n');
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H2 for the coordinated pass.', 'H2_PLAN_EXECUTE_EVAL'),
          { sessionId: 'session-scout-h2-visible-terminal' },
        );
      }
      if (workerPrompt.includes('You are the Planner role')) {
        options.events?.onThinkingDelta?.('PLANNER THINKING SHOULD STAY VISIBLE\n');
        options.events?.onTextDelta?.('PLANNER TEXT SHOULD STAY VISIBLE\n');
        return buildAssistantResult(
          buildContractResponse('Planner prepared the coordinated contract.'),
          { sessionId: 'session-planner-h2-visible-terminal' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        options.events?.onThinkingDelta?.('GENERATOR THINKING SHOULD STAY VISIBLE\n');
        options.events?.onTextDelta?.('GENERATOR TEXT SHOULD STAY VISIBLE\n');
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the coordinated execution pass.'),
          { sessionId: 'session-generator-h2-visible-terminal' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        options.events?.onThinkingDelta?.(
          'Evaluator is checking whether the coordinated result is ready to present.\n',
        );
        options.events?.onTextDelta?.('Evaluator final answer is ready.\n');
        return buildAssistantResult(
          buildVerdictResponse(
            'Evaluator final answer is ready.',
            'accept',
            'The coordinated result is complete and independently verified.',
          ),
          { sessionId: 'session-evaluator-h2-visible-terminal' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        events: {
          onTextDelta: (text) => {
            streamedText.push(text);
          },
          onThinkingDelta: (text) => {
            streamedThinking.push(text);
          },
        },
      },
      'Implement the coordinated change and surface the verified final answer.',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toContain('Evaluator final answer is ready.');
    expect(streamedText.join('')).toContain('PLANNER TEXT SHOULD STAY VISIBLE');
    expect(streamedText.join('')).toContain('GENERATOR TEXT SHOULD STAY VISIBLE');
    expect(streamedText.join('')).toContain('Evaluator final answer is ready.');
    expect(streamedThinking.join('')).toContain('SCOUT THINKING SHOULD STAY VISIBLE');
    expect(streamedThinking.join('')).toContain('PLANNER THINKING SHOULD STAY VISIBLE');
    expect(streamedThinking.join('')).toContain('GENERATOR THINKING SHOULD STAY VISIBLE');
    expect(streamedThinking.join('')).toContain('Evaluator is checking whether the coordinated result is ready to present.');
  });

  it('runs tactical read-only lookup fan-out inside AMA H0 and keeps the parent as final authority', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-tactical-lookup-');
    const evidenceImagePath = path.join(workspaceRoot, 'statusbar.png');
    const statuses: KodaXManagedTaskStatusEvent[] = [];
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'lookup',
        taskFamily: 'lookup',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'lookup',
        complexity: 'moderate',
        riskLevel: 'low',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        topologyCeiling: 'H0_DIRECT',
        reason: 'Read-only lookup should stay tactical and validate module triage in parallel.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout kept the lookup on H0 and recommended bounded module triage.',
            'H0_DIRECT',
          ),
          { sessionId: 'session-scout-tactical-lookup' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Lookup Scanner')) {
        return buildAssistantResult(
          [
            'Scanner found two module-triage shards worth validating.',
            '```kodax-lookup-shards',
            JSON.stringify({
              summary: 'Scanner identified two lookup shards.',
              shards: [
                {
                  id: 'lookup-1',
                  question: 'Does StatusBar.tsx own the live status rendering?',
                  scope: 'Status bar live rendering',
                  priority: 'high',
                  paths: ['packages/repl/src/ui/components/StatusBar.tsx'],
                  rationale: ['The component name matches the user-visible surface directly.'],
                },
                {
                  id: 'lookup-2',
                  question: 'Is InkREPL.tsx only a wrapper around the status bar?',
                  scope: 'InkREPL wrapper role',
                  priority: 'medium',
                  paths: ['packages/repl/src/ui/InkREPL.tsx'],
                  rationale: ['This path could still own orchestration rather than rendering.'],
                },
              ],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-scan-tactical-lookup' },
        );
      }
      if (workerPrompt.includes('[Shard ID] lookup-1')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator confirmed StatusBar.tsx owns the live status rendering.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'lookup-1',
              fanoutClass: 'module-triage',
              status: 'completed',
              disposition: 'valid',
              summary: 'Lookup shard 1 confirms StatusBar.tsx owns the live status rendering.',
              evidenceRefs: ['packages/repl/src/ui/components/StatusBar.tsx'],
              contradictions: [],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-lookup-validator-1' },
        );
      }
      if (workerPrompt.includes('[Shard ID] lookup-2')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator found InkREPL.tsx orchestrates layout but does not own live status rendering.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'lookup-2',
              fanoutClass: 'module-triage',
              status: 'completed',
              disposition: 'false-positive',
              summary: 'Lookup shard 2 weakens the idea that InkREPL.tsx owns the live status rendering.',
              evidenceRefs: ['packages/repl/src/ui/InkREPL.tsx'],
              contradictions: ['InkREPL composes the footer but does not render the status component itself.'],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-lookup-validator-2' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Lookup Reducer')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Reducer completed the tactical lookup.',
            'accept',
            'Validator evidence is sufficient for the parent lookup answer.',
            {
              userAnswer: [
                'The live status rendering is owned by `packages/repl/src/ui/components/StatusBar.tsx`.',
                '',
                '`InkREPL.tsx` still orchestrates the surrounding layout, but it is not the component that renders the live status line itself.',
              ].join('\n'),
            },
          ),
          { sessionId: 'session-lookup-reducer' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        events: {
          onManagedTaskStatus: (status) => {
            statuses.push(status);
          },
        },
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
          inputArtifacts: [
            {
              kind: 'image',
              path: evidenceImagePath,
              mediaType: 'image/png',
              source: 'user-inline',
              description: 'Attached image statusbar.png',
            },
          ],
        },
      },
      'Where is the live status rendering logic defined right now?',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toContain('packages/repl/src/ui/components/StatusBar.tsx');
    expect(result.managedTask?.runtime?.amaProfile).toBe('tactical');
    expect(result.managedTask?.runtime?.amaFanout?.class).toBe('module-triage');
    expect(result.managedTask?.runtime?.childContextBundles).toHaveLength(2);
    expect(result.managedTask?.runtime?.fanoutSchedulerPlan?.fanoutClass).toBe('module-triage');
    expect(
      result.managedTask?.evidence.artifacts.some(
        (artifact) => artifact.kind === 'image' && artifact.path === evidenceImagePath,
      ),
    ).toBe(true);
    expect(statuses.some((status) => status.childFanoutClass === 'module-triage')).toBe(true);
  });

  it('lets Scout downshift a managed run back to H0 and return early', async () => {
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: false,
        reason: 'Review request starts in checked-direct mode.',
      }),
    );
    mockRunDirectKodaX
      .mockResolvedValueOnce(
        buildAssistantResult(
          buildScoutResponse(
            'Scout determined this is small enough to answer directly.',
            'H0_DIRECT',
          ),
        ),
      )
      .mockResolvedValueOnce(
        buildAssistantResult('直接路径给出了最终答案。'),
      );

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
      },
      '请快速 review 一下这个很小的改动',
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(1);
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.roleAssignments.map((item) => item.role)).toEqual(['scout']);
    expect(result.routingDecision?.harnessProfile).toBe('H0_DIRECT');
    expect(result.lastText).toContain('Scout determined this is small enough to answer directly.');

    // Verify Scout H0 has no tool restrictions (undefined toolPolicy)
    const scoutAssignment = result.managedTask?.roleAssignments.find((a) => a.role === 'scout');
    expect(scoutAssignment?.toolPolicy).toBeUndefined();
  });

  it('allows large current-diff reviews to stay on H0 when Scout provides complete direct-review evidence', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-large-review-floor-root-');
    const repoRoot = await createTempDir('kodax-task-engine-large-review-floor-repo-');

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'direct',
        recommendedMode: 'pr-review',
        complexity: 'complex',
        riskLevel: 'medium',
        mutationSurface: 'read-only',
        harnessProfile: 'H1_EXECUTE_EVAL',
        reviewScale: 'large',
        needsIndependentQA: false,
        topologyCeiling: 'H2_PLAN_EXECUTE_EVAL',
        upgradeCeiling: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Large current-diff reviews should stay direct when Scout already has complete review evidence.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            [
              '## Findings',
              '',
              '- [high] `packages/coding/src/task-engine.ts`: duplicated normalization paths can diverge.',
              '- [medium] `packages/repl/src/ui/InkREPL.tsx`: managed live events need durable transcript persistence.',
            ].join('\n'),
            'H0_DIRECT',
            {
              harnessRationale: 'The key diff and risk areas are already inspected, so a direct findings-first review is ready now.',
              directCompletionReady: 'yes',
              blockingEvidence: ['none'],
            },
          ),
          { sessionId: 'session-scout-large-review-floor' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
          executionCwd: repoRoot,
          gitRoot: repoRoot,
          repoIntelligenceMode: 'off',
          repoRoutingSignals: buildRepoRoutingSignals({
            workspaceRoot: repoRoot,
            changedFileCount: 23,
            changedLineCount: 2797,
            addedLineCount: 2518,
            deletedLineCount: 279,
            touchedModuleCount: 3,
            changedModules: ['packages/coding', 'packages/repl', 'docs'],
            crossModule: true,
          }),
        },
      },
      'Please review the current repository changes for merge blockers and give me the final review findings.',
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(1);
    expect(result.routingDecision?.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.roleAssignments.map((item) => item.role)).toEqual(['scout']);
    expect(result.managedTask?.runtime?.routingOverrideReason).toBeUndefined();
    expect(result.lastText).toContain('## Findings');
    expect(result.lastText).toContain('duplicated normalization paths can diverge');
  });

  it('keeps a minimum of H1 when the task explicitly requires independent verification', async () => {
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        mutationSurface: 'read-only',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        topologyCeiling: 'H2_PLAN_EXECUTE_EVAL',
        upgradeCeiling: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'The task explicitly requires an independent second judgment.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout thinks the review could probably finish directly.',
            'H0_DIRECT',
            {
              harnessRationale: 'The key files are understood, but the controller should only allow H0 if no QA guardrail applies.',
              directCompletionReady: 'yes',
              blockingEvidence: ['none'],
            },
          ),
          { sessionId: 'session-scout-explicit-qa-floor' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator prepared the review findings for independent evaluation.'),
          { sessionId: 'session-generator-explicit-qa-floor' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          buildVerdictResponse(
            '## Findings\n\n- [medium] `packages/coding/src/task-engine.ts`: independent verification confirmed the scoped issue.',
            'accept',
            'Independent verification completed successfully.',
          ),
          { sessionId: 'session-evaluator-explicit-qa-floor' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
      },
      'Please review these changes and make sure an independent verifier signs off before we trust the result.',
    );

    expect(result.routingDecision?.harnessProfile).toBe('H1_EXECUTE_EVAL');
    expect(result.managedTask?.contract.harnessProfile).toBe('H1_EXECUTE_EVAL');
    expect(result.managedTask?.roleAssignments.map((item) => item.role)).toEqual(['generator', 'evaluator']);
    expect(result.managedTask?.runtime?.routingOverrideReason).toContain('independent verification was explicitly requested');
    expect(result.lastText).toContain('## Findings');
  });

  it('keeps a minimum of H2 for high-risk system-level overwrite work', async () => {
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'edit',
        taskFamily: 'implementation',
        executionPattern: 'direct',
        recommendedMode: 'implementation',
        complexity: 'systemic',
        riskLevel: 'high',
        mutationSurface: 'system',
        workIntent: 'overwrite',
        harnessProfile: 'H1_EXECUTE_EVAL',
        topologyCeiling: 'H2_PLAN_EXECUTE_EVAL',
        upgradeCeiling: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'This is a risky system-level overwrite and must keep a coordinated execution floor.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout thinks the edit path looks straightforward.',
            'H0_DIRECT',
            {
              harnessRationale: 'The scout believes the edit is conceptually simple, but hard guardrails may still apply.',
              directCompletionReady: 'yes',
              blockingEvidence: ['none'],
            },
          ),
          { sessionId: 'session-scout-system-floor' },
        );
      }
      if (workerPrompt.includes('You are the Planner role')) {
        return buildAssistantResult(
          buildContractResponse('Planner decomposed the risky system edit before execution.'),
          { sessionId: 'session-planner-system-floor' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the coordinated system edit handoff.'),
          { sessionId: 'session-generator-system-floor' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'System edit completed under the coordinated H2 guardrail.',
            'accept',
            'The high-risk overwrite guardrail required coordinated execution.',
          ),
          { sessionId: 'session-evaluator-system-floor' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
      },
      'Apply this risky system-wide overwrite across the codebase and make sure the final result is coordinated safely.',
    );

    expect(result.routingDecision?.harnessProfile).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(result.managedTask?.contract.harnessProfile).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(result.managedTask?.roleAssignments.map((item) => item.role)).toEqual(['planner', 'generator', 'evaluator']);
    expect(result.managedTask?.runtime?.routingOverrideReason).toContain('high-risk system-level mutation requires coordinated execution');
    expect(result.lastText).toContain('System edit completed');
  });

  it('retries Scout when H0_DIRECT declares directCompletionReady as no instead of yes', async () => {
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        mutationSurface: 'read-only',
        harnessProfile: 'H0_DIRECT',
        topologyCeiling: 'H2_PLAN_EXECUTE_EVAL',
        upgradeCeiling: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Scout should be able to complete the review directly once the structured payload is consistent.',
      }),
    );

    let scoutAttempts = 0;
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (!workerPrompt.includes('You are the Scout role')) {
        throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
      }
      expect(workerPrompt).toContain('harness_rationale');
      expect(workerPrompt).toContain('direct_completion_ready');
      expect(workerPrompt).toContain('blocking_evidence');
      expect(workerPrompt).toContain('changed file count');
      scoutAttempts += 1;
      if (scoutAttempts === 1) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout has enough evidence, but forgot the readiness field.',
            'H0_DIRECT',
            {
              directCompletionReady: 'no',
              blockingEvidence: ['none'],
              harnessRationale: 'This should be retried because H0 requires explicit readiness.',
            },
          ),
          { sessionId: 'session-scout-invalid-h0' },
        );
      }
      return buildAssistantResult(
        buildScoutResponse(
          '## Findings\n\n- [low] `packages/coding/src/task-engine.ts`: the retry path now preserves H0 when the scout evidence is complete.',
          'H0_DIRECT',
          {
            harnessRationale: 'The retry produced a complete direct-review payload with all required evidence fields.',
            directCompletionReady: 'yes',
            blockingEvidence: ['none'],
          },
        ),
        { sessionId: 'session-scout-valid-h0' },
      );
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
      },
      'Please review the current code changes and tell me if the new routing behavior is safe to merge.',
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(2);
    expect(result.routingDecision?.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
    expect(result.lastText).toContain('## Findings');
    expect(result.lastText).toContain('retry path now preserves H0');
  });

  it('runs tactical review child fan-out inside AMA H0 and keeps the parent as final authority', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-tactical-review-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        topologyCeiling: 'H0_DIRECT',
        reason: 'Read-only review should stay tactical and use hidden child validators.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout kept the task on H0 and recommended tactical validation.',
            'H0_DIRECT',
          ),
          { sessionId: 'session-scout-tactical-review' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Review Scanner')) {
        return buildAssistantResult(
          [
            'Scanner found two candidate findings worth validation.',
            '```kodax-review-findings',
            JSON.stringify({
              summary: 'Scanner identified two candidate findings.',
              findings: [
                {
                  id: 'finding-1',
                  title: 'Null guard removed',
                  claim: 'The retry path dropped a defensive null guard.',
                  priority: 'high',
                  files: ['packages/coding/src/reasoning.ts'],
                  evidence: ['Null guard disappeared from the retry path.'],
                },
                {
                  id: 'finding-2',
                  title: 'Timeout reset regression',
                  claim: 'Timeout still resets the counter unexpectedly.',
                  priority: 'medium',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['Timeout branch still mutates the counter.'],
                },
              ],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-scan-tactical-review' },
        );
      }
      if (workerPrompt.includes('[Finding ID] finding-1')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator confirmed the null guard issue is real.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'finding-1',
              fanoutClass: 'finding-validation',
              status: 'completed',
              disposition: 'valid',
              summary: 'Finding 1 is valid.',
              evidenceRefs: ['packages/coding/src/reasoning.ts'],
              contradictions: [],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-validator-1' },
        );
      }
      if (workerPrompt.includes('[Finding ID] finding-2')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator ruled the timeout reset report a false positive.', 'ready'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'finding-2',
              fanoutClass: 'finding-validation',
              status: 'completed',
              disposition: 'false-positive',
              summary: 'Finding 2 is a false positive.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: ['The timeout branch preserves the counter in the current code.'],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-validator-2' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Review Reducer')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Reducer completed the tactical review.',
            'accept',
            'Validator evidence is sufficient for the final review.',
            {
              userAnswer: [
                '## Findings',
                '',
                '- The retry path dropped a defensive null guard and can now dereference a missing value.',
                '',
                'No other validator-backed findings remain.',
              ].join('\n'),
            },
          ),
          { sessionId: 'session-review-reducer' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Please review the current changes for merge blockers.',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toContain('## Findings');
    expect(result.lastText).toContain('dropped a defensive null guard');
    expect(result.lastText).not.toContain('Timeout reset regression');
    expect(result.managedTask?.runtime?.amaProfile).toBe('tactical');
    expect(result.managedTask?.runtime?.amaFanout?.class).toBe('finding-validation');
    expect(result.managedTask?.runtime?.childContextBundles).toHaveLength(2);
    expect(result.managedTask?.runtime?.childAgentResults).toHaveLength(2);
    expect(result.managedTask?.runtime?.parentReductionContract).toEqual(
      expect.objectContaining({
        owner: 'parent',
        strategy: 'evaluator-assisted',
        collapseChildTranscripts: true,
      }),
    );
    expect(result.managedTask?.roleAssignments.map((assignment) => assignment.id)).toEqual(
      expect.arrayContaining(['review-scan', 'validator-01', 'validator-02', 'review-reducer']),
    );
    expect(result.managedTask?.evidence.artifacts.map((artifact) => artifact.path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('review-findings.json'),
        expect.stringContaining('child-result.json'),
        expect.stringContaining('child-result-ledger.json'),
      ]),
    );
  });

  it('keeps overflow tactical review findings in the ledger and defers the unscheduled bundles', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-tactical-review-overflow-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        reviewScale: 'large',
        topologyCeiling: 'H0_DIRECT',
        reason: 'Read-only review should stay tactical and defer overflow findings through the scheduler.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout kept the task on H0 and recommended tactical validation.',
            'H0_DIRECT',
          ),
          { sessionId: 'session-scout-tactical-review-overflow' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Review Scanner')) {
        return buildAssistantResult(
          [
            'Scanner found four candidate findings worth validation.',
            '```kodax-review-findings',
            JSON.stringify({
              summary: 'Scanner identified four candidate findings.',
              findings: [
                {
                  id: 'finding-1',
                  title: 'Null guard removed',
                  claim: 'The retry path dropped a defensive null guard.',
                  priority: 'high',
                  files: ['packages/coding/src/reasoning.ts'],
                  evidence: ['Null guard disappeared from the retry path.'],
                },
                {
                  id: 'finding-2',
                  title: 'Timeout reset regression',
                  claim: 'Timeout still resets the counter unexpectedly.',
                  priority: 'medium',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['Timeout branch still mutates the counter.'],
                },
                {
                  id: 'finding-3',
                  title: 'Budget note missing',
                  claim: 'The degraded continue note is not emitted on blocked runs.',
                  priority: 'medium',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['Blocked runs no longer append the degraded note.'],
                },
                {
                  id: 'finding-4',
                  title: 'Deferred review candidate',
                  claim: 'One more finding should remain deferred when the child budget is exhausted.',
                  priority: 'low',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['Fourth finding exists only to exercise scheduler deferral.'],
                },
              ],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-scan-tactical-review-overflow' },
        );
      }
      if (workerPrompt.includes('[Finding ID] finding-1')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator confirmed the null guard issue is real.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'finding-1',
              fanoutClass: 'finding-validation',
              status: 'completed',
              disposition: 'valid',
              summary: 'Finding 1 is valid.',
              evidenceRefs: ['packages/coding/src/reasoning.ts'],
              contradictions: [],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-validator-overflow-1' },
        );
      }
      if (workerPrompt.includes('[Finding ID] finding-2')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator ruled the timeout reset report a false positive.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'finding-2',
              fanoutClass: 'finding-validation',
              status: 'completed',
              disposition: 'false-positive',
              summary: 'Finding 2 is a false positive.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: ['The timeout branch preserves the counter in the current code.'],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-validator-overflow-2' },
        );
      }
      if (workerPrompt.includes('[Finding ID] finding-3')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator confirmed the degraded-note issue is real.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'finding-3',
              fanoutClass: 'finding-validation',
              status: 'completed',
              disposition: 'valid',
              summary: 'Finding 3 is valid.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: [],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-validator-overflow-3' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Review Reducer')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Reducer tried to finalize the tactical review.',
            'accept',
            'Validator evidence is sufficient for the final review.',
            {
              userAnswer: [
                '## Findings',
                '',
                '- Finding 1 is valid.',
                '- Finding 3 is valid.',
              ].join('\n'),
            },
          ),
          { sessionId: 'session-review-reducer-overflow' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Please review the current changes for merge blockers.',
    );

    expect(result.success).toBe(false);
    expect(result.lastText).toContain('The review cannot be finalized yet');
    expect(result.lastText).toContain('Deferred review candidate');
    expect(result.lastText).toContain('Finding 1 is valid.');
    expect(result.managedTask?.runtime?.childContextBundles).toHaveLength(4);
    expect(result.managedTask?.runtime?.childAgentResults).toHaveLength(3);
    expect(result.managedTask?.runtime?.fanoutSchedulerPlan?.scheduledBundleIds).toEqual([
      'finding-1',
      'finding-2',
      'finding-3',
    ]);
    expect(result.managedTask?.runtime?.fanoutSchedulerPlan?.deferredBundleIds).toEqual(['finding-4']);
    expect(result.managedTask?.runtime?.fanoutSchedulerPlan?.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bundleId: 'finding-1', status: 'completed' }),
        expect.objectContaining({ bundleId: 'finding-2', status: 'completed' }),
        expect.objectContaining({ bundleId: 'finding-3', status: 'completed' }),
        expect.objectContaining({ bundleId: 'finding-4', status: 'deferred' }),
      ]),
    );
  });

  it('fails closed when a validator omits kodax-child-result and ignores reducer optimism without ledger proof', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-tactical-review-fail-closed-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        topologyCeiling: 'H0_DIRECT',
        reason: 'Read-only review should stay tactical and fail closed on malformed child results.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout kept the task on H0 and recommended tactical validation.',
            'H0_DIRECT',
          ),
          { sessionId: 'session-scout-tactical-review-fail-closed' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Review Scanner')) {
        return buildAssistantResult(
          [
            'Scanner found two candidate findings worth validation.',
            '```kodax-review-findings',
            JSON.stringify({
              summary: 'Scanner identified two candidate findings.',
              findings: [
                {
                  id: 'finding-1',
                  title: 'Missing structured validator output',
                  claim: 'The child validator never returns a structured result.',
                  priority: 'high',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['This finding exists to exercise fail-closed reduction.'],
                },
                {
                  id: 'finding-2',
                  title: 'False-positive sibling',
                  claim: 'The sibling finding should still be evaluated normally.',
                  priority: 'medium',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['This sibling finding provides a structured comparison point.'],
                },
              ],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-scan-tactical-review-fail-closed' },
        );
      }
      if (workerPrompt.includes('[Finding ID] finding-1')) {
        return buildAssistantResult(
          buildHandoffResponse('Validator insists the finding is real but forgets the structured block.'),
          { sessionId: 'session-validator-fail-closed-1' },
        );
      }
      if (workerPrompt.includes('[Finding ID] finding-2')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator ruled the sibling report a false positive.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'finding-2',
              fanoutClass: 'finding-validation',
              status: 'completed',
              disposition: 'false-positive',
              summary: 'Finding 2 is a false positive.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: ['The sibling issue does not reproduce in the current code.'],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-validator-fail-closed-2' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Review Reducer')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Reducer believes the review is complete.',
            'accept',
            'The reducer thinks the review is done.',
            {
              userAnswer: [
                '## Findings',
                '',
                '- Reducer says the first finding is valid and ready to publish.',
              ].join('\n'),
            },
          ),
          { sessionId: 'session-review-reducer-fail-closed' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Please review the current changes for merge blockers.',
    );

    expect(result.success).toBe(false);
    expect(result.lastText).toContain('The review cannot be finalized yet');
    expect(result.lastText).toContain('Missing structured validator output');
    expect(result.lastText).not.toContain('Reducer says the first finding is valid and ready to publish.');
    expect(result.managedTask?.runtime?.childAgentResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childId: 'finding-1',
          disposition: 'needs-more-evidence',
          contradictions: ['Missing or malformed structured child result.'],
        }),
      ]),
    );
    expect(result.managedTask?.evidence.artifacts.map((artifact) => artifact.path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('child-result-ledger.json'),
        expect.stringContaining('child-result-ledger.md'),
      ]),
    );
  });

  it('fails closed when structured child results are missing a ready handoff or completion status', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-tactical-review-handoff-contract-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        topologyCeiling: 'H0_DIRECT',
        reason: 'Read-only review should fail closed on incomplete child contracts.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout kept the task on H0 and recommended tactical validation.',
            'H0_DIRECT',
          ),
          { sessionId: 'session-scout-tactical-review-handoff-contract' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Review Scanner')) {
        return buildAssistantResult(
          [
            'Scanner found two candidate findings worth validation.',
            '```kodax-review-findings',
            JSON.stringify({
              summary: 'Scanner identified two candidate findings.',
              findings: [
                {
                  id: 'finding-1',
                  title: 'Missing handoff',
                  claim: 'The validator returns a structured result without a ready handoff.',
                  priority: 'high',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['This finding exists to exercise handoff fail-closed behavior.'],
                },
                {
                  id: 'finding-2',
                  title: 'Blocked structured result',
                  claim: 'The validator returns a structured result that is not completed.',
                  priority: 'medium',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['This finding exists to exercise child status fail-closed behavior.'],
                },
              ],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-scan-tactical-review-handoff-contract' },
        );
      }
      if (workerPrompt.includes('[Finding ID] finding-1')) {
        return buildAssistantResult(
          [
            '```kodax-child-result',
            JSON.stringify({
              childId: 'finding-1',
              fanoutClass: 'finding-validation',
              status: 'completed',
              disposition: 'valid',
              summary: 'Finding 1 would be valid if the handoff existed.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: [],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-validator-handoff-contract-1' },
        );
      }
      if (workerPrompt.includes('[Finding ID] finding-2')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator could not complete the check but still emitted a result.', 'ready'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'finding-2',
              fanoutClass: 'finding-validation',
              status: 'blocked',
              disposition: 'valid',
              summary: 'Finding 2 is not actually complete.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: ['The validator stopped before producing a complete result.'],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-validator-handoff-contract-2' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Review Reducer')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Reducer tried to finalize the tactical review.',
            'accept',
            'The reducer thinks the review is done.',
            {
              userAnswer: [
                '## Findings',
                '',
                '- Reducer says both findings are ready to publish.',
              ].join('\n'),
            },
          ),
          { sessionId: 'session-review-reducer-handoff-contract' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Please review the current changes for merge blockers.',
    );

    expect(result.success).toBe(false);
    expect(result.lastText).toContain('The review cannot be finalized yet');
    expect(result.lastText).toContain('Missing handoff');
    expect(result.lastText).toContain('Blocked structured result');
    expect(result.lastText).not.toContain('Reducer says both findings are ready to publish.');
    expect(result.managedTask?.runtime?.childAgentResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childId: 'finding-1',
          disposition: 'needs-more-evidence',
          contradictions: ['Missing validator handoff block.'],
        }),
        expect.objectContaining({
          childId: 'finding-2',
          disposition: 'needs-more-evidence',
          contradictions: ['Structured child result status was blocked.'],
        }),
      ]),
    );
  });

  it('canonicalizes duplicate scanner finding ids before scheduling validator branches', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-tactical-review-duplicates-');
    let findingOneValidatorRuns = 0;
    const statuses: KodaXManagedTaskStatusEvent[] = [];
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        topologyCeiling: 'H0_DIRECT',
        reason: 'Read-only review should canonicalize duplicate findings before validation.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout kept the task on H0 and recommended tactical validation.',
            'H0_DIRECT',
          ),
          { sessionId: 'session-scout-tactical-review-duplicates' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Review Scanner')) {
        return buildAssistantResult(
          [
            'Scanner found three candidate findings, including one duplicate id.',
            '```kodax-review-findings',
            JSON.stringify({
              summary: 'Scanner identified three candidate findings with one duplicate id.',
              findings: [
                {
                  id: 'finding-1',
                  title: 'Canonical finding',
                  claim: 'The canonical finding should only validate once.',
                  priority: 'high',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['First occurrence.'],
                },
                {
                  id: 'finding-1',
                  title: 'Duplicate finding',
                  claim: 'The duplicate should not create a second validator.',
                  priority: 'medium',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['Duplicate occurrence.'],
                },
                {
                  id: 'finding-2',
                  title: 'Sibling finding',
                  claim: 'The sibling finding should validate normally.',
                  priority: 'medium',
                  files: ['packages/coding/src/reasoning.ts'],
                  evidence: ['Independent sibling finding.'],
                },
              ],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-scan-tactical-review-duplicates' },
        );
      }
      if (workerPrompt.includes('[Finding ID] finding-1')) {
        findingOneValidatorRuns += 1;
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator confirmed the canonical finding.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'finding-1',
              fanoutClass: 'finding-validation',
              status: 'completed',
              disposition: 'valid',
              summary: 'Finding 1 is valid.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: [],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-validator-duplicates-1' },
        );
      }
      if (workerPrompt.includes('[Finding ID] finding-2')) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator ruled the sibling finding a false positive.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'finding-2',
              fanoutClass: 'finding-validation',
              status: 'completed',
              disposition: 'false-positive',
              summary: 'Finding 2 is a false positive.',
              evidenceRefs: ['packages/coding/src/reasoning.ts'],
              contradictions: ['The sibling issue does not reproduce.'],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-validator-duplicates-2' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Review Reducer')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Reducer completed the tactical review.',
            'accept',
            'Validator evidence is sufficient for the final review.',
            {
              userAnswer: [
                '## Findings',
                '',
                '- The canonical finding is valid.',
              ].join('\n'),
            },
          ),
          { sessionId: 'session-review-reducer-duplicates' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        events: {
          onManagedTaskStatus: (status) => {
            statuses.push(status);
          },
        },
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Please review the current changes for merge blockers.',
    );

    expect(result.success).toBe(true);
    expect(findingOneValidatorRuns).toBe(1);
    expect(result.managedTask?.runtime?.childContextBundles).toHaveLength(2);
    expect(result.managedTask?.runtime?.fanoutSchedulerPlan?.branches.map((branch) => branch.bundleId)).toEqual([
      'finding-1',
      'finding-2',
    ]);
    expect(result.managedTask?.runtime?.childAgentResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ childId: 'finding-1' }),
        expect.objectContaining({ childId: 'finding-2' }),
      ]),
    );
    const fanoutWorkerCounts = statuses
      .filter((status) => status.phase === 'worker' && status.childFanoutClass === 'finding-validation')
      .map((status) => status.childFanoutCount);
    expect(fanoutWorkerCounts).toContain(2);
    expect(fanoutWorkerCounts).toContain(1);
    expect(fanoutWorkerCounts).toContain(0);
  });

  it('runs tactical read-only investigation fan-out inside AMA H0 and keeps the parent as final authority', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-tactical-investigation-');
    const statuses: KodaXManagedTaskStatusEvent[] = [];
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'bugfix',
        taskFamily: 'investigation',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'investigation',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        topologyCeiling: 'H0_DIRECT',
        reason: 'Read-only investigation should stay tactical and validate evidence in parallel.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout kept the investigation on H0 and recommended bounded evidence validation.',
            'H0_DIRECT',
          ),
          { sessionId: 'session-scout-tactical-investigation' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Investigation Scanner')) {
        return buildAssistantResult(
          [
            'Scanner found two evidence shards worth validating.',
            '```kodax-investigation-shards',
            JSON.stringify({
              summary: 'Scanner identified two investigation shards.',
              shards: [
                {
                  id: 'shard-1',
                  question: 'Does the retry path swallow the root cause error?',
                  scope: 'Retry root-cause propagation',
                  priority: 'high',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['Retry branch wraps errors before surfacing them.'],
                },
                {
                  id: 'shard-2',
                  question: 'Is the timeout counter reset still a real contributor?',
                  scope: 'Timeout counter branch',
                  priority: 'medium',
                  files: ['packages/coding/src/reasoning.ts'],
                  evidence: ['Timeout branch was previously blamed in the report.'],
                },
              ],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-scan-tactical-investigation' },
        );
      }
      if (workerPrompt.includes('[Shard ID] shard-1')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator confirmed the retry path hides the root cause.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'shard-1',
              fanoutClass: 'evidence-scan',
              status: 'completed',
              disposition: 'valid',
              summary: 'Shard 1 confirmed the retry path hides the root cause error.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: [],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-investigation-validator-1' },
        );
      }
      if (workerPrompt.includes('[Shard ID] shard-2')) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator ruled the timeout counter reset out as a primary cause.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'shard-2',
              fanoutClass: 'evidence-scan',
              status: 'completed',
              disposition: 'false-positive',
              summary: 'Shard 2 weakens the timeout-counter theory.',
              evidenceRefs: ['packages/coding/src/reasoning.ts'],
              contradictions: ['Timeout counter state remains intact in the current code path.'],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-investigation-validator-2' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Investigation Reducer')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Reducer completed the tactical investigation.',
            'accept',
            'Validator evidence is sufficient for the parent diagnosis.',
            {
              userAnswer: [
                '## Investigation Update',
                '',
                'The retry path is still the most likely root cause because it hides the original error before surfacing it.',
                '',
                'The timeout-counter hypothesis did not hold up under validator-backed evidence.',
              ].join('\n'),
            },
          ),
          { sessionId: 'session-investigation-reducer' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        events: {
          onManagedTaskStatus: (status) => {
            statuses.push(status);
          },
        },
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Investigate why the retry path still reports the wrong failure to users.',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toContain('## Investigation Update');
    expect(result.lastText).toContain('retry path is still the most likely root cause');
    expect(result.managedTask?.runtime?.amaProfile).toBe('tactical');
    expect(result.managedTask?.runtime?.amaFanout?.class).toBe('evidence-scan');
    expect(result.managedTask?.runtime?.childContextBundles).toHaveLength(2);
    expect(result.managedTask?.runtime?.childAgentResults).toHaveLength(1);
    expect(result.managedTask?.runtime?.fanoutSchedulerPlan?.fanoutClass).toBe('evidence-scan');
    expect(result.managedTask?.runtime?.fanoutSchedulerPlan?.cancellationPolicy).toBe('winner-cancel');
    expect(result.managedTask?.runtime?.fanoutSchedulerPlan?.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bundleId: 'shard-2',
          status: 'cancelled',
        }),
      ]),
    );
    const fanoutWorkerCounts = statuses
      .filter((status) => status.phase === 'worker' && status.childFanoutClass === 'evidence-scan')
      .map((status) => status.childFanoutCount);
    expect(fanoutWorkerCounts).toContain(2);
    expect(fanoutWorkerCounts).toContain(0);
  });

  it('applies deterministic winner-cancel for investigation once a high-priority shard is sufficient', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-tactical-investigation-cancel-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'bugfix',
        taskFamily: 'investigation',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'investigation',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        topologyCeiling: 'H0_DIRECT',
        reason: 'Read-only investigation should cancel lower-priority shards once a high-priority winner is clear.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout kept the investigation on H0 and recommended bounded evidence validation.',
            'H0_DIRECT',
          ),
          { sessionId: 'session-scout-tactical-investigation-cancel' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Investigation Scanner')) {
        return buildAssistantResult(
          [
            'Scanner found two evidence shards worth validating.',
            '```kodax-investigation-shards',
            JSON.stringify({
              summary: 'Scanner identified two investigation shards.',
              shards: [
                {
                  id: 'shard-1',
                  question: 'Does the retry path hide the root cause?',
                  scope: 'Retry root-cause propagation',
                  priority: 'high',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['This is the decisive shard for the current diagnosis.'],
                },
                {
                  id: 'shard-2',
                  question: 'Does the metrics side-path contribute anything material?',
                  scope: 'Metrics side-path',
                  priority: 'low',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['This shard should be cancellable once the primary cause is confirmed.'],
                },
              ],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-scan-tactical-investigation-cancel' },
        );
      }
      if (workerPrompt.includes('[Shard ID] shard-1')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator confirmed the retry path hides the root cause.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'shard-1',
              fanoutClass: 'evidence-scan',
              status: 'completed',
              disposition: 'valid',
              summary: 'Shard 1 confirmed the retry path hides the root cause.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: [],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-investigation-cancel-1' },
        );
      }
      if (workerPrompt.includes('[Shard ID] shard-2')) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return buildAssistantResult(
          [
            buildHandoffResponse('Late validator result should be ignored after cancellation.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'shard-2',
              fanoutClass: 'evidence-scan',
              status: 'completed',
              disposition: 'false-positive',
              summary: 'Shard 2 eventually completed, but the parent had already cancelled it.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: ['Late result should not affect the finalized diagnosis.'],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-investigation-cancel-2' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Investigation Reducer')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Reducer completed the tactical investigation.',
            'accept',
            'High-priority validator evidence is sufficient for the diagnosis.',
            {
              userAnswer: [
                '## Investigation Update',
                '',
                'The retry path remains the confirmed root cause.',
              ].join('\n'),
            },
          ),
          { sessionId: 'session-investigation-reducer-cancel' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Investigate why the retry path still reports the wrong failure to users.',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toContain('retry path remains the confirmed root cause');
    expect(result.managedTask?.runtime?.fanoutSchedulerPlan?.cancellationPolicy).toBe('winner-cancel');
    expect(result.managedTask?.runtime?.fanoutSchedulerPlan?.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bundleId: 'shard-2',
          status: 'cancelled',
        }),
      ]),
    );
    expect(result.managedTask?.runtime?.childAgentResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childId: 'shard-1',
          disposition: 'valid',
        }),
      ]),
    );
    expect(result.managedTask?.runtime?.childAgentResults).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childId: 'shard-2',
        }),
      ]),
    );
  });

  it('keeps overflow tactical investigation shards in the ledger and forces revise when a high-priority shard is deferred', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-tactical-investigation-overflow-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'bugfix',
        taskFamily: 'investigation',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'investigation',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        topologyCeiling: 'H0_DIRECT',
        reason: 'Read-only investigation should defer overflow evidence shards through the scheduler.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout kept the investigation on H0 and recommended bounded evidence validation.',
            'H0_DIRECT',
          ),
          { sessionId: 'session-scout-tactical-investigation-overflow' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Investigation Scanner')) {
        return buildAssistantResult(
          [
            'Scanner found four evidence shards worth validating.',
            '```kodax-investigation-shards',
            JSON.stringify({
              summary: 'Scanner identified four investigation shards.',
              shards: [
                {
                  id: 'shard-1',
                  question: 'Does the retry path hide the root cause?',
                  scope: 'Retry root-cause propagation',
                  priority: 'high',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['Retry wrapper still suppresses the underlying error.'],
                },
                {
                  id: 'shard-2',
                  question: 'Does the timeout counter remain intact?',
                  scope: 'Timeout counter branch',
                  priority: 'medium',
                  files: ['packages/coding/src/reasoning.ts'],
                  evidence: ['Timeout counter branch is implicated in the report.'],
                },
                {
                  id: 'shard-3',
                  question: 'Does the logger preserve the hidden root cause text?',
                  scope: 'Logger root-cause handoff',
                  priority: 'high',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['Logger handoff may still hide the message.'],
                },
                {
                  id: 'shard-4',
                  question: 'Is a tertiary metrics path involved?',
                  scope: 'Metrics side-path',
                  priority: 'low',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['Low-priority branch used to exercise deferral.'],
                },
              ],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-scan-tactical-investigation-overflow' },
        );
      }
      if (workerPrompt.includes('[Shard ID] shard-1')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator confirmed the retry path issue.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'shard-1',
              fanoutClass: 'evidence-scan',
              status: 'completed',
              disposition: 'valid',
              summary: 'Shard 1 confirmed the retry path hides the root cause.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: [],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-investigation-overflow-1' },
        );
      }
      if (workerPrompt.includes('[Shard ID] shard-2')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator weakened the timeout branch theory.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'shard-2',
              fanoutClass: 'evidence-scan',
              status: 'completed',
              disposition: 'false-positive',
              summary: 'Shard 2 weakens the timeout branch theory.',
              evidenceRefs: ['packages/coding/src/reasoning.ts'],
              contradictions: ['Timeout state remains intact.'],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-investigation-overflow-2' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Investigation Reducer')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Reducer tried to finalize the investigation.',
            'accept',
            'Reducer thinks the evidence is enough.',
            {
              userAnswer: [
                '## Investigation Update',
                '',
                'Reducer says the retry path diagnosis is complete.',
              ].join('\n'),
            },
          ),
          { sessionId: 'session-investigation-reducer-overflow' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Investigate why the retry path still reports the wrong failure to users.',
    );

    expect(result.success).toBe(false);
    expect(result.lastText).toContain('The investigation is still inconclusive');
    expect(result.lastText).toContain('Logger root-cause handoff (high)');
    expect(result.managedTask?.runtime?.childContextBundles).toHaveLength(4);
    expect(result.managedTask?.runtime?.childAgentResults).toHaveLength(2);
    expect(result.managedTask?.runtime?.fanoutSchedulerPlan?.scheduledBundleIds).toEqual(['shard-1', 'shard-2']);
    expect(result.managedTask?.runtime?.fanoutSchedulerPlan?.deferredBundleIds).toEqual(['shard-3', 'shard-4']);
  });

  it('canonicalizes duplicate investigation shard ids before scheduling validator branches', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-tactical-investigation-duplicates-');
    let shardOneValidatorRuns = 0;
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'bugfix',
        taskFamily: 'investigation',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'investigation',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        topologyCeiling: 'H0_DIRECT',
        reason: 'Read-only investigation should canonicalize duplicate shards before validation.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout kept the investigation on H0 and recommended bounded evidence validation.',
            'H0_DIRECT',
          ),
          { sessionId: 'session-scout-tactical-investigation-duplicates' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Investigation Scanner')) {
        return buildAssistantResult(
          [
            'Scanner found three shards, including one duplicate id.',
            '```kodax-investigation-shards',
            JSON.stringify({
              summary: 'Scanner identified three investigation shards with one duplicate id.',
              shards: [
                {
                  id: 'shard-1',
                  question: 'Does the retry path hide the root cause?',
                  scope: 'Retry root-cause propagation',
                  priority: 'high',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['First occurrence.'],
                },
                {
                  id: 'shard-1',
                  question: 'Duplicate shard should not run twice.',
                  scope: 'Duplicate retry shard',
                  priority: 'medium',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['Duplicate occurrence.'],
                },
                {
                  id: 'shard-2',
                  question: 'Does the logger preserve the root cause?',
                  scope: 'Logger handoff',
                  priority: 'medium',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['Independent sibling shard.'],
                },
              ],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-scan-tactical-investigation-duplicates' },
        );
      }
      if (workerPrompt.includes('[Shard ID] shard-1')) {
        shardOneValidatorRuns += 1;
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator confirmed the canonical shard.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'shard-1',
              fanoutClass: 'evidence-scan',
              status: 'completed',
              disposition: 'valid',
              summary: 'Shard 1 is valid.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: [],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-investigation-duplicates-1' },
        );
      }
      if (workerPrompt.includes('[Shard ID] shard-2')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator weakened the sibling shard.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'shard-2',
              fanoutClass: 'evidence-scan',
              status: 'completed',
              disposition: 'false-positive',
              summary: 'Shard 2 is a false positive.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: ['Sibling shard does not reproduce.'],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-investigation-duplicates-2' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Investigation Reducer')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Reducer completed the tactical investigation.',
            'accept',
            'Validator evidence is sufficient for the parent diagnosis.',
            {
              userAnswer: [
                '## Investigation Update',
                '',
                'The canonical shard is valid.',
              ].join('\n'),
            },
          ),
          { sessionId: 'session-investigation-reducer-duplicates' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Investigate why the retry path still reports the wrong failure to users.',
    );

    expect(result.success).toBe(true);
    expect(shardOneValidatorRuns).toBe(1);
    expect(result.managedTask?.runtime?.childContextBundles).toHaveLength(2);
    expect(result.managedTask?.runtime?.fanoutSchedulerPlan?.branches.map((branch) => branch.bundleId)).toEqual([
      'shard-1',
      'shard-2',
    ]);
  });

  it('fails closed when a tactical investigation shard omits a structured child result', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-tactical-investigation-fail-closed-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'bugfix',
        taskFamily: 'investigation',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'investigation',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        topologyCeiling: 'H0_DIRECT',
        reason: 'Read-only investigation should fail closed on malformed child results.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout kept the investigation on H0 and recommended bounded evidence validation.',
            'H0_DIRECT',
          ),
          { sessionId: 'session-scout-tactical-investigation-fail-closed' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Investigation Scanner')) {
        return buildAssistantResult(
          [
            'Scanner found two investigation shards worth validation.',
            '```kodax-investigation-shards',
            JSON.stringify({
              summary: 'Scanner identified two investigation shards.',
              shards: [
                {
                  id: 'shard-1',
                  question: 'Does the retry path hide the root cause?',
                  scope: 'Retry root-cause propagation',
                  priority: 'high',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['This shard exercises fail-closed reduction.'],
                },
                {
                  id: 'shard-2',
                  question: 'Is the timeout branch involved?',
                  scope: 'Timeout branch',
                  priority: 'medium',
                  files: ['packages/coding/src/reasoning.ts'],
                  evidence: ['Sibling shard provides a structured comparison point.'],
                },
              ],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-scan-tactical-investigation-fail-closed' },
        );
      }
      if (workerPrompt.includes('[Shard ID] shard-1')) {
        return buildAssistantResult(
          buildHandoffResponse('Validator insists the retry shard is valid but forgets the structured block.'),
          { sessionId: 'session-investigation-fail-closed-1' },
        );
      }
      if (workerPrompt.includes('[Shard ID] shard-2')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator weakened the sibling shard.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'shard-2',
              fanoutClass: 'evidence-scan',
              status: 'completed',
              disposition: 'false-positive',
              summary: 'Shard 2 weakens the timeout branch theory.',
              evidenceRefs: ['packages/coding/src/reasoning.ts'],
              contradictions: ['Timeout branch is not implicated by current evidence.'],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-investigation-fail-closed-2' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Investigation Reducer')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Reducer believes the investigation is complete.',
            'accept',
            'Reducer thinks the investigation is done.',
            {
              userAnswer: [
                '## Investigation Update',
                '',
                'Reducer says the retry shard is confirmed.',
              ].join('\n'),
            },
          ),
          { sessionId: 'session-investigation-reducer-fail-closed' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Investigate why the retry path still reports the wrong failure to users.',
    );

    expect(result.success).toBe(false);
    expect(result.lastText).toContain('The investigation is still inconclusive');
    expect(result.lastText).toContain('Retry root-cause propagation (high)');
    expect(result.lastText).not.toContain('Reducer says the retry shard is confirmed.');
    expect(result.managedTask?.runtime?.childAgentResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childId: 'shard-1',
          disposition: 'needs-more-evidence',
          contradictions: ['Missing or malformed structured child result.'],
        }),
      ]),
    );
  });

  it('treats fully-completed but unsupported investigation evidence as an unsupported diagnosis, not as missing evidence', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-tactical-investigation-unsupported-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'bugfix',
        taskFamily: 'investigation',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'investigation',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        topologyCeiling: 'H0_DIRECT',
        reason: 'Read-only investigation should distinguish unsupported diagnoses from missing evidence.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout kept the investigation on H0 and recommended bounded evidence validation.',
            'H0_DIRECT',
          ),
          { sessionId: 'session-scout-tactical-investigation-unsupported' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Investigation Scanner')) {
        return buildAssistantResult(
          [
            'Scanner found two evidence shards worth validating.',
            '```kodax-investigation-shards',
            JSON.stringify({
              summary: 'Scanner identified two investigation shards.',
              shards: [
                {
                  id: 'shard-1',
                  question: 'Does the retry wrapper hide the original error?',
                  scope: 'Retry wrapper',
                  priority: 'high',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['Current lead depends on this shard.'],
                },
                {
                  id: 'shard-2',
                  question: 'Does the logger drop the root cause text?',
                  scope: 'Logger handoff',
                  priority: 'medium',
                  files: ['packages/coding/src/task-engine.ts'],
                  evidence: ['Secondary supporting shard.'],
                },
              ],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-scan-tactical-investigation-unsupported' },
        );
      }
      if (workerPrompt.includes('[Shard ID] shard-1')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator found no support for the retry-wrapper diagnosis.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'shard-1',
              fanoutClass: 'evidence-scan',
              status: 'completed',
              disposition: 'false-positive',
              summary: 'Shard 1 does not support the retry-wrapper diagnosis.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: ['Retry wrapper preserves the original error in the current code path.'],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-investigation-unsupported-1' },
        );
      }
      if (workerPrompt.includes('[Shard ID] shard-2')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Validator found no support for the logger-handoff diagnosis.'),
            '```kodax-child-result',
            JSON.stringify({
              childId: 'shard-2',
              fanoutClass: 'evidence-scan',
              status: 'completed',
              disposition: 'false-positive',
              summary: 'Shard 2 does not support the logger-handoff diagnosis.',
              evidenceRefs: ['packages/coding/src/task-engine.ts'],
              contradictions: ['Logger handoff preserves the root cause text.'],
              artifactPaths: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-investigation-unsupported-2' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Investigation Reducer')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Reducer thinks the investigation can be accepted.',
            'accept',
            'Reducer optimism should be ignored when no validator-backed support exists.',
            {
              userAnswer: [
                '## Investigation Update',
                '',
                'Reducer says the current diagnosis is confirmed.',
              ].join('\n'),
            },
          ),
          { sessionId: 'session-investigation-reducer-unsupported' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Investigate why the retry path still reports the wrong failure to users.',
    );

    expect(result.success).toBe(false);
    expect(result.lastText).toContain('validated evidence collected so far does not support the current diagnosis');
    expect(result.lastText).toContain('No unresolved evidence shards remain');
    expect(result.lastText).toContain('does not support the retry-wrapper diagnosis');
    expect(result.lastText).not.toContain('Reducer says the current diagnosis is confirmed.');
  });

  it('accepts an empty investigation shard block as structured scanner output and records the scanner artifact', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-tactical-investigation-empty-shards-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'bugfix',
        taskFamily: 'investigation',
        actionability: 'actionable',
        executionPattern: 'checked-direct',
        recommendedMode: 'investigation',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'read-only',
        topologyCeiling: 'H0_DIRECT',
        reason: 'Read-only investigation should preserve an explicit empty shard contract from the scanner.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout kept the investigation on H0 and recommended bounded evidence validation.',
            'H0_DIRECT',
          ),
          { sessionId: 'session-scout-tactical-investigation-empty-shards' },
        );
      }
      if (workerPrompt.includes('You are the Tactical Investigation Scanner')) {
        return buildAssistantResult(
          [
            'Scanner found no bounded evidence shards worth splitting out.',
            '```kodax-investigation-shards',
            JSON.stringify({
              summary: 'Scanner found no bounded investigation shards.',
              shards: [],
            }),
            '```',
          ].join('\n'),
          { sessionId: 'session-scan-tactical-investigation-empty-shards' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 160)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Investigate why the retry path still reports the wrong failure to users.',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toContain('Scanner found no bounded evidence shards worth splitting out.');
    expect(result.managedTask?.runtime?.childContextBundles ?? []).toHaveLength(0);
    expect(result.managedTask?.evidence.artifacts.map((artifact) => artifact.path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('investigation-shards.json'),
      ]),
    );
  });

  it('keeps mutation-focused AMA tactical investigation on the direct path when child fan-out is inadmissible', async () => {
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'bugfix',
        taskFamily: 'investigation',
        actionability: 'actionable',
        executionPattern: 'direct',
        recommendedMode: 'investigation',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        mutationSurface: 'code',
        topologyCeiling: 'H0_DIRECT',
        reason: 'Mutation investigation should stay direct without hidden child fan-out.',
      }),
    );
    mockRunDirectKodaX.mockResolvedValue(
      buildAssistantResult('I investigated the failing test and identified the direct code fix path.'),
    );

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
      },
      'Investigate the failing test and patch the implementation.',
    );

    expect(result.success).toBe(true);
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.runtime?.childContextBundles ?? []).toHaveLength(0);
    expect(result.managedTask?.runtime?.childAgentResults ?? []).toHaveLength(0);
    const prompts = mockRunDirectKodaX.mock.calls.map((call) => String(call[1] ?? ''));
    expect(prompts.some((prompt) => prompt.includes('Tactical Review'))).toBe(false);
  });

  it('keeps project read-only scout preflight on optional QA instead of auto-marking it required', async () => {
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        mutationSurface: 'read-only',
        assuranceIntent: 'default',
        needsIndependentQA: false,
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'Project-context review should stay lightweight without explicit stronger checking.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_workerOptions, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout determined this project review can finish directly.',
            'H0_DIRECT',
          ),
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          taskSurface: 'project',
        },
      },
      '请 review 当前项目状态并指出最重要的风险。',
    );

    expect(result.success).toBe(true);
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.contract.surface).toBe('project');
    expect(result.managedTask?.runtime?.qualityAssuranceMode).toBe('optional');
  });

  it('runs AMA H1 as lightweight checked-direct with generator plus evaluator only for explicit review checks', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-h1-');
    const prompts: string[] = [];
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
        assuranceIntent: 'explicit-check',
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'Explicit double-check review should use checked-direct execution.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      prompts.push(workerPrompt);
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout kept the task on H1.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the requested review pass.'),
          { sessionId: 'session-generator' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          buildVerdictResponse('Evaluator accepted the checked-direct result.', 'accept', 'The answer is complete and supported.'),
          { sessionId: 'session-evaluator' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      '请 review 当前改动并指出关键问题',
    );

    expect(result.success).toBe(true);
    expect(result.managedTask?.contract.harnessProfile).toBe('H1_EXECUTE_EVAL');
    expect(result.managedTask?.roleAssignments.map((item) => item.role)).toEqual([
      'generator',
      'evaluator',
    ]);
    expect(result.managedTask?.evidence.entries.map((entry) => entry.assignmentId)).toEqual(
      expect.arrayContaining(['scout', 'generator', 'evaluator']),
    );
    const scoutPrompt = prompts.find((item) => item.includes('You are the Scout role'));
    const generatorPrompt = prompts.find((item) => item.includes('You are the Generator role'));
    const evaluatorPrompt = prompts.find((item) => item.includes('You are the Evaluator role'));
    expect(scoutPrompt).toContain('If you confirm H1 or H2, stop after the cheap-facts pass.');
    expect(scoutPrompt).toContain('When multiple read-only tool calls are independent, emit them in the same response so parallel mode can run them together.');
    expect(generatorPrompt).toContain('This is lightweight H1 checked-direct execution, not mini-H2.');
    expect(generatorPrompt).toContain('Reuse its cheap-facts summary, scope notes, and evidence-acquisition hints instead of rebuilding them from scratch.');
    expect(generatorPrompt).toContain('Consume the Scout handoff before collecting more evidence.');
    expect(generatorPrompt).toContain('Only serialize tool calls when a later call depends on an earlier result.');
    expect(generatorPrompt).toContain('This H1 run is read-only. Do not mutate files, code, or system state.');
    expect(generatorPrompt).toContain('Never mention internal protocol tools, fenced blocks, MCP, capability runtimes, or extension runtimes in the user-facing answer.');
    expect(generatorPrompt).not.toContain('Consume the Scout handoff and Planner contract before collecting more evidence.');
    expect(evaluatorPrompt).toContain('When status=revise, keep the user-facing text short and specific');
    expect(evaluatorPrompt).toContain('Do not write a full polished final report when status=revise.');
    expect(evaluatorPrompt).toContain('Start from the Scout handoff and Generator handoff.');
    expect(evaluatorPrompt).toContain('Keep parallel batches focused: prefer a few narrow grep/read/diff calls over many tiny sequential probes.');
    expect(evaluatorPrompt).toContain('user_answer: <optional final user-facing answer; multi-line content may continue on following lines>');
    expect(evaluatorPrompt).toContain('Prefer putting the final user-facing answer in user_answer:');
    expect(evaluatorPrompt).toContain('Never mention internal protocol tools, fenced blocks, MCP, capability runtimes, or extension runtimes in the user-facing answer.');
    expect(evaluatorPrompt).not.toContain('Start from the Planner contract and Generator handoff.');
  });

  it('accepts common evaluator verdict status variants instead of treating them as missing blocks', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-h1-status-variant-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'Use checked-direct review.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout kept the task on H1.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout-variant' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the requested review pass.'),
          { sessionId: 'session-generator-variant' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          buildRawVerdictResponse(
            'Evaluator accepted the checked-direct result.',
            'accepted.',
            'The answer is complete and supported.',
          ),
          { sessionId: 'session-evaluator-variant' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Review the current change set and call out any important issues.',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toContain('Evaluator accepted the checked-direct result.');
    expect(result.signalReason ?? '').not.toContain('missing kodax-task-verdict');
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
  });

  it('accepts a trailing verdict block even when the model adds extra chatter afterwards', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-trailing-verdict-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'Use checked-direct review.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout kept the task on H1.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout-trailing' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the requested review pass.'),
          { sessionId: 'session-generator-trailing' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          [
            'Evaluator accepted the checked-direct result.',
            '```kodax-task-verdict',
            'status: accepted',
            'reason: Looks good.',
            'followups:',
            '- none',
            '```',
            'Final note: thanks.',
          ].join('\n'),
          { sessionId: 'session-evaluator-trailing' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Review the current change set and call out any important issues.',
    );

    expect(result.success).toBe(true);
    expect(result.signalReason ?? '').not.toContain('missing kodax-task-verdict');
  });

  it('accepts json verdict blocks with aliased fields', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-json-verdict-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'Use checked-direct review.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout kept the task on H1.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout-json' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the requested review pass.'),
          { sessionId: 'session-generator-json' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          [
            'Evaluator accepts the checked-direct result via JSON.',
            '```kodax-task-verdict',
            JSON.stringify({
              status: 'accepted.',
              reason: 'JSON verdict parsed successfully.',
              userAnswer: 'Final answer is ready.',
              nextHarness: 'h1',
              followups: ['Address the loose section.'],
            }, null, 2),
            '```',
          ].join('\n'),
          { sessionId: 'session-evaluator-json' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Review the current change set and call out any important issues.',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toContain('Final answer is ready.');
    expect(result.signalReason ?? '').not.toContain('missing kodax-task-verdict');
  });

  it('falls back to the generator answer with a degraded verification note when evaluator verdict output stays malformed', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-malformed-verdict-');
    const streamedText: string[] = [];
    const rawStructuredPayload = [
      'Evaluator visible prose before the malformed block.',
      '```kodax-investigation-shards',
      JSON.stringify({
        summary: 'Large malformed payload',
        shards: Array.from({ length: 8 }, (_value, index) => ({
          id: `shard-${index + 1}`,
          question: `Question ${index + 1}`,
          scope: `Scope ${index + 1} `.repeat(40),
          priority: 'high',
        })),
      }),
      '```',
    ].join('\n');

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'Use checked-direct review.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        options.events?.onTextDelta?.('SCOUT RAW SHOULD STAY VISIBLE');
        return buildAssistantResult(
          buildScoutResponse('Scout kept the task on H1.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout-malformed' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the requested review pass.'),
          { sessionId: 'session-generator-malformed' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        options.events?.onTextDelta?.(rawStructuredPayload);
        return buildAssistantResult(rawStructuredPayload, { sessionId: 'session-evaluator-malformed' });
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
        events: {
          onTextDelta: (text) => {
            streamedText.push(text);
          },
        },
      },
      'Review the current change set and tell me whether it is ready.',
    );

      expect(result.success).toBe(false);
      expect(result.signal).toBe('BLOCKED');
      expect(result.signalReason).toContain('structured verification data');
      expect(result.signalReason).not.toContain('kodax-task-verdict');
      expect(result.signalDebugReason).toContain('kodax-task-verdict');
      expect(result.lastText).toContain('Generator completed the requested review pass.');
      expect(result.lastText).toContain('Verification degraded:');
      expect(result.lastText).not.toContain('kodax-task-verdict');
      expect(result.lastText).not.toContain('kodax-investigation-shards');
      expect(result.lastText.length).toBeLessThan(2600);
      expect(result.protocolRawText).toBeUndefined();
      expect(result.managedProtocolPayload?.handoff?.status).toBe('ready');
      expect(result.managedTask?.verdict.continuationSuggested).toBe(true);
      expect(result.managedTask?.runtime?.degradedVerification?.fallbackWorkerId).toBe('generator');
      expect(result.managedTask?.runtime?.degradedVerification?.debugReason).toContain('kodax-task-verdict');
      expect(streamedText.join('')).toContain('SCOUT RAW SHOULD STAY VISIBLE');
      expect(streamedText.join('')).not.toContain('kodax-investigation-shards');

      const feedbackArtifact = result.managedTask?.evidence.artifacts.find((artifact) => artifact.path.endsWith('feedback.json'));
      expect(feedbackArtifact?.path).toBeTruthy();
      const feedbackJson = JSON.parse(await readFile(feedbackArtifact!.path, 'utf8'));
      expect(feedbackJson.reason).toContain('structured verification data');
      expect(feedbackJson.debugReason).toContain('kodax-task-verdict');
      expect(feedbackJson.protocolParseFailed).toBe(true);
      const rawFeedbackPath = path.join(path.dirname(feedbackArtifact!.path), 'feedback-raw.txt');
      expect(existsSync(rawFeedbackPath)).toBe(true);
      await expect(readFile(rawFeedbackPath, 'utf8')).resolves.toContain('kodax-investigation-shards');
    });

  it('accepts structured managed protocol payloads without fenced protocol blocks', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-structured-protocol-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'Managed workers can provide protocol payloads directly.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          'Scout confirmed the task should stay on H1.',
          {
            sessionId: 'session-scout-structured-payload',
            managedProtocolPayload: {
              scout: {
                summary: 'Scout confirmed the task should stay on H1.',
                confirmedHarness: 'H1_EXECUTE_EVAL',
                scope: ['Inspect the changed review surface.'],
                requiredEvidence: ['Generator handoff and evaluator acceptance.'],
              },
            },
          },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          'Generator completed the requested review pass.',
          {
            sessionId: 'session-generator-structured-payload',
            managedProtocolPayload: {
              handoff: {
                status: 'ready',
                summary: 'Generator completed the requested review pass.',
                evidence: ['Validated the changed review surface.'],
                followup: ['none'],
                userFacingText: 'Generator completed the requested review pass.',
              },
            },
          },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          'Evaluator accepts the review result without further changes.',
          {
            sessionId: 'session-evaluator-structured-payload',
            managedProtocolPayload: {
              verdict: {
                source: 'evaluator',
                status: 'accept',
                reason: 'Structured payload satisfied the evaluator contract.',
                followups: ['none'],
                userFacingText: 'Evaluator accepts the review result without further changes.',
              },
            },
          },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Review the current changes and conclude only when the evaluator accepts the result.',
    );

    expect(result.success).toBe(true);
    expect(result.signalReason ?? '').not.toContain('missing kodax-task');
    expect(result.managedProtocolPayload?.verdict?.status).toBe('accept');
    expect(result.managedTask?.contract.harnessProfile).toBe('H1_EXECUTE_EVAL');
    expect(result.lastText).toContain('Evaluator accepts the review result without further changes.');
  });

  it('reuses normalized handoff payloads at round reduction time instead of reparsing trailing text', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-handoff-payload-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'Use checked-direct review.',
      }),
    );
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout kept the task on H1.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout-handoff-payload' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          [
            buildHandoffResponse('Generator reports evidence is still incomplete.', 'incomplete'),
            'Trailing chatter after the handoff block should not matter.',
          ].join('\n'),
          { sessionId: 'session-generator-handoff-payload' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        throw new Error('Evaluator should not run when generator handoff already requests continuation.');
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Review the current change set and continue only when the generator handoff is structurally ready.',
    );

    expect(result.success).toBe(false);
    expect(result.lastText).toContain('Generator reports evidence is still incomplete.');
    expect(result.signalReason ?? '').not.toContain('did not produce a consumable handoff');
  });

  it('keeps H1 mutation work on checked-direct and returns blocked after one short revise instead of escalating to H2', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-h2-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'edit',
        taskFamily: 'implementation',
        executionPattern: 'checked-direct',
        recommendedMode: 'implementation',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'code',
        topologyCeiling: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Checked-direct mutation work may need escalation if evidence is incomplete.',
      }),
    );

    let evaluatorRound = 0;
    let generatorRound = 0;
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H1 for the initial mutation pass.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout-upgrade' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        generatorRound += 1;
        return buildAssistantResult(
          buildHandoffResponse(`Generator completed execution slice ${generatorRound}.`),
          { sessionId: `session-generator-${generatorRound}` },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        evaluatorRound += 1;
        if (evaluatorRound === 1) {
          return buildAssistantResult(
            buildVerdictResponse(
              'Evaluator requests one more checked-direct pass before escalating.',
              'revise',
              'Take one more checked-direct pass before considering a stronger harness.',
            ),
            { sessionId: 'session-evaluator-revise' },
          );
        }
        if (evaluatorRound === 2) {
          return buildAssistantResult(
            buildVerdictResponse(
              'Evaluator still sees unresolved issues after the second H1 pass.',
              'revise',
              'One checked-direct revise was not enough; return the best supported answer with explicit limits.',
            ),
            { sessionId: 'session-evaluator-blocked' },
          );
        }
        throw new Error(`Unexpected evaluator round ${evaluatorRound}`);
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      '请 review 当前改动并在证据不足时继续深入',
    );

    expect(result.success).toBe(false);
    expect(result.managedTask?.contract.harnessProfile).toBe('H1_EXECUTE_EVAL');
    expect(generatorRound).toBe(2);
    expect(evaluatorRound).toBe(2);
    expect(result.managedTask?.roleAssignments.map((item) => item.role)).toEqual([
      'generator',
      'evaluator',
    ]);
    expect(result.managedTask?.runtime?.harnessTransitions).toEqual([]);
    expect(mockRunDirectKodaX.mock.calls.some((call) => String(call[1]).includes('You are the Planner role'))).toBe(false);
  });

  it('keeps read-only H1 tasks capped at H1 instead of auto-escalating to H2', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-h1-readonly-cap-');
    let evaluatorRound = 0;

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
        assuranceIntent: 'explicit-check',
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'Explicit double-check review should stay capped at H1.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H1 for the explicit double-check review.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout-h1-readonly' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the review pass.'),
          { sessionId: 'session-generator-h1-readonly' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        evaluatorRound += 1;
        if (evaluatorRound === 1) {
          return buildAssistantResult(
            buildVerdictResponse(
              'Evaluator requests one more checked-direct review pass.',
              'revise',
              'Take one more same-harness pass before acceptance.',
            ),
            { sessionId: 'session-evaluator-h1-readonly-revise-1' },
          );
        }
        return buildAssistantResult(
          buildVerdictResponse(
            'Evaluator still sees limits after the second pass.',
            'revise',
            'The review remains incomplete, but this task is capped at H1.',
          ),
          { sessionId: 'session-evaluator-h1-readonly-revise-2' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Please review the current change set and do a second pass to double-check the important findings.',
    );

    expect(result.success).toBe(false);
    expect(evaluatorRound).toBe(2);
    expect(result.managedTask?.contract.harnessProfile).toBe('H1_EXECUTE_EVAL');
    expect(result.managedTask?.runtime?.harnessTransitions).toEqual([]);
    expect(mockRunDirectKodaX.mock.calls.some((call) => String(call[1]).includes('You are the Planner role'))).toBe(false);
    const generatorAssignment = result.managedTask?.roleAssignments.find((item) => item.role === 'generator');
    expect(generatorAssignment?.toolPolicy?.blockedTools).toEqual(expect.arrayContaining(['write', 'edit', 'apply_patch']));
    expect(generatorAssignment?.toolPolicy?.allowedTools).toEqual(expect.arrayContaining(['changed_diff', 'changed_diff_bundle', 'read']));
  });

  it('scopes H1 docs-only Generator writes to documentation paths', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-h1-docs-');
    const prompts: string[] = [];

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'edit',
        taskFamily: 'planning',
        executionPattern: 'checked-direct',
        recommendedMode: 'planning',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'docs-only',
        assuranceIntent: 'explicit-check',
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'Explicit second-pass documentation work should use lightweight checked-direct execution.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (options, workerPrompt: string) => {
      prompts.push(workerPrompt);
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout kept the docs task on H1.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout-h1-docs' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        await expect(
          options.events?.beforeToolExecute?.('edit', {
            path: 'docs/architecture/ama.md',
            old_str: 'old',
            new_str: 'new',
          } as any),
        ).resolves.toBe(true);
        const blockedCodeEdit = await options.events?.beforeToolExecute?.('edit', {
          path: 'packages/coding/src/task-engine.ts',
          old_str: 'old',
          new_str: 'new',
        } as any);
        expect(typeof blockedCodeEdit).toBe('string');
        expect(String(blockedCodeEdit)).toContain('outside the allowed docs-only write boundary');
        return buildAssistantResult(
          buildHandoffResponse('Generator updated the documentation review pass.'),
          { sessionId: 'session-generator-h1-docs' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          buildVerdictResponse('Evaluator accepted the documentation pass.', 'accept', 'The documentation changes are scoped correctly.'),
          { sessionId: 'session-evaluator-h1-docs' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      '请对文档做 second pass，并只更新架构说明文档。',
    );

    expect(result.success).toBe(true);
    expect(result.managedTask?.contract.harnessProfile).toBe('H1_EXECUTE_EVAL');
    const generatorAssignment = result.managedTask?.roleAssignments.find((item) => item.role === 'generator');
    expect(generatorAssignment?.toolPolicy?.allowedWritePathPatterns).toEqual(
      expect.arrayContaining(['\\.(?:md|mdx|txt|rst|adoc)$']),
    );
    const generatorPrompt = prompts.find((item) => item.includes('You are the Generator role'));
    expect(generatorPrompt).toContain('This H1 run is docs-only. Restrict any edits to documentation artifacts. Do not mutate code or system state.');
  });

  it('re-runs Planner when mutation-focused H2 is missing a consumable contract before Generator executes', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-planner-retry-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'edit',
        taskFamily: 'implementation',
        executionPattern: 'coordinated',
        recommendedMode: 'implementation',
        complexity: 'complex',
        riskLevel: 'medium',
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'code',
        reason: 'Long-running mutation work should use the coordinated harness.',
      }),
    );

    let plannerCalls = 0;
    let generatorCalls = 0;
    let evaluatorCalls = 0;
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H2 for the initial pass.', 'H2_PLAN_EXECUTE_EVAL'),
          { sessionId: 'session-scout-h2' },
        );
      }
      if (workerPrompt.includes('You are the Planner role')) {
        plannerCalls += 1;
        if (plannerCalls === 1) {
          return buildAssistantResult(
            'Planner gathered evidence but omitted the required contract block.',
            { sessionId: 'session-planner-missing-contract' },
          );
        }
        return buildAssistantResult(
          buildContractResponse('Planner produced the required sprint contract on retry.'),
          { sessionId: 'session-planner-contract' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        generatorCalls += 1;
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the requested review after Planner recovery.'),
          { sessionId: 'session-generator-after-planner-retry' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        evaluatorCalls += 1;
        return buildAssistantResult(
          buildVerdictResponse(
            'Evaluator accepted the recovered H2 pass.',
            'accept',
            'The Planner contract was recovered and the execution evidence is sufficient.',
          ),
          { sessionId: 'session-evaluator-after-planner-retry' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      '请 review 当前仓库的代码改动，并给出最终结论。',
    );

    expect(result.success).toBe(true);
    expect(plannerCalls).toBe(2);
    expect(generatorCalls).toBe(1);
    expect(evaluatorCalls).toBe(1);
  });

  it('keeps H2 Planner on overview evidence tools and reserves deep diff paging for Generator on mutation work', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-planner-overview-');
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'edit',
        taskFamily: 'implementation',
        executionPattern: 'coordinated',
        recommendedMode: 'implementation',
        complexity: 'complex',
        riskLevel: 'high',
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'code',
        reason: 'Complex mutation work needs a coordinated plan and independent evaluation.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H2 for the coordinated mutation pass.', 'H2_PLAN_EXECUTE_EVAL'),
          { sessionId: 'session-scout-overview' },
        );
      }
      if (workerPrompt.includes('You are the Planner role')) {
        expect(workerPrompt).toContain('Do not linearly page large raw diffs');
        await expect(
          options.events?.beforeToolExecute?.('changed_diff_bundle', {
            paths: ['packages/coding/src/task-engine.ts'],
          } as any),
        ).resolves.toBe(true);
        const deepDiffDecision = await options.events?.beforeToolExecute?.('changed_diff', {
          path: 'packages/coding/src/task-engine.ts',
          offset: 721,
          limit: 360,
        } as any);
        expect(typeof deepDiffDecision).toBe('string');
        expect(String(deepDiffDecision)).toContain('outside the allowed capability boundary');
        return buildAssistantResult(
          buildContractResponse('Planner produced an overview-driven sprint contract.'),
          { sessionId: 'session-planner-overview' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the deep evidence pass.'),
          { sessionId: 'session-generator-overview' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Evaluator accepted the overview-planned review.',
            'accept',
            'Planner stayed at overview evidence and Generator supplied the deep evidence.',
          ),
          { sessionId: 'session-evaluator-overview' },
        );
      }
      return buildAssistantResult('fallback');
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        session: { id: 'session-planner-overview' } as any,
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      '请 review 当前仓库的大规模改动，并给出系统性的审查结论。',
    );

    expect(result.success).toBe(true);
    const plannerAssignment = result.managedTask?.roleAssignments.find((assignment) => assignment.role === 'planner');
    expect(plannerAssignment?.toolPolicy?.allowedTools).toEqual(
      expect.arrayContaining(['changed_scope', 'repo_overview', 'changed_diff_bundle']),
    );
    expect(plannerAssignment?.toolPolicy?.allowedTools).not.toContain('changed_diff');
  });

  it('treats off mode as a strict repo-intelligence working-plane disable', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-off-mode-');

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'coordinated',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
      }),
    );
    mockGetRepoOverview.mockImplementation(async () => {
      throw new Error('repo_overview should not run in off mode');
    });
    mockAnalyzeChangedScope.mockImplementation(async () => {
      throw new Error('changed_scope should not run in off mode');
    });
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout stayed in cheap-facts mode.', 'H2_PLAN_EXECUTE_EVAL'),
          { sessionId: 'session-scout-off' },
        );
      }
      if (workerPrompt.includes('You are the Planner role')) {
        return buildAssistantResult(
          buildContractResponse('Planner produced an off-mode contract.'),
          { sessionId: 'session-planner-off' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the off-mode review pass.'),
          { sessionId: 'session-generator-off' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          buildVerdictResponse(
            'Evaluator accepted the off-mode review.',
            'accept',
            'Off mode stayed on general-purpose evidence only.',
          ),
          { sessionId: 'session-evaluator-off' },
        );
      }
      return buildAssistantResult('fallback');
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        session: { id: 'session-off-mode' } as any,
        context: {
          executionCwd: workspaceRoot,
          managedTaskWorkspaceDir: workspaceRoot,
          repoIntelligenceMode: 'off',
        },
      },
      'Review the current task with repo intelligence fully disabled.',
    );

    expect(result.success).toBe(true);
    const plannerAssignment = result.managedTask?.roleAssignments.find((assignment) => assignment.role === 'planner');
    expect(plannerAssignment?.toolPolicy?.allowedTools).toEqual(
      expect.arrayContaining(['glob', 'grep', 'read']),
    );
    expect(plannerAssignment?.toolPolicy?.allowedTools).not.toContain('repo_overview');
    expect(plannerAssignment?.toolPolicy?.allowedTools).not.toContain('changed_scope');
    expect(plannerAssignment?.toolPolicy?.allowedTools).not.toContain('changed_diff');
    expect(plannerAssignment?.toolPolicy?.allowedTools).not.toContain('changed_diff_bundle');

    const workspaceDir = result.managedTask?.evidence.workspaceDir;
    expect(workspaceDir).toBeTruthy();
    expect(existsSync(path.join(workspaceDir!, 'repo-intelligence'))).toBe(false);
    expect(mockGetRepoOverview).not.toHaveBeenCalled();
    expect(mockAnalyzeChangedScope).not.toHaveBeenCalled();
  });

  it('requests more work budget at 90% usage and extends explicit-check H1 for one more revise pass', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-h1-budget-');
    const askUser = vi.fn(async () => 'continue');
    let generatorRound = 0;
    let evaluatorRound = 0;

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
        assuranceIntent: 'explicit-check',
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'Explicit double-check review should request more budget when it needs another pass.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H1 for the initial pass.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout-budget' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        generatorRound += 1;
        const iterCount = generatorRound === 1 ? 185 : 4;
        for (let iter = 1; iter <= iterCount; iter += 1) {
          options.events?.onIterationStart?.(iter, iterCount);
        }
        return buildAssistantResult(
          buildHandoffResponse(`Generator completed checked-direct pass ${generatorRound}.`),
          { sessionId: `session-generator-budget-${generatorRound}` },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        evaluatorRound += 1;
        const iterCount = evaluatorRound === 1 ? 8 : 2;
        for (let iter = 1; iter <= iterCount; iter += 1) {
          options.events?.onIterationStart?.(iter, iterCount);
        }
        if (evaluatorRound === 1) {
          return buildAssistantResult(
            buildVerdictResponse(
              'Evaluator requests one more checked-direct pass.',
              'revise',
              'One more pass is needed to tighten the answer.',
            ),
            { sessionId: 'session-evaluator-budget-revise' },
          );
        }
        return buildAssistantResult(
          buildVerdictResponse(
            'Evaluator accepts the second checked-direct pass.',
            'accept',
            'The revised answer is now complete and well-supported.',
          ),
          { sessionId: 'session-evaluator-budget-accept' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        events: {
          askUser,
        },
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      '请 review 当前改动，并在还需要更多工作时申请继续执行预算。',
    );

    expect(result.success).toBe(true);
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(generatorRound).toBe(2);
    expect(evaluatorRound).toBe(2);
    expect(result.managedTask?.contract.harnessProfile).toBe('H1_EXECUTE_EVAL');
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(400);
    expect(result.managedTask?.runtime?.budgetUsage).toBeGreaterThanOrEqual(199);
    expect(result.managedTask?.verdict.status).toBe('completed');
  });

  it('can request additional global work budget more than once on a long mutation-focused H2 run', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-h2-budget-repeat-');
    const askUser = vi.fn(async () => 'continue');
    let plannerRound = 0;
    let generatorRound = 0;
    let evaluatorRound = 0;

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'edit',
        taskFamily: 'implementation',
        executionPattern: 'coordinated',
        recommendedMode: 'implementation',
        complexity: 'complex',
        riskLevel: 'high',
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'code',
        reason: 'Long-running mutation work needs the full coordinated harness.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H2 for the long-running mutation pass.', 'H2_PLAN_EXECUTE_EVAL'),
          { sessionId: 'session-scout-repeat-budget' },
        );
      }
      if (workerPrompt.includes('You are the Planner role')) {
        plannerRound += 1;
        for (let iter = 1; iter <= 5; iter += 1) {
          options.events?.onIterationStart?.(iter, 5);
        }
        return buildAssistantResult(
          buildContractResponse(`Planner prepared H2 sprint ${plannerRound}.`),
          { sessionId: `session-planner-repeat-budget-${plannerRound}` },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        generatorRound += 1;
        const iterCount = generatorRound === 1 ? 210 : generatorRound === 2 ? 180 : 5;
        for (let iter = 1; iter <= iterCount; iter += 1) {
          options.events?.onIterationStart?.(iter, iterCount);
        }
        return buildAssistantResult(
          buildHandoffResponse(`Generator completed coordinated pass ${generatorRound}.`),
          { sessionId: `session-generator-repeat-budget-${generatorRound}` },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        evaluatorRound += 1;
        for (let iter = 1; iter <= 10; iter += 1) {
          options.events?.onIterationStart?.(iter, 10);
        }
        if (evaluatorRound < 3) {
          return buildAssistantResult(
            buildVerdictResponse(
              `Evaluator requests another coordinated pass ${evaluatorRound}.`,
              'revise',
              'Another coordinated pass is still needed before we can accept the review.',
            ),
            { sessionId: `session-evaluator-repeat-budget-${evaluatorRound}` },
          );
        }
        return buildAssistantResult(
          buildVerdictResponse(
            'Evaluator accepts the final coordinated pass.',
            'accept',
            'The coordinated review is now complete and well-supported.',
          ),
          { sessionId: 'session-evaluator-repeat-budget-accept' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        events: {
          askUser,
        },
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      '请系统性 review 当前仓库的大规模改动，并在预算接近上限时继续申请额外的全局 work budget。',
    );

    expect(result.success).toBe(true);
    expect(askUser).toHaveBeenCalledTimes(2);
    expect(plannerRound).toBe(1);
    expect(generatorRound).toBe(3);
    expect(evaluatorRound).toBe(3);
    expect(result.managedTask?.runtime?.globalWorkBudget).toBe(600);
    expect(result.managedTask?.runtime?.budgetUsage).toBeGreaterThanOrEqual(430);
  });

  it('injects previous evaluator summaries across H2 mutation refinement rounds without re-running Planner by default', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-role-summaries-');
    const prompts: string[] = [];
    let plannerRound = 0;
    let evaluatorRound = 0;

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'edit',
        taskFamily: 'implementation',
        executionPattern: 'coordinated',
        recommendedMode: 'implementation',
        complexity: 'complex',
        riskLevel: 'high',
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'code',
        reason: 'Coordinated mutation work may need structured refinement.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      prompts.push(workerPrompt);
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H2 for the review.', 'H2_PLAN_EXECUTE_EVAL'),
          { sessionId: 'session-scout-role-summary' },
        );
      }
      if (workerPrompt.includes('You are the Planner role')) {
        plannerRound += 1;
        return buildAssistantResult(
          buildContractResponse(`Planner prepared coordinated contract ${plannerRound}.`),
          { sessionId: `session-planner-role-summary-${plannerRound}` },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the deep evidence pass.'),
          { sessionId: `session-generator-role-summary-${plannerRound}` },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        evaluatorRound += 1;
        if (evaluatorRound === 1) {
          return buildAssistantResult(
            buildVerdictResponse(
              'Evaluator requests one more coordinated pass.',
              'revise',
              'One more coordinated pass is needed before acceptance.',
            ),
            { sessionId: 'session-evaluator-role-summary-revise' },
          );
        }
        return buildAssistantResult(
          buildVerdictResponse(
            '## Findings\n\n- The coordinated review is ready.',
            'accept',
            'The coordinated review is complete.',
          ),
          { sessionId: 'session-evaluator-role-summary-accept' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Please review the current repository changes and keep refining until the evidence is solid.',
    );

    expect(result.success).toBe(true);
    const plannerPrompts = prompts.filter((prompt) => prompt.includes('You are the Planner role'));
    const evaluatorPrompts = prompts.filter((prompt) => prompt.includes('You are the Evaluator role'));
    const generatorPrompts = prompts.filter((prompt) => prompt.includes('You are the Generator role'));

    expect(plannerPrompts).toHaveLength(1);
    expect(plannerPrompts[0]).not.toContain('Previous same-role summary:');

    expect(evaluatorPrompts).toHaveLength(2);
    expect(evaluatorPrompts[0]).not.toContain('Previous same-role summary:');
    expect(evaluatorPrompts[1]).toContain('Previous same-role summary:');
    expect(evaluatorPrompts[1]).toContain('Verdict: revise');

    expect(generatorPrompts.every((prompt) => !prompt.includes('Previous same-role summary:'))).toBe(true);
    expect(result.managedTask?.runtime?.roleRoundSummaries?.planner?.summary).toContain('Planner prepared coordinated contract 1.');
    expect(result.managedTask?.runtime?.roleRoundSummaries?.evaluator?.summary).toContain('The coordinated review is complete.');
  });

  it('injects a previous scout summary when the scout must retry its protocol block for mutation work', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-scout-summary-retry-');
    const prompts: string[] = [];
    let scoutAttempts = 0;

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'edit',
        taskFamily: 'implementation',
        executionPattern: 'coordinated',
        recommendedMode: 'implementation',
        complexity: 'complex',
        riskLevel: 'high',
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'code',
        reason: 'Broad mutation work needs coordinated refinement.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      prompts.push(workerPrompt);
      if (workerPrompt.includes('You are the Scout role')) {
        scoutAttempts += 1;
        if (scoutAttempts === 1) {
          return buildAssistantResult(
            'Scout thinks H2 is warranted because the mutation task is broad and high-risk.',
            { sessionId: 'session-scout-retry-1' },
          );
        }
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H2 after retry.', 'H2_PLAN_EXECUTE_EVAL'),
          { sessionId: 'session-scout-retry-2' },
        );
      }
      if (workerPrompt.includes('You are the Planner role')) {
        return buildAssistantResult(
          buildContractResponse('Planner prepared the review contract.'),
          { sessionId: 'session-planner-scout-retry' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the deep review pass.'),
          { sessionId: 'session-generator-scout-retry' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          buildVerdictResponse('## Findings\n\n- The review is ready.', 'accept', 'The review is complete.'),
          { sessionId: 'session-evaluator-scout-retry' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Review the repository changes and coordinate when needed.',
    );

    expect(result.success).toBe(true);
    const scoutPrompts = prompts.filter((prompt) => prompt.includes('You are the Scout role'));
    expect(scoutPrompts).toHaveLength(2);
    expect(scoutPrompts[1]).toContain('Previous same-role summary:');
    expect(scoutPrompts[1]).toContain('Scout thinks H2 is warranted because the mutation task is broad and high-risk.');
  });

  it('projects skill content through Scout into H2 mutation roles without sharing the raw skill everywhere', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-skill-map-');
    const prompts: string[] = [];

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'edit',
        taskFamily: 'implementation',
        executionPattern: 'coordinated',
        recommendedMode: 'implementation',
        complexity: 'complex',
        riskLevel: 'high',
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'code',
        reason: 'Skill-driven mutation work should use the coordinated harness.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      prompts.push(workerPrompt);
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            'Scout decomposed the skill for the coordinated mutation task.',
            'H2_PLAN_EXECUTE_EVAL',
            {
              skillSummary: 'Use the implementation skill to inspect the target files and carry out the refactor.',
              projectionConfidence: 'low',
              executionObligations: ['Inspect the target files deeply.', 'Apply the required refactor steps.'],
              verificationObligations: ['Confirm the refactor is backed by code evidence.', 'Reject unsupported completion claims.'],
              ambiguities: ['The skill does not define which validation checks are mandatory.'],
            },
          ),
          { sessionId: 'session-scout-skill-map' },
        );
      }
      if (workerPrompt.includes('You are the Planner role')) {
        return buildAssistantResult(
          buildContractResponse('Planner produced the sprint contract from the skill map.'),
          { sessionId: 'session-planner-skill-map' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the mutation task using the skill map and raw skill.'),
          { sessionId: 'session-generator-skill-map' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          buildVerdictResponse(
            '发现 1: `task-engine.ts` 仍有一个预算边界问题。',
            'accept',
            'The final review findings are evidence-backed and complete.',
          ),
          { sessionId: 'session-evaluator-skill-map' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
          rawUserInput: '请用 review skill 审查当前仓库改动',
          skillInvocation: {
            name: 'implementation-skill',
            path: '/tmp/implementation-skill/SKILL.md',
            description: 'Refactor the target implementation safely.',
            arguments: '--focus repo',
            allowedTools: 'Read, Grep, Bash(git status)',
            context: 'fork',
            agent: 'implementer',
            argumentHint: '--focus <scope>',
            model: 'sonnet',
            hookEvents: ['UserPromptSubmit'],
            expandedContent: '# Implementation Skill\n1. Inspect the target files.\n2. Apply the refactor.\n3. Validate the result.',
          },
        },
      },
      'Expanded skill body that should not be the only shared prompt.',
    );

    expect(result.success).toBe(true);
    const scoutPrompt = prompts.find((item) => item.includes('You are the Scout role'));
    const plannerPrompt = prompts.find((item) => item.includes('You are the Planner role'));
    const generatorPrompt = prompts.find((item) => item.includes('You are the Generator role'));
    const evaluatorPrompt = prompts.find((item) => item.includes('You are the Evaluator role'));

    expect(scoutPrompt).toContain('Full expanded skill (authoritative execution reference):');
    expect(scoutPrompt).toContain('Inspect the target files.');
    expect(plannerPrompt).toContain('Skill map:');
    expect(plannerPrompt).toContain('When multiple read-only tool calls are independent, emit them in the same response so parallel mode can run them together.');
    expect(plannerPrompt).toContain('Projection confidence: low');
    expect(plannerPrompt).not.toContain('Full expanded skill (authoritative execution reference):');
    expect(generatorPrompt).toContain('Full expanded skill (authoritative execution reference):');
    expect(generatorPrompt).toContain('Treat the raw skill as the authoritative execution reference');
    expect(generatorPrompt).toContain('Skill map:');
    expect(evaluatorPrompt).toContain('Skill map:');
    expect(evaluatorPrompt).toContain('Do not describe yourself as reviewing or judging another role.');
    expect(evaluatorPrompt).not.toContain('Full expanded skill (authoritative execution reference):');
    expect(evaluatorPrompt).toContain('Only if the skill map is incomplete');
    expect(result.managedTask?.runtime?.skillMap).toEqual(
      expect.objectContaining({
        skillSummary: 'Use the implementation skill to inspect the target files and carry out the refactor.',
        projectionConfidence: 'low',
        rawSkillFallbackAllowed: true,
      }),
    );
    expect(result.managedTask?.evidence.artifacts.map((artifact) => artifact.path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('skill-execution.md'),
        expect.stringContaining('skill-map.json'),
        expect.stringContaining('skill-map.md'),
      ]),
    );
    expect(result.lastText).not.toContain('verified the Generator');
    expect(prompts.some((prompt) => prompt.includes('You are the Planner role'))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('You are the Evaluator role'))).toBe(true);
  });

  it('strips evaluator-only framing from the final public answer in explicit-check H1 reviews', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-evaluator-public-answer-');

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'high',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
        assuranceIntent: 'explicit-check',
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'Explicit double-check review should use lightweight checked-direct evaluation.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H1 for the review.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout-evaluator-public' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the checked-direct review pass.'),
          { sessionId: 'session-generator-evaluator-public' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          buildVerdictResponse(
            [
              'Confirmed: the verifier has enough evidence to finish the review.',
              '',
              "I've completed my spot-check verification of the Generator's review findings. Here is my final evaluation.",
              '',
              'I now have sufficient evidence to deliver the final review.',
              '',
              'From the code I already read in reasoning.ts:',
              '1. Review takes priority over implementation.',
              '2. Lookup only runs after actionable paths.',
              '',
              '## Findings',
              '',
              '- The review is ready to send to the user.',
            ].join('\n'),
            'accept',
            'The review is complete and well-supported.',
          ),
          { sessionId: 'session-evaluator-public-answer' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      '请 review 当前仓库改动，并直接给出最终审查结论。',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toContain('## Findings');
    expect(result.lastText).toContain('The review is ready to send to the user.');
    expect(result.lastText).not.toContain('Confirmed:');
    expect(result.lastText).not.toContain('I now have sufficient evidence');
    expect(result.lastText).not.toContain('From the code I already read');
    expect(result.lastText).not.toContain('verified the Generator');
    expect(result.lastText).not.toContain('final evaluation');
  });

  it('prefers structured user_answer content over legacy visible text in evaluator verdicts', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-evaluator-user-answer-');
    const structuredUserAnswer = [
      "I've completed the final review of the retry path and found two regressions that still need to be called out.",
      '',
      '## Findings',
      '',
      '- The retry counter still resets on timeout.',
    ].join('\n');

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'high',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
        assuranceIntent: 'explicit-check',
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'Explicit double-check review should use lightweight checked-direct evaluation.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H1 for the review.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout-evaluator-user-answer' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the checked-direct review pass.'),
          { sessionId: 'session-generator-evaluator-user-answer' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          buildVerdictResponse(
            [
              'Confirmed: the verifier has enough evidence to finish the review.',
              '',
              'I now have sufficient evidence to deliver the final review.',
            ].join('\n'),
            'accept',
            'The review is complete and well-supported.',
            {
              userAnswer: structuredUserAnswer,
            },
          ),
          { sessionId: 'session-evaluator-user-answer' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Please review the current repository changes and do a second pass before sending the final review.',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toBe(structuredUserAnswer);
    expect(result.lastText).not.toContain('Confirmed:');
    expect(result.lastText).not.toContain('I now have sufficient evidence');
  });

  it.each([
    'I checked the null-handling path and found two regressions that still need to be called out.',
    'I reviewed the null-handling path and identified two regressions that still need to be called out.',
    "I've completed the final review of the retry path and found two regressions that still need to be called out.",
  ])('preserves legitimate technical lead paragraphs in evaluator public answers: %s', async (leadParagraph) => {
    const workspaceRoot = await createTempDir('kodax-task-engine-evaluator-technical-lead-');

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'high',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
        assuranceIntent: 'explicit-check',
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'Explicit double-check review should use lightweight checked-direct evaluation.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H1 for the review.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout-evaluator-technical' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the checked-direct review pass.'),
          { sessionId: 'session-generator-evaluator-technical' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          buildVerdictResponse(
            [
              leadParagraph,
              '',
              '## Findings',
              '',
              '- The fallback branch still leaks stale state.',
            ].join('\n'),
            'accept',
            'The review is complete and well-supported.',
          ),
          { sessionId: 'session-evaluator-technical-lead' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Please review the current repository changes and do a second pass before sending the final review.',
    );

    expect(result.success).toBe(true);
    expect(result.lastText).toContain(leadParagraph);
    expect(result.lastText).toContain('## Findings');
    expect(result.lastText).toContain('The fallback branch still leaks stale state.');
  });

  it('does not block Scout H0 completion on task-scoped repo-intelligence capture', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-h0-background-root-');
    const repoRoot = await createTempDir('kodax-task-engine-h0-background-repo-');
    const moduleGate = createDeferred<void>();

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        reason: 'Review stays on Scout and should return without waiting for repo snapshotting.',
      }),
    );
    mockGetRepoOverview.mockResolvedValue({ kind: 'overview', workspaceRoot: repoRoot });
    mockAnalyzeChangedScope.mockResolvedValue({ kind: 'changed-scope' });
    mockGetModuleContext.mockImplementation(async () => {
      await moduleGate.promise;
      return { kind: 'module-context' };
    });
    mockGetImpactEstimate.mockResolvedValue({ kind: 'impact-estimate' });

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout can complete this review directly.', 'H0_DIRECT'),
          { sessionId: 'session-scout-h0-background' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await Promise.race([
      runManagedTask(
        {
          provider: 'anthropic',
          agentMode: 'ama',
          context: {
            managedTaskWorkspaceDir: workspaceRoot,
            executionCwd: repoRoot,
            gitRoot: repoRoot,
            repoIntelligenceMode: 'oss',
            repoRoutingSignals: buildRepoRoutingSignals({ workspaceRoot: repoRoot }),
          },
        },
        'Please inspect the current changes and tell me if the review can finish directly.',
      ),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('runManagedTask unexpectedly waited on background repo-intelligence capture.')), 250);
      }),
    ]);

    expect(result.success).toBe(true);
    expect(result.lastText).toContain('Scout can complete this review directly.');
    expect(result.managedTask?.evidence.artifacts.some((artifact) => artifact.path.includes(`${path.sep}repo-intelligence${path.sep}`))).toBe(false);

    moduleGate.resolve();

    const summaryPath = path.join(result.managedTask!.evidence.workspaceDir, 'repo-intelligence', 'summary.md');
    const summaryContent = await waitForFileContentContaining(summaryPath, [
      'Repository overview summary',
      'Changed scope summary',
      'Module context summary',
      'Impact estimate summary',
    ]);
    expect(summaryContent).toContain('Repository overview summary');
    expect(summaryContent).toContain('Changed scope summary');
    expect(summaryContent).toContain('Module context summary');
    expect(summaryContent).toContain('Impact estimate summary');
  });

  it('keeps task-scoped repo-intelligence attached synchronously for H1 managed runs', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-h1-repo-intelligence-root-');
    const repoRoot = await createTempDir('kodax-task-engine-h1-repo-intelligence-repo-');

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        executionPattern: 'checked-direct',
        recommendedMode: 'pr-review',
        complexity: 'moderate',
        riskLevel: 'high',
        harnessProfile: 'H1_EXECUTE_EVAL',
        needsIndependentQA: true,
        mutationSurface: 'read-only',
        assuranceIntent: 'explicit-check',
        topologyCeiling: 'H1_EXECUTE_EVAL',
        upgradeCeiling: 'H1_EXECUTE_EVAL',
        reason: 'H1 should keep task-scoped repo intelligence on the synchronous path.',
      }),
    );
    mockGetRepoOverview.mockResolvedValue({ kind: 'overview', workspaceRoot: repoRoot });
    mockAnalyzeChangedScope.mockResolvedValue({ kind: 'changed-scope' });
    mockGetModuleContext.mockResolvedValue({ kind: 'module-context' });
    mockGetImpactEstimate.mockResolvedValue({ kind: 'impact-estimate' });

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H1 for the review.', 'H1_EXECUTE_EVAL'),
          { sessionId: 'session-scout-h1-sync-repo-intelligence' },
        );
      }
      if (workerPrompt.includes('You are the Generator role')) {
        return buildAssistantResult(
          buildHandoffResponse('Generator completed the checked-direct review pass.'),
          { sessionId: 'session-generator-h1-sync-repo-intelligence' },
        );
      }
      if (workerPrompt.includes('You are the Evaluator role')) {
        return buildAssistantResult(
          buildVerdictResponse(
            ['## Findings', '', '- The review is complete.'].join('\n'),
            'accept',
            'The review is complete and well-supported.',
          ),
          { sessionId: 'session-evaluator-h1-sync-repo-intelligence' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
        context: {
          managedTaskWorkspaceDir: workspaceRoot,
          executionCwd: repoRoot,
          gitRoot: repoRoot,
          repoIntelligenceMode: 'oss',
          repoRoutingSignals: buildRepoRoutingSignals({ workspaceRoot: repoRoot }),
        },
      },
      'Please review the current repository changes and do a second pass before sending the final review.',
    );

    expect(result.success).toBe(true);
    expect(result.managedTask?.evidence.artifacts.map((artifact) => artifact.path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${path.sep}repo-intelligence${path.sep}summary.md`),
        expect.stringContaining(`${path.sep}repo-intelligence${path.sep}repo-overview.json`),
      ]),
    );

    const summaryPath = path.join(result.managedTask!.evidence.workspaceDir, 'repo-intelligence', 'summary.md');
    await expect(readFile(summaryPath, 'utf8')).resolves.toContain('Repository overview summary');
    expect(mockGetModuleContext).toHaveBeenCalledTimes(1);
    expect(mockGetImpactEstimate).toHaveBeenCalledTimes(1);
  });

  it('logs and tolerates background repo-intelligence failures after H0 completion', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-h0-background-failure-root-');
    const repoRoot = await createTempDir('kodax-task-engine-h0-background-failure-repo-');
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    process.env.KODAX_DEBUG_REPO_INTELLIGENCE = '1';

    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'review',
        taskFamily: 'review',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H0_DIRECT',
        reason: 'Background repo snapshot failures should be logged without affecting the final answer.',
      }),
    );
    mockGetRepoOverview.mockRejectedValue(new Error('repo overview failed'));
    mockAnalyzeChangedScope.mockRejectedValue(new Error('changed scope failed'));
    mockGetModuleContext.mockRejectedValue(new Error('module context failed'));
    mockGetImpactEstimate.mockRejectedValue(new Error('impact estimate failed'));

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse('Scout can complete this review directly.', 'H0_DIRECT'),
          { sessionId: 'session-scout-h0-background-failure' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
    });

    try {
      const result = await runManagedTask(
        {
          provider: 'anthropic',
          agentMode: 'ama',
          context: {
            managedTaskWorkspaceDir: workspaceRoot,
            executionCwd: repoRoot,
            gitRoot: repoRoot,
            repoIntelligenceMode: 'oss',
            repoRoutingSignals: buildRepoRoutingSignals({ workspaceRoot: repoRoot }),
          },
        },
        'Please inspect the current changes and finish directly if safe.',
      );

      expect(result.success).toBe(true);
      expect(result.lastText).toContain('Scout can complete this review directly.');

      await vi.waitFor(() => {
        expect(debugSpy).toHaveBeenCalled();
      });
    } finally {
      debugSpy.mockRestore();
    }
  });
});
