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

export type ProjectWorkflowStage =
  | 'bootstrap'
  | 'discovering'
  | 'aligned'
  | 'planned'
  | 'executing'
  | 'blocked'
  | 'completed';

export type ProjectWorkflowScope = 'project' | 'change_request';

export interface ProjectWorkflowState {
  stage: ProjectWorkflowStage;
  scope: ProjectWorkflowScope;
  activeRequestId?: string;
  unresolvedQuestionCount: number;
  currentFeatureIndex?: number;
  lastPlannedAt?: string;
  latestExecutionSummary?: string;
  lastUpdated: string;
  discoveryStepIndex: number;
}

export interface ProjectBrief {
  originalPrompt: string;
  goals: string[];
  constraints: string[];
  nonGoals: string[];
  updatedAt: string;
}

export interface ProjectAlignment {
  sourcePrompt: string;
  confirmedRequirements: string[];
  constraints: string[];
  nonGoals: string[];
  acceptedTradeoffs: string[];
  successCriteria: string[];
  openQuestions: string[];
  updatedAt: string;
}

export const DEFAULT_DISCOVERY_OPEN_QUESTIONS = [
  'What outcome matters most for the first usable version?',
  'What constraint or boundary must the implementation respect?',
  'What should stay out of scope for this iteration?',
  'How will we know the first version is successful?',
] as const;

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

function parseBulletSection(markdown: string, heading: string): string[] {
  const pattern = new RegExp(`## ${heading}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`);
  const match = markdown.match(pattern);
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map(line => line.replace(/^[-*]\s+|^\d+\.\s+/, '').trim())
    .filter(Boolean);
}

function parseSingleValue(markdown: string, heading: string): string {
  const pattern = new RegExp(`## ${heading}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`);
  const match = markdown.match(pattern);
  return match?.[1]?.trim() ?? '';
}

export function createProjectWorkflowState(
  stage: ProjectWorkflowStage,
  timestamp = new Date().toISOString(),
  scope: ProjectWorkflowScope = 'project',
): ProjectWorkflowState {
  return {
    stage,
    scope,
    unresolvedQuestionCount: stage === 'aligned' || stage === 'planned' || stage === 'executing' || stage === 'completed'
      ? 0
      : DEFAULT_DISCOVERY_OPEN_QUESTIONS.length,
    lastUpdated: timestamp,
    discoveryStepIndex: 0,
  };
}

export function createProjectBrief(
  prompt: string,
  timestamp = new Date().toISOString(),
): ProjectBrief {
  const normalized = prompt.trim();
  return {
    originalPrompt: normalized,
    goals: [normalized],
    constraints: [],
    nonGoals: [],
    updatedAt: timestamp,
  };
}

export function formatProjectBriefMarkdown(brief: ProjectBrief): string {
  return [
    '# Project Brief',
    '',
    `Updated: ${brief.updatedAt}`,
    '',
    '## Original Prompt',
    brief.originalPrompt,
    '',
    '## Goals',
    ...(brief.goals.length > 0 ? brief.goals.map(goal => `- ${goal}`) : ['- (not set)']),
    '',
    '## Constraints',
    ...(brief.constraints.length > 0 ? brief.constraints.map(item => `- ${item}`) : ['- (none yet)']),
    '',
    '## Non-goals',
    ...(brief.nonGoals.length > 0 ? brief.nonGoals.map(item => `- ${item}`) : ['- (none yet)']),
  ].join('\n');
}

export function parseProjectBriefMarkdown(markdown: string): ProjectBrief {
  return {
    originalPrompt: parseSingleValue(markdown, 'Original Prompt'),
    goals: parseBulletSection(markdown, 'Goals'),
    constraints: parseBulletSection(markdown, 'Constraints'),
    nonGoals: parseBulletSection(markdown, 'Non-goals'),
    updatedAt: markdown.match(/Updated:\s*(.+)/)?.[1]?.trim() ?? new Date().toISOString(),
  };
}

export function createProjectAlignment(
  prompt: string,
  timestamp = new Date().toISOString(),
): ProjectAlignment {
  return {
    sourcePrompt: prompt.trim(),
    confirmedRequirements: [],
    constraints: [],
    nonGoals: [],
    acceptedTradeoffs: [],
    successCriteria: [],
    openQuestions: [...DEFAULT_DISCOVERY_OPEN_QUESTIONS],
    updatedAt: timestamp,
  };
}

export function formatProjectAlignmentMarkdown(alignment: ProjectAlignment): string {
  return [
    '# Project Alignment',
    '',
    `Updated: ${alignment.updatedAt}`,
    '',
    '## Source Prompt',
    alignment.sourcePrompt,
    '',
    '## Confirmed Requirements',
    ...(alignment.confirmedRequirements.length > 0
      ? alignment.confirmedRequirements.map(item => `- ${item}`)
      : ['- (none confirmed yet)']),
    '',
    '## Constraints',
    ...(alignment.constraints.length > 0
      ? alignment.constraints.map(item => `- ${item}`)
      : ['- (none confirmed yet)']),
    '',
    '## Non-goals',
    ...(alignment.nonGoals.length > 0
      ? alignment.nonGoals.map(item => `- ${item}`)
      : ['- (none confirmed yet)']),
    '',
    '## Accepted Tradeoffs',
    ...(alignment.acceptedTradeoffs.length > 0
      ? alignment.acceptedTradeoffs.map(item => `- ${item}`)
      : ['- (none confirmed yet)']),
    '',
    '## Success Criteria',
    ...(alignment.successCriteria.length > 0
      ? alignment.successCriteria.map(item => `- ${item}`)
      : ['- (none confirmed yet)']),
    '',
    '## Open Questions',
    ...(alignment.openQuestions.length > 0
      ? alignment.openQuestions.map(item => `- ${item}`)
      : ['- (none)']),
  ].join('\n');
}

export function parseProjectAlignmentMarkdown(markdown: string): ProjectAlignment {
  return {
    sourcePrompt: parseSingleValue(markdown, 'Source Prompt'),
    confirmedRequirements: parseBulletSection(markdown, 'Confirmed Requirements').filter(item => item !== '(none confirmed yet)'),
    constraints: parseBulletSection(markdown, 'Constraints').filter(item => item !== '(none confirmed yet)'),
    nonGoals: parseBulletSection(markdown, 'Non-goals').filter(item => item !== '(none confirmed yet)'),
    acceptedTradeoffs: parseBulletSection(markdown, 'Accepted Tradeoffs').filter(item => item !== '(none confirmed yet)'),
    successCriteria: parseBulletSection(markdown, 'Success Criteria').filter(item => item !== '(none confirmed yet)'),
    openQuestions: parseBulletSection(markdown, 'Open Questions').filter(item => item !== '(none)'),
    updatedAt: markdown.match(/Updated:\s*(.+)/)?.[1]?.trim() ?? new Date().toISOString(),
  };
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
