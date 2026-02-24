/**
 * KodaX Tool Types
 *
 * 工具类型定义
 */

import { KodaXToolExecutionContext } from '../types.js';

export type ToolHandler = (
  input: Record<string, unknown>,
  context: KodaXToolExecutionContext
) => Promise<string>;

export type ToolRegistry = Map<string, ToolHandler>;
