/**
 * KodaX CLI Utilities
 * CLI 层工具函数
 */

import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import {
  getProviderConfiguredCapabilityProfile,
  getProviderConfiguredReasoningCapability,
  getProviderList as getBuiltInProviderList,
  getProviderModel as getBuiltInProviderModel,
  getProviderModels,
  getCustomProviderList,
  getCustomProvider,
  isProviderConfigured as isBuiltInProviderConfigured,
  type KodaXProviderCapabilityProfile,
  type KodaXReasoningCapability,
  type KodaXReasoningMode,
  type KodaXReasoningOverride,
  type KodaXCustomProviderConfig,
} from '@kodax/coding';

const execAsync = promisify(exec);

// CLI config directory
export const KODAX_DIR = path.join(os.homedir(), '.kodax');
export const KODAX_SESSIONS_DIR = path.join(KODAX_DIR, 'sessions');
export const KODAX_CONFIG_FILE = path.join(KODAX_DIR, 'config.json');

// UI display constants
export const PREVIEW_MAX_LENGTH = 60;

// Read version from package.json dynamically - 动态读取版本号
// Uses import.meta.url for path resolution, works regardless of cwd
// 使用 import.meta.url 获取路径，无论用户在哪个目录运行都能正确读取
export function getVersion(): string {
  const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
  if (fsSync.existsSync(packageJsonPath)) {
    try {
      return JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8')).version ?? '0.0.0';
    } catch { }
  }
  return '0.0.0';
}

// Export for backwards compatibility
export const KODAX_VERSION = getVersion();

// Get provider model name (snapshot-based, no API key needed)
export function getProviderModel(name: string): string | null {
  return getBuiltInProviderModel(name);
}

/**
 * Merge user-configured models with built-in provider models.
 * Config entries come first (preserving user order), then built-in models
 * not already present in the config list are appended (deduplicated, case-insensitive).
 */
function mergeModels(configModels: string[], builtInModels: string[]): string[] {
  const configSet = new Set(configModels.map(m => m.toLowerCase()));
  const merged = [...configModels];
  for (const m of builtInModels) {
    if (!configSet.has(m.toLowerCase())) {
      merged.push(m);
    }
  }
  return merged;
}

// Get available models for a provider (respects config-level providerModels, merged with built-in)
// Uses getProviderModels (snapshot-based, no API key required) for built-in providers,
// falls back to getProvider() instantiation for custom providers.
export function getProviderAvailableModels(name: string, providerModelsConfig?: Record<string, string[]>): string[] {
  if (!providerModelsConfig) {
    providerModelsConfig = loadConfig().providerModels;
  }
  const configModels = providerModelsConfig?.[name];
  if (configModels && configModels.length > 0) {
    // Merge config list with built-in models to avoid accidentally dropping models
    try {
      const builtInModels = getProviderModels(name);
      if (builtInModels.length > 0) return mergeModels(configModels, builtInModels);
    } catch { /* fall through */ }
    try {
      const custom = getCustomProvider(name);
      if (custom) return mergeModels(configModels, custom.getAvailableModels());
    } catch { /* ignore */ }
    return configModels;
  }
  // No config override — use built-in models from snapshot
  try {
    const builtInModels = getProviderModels(name);
    if (builtInModels.length > 0) return builtInModels;
  } catch { /* fall through */ }
  // Check custom providers
  try {
    const custom = getCustomProvider(name);
    if (custom) return custom.getAvailableModels();
  } catch { /* ignore */ }
  return [];
}

export function getProviderReasoningCapability(
  name: string,
): KodaXReasoningCapability | 'unknown' {
  // Try built-in provider snapshot first (no API key needed)
  const capability = getProviderConfiguredReasoningCapability(name);
  if (capability !== 'unknown') return capability;
  // Fallback: check custom providers
  try {
    const custom = getCustomProvider(name);
    if (custom) return custom.getReasoningCapability();
  } catch { /* ignore */ }
  return 'unknown';
}

export function getProviderCapabilityProfile(
  name: string,
): KodaXProviderCapabilityProfile | null {
  const builtInProfile = getProviderConfiguredCapabilityProfile(name);
  if (builtInProfile) {
    return builtInProfile;
  }

  try {
    const custom = getCustomProviderList().find((provider) => provider.name === name);
    return custom?.capabilityProfile ?? null;
  } catch {
    return null;
  }
}

export function describeProviderCapabilitySummary(
  profile: KodaXProviderCapabilityProfile,
): string {
  const transport =
    profile.transport === 'cli-bridge' ? 'CLI bridge' : 'Native API';
  const conversation =
    profile.conversationSemantics === 'last-user-message'
      ? 'forwards only the latest user message'
      : 'preserves full conversation history';
  const mcp =
    profile.mcpSupport === 'native' ? 'MCP available' : 'MCP unavailable';

  return `${transport}; ${conversation}; ${mcp}`;
}

export function formatReasoningCapabilityShort(
  capability: KodaXReasoningCapability | 'unknown',
): string {
  switch (capability) {
    case 'native-budget':
      return 'B';
    case 'native-effort':
      return 'E';
    case 'native-toggle':
      return 'T';
    case 'none':
    case 'prompt-only':
    case 'unknown':
    default:
      return '-';
  }
}

export function describeReasoningCapabilityControl(
  capability: KodaXReasoningCapability | 'unknown',
): string {
  switch (capability) {
    case 'native-budget':
      return 'budget';
    case 'native-effort':
      return 'effort';
    case 'native-toggle':
      return 'toggle';
    case 'none':
    case 'prompt-only':
    case 'unknown':
    default:
      return 'none';
  }
}

export function describeReasoningExecution(
  mode: KodaXReasoningMode,
  capability: KodaXReasoningCapability | 'unknown',
): string {
  if (mode === 'off') {
    return 'Reasoning disabled';
  }

  switch (capability) {
    case 'native-budget':
      return 'Uses native thinking budget control';
    case 'native-effort':
      return 'Uses native reasoning effort control';
    case 'native-toggle':
      return 'Uses provider-native thinking toggle only';
    case 'none':
      return 'Runs without native reasoning parameters';
    case 'prompt-only':
      return 'Uses prompt overlays only; no native reasoning parameter';
    case 'unknown':
    default:
      return 'Runs without native reasoning parameters';
  }
}

// Get list of all providers with their status
export function getProviderList(providerModelsConfig?: Record<string, string[]>): Array<{
  name: string;
  model: string;
  models: string[];
  configured: boolean;
  reasoningCapability: string;
  capabilityProfile: KodaXProviderCapabilityProfile;
  custom?: boolean;
}> {
  const result: Array<{
    name: string;
    model: string;
    models: string[];
    configured: boolean;
    reasoningCapability: string;
    capabilityProfile: KodaXProviderCapabilityProfile;
    custom?: boolean;
  }> = [];
  if (!providerModelsConfig) {
    providerModelsConfig = loadConfig().providerModels;
  }
  for (const provider of getBuiltInProviderList()) {
    result.push({
      name: provider.name,
      model: provider.model,
      models: getProviderAvailableModels(provider.name, providerModelsConfig),
      configured: provider.capabilityProfile.transport === 'cli-bridge'
        ? true
        : provider.configured,
      reasoningCapability: provider.reasoningCapability,
      capabilityProfile: provider.capabilityProfile,
    });
  }
  // Append custom providers - 追加自定义 Provider
  try {
    const customList = getCustomProviderList().map((provider) => ({
      ...provider,
      models: (() => {
        const configModels = providerModelsConfig?.[provider.name];
        return configModels && configModels.length > 0
          ? mergeModels(configModels, provider.models)
          : provider.models;
      })(),
    }));
    result.push(...customList);
  } catch {
    // Custom providers not initialized or unavailable
  }
  return result;
}

// Check if provider is configured (supports both built-in and custom)
export function isProviderConfigured(name: string): boolean {
  if (isBuiltInProviderConfigured(name)) return true;
  try {
    const custom = getCustomProvider(name);
    return custom?.isConfigured() ?? false;
  } catch {
    return false;
  }
}

// Load config from ~/.kodax/config.json
export function loadConfig(): {
  provider?: string;
  model?: string;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
  parallel?: boolean;
  permissionMode?: string;
  providerReasoningOverrides?: Record<string, KodaXReasoningOverride>;
  providerModels?: Record<string, string[]>;
  customProviders?: KodaXCustomProviderConfig[];
} {
  try {
    if (fsSync.existsSync(KODAX_CONFIG_FILE)) {
      return JSON.parse(fsSync.readFileSync(KODAX_CONFIG_FILE, 'utf-8'));
    }
  } catch { }
  return {};
}

// Save config to ~/.kodax/config.json
export function saveConfig(config: {
  provider?: string;
  model?: string;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
  parallel?: boolean;
  permissionMode?: string;
  providerReasoningOverrides?: Record<string, KodaXReasoningOverride>;
  providerModels?: Record<string, string[]>;
  customProviders?: KodaXCustomProviderConfig[];
}): void {
  const current = loadConfig();
  const merged = { ...current, ...config };
  // Remove fields explicitly set to undefined (e.g. clearing model when switching provider)
  for (const key of Object.keys(config) as Array<keyof typeof config>) {
    if (config[key] === undefined) {
      delete (merged as Record<string, unknown>)[key];
    }
  }
  fsSync.mkdirSync(path.dirname(KODAX_CONFIG_FILE), { recursive: true });
  fsSync.writeFileSync(KODAX_CONFIG_FILE, JSON.stringify(merged, null, 2));
}

// Get git root directory
export async function getGitRoot(): Promise<string | null> {
  try { const { stdout } = await execAsync('git rev-parse --show-toplevel'); return stdout.trim(); } catch { return null; }
}

// Feature type definition
interface Feature {
  name?: string;
  description?: string;
  steps?: string[];
  passes?: boolean;
  [key: string]: unknown;
}

// Get feature progress from feature_list.json
export function getFeatureProgress(): [number, number] {
  const featuresPath = path.resolve('feature_list.json');
  if (!fsSync.existsSync(featuresPath)) return [0, 0];
  try {
    const features = JSON.parse(fsSync.readFileSync(featuresPath, 'utf-8'));
    const total = (features.features ?? []).length;
    const completed = (features.features ?? []).filter((f: Feature) => f.passes).length;
    return [completed, total];
  } catch { return [0, 0]; }
}

// Check if all features are complete
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

// API rate limiting - API 速率限制
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

// ============== --init prompt builder - 提示词构建 ==============

/**
 * Build initialization prompt for long-running projects
 * 构建初始化长运行项目的提示词
 */
export function buildInitPrompt(task: string, currentDate?: string, currentOS?: string): string {
  const date = currentDate ?? new Date().toISOString().split('T')[0];
  const os = currentOS ?? process.platform;
  return `Initialize a long-running project: ${task}

**Current Context:**
- Date: ${date}
- OS: ${os}

Create these files in the current directory:

1. **feature_list.json** - A list of features for this project.

**What is a Feature?**
A feature is a COMPLETE, TESTABLE functionality that can be finished in 1-2 sessions.
- Code size: ~50-300 lines per feature
- Time: ~10-60 minutes of actual development work
- Testable: Has clear "done" criteria

**Feature Count Guidelines (use your judgment, not hard limits):**
- **Simple task** (single file, display page, config): 1-3 features
- **Medium task** (multi-page site, CLI tool, small API): 3-8 features
- **Complex task** (full app with frontend + backend + database): 8-15 features

**DO:**
- Split by user-facing features (page A, page B, API group C)
- Each feature = something a user can actually USE

**DO NOT:**
- Split by technical layers (HTML → CSS → JS → content)
- Create features smaller than ~50 lines of code
- Create features larger than ~300 lines of code

**Examples of GOOD features:**
- "User authentication (register, login, logout)" - complete system
- "Todo list page with add/delete/mark-done" - complete page functionality
- "REST API for todos (GET, POST, PUT, DELETE)" - complete API resource

**Examples of BAD features:**
- "Add HTML structure" - too small, technical layer
- "Create the entire application" - too large
- "Add button styling" - trivial, not a feature

Format:
{
  "features": [
    {
      "description": "Feature description (clear and testable)",
      "steps": ["step 1", "step 2", "step 3"],
      "passes": false
    }
  ]
}

2. **PROGRESS.md** - A progress log file:
   # Progress Log

   ## ${date} - Project Initialization

   ### Completed
   - [x] Project initialized

   ### Next Steps
   - [ ] First feature to implement

After creating files, make an initial git commit:
   git add .
   git commit -m "Initial commit: project setup for ${task.slice(0, 50)}"
`;
}
