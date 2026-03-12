/**
 * @kodax/coding Compaction Config
 *
 * 压缩配置加载 - 仅从用户级配置文件加载
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { CompactionConfig } from '@kodax/agent';

/**
 * 默认压缩配置
 */
const DEFAULT_CONFIG: CompactionConfig = {
  enabled: true,
  triggerPercent: 75,     // 使用 75% 上下文时触发压缩
};

/**
 * 加载压缩配置
 *
 * 仅从用户级 ~/.kodax/config.json 加载
 *
 * @param _projectRoot - 项目根目录（已废弃，不再使用）
 * @returns 合并后的配置
 */
export async function loadCompactionConfig(
  _projectRoot?: string
): Promise<CompactionConfig> {
  const userConfigPath = join(homedir(), '.kodax', 'config.json');
  try {
    const userConfig = await readConfigFile(userConfigPath);
    if (userConfig?.compaction) {
      return { ...DEFAULT_CONFIG, ...userConfig.compaction as Partial<CompactionConfig> };
    }
  } catch {
    // 忽略错误，使用默认值
  }

  return DEFAULT_CONFIG;
}

/**
 * 读取配置文件
 *
 * @param path - 配置文件路径
 * @returns 配置对象（如果文件不存在或解析失败则返回 null）
 */
async function readConfigFile(
  path: string
): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}
