import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillRegistry } from '@kodax-ai/agent';
import type { ReasoningPlan } from './reasoning.js';
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

vi.mock('./repo-intelligence/runtime.js', async () => {
  const actual = await vi.importActual<typeof import('./repo-intelligence/runtime.js')>('./repo-intelligence/runtime.js');
  return {
    ...actual,
    getImpactEstimate: mockGetImpactEstimate,
    getModuleContext: mockGetModuleContext,
    renderImpactEstimate: mockRenderImpactEstimate,
    renderModuleContext: mockRenderModuleContext,
  };
});

import { ensureManagedSkillCatalog, runManagedTask } from './task-engine.js';

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
    effort: 'auto',
    promptOverlay: '[Routing] test',
    decision,
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
  it('binds only model-visible Skills for a plain AMA managed run', async () => {
    const root = await createTempDir('kodax-managed-skill-catalog-');
    for (const [name, disabled] of [
      ['natural-review', false],
      ['explicit-only', true],
    ] as const) {
      const skillDir = path.join(root, '.kodax', 'skills', name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), [
        '---',
        `name: ${name}`,
        `description: ${name} description`,
        ...(disabled ? ['disable-model-invocation: true'] : []),
        '---',
        '',
        'Test.',
      ].join('\n'), 'utf8');
    }

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root);
    const options = await ensureManagedSkillCatalog({
      provider: 'anthropic',
      agentMode: 'ama',
    }).finally(() => cwdSpy.mockRestore());

    expect(options.agentMode).toBe('ama');
    expect(options.context?.skillsPrompt).toContain('natural-review');
    expect(options.context?.skillsPrompt).not.toContain('explicit-only');
    expect(options.context?.skillRegistry?.has('natural-review')).toBe(true);
    expect(options.context?.skillRegistry?.has('explicit-only')).toBe(true);
  });

  it('preserves a host-provided managed Skill catalog', async () => {
    const options = {
      provider: 'anthropic',
      agentMode: 'ama' as const,
      context: { skillsPrompt: '[Pinned Skill Catalog]' },
    };

    await expect(ensureManagedSkillCatalog(options)).resolves.toBe(options);
  });

  it('keeps enforced Skill catalog discovery failures local before managed dispatch', async () => {
    const cause = new Error('Unreadable private Skill source');
    const discover = vi.spyOn(SkillRegistry.prototype, 'discover').mockRejectedValue(cause);
    try {
      await expect(ensureManagedSkillCatalog({ provider: 'anthropic', context: {
        skillInvocation: { name: 'draft-response', runtimePolicy: { enforceAtRuntime: true } },
      } })).rejects.toMatchObject({ code: 'skill_registry_unavailable', source: 'local', stage: 'skill_load' });
    } finally { discover.mockRestore(); }
  });

  it('waits for runtime-owned PostToolUse hooks before returning', async () => {
    const root = await createTempDir('kodax-managed-skill-hook-');
    const skillDir = path.join(root, '.kodax', 'skills', 'delayed-skill');
    const marker = path.join(root, 'post-hook.txt');
    const encodedMarker = Buffer.from(marker, 'utf8').toString('base64');
    const hookCommand = `"${process.execPath}" -e "setTimeout(()=>require('node:fs').writeFileSync(Buffer.from('${encodedMarker}','base64').toString(),'done'),80)"`;
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: delayed-skill',
      'description: delayed hook fixture',
      'hooks:',
      '  PostToolUse:',
      '    - matcher: read',
      `      command: ${JSON.stringify(hookCommand)}`,
      '---',
      '',
      'Test.',
    ].join('\n'), 'utf8');
    mockRunDirectKodaX.mockImplementationOnce(async (options) => {
      options.events?.onToolResult?.({ id: 'read-1', name: 'read', content: 'ok' });
      return buildAssistantResult('done');
    });

    await runManagedTask({
      provider: 'anthropic',
      agentMode: 'sa',
      events: { beforeToolExecute: async () => true },
      context: {
        gitRoot: root,
        executionCwd: root,
        skillInvocation: {
          name: 'delayed-skill',
          path: path.join(skillDir, 'SKILL.md'),
          expandedContent: '<skill name="delayed-skill">test</skill>',
          runtimePolicy: { enforceAtRuntime: true },
        },
      },
    }, 'run delayed skill');

    await expect(readFile(marker, 'utf8')).resolves.toBe('done');
    mockRunDirectKodaX.mockClear();
  });

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

  it('strips the multi-agent / workflow tool cluster from the SA tool surface (no sub-agents, no workflows)', async () => {
    mockRunDirectKodaX.mockClear();
    mockRunDirectKodaX.mockResolvedValue(buildAssistantResult('ok'));

    await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'sa',
        context: { excludeTools: ['some_preexisting_tool'] },
      },
      'a solo question',
    );

    const passedExclude = mockRunDirectKodaX.mock.calls.at(-1)?.[0].context?.excludeTools ?? [];
    // Solo agent: no sub-agents, no workflow.
    expect(passedExclude).toContain('spawn_agent');
    expect(passedExclude).toContain('run_workflow');
    expect(passedExclude).toContain('send_message');
    expect(passedExclude).toContain('followup_task');
    expect(passedExclude).toContain('wait_agent');
    expect(passedExclude).toContain('interrupt_agent');
    expect(passedExclude).toContain('list_agents');
    expect(passedExclude).toContain('agent_output');
    // Pre-existing excludeTools are preserved, not clobbered.
    expect(passedExclude).toContain('some_preexisting_tool');
  });

});
