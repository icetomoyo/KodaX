import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDirSync, removeTempDirSync } from '../test-utils/temp-dir.js';
import {
  createProjectHarnessAttempt,
  formatProjectHarnessCheckpointSummary,
  formatProjectHarnessPivotSummary,
  loadOrCreateProjectHarnessConfig,
  readLatestHarnessCheckpoint,
  readLatestHarnessPivot,
  recordHarnessPivot,
  recordManualHarnessOverride,
  replayHarnessCalibrationCase,
  reverifyProjectHarnessRun,
} from './project-harness.js';
import { ProjectStorage } from './project-storage.js';

describe('project harness', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = createTempDirSync('kodax-project-harness-');
    const storage = new ProjectStorage(tempDir);
    await storage.saveFeatures({
      features: [
        {
          description: 'Add verifier-gated project execution',
        },
      ],
    });
  });

  afterEach(() => {
    removeTempDirSync(tempDir);
  });

  it('blocks direct writes to feature_list.json during harnessed execution', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    const wrapped = attempt.wrapOptions({
      provider: 'test',
      session: {},
      events: {},
    });

    const allowed = await wrapped.events!.beforeToolExecute!(
      'write',
      { path: storage.getPaths().features, content: '{}' },
    );

    expect(typeof allowed).toBe('string');
    expect(String(allowed)).toContain('Blocked by Project Harness');
  });

  it('describes a verification contract that exposes browser-testing hints for frontend work', async () => {
    const storage = new ProjectStorage(tempDir);
    await storage.writeHarnessConfig({
      version: 1,
      generatedAt: '2026-03-26T10:00:00.000Z',
      protectedArtifacts: ['feature_list.json', '.agent/project/harness'],
      checks: [
        {
          id: 'playwright-e2e',
          command: 'npx playwright test',
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
      invariants: {
        requireTestEvidenceOnComplete: true,
        requireDocUpdateOnArchitectureChange: false,
        enforcePackageBoundaryImports: false,
        requireDeclaredWorkspaceDependencies: false,
        requireFeatureChecklistCoverageOnComplete: false,
        requireSessionPlanChecklistCoverage: false,
        checklistCoverageMinimum: 0,
        sourceNotes: [],
      },
      exceptions: {
        allowedImportSpecifiers: [],
        skipChecklistFeaturePatterns: [],
      },
      repairPolicy: {
        codeOverrides: {},
        customPlaybooks: [],
      },
    });
    await storage.saveFeatures({
      features: [
        {
          description: 'Add frontend signup UI flow',
          steps: ['Verify the browser path with Playwright'],
        },
      ],
    });

    const feature = await storage.getFeatureByIndex(0);
    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    const contract = attempt.describeVerificationContract();

    expect(contract.requiredChecks).toContain('playwright-e2e: npx playwright test');
    expect(contract.requiredEvidence).toContain('Report the exact tests, checks, or browser validation that were executed.');
    expect(contract.capabilityHints?.map((hint) => hint.name)).toEqual(expect.arrayContaining(['agent-browser', 'playwright']));
  });

  it('blocks shell commands that try to modify feature_list.json', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    const wrapped = attempt.wrapOptions({
      provider: 'test',
      session: {},
      events: {},
    });

    const allowed = await wrapped.events!.beforeToolExecute!(
      'bash',
      { command: 'echo "{}" > feature_list.json' },
    );

    expect(typeof allowed).toBe('string');
    expect(String(allowed)).toContain('Shell commands must not modify feature_list.json');
  });

  it('blocks shell commands that try to modify harness-owned artifacts', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    const wrapped = attempt.wrapOptions({
      provider: 'test',
      session: {},
      events: {},
    });

    const allowed = await wrapped.events!.beforeToolExecute!(
      'bash',
      { command: 'Set-Content .agent/project/harness/config.generated.json "{}"' },
    );

    expect(typeof allowed).toBe('string');
    expect(String(allowed)).toContain('Shell commands must not modify .agent/project/harness');
  });

  it('blocks interpreter-based shell commands that touch protected artifacts', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    const wrapped = attempt.wrapOptions({
      provider: 'test',
      session: {},
      events: {},
    });

    const allowed = await wrapped.events!.beforeToolExecute!(
      'bash',
      { command: 'node -e "require(\'fs\').writeFileSync(\'feature_list.json\', \'{}\')"' },
    );

    expect(typeof allowed).toBe('string');
    expect(String(allowed)).toContain('Shell commands must not modify feature_list.json');
  });

  it('does not block read-only shell commands that merely mention a protected artifact in quoted output', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    const wrapped = attempt.wrapOptions({
      provider: 'test',
      session: {},
      events: {},
    });

    const allowed = await wrapped.events!.beforeToolExecute!(
      'bash',
      { command: 'git log --format="%H > feature_list.json"' },
    );

    expect(allowed).toBe(true);
  });

  it('verifies a completed attempt when progress is updated and a completion report is present', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session 1\n\nCompleted verifier wiring.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Implemented the verifier flow.","evidence":["Updated progress."],"tests":["manual check"],"changedFiles":["src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('verified_complete');
    expect(result.runRecord.changedFiles[0]).toContain('src');
    expect(result.evidenceRecord.completionSource).toBe('auto_verified');
    expect(result.evidenceRecord.completionSummary).toContain('Implemented the verifier flow');
    expect(result.runRecord.scorecard?.overall).toBeGreaterThan(0);
    expect(result.runRecord.scorecard?.legality).toBe(100);
  });

  it('captures checkpoint and session-tree metadata for persisted runs even outside a git repository', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session checkpoint\n\nImplemented verifier metadata.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Implemented the verifier flow.","evidence":["Updated progress."],"tests":["manual check"],"changedFiles":["src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    const checkpoints = await storage.readHarnessCheckpoints<{
      id?: string;
      checkpointId: string;
      runId: string;
      taskId?: string;
      featureIndex: number;
      gitHead: string | null;
      gitStatus: string[];
    }>();
    const nodes = await storage.readHarnessSessionNodes<{
      id?: string;
      nodeId: string;
      runId: string;
      taskId?: string;
      parentId?: string | null;
      parentRunId: string | null;
      checkpointId: string | null;
      featureIndex: number;
    }>();

    expect(result.decision).toBe('verified_complete');
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.id).toBe(checkpoints[0]?.checkpointId);
    expect(checkpoints[0]?.runId).toBe(result.runRecord.runId);
    expect(checkpoints[0]?.taskId).toBe('feature-0');
    expect(checkpoints[0]?.featureIndex).toBe(0);
    expect(checkpoints[0]?.gitHead ?? null).toBeNull();
    expect(checkpoints[0]?.gitStatus).toEqual([]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.id).toBe(nodes[0]?.nodeId);
    expect(nodes[0]?.taskId).toBe('feature-0');
    expect(nodes[0]?.runId).toBe(result.runRecord.runId);
    expect(nodes[0]?.parentId ?? null).toBeNull();
    expect(nodes[0]?.checkpointId).toContain(result.runRecord.runId);
    expect(nodes[0]?.parentRunId ?? null).toBeNull();
  });

  it('links later session-tree nodes to the previous run for the same feature', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const firstAttempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session one\n\nFirst verifier attempt.\n');
    const firstResult = await firstAttempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"First pass.","evidence":["Updated progress."],"tests":["manual check"],"changedFiles":["src/feature-a.ts"]}</project-harness>',
      } as never,
    ]);

    const secondAttempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 2);
    await storage.appendProgress('## Session two\n\nSecond verifier attempt.\n');
    const secondResult = await secondAttempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Second pass.","evidence":["Updated progress again."],"tests":["manual check"],"changedFiles":["src/feature-b.ts"]}</project-harness>',
      } as never,
    ]);

    const nodes = await storage.readHarnessSessionNodes<{
      parentId?: string | null;
      runId: string;
      parentRunId: string | null;
    }>();

    expect(nodes).toHaveLength(2);
    expect(nodes[1]?.runId).toBe(secondResult.runRecord.runId);
    expect(nodes[1]?.parentId).toBe(`${firstResult.runRecord.runId}-node`);
    expect(nodes[1]?.parentRunId).toBe(firstResult.runRecord.runId);
  });

  it('rejects a complete report that does not include changed files', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session 2\n\nSaid it was done but did not include files.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Implemented the verifier flow.","evidence":["Updated progress."]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('retryable_failure');
    expect(result.reasons.join(' | ')).toContain('changed files');
    expect(result.runRecord.failureCodes).toContain('missing_changed_files');
  });

  it('discovers rule sources from the current workspace project and excludes .kodax control files', async () => {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Workspace Agents\n', 'utf-8');
    mkdirSync(join(tempDir, 'docs', 'ADR'), { recursive: true });
    writeFileSync(join(tempDir, 'docs', 'HLD.md'), '# HLD\n', 'utf-8');
    writeFileSync(join(tempDir, 'docs', 'ADR', '0001-boundary.md'), '# ADR 1\n', 'utf-8');
    mkdirSync(join(tempDir, '.kodax'), { recursive: true });
    writeFileSync(join(tempDir, '.kodax', 'AGENTS.md'), '# Control Plane Agents\n', 'utf-8');
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'vitest run',
          lint: 'eslint .',
        },
      }),
      'utf-8',
    );

    const storage = new ProjectStorage(tempDir);
    const config = await loadOrCreateProjectHarnessConfig(storage);

    expect(config.ruleSources?.projectAgents).toEqual(['AGENTS.md']);
    expect(config.ruleSources?.architectureDocs).toEqual(['docs/HLD.md']);
    expect(config.ruleSources?.adrDocs).toEqual(['docs/ADR/0001-boundary.md']);
    expect(config.ruleSources?.scriptSources).toContain('package.json');
    expect(config.ruleSources?.scriptSources).toContain('package.json#scripts.test');
    expect(config.ruleSources?.excludedControlPlane).toEqual(['.kodax/**']);
    expect(config.ruleSources?.projectAgents).not.toContain('.kodax/AGENTS.md');
  });

  it('backfills rule sources into an existing harness config without dropping checks', async () => {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Workspace Agents\n', 'utf-8');
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'vitest run',
        },
      }),
      'utf-8',
    );

    const storage = new ProjectStorage(tempDir);
    await storage.writeHarnessConfig({
      version: 1,
      generatedAt: new Date().toISOString(),
      protectedArtifacts: ['feature_list.json', '.agent/project/harness'],
      checks: [
        {
          id: 'custom-check',
          command: 'node -e "process.exit(0)"',
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

    const config = await loadOrCreateProjectHarnessConfig(storage);

    expect(config.checks).toHaveLength(1);
    expect(config.checks[0]?.id).toBe('custom-check');
    expect(config.ruleSources?.projectAgents).toEqual(['AGENTS.md']);
    expect(config.ruleSources?.scriptSources).toContain('package.json#scripts.test');
    expect(config.exceptions?.allowedImportSpecifiers).toEqual([]);
    expect(config.repairPolicy?.customPlaybooks).toEqual([]);
    expect(config.invariants?.requireDeclaredWorkspaceDependencies).toBe(true);
    expect(config.invariants?.requireFeatureChecklistCoverageOnComplete).toBe(true);
  });

  it('refreshes generated rule sources and script checks when project docs or scripts change', async () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'vitest run',
        },
      }),
      'utf-8',
    );

    const storage = new ProjectStorage(tempDir);
    const firstConfig = await loadOrCreateProjectHarnessConfig(storage);

    expect(firstConfig.ruleSources?.architectureDocs).toEqual([]);
    expect(firstConfig.checks.map(check => check.id)).toEqual(['test']);
    expect(firstConfig.sourceFingerprint).toBeTruthy();

    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    writeFileSync(join(tempDir, 'docs', 'HLD.md'), '# New HLD\n', 'utf-8');
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'vitest run',
          build: 'tsc -b',
        },
      }),
      'utf-8',
    );
    utimesSync(join(tempDir, 'package.json'), new Date(2_000), new Date(2_000));
    utimesSync(join(tempDir, 'docs', 'HLD.md'), new Date(2_000), new Date(2_000));

    const refreshed = await loadOrCreateProjectHarnessConfig(storage);

    expect(refreshed.sourceFingerprint).not.toBe(firstConfig.sourceFingerprint);
    expect(refreshed.ruleSources?.architectureDocs).toEqual(['docs/HLD.md']);
    expect(refreshed.checks.map(check => check.id)).toEqual(['test', 'build']);
  });

  it('preserves custom checks while refreshing generated script checks', async () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'vitest run',
        },
      }),
      'utf-8',
    );

    const storage = new ProjectStorage(tempDir);
    const firstConfig = await loadOrCreateProjectHarnessConfig(storage);
    await storage.writeHarnessConfig({
      ...firstConfig,
      checks: [
        ...firstConfig.checks,
        {
          id: 'custom-check',
          command: 'node -e "process.exit(0)"',
          required: false,
        },
      ],
    });

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'vitest run',
          lint: 'eslint .',
        },
      }),
      'utf-8',
    );
    utimesSync(join(tempDir, 'package.json'), new Date(3_000), new Date(3_000));

    const refreshed = await loadOrCreateProjectHarnessConfig(storage);

    expect(refreshed.checks.map(check => check.id)).toContain('custom-check');
    expect(refreshed.checks.map(check => check.id)).toContain('test');
    expect(refreshed.checks.map(check => check.id)).toContain('lint');
  });

  it('compiles invariants from workspace docs and enforces test evidence on completion', async () => {
    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    writeFileSync(
      join(tempDir, 'docs', 'AGENTS.md'),
      '# Rules\n- TDD First: Write tests before implementation\n- Doc First: Update docs before coding\n',
      'utf-8',
    );

    const storage = new ProjectStorage(tempDir);
    const config = await loadOrCreateProjectHarnessConfig(storage);
    expect(config.invariants?.requireTestEvidenceOnComplete).toBe(true);
    expect(config.invariants?.requireDocUpdateOnArchitectureChange).toBe(true);
    expect(config.invariants?.requireFeatureChecklistCoverageOnComplete).toBe(true);
    expect(config.invariants?.requireSessionPlanChecklistCoverage).toBe(true);

    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session 3\n\nImplemented the feature.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Implemented the verifier flow.","evidence":["Updated progress."],"changedFiles":["src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('retryable_failure');
    expect(result.reasons.join(' | ')).toContain('explicit test evidence');
  });

  it('requires completion evidence to cover planned feature steps', async () => {
    const storage = new ProjectStorage(tempDir);
    await storage.saveFeatures({
      features: [
        {
          description: 'session tree rollback metadata',
          steps: [
            'Add session tree metadata persistence',
            'Add rollback verification tests',
          ],
        },
      ],
    });

    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();
    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session checklist\n\nGeneral progress only.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Implemented the feature.","evidence":["Updated files."],"tests":["vitest"],"changedFiles":["src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('retryable_failure');
    expect(result.runRecord.failureCodes).toContain('missing_feature_checklist_coverage');
    expect(result.repairPrompt).toContain('Add session tree metadata persistence');
  });

  it('does not treat a single keyword hit as enough checklist coverage', async () => {
    const storage = new ProjectStorage(tempDir);
    await storage.saveFeatures({
      features: [
        {
          description: 'session tree rollback metadata',
          steps: [
            'Implement session tree rollback metadata',
          ],
        },
      ],
    });

    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();
    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session checklist\n\nTouched unrelated session cleanup.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Updated session cleanup only.","evidence":["Adjusted session plumbing."],"tests":["vitest"],"changedFiles":["src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('retryable_failure');
    expect(result.runRecord.failureCodes).toContain('missing_feature_checklist_coverage');
  });

  it('supports Chinese checklist coverage for proof-carrying completion', async () => {
    const storage = new ProjectStorage(tempDir);
    await storage.saveFeatures({
      features: [
        {
          description: '会话树回滚元数据',
          steps: [
            '实现会话树回滚元数据持久化',
            '补充回滚验证测试',
          ],
        },
      ],
    });

    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();
    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## 会话\n\n已实现会话树回滚元数据持久化，并补充回滚验证测试。\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"已实现会话树回滚元数据持久化并补充回滚验证测试。","evidence":["更新了进度记录。"],"tests":["vitest 回滚验证"],"changedFiles":["src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('verified_complete');
    expect(result.runRecord.failureCodes ?? []).not.toContain('missing_feature_checklist_coverage');
  });

  it('falls back to session plan checklist coverage when the feature has no explicit steps', async () => {
    const storage = new ProjectStorage(tempDir);
    await storage.saveFeatures({
      features: [
        {
          description: 'session tree rollback metadata',
        },
      ],
    });
    await storage.writeSessionPlan(`## Implementation (2h)
Goal: Deliver the feature.
Milestone: Main path works.

- [ ] impl-1: Implement session tree rollback metadata (1h, medium)

## Validation (1h)
Goal: Lock correctness.
Milestone: Checks are green.

- [ ] validate-1: Add rollback verification tests (1h, medium)
`);

    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();
    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session plan\n\nGeneral progress only.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Implemented the feature.","evidence":["Updated files."],"tests":["vitest"],"changedFiles":["src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('retryable_failure');
    expect(result.runRecord.failureCodes).toContain('missing_plan_checklist_coverage');
    expect(result.repairPrompt).toContain('Add rollback verification tests');
  });

  it('requires doc evidence when the completion report claims architecture changes', async () => {
    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    writeFileSync(
      join(tempDir, 'docs', 'AGENTS.md'),
      '# Rules\n- Doc First: Update docs before coding (PRD, ADR, Feature Design)\n',
      'utf-8',
    );

    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session 4\n\nRefactored boundary handling.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Refactored architecture boundary handling.","evidence":["Adjusted layer boundaries."],"tests":["vitest packages/repl"],"changedFiles":["src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('retryable_failure');
    expect(result.reasons.join(' | ')).toContain('docs or ADR evidence');
  });

  it('rejects package imports that violate workspace layer direction rules', async () => {
    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    mkdirSync(join(tempDir, 'packages', 'coding', 'src'), { recursive: true });
    writeFileSync(
      join(tempDir, 'docs', 'HLD.md'),
      '# HLD\n\nLayer Independence\n\nPackage Dependencies\n',
      'utf-8',
    );
    writeFileSync(
      join(tempDir, 'packages', 'coding', 'src', 'feature.ts'),
      "import { something } from '@kodax/repl';\nexport const value = something;\n",
      'utf-8',
    );

    const storage = new ProjectStorage(tempDir);
    const config = await loadOrCreateProjectHarnessConfig(storage);
    expect(config.invariants?.enforcePackageBoundaryImports).toBe(true);

    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();
    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session 4\n\nImplemented the feature.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Implemented package changes.","evidence":["Updated progress."],"tests":["vitest"],"changedFiles":["packages/coding/src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('retryable_failure');
    expect(result.reasons.join(' | ')).toContain('imports higher-layer package');
    expect(result.runRecord.failureCodes).toContain('layer_direction_violation');
  });

  it('rejects workspace package imports that are not declared in the importing package manifest', async () => {
    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    mkdirSync(join(tempDir, 'packages', 'coding', 'src'), { recursive: true });
    writeFileSync(
      join(tempDir, 'docs', 'HLD.md'),
      '# HLD\n\nLayer Independence\n\nPackage Dependencies\n',
      'utf-8',
    );
    writeFileSync(
      join(tempDir, 'packages', 'coding', 'package.json'),
      JSON.stringify({
        name: '@kodax/coding',
        version: '0.0.0',
      }),
      'utf-8',
    );
    writeFileSync(
      join(tempDir, 'packages', 'coding', 'src', 'feature.ts'),
      "import { something } from '@kodax/skills';\nexport const value = something;\n",
      'utf-8',
    );

    const storage = new ProjectStorage(tempDir);
    const config = await loadOrCreateProjectHarnessConfig(storage);
    expect(config.invariants?.requireDeclaredWorkspaceDependencies).toBe(true);

    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();
    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session 4b\n\nImplemented the feature.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Implemented package changes.","evidence":["Updated progress."],"tests":["vitest"],"changedFiles":["packages/coding/src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('retryable_failure');
    expect(result.reasons.join(' | ')).toContain('without declaring it');
    expect(result.runRecord.failureCodes).toContain('undeclared_workspace_dependency');
  });

  it('does not report undeclared workspace dependency when the importing package has no manifest yet', async () => {
    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    mkdirSync(join(tempDir, 'packages', 'coding', 'src'), { recursive: true });
    writeFileSync(
      join(tempDir, 'docs', 'HLD.md'),
      '# HLD\n\nLayer Independence\n\nPackage Dependencies\n',
      'utf-8',
    );
    writeFileSync(
      join(tempDir, 'packages', 'coding', 'src', 'feature.ts'),
      "import { something } from '@kodax/skills';\nexport const value = something;\n",
      'utf-8',
    );

    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();
    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session 4c\n\nImplemented the feature.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Implemented package changes.","evidence":["Updated progress."],"tests":["vitest"],"changedFiles":["packages/coding/src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('verified_complete');
    expect(result.runRecord.failureCodes ?? []).not.toContain('undeclared_workspace_dependency');
    expect(result.runRecord.failureCodes ?? []).not.toContain('layer_direction_violation');
  });

  it('respects declarative import allowlists for repo-specific package exceptions', async () => {
    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    mkdirSync(join(tempDir, 'packages', 'coding', 'src'), { recursive: true });
    writeFileSync(
      join(tempDir, 'docs', 'HLD.md'),
      '# HLD\n\nLayer Independence\n\nPackage Dependencies\n',
      'utf-8',
    );
    writeFileSync(
      join(tempDir, 'packages', 'coding', 'src', 'feature.ts'),
      "import { something } from '@kodax/repl';\nexport const value = something;\n",
      'utf-8',
    );

    const storage = new ProjectStorage(tempDir);
    const config = await loadOrCreateProjectHarnessConfig(storage);
    await storage.writeHarnessConfig({
      ...config,
      exceptions: {
        ...config.exceptions,
        allowedImportSpecifiers: ['@kodax/repl'],
      },
    });

    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();
    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session import exception\n\nImplemented the feature.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Implemented package changes.","evidence":["Updated progress."],"tests":["vitest"],"changedFiles":["packages/coding/src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('verified_complete');
    expect(result.runRecord.failureCodes).not.toContain('layer_direction_violation');
  });

  it('applies custom repair playbooks declared in harness config', async () => {
    const storage = new ProjectStorage(tempDir);
    await storage.saveFeatures({
      features: [
        {
          description: 'session tree rollback metadata',
          steps: [
            'Add session tree metadata persistence',
            'Add rollback verification tests',
          ],
        },
      ],
    });

    const config = await loadOrCreateProjectHarnessConfig(storage);
    await storage.writeHarnessConfig({
      ...config,
      repairPolicy: {
        codeOverrides: {
          missing_feature_checklist_coverage: ['scope-narrowing'],
        },
        customPlaybooks: [
          {
            id: 'scope-narrowing',
            actions: [
              'Reduce the completion claim to the first explicit checklist item before broadening scope.',
            ],
          },
        ],
      },
    });

    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();
    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session custom playbook\n\nGeneral progress only.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Implemented the feature.","evidence":["Updated files."],"tests":["vitest"],"changedFiles":["src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('retryable_failure');
    expect(result.repairPrompt).toContain('Repair playbooks: scope-narrowing');
    expect(result.repairPrompt).toContain('Reduce the completion claim to the first explicit checklist item');
  });

  it('reverifies against refreshed rules without rewriting the persisted harness config', async () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'node -e "process.exit(0)"',
        },
      }),
      'utf-8',
    );

    const storage = new ProjectStorage(tempDir);
    const config = await loadOrCreateProjectHarnessConfig(storage);
    expect(config.checks.map(check => check.id)).toEqual(['test']);

    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();
    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session verify\n\nCompleted the work.\n');

    const verified = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Completed the work.","evidence":["Updated progress."],"tests":["test"],"changedFiles":["src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    const configBeforeReverify = readFileSync(storage.getPaths().harnessConfig, 'utf-8');
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'node -e "process.exit(0)"',
          build: 'node -e "process.exit(1)"',
        },
      }),
      'utf-8',
    );
    utimesSync(join(tempDir, 'package.json'), new Date(4_000), new Date(4_000));

    const reverified = await reverifyProjectHarnessRun(storage, verified.runRecord);
    const configAfterReverify = readFileSync(storage.getPaths().harnessConfig, 'utf-8');
    const persistedConfig = await storage.readHarnessConfig<{ checks: Array<{ id: string }> }>();

    expect(reverified.decision).toBe('retryable_failure');
    expect(reverified.runRecord.checks.map(check => `${check.id}:${check.passed ? 'pass' : 'fail'}`)).toContain('build:fail');
    expect(configAfterReverify).toBe(configBeforeReverify);
    expect(persistedConfig?.checks.map(check => check.id)).toEqual(['test']);
  });

  it('rejects large unrelated diffs that do not appear tied to the active feature', async () => {
    const storage = new ProjectStorage(tempDir);
    await storage.saveFeatures({
      features: [
        {
          description: 'session tree rollback metadata',
        },
      ],
    });

    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session 5\n\nTouched many files.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Updated various files.","evidence":["General cleanup."],"tests":["vitest"],"changedFiles":["README.md","package.json","scripts/release.sh","tests/other.test.ts","docs/notes.md"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('retryable_failure');
    expect(result.reasons.join(' | ')).toContain('do not appear related to the active feature');
  });

  it('upgrades repeated feature failures into needs_review', async () => {
    const storage = new ProjectStorage(tempDir);
    await storage.appendHarnessRun({
      runId: 'feature-0-old-1',
      featureIndex: 0,
      mode: 'next',
      attempt: 1,
      decision: 'retryable_failure',
      changedFiles: ['src/feature.ts'],
      checks: [],
      qualityBefore: 10,
      qualityAfter: 10,
      violations: [],
      repairHints: ['retry'],
      evidence: ['old failure'],
      completionReport: null,
      createdAt: new Date().toISOString(),
    });
    await storage.appendHarnessRun({
      runId: 'feature-0-old-2',
      featureIndex: 0,
      mode: 'next',
      attempt: 2,
      decision: 'retryable_failure',
      changedFiles: ['src/feature.ts'],
      checks: [],
      qualityBefore: 10,
      qualityAfter: 10,
      violations: [],
      repairHints: ['retry'],
      evidence: ['old failure'],
      completionReport: null,
      createdAt: new Date().toISOString(),
    });

    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 3);
    await storage.appendProgress('## Session 6\n\nStill not done.\n');

    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Implemented the verifier flow.","evidence":["Updated progress."],"tests":["manual check"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('needs_review');
    expect(result.reasons.join(' | ')).toContain('Repeated verification failures');
  });

  it('includes structured failure codes in repair feedback', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    const result = await attempt.verify([
      {
        role: 'assistant',
        content: 'No completion report here.',
      } as never,
    ]);

    expect(result.decision).toBe('retryable_failure');
    expect(result.runRecord.failureCodes).toContain('missing_completion_report');
    expect(result.repairPrompt).toContain('Failure codes: missing_completion_report');
    expect(result.repairPrompt).toContain('Repair playbooks: completion-proof');

    const critics = await storage.readHarnessCritics<{ failureCodes: string[]; repairPlaybooks: string[] }>();
    expect(critics).toHaveLength(1);
    expect(critics[0]?.failureCodes).toContain('missing_completion_report');
    expect(critics[0]?.repairPlaybooks).toContain('completion-proof');
  });

  it('assigns a lower score to stalled or low-evidence attempts', async () => {
    const storage = new ProjectStorage(tempDir);
    await storage.appendHarnessRun({
      runId: 'feature-0-old-1',
      featureIndex: 0,
      mode: 'next',
      attempt: 1,
      decision: 'retryable_failure',
      failureCodes: ['missing_completion_report'],
      changedFiles: [],
      checks: [],
      qualityBefore: 10,
      qualityAfter: 10,
      violations: [],
      repairHints: ['retry'],
      evidence: [],
      completionReport: null,
      createdAt: new Date().toISOString(),
    });
    await storage.appendProgress('## Session 7\n\nLittle evidence.\n');

    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 2);
    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"needs_review","summary":"Still uncertain."}</project-harness>',
      } as never,
    ]);

    expect(result.runRecord.scorecard?.overall).toBeLessThan(70);
    expect(result.runRecord.scorecard?.stallResistance).toBeLessThan(100);
  });

  it('persists false-fail calibration cases and can replay them deterministically', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    const result = await attempt.verify([
      {
        role: 'assistant',
        content: 'No completion report here.',
      } as never,
    ]);

    expect(result.decision).toBe('retryable_failure');

    await recordManualHarnessOverride(storage, 0, 'done');

    const cases = await storage.readHarnessCalibrationCases<{
      caseId: string;
      label: string;
      runId: string;
      checkpointId: string | null;
    }>();
    expect(cases).toHaveLength(1);
    expect(cases[0]?.label).toBe('false_fail');
    expect(cases[0]?.runId).toBe(result.runRecord.runId);
    expect(cases[0]?.checkpointId).toContain(result.runRecord.runId);

    const replay = await replayHarnessCalibrationCase(storage, cases[0] as never);
    expect(replay.decision).toBe(result.decision);

    const checkpoint = await readLatestHarnessCheckpoint(storage, 0);
    expect(checkpoint?.runId).toBe(result.runRecord.runId);
    expect(formatProjectHarnessCheckpointSummary(checkpoint!)).toContain('Project Harness Safe Checkpoint');
  });

  it('persists false-pass calibration cases when manual review rejects a verified completion', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await storage.appendProgress('## Session 8\n\nVerifier work completed.\n');
    const result = await attempt.verify([
      {
        role: 'assistant',
        content: '<project-harness>{"status":"complete","summary":"Implemented the verifier flow.","evidence":["Updated progress."],"tests":["manual"],"changedFiles":["src/feature.ts"]}</project-harness>',
      } as never,
    ]);

    expect(result.decision).toBe('verified_complete');

    await recordManualHarnessOverride(storage, 0, 'skip');

    const cases = await storage.readHarnessCalibrationCases<{
      label: string;
      observedDecision: string;
      expectedDecision: string;
    }>();
    expect(cases).toHaveLength(1);
    expect(cases[0]?.label).toBe('false_pass');
    expect(cases[0]?.observedDecision).toBe('verified_complete');
    expect(cases[0]?.expectedDecision).toBe('needs_review');
  });

  it('does not duplicate the same calibration case on repeated manual overrides', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    await attempt.verify([
      {
        role: 'assistant',
        content: 'No completion report here.',
      } as never,
    ]);

    await recordManualHarnessOverride(storage, 0, 'done');
    await recordManualHarnessOverride(storage, 0, 'done');

    const cases = await storage.readHarnessCalibrationCases();
    expect(cases).toHaveLength(1);
  });

  it('records an explicit pivot with preserved checkpoint linkage', async () => {
    const storage = new ProjectStorage(tempDir);
    const feature = await storage.getFeatureByIndex(0);
    expect(feature).not.toBeNull();

    const attempt = await createProjectHarnessAttempt(storage, feature!, 0, 'next', 1);
    const result = await attempt.verify([
      {
        role: 'assistant',
        content: 'No completion report here.',
      } as never,
    ]);

    expect(result.decision).toBe('retryable_failure');

    const pivot = await recordHarnessPivot(storage, 0, {
      reason: 'Repeated proof gaps suggest the current implementation path should change.',
    });

    expect(pivot.fromRunId).toBe(result.runRecord.runId);
    expect(pivot.fromCheckpointId).toContain(result.runRecord.runId);
    expect(pivot.failureCodes).toContain('missing_completion_report');

    const latestPivot = await readLatestHarnessPivot(storage, 0);
    expect(latestPivot?.pivotId).toBe(pivot.pivotId);
    expect(formatProjectHarnessPivotSummary(latestPivot!)).toContain('Project Harness Pivot');
  });
});
