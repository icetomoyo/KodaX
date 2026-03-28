import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateReasoningPlan,
  mockResolveProvider,
  mockRunDirectKodaX,
} = vi.hoisted(() => ({
  mockCreateReasoningPlan: vi.fn(),
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

import { runManagedTask } from './task-engine.js';

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initGitRepo(workspaceRoot: string): void {
  execFileSync('git', ['init'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'KodaX Test'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'kodax-test@example.com'], { cwd: workspaceRoot, stdio: 'ignore' });
}

function commitAll(workspaceRoot: string, message: string): void {
  execFileSync('git', ['add', '.'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', message], { cwd: workspaceRoot, stdio: 'ignore' });
}

function createRepoFixture(workspaceRoot: string): void {
  mkdirSync(path.join(workspaceRoot, 'packages', 'app', 'src'), { recursive: true });
  mkdirSync(path.join(workspaceRoot, 'packages', 'shared', 'src'), { recursive: true });

  writeFileSync(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'managed-task-fixture' }, null, 2));
  writeFileSync(path.join(workspaceRoot, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@fixture/app' }, null, 2));
  writeFileSync(path.join(workspaceRoot, 'packages', 'shared', 'package.json'), JSON.stringify({ name: '@fixture/shared' }, null, 2));

  writeFileSync(path.join(workspaceRoot, 'packages', 'shared', 'src', 'strings.ts'), [
    'export function normalizeName(input: string): string {',
    '  return input.trim().toLowerCase();',
    '}',
    '',
  ].join('\n'));

  writeFileSync(path.join(workspaceRoot, 'packages', 'app', 'src', 'boot.ts'), [
    "import { normalizeName } from '../../shared/src/strings';",
    '',
    'export function bootApp(input: string): string {',
    '  return normalizeName(input);',
    '}',
    '',
    "bootApp('Demo');",
    '',
  ].join('\n'));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  mockCreateReasoningPlan.mockReset();
  mockResolveProvider.mockClear();
  mockRunDirectKodaX.mockReset();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('runManagedTask', () => {
  it('runs low-complexity tasks in H0 direct mode and writes managed-task artifacts', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'low',
      promptOverlay: '[Routing] direct',
      decision: {
        primaryTask: 'edit',
        confidence: 0.91,
        riskLevel: 'low',
        recommendedMode: 'implementation',
        recommendedThinkingDepth: 'low',
        complexity: 'simple',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H0_DIRECT',
        reason: 'Simple execution',
      },
    });
    mockRunDirectKodaX.mockResolvedValue({
      success: true,
      lastText: 'Handled directly.',
      messages: [{ role: 'assistant', content: 'Handled directly.' }],
      sessionId: 'session-direct',
      routingDecision: undefined,
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Fix the typo in the README.'
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.routingDecision?.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.roleAssignments).toEqual([
      expect.objectContaining({
        id: 'direct',
        role: 'direct',
        status: 'completed',
      }),
    ]);

    const artifact = JSON.parse(
      await readFile(path.join(result.managedTask!.evidence.workspaceDir, 'managed-task.json'), 'utf8')
    );
    expect(artifact.contract.taskId).toBe(result.managedTask?.contract.taskId);
    expect(result.managedTask?.evidence.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: path.join(result.managedTask!.evidence.workspaceDir, 'managed-task.json'),
        }),
        expect.objectContaining({
          path: path.join(result.managedTask!.evidence.workspaceDir, 'result.json'),
        }),
      ]),
    );
  });

  it('runs planner, contract review, generator, and evaluator roles for H2 managed tasks', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] h2',
      decision: {
        primaryTask: 'plan',
        confidence: 0.88,
        riskLevel: 'medium',
        recommendedMode: 'planning',
        recommendedThinkingDepth: 'medium',
        complexity: 'complex',
        workIntent: 'overwrite',
        requiresBrainstorm: true,
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Planning-heavy execution',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Planner role')) {
        return {
          success: true,
          lastText: [
            'Plan ready with evidence checklist.',
            '```kodax-task-contract',
            'summary: Deliver the release checklist flow safely.',
            'success_criteria:',
            '- The release checklist flow is implemented end-to-end.',
            'required_evidence:',
            '- Automated verification covering the release checklist flow.',
            'constraints:',
            '- Preserve existing release rollback behavior.',
            '```',
          ].join('\n'),
          messages: [{ role: 'assistant', content: [
            'Plan ready with evidence checklist.',
            '```kodax-task-contract',
            'summary: Deliver the release checklist flow safely.',
            'success_criteria:',
            '- The release checklist flow is implemented end-to-end.',
            'required_evidence:',
            '- Automated verification covering the release checklist flow.',
            'constraints:',
            '- Preserve existing release rollback behavior.',
            '```',
          ].join('\n') }],
          sessionId: 'session-planner',
        };
      }

      if (prompt.includes('Contract Reviewer role')) {
        return {
          success: true,
          lastText: [
            'The contract is concrete enough to execute.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The planned work is specific and verifiable.',
            'followup:',
            '- Proceed with implementation against the agreed contract.',
            '```',
          ].join('\n'),
          messages: [{ role: 'assistant', content: [
            'The contract is concrete enough to execute.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The planned work is specific and verifiable.',
            'followup:',
            '- Proceed with implementation against the agreed contract.',
            '```',
          ].join('\n') }],
          sessionId: 'session-contract-review',
        };
      }

      if (prompt.includes('Generator role')) {
        return {
          success: true,
          lastText: 'Implementation complete with updated tests.',
          messages: [{ role: 'assistant', content: 'Implementation complete with updated tests.' }],
          sessionId: 'session-generator',
        };
      }

      return {
        success: true,
        lastText: [
          'Evaluator accepted the result.',
          '```kodax-task-verdict',
          'status: accept',
          'reason: The task is complete.',
          'followup:',
          '- Deliver the final answer.',
          '```',
        ].join('\n'),
        messages: [{
          role: 'assistant',
          content: [
            'Evaluator accepted the result.',
            '```kodax-task-verdict',
            'status: accept',
            'reason: The task is complete.',
            'followup:',
            '- Deliver the final answer.',
            '```',
          ].join('\n'),
        }],
        sessionId: 'session-evaluator',
        signal: 'COMPLETE',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'repl',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Design and implement the new release checklist flow.'
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(4);
    expect(result.lastText).toBe('Evaluator accepted the result.');
    expect(result.managedTask?.contract.harnessProfile).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(result.managedTask?.roleAssignments.map((assignment) => assignment.role)).toEqual([
      'planner',
      'validator',
      'generator',
      'evaluator',
    ]);
    expect(result.managedTask?.evidence.entries).toEqual([
      expect.objectContaining({ assignmentId: 'planner', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'contract-review', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'generator', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'evaluator', status: 'completed', signal: 'COMPLETE' }),
    ]);
    expect(result.managedTask?.roleAssignments).toEqual([
      expect.objectContaining({ id: 'planner', agent: 'PlanningAgent' }),
      expect.objectContaining({ id: 'contract-review', agent: 'ContractReviewAgent' }),
      expect.objectContaining({ id: 'generator', agent: 'ExecutionAgent' }),
      expect.objectContaining({ id: 'evaluator', agent: 'EvaluationAgent' }),
    ]);
    expect(String(mockRunDirectKodaX.mock.calls[1]?.[1])).toContain('Dependency handoff artifacts:');
    expect(String(mockRunDirectKodaX.mock.calls[2]?.[1])).toContain('Dependency handoff artifacts:');
  });

  it('preserves the full terminal evaluator output instead of replacing it with the managed-task summary', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] h1-long-final',
      decision: {
        primaryTask: 'review',
        confidence: 0.9,
        riskLevel: 'medium',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        workIntent: 'overwrite',
        requiresBrainstorm: false,
        harnessProfile: 'H1_EXECUTE_EVAL',
        reason: 'Review requires independent QA.',
      },
    });

    const longReview = [
      'Final review: confirmed issues with detailed reasoning.',
      '',
      ...Array.from({ length: 32 }, (_, index) => `Must fix ${index + 1}: detailed explanation line ${index + 1}.`),
    ].join('\n');

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Generator role')) {
        return {
          success: true,
          lastText: 'Generator draft review.',
          messages: [{ role: 'assistant', content: 'Generator draft review.' }],
          sessionId: 'session-generator',
        };
      }

      return {
        success: true,
        lastText: [
          longReview,
          '```kodax-task-verdict',
          'status: accept',
          'reason: The final review is complete.',
          'followup:',
          '- Deliver the final review.',
          '```',
        ].join('\n'),
        messages: [{
          role: 'assistant',
          content: [
            longReview,
            '```kodax-task-verdict',
            'status: accept',
            'reason: The final review is complete.',
            'followup:',
            '- Deliver the final review.',
            '```',
          ].join('\n'),
        }],
        sessionId: 'session-evaluator',
        signal: 'COMPLETE',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'repl',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Review the release workflow changes and deliver the final code review.'
    );

    expect(result.lastText).toBe(longReview);
    expect(result.messages.at(-1)?.content).toBe(longReview);
    expect(result.managedTask?.verdict.summary).toBe(longReview);
  });

  it('can omit the evaluator for low-risk AMA tasks that stay within the solo implementation boundary', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    const textDeltas: string[] = [];
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] h2-optional-qa',
      decision: {
        primaryTask: 'edit',
        confidence: 0.87,
        riskLevel: 'low',
        recommendedMode: 'implementation',
        recommendedThinkingDepth: 'medium',
        complexity: 'complex',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Complex but low-risk implementation task.',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Planner role')) {
        return {
          success: true,
          lastText: [
            'Plan ready.',
            '```kodax-task-contract',
            'summary: Add the low-risk enhancement safely.',
            'success_criteria:',
            '- Enhancement works end-to-end.',
            'required_evidence:',
            '- Minimal implementation evidence.',
            'constraints:',
            '- Preserve existing behavior.',
            '```',
          ].join('\n'),
          messages: [{ role: 'assistant', content: [
            'Plan ready.',
            '```kodax-task-contract',
            'summary: Add the low-risk enhancement safely.',
            'success_criteria:',
            '- Enhancement works end-to-end.',
            'required_evidence:',
            '- Minimal implementation evidence.',
            'constraints:',
            '- Preserve existing behavior.',
            '```',
          ].join('\n') }],
          sessionId: 'session-planner-optional-qa',
        };
      }

      if (prompt.includes('Contract Reviewer role')) {
        return {
          success: true,
          lastText: [
            'The contract is approved for direct implementation.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The task stays within the solo implementation boundary.',
            'followup:',
            '- Proceed directly to implementation.',
            '```',
          ].join('\n'),
          messages: [{ role: 'assistant', content: [
            'The contract is approved for direct implementation.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The task stays within the solo implementation boundary.',
            'followup:',
            '- Proceed directly to implementation.',
            '```',
          ].join('\n') }],
          sessionId: 'session-contract-review-optional-qa',
        };
      }

      return {
        success: true,
        lastText: 'Final implementation answer delivered directly by the generator.',
        messages: [{ role: 'assistant', content: 'Final implementation answer delivered directly by the generator.' }],
        sessionId: 'session-generator-optional-qa',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
        events: {
          onTextDelta: (text) => {
            textDeltas.push(text);
          },
        },
      },
      'Implement the small enhancement and keep the rest of the workflow unchanged.'
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(3);
    expect(mockRunDirectKodaX.mock.calls.some((call) => String(call[1]).includes('Evaluator role'))).toBe(false);
    expect(textDeltas.join('')).toContain('quality assurance mode=optional');
    expect(result.success).toBe(true);
    expect(result.managedTask?.roleAssignments.map((assignment) => assignment.role)).toEqual([
      'planner',
      'validator',
      'generator',
    ]);
    const generatorCall = mockRunDirectKodaX.mock.calls.find((call) =>
      String(call[1]).includes('Generator role')
    );
    expect(String(generatorCall?.[1])).toContain('You are the terminal delivery role for this run.');
  });

  it('forces single-agent execution when agent mode is SA', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'high',
      promptOverlay: '[Routing] h3',
      decision: {
        primaryTask: 'edit',
        confidence: 0.93,
        riskLevel: 'high',
        recommendedMode: 'implementation',
        recommendedThinkingDepth: 'high',
        complexity: 'complex',
        workIntent: 'overwrite',
        requiresBrainstorm: false,
        harnessProfile: 'H3_MULTI_WORKER',
        reason: 'Requires role-split execution and validation',
      },
    });
    mockRunDirectKodaX.mockResolvedValue({
      success: true,
      lastText: 'Handled in single-agent mode.',
      messages: [{ role: 'assistant', content: 'Handled in single-agent mode.' }],
      sessionId: 'session-sa',
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'sa',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Implement the release workflow and validate it before accepting.'
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(1);
    expect(result.routingDecision?.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.roleAssignments).toEqual([
      expect.objectContaining({
        id: 'direct',
        role: 'direct',
        status: 'completed',
      }),
    ]);
    expect(result.routingDecision?.reason).toContain('Agent mode SA forced single-agent execution');
    expect(String(mockRunDirectKodaX.mock.calls[0]?.[0]?.context?.promptOverlay ?? '')).toContain('[Agent Mode: SA]');
  });

  it('injects verification contracts into evaluator runs and enforces evaluator tool policy', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] verify-ui',
      decision: {
        primaryTask: 'verify',
        confidence: 0.9,
        riskLevel: 'medium',
        recommendedMode: 'implementation',
        recommendedThinkingDepth: 'medium',
        complexity: 'complex',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Verification-heavy flow',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => ({
      success: true,
      lastText: prompt.includes('Evaluator role')
        ? [
            'Evaluator finished after browser verification.',
            '```kodax-task-verdict',
            'status: accept',
            'reason: Browser verification is complete.',
            'followup:',
            '- Deliver the validated result.',
            '```',
          ].join('\n')
        : prompt.includes('Contract Reviewer role')
          ? [
              'The contract is ready for browser verification work.',
              '```kodax-task-contract-review',
              'status: approve',
              'reason: The verification scope and evidence are explicit.',
              'followup:',
              '- Proceed with implementation and validation.',
              '```',
            ].join('\n')
          : 'Intermediate worker finished.',
      messages: [{
        role: 'assistant',
        content: prompt.includes('Evaluator role')
          ? [
              'Evaluator finished after browser verification.',
              '```kodax-task-verdict',
              'status: accept',
              'reason: Browser verification is complete.',
              'followup:',
              '- Deliver the validated result.',
              '```',
            ].join('\n')
          : prompt.includes('Contract Reviewer role')
            ? [
                'The contract is ready for browser verification work.',
                '```kodax-task-contract-review',
                'status: approve',
                'reason: The verification scope and evidence are explicit.',
                'followup:',
                '- Proceed with implementation and validation.',
                '```',
              ].join('\n')
            : 'Intermediate worker finished.',
      }],
      sessionId: prompt.includes('Evaluator role')
        ? 'session-evaluator'
        : prompt.includes('Contract Reviewer role')
          ? 'session-contract-review'
          : 'session-worker',
      signal: prompt.includes('Evaluator role') ? 'COMPLETE' : undefined,
    }));

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        session: {
          id: 'outer-user-session',
          scope: 'user',
          storage: {
            save: vi.fn(async () => {}),
            load: vi.fn(async () => null),
            list: vi.fn(async () => []),
          },
        },
        context: {
          taskSurface: 'project',
          managedTaskWorkspaceDir: workspaceRoot,
          taskMetadata: {
            featureIndex: 7,
            projectMode: 'next',
          },
          taskVerification: {
            summary: 'Run real frontend verification before accepting.',
            instructions: ['Use agent-browser or Playwright to execute the signup flow.'],
            requiredEvidence: ['Attach browser evidence and console findings.'],
            requiredChecks: ['playwright:e2e'],
            runtime: {
              cwd: workspaceRoot,
              startupCommand: 'npm run dev',
              baseUrl: 'http://localhost:4173',
              apiChecks: ['health: curl http://localhost:4173/health'],
            },
            capabilityHints: [
              { kind: 'skill', name: 'agent-browser', details: 'Preferred browser automation skill.' },
              { kind: 'tool', name: 'playwright', details: 'Fallback browser runner.' },
            ],
          },
        },
      },
      'Verify the signup flow on the frontend and only accept with browser evidence.'
    );

    const evaluatorCall = mockRunDirectKodaX.mock.calls.find((call) =>
      String(call[1]).includes('Evaluator role')
    );
    expect(evaluatorCall).toBeTruthy();
    const evaluatorOptions = evaluatorCall?.[0];

    expect(String(evaluatorCall?.[1])).toContain('Verification contract:');
    expect(String(evaluatorCall?.[1])).toContain('agent-browser');
    expect(String(evaluatorCall?.[1])).toContain('Runtime execution guide:');
    expect(String(evaluatorCall?.[1])).toContain('Startup command: npm run dev');
    expect(evaluatorOptions?.context?.promptOverlay).toContain('Task metadata:');
    expect(evaluatorOptions?.context?.promptOverlay).toContain('"featureIndex": 7');
    expect(evaluatorOptions?.context?.taskVerification?.requiredChecks).toContain('playwright:e2e');
    expect(evaluatorOptions?.session?.id).toContain('managed-task-worker-task-');
    expect(evaluatorOptions?.session?.id).toContain('-evaluator');
    expect(evaluatorOptions?.session?.scope).toBe('managed-task-worker');
    expect(evaluatorOptions?.session?.storage).toBeDefined();

    const allowBrowser = await evaluatorOptions?.events?.beforeToolExecute?.('bash', { command: 'npx playwright test' });
    const allowRuntimeStartup = await evaluatorOptions?.events?.beforeToolExecute?.('bash', { command: 'npm run dev' });
    const allowRuntimeHealth = await evaluatorOptions?.events?.beforeToolExecute?.('bash', { command: 'curl http://localhost:4173/health' });
    const blockRuntimeStartupWrite = await evaluatorOptions?.events?.beforeToolExecute?.('bash', { command: 'npm run dev > runtime.log' });
    const blockWrite = await evaluatorOptions?.events?.beforeToolExecute?.('write', { path: 'src/app.ts', content: 'oops' });
    const blockShellWrite = await evaluatorOptions?.events?.beforeToolExecute?.('bash', { command: 'echo broken > src/app.ts' });

    expect(allowBrowser).toBe(true);
    expect(allowRuntimeStartup).toBe(true);
    expect(allowRuntimeHealth).toBe(true);
    expect(typeof blockRuntimeStartupWrite).toBe('string');
    expect(typeof blockWrite).toBe('string');
    expect(typeof blockShellWrite).toBe('string');
    expect(result.managedTask?.contract.verification?.capabilityHints?.map((hint) => hint.name)).toContain('agent-browser');
    expect(result.managedTask?.evidence.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: path.join(result.managedTask!.evidence.workspaceDir, 'runtime-execution.md'),
        }),
      ]),
    );
    expect(result.managedTask?.roleAssignments.find((assignment) => assignment.id === 'evaluator')).toEqual(
      expect.objectContaining({
        agent: 'EvaluationAgent',
        toolPolicy: expect.objectContaining({
          summary: expect.stringContaining('Verification agents'),
        }),
      }),
    );
  });

  it('uses compact worker memory seeds instead of raw session resume when the context is already heavy', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] compact-memory',
      decision: {
        primaryTask: 'review',
        confidence: 0.86,
        riskLevel: 'medium',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H1_EXECUTE_EVAL',
        reason: 'Review task with very large context.',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Generator role')) {
        return {
          success: true,
          lastText: 'Compact-memory generator draft.',
          messages: [{ role: 'assistant', content: 'Compact-memory generator draft.' }],
          sessionId: 'session-generator-compact',
        };
      }

      return {
        success: true,
        lastText: [
          'Compact-memory review accepted.',
          '```kodax-task-verdict',
          'status: accept',
          'reason: The compact-memory run still produced a complete review.',
          'followup:',
          '- Deliver the final answer.',
          '```',
        ].join('\n'),
        messages: [{
          role: 'assistant',
          content: [
            'Compact-memory review accepted.',
            '```kodax-task-verdict',
            'status: accept',
            'reason: The compact-memory run still produced a complete review.',
            'followup:',
            '- Deliver the final answer.',
            '```',
          ].join('\n'),
        }],
        sessionId: 'session-evaluator-compact',
        signal: 'COMPLETE',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
          contextTokenSnapshot: {
            currentTokens: 130000,
            baselineEstimatedTokens: 130000,
            source: 'estimate',
          },
        },
      },
      'Review the release workflow changes and stay focused on the critical findings.'
    );

    const generatorCall = mockRunDirectKodaX.mock.calls.find((call) =>
      String(call[1]).includes('Generator role')
    );
    const generatorOptions = generatorCall?.[0];

    expect(generatorOptions?.session?.resume).toBe(false);
    expect(generatorOptions?.session?.autoResume).toBe(false);
    expect(generatorOptions?.session?.initialMessages?.[0]?.content).toContain('Compacted managed-task memory:');
    expect(result.managedTask?.runtime?.memoryStrategies?.generator).toBe('compact');
    expect(
      Object.values(result.managedTask?.runtime?.memoryNotes ?? {}).some((note) =>
        note.includes('Compacted managed-task memory:')
      )
    ).toBe(true);
  });

  it('forwards non-terminal worker output for observability', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    const textDeltas: string[] = [];
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] observability',
      decision: {
        primaryTask: 'plan',
        confidence: 0.88,
        riskLevel: 'medium',
        recommendedMode: 'planning',
        recommendedThinkingDepth: 'medium',
        complexity: 'complex',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Need visible orchestration',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (options, prompt: string) => {
      if (prompt.includes('Planner role')) {
        options.events?.onTextDelta?.('Planner checked the repo.');
      }
      if (prompt.includes('Contract Reviewer role')) {
        return {
          success: true,
          lastText: [
            'Contract review passed.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The contract is specific enough to execute.',
            'followup:',
            '- Continue to implementation.',
            '```',
          ].join('\n'),
          messages: [{
            role: 'assistant',
            content: [
              'Contract review passed.',
              '```kodax-task-contract-review',
              'status: approve',
              'reason: The contract is specific enough to execute.',
              'followup:',
              '- Continue to implementation.',
              '```',
            ].join('\n'),
          }],
          sessionId: 'session-contract-review',
        };
      }
      return {
        success: true,
        lastText: prompt.includes('Evaluator role')
          ? [
              'Evaluator accepted.',
              '```kodax-task-verdict',
              'status: accept',
              'reason: The work is complete.',
              'followup:',
              '- Deliver the final answer.',
              '```',
            ].join('\n')
          : 'Worker output.',
        messages: [{
          role: 'assistant',
          content: prompt.includes('Evaluator role')
            ? [
                'Evaluator accepted.',
                '```kodax-task-verdict',
                'status: accept',
                'reason: The work is complete.',
                'followup:',
                '- Deliver the final answer.',
                '```',
              ].join('\n')
            : 'Worker output.',
        }],
        sessionId: prompt.includes('Evaluator role') ? 'session-evaluator' : 'session-other',
        signal: prompt.includes('Evaluator role') ? 'COMPLETE' : undefined,
      };
    });

    await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'repl',
          managedTaskWorkspaceDir: workspaceRoot,
        },
        events: {
          onTextDelta: (text) => {
            textDeltas.push(text);
          },
        },
      },
      'Plan and implement a visible orchestration flow.'
    );

    expect(textDeltas.join('')).toContain('[Planner]');
    expect(textDeltas.join('')).toContain('Planner checked the repo.');
    expect(textDeltas.join('')).toContain('starting');
  });

  it('runs H3 managed tasks with parallel worker roles and evaluator handoff', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    let concurrent = 0;
    let maxConcurrent = 0;

    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'high',
      promptOverlay: '[Routing] h3',
      decision: {
        primaryTask: 'edit',
        confidence: 0.93,
        riskLevel: 'high',
        recommendedMode: 'implementation',
        recommendedThinkingDepth: 'high',
        complexity: 'complex',
        workIntent: 'overwrite',
        requiresBrainstorm: false,
        harnessProfile: 'H3_MULTI_WORKER',
        reason: 'Requires role-split execution and validation',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (options, prompt: string) => {
      const overlay = String(options.context?.promptOverlay ?? '');
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (overlay.includes('worker=worker-implementation') || overlay.includes('worker=worker-validation')) {
          await delay(25);
        } else {
          await delay(5);
        }

        if (prompt.includes('Lead role')) {
          return {
            success: true,
            lastText: [
              'Lead aligned the execution strategy.',
              '```kodax-task-contract',
              'summary: Coordinate the implementation and validation lanes for the release workflow.',
              'success_criteria:',
              '- The implementation and validation workers stay aligned on the same release-workflow contract.',
              'required_evidence:',
              '- Explicit coordination guidance for the downstream workers.',
              'constraints:',
              '- Preserve rollback behavior.',
              '```',
            ].join('\n'),
            messages: [{ role: 'assistant', content: [
              'Lead aligned the execution strategy.',
              '```kodax-task-contract',
              'summary: Coordinate the implementation and validation lanes for the release workflow.',
              'success_criteria:',
              '- The implementation and validation workers stay aligned on the same release-workflow contract.',
              'required_evidence:',
              '- Explicit coordination guidance for the downstream workers.',
              'constraints:',
              '- Preserve rollback behavior.',
              '```',
            ].join('\n') }],
            sessionId: 'session-lead',
          };
        }

        if (prompt.includes('Planner role')) {
          return {
            success: true,
            lastText: [
              'Planner produced the decomposition.',
              '```kodax-task-contract',
              'summary: Implement and validate the release workflow.',
              'success_criteria:',
              '- The release workflow is implemented.',
              '- Validation covers the release workflow end-to-end.',
              'required_evidence:',
              '- Validation evidence for the release workflow.',
              'constraints:',
              '- Preserve rollback behavior.',
              '```',
            ].join('\n'),
            messages: [{ role: 'assistant', content: [
              'Planner produced the decomposition.',
              '```kodax-task-contract',
              'summary: Implement and validate the release workflow.',
              'success_criteria:',
              '- The release workflow is implemented.',
              '- Validation covers the release workflow end-to-end.',
              'required_evidence:',
              '- Validation evidence for the release workflow.',
              'constraints:',
              '- Preserve rollback behavior.',
              '```',
            ].join('\n') }],
            sessionId: 'session-planner',
          };
        }

        if (prompt.includes('Contract Reviewer role')) {
          return {
            success: true,
            lastText: [
              'The implementation contract is approved.',
              '```kodax-task-contract-review',
              'status: approve',
              'reason: The worker split and evidence plan are concrete enough.',
              'followup:',
              '- Proceed with implementation and validation.',
              '```',
            ].join('\n'),
            messages: [{ role: 'assistant', content: [
              'The implementation contract is approved.',
              '```kodax-task-contract-review',
              'status: approve',
              'reason: The worker split and evidence plan are concrete enough.',
              'followup:',
              '- Proceed with implementation and validation.',
              '```',
            ].join('\n') }],
            sessionId: 'session-contract-review',
          };
        }

        if (overlay.includes('worker=worker-implementation')) {
          return {
            success: true,
            lastText: 'Implementation worker updated the feature.',
            messages: [{ role: 'assistant', content: 'Implementation worker updated the feature.' }],
            sessionId: 'session-implementation',
          };
        }

        if (overlay.includes('worker=worker-validation')) {
          return {
            success: true,
            lastText: 'Validation worker checked the flow.',
            messages: [{ role: 'assistant', content: 'Validation worker checked the flow.' }],
            sessionId: 'session-validation',
          };
        }

        return {
          success: true,
          lastText: [
            'Evaluator accepted both implementation and validation evidence.',
            '```kodax-task-verdict',
            'status: accept',
            'reason: Implementation and validation evidence are sufficient.',
            'followup:',
            '- Deliver the final answer.',
            '```',
          ].join('\n'),
          messages: [{
            role: 'assistant',
            content: [
              'Evaluator accepted both implementation and validation evidence.',
              '```kodax-task-verdict',
              'status: accept',
              'reason: Implementation and validation evidence are sufficient.',
              'followup:',
              '- Deliver the final answer.',
              '```',
            ].join('\n'),
          }],
          sessionId: 'session-evaluator',
          signal: 'COMPLETE',
        };
      } finally {
        concurrent -= 1;
      }
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'project',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Implement the release workflow and validate it before accepting.'
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(6);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
    expect(result.success).toBe(true);
    expect(result.managedTask?.contract.harnessProfile).toBe('H3_MULTI_WORKER');
    expect(result.managedTask?.roleAssignments.map((assignment) => assignment.role)).toEqual([
      'lead',
      'planner',
      'validator',
      'worker',
      'validator',
      'evaluator',
    ]);

    const evaluatorCall = mockRunDirectKodaX.mock.calls.find((call) =>
      String(call[1]).includes('Evaluator role')
    );
    expect(String(evaluatorCall?.[1])).toContain('Implementation Worker');
    expect(String(evaluatorCall?.[1])).toContain('Validation Worker');
    expect(result.managedTask?.evidence.entries).toEqual([
      expect.objectContaining({ assignmentId: 'lead', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'planner', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'contract-review', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'worker-implementation', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'worker-validation', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'evaluator', status: 'completed', signal: 'COMPLETE' }),
    ]);
  });

  it('runs an explicit evaluator-to-generator refinement loop before accepting AMA tasks', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    const textDeltas: string[] = [];
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] review',
      decision: {
        primaryTask: 'review',
        confidence: 0.9,
        riskLevel: 'medium',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H1_EXECUTE_EVAL',
        reason: 'Review tasks require an independent evaluator.',
      },
    });

    let evaluatorRound = 0;
    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Generator role')) {
        const isRefinement = prompt.includes('Evaluator feedback after round 1:');
        return {
          success: true,
          lastText: isRefinement
            ? 'Must Fix #1: switch to dynamic import and add guardrails around the index build.'
            : 'Must Fix #1: switch to dynamic import.',
          messages: [{
            role: 'assistant',
            content: isRefinement
              ? 'Must Fix #1: switch to dynamic import and add guardrails around the index build.'
              : 'Must Fix #1: switch to dynamic import.',
          }],
          sessionId: isRefinement ? 'session-generator-round-2' : 'session-generator-round-1',
        };
      }

      evaluatorRound += 1;
      if (evaluatorRound === 1) {
        return {
          success: true,
          lastText: [
            'Final code review is not ready yet. The TypeScript import finding is valid, but the review needs one more pass with the missing index-build failure mode covered.',
            '```kodax-task-verdict',
            'status: revise',
            'reason: The review is incomplete and needs one more must-fix finding.',
            'followup:',
            '- Add the index-build failure finding with concrete consequence and fix direction.',
            '```',
          ].join('\n'),
          messages: [{
            role: 'assistant',
            content: [
              'Final code review is not ready yet. The TypeScript import finding is valid, but the review needs one more pass with the missing index-build failure mode covered.',
              '```kodax-task-verdict',
              'status: revise',
              'reason: The review is incomplete and needs one more must-fix finding.',
              'followup:',
              '- Add the index-build failure finding with concrete consequence and fix direction.',
              '```',
            ].join('\n'),
          }],
          sessionId: 'session-evaluator-round-1',
          signal: 'BLOCKED',
        };
      }

      return {
        success: true,
        lastText: [
          'Final code review: 2 must-fix findings are confirmed, with dynamic import and index-build resilience called out precisely.',
          '```kodax-task-verdict',
          'status: accept',
          'reason: Review findings are complete and supported.',
          'followup:',
          '- Ship the validated review as the final answer.',
          '```',
        ].join('\n'),
        messages: [{
          role: 'assistant',
          content: [
            'Final code review: 2 must-fix findings are confirmed, with dynamic import and index-build resilience called out precisely.',
            '```kodax-task-verdict',
            'status: accept',
            'reason: Review findings are complete and supported.',
            'followup:',
            '- Ship the validated review as the final answer.',
            '```',
          ].join('\n'),
        }],
        sessionId: 'session-evaluator-round-2',
        signal: 'COMPLETE',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
        events: {
          onTextDelta: (text) => {
            textDeltas.push(text);
          },
        },
      },
      'Review the repo-intelligence changes and deliver the final code review.'
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(4);
    expect(result.success).toBe(true);
    expect(result.lastText).toContain('Final code review: 2 must-fix findings are confirmed');
    expect(result.messages.at(-1)?.content).not.toContain('```kodax-task-verdict');
    expect(result.managedTask?.evidence.entries.map((entry) => ({
      assignmentId: entry.assignmentId,
      round: entry.round,
    }))).toEqual([
      { assignmentId: 'generator', round: 1 },
      { assignmentId: 'evaluator', round: 1 },
      { assignmentId: 'generator', round: 2 },
      { assignmentId: 'evaluator', round: 2 },
    ]);
    expect(textDeltas.join('')).toContain('evaluator requested another pass');

    const generatorCalls = mockRunDirectKodaX.mock.calls.filter((call) =>
      String(call[1]).includes('Generator role')
    );
    expect(generatorCalls).toHaveLength(2);
    expect(String(generatorCalls[1]?.[1])).toContain('Evaluator feedback after round 1:');
    expect(String(generatorCalls[1]?.[1])).toContain('Previous round feedback artifact:');
    expect(String(generatorCalls[1]?.[1])).toContain('Add the index-build failure finding with concrete consequence and fix direction.');

    const roundHistory = JSON.parse(
      await readFile(path.join(result.managedTask!.evidence.workspaceDir, 'round-history.json'), 'utf8')
    );
    expect(roundHistory).toHaveLength(2);
    expect(result.managedTask?.evidence.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: path.join(result.managedTask!.evidence.workspaceDir, 'round-history.json'),
        }),
        expect.objectContaining({
          path: path.join(result.managedTask!.evidence.workspaceDir, 'rounds', 'round-01', 'feedback.json'),
        }),
      ]),
    );
  });

  it('reduces the AMA round budget when the existing context is already large', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    const textDeltas: string[] = [];
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] review-budget',
      decision: {
        primaryTask: 'review',
        confidence: 0.9,
        riskLevel: 'medium',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H1_EXECUTE_EVAL',
        reason: 'Review tasks require an independent evaluator.',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Generator role')) {
        return {
          success: true,
          lastText: 'Draft review still needs another pass.',
          messages: [{ role: 'assistant', content: 'Draft review still needs another pass.' }],
          sessionId: 'session-generator-budget',
        };
      }

      return {
        success: true,
        lastText: [
          'The review still needs another pass.',
          '```kodax-task-verdict',
          'status: revise',
          'reason: One more review pass is still requested.',
          'followup:',
          '- Keep iterating.',
          '```',
        ].join('\n'),
        messages: [{
          role: 'assistant',
          content: [
            'The review still needs another pass.',
            '```kodax-task-verdict',
            'status: revise',
            'reason: One more review pass is still requested.',
            'followup:',
            '- Keep iterating.',
            '```',
          ].join('\n'),
        }],
        sessionId: 'session-evaluator-budget',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
          contextTokenSnapshot: {
            currentTokens: 130000,
            baselineEstimatedTokens: 130000,
            source: 'estimate',
          },
        },
        events: {
          onTextDelta: (text) => {
            textDeltas.push(text);
          },
        },
      },
      'Review the code changes and keep iterating until the review is complete.'
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(4);
    expect(textDeltas.join('')).toContain('adaptive round budget=2');
    expect(result.success).toBe(false);
    expect(result.signal).toBe('BLOCKED');
    expect(result.signalReason).toContain('One more review pass is still requested');
    const continuation = JSON.parse(
      await readFile(path.join(result.managedTask!.evidence.workspaceDir, 'continuation.json'), 'utf8')
    );
    expect(continuation.continuationSuggested).toBe(true);
    expect(String(continuation.latestFeedbackArtifact)).toContain('feedback.json');
    expect(String(continuation.suggestedPrompt)).toContain('Keep iterating.');
  });

  it('extends the AMA round budget for project-scoped long-running tasks', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    const textDeltas: string[] = [];
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'high',
      promptOverlay: '[Routing] project-long-running',
      decision: {
        primaryTask: 'review',
        confidence: 0.94,
        riskLevel: 'high',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'high',
        complexity: 'complex',
        workIntent: 'overwrite',
        requiresBrainstorm: true,
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Project-scoped long-running review.',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Planner role')) {
        return {
          success: true,
          lastText: [
            'Plan ready.',
            '```kodax-task-contract',
            'summary: Long-running project review.',
            'success_criteria:',
            '- Deliver the project review.',
            'required_evidence:',
            '- Verified project evidence.',
            'constraints:',
            '- Stay within the review scope.',
            '```',
          ].join('\n'),
          messages: [{ role: 'assistant', content: [
            'Plan ready.',
            '```kodax-task-contract',
            'summary: Long-running project review.',
            'success_criteria:',
            '- Deliver the project review.',
            'required_evidence:',
            '- Verified project evidence.',
            'constraints:',
            '- Stay within the review scope.',
            '```',
          ].join('\n') }],
          sessionId: 'session-planner-project',
        };
      }
      if (prompt.includes('Contract Reviewer role')) {
        return {
          success: true,
          lastText: [
            'Contract approved.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The project review contract is clear.',
            'followup:',
            '- Proceed.',
            '```',
          ].join('\n'),
          messages: [{ role: 'assistant', content: [
            'Contract approved.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The project review contract is clear.',
            'followup:',
            '- Proceed.',
            '```',
          ].join('\n') }],
          sessionId: 'session-contract-review-project',
        };
      }
      if (prompt.includes('Generator role')) {
        return {
          success: true,
          lastText: 'Project review draft ready.',
          messages: [{ role: 'assistant', content: 'Project review draft ready.' }],
          sessionId: 'session-generator-project',
        };
      }
      return {
        success: true,
        lastText: [
          'Project review accepted.',
          '```kodax-task-verdict',
          'status: accept',
          'reason: The project review is complete.',
          'followup:',
          '- Deliver the review.',
          '```',
        ].join('\n'),
        messages: [{ role: 'assistant', content: [
          'Project review accepted.',
          '```kodax-task-verdict',
          'status: accept',
          'reason: The project review is complete.',
          'followup:',
          '- Deliver the review.',
          '```',
        ].join('\n') }],
        sessionId: 'session-evaluator-project',
      };
    });

    await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'project',
          managedTaskWorkspaceDir: workspaceRoot,
          longRunning: {
            featuresFile: 'docs/features.md',
            progressFile: '.agent/progress.md',
          },
        },
        events: {
          onTextDelta: (text) => {
            textDeltas.push(text);
          },
        },
      },
      'Review the project implementation until the managed task concludes.'
    );

    expect(textDeltas.join('')).toContain('adaptive round budget=11');
  });

  it('blocks managed tasks when the evaluator omits the required verdict block', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] review',
      decision: {
        primaryTask: 'review',
        confidence: 0.9,
        riskLevel: 'medium',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H1_EXECUTE_EVAL',
        reason: 'Review tasks require an independent evaluator.',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Generator role')) {
        return {
          success: true,
          lastText: 'Draft review with one finding.',
          messages: [{ role: 'assistant', content: 'Draft review with one finding.' }],
          sessionId: 'session-generator',
        };
      }

      return {
        success: true,
        lastText: 'The review is incomplete and needs another pass, but I forgot the fenced block.',
        messages: [{
          role: 'assistant',
          content: 'The review is incomplete and needs another pass, but I forgot the fenced block.',
        }],
        sessionId: 'session-evaluator',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Review the repo-intelligence changes and deliver the final code review.'
    );

    expect(result.success).toBe(false);
    expect(result.signal).toBe('BLOCKED');
    expect(result.signalReason).toContain('omitted required');
    expect(result.managedTask?.verdict.status).toBe('blocked');
  });

  it('re-enters planner during H2 refinement and persists the updated task contract', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] h2-contract',
      decision: {
        primaryTask: 'edit',
        confidence: 0.89,
        riskLevel: 'medium',
        recommendedMode: 'implementation',
        recommendedThinkingDepth: 'medium',
        complexity: 'complex',
        workIntent: 'overwrite',
        requiresBrainstorm: false,
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Needs contract-backed implementation.',
      },
    });

    let plannerRound = 0;
    mockRunDirectKodaX.mockImplementation(async (options, prompt: string) => {
      if (prompt.includes('Planner role')) {
        plannerRound += 1;
        if (plannerRound === 1) {
          return {
            success: true,
            lastText: [
              'Initial plan is ready.',
              '```kodax-task-contract',
              'summary: Ship the release workflow safely.',
              'success_criteria:',
              '- Release workflow completes end-to-end.',
              'required_evidence:',
              '- Focused automated verification.',
              'constraints:',
              '- Do not break rollback behavior.',
              '```',
            ].join('\n'),
            messages: [{
              role: 'assistant',
              content: [
                'Initial plan is ready.',
                '```kodax-task-contract',
                'summary: Ship the release workflow safely.',
                'success_criteria:',
                '- Release workflow completes end-to-end.',
                'required_evidence:',
                '- Focused automated verification.',
                'constraints:',
                '- Do not break rollback behavior.',
                '```',
              ].join('\n'),
            }],
            sessionId: 'session-planner-round-1',
          };
        }

        return {
          success: true,
          lastText: [
            'Replanned contract with rollback coverage.',
            '```kodax-task-contract',
            'summary: Ship the release workflow safely with rollback coverage.',
            'success_criteria:',
            '- Release workflow completes end-to-end.',
            '- Rollback path is explicitly covered.',
            'required_evidence:',
            '- Focused automated verification.',
            '- Rollback-path verification evidence.',
            'constraints:',
            '- Do not break rollback behavior.',
            '```',
          ].join('\n'),
          messages: [{
            role: 'assistant',
            content: [
              'Replanned contract with rollback coverage.',
              '```kodax-task-contract',
              'summary: Ship the release workflow safely with rollback coverage.',
              'success_criteria:',
              '- Release workflow completes end-to-end.',
              '- Rollback path is explicitly covered.',
              'required_evidence:',
              '- Focused automated verification.',
              '- Rollback-path verification evidence.',
              'constraints:',
              '- Do not break rollback behavior.',
              '```',
            ].join('\n'),
          }],
          sessionId: 'session-planner-round-2',
        };
      }

      if (prompt.includes('Contract Reviewer role')) {
        if (plannerRound === 1) {
          return {
            success: true,
            lastText: [
              'The contract needs replanning to cover rollback.',
              '```kodax-task-contract-review',
              'status: revise',
              'reason: The contract is missing explicit rollback-path coverage.',
              'followup:',
              '- Replan with rollback-path success criteria and evidence.',
              '```',
            ].join('\n'),
            messages: [{
              role: 'assistant',
              content: [
                'The contract needs replanning to cover rollback.',
                '```kodax-task-contract-review',
                'status: revise',
                'reason: The contract is missing explicit rollback-path coverage.',
                'followup:',
                '- Replan with rollback-path success criteria and evidence.',
                '```',
              ].join('\n'),
            }],
            sessionId: 'session-contract-review-round-1',
          };
        }

        return {
          success: true,
          lastText: [
            'The revised contract is approved.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The revised contract now covers rollback explicitly.',
            'followup:',
            '- Proceed with implementation.',
            '```',
          ].join('\n'),
          messages: [{
            role: 'assistant',
            content: [
              'The revised contract is approved.',
              '```kodax-task-contract-review',
              'status: approve',
              'reason: The revised contract now covers rollback explicitly.',
              'followup:',
              '- Proceed with implementation.',
              '```',
            ].join('\n'),
          }],
          sessionId: 'session-contract-review-round-2',
        };
      }

      if (prompt.includes('Generator role')) {
        const overlay = String(options.context?.promptOverlay ?? '');
        return {
          success: true,
          lastText: overlay.includes('Rollback path is explicitly covered.')
            ? 'Generator implemented the workflow with rollback coverage.'
            : 'Generator implemented the workflow.',
          messages: [{
            role: 'assistant',
            content: overlay.includes('Rollback path is explicitly covered.')
              ? 'Generator implemented the workflow with rollback coverage.'
              : 'Generator implemented the workflow.',
          }],
          sessionId: overlay.includes('Rollback path is explicitly covered.')
            ? 'session-generator-round-2'
            : 'session-generator-round-1',
        };
      }

      return {
        success: true,
        lastText: [
          'Final result accepted with the updated contract and rollback coverage.',
          '```kodax-task-verdict',
          'status: accept',
          'reason: The revised contract is satisfied.',
          'followup:',
          '- Deliver the final answer.',
          '```',
        ].join('\n'),
        messages: [{
          role: 'assistant',
          content: [
            'Final result accepted with the updated contract and rollback coverage.',
            '```kodax-task-verdict',
            'status: accept',
            'reason: The revised contract is satisfied.',
            'followup:',
            '- Deliver the final answer.',
            '```',
          ].join('\n'),
        }],
        sessionId: 'session-evaluator-round-2',
        signal: 'COMPLETE',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Implement the release workflow with strong verification.'
    );

    const plannerCalls = mockRunDirectKodaX.mock.calls.filter((call) =>
      String(call[1]).includes('Planner role')
    );
    const contractReviewCalls = mockRunDirectKodaX.mock.calls.filter((call) =>
      String(call[1]).includes('Contract Reviewer role')
    );
    const generatorCalls = mockRunDirectKodaX.mock.calls.filter((call) =>
      String(call[1]).includes('Generator role')
    );

    expect(plannerCalls).toHaveLength(2);
    expect(contractReviewCalls).toHaveLength(2);
    expect(generatorCalls).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.managedTask?.contract.contractSummary).toContain('rollback coverage');
    expect(result.managedTask?.contract.successCriteria).toContain('Rollback path is explicitly covered.');
    expect(result.managedTask?.contract.requiredEvidence).toContain('Rollback-path verification evidence.');

    const persistedContract = JSON.parse(
      await readFile(path.join(result.managedTask!.evidence.workspaceDir, 'contract.json'), 'utf8')
    );
    expect(persistedContract.successCriteria).toContain('Rollback path is explicitly covered.');
  });

  it('falls back to heuristic routing when provider-backed routing is unavailable', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockRejectedValue(new Error('routing unavailable'));
    mockRunDirectKodaX.mockResolvedValue({
      success: true,
      lastText: 'Summary completed.',
      messages: [{ role: 'assistant', content: 'Summary completed.' }],
      sessionId: 'session-fallback',
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Summarize the release notes in one paragraph.'
    );

    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
    expect(result.routingDecision?.routingNotes?.join('\n')).toContain('heuristic fallback routing');
    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(1);
  });

  it('captures repo intelligence artifacts for managed tasks when repo context is available', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-repo-intel-');
    initGitRepo(workspaceRoot);
    createRepoFixture(workspaceRoot);
    commitAll(workspaceRoot, 'initial fixture');

    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'low',
      promptOverlay: '[Routing] direct-repo-intel',
      decision: {
        primaryTask: 'edit',
        confidence: 0.89,
        riskLevel: 'low',
        recommendedMode: 'implementation',
        recommendedThinkingDepth: 'low',
        complexity: 'simple',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H0_DIRECT',
        reason: 'Simple repo-aware execution',
      },
    });
    mockRunDirectKodaX.mockResolvedValue({
      success: true,
      lastText: 'Repo-aware task handled directly.',
      messages: [{ role: 'assistant', content: 'Repo-aware task handled directly.' }],
      sessionId: 'session-direct-repo-intel',
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'project',
          gitRoot: workspaceRoot,
          executionCwd: path.join(workspaceRoot, 'packages', 'app'),
          managedTaskWorkspaceDir: path.join(workspaceRoot, '.agent', 'managed-tasks'),
        },
      },
      'Inspect the app package and adjust the boot flow.'
    );

    const artifactPaths = result.managedTask?.evidence.artifacts.map((artifact) => artifact.path) ?? [];
    expect(artifactPaths.some((artifactPath) => artifactPath.endsWith(path.join('repo-intelligence', 'summary.md')))).toBe(true);
    expect(artifactPaths.some((artifactPath) => artifactPath.endsWith(path.join('repo-intelligence', 'repo-overview.json')))).toBe(true);
    expect(artifactPaths.some((artifactPath) => artifactPath.endsWith(path.join('repo-intelligence', 'active-module.json')))).toBe(true);

    const repoSummary = await readFile(
      path.join(result.managedTask!.evidence.workspaceDir, 'repo-intelligence', 'summary.md'),
      'utf8'
    );
    expect(repoSummary).toContain('## Repository Overview');
    expect(repoSummary).toContain('## Active Module');
    expect(repoSummary).toContain('@fixture/app');
  }, 15000);
});
