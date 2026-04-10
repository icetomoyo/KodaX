import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KodaXManagedTask } from '@kodax/coding';
import { createTempDirSync, removeTempDirSync } from '../test-utils/temp-dir.js';
import {
  appendBrainstormExchange,
  completeBrainstormSession,
  createBrainstormSession,
  formatBrainstormTranscript,
} from './project-brainstorm.js';
import { ProjectStorage, type ProjectLightweightRunRecord } from './project-storage.js';

describe('project-storage brainstorm persistence', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = createTempDirSync('kodax-project-storage-');
  });

  afterEach(() => {
    removeTempDirSync(tempDir);
  });

  it('saves and loads brainstorm sessions with transcript files', async () => {
    const storage = new ProjectStorage(tempDir);
    const session = appendBrainstormExchange(
      createBrainstormSession(
        'Observability roadmap',
        'Which signals are missing today?',
        '2026-03-17T10:00:00.000Z',
      ),
      'Tracing and alert ownership are missing.',
      'Then we should separate telemetry gaps from team process gaps.',
      '2026-03-17T10:05:00.000Z',
    );

    await storage.saveBrainstormSession(session, formatBrainstormTranscript(session));

    await expect(storage.loadBrainstormSession(session.id)).resolves.toEqual(session);
    await expect(storage.loadActiveBrainstormSession()).resolves.toEqual(session);
    await expect(storage.readBrainstormTranscript(session.id)).resolves.toContain(
      '# Brainstorm: Observability roadmap',
    );
    expect(existsSync(storage.getPaths().brainstormProjects)).toBe(true);
    expect(storage.getPaths().brainstormProjects).toContain('.agent');
  });

  it('clears the active brainstorm pointer without deleting the session', async () => {
    const storage = new ProjectStorage(tempDir);
    const session = createBrainstormSession(
      'Developer onboarding',
      'What part of onboarding feels slow today?',
      '2026-03-17T10:00:00.000Z',
    );

    await storage.saveBrainstormSession(session, formatBrainstormTranscript(session));
    await storage.clearActiveBrainstormSession();

    await expect(storage.loadActiveBrainstormSession()).resolves.toBeNull();
    await expect(storage.loadBrainstormSession(session.id)).resolves.toEqual(session);
  });

  it('drops the active pointer when the saved session is completed', async () => {
    const storage = new ProjectStorage(tempDir);
    const activeSession = createBrainstormSession(
      'Developer onboarding',
      'What part of onboarding feels slow today?',
      '2026-03-17T10:00:00.000Z',
    );
    const completedSession = completeBrainstormSession(
      activeSession,
      '2026-03-17T10:10:00.000Z',
    );

    await storage.saveBrainstormSession(activeSession, formatBrainstormTranscript(activeSession));
    await storage.saveBrainstormSession(completedSession, formatBrainstormTranscript(completedSession));

    await expect(storage.loadActiveBrainstormSession()).resolves.toBeNull();
    await expect(storage.loadBrainstormSession(completedSession.id)).resolves.toEqual(completedSession);
  });

  it('writes session plans to .agent/project and can read the legacy .kodax plan as a fallback', async () => {
    const storage = new ProjectStorage(tempDir);
    const legacyPlanPath = storage.getPaths().legacySessionPlan;

    mkdirSync(join(tempDir, '.kodax'), { recursive: true });
    writeFileSync(legacyPlanPath, '# Legacy Plan\n', 'utf-8');

    await expect(storage.readSessionPlan()).resolves.toContain('# Legacy Plan');

    await storage.writeSessionPlan('# New Plan\n');

    await expect(storage.readSessionPlan()).resolves.toContain('# New Plan');
    expect(existsSync(storage.getPaths().sessionPlan)).toBe(true);
    expect(storage.getPaths().sessionPlan).toContain('.agent');
  });

  it('derives workflow stage from minimal control state instead of persisting a stage machine', async () => {
    const storage = new ProjectStorage(tempDir);
    await storage.writeAlignment({
      sourcePrompt: 'Need a discovery flow',
      confirmedRequirements: [],
      constraints: [],
      nonGoals: [],
      acceptedTradeoffs: [],
      successCriteria: [],
      openQuestions: [],
      updatedAt: '2026-03-26T10:00:00.000Z',
    });
    await storage.saveControlState({
      scope: 'project',
      discoveryStepIndex: 0,
      lastUpdated: '2026-03-26T10:00:00.000Z',
    });

    const state = await storage.loadWorkflowState();

    expect(state?.stage).toBe('discovering');
    expect(state?.discoveryStepIndex).toBe(0);
    expect(storage.getPaths().projectControl).toContain('.agent');
  });

  it('skips malformed harness run lines instead of failing the entire read', async () => {
    const storage = new ProjectStorage(tempDir);
    mkdirSync(dirname(storage.getPaths().harnessRuns), { recursive: true });
    writeFileSync(
      storage.getPaths().harnessRuns,
      '{"featureIndex":1}\n{not-json}\n{"featureIndex":2}\n',
      'utf-8',
    );

    const runs = await storage.readHarnessRuns<{ featureIndex: number }>();
    expect(runs).toEqual([{ featureIndex: 1 }, { featureIndex: 2 }]);
  });

  it('rejects malformed brainstorm session JSON instead of blindly casting it', async () => {
    const storage = new ProjectStorage(tempDir);
    const sessionPath = join(storage.getPaths().brainstormProjects, 'bad-session', 'session.json');
    mkdirSync(dirname(sessionPath), { recursive: true });
    writeFileSync(
      sessionPath,
      JSON.stringify({
        id: 'bad-session',
        topic: 'Bad session',
        status: 'active',
        turns: 'not-an-array',
      }),
      'utf-8',
    );

    await expect(storage.loadBrainstormSession('bad-session')).resolves.toBeNull();
  });

  it('persists checkpoint and session-tree records under .agent/project', async () => {
    const storage = new ProjectStorage(tempDir);

    await storage.appendHarnessCheckpoint({ checkpointId: 'cp-1', featureIndex: 0 });
    await storage.appendHarnessSessionNode({ nodeId: 'node-1', featureIndex: 0 });

    await expect(storage.readHarnessCheckpoints()).resolves.toEqual([
      { checkpointId: 'cp-1', featureIndex: 0 },
    ]);
    await expect(storage.readHarnessSessionNodes()).resolves.toEqual([
      { nodeId: 'node-1', featureIndex: 0 },
    ]);
    expect(storage.getPaths().harnessCheckpoints).toContain('.agent');
    expect(storage.getPaths().harnessSessionTree).toContain('.agent');
  });

  it('persists managed task state under .agent/project', async () => {
    const storage = new ProjectStorage(tempDir);
    const managedTask: KodaXManagedTask = {
      contract: {
        taskId: 'task-1',
        surface: 'project',
        objective: 'Implement managed task persistence',
        createdAt: '2026-03-26T10:00:00.000Z',
        updatedAt: '2026-03-26T10:05:00.000Z',
        status: 'blocked',
        primaryTask: 'edit',
        workIntent: 'append',
        complexity: 'moderate',
        riskLevel: 'medium',
        harnessProfile: 'H1_EXECUTE_EVAL',
        recommendedMode: 'implementation',
        requiresBrainstorm: false,
        reason: 'Test fixture',
        contractSummary: 'Persist managed task state under project storage.',
        successCriteria: ['Managed task state survives reload.'],
        requiredEvidence: ['Persisted managed-task artifacts exist.'],
        constraints: ['Keep task state under .agent/project.'],
        metadata: {
          featureIndex: 1,
          projectMode: 'next',
        },
      },
      roleAssignments: [
        {
          id: 'generator',
          role: 'generator',
          title: 'Generator',
          dependsOn: [],
          status: 'completed',
          summary: 'Implementation draft ready',
          sessionId: 'session-1',
        },
        {
          id: 'evaluator',
          role: 'evaluator',
          title: 'Evaluator',
          dependsOn: ['generator'],
          status: 'blocked',
          summary: 'Missing verification evidence',
          sessionId: 'session-2',
        },
      ],
      workItems: [
        {
          id: 'generator',
          assignmentId: 'generator',
          description: 'Implement the feature',
          execution: 'serial',
        },
        {
          id: 'evaluator',
          assignmentId: 'evaluator',
          description: 'Judge readiness',
          execution: 'serial',
        },
      ],
      evidence: {
        workspaceDir: join(tempDir, '.agent', 'project', 'managed-tasks', 'task-1'),
        runId: 'task-1',
        artifacts: [
          {
            kind: 'json',
            path: join(tempDir, '.agent', 'project', 'managed-tasks', 'task-1', 'summary.json'),
          },
        ],
        entries: [
          {
            assignmentId: 'evaluator',
            role: 'evaluator',
            status: 'blocked',
            summary: 'Need more evidence',
            sessionId: 'session-2',
            signal: 'BLOCKED',
            signalReason: 'Tests missing',
          },
        ],
        routingNotes: ['H1 selected for evaluator separation'],
      },
      verdict: {
        status: 'blocked',
        decidedByAssignmentId: 'evaluator',
        summary: 'Need more evidence',
        signal: 'BLOCKED',
        signalReason: 'Tests missing',
      },
    };

    await storage.saveManagedTask(managedTask);

    await expect(storage.loadManagedTask()).resolves.toEqual(managedTask);
    expect(storage.getPaths().managedTaskState).toContain('.agent');
    expect(storage.getPaths().managedTasksRoot).toContain('.agent');
  });

  it('persists lightweight direct run records and uses them for workflow summaries when managed tasks are absent', async () => {
    const storage = new ProjectStorage(tempDir);
    const record: ProjectLightweightRunRecord = {
      status: 'completed',
      summary: 'Direct project analysis completed without the managed harness.',
      sessionId: 'session-direct-project',
      taskSurface: 'project',
      agentMode: 'sa',
      executionMode: 'direct',
      featureIndex: 2,
      changedFiles: ['packages/repl/src/interactive/project-commands.ts'],
      checks: ['Confirm status output'],
      evidence: ['Reviewed direct analysis output'],
      blockers: [],
      nextStep: '/project next --no-confirm',
      createdAt: '2026-03-29T10:00:00.000Z',
      updatedAt: '2026-03-29T10:05:00.000Z',
    };

    await storage.saveLightweightRunRecord(record);

    await expect(storage.loadLightweightRunRecord()).resolves.toEqual(record);

    const state = await storage.loadWorkflowState();
    expect(state?.latestExecutionSummary).toBe(record.summary);
    expect(state?.currentFeatureIndex).toBe(2);
    expect(storage.getPaths().lightweightRunRecord).toContain('.agent');
  });

  it('deletes project runtime artifacts under .agent/project on full reset', async () => {
    const storage = new ProjectStorage(tempDir);
    await storage.writeSessionPlan('# Plan\n');
    await storage.writeHarnessConfig({ version: 1, checks: [] });
    await storage.appendHarnessRun({ featureIndex: 0 });
    await storage.appendHarnessCalibrationCase({ caseId: 'cal-1', featureIndex: 0 });
    await storage.appendHarnessCheckpoint({ checkpointId: 'cp-1' });
    await storage.appendHarnessSessionNode({ nodeId: 'node-1' });
    await storage.writeHarnessEvidence(0, { ok: true });

    const result = await storage.deleteProjectManagementFiles();

    expect(result.failed).toBe(0);
    expect(existsSync(storage.getPaths().projectArtifactsRoot)).toBe(false);
  });

  it('persists calibration corpus records under the harness root', async () => {
    const storage = new ProjectStorage(tempDir);
    const record = {
      caseId: 'feature-0-run-1-false_fail',
      runId: 'feature-0-run-1',
      featureIndex: 0,
      label: 'false_fail',
      observedDecision: 'retryable_failure',
      expectedDecision: 'verified_complete',
      checkpointId: 'feature-0-run-1-checkpoint',
      failureCodes: ['missing_completion_report'],
      summary: 'Harness rejected a completion that manual review later accepted.',
      createdAt: '2026-04-05T12:00:00.000Z',
    };

    await storage.appendHarnessCalibrationCase(record);

    await expect(storage.readHarnessCalibrationCases()).resolves.toEqual([record]);
    expect(storage.getPaths().harnessCalibration).toContain('.agent');
    expect(storage.getPaths().harnessCalibration).toContain('calibration.jsonl');
  });

  it('persists pivot records under the harness root', async () => {
    const storage = new ProjectStorage(tempDir);
    const record = {
      pivotId: 'feature-0-run-1-pivot',
      featureIndex: 0,
      fromRunId: 'feature-0-run-1',
      fromCheckpointId: 'feature-0-run-1-checkpoint',
      evidenceFeatureIndex: 0,
      decision: 'needs_review',
      failureCodes: ['stall_repeated_failure'],
      reason: 'Verifier keeps stalling on the same proof gap.',
      summary: 'Pivot away from the stalled path and keep the latest checkpoint.',
      createdAt: '2026-04-05T12:15:00.000Z',
    };

    await storage.appendHarnessPivot(record);

    await expect(storage.readHarnessPivots()).resolves.toEqual([record]);
    expect(storage.getPaths().harnessPivots).toContain('pivots.jsonl');
  });
});
