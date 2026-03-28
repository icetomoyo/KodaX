import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDirSync, removeTempDirSync } from '../test-utils/temp-dir.js';

const { mockRunManagedTask } = vi.hoisted(() => ({
  mockRunManagedTask: vi.fn(),
}));

vi.mock('@kodax/coding', async () => {
  const actual = await vi.importActual<typeof import('@kodax/coding')>('@kodax/coding');
  return {
    ...actual,
    runManagedTask: mockRunManagedTask,
  };
});

import { createInteractiveContext } from './context.js';
import { detectAndShowProjectHint, handleProjectCommand, printProjectHelp } from './project-commands.js';
import { ProjectStorage } from './project-storage.js';
import { createBrainstormSession, formatBrainstormTranscript } from './project-brainstorm.js';
import type { CommandCallbacks, CurrentConfig } from './commands.js';

function createCallbacks(overrides: Partial<CommandCallbacks> = {}): CommandCallbacks {
  return {
    exit: () => {},
    saveSession: async () => {},
    loadSession: async () => 'missing',
    listSessions: async () => {},
    clearHistory: () => {},
    printHistory: () => {},
    ui: {
      select: async () => {
        throw new Error('Unexpected ui.select call in test. Override ui.select for interactive paths.');
      },
      confirm: async () => true,
      input: async () => undefined,
    },
    ...overrides,
  };
}

const currentConfig: CurrentConfig = {
  provider: 'zhipu-coding',
  thinking: true,
  reasoningMode: 'auto',
  agentMode: 'ama',
  parallel: false,
  permissionMode: 'accept-edits' as never,
};

describe('project commands', () => {
  const originalCwd = process.cwd();
  let tempDir = '';

  beforeEach(async () => {
    tempDir = createTempDirSync('kodax-project-commands-');
    process.chdir(tempDir);

    const storage = new ProjectStorage(tempDir);
    await storage.saveFeatures({
      features: [
        {
          description: 'Implement project quality report',
          passes: true,
          startedAt: '2026-03-17T08:00:00.000Z',
        },
        {
          description: 'Wire guided project status analysis',
          startedAt: '2026-03-17T09:00:00.000Z',
        },
      ],
    });
    await storage.appendProgress('Completed review. Added vitest coverage. Release pending.');
    await storage.writeSessionPlan('- Finish release validation\n- Deploy after checks');
    await storage.clearActiveBrainstormSession();

    mockRunManagedTask.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    removeTempDirSync(tempDir);
    vi.restoreAllMocks();
  });

  it('shows a deterministic quality report without AI options', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});

    await handleProjectCommand(
      ['quality'],
      context,
      createCallbacks(),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('/project quality - Workflow Health');
    expect(output).toContain('## Project Quality Report');
    expect(output).toContain('Guided Status Summary');
    expect(output).toContain('Suggested next move');
  });

  it('prints project help aligned with current command surface', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    printProjectHelp();

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('/project - Project Management');
    expect(output).toContain('plan');
    expect(output).toContain('brainstorm');
    expect(output).toContain('pause');
    expect(output).toContain('verify');
    expect(output).toContain('Current Semantics:');
    expect(output).toContain('init -> brainstorm -> plan -> next/auto');
    expect(output).toContain('docs/FEATURE_LIST.md');
    expect(output).toContain('docs/features/v0.6.10.md');
  });

  it('shows expanded project hints for detected long-running projects', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const shown = await detectAndShowProjectHint();

    const output = logSpy.mock.calls.flat().join('\n');
    expect(shown).toBe(true);
    expect(output).toContain('Use /project status to view progress');
    expect(output).toContain('Recommended next step: /project next');
    expect(output).toContain('Use /project quality or /project verify when you need diagnostic help');
  });

  it('uses AI for guided status questions when model execution is available', async () => {
    mockRunManagedTask.mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          content: '## Direct assessment\nRelease looks close, but validate the pending feature first.',
        },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});

    await handleProjectCommand(
      ['status', 'what', 'is', 'blocking', 'release?'],
      context,
      createCallbacks({
        createKodaXOptions: () =>
          ({
            session: {},
          }) as never,
      }),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(mockRunManagedTask).toHaveBeenCalledTimes(1);
    expect(output).toContain('/project status - Guided Analysis');
    expect(output).toContain('## Project Quality Report');
    expect(output).toContain('Release looks close, but validate the pending feature first.');
  });

  it('replaces the old placeholder with a fallback guided summary when AI is unavailable', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});

    await handleProjectCommand(
      ['status', 'what', 'is', 'blocking', 'release?'],
      context,
      createCallbacks(),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).not.toContain('AI analysis coming in future release');
    expect(output).toContain('Guided Status Summary');
  });

  it('runs brainstorm as a UI-driven discovery flow and saves aligned truth', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});
    const storage = new ProjectStorage(tempDir);
    await storage.writeProjectBrief({
      originalPrompt: 'Need a permission system',
      goals: ['Need a permission system'],
      constraints: [],
      nonGoals: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.writeAlignment({
      sourcePrompt: 'Need a permission system',
      confirmedRequirements: [],
      constraints: [],
      nonGoals: [],
      acceptedTradeoffs: [],
      successCriteria: [],
      openQuestions: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.saveWorkflowState({
      stage: 'discovering',
      scope: 'project',
      unresolvedQuestionCount: 4,
      discoveryStepIndex: 0,
      lastUpdated: '2026-03-17T10:00:00.000Z',
    });

    await handleProjectCommand(
      ['brainstorm'],
      context,
      createCallbacks({
        ui: {
          select: async (_title, options) => options[0],
          confirm: async () => true,
          input: async () => undefined,
        },
      }),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    const activeSession = await storage.loadActiveBrainstormSession();
    const state = await storage.loadWorkflowState();
    const alignment = await storage.readAlignment();

    expect(output).toContain('/project brainstorm - Discovery Flow');
    expect(output).toContain('Discovery is aligned.');
    expect(activeSession).toBeNull();
    expect(state?.stage).toBe('aligned');
    expect(alignment?.confirmedRequirements.length).toBeGreaterThan(0);
    expect(alignment?.successCriteria.length).toBeGreaterThan(0);
  });

  it('does not require model execution for the new brainstorm flow', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});
    const storage = new ProjectStorage(tempDir);
    await storage.writeProjectBrief({
      originalPrompt: 'Multi-tenant RBAC',
      goals: ['Multi-tenant RBAC'],
      constraints: [],
      nonGoals: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.writeAlignment({
      sourcePrompt: 'Multi-tenant RBAC',
      confirmedRequirements: [],
      constraints: [],
      nonGoals: [],
      acceptedTradeoffs: [],
      successCriteria: [],
      openQuestions: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.saveWorkflowState({
      stage: 'discovering',
      scope: 'project',
      unresolvedQuestionCount: 4,
      discoveryStepIndex: 0,
      lastUpdated: '2026-03-17T10:00:00.000Z',
    });

    await handleProjectCommand(
      ['brainstorm'],
      context,
      createCallbacks({
        ui: {
          select: async (_title, options) => options[0],
          confirm: async () => true,
          input: async () => undefined,
        },
      }),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    const state = await storage.loadWorkflowState();

    expect(mockRunManagedTask).not.toHaveBeenCalled();
    expect(output).toContain('Discovery is aligned.');
    expect(state?.stage).toBe('aligned');
  });

  it('accepts custom brainstorm answers through the Other -> input path', async () => {
    const context = await createInteractiveContext({});
    const storage = new ProjectStorage(tempDir);
    await storage.writeProjectBrief({
      originalPrompt: 'Need custom workflow support',
      goals: ['Need custom workflow support'],
      constraints: [],
      nonGoals: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.writeAlignment({
      sourcePrompt: 'Need custom workflow support',
      confirmedRequirements: [],
      constraints: [],
      nonGoals: [],
      acceptedTradeoffs: [],
      successCriteria: [],
      openQuestions: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.saveWorkflowState({
      stage: 'discovering',
      scope: 'project',
      unresolvedQuestionCount: 4,
      discoveryStepIndex: 0,
      lastUpdated: '2026-03-17T10:00:00.000Z',
    });

    await handleProjectCommand(
      ['brainstorm'],
      context,
      createCallbacks({
        ui: {
          select: async (_title, options) => options[options.length - 1],
          confirm: async () => true,
          input: async () => 'Use a bespoke approval pipeline',
        },
      }),
      currentConfig,
    );

    const alignment = await storage.readAlignment();
    expect(alignment?.confirmedRequirements).toContain('Use a bespoke approval pipeline');
  });

  it('routes ambiguous discovery edits through UI selection instead of keyword guessing', async () => {
    const context = await createInteractiveContext({});
    const storage = new ProjectStorage(tempDir);
    await storage.writeAlignment({
      sourcePrompt: 'Clarify project intent',
      confirmedRequirements: [],
      constraints: [],
      nonGoals: [],
      acceptedTradeoffs: [],
      successCriteria: [],
      openQuestions: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.saveWorkflowState({
      stage: 'discovering',
      scope: 'project',
      unresolvedQuestionCount: 1,
      discoveryStepIndex: 0,
      lastUpdated: '2026-03-17T10:00:00.000Z',
    });

    await handleProjectCommand(
      ['edit', 'This', 'should', 'NOT', 'be', 'a', 'constraint'],
      context,
      createCallbacks({
        confirm: async () => true,
        ui: {
          select: async () => 'Confirmed requirement',
          confirm: async () => true,
          input: async () => undefined,
        },
      }),
      currentConfig,
    );

    const alignment = await storage.readAlignment();
    expect(alignment?.confirmedRequirements).toContain('This should NOT be a constraint');
    expect(alignment?.constraints).toEqual([]);
  });

  it('supports removing a discovery alignment entry without re-adding it', async () => {
    const context = await createInteractiveContext({});
    const storage = new ProjectStorage(tempDir);
    await storage.writeAlignment({
      sourcePrompt: 'Clarify project intent',
      confirmedRequirements: [],
      constraints: [],
      nonGoals: ['Caching is out of scope for the first release'],
      acceptedTradeoffs: [],
      successCriteria: [],
      openQuestions: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.saveWorkflowState({
      stage: 'aligned',
      scope: 'project',
      unresolvedQuestionCount: 0,
      discoveryStepIndex: 4,
      lastUpdated: '2026-03-17T10:00:00.000Z',
    });

    await handleProjectCommand(
      ['edit', 'Remove', 'the', 'non-goal', 'about', 'caching'],
      context,
      createCallbacks({
        confirm: async () => true,
        ui: {
          select: async () => {
            throw new Error('The explicit non-goal removal path should not need a selector.');
          },
          confirm: async () => true,
          input: async () => undefined,
        },
      }),
      currentConfig,
    );

    const alignment = await storage.readAlignment();
    expect(alignment?.nonGoals).toEqual([]);
  });

  it('builds and persists a structured plan for a feature index', async () => {
    const storage = new ProjectStorage(tempDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});

    await handleProjectCommand(
      ['plan', '#1'],
      context,
      createCallbacks(),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    const sessionPlan = await storage.readSessionPlan();

    expect(output).toContain('/project plan - Planning View');
    expect(output).toContain('Source: feature #1');
    expect(sessionPlan).toContain('# Project Plan: Wire guided project status analysis');
    expect(sessionPlan).toContain('## Implementation');
  });

  it('builds a structured plan from a freeform prompt', async () => {
    const storage = new ProjectStorage(tempDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});

    await handleProjectCommand(
      ['plan', 'Terminal', 'brainstorm', 'continuation'],
      context,
      createCallbacks(),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    const sessionPlan = await storage.readSessionPlan();

    expect(output).toContain('Source: freeform request');
    expect(sessionPlan).toContain('# Project Plan: Terminal brainstorm continuation');
    expect(sessionPlan).toContain('## Risks');
  });

  it('treats mixed numeric freeform text as a prompt instead of a feature index', async () => {
    const storage = new ProjectStorage(tempDir);
    const context = await createInteractiveContext({});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleProjectCommand(
      ['plan', '2026', 'release', 'readiness'],
      context,
      createCallbacks(),
      currentConfig,
    );

    const sessionPlan = await storage.readSessionPlan();
    expect(sessionPlan).toContain('# Project Plan: 2026 release readiness');
  });

  it('keeps old feature-list-first projects in planned state when inferring workflow state', async () => {
    const storage = new ProjectStorage(tempDir);
    await storage.deleteProjectManagementFiles();
    await storage.saveFeatures({
      features: [
        { description: 'Existing feature', passes: false },
      ],
    });

    const inferred = await storage.loadOrInferWorkflowState();
    expect(inferred.stage).toBe('planned');
  });

  it('returns change-request planning back to project scope after generating plan truth', async () => {
    const storage = new ProjectStorage(tempDir);
    const context = await createInteractiveContext({});
    await storage.writeAlignment({
      sourcePrompt: 'Add pagination',
      confirmedRequirements: ['Add pagination to the current API'],
      constraints: [],
      nonGoals: [],
      acceptedTradeoffs: [],
      successCriteria: ['The list endpoint supports stable page traversal'],
      openQuestions: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.saveWorkflowState({
      stage: 'aligned',
      scope: 'change_request',
      activeRequestId: 'request_1',
      unresolvedQuestionCount: 0,
      discoveryStepIndex: 4,
      lastUpdated: '2026-03-17T10:00:00.000Z',
    });

    await handleProjectCommand(
      ['plan'],
      context,
      createCallbacks(),
      currentConfig,
    );

    const state = await storage.loadWorkflowState();
    expect(state?.scope).toBe('project');
    expect(state?.activeRequestId).toBeUndefined();
    expect(state?.stage).toBe('planned');
  });

  it('resumes from an active brainstorm session and completes discovery', async () => {
    const storage = new ProjectStorage(tempDir);
    const seededSession = createBrainstormSession(
      'Permission system',
      'What tenant isolation constraints matter most?',
      '2026-03-17T10:00:00.000Z',
    );
    await storage.saveBrainstormSession(seededSession, formatBrainstormTranscript(seededSession));
    await storage.writeProjectBrief({
      originalPrompt: 'Permission system',
      goals: ['Permission system'],
      constraints: [],
      nonGoals: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.writeAlignment({
      sourcePrompt: 'Permission system',
      confirmedRequirements: [],
      constraints: [],
      nonGoals: [],
      acceptedTradeoffs: [],
      successCriteria: [],
      openQuestions: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.saveWorkflowState({
      stage: 'discovering',
      scope: 'project',
      unresolvedQuestionCount: 2,
      discoveryStepIndex: 2,
      lastUpdated: '2026-03-17T10:00:00.000Z',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});

    await handleProjectCommand(
      ['brainstorm'],
      context,
      createCallbacks({
        ui: {
          select: async (_title, options) => options[0],
          confirm: async () => true,
          input: async () => undefined,
        },
      }),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    const activeSession = await storage.loadActiveBrainstormSession();
    const storedSession = await storage.loadBrainstormSession(seededSession.id);
    const state = await storage.loadWorkflowState();

    expect(output).toContain('Discovery is aligned.');
    expect(activeSession).toBeNull();
    expect(storedSession?.status).toBe('completed');
    expect(storedSession?.turns.length).toBeGreaterThan(2);
    expect(state?.stage).toBe('aligned');
  });

  it('pauses brainstorm when the user cancels a discovery question', async () => {
    const storage = new ProjectStorage(tempDir);
    await storage.writeProjectBrief({
      originalPrompt: 'Permission system',
      goals: ['Permission system'],
      constraints: [],
      nonGoals: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.writeAlignment({
      sourcePrompt: 'Permission system',
      confirmedRequirements: [],
      constraints: [],
      nonGoals: [],
      acceptedTradeoffs: [],
      successCriteria: [],
      openQuestions: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.saveWorkflowState({
      stage: 'discovering',
      scope: 'project',
      unresolvedQuestionCount: 4,
      discoveryStepIndex: 0,
      lastUpdated: '2026-03-17T10:00:00.000Z',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});

    await handleProjectCommand(
      ['brainstorm'],
      context,
      createCallbacks({
        ui: {
          select: async () => undefined,
          confirm: async () => true,
          input: async () => undefined,
        },
      }),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    const activeSession = await storage.loadActiveBrainstormSession();
    const state = await storage.loadWorkflowState();

    expect(output).toContain('Discovery paused');
    expect(activeSession?.status).toBe('active');
    expect(state?.stage).toBe('discovering');
  });

  it('keeps discovery open when the user chooses to refine additional questions', async () => {
    const storage = new ProjectStorage(tempDir);
    const context = await createInteractiveContext({});
    await storage.writeProjectBrief({
      originalPrompt: 'Permission system',
      goals: ['Permission system'],
      constraints: [],
      nonGoals: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.writeAlignment({
      sourcePrompt: 'Permission system',
      confirmedRequirements: [],
      constraints: [],
      nonGoals: [],
      acceptedTradeoffs: [],
      successCriteria: [],
      openQuestions: [],
      updatedAt: '2026-03-17T10:00:00.000Z',
    });
    await storage.saveWorkflowState({
      stage: 'discovering',
      scope: 'project',
      unresolvedQuestionCount: 4,
      discoveryStepIndex: 0,
      lastUpdated: '2026-03-17T10:00:00.000Z',
    });

    let selectCount = 0;
    await handleProjectCommand(
      ['brainstorm'],
      context,
      createCallbacks({
        ui: {
          select: async (_title, options) => {
            selectCount += 1;
            return selectCount <= 4 ? options[0] : 'Keep refining discovery';
          },
          confirm: async () => true,
          input: async () => 'Clarify tenant migration rules',
        },
      }),
      currentConfig,
    );

    let state = await storage.loadWorkflowState();
    let alignment = await storage.readAlignment();
    expect(state?.stage).toBe('discovering');
    expect(alignment?.openQuestions).toContain('Clarify tenant migration rules');

    await handleProjectCommand(
      ['brainstorm'],
      context,
      createCallbacks({
        ui: {
          select: async (_title, options) => options[2],
          confirm: async () => true,
          input: async () => 'Migration only needs to support existing enterprise tenants',
        },
      }),
      currentConfig,
    );

    state = await storage.loadWorkflowState();
    alignment = await storage.readAlignment();
    expect(state?.stage).toBe('aligned');
    expect(alignment?.openQuestions).toEqual([]);
    expect(alignment?.confirmedRequirements).toContain('Migration only needs to support existing enterprise tenants');
  });

  it('marks a feature complete only after harness verification passes', async () => {
    mockRunManagedTask.mockImplementation(async () => {
      const storage = new ProjectStorage(process.cwd());
      await storage.appendProgress('## Session 2\n\nCompleted guided status analysis.\n');
      return {
        success: true,
        lastText: '<project-harness>{"status":"complete","summary":"Finished the feature.","evidence":["Updated PROGRESS.md"],"tests":["manual"],"changedFiles":["src/project.ts"]}</project-harness>',
        sessionId: 'managed-task-1',
        messages: [
          {
            role: 'assistant',
            content: `<project-harness>{"status":"complete","summary":"Finished the feature.","evidence":["Updated PROGRESS.md"],"tests":["manual"],"changedFiles":["src/project.ts"]}</project-harness>`,
          },
        ],
      };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});
    const storage = new ProjectStorage(tempDir);

    await handleProjectCommand(
      ['next', '--no-confirm'],
      context,
      createCallbacks({
        confirm: async () => true,
        createKodaXOptions: () =>
          ({
            provider: 'zhipu-coding',
            session: {},
          }) as never,
      }),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    const feature = await storage.getFeatureByIndex(1);
    const runs = await storage.readHarnessRuns();
    const evidence = await storage.readHarnessEvidence<{ completionSource: string }>(1);

    expect(feature?.passes).toBe(true);
    expect(feature?.completedAt).toBeTruthy();
    expect(output).toContain('Feature completed');
    expect(output).toContain('Project Harness Verification');
    expect(runs).toHaveLength(1);
    expect(evidence?.completionSource).toBe('auto_verified');
  });

  it('keeps a feature pending when the harness report is missing and exposes /project verify output', async () => {
    mockRunManagedTask.mockImplementation(async () => {
      const storage = new ProjectStorage(process.cwd());
      await storage.appendProgress('## Session 2\n\nMade partial progress.\n');
      return {
        success: true,
        lastText: 'Implemented part of the feature, but forgot the verifier block.',
        sessionId: 'managed-task-2',
        messages: [
          {
            role: 'assistant',
            content: 'Implemented part of the feature, but forgot the verifier block.',
          },
        ],
      };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});
    const storage = new ProjectStorage(tempDir);

    await handleProjectCommand(
      ['next', '--no-confirm'],
      context,
      createCallbacks({
        confirm: async () => true,
        createKodaXOptions: () =>
          ({
            provider: 'zhipu-coding',
            session: {},
          }) as never,
      }),
      currentConfig,
    );

    const feature = await storage.getFeatureByIndex(1);
    expect(feature?.passes).not.toBe(true);

    logSpy.mockClear();

    await handleProjectCommand(
      ['verify', '--last'],
      context,
      createCallbacks(),
      currentConfig,
    );

    const verifyOutput = logSpy.mock.calls.flat().join('\n');
    expect(verifyOutput).toContain('/project verify - Deterministic Re-check');
    expect(verifyOutput).toContain('needs_review');
  });

  it('reruns deterministic checks during /project verify against the current workspace state', async () => {
    mockRunManagedTask.mockImplementation(async () => {
      const storage = new ProjectStorage(process.cwd());
      await storage.appendProgress('## Session 3\n\nCompleted verifier wiring.\n');
      return {
        success: true,
        lastText: '<project-harness>{"status":"complete","summary":"Finished the feature.","evidence":["Updated PROGRESS.md"],"tests":["manual"],"changedFiles":["src/project.ts"]}</project-harness>',
        sessionId: 'managed-task-3',
        messages: [
          {
            role: 'assistant',
            content: '<project-harness>{"status":"complete","summary":"Finished the feature.","evidence":["Updated PROGRESS.md"],"tests":["manual"],"changedFiles":["src/project.ts"]}</project-harness>',
          },
        ],
      };
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});
    const storage = new ProjectStorage(tempDir);

    await handleProjectCommand(
      ['next', '--no-confirm'],
      context,
      createCallbacks({
        confirm: async () => true,
        createKodaXOptions: () =>
          ({
            provider: 'zhipu-coding',
            session: {},
          }) as never,
      }),
      currentConfig,
    );

    await storage.writeHarnessConfig({
      version: 1,
      generatedAt: new Date().toISOString(),
      protectedArtifacts: ['feature_list.json', '.agent/project/harness'],
      checks: [
        {
          id: 'verify-check',
          command: 'node -e "process.exit(1)"',
          required: true,
        },
      ],
      completionRules: {
        requireProgressUpdate: true,
        requireChecksPass: true,
        requireCompletionReport: true,
      },
      advisoryRules: {
        warnOnLargeUnrelatedDiff: true,
        warnOnRepeatedFailure: true,
      },
    });

    logSpy.mockClear();

    await handleProjectCommand(
      ['verify', '--last'],
      context,
      createCallbacks(),
      currentConfig,
    );

    const verifyOutput = logSpy.mock.calls.flat().join('\n');
    expect(verifyOutput).toContain('Deterministic Re-check');
    expect(verifyOutput).toContain('retryable_failure');
    expect(verifyOutput).toContain('verify-check:fail');
    expect(verifyOutput).toContain('Evidence completeness');
  });

  it('records manual override evidence for /project mark', async () => {
    const context = await createInteractiveContext({});
    const storage = new ProjectStorage(tempDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleProjectCommand(
      ['mark', '1', 'done'],
      context,
      createCallbacks(),
      currentConfig,
    );

    const evidence = await storage.readHarnessEvidence<{ completionSource: string; status: string }>(1);
    expect(evidence?.completionSource).toBe('manual_override');
    expect(evidence?.status).toBe('manual_override');
  });
});
