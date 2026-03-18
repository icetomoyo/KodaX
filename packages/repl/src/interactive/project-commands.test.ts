import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunKodaX } = vi.hoisted(() => ({
  mockRunKodaX: vi.fn(),
}));

vi.mock('@kodax/coding', async () => {
  const actual = await vi.importActual<typeof import('@kodax/coding')>('@kodax/coding');
  return {
    ...actual,
    runKodaX: mockRunKodaX,
  };
});

import { createInteractiveContext } from './context.js';
import { handleProjectCommand } from './project-commands.js';
import { ProjectStorage } from './project-storage.js';
import { createBrainstormSession, formatBrainstormTranscript } from './project-brainstorm.js';
import type { CommandCallbacks, CurrentConfig } from './commands.js';

function createCallbacks(overrides: Partial<CommandCallbacks> = {}): CommandCallbacks {
  return {
    exit: () => {},
    saveSession: async () => {},
    loadSession: async () => false,
    listSessions: async () => {},
    clearHistory: () => {},
    printHistory: () => {},
    ui: {
      select: async () => undefined,
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
  permissionMode: 'default' as never,
};

describe('project commands', () => {
  const originalCwd = process.cwd();
  let tempDir = '';

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-project-commands-'));
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

    mockRunKodaX.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
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

  it('uses AI for guided status questions when model execution is available', async () => {
    mockRunKodaX.mockResolvedValue({
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
    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
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

  it('starts and persists a brainstorm session with fallback facilitation', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});
    const storage = new ProjectStorage(tempDir);

    await handleProjectCommand(
      ['brainstorm', 'Need', 'a', 'permission', 'system'],
      context,
      createCallbacks(),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    const activeSession = await storage.loadActiveBrainstormSession();

    expect(output).toContain('/project brainstorm - Session Started');
    expect(output).toContain('Use /project brainstorm continue');
    expect(activeSession?.topic).toBe('Need a permission system');
    expect(activeSession?.turns[1]?.text).toContain('Key questions to answer first:');
  });

  it('uses AI output when starting a brainstorm session if model execution is available', async () => {
    mockRunKodaX.mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          content: 'Let us map the riskiest assumptions first.\n\n1. Who administers roles?',
        },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});
    const storage = new ProjectStorage(tempDir);

    await handleProjectCommand(
      ['brainstorm', 'Multi-tenant', 'RBAC'],
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
    const activeSession = await storage.loadActiveBrainstormSession();

    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
    expect(output).toContain('Session Started');
    expect(activeSession?.turns[1]?.text).toContain('Let us map the riskiest assumptions first.');
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

  it('continues an active brainstorm session and persists the follow-up exchange', async () => {
    mockRunKodaX.mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          content: 'We should compare a simple RBAC rollout with a more flexible policy engine.',
        },
      ],
    });

    const storage = new ProjectStorage(tempDir);
    const seededSession = createBrainstormSession(
      'Permission system',
      'What tenant isolation constraints matter most?',
      '2026-03-17T10:00:00.000Z',
    );
    await storage.saveBrainstormSession(seededSession, formatBrainstormTranscript(seededSession));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});

    await handleProjectCommand(
      ['brainstorm', 'continue', 'Need', 'RBAC', 'first,', 'ABAC', 'later'],
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
    const activeSession = await storage.loadActiveBrainstormSession();

    expect(output).toContain('Session Continued');
    expect(activeSession?.turns).toHaveLength(4);
    expect(activeSession?.turns[2]?.text).toBe('Need RBAC first, ABAC later');
    expect(activeSession?.turns[3]?.text).toContain('simple RBAC rollout');
  });

  it('completes the active brainstorm session and clears the active pointer', async () => {
    const storage = new ProjectStorage(tempDir);
    const seededSession = createBrainstormSession(
      'Permission system',
      'What tenant isolation constraints matter most?',
      '2026-03-17T10:00:00.000Z',
    );
    await storage.saveBrainstormSession(seededSession, formatBrainstormTranscript(seededSession));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = await createInteractiveContext({});

    await handleProjectCommand(
      ['brainstorm', 'done'],
      context,
      createCallbacks(),
      currentConfig,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    const activeSession = await storage.loadActiveBrainstormSession();
    const storedSession = await storage.loadBrainstormSession(seededSession.id);

    expect(output).toContain('Session Completed');
    expect(activeSession).toBeNull();
    expect(storedSession?.status).toBe('completed');
  });

  it('marks a feature complete only after harness verification passes', async () => {
    mockRunKodaX.mockImplementation(async () => {
      const storage = new ProjectStorage(process.cwd());
      await storage.appendProgress('## Session 2\n\nCompleted guided status analysis.\n');
      return {
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
    mockRunKodaX.mockImplementation(async () => {
      const storage = new ProjectStorage(process.cwd());
      await storage.appendProgress('## Session 2\n\nMade partial progress.\n');
      return {
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
    mockRunKodaX.mockImplementation(async () => {
      const storage = new ProjectStorage(process.cwd());
      await storage.appendProgress('## Session 3\n\nCompleted verifier wiring.\n');
      return {
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
