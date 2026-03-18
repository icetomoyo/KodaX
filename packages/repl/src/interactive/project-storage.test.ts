import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendBrainstormExchange,
  completeBrainstormSession,
  createBrainstormSession,
  formatBrainstormTranscript,
} from './project-brainstorm.js';
import { ProjectStorage } from './project-storage.js';

describe('project-storage brainstorm persistence', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kodax-project-storage-'));
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
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

  it('deletes project runtime artifacts under .agent/project on full reset', async () => {
    const storage = new ProjectStorage(tempDir);
    await storage.writeSessionPlan('# Plan\n');
    await storage.writeHarnessConfig({ version: 1, checks: [] });
    await storage.appendHarnessRun({ featureIndex: 0 });
    await storage.appendHarnessCheckpoint({ checkpointId: 'cp-1' });
    await storage.appendHarnessSessionNode({ nodeId: 'node-1' });
    await storage.writeHarnessEvidence(0, { ok: true });

    const result = await storage.deleteProjectManagementFiles();

    expect(result.failed).toBe(0);
    expect(existsSync(storage.getPaths().projectArtifactsRoot)).toBe(false);
  });
});
