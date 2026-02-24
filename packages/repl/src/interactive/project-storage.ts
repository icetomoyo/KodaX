/**
 * KodaX 项目存储管理
 *
 * 管理 feature_list.json、PROGRESS.md 和会话计划文件
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import {
  KODAX_FEATURES_FILE,
  KODAX_PROGRESS_FILE,
} from '@kodax/core';
import {
  ProjectFeature,
  FeatureList,
  ProjectStatistics,
  calculateStatistics,
  getNextPendingIndex,
} from './project-state.js';

/**
 * 项目存储管理类
 *
 * 封装对项目文件的读写操作
 */
export class ProjectStorage {
  private projectDir: string;
  private featuresPath: string;
  private progressPath: string;
  private sessionPlanPath: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    this.featuresPath = path.join(projectDir, KODAX_FEATURES_FILE);
    this.progressPath = path.join(projectDir, KODAX_PROGRESS_FILE);
    this.sessionPlanPath = path.join(projectDir, '.kodax', 'session_plan.md');
  }

  /**
   * 检查项目是否存在
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.featuresPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 加载功能列表
   */
  async loadFeatures(): Promise<FeatureList | null> {
    try {
      const content = await fs.readFile(this.featuresPath, 'utf-8');
      const data = JSON.parse(content);
      return data as FeatureList;
    } catch (error) {
      // 文件不存在是正常情况（项目未初始化）
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      // 其他错误（权限、格式等）应该记录日志
      console.error(`[KodaX] Failed to load ${this.featuresPath}:`, error);
      return null;
    }
  }

  /**
   * 保存功能列表
   */
  async saveFeatures(data: FeatureList): Promise<void> {
    await fs.writeFile(
      this.featuresPath,
      JSON.stringify(data, null, 2),
      'utf-8'
    );
  }

  /**
   * 读取进度文件
   */
  async readProgress(): Promise<string> {
    try {
      return await fs.readFile(this.progressPath, 'utf-8');
    } catch (error) {
      // 文件不存在是正常情况
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      // 其他错误应该记录日志
      console.error(`[KodaX] Failed to read ${this.progressPath}:`, error);
      return '';
    }
  }

  /**
   * 追加到进度文件
   */
  async appendProgress(content: string): Promise<void> {
    const existing = await this.readProgress();
    const newContent = existing ? existing + '\n' + content : content;
    await fs.writeFile(this.progressPath, newContent, 'utf-8');
  }

  /**
   * 读取会话计划
   */
  async readSessionPlan(): Promise<string> {
    try {
      return await fs.readFile(this.sessionPlanPath, 'utf-8');
    } catch (error) {
      // 文件不存在是正常情况
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      // 其他错误应该记录日志
      console.error(`[KodaX] Failed to read ${this.sessionPlanPath}:`, error);
      return '';
    }
  }

  /**
   * 写入会话计划
   */
  async writeSessionPlan(content: string): Promise<void> {
    // 确保 .kodax 目录存在
    const kodaxDir = path.dirname(this.sessionPlanPath);
    await fs.mkdir(kodaxDir, { recursive: true });
    await fs.writeFile(this.sessionPlanPath, content, 'utf-8');
  }

  /**
   * 获取下一个待完成功能
   */
  async getNextPendingFeature(): Promise<{ feature: ProjectFeature; index: number } | null> {
    const data = await this.loadFeatures();
    if (!data || !data.features.length) return null;

    const index = getNextPendingIndex(data.features);
    if (index === -1) return null;

    return { feature: data.features[index]!, index };
  }

  /**
   * 获取指定索引的功能
   */
  async getFeatureByIndex(index: number): Promise<ProjectFeature | null> {
    const data = await this.loadFeatures();
    if (!data || index < 0 || index >= data.features.length) return null;
    return data.features[index] ?? null;
  }

  /**
   * 更新功能状态
   */
  async updateFeatureStatus(
    index: number,
    updates: Partial<ProjectFeature>
  ): Promise<boolean> {
    const data = await this.loadFeatures();
    if (!data || index < 0 || index >= data.features.length) return false;

    data.features[index] = { ...data.features[index], ...updates };
    await this.saveFeatures(data);
    return true;
  }

  /**
   * 获取项目统计信息
   */
  async getStatistics(): Promise<ProjectStatistics> {
    const data = await this.loadFeatures();
    if (!data) {
      return { total: 0, completed: 0, pending: 0, skipped: 0, percentage: 0 };
    }
    return calculateStatistics(data.features);
  }

  /**
   * 获取所有功能列表
   */
  async listFeatures(): Promise<ProjectFeature[]> {
    const data = await this.loadFeatures();
    return data?.features ?? [];
  }

  /**
   * 获取功能路径信息
   */
  getPaths(): {
    features: string;
    progress: string;
    sessionPlan: string;
  } {
    return {
      features: this.featuresPath,
      progress: this.progressPath,
      sessionPlan: this.sessionPlanPath,
    };
  }
}
