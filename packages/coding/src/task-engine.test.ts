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

  it('routes AMA H0 lookup tasks through Scout instead of bypassing', async () => {
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
    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      if (workerPrompt.includes('You are the Scout role')) {
        return buildAssistantResult(
          buildScoutResponse(
            '状态栏由两个文件管理。',
            'H0_DIRECT',
            {
              harnessRationale: 'Simple lookup — answering directly.',
              directCompletionReady: 'yes',
              blockingEvidence: ['none'],
            },
          ),
          { sessionId: 'session-scout-lookup-h0' },
        );
      }
      throw new Error(`Unexpected prompt: ${workerPrompt.slice(0, 120)}`);
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
      },
      '现在状态栏是在哪个文件管理的？',
    );

    expect(result.success).toBe(true);
    expect(result.managedTask).toBeDefined();
    expect(statuses.some((status) => status.phase === 'preflight')).toBe(true);
    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(1);
    expect(result.lastText).toContain('状态栏由两个文件管理。');
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

    // Scout has full tool access (no tool policy restriction).
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

  it('Scout keeps H1 when the task explicitly requires independent verification', async () => {
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
            'Scout confirmed independent verification is needed for this review.',
            'H1_EXECUTE_EVAL',
            {
              harnessRationale: 'Independent verification is explicitly required — keeping H1.',
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
    expect(result.managedTask?.runtime?.routingOverrideReason).toBeUndefined();
    expect(result.lastText).toContain('## Findings');
  });

  it('Scout escalates to H2 for high-risk system-level overwrite work', async () => {
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
            'Scout determined this high-risk system overwrite needs coordinated execution.',
            'H2_PLAN_EXECUTE_EVAL',
            {
              harnessRationale: 'High-risk system-level overwrite requires coordinated planning and execution.',
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
            'System edit completed under coordinated H2 execution.',
            'accept',
            'The high-risk overwrite was handled through coordinated planning and execution.',
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
    expect(result.managedTask?.runtime?.routingOverrideReason).toBeUndefined();
    expect(result.lastText).toContain('System edit completed');
  });

  // Scout completes H0 tasks directly without protocol — single agent run.
  it('completes H0 directly when Scout does not emit protocol (inferred H0)', async () => {
    mockCreateReasoningPlan.mockResolvedValue(
      buildPlan({
        primaryTask: 'edit',
        taskFamily: 'implementation',
        executionPattern: 'direct',
        recommendedMode: 'implementation',
        complexity: 'simple',
        riskLevel: 'low',
        mutationSurface: 'code',
        harnessProfile: 'H0_DIRECT',
        topologyCeiling: 'H2_PLAN_EXECUTE_EVAL',
        upgradeCeiling: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Simple file edit completed directly by Scout.',
      }),
    );

    // Scout completes the task without calling emit_managed_protocol
    mockRunDirectKodaX.mockResolvedValue(
      buildAssistantResult(
        'Done — updated .gitignore with output/ and .agent/ entries.',
        { sessionId: 'session-scout-direct' },
      ),
    );

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'ama',
      },
      'Add output/ and .agent/ to .gitignore',
    );

    // Single agent run — no retry, no continuation
    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(1);
    expect(result.routingDecision?.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
    expect(result.lastText).toContain('updated .gitignore');
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
    expect(scoutPrompt).toContain('For complex tasks (H1/H2): investigate scope, then call emit_managed_protocol to escalate.');
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

  it('escalates to H2 when Scout emits protocol requesting H2 for complex mutation work', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-scout-escalation-');
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
        reason: 'Broad mutation work needs coordinated refinement.',
      }),
    );

    mockRunDirectKodaX.mockImplementation(async (_options, workerPrompt: string) => {
      prompts.push(workerPrompt);
      if (workerPrompt.includes('You are the Scout role')) {
        // Scout escalates to H2 in its first (and only) run
        return buildAssistantResult(
          buildScoutResponse('Scout confirmed H2 — broad mutation task is high-risk.', 'H2_PLAN_EXECUTE_EVAL'),
          { sessionId: 'session-scout-escalation' },
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
    // Single Scout run (no retry) — Scout escalates in one attempt
    const scoutPrompts = prompts.filter((prompt) => prompt.includes('You are the Scout role'));
    expect(scoutPrompts).toHaveLength(1);
    expect(result.managedTask?.contract.harnessProfile).toBe('H2_PLAN_EXECUTE_EVAL');
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
