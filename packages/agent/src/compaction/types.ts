/**
 * @kodax/agent Compaction Types
 *
 * 上下文压缩相关类型定义
 */

import type { KodaXMessage } from '@kodax/ai';

/**
 * 压缩配置
 */
export interface CompactionConfig {
  /** 是否启用自动压缩 */
  enabled: boolean;
  /** 触发压缩的阈值百分比 (0-100)，例如 75 表示使用 75% 上下文时触发 */
  triggerPercent: number;
  /**
   * @deprecated V2 渐进式滚动压缩不再需要该配置项
   *
   * 系统将自动执行静默修剪与滚动摘要，智能控制保留范围
   */
  keepRecentPercent?: number;

  /** V2: 绝对保护区百分比 (默认 20)。该比例内的最新消息绝对不被压缩或修剪 */
  protectionPercent?: number;
  /** V2: 滚动摘要提取百分比 (默认 10)。每次强制压缩时提取的最老消息比例 */
  rollingSummaryPercent?: number;
  /** V2: 静默修剪的 Token 阈值估算 (默认 500)。超过此长度的工具输出才会被修剪 */
  pruningThresholdTokens?: number;

  /** (可选) 覆盖 Provider 的 contextWindow */
  contextWindow?: number;
}

/**
 * 压缩详情
 *
 * 记录压缩过程中追踪的文件操作
 */
export interface CompactionDetails {
  /** 读取过的文件路径列表 */
  readFiles: string[];
  /** 修改过的文件路径列表 */
  modifiedFiles: string[];
}

/**
 * 压缩结果
 */
export interface CompactionResult {
  /** 是否执行了压缩 */
  compacted: boolean;
  /** 压缩后的消息列表 */
  messages: KodaXMessage[];
  /** 生成的摘要文本（如果执行了压缩） */
  summary?: string;
  /** 压缩前的 token 数 */
  tokensBefore: number;
  /** 压缩后的 token 数 */
  tokensAfter: number;
  /** 移除的消息数量 */
  entriesRemoved: number;
  /** 压缩详情（如果执行了压缩） */
  details?: CompactionDetails;
}

/**
 * 文件操作记录
 *
 * 从消息中提取的文件操作集合
 */
export interface FileOperations {
  /** 读取过的文件路径列表 */
  readFiles: string[];
  /** 修改过的文件路径列表 */
  modifiedFiles: string[];
}
