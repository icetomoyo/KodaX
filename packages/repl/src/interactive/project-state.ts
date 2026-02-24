/**
 * KodaX 项目状态类型定义
 *
 * 定义交互式项目模式的状态和类型
 */

/**
 * 扩展的 Feature 类型
 *
 * 在 CLI 的 Feature 基础上添加更多元数据
 */
export interface ProjectFeature {
  /** 功能名称（可选） */
  name?: string;
  /** 功能描述 */
  description?: string;
  /** 实现步骤 */
  steps?: string[];
  /** 是否通过测试 */
  passes?: boolean;
  /** 是否跳过 */
  skipped?: boolean;
  /** 开始时间 (ISO string) */
  startedAt?: string;
  /** 完成时间 (ISO string) */
  completedAt?: string;
  /** 备注 */
  notes?: string;
  /** 允许其他字段 */
  [key: string]: unknown;
}

/**
 * 功能列表文件结构
 */
export interface FeatureList {
  features: ProjectFeature[];
}

/**
 * 项目状态
 */
export interface ProjectState {
  /** 任务描述 */
  taskId: string;
  /** 初始化时间 (ISO string) */
  initializedAt: string;
  /** 最后更新时间 (ISO string) */
  lastUpdated: string;

  /** 总功能数 */
  totalFeatures: number;
  /** 已完成功能数 */
  completedFeatures: number;
  /** 待完成功能数 */
  pendingFeatures: number;
  /** 已跳过功能数 */
  skippedFeatures: number;

  /** 当前执行的功能索引 */
  currentFeatureIndex?: number;
  /** 下一个待完成功能索引 */
  nextFeatureIndex?: number;

  /** 是否在自动继续模式 */
  autoContinue: boolean;
  /** 自动继续开始时间 */
  autoContinueStartedAt?: string;
  /** 自动继续最大执行次数 */
  autoContinueMaxRuns?: number;
  /** 自动继续当前执行次数 */
  autoContinueCurrentRun?: number;
}

/**
 * 项目会话记录
 */
export interface ProjectSession {
  /** 会话 ID */
  sessionId: string;
  /** 功能索引 */
  featureIndex: number;
  /** 功能信息 */
  feature: ProjectFeature;
  /** 会话状态 */
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'skipped';
  /** 开始时间 */
  startTime: string;
  /** 结束时间 */
  endTime?: string;
  /** 备注 */
  notes?: string;
}

/**
 * 项目统计信息
 */
export interface ProjectStatistics {
  /** 总功能数 */
  total: number;
  /** 已完成数 */
  completed: number;
  /** 待完成数 */
  pending: number;
  /** 已跳过数 */
  skipped: number;
  /** 完成百分比 */
  percentage: number;
}

/**
 * 计算项目统计信息
 */
export function calculateStatistics(features: ProjectFeature[]): ProjectStatistics {
  const total = features.length;
  const completed = features.filter(f => f.passes === true).length;
  const skipped = features.filter(f => f.skipped === true).length;
  const pending = total - completed - skipped;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { total, completed, pending, skipped, percentage };
}

/**
 * 获取下一个待完成功能索引
 */
export function getNextPendingIndex(features: ProjectFeature[]): number {
  return features.findIndex(f => f.passes !== true && f.skipped !== true);
}

/**
 * 检查所有功能是否完成
 */
export function isAllCompleted(features: ProjectFeature[]): boolean {
  return features.every(f => f.passes === true || f.skipped === true);
}
