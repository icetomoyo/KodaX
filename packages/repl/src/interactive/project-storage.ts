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
} from '@kodax/coding';
import {
  ProjectFeature,
  FeatureList,
  ProjectStatistics,
  calculateStatistics,
  getNextPendingIndex,
} from './project-state.js';
import type { BrainstormSession } from './project-brainstorm.js';

export class ProjectStorage {
  private projectDir: string;
  private featuresPath: string;
  private progressPath: string;
  private projectArtifactsRoot: string;
  private sessionPlanPath: string;
  private legacySessionPlanPath: string;
  private brainstormIndexPath: string;
  private legacyBrainstormIndexPath: string;
  private brainstormProjectsPath: string;
  private legacyBrainstormProjectsPath: string;
  private harnessRootPath: string;
  private harnessConfigPath: string;
  private harnessRunsPath: string;
  private harnessCriticPath: string;
  private harnessCheckpointsPath: string;
  private harnessSessionTreePath: string;
  private harnessEvidencePath: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.featuresPath = path.join(projectDir, KODAX_FEATURES_FILE);
    this.progressPath = path.join(projectDir, KODAX_PROGRESS_FILE);
    this.projectArtifactsRoot = path.join(projectDir, '.agent', 'project');
    this.sessionPlanPath = path.join(this.projectArtifactsRoot, 'session_plan.md');
    this.legacySessionPlanPath = path.join(projectDir, '.kodax', 'session_plan.md');
    this.brainstormIndexPath = path.join(this.projectArtifactsRoot, 'brainstorm-active.json');
    this.legacyBrainstormIndexPath = path.join(projectDir, '.kodax', 'brainstorm-active.json');
    this.brainstormProjectsPath = path.join(this.projectArtifactsRoot, 'brainstorm');
    this.legacyBrainstormProjectsPath = path.join(projectDir, '.kodax', 'projects');
    this.harnessRootPath = path.join(this.projectArtifactsRoot, 'harness');
    this.harnessConfigPath = path.join(this.harnessRootPath, 'config.generated.json');
    this.harnessRunsPath = path.join(this.harnessRootPath, 'runs.jsonl');
    this.harnessCriticPath = path.join(this.harnessRootPath, 'critic.jsonl');
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

  private warnMalformedJsonl(filePath: string, label: string, count: number): void {
    if (count === 0 || process.env.NODE_ENV === 'test') {
      return;
    }

    const fileName = path.basename(filePath);
    console.warn(`[KodaX] Skipped ${count} malformed ${label} record(s) from ${fileName}.`);
  }

  private async readJsonLinesFile<T>(filePath: string, label: string): Promise<T[]> {
    const content = await this.readTextFileWithFallback(filePath);
    if (!content.trim()) {
      return [];
    }

    const records: T[] = [];
    let malformedCount = 0;
    for (const line of content.split('\n').map(item => item.trim()).filter(Boolean)) {
      try {
        records.push(JSON.parse(line) as T);
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

  private async readJsonFile<T>(filePath: string): Promise<T | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      console.error(`[KodaX] Failed to load ${filePath}:`, error);
      return null;
    }
  }

  private async readJsonFileWithFallback<T>(...paths: string[]): Promise<T | null> {
    for (const candidate of paths) {
      const data = await this.readJsonFile<T>(candidate);
      if (data) {
        return data;
      }
    }

    return null;
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.featuresPath);
      return true;
    } catch {
      return false;
    }
  }

  async loadFeatures(): Promise<FeatureList | null> {
    try {
      const content = await fs.readFile(this.featuresPath, 'utf-8');
      return JSON.parse(content) as FeatureList;
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
      this.getBrainstormSessionPath(sessionId),
      this.getBrainstormSessionPath(sessionId, true),
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
      this.brainstormIndexPath,
      this.legacyBrainstormIndexPath,
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
    sessionPlan: string;
    legacySessionPlan: string;
    brainstormIndex: string;
    legacyBrainstormIndex: string;
    brainstormProjects: string;
    legacyBrainstormProjects: string;
    harnessRoot: string;
    harnessConfig: string;
    harnessRuns: string;
    harnessCritic: string;
    harnessCheckpoints: string;
    harnessSessionTree: string;
    harnessEvidence: string;
  } {
    return {
      features: this.featuresPath,
      progress: this.progressPath,
      projectArtifactsRoot: this.projectArtifactsRoot,
      sessionPlan: this.sessionPlanPath,
      legacySessionPlan: this.legacySessionPlanPath,
      brainstormIndex: this.brainstormIndexPath,
      legacyBrainstormIndex: this.legacyBrainstormIndexPath,
      brainstormProjects: this.brainstormProjectsPath,
      legacyBrainstormProjects: this.legacyBrainstormProjectsPath,
      harnessRoot: this.harnessRootPath,
      harnessConfig: this.harnessConfigPath,
      harnessRuns: this.harnessRunsPath,
      harnessCritic: this.harnessCriticPath,
      harnessCheckpoints: this.harnessCheckpointsPath,
      harnessSessionTree: this.harnessSessionTreePath,
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

  async appendHarnessCheckpoint(record: unknown): Promise<void> {
    await fs.mkdir(path.dirname(this.harnessCheckpointsPath), { recursive: true });
    await fs.appendFile(this.harnessCheckpointsPath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  async appendHarnessSessionNode(record: unknown): Promise<void> {
    await fs.mkdir(path.dirname(this.harnessSessionTreePath), { recursive: true });
    await fs.appendFile(this.harnessSessionTreePath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  async readHarnessRuns<T = unknown>(): Promise<T[]> {
    return this.readJsonLinesFile<T>(this.harnessRunsPath, 'harness run');
  }

  async readHarnessCritics<T = unknown>(): Promise<T[]> {
    return this.readJsonLinesFile<T>(this.harnessCriticPath, 'harness critic');
  }

  async readHarnessCheckpoints<T = unknown>(): Promise<T[]> {
    return this.readJsonLinesFile<T>(this.harnessCheckpointsPath, 'harness checkpoint');
  }

  async readHarnessSessionNodes<T = unknown>(): Promise<T[]> {
    return this.readJsonLinesFile<T>(this.harnessSessionTreePath, 'harness session-tree');
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
