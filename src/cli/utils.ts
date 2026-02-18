/**
 * KodaX CLI Utilities
 *
 * CLI 层工具函数
 */

import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getProvider, KODAX_PROVIDERS } from '../core/index.js';

const execAsync = promisify(exec);

// CLI 配置目录
export const KODAX_DIR = path.join(os.homedir(), '.kodax');
export const KODAX_SESSIONS_DIR = path.join(KODAX_DIR, 'sessions');
export const KODAX_CONFIG_FILE = path.join(KODAX_DIR, 'config.json');

// 动态读取版本号
export function getVersion(): string {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  if (fsSync.existsSync(packageJsonPath)) {
    try {
      return JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8')).version ?? '0.0.0';
    } catch { }
  }
  return '0.0.0';
}

// 导出 KODAX_VERSION 供兼容性使用
export const KODAX_VERSION = getVersion();

// 获取 Provider 模型名称
export function getProviderModel(name: string): string | null {
  try {
    const provider = getProvider(name);
    return provider.getModel();
  } catch {
    return null;
  }
}

// 获取 Provider 列表
export function getProviderList(): Array<{ name: string; model: string; configured: boolean }> {
  const result: Array<{ name: string; model: string; configured: boolean }> = [];
  for (const [name, factory] of Object.entries(KODAX_PROVIDERS)) {
    try {
      const p = factory();
      result.push({ name, model: p.getModel(), configured: p.isConfigured() });
    } catch {
      result.push({ name, model: 'unknown', configured: false });
    }
  }
  return result;
}

// 检查 Provider 是否已配置
export function isProviderConfigured(name: string): boolean {
  try {
    const provider = getProvider(name);
    return provider.isConfigured();
  } catch {
    return false;
  }
}

// 加载配置
export function loadConfig(): { provider?: string; thinking?: boolean; auto?: boolean } {
  try {
    if (fsSync.existsSync(KODAX_CONFIG_FILE)) {
      return JSON.parse(fsSync.readFileSync(KODAX_CONFIG_FILE, 'utf-8'));
    }
  } catch { }
  return {};
}

// 保存配置
export function saveConfig(config: { provider?: string; thinking?: boolean; auto?: boolean }): void {
  const current = loadConfig();
  const merged = { ...current, ...config };
  fsSync.mkdirSync(path.dirname(KODAX_CONFIG_FILE), { recursive: true });
  fsSync.writeFileSync(KODAX_CONFIG_FILE, JSON.stringify(merged, null, 2));
}

// 获取 Git 根目录
export async function getGitRoot(): Promise<string | null> {
  try { const { stdout } = await execAsync('git rev-parse --show-toplevel'); return stdout.trim(); } catch { return null; }
}

// 获取功能进度
export function getFeatureProgress(): [number, number] {
  const featuresPath = path.resolve('feature_list.json');
  if (!fsSync.existsSync(featuresPath)) return [0, 0];
  try {
    const features = JSON.parse(fsSync.readFileSync(featuresPath, 'utf-8'));
    const total = (features.features ?? []).length;
    const completed = (features.features ?? []).filter((f: any) => f.passes).length;
    return [completed, total];
  } catch { return [0, 0]; }
}

// 检查所有功能是否完成
export function checkAllFeaturesComplete(): boolean {
  const featuresPath = path.resolve('feature_list.json');
  if (!fsSync.existsSync(featuresPath)) return false;
  try {
    const features = JSON.parse(fsSync.readFileSync(featuresPath, 'utf-8'));
    for (const f of features.features ?? []) {
      if (!f.passes) return false;
    }
    return true;
  } catch { return false; }
}

// API 速率限制
const KODAX_API_MIN_INTERVAL = 0.5;
let lastApiCallTime = 0;
const apiLock = { locked: false, queue: [] as (() => void)[] };

export async function rateLimitedCall<T>(fn: () => Promise<T>): Promise<T> {
  while (apiLock.locked) {
    await new Promise<void>(resolve => apiLock.queue.push(resolve));
  }
  apiLock.locked = true;
  try {
    const elapsed = (Date.now() - lastApiCallTime) / 1000;
    if (elapsed < KODAX_API_MIN_INTERVAL) {
      await new Promise(r => setTimeout(r, (KODAX_API_MIN_INTERVAL - elapsed) * 1000));
    }
    const result = await fn();
    lastApiCallTime = Date.now();
    return result;
  } finally {
    apiLock.locked = false;
    const next = apiLock.queue.shift();
    if (next) next();
  }
}
