/**
 * Project storage for /project workflows.
 *
 * It owns the project management artifacts created in the current workspace
 * and keeps file IO in one place so command handlers stay thin.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import {
  KODAX_FEATURES_FILE,
  KODAX_PROGRESS_FILE,
  type KodaXManagedTask,
  type KodaXTaskStatus,
} from '@kodax/coding';
import {
  ProjectFeature,
  FeatureList,
  ProjectStatistics,
  calculateStatistics,
  getNextPendingIndex,
  type ProjectControlState,
  type ProjectWorkflowState,
  type ProjectBrief,
  type ProjectAlignment,
  DEFAULT_DISCOVERY_OPEN_QUESTIONS,
  createProjectWorkflowState,
  parseProjectBriefMarkdown,
  parseProjectAlignmentMarkdown,
  formatProjectBriefMarkdown,
  formatProjectAlignmentMarkdown,
} from './project-state.js';
import type { BrainstormSession } from './project-brainstorm.js';
import {
  isKodaXManagedTask,
  isBrainstormSession,
  isFeatureList,
  isProjectControlState,
  isProjectWorkflowState,
  isRecord,
} from './json-guards.js';

function hasSessionIdField(value: unknown): value is { sessionId?: string } {
  return isRecord(value) && (value.sessionId === undefined || typeof value.sessionId === 'string');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export interface ProjectLightweightRunRecord {
  status: KodaXTaskStatus;
  summary: string;
  sessionId: string;
  taskSurface: 'project';
  agentMode: 'sa' | 'ama';
  executionMode: 'direct';
  featureIndex?: number;
  requestId?: string;
  projectMetadata?: Record<string, unknown>;
  changedFiles: string[];
  checks: string[];
  evidence: string[];
  blockers: string[];
  nextStep?: string;
  createdAt: string;
  updatedAt: string;
}

function isProjectLightweightRunRecord(value: unknown): value is ProjectLightweightRunRecord {
  return isRecord(value)
    && (value.status === 'planned' || value.status === 'running' || value.status === 'blocked' || value.status === 'failed' || value.status === 'completed')
    && typeof value.summary === 'string'
    && typeof value.sessionId === 'string'
    && value.taskSurface === 'project'
    && (value.agentMode === 'sa' || value.agentMode === 'ama')
    && value.executionMode === 'direct'
    && (value.featureIndex === undefined || typeof value.featureIndex === 'number')
    && (value.requestId === undefined || typeof value.requestId === 'string')
    && (value.projectMetadata === undefined || isRecord(value.projectMetadata))
    && isStringArray(value.changedFiles)
    && isStringArray(value.checks)
    && isStringArray(value.evidence)
    && isStringArray(value.blockers)
    && (value.nextStep === undefined || typeof value.nextStep === 'string')
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

export class ProjectStorage {
  private projectDir: string;
  private featuresPath: string;
  private progressPath: string;
  private projectArtifactsRoot: string;
  private projectStatePath: string;
  private projectControlStatePath: string;
  private projectBriefPath: string;
  private alignmentPath: string;
  private changeRequestsPath: string;
  private sessionPlanPath: string;
  private legacySessionPlanPath: string;
  private brainstormIndexPath: string;
  private legacyBrainstormIndexPath: string;
  private brainstormProjectsPath: string;
  private legacyBrainstormProjectsPath: string;
  private managedTasksRootPath: string;
  private managedTaskStatePath: string;
  private lightweightRunRecordPath: string;
  private harnessRootPath: string;
  private harnessConfigPath: string;
  private harnessRunsPath: string;
  private harnessCriticPath: string;
  private harnessCalibrationPath: string;
  private harnessPivotsPath: string;
  private harnessCheckpointsPath: string;
  private harnessSessionTreePath: string;
  private harnessEvidencePath: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.featuresPath = path.join(projectDir, KODAX_FEATURES_FILE);
    this.progressPath = path.join(projectDir, KODAX_PROGRESS_FILE);
    this.projectArtifactsRoot = path.join(projectDir, '.agent', 'project');
    this.projectStatePath = path.join(this.projectArtifactsRoot, 'project_state.json');
    this.projectControlStatePath = path.join(this.projectArtifactsRoot, 'control-state.json');
    this.projectBriefPath = path.join(this.projectArtifactsRoot, 'project_brief.md');
    this.alignmentPath = path.join(this.projectArtifactsRoot, 'alignment.md');
    this.changeRequestsPath = path.join(this.projectArtifactsRoot, 'change-requests');
    this.sessionPlanPath = path.join(this.projectArtifactsRoot, 'session_plan.md');
    this.legacySessionPlanPath = path.join(projectDir, '.kodax', 'session_plan.md');
    this.brainstormIndexPath = path.join(this.projectArtifactsRoot, 'brainstorm-active.json');
    this.legacyBrainstormIndexPath = path.join(projectDir, '.kodax', 'brainstorm-active.json');
    this.brainstormProjectsPath = path.join(this.projectArtifactsRoot, 'brainstorm');
    this.legacyBrainstormProjectsPath = path.join(projectDir, '.kodax', 'projects');
    this.managedTasksRootPath = path.join(this.projectArtifactsRoot, 'managed-tasks');
    this.managedTaskStatePath = path.join(this.projectArtifactsRoot, 'managed-task.json');
    this.lightweightRunRecordPath = path.join(this.projectArtifactsRoot, 'lightweight-run.json');
    this.harnessRootPath = path.join(this.projectArtifactsRoot, 'harness');
    this.harnessConfigPath = path.join(this.harnessRootPath, 'config.generated.json');
    this.harnessRunsPath = path.join(this.harnessRootPath, 'runs.jsonl');
    this.harnessCriticPath = path.join(this.harnessRootPath, 'critic.jsonl');
    this.harnessCalibrationPath = path.join(this.harnessRootPath, 'calibration.jsonl');
    this.harnessPivotsPath = path.join(this.harnessRootPath, 'pivots.jsonl');
    this.harnessCheckpointsPath = path.join(this.projectArtifactsRoot, 'checkpoints', 'index.jsonl');
    this.harnessSessionTreePath = path.join(this.projectArtifactsRoot, 'session-tree', 'nodes.jsonl');
    this.harnessEvidencePath = path.join(this.harnessRootPath, 'evidence');
  }

  private getBrainstormSessionDir(sessionId: string, legacy = false): string {
    return legacy
      ? path.join(this.legacyBrainstormProjectsPath, sessionId, 'brainstorm')
      : path.join(this.brainstormProjectsPath, sessionId);
  }

  private getBrainstormSessionPath(sessionId: string, legacy = false): string {
    return path.join(this.getBrainstormSessionDir(sessionId, legacy), 'session.json');
  }

  private getBrainstormTranscriptPath(sessionId: string, legacy = false): string {
    return path.join(this.getBrainstormSessionDir(sessionId, legacy), 'transcript.md');
  }

  private getHarnessEvidenceFilePath(featureIndex: number): string {
    return path.join(this.harnessEvidencePath, `feature-${featureIndex}.json`);
  }

  private getChangeRequestPath(requestId: string): string {
    return path.join(this.changeRequestsPath, `${requestId}.md`);
  }

  private warnMalformedJsonl(filePath: string, label: string, count: number): void {
    if (count === 0 || process.env.NODE_ENV === 'test') {
      return;
    }

    const fileName = path.basename(filePath);
    console.warn(`[KodaX] Skipped ${count} malformed ${label} record(s) from ${fileName}.`);
  }

  private async readJsonLinesFile<T>(
    filePath: string,
    label: string,
    validator?: (value: unknown) => value is T,
  ): Promise<T[]> {
    const content = await this.readTextFileWithFallback(filePath);
    if (!content.trim()) {
      return [];
    }

    const records: T[] = [];
    let malformedCount = 0;
    for (const line of content.split('\n').map(item => item.trim()).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        if (validator) {
          if (validator(parsed)) {
            records.push(parsed);
          } else {
            malformedCount += 1;
          }
          continue;
        }

        if (isRecord(parsed)) {
          records.push(parsed as T);
        } else {
          malformedCount += 1;
        }
      } catch {
        malformedCount += 1;
      }
    }

    this.warnMalformedJsonl(filePath, label, malformedCount);
    return records;
  }

  private async readTextFileWithFallback(...paths: string[]): Promise<string> {
    for (const candidate of paths) {
      try {
        return await fs.readFile(candidate, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`[KodaX] Failed to read ${candidate}:`, error);
          return '';
        }
      }
    }

    return '';
  }

  private readMarkdownSection(content: string, heading: string): string {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = content.match(
      new RegExp(`## ${escapedHeading}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`),
    );
    return match?.[1]?.trim() ?? '';
  }

  private async readJsonFile<T>(
    filePath: string,
    validator?: (value: unknown) => value is T,
  ): Promise<T | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);

      if (validator) {
        if (!validator(parsed)) {
          console.warn(`[KodaX] Ignored malformed JSON structure in ${path.basename(filePath)}.`);
          return null;
        }
        return parsed;
      }

      if (!isRecord(parsed)) {
        console.warn(`[KodaX] Ignored non-object JSON structure in ${path.basename(filePath)}.`);
        return null;
      }

      return parsed as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      console.error(`[KodaX] Failed to load ${filePath}:`, error);
      return null;
    }
  }

  private async readJsonFileWithFallback<T>(
    paths: string[],
    validator?: (value: unknown) => value is T,
  ): Promise<T | null> {
    for (const candidate of paths) {
      const data = await this.readJsonFile<T>(candidate, validator);
      if (data) {
        return data;
      }
    }

    return null;
  }

  async exists(): Promise<boolean> {
    const candidates = [
      this.featuresPath,
      this.progressPath,
      this.projectStatePath,
      this.projectControlStatePath,
      this.projectBriefPath,
      this.alignmentPath,
      this.lightweightRunRecordPath,
    ];

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return true;
      } catch {
        // Keep scanning.
      }
    }

    return false;
  }

  private async ensureProjectArtifactsRoot(): Promise<void> {
    await fs.mkdir(this.projectArtifactsRoot, { recursive: true });
  }

  async loadFeatures(): Promise<FeatureList | null> {
    try {
      const content = await fs.readFile(this.featuresPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (!isFeatureList(parsed)) {
        console.warn(`[KodaX] Ignored malformed feature list in ${path.basename(this.featuresPath)}.`);
        return null;
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      console.error(`[KodaX] Failed to load ${this.featuresPath}:`, error);
      return null;
    }
  }

  async saveFeatures(data: FeatureList): Promise<void> {
    await fs.writeFile(
      this.featuresPath,
      JSON.stringify(data, null, 2),
      'utf-8',
    );
  }

  async readProgress(): Promise<string> {
    try {
      return await fs.readFile(this.progressPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      console.error(`[KodaX] Failed to read ${this.progressPath}:`, error);
      return '';
    }
  }

  async appendProgress(content: string): Promise<void> {
    const existing = await this.readProgress();
    const newContent = existing ? `${existing}\n${content}` : content;
    await fs.writeFile(this.progressPath, newContent, 'utf-8');
  }

  async readSessionPlan(): Promise<string> {
    return this.readTextFileWithFallback(this.sessionPlanPath, this.legacySessionPlanPath);
  }

  async writeSessionPlan(content: string): Promise<void> {
    const artifactsDir = path.dirname(this.sessionPlanPath);
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(this.sessionPlanPath, content, 'utf-8');
  }

  private parseManagedTaskFeatureIndex(task: KodaXManagedTask | null): number | undefined {
    const featureIndex = task?.contract.metadata?.featureIndex;
    return typeof featureIndex === 'number' ? featureIndex : undefined;
  }

  private resolveWorkflowLastUpdated(
    fallback: string,
    values: Array<string | undefined>,
  ): string {
    const timestamps = values
      .filter((value): value is string => Boolean(value))
      .map((value) => Date.parse(value))
      .filter((value) => !Number.isNaN(value));

    if (timestamps.length === 0) {
      return fallback;
    }

    return new Date(Math.max(...timestamps)).toISOString();
  }

  private hasAlignedTruth(alignment: ProjectAlignment | null): boolean {
    if (!alignment) {
      return false;
    }

    return alignment.confirmedRequirements.length > 0
      || alignment.constraints.length > 0
      || alignment.nonGoals.length > 0
      || alignment.acceptedTradeoffs.length > 0
      || alignment.successCriteria.length > 0;
  }

  private async deriveWorkflowState(
    controlState: ProjectControlState | null,
    legacyState: ProjectWorkflowState | null,
  ): Promise<ProjectWorkflowState | null> {
    const timestamp = new Date().toISOString();
    const featureList = await this.loadFeatures();
    const sessionPlan = await this.readSessionPlan();
    const activeSession = await this.loadActiveBrainstormSession();
    const alignment = await this.readAlignment();
    const managedTask = await this.loadManagedTask();
    const lightweightRun = await this.loadLightweightRunRecord();
    const stats = featureList ? calculateStatistics(featureList.features) : null;

    const hasAnyWorkflowSignal = Boolean(
      controlState
      || legacyState
      || featureList?.features.length
      || sessionPlan.trim()
      || activeSession
      || alignment
      || managedTask
      || lightweightRun
    );
    if (!hasAnyWorkflowSignal) {
      return null;
    }

    const scope = controlState?.scope ?? legacyState?.scope ?? 'project';
    const activeRequestId = controlState?.activeRequestId ?? legacyState?.activeRequestId;
    const discoveryStepIndex = controlState?.discoveryStepIndex ?? legacyState?.discoveryStepIndex ?? 0;
    const defaultDiscoveryQuestionCount = DEFAULT_DISCOVERY_OPEN_QUESTIONS.length;
    const controlSuggestsDiscovery = Boolean(
      controlState
      && discoveryStepIndex < defaultDiscoveryQuestionCount
    );
    const hasPlanningMarker = Boolean(
      controlState?.lastPlannedAt
      || legacyState?.lastPlannedAt
      || managedTask
      || lightweightRun
    );
    const managedTaskFeatureIndex = this.parseManagedTaskFeatureIndex(managedTask);
    const lightweightRunFeatureIndex = typeof lightweightRun?.featureIndex === 'number'
      ? lightweightRun.featureIndex
      : undefined;
    const nextPendingIndex = featureList ? getNextPendingIndex(featureList.features) : -1;
    const currentFeatureIndex = managedTask?.contract.status === 'blocked' || managedTask?.contract.status === 'failed'
      ? managedTaskFeatureIndex
      : nextPendingIndex >= 0
        ? nextPendingIndex
        : managedTaskFeatureIndex ?? lightweightRunFeatureIndex;

    let stage: ProjectWorkflowState['stage'] = 'bootstrap';
    if (activeSession || (alignment?.openQuestions.length ?? 0) > 0 || controlSuggestsDiscovery) {
      stage = 'discovering';
    } else if (this.hasAlignedTruth(alignment) && !hasPlanningMarker) {
      stage = 'aligned';
    } else if (sessionPlan.trim() && hasPlanningMarker) {
      if (
        managedTask?.contract.status === 'blocked'
        || managedTask?.contract.status === 'failed'
        || lightweightRun?.status === 'blocked'
        || lightweightRun?.status === 'failed'
      ) {
        stage = 'blocked';
      } else if (stats && stats.total > 0 && stats.pending === 0) {
        stage = 'completed';
      } else if (
        managedTask?.contract.status === 'completed'
        || managedTask?.contract.status === 'running'
        || lightweightRun?.status === 'completed'
        || lightweightRun?.status === 'running'
      ) {
        stage = 'executing';
      } else {
        stage = 'planned';
      }
    } else if (featureList?.features.length) {
      stage = stats && stats.pending === 0 ? 'completed' : 'planned';
    }

    const unresolvedQuestionCount = activeSession
      ? Math.max(1, alignment?.openQuestions.length ?? defaultDiscoveryQuestionCount - discoveryStepIndex)
      : (alignment?.openQuestions.length ?? 0) > 0
        ? alignment?.openQuestions.length ?? 0
        : controlSuggestsDiscovery
          ? Math.max(0, defaultDiscoveryQuestionCount - discoveryStepIndex)
          : 0;
    const latestExecutionSummary = managedTask?.verdict.summary
      ?? lightweightRun?.summary
      ?? controlState?.latestExecutionSummary
      ?? legacyState?.latestExecutionSummary;
    const lastUpdated = this.resolveWorkflowLastUpdated(timestamp, [
      controlState?.lastUpdated,
      legacyState?.lastUpdated,
      alignment?.updatedAt,
      activeSession?.updatedAt,
      managedTask?.contract.updatedAt,
      lightweightRun?.updatedAt,
    ]);

    return {
      stage,
      scope,
      activeRequestId,
      unresolvedQuestionCount,
      currentFeatureIndex,
      lastPlannedAt: controlState?.lastPlannedAt ?? legacyState?.lastPlannedAt,
      latestExecutionSummary,
      lastUpdated,
      discoveryStepIndex,
    };
  }

  async loadControlState(): Promise<ProjectControlState | null> {
    return this.readJsonFile<ProjectControlState>(this.projectControlStatePath, isProjectControlState);
  }

  async saveControlState(state: ProjectControlState): Promise<void> {
    await this.ensureProjectArtifactsRoot();
    await fs.writeFile(this.projectControlStatePath, JSON.stringify(state, null, 2), 'utf-8');
    try {
      await fs.unlink(this.projectStatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async loadWorkflowState(): Promise<ProjectWorkflowState | null> {
    const [controlState, legacyState] = await Promise.all([
      this.loadControlState(),
      this.readJsonFile<ProjectWorkflowState>(this.projectStatePath, isProjectWorkflowState),
    ]);
    return this.deriveWorkflowState(controlState, legacyState);
  }

  async loadManagedTask(): Promise<KodaXManagedTask | null> {
    return this.readJsonFile<KodaXManagedTask>(this.managedTaskStatePath, isKodaXManagedTask);
  }

  async loadLightweightRunRecord(): Promise<ProjectLightweightRunRecord | null> {
    return this.readJsonFile<ProjectLightweightRunRecord>(
      this.lightweightRunRecordPath,
      isProjectLightweightRunRecord,
    );
  }

  async saveManagedTask(task: KodaXManagedTask): Promise<void> {
    await this.ensureProjectArtifactsRoot();
    await fs.mkdir(this.managedTasksRootPath, { recursive: true });
    await fs.writeFile(this.managedTaskStatePath, JSON.stringify(task, null, 2), 'utf-8');
  }

  async saveLightweightRunRecord(record: ProjectLightweightRunRecord): Promise<void> {
    await this.ensureProjectArtifactsRoot();
    await fs.writeFile(this.lightweightRunRecordPath, JSON.stringify(record, null, 2), 'utf-8');
  }

  async clearManagedTask(): Promise<void> {
    try {
      await fs.unlink(this.managedTaskStatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async clearLightweightRunRecord(): Promise<void> {
    try {
      await fs.unlink(this.lightweightRunRecordPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async inferWorkflowState(): Promise<ProjectWorkflowState> {
    return (await this.loadWorkflowState()) ?? createProjectWorkflowState('bootstrap', new Date().toISOString());
  }

  async loadOrInferWorkflowState(): Promise<ProjectWorkflowState> {
    return (await this.loadWorkflowState()) ?? this.inferWorkflowState();
  }

  async saveWorkflowState(state: ProjectWorkflowState): Promise<void> {
    await this.saveControlState({
      scope: state.scope,
      activeRequestId: state.activeRequestId,
      discoveryStepIndex: state.stage === 'discovering'
        ? state.discoveryStepIndex
        : DEFAULT_DISCOVERY_OPEN_QUESTIONS.length,
      lastUpdated: state.lastUpdated,
      lastPlannedAt: state.lastPlannedAt,
      latestExecutionSummary: state.latestExecutionSummary,
    });
  }

  async readProjectBrief(): Promise<ProjectBrief | null> {
    const content = await this.readTextFileWithFallback(this.projectBriefPath);
    if (!content.trim()) {
      return null;
    }
    return parseProjectBriefMarkdown(content);
  }

  async writeProjectBrief(brief: ProjectBrief): Promise<void> {
    await this.ensureProjectArtifactsRoot();
    await fs.writeFile(this.projectBriefPath, formatProjectBriefMarkdown(brief), 'utf-8');
  }

  async readAlignment(): Promise<ProjectAlignment | null> {
    const content = await this.readTextFileWithFallback(this.alignmentPath);
    if (!content.trim()) {
      return null;
    }
    return parseProjectAlignmentMarkdown(content);
  }

  async writeAlignment(alignment: ProjectAlignment): Promise<void> {
    await this.ensureProjectArtifactsRoot();
    await fs.writeFile(this.alignmentPath, formatProjectAlignmentMarkdown(alignment), 'utf-8');
  }

  async createChangeRequest(prompt: string, timestamp = new Date().toISOString()): Promise<{
    id: string;
    path: string;
    content: string;
  }> {
    const requestId = `request_${timestamp.replace(/[:.]/g, '-')}`;
    const content = [
      '# Change Request',
      '',
      `Request ID: ${requestId}`,
      `Updated: ${timestamp}`,
      '',
      '## Prompt',
      prompt.trim(),
      '',
      '## Impacted Areas',
      '- (to be refined during discovery)',
      '',
      '## Discovery Summary',
      '- (pending)',
      '',
      '## Plan Delta Summary',
      '- (pending)',
    ].join('\n');

    await fs.mkdir(this.changeRequestsPath, { recursive: true });
    const targetPath = this.getChangeRequestPath(requestId);
    await fs.writeFile(targetPath, content, 'utf-8');

    return {
      id: requestId,
      path: targetPath,
      content,
    };
  }

  async readChangeRequest(requestId: string): Promise<string> {
    return this.readTextFileWithFallback(this.getChangeRequestPath(requestId));
  }

  async readChangeRequestPrompt(requestId: string): Promise<string> {
    const content = await this.readChangeRequest(requestId);
    if (!content.trim()) {
      return '';
    }
    return this.readMarkdownSection(content, 'Prompt');
  }

  async saveBrainstormSession(
    session: BrainstormSession,
    transcript: string,
  ): Promise<void> {
    const sessionDir = this.getBrainstormSessionDir(session.id);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      this.getBrainstormSessionPath(session.id),
      JSON.stringify(session, null, 2),
      'utf-8',
    );
    await fs.writeFile(
      this.getBrainstormTranscriptPath(session.id),
      transcript,
      'utf-8',
    );
    if (session.status === 'active') {
      await fs.writeFile(
        this.brainstormIndexPath,
        JSON.stringify(
          {
            sessionId: session.id,
            topic: session.topic,
            updatedAt: session.updatedAt,
            status: session.status,
          },
          null,
          2,
        ),
        'utf-8',
      );
    } else {
      await this.clearActiveBrainstormSession();
    }
  }

  async loadBrainstormSession(sessionId: string): Promise<BrainstormSession | null> {
    return this.readJsonFileWithFallback<BrainstormSession>(
      [
        this.getBrainstormSessionPath(sessionId),
        this.getBrainstormSessionPath(sessionId, true),
      ],
      isBrainstormSession,
    );
  }

  async readBrainstormTranscript(sessionId: string): Promise<string> {
    return this.readTextFileWithFallback(
      this.getBrainstormTranscriptPath(sessionId),
      this.getBrainstormTranscriptPath(sessionId, true),
    );
  }

  async loadActiveBrainstormSession(): Promise<BrainstormSession | null> {
    const data = await this.readJsonFileWithFallback<{ sessionId?: string }>(
      [
        this.brainstormIndexPath,
        this.legacyBrainstormIndexPath,
      ],
      hasSessionIdField,
    );
    if (!data?.sessionId) {
      return null;
    }
    return await this.loadBrainstormSession(data.sessionId);
  }

  async clearActiveBrainstormSession(): Promise<void> {
    for (const filePath of [this.brainstormIndexPath, this.legacyBrainstormIndexPath]) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  async getNextPendingFeature(): Promise<{ feature: ProjectFeature; index: number } | null> {
    const data = await this.loadFeatures();
    if (!data || !data.features.length) {
      return null;
    }

    const index = getNextPendingIndex(data.features);
    if (index === -1) {
      return null;
    }

    const feature = data.features[index];
    if (!feature) {
      return null;
    }

    return { feature, index };
  }

  async getFeatureByIndex(index: number): Promise<ProjectFeature | null> {
    const data = await this.loadFeatures();
    if (!data || index < 0 || index >= data.features.length) {
      return null;
    }
    return data.features[index] ?? null;
  }

  async updateFeatureStatus(
    index: number,
    updates: Partial<ProjectFeature>,
  ): Promise<boolean> {
    const data = await this.loadFeatures();
    if (!data || index < 0 || index >= data.features.length) {
      return false;
    }

    data.features[index] = { ...data.features[index], ...updates };
    await this.saveFeatures(data);
    return true;
  }

  async getStatistics(): Promise<ProjectStatistics> {
    const data = await this.loadFeatures();
    if (!data) {
      return { total: 0, completed: 0, pending: 0, skipped: 0, percentage: 0 };
    }
    return calculateStatistics(data.features);
  }

  async listFeatures(): Promise<ProjectFeature[]> {
    const data = await this.loadFeatures();
    return data?.features ?? [];
  }

  getPaths(): {
    features: string;
    progress: string;
    projectArtifactsRoot: string;
    projectState: string;
    projectControl: string;
    projectBrief: string;
    alignment: string;
    changeRequests: string;
    sessionPlan: string;
    legacySessionPlan: string;
    brainstormIndex: string;
    legacyBrainstormIndex: string;
    brainstormProjects: string;
    legacyBrainstormProjects: string;
    managedTasksRoot: string;
    managedTaskState: string;
    lightweightRunRecord: string;
    harnessRoot: string;
    harnessConfig: string;
    harnessRuns: string;
    harnessCritic: string;
    harnessCalibration: string;
    harnessPivots: string;
    harnessCheckpoints: string;
    harnessSessionTree: string;
    lineageCheckpoints: string;
    lineageSessionTree: string;
    harnessEvidence: string;
  } {
    return {
      features: this.featuresPath,
      progress: this.progressPath,
      projectArtifactsRoot: this.projectArtifactsRoot,
      projectState: this.projectStatePath,
      projectControl: this.projectControlStatePath,
      projectBrief: this.projectBriefPath,
      alignment: this.alignmentPath,
      changeRequests: this.changeRequestsPath,
      sessionPlan: this.sessionPlanPath,
      legacySessionPlan: this.legacySessionPlanPath,
      brainstormIndex: this.brainstormIndexPath,
      legacyBrainstormIndex: this.legacyBrainstormIndexPath,
      brainstormProjects: this.brainstormProjectsPath,
      legacyBrainstormProjects: this.legacyBrainstormProjectsPath,
      managedTasksRoot: this.managedTasksRootPath,
      managedTaskState: this.managedTaskStatePath,
      lightweightRunRecord: this.lightweightRunRecordPath,
      harnessRoot: this.harnessRootPath,
      harnessConfig: this.harnessConfigPath,
      harnessRuns: this.harnessRunsPath,
      harnessCritic: this.harnessCriticPath,
      harnessCalibration: this.harnessCalibrationPath,
      harnessPivots: this.harnessPivotsPath,
      harnessCheckpoints: this.harnessCheckpointsPath,
      harnessSessionTree: this.harnessSessionTreePath,
      lineageCheckpoints: this.harnessCheckpointsPath,
      lineageSessionTree: this.harnessSessionTreePath,
      harnessEvidence: this.harnessEvidencePath,
    };
  }

  async readHarnessConfig<T = unknown>(): Promise<T | null> {
    return this.readJsonFile<T>(this.harnessConfigPath);
  }

  async writeHarnessConfig(config: unknown): Promise<void> {
    await fs.mkdir(this.harnessRootPath, { recursive: true });
    await fs.writeFile(this.harnessConfigPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  async appendHarnessRun(record: unknown): Promise<void> {
    await fs.mkdir(this.harnessRootPath, { recursive: true });
    await fs.appendFile(this.harnessRunsPath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  async appendHarnessCritic(record: unknown): Promise<void> {
    await fs.mkdir(this.harnessRootPath, { recursive: true });
    await fs.appendFile(this.harnessCriticPath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  async appendHarnessCalibrationCase(record: unknown): Promise<void> {
    await fs.mkdir(this.harnessRootPath, { recursive: true });
    await fs.appendFile(this.harnessCalibrationPath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  async appendHarnessPivot(record: unknown): Promise<void> {
    await fs.mkdir(this.harnessRootPath, { recursive: true });
    await fs.appendFile(this.harnessPivotsPath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  async appendLineageCheckpoint(record: unknown): Promise<void> {
    await fs.mkdir(path.dirname(this.harnessCheckpointsPath), { recursive: true });
    await fs.appendFile(this.harnessCheckpointsPath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  async appendLineageSessionNode(record: unknown): Promise<void> {
    await fs.mkdir(path.dirname(this.harnessSessionTreePath), { recursive: true });
    await fs.appendFile(this.harnessSessionTreePath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  async appendHarnessCheckpoint(record: unknown): Promise<void> {
    await this.appendLineageCheckpoint(record);
  }

  async appendHarnessSessionNode(record: unknown): Promise<void> {
    await this.appendLineageSessionNode(record);
  }

  async readHarnessRuns<T = unknown>(): Promise<T[]> {
    return this.readJsonLinesFile<T>(this.harnessRunsPath, 'harness run');
  }

  async readHarnessCritics<T = unknown>(): Promise<T[]> {
    return this.readJsonLinesFile<T>(this.harnessCriticPath, 'harness critic');
  }

  async readHarnessCalibrationCases<T = unknown>(): Promise<T[]> {
    return this.readJsonLinesFile<T>(this.harnessCalibrationPath, 'harness calibration');
  }

  async readHarnessPivots<T = unknown>(): Promise<T[]> {
    return this.readJsonLinesFile<T>(this.harnessPivotsPath, 'harness pivot');
  }

  async readLineageCheckpoints<T = unknown>(): Promise<T[]> {
    return this.readJsonLinesFile<T>(this.harnessCheckpointsPath, 'lineage checkpoint');
  }

  async readLineageSessionNodes<T = unknown>(): Promise<T[]> {
    return this.readJsonLinesFile<T>(this.harnessSessionTreePath, 'lineage session-tree');
  }

  async readHarnessCheckpoints<T = unknown>(): Promise<T[]> {
    return this.readLineageCheckpoints<T>();
  }

  async readHarnessSessionNodes<T = unknown>(): Promise<T[]> {
    return this.readLineageSessionNodes<T>();
  }

  async writeHarnessEvidence(featureIndex: number, record: unknown): Promise<void> {
    await fs.mkdir(this.harnessEvidencePath, { recursive: true });
    await fs.writeFile(
      this.getHarnessEvidenceFilePath(featureIndex),
      JSON.stringify(record, null, 2),
      'utf-8',
    );
  }

  async readHarnessEvidence<T = unknown>(featureIndex: number): Promise<T | null> {
    return this.readJsonFile<T>(this.getHarnessEvidenceFilePath(featureIndex));
  }

  async clearProgress(): Promise<void> {
    await fs.writeFile(this.progressPath, '', 'utf-8');
  }

  async deleteProjectManagementFiles(): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;

    const unlinkIfExists = async (filePath: string): Promise<void> => {
      try {
        await fs.unlink(filePath);
        deleted++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          failed++;
        }
      }
    };

    const removeDirIfExists = async (dirPath: string): Promise<void> => {
      try {
        await fs.rm(dirPath, { recursive: true, force: false });
        deleted++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        failed++;
      }
    };

    await unlinkIfExists(this.featuresPath);
    await unlinkIfExists(this.progressPath);
    await unlinkIfExists(this.legacySessionPlanPath);
    await unlinkIfExists(this.legacyBrainstormIndexPath);

    await removeDirIfExists(this.projectArtifactsRoot);
    await removeDirIfExists(this.legacyBrainstormProjectsPath);

    return { deleted, failed };
  }
}
