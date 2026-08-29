/**
 * KodaX CLI Utilities
 * CLI 灞傚伐鍏峰嚱鏁?
 */

import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { exec, spawnSync, type SpawnSyncReturns } from 'child_process';
import { getAgentConfigHome, getCachedRejectedEfforts } from '@kodax-ai/agent';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { setLocale } from './i18n.js';
import type { AutoModeSettings } from './permission-config.js';
import {
  CONFIG_TEMPLATES,
  getConfigTemplate,
  type ConfigTemplateName,
} from './generated-config-templates.js';
import {
  parseExtensionsIntegrationDocument,
  parseMcpIntegrationDocument,
  readExtensionsIntegration,
  readMcpIntegration,
  writeIntegrationDocument,
} from './integration-config.js';
import { withCoreConfigWriteLock } from './core-config-lock.js';
import {
  buildProviderCapabilitySnapshot,
  evaluateProviderPolicy,
  getProviderConfiguredCapabilityProfile,
  getProviderConfiguredReasoningCapability,
  getProviderList as getBuiltInProviderList,
  getProviderModel as getBuiltInProviderModel,
  getProviderModels,
  resolveModelCapabilities,
  resolveReasoningEffort,
  resolveReasoningEffortForModelSwitch,
  getCustomProviderList,
  getCustomProvider,
  isProviderConfigured as isBuiltInProviderConfigured,
  registerCustomProviders,
  resolveProvider,
  normalizeReasoningEffortValue,
  parseReasoningEffortEnv,
  type KodaXProviderCapabilityProfile,
  type KodaXProviderCapabilitySnapshot,
  type KodaXProviderPolicyDecision,
  type KodaXProviderPolicyHints,
  type KodaXReasoningCapability,
  type KodaXAgentMode,
  type KodaXReasoningMode,
  type KodaXMcpServersConfig,
  type KodaXCustomProviderConfig,
  type KodaXReasoningProfile,
} from '@kodax-ai/coding';
import { narrowReasoningProfile } from '@kodax-ai/llm';

const execAsync = promisify(exec);
const AGENT_MODE_CONFIG_SCHEMA_VERSION = 2;
let agentModeMigrationNoticeEmitted = false;

/**
 * CLI config directory paths — top-level constants frozen at module-load time.
 *
 * **LOAD-TIME FREEZE WARNING (v0.7.35.1 FEATURE_145)** — these constants
 * are computed ONCE when this module is first imported, by reading
 * `getAgentConfigHome()` (which itself reads `KODAX_HOME` env var and
 * the programmatic override at that single moment). Subsequent calls to
 * `setAgentConfigHome()` have NO effect on these constants. This
 * matches the prior v0.7.35 behavior where they were inlined as
 * `path.join(os.homedir(), '.kodax')` — same load-time semantics, just
 * routed through the resolver so that `KODAX_HOME` env is now honored.
 *
 * **For substrate consumers**: if you intend to redirect the agent
 * config home via `setAgentConfigHome()`, you MUST call it BEFORE
 * importing any module that transitively imports `@kodax-ai/repl`'s
 * `utils.ts`. Common downstream consumers that capture these constants
 * include:
 *   - `repl/interactive/storage.ts` → `KODAX_SESSIONS_DIR` (session
 *     persistence; silent corruption risk if override is set late)
 *   - the SDK's `repl/index.ts` re-exports
 *   - root `src/index.ts` re-exports
 *
 * **For env-var users**: setting `KODAX_HOME=/path` before launching
 * the kodax CLI works as expected — the env var is read at first
 * import.
 *
 * **For per-call resolution**: use `getAgentConfigHome()` /
 * `getAgentConfigPath(...)` directly from `@kodax-ai/agent` instead of
 * these constants — those resolve at call time and honor late
 * `setAgentConfigHome()` calls.
 */
export const KODAX_DIR = getAgentConfigHome();
export const KODAX_SESSIONS_DIR = path.join(KODAX_DIR, 'sessions');
export const KODAX_CONFIG_FILE = path.join(KODAX_DIR, 'config.json');

// UI display constants
export const PREVIEW_MAX_LENGTH = 60;

let cachedVersion: string | null = null;
let shellEnvironmentHydrated = false;

type ShellEnvRunner = (
  command: string,
  args: string[],
  options: {
    encoding: 'utf8';
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
    windowsHide: boolean;
    detached: boolean;
    stdio: ['ignore', 'pipe', 'pipe'];
  },
) => SpawnSyncReturns<string>;

const SHELL_ENV_PROBE_TERM = 'dumb';

function buildShellEnvCommand(shellPath: string): { args: string[]; sentinel: string } {
  const shellName = path.basename(shellPath).toLowerCase();
  const sentinel = '__KODAX_SHELL_ENV_START__';
  const command = `printf '%s\\0' '${sentinel}'; env -0`;

  if (shellName === 'fish') {
    return { args: ['-i', '-c', command], sentinel };
  }

  const args =
    shellName === 'bash' || shellName === 'zsh'
      ? ['-ic', command]
      : ['-lc', command];

  return { args, sentinel };
}

function parseNullDelimitedShellEnv(stdout: string, sentinel: string): Record<string, string> {
  const marker = `${sentinel}\0`;
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex === -1) {
    return {};
  }

  const payload = stdout.slice(markerIndex + marker.length);
  const env: Record<string, string> = {};

  for (const entry of payload.split('\0')) {
    if (!entry) {
      continue;
    }

    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    env[entry.slice(0, separatorIndex)] = entry.slice(separatorIndex + 1);
  }

  return env;
}

export function hydrateProcessEnvFromShell(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: ShellEnvRunner;
  shell?: string;
} = {}): boolean {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (platform === 'win32') {
    return false;
  }

  if (env.KODAX_DISABLE_SHELL_ENV_HYDRATION === '1') {
    return false;
  }

  const shellPath = options.shell ?? env.SHELL;
  if (!shellPath || !path.isAbsolute(shellPath)) {
    return false;
  }

  const { args, sentinel } = buildShellEnvCommand(shellPath);
  const run = options.run ?? spawnSync;
  const shellProbeEnv: NodeJS.ProcessEnv = {
    ...env,
    TERM: SHELL_ENV_PROBE_TERM,
  };
  const result = run(shellPath, args, {
    encoding: 'utf8',
    env: shellProbeEnv,
    maxBuffer: 1024 * 1024,
    timeout: 5000,
    windowsHide: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0 || !result.stdout) {
    return false;
  }

  const stdout = typeof result.stdout === 'string'
    ? result.stdout
    : result.stdout.toString('utf8');
  const shellEnv = parseNullDelimitedShellEnv(stdout, sentinel);
  let applied = false;

  for (const [key, value] of Object.entries(shellEnv)) {
    // TERM is probe-only; applying it back would misrepresent the live terminal.
    if (key === 'TERM') {
      continue;
    }
    if (env[key] !== undefined) {
      continue;
    }
    env[key] = value;
    applied = true;
  }

  return applied;
}

function ensureShellEnvironmentHydrated(): void {
  if (shellEnvironmentHydrated) {
    return;
  }

  shellEnvironmentHydrated = true;
  try {
    hydrateProcessEnvFromShell();
  } catch {
    // Shell env hydration is best-effort. Falling back to the inherited
    // process env keeps startup resilient in restricted runtimes.
  }
}

// Test-only helper to keep module-level hydration state from leaking across
// multiple cases running in the same process.
export function resetShellEnvironmentHydrationForTesting(): void {
  shellEnvironmentHydrated = false;
}

export function registerConfiguredCustomProviders(config: {
  customProviders?: KodaXCustomProviderConfig[];
}): void {
  registerCustomProviders(config.customProviders ?? []);
}

function normalizeConfiguredExtensions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return normalized.length > 0 ? normalized : [];
}

function normalizeSandboxConfig(value: unknown): {
  envPass?: string[];
} | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const envPass = (value as { envPass?: unknown }).envPass;
  if (!Array.isArray(envPass)) return undefined;
  const names = envPass
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  return { envPass: [...new Set(names)] };
}

interface PersistedCoreConfig {
  readonly raw: string;
  readonly value: Record<string, unknown>;
}

function readPersistedCoreConfig(): PersistedCoreConfig | undefined {
  const raw = fsSync.readFileSync(KODAX_CONFIG_FILE, 'utf8');
  const value = JSON.parse(raw) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return { raw, value: value as Record<string, unknown> };
}

function writePersistedCoreConfig(config: Readonly<Record<string, unknown>>): void {
  fsSync.writeFileSync(KODAX_CONFIG_FILE, JSON.stringify(config, null, 2));
}

function migrateLegacyPermissionModeInConfig<T extends { permissionMode?: string }>(
  config: T,
): T {
  if (config.permissionMode !== 'default') {
    return config;
  }

  const migrated = {
    ...config,
    permissionMode: 'accept-edits',
  } as T;

  try {
    withCoreConfigWriteLock(KODAX_CONFIG_FILE, () => {
      const persisted = readPersistedCoreConfig();
      if (persisted?.value.permissionMode !== 'default') return;
      writePersistedCoreConfig({
        ...persisted.value,
        permissionMode: 'accept-edits',
      });
    });
  } catch {
    // Best-effort self-heal. The in-memory canonicalization still applies,
    // while a competing KodaX writer remains authoritative on disk.
  }

  return migrated;
}

/**
 * FEATURE_092 follow-up (v0.7.46): the `auto-in-project` permission-mode alias is
 * retired. Self-heal the user config to the canonical `auto` instead of nagging a
 * deprecation notice on every startup. Uses a TARGETED rewrite of just the
 * permissionMode value (preserves every other field, comment and formatting,
 * unlike the lossy `JSON.stringify` rewrite above) and canonicalizes the in-memory
 * value so the once-per-session deprecation emitter never fires.
 */
function migrateAutoInProjectAliasInConfig<T extends { permissionMode?: string }>(
  config: T,
): T {
  if (config.permissionMode !== 'auto-in-project') {
    return config;
  }
  try {
    withCoreConfigWriteLock(KODAX_CONFIG_FILE, () => {
      const persisted = readPersistedCoreConfig();
      if (persisted?.value.permissionMode !== 'auto-in-project') return;
      const next = persisted.raw.replace(
        /("permissionMode"\s*:\s*)"auto-in-project"/,
        '$1"auto"',
      );
      if (next !== persisted.raw) fsSync.writeFileSync(KODAX_CONFIG_FILE, next);
    });
  } catch {
    // Best-effort self-heal. The in-memory canonicalization below still applies,
    // while a competing KodaX writer remains authoritative on disk.
  }
  return { ...config, permissionMode: 'auto' } as T;
}

// Read version from package.json dynamically - 动态读取版本号
// In standalone binary builds (Bun --compile), package.json is not on disk;
// the build script injects `process.env.KODAX_VERSION` via --define so this
// function returns the baked-in version without filesystem access.
// 在 Bun 编译后的单文件分发里读不到 package.json，由 build 脚本通过 --define
// 注入 KODAX_VERSION，运行时优先返回该值。
export function getVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  const injected = process.env.KODAX_VERSION;
  if (injected) {
    cachedVersion = injected;
    return cachedVersion;
  }

  const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
  if (fsSync.existsSync(packageJsonPath)) {
    try {
      cachedVersion = JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8')).version ?? '0.0.0';
      return cachedVersion ?? '0.0.0';
    } catch {
      // Fall through to the stable default version when package metadata is unavailable.
    }
  }
  cachedVersion = '0.0.0';
  return cachedVersion;
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
    } catch {
      // Built-in provider snapshots are optional here; custom providers may still supply models.
    }
    try {
      const custom = getCustomProvider(name);
      if (custom) return mergeModels(configModels, custom.getAvailableModels());
    } catch {
      // Ignore custom-provider lookup failures and fall back to user-configured models below.
    }
    return configModels;
  }
  // No config override — use built-in models from snapshot
  try {
    const builtInModels = getProviderModels(name);
    if (builtInModels.length > 0) return builtInModels;
  } catch {
    // Fall through to custom providers when a built-in snapshot is unavailable.
  }
  // Check custom providers
  try {
    const custom = getCustomProvider(name);
    if (custom) return custom.getAvailableModels();
  } catch {
    // Ignore custom-provider lookup failures and report no models.
  }
  return [];
}

export function getProviderReasoningCapability(
  name: string,
  model?: string,
): KodaXReasoningCapability | 'unknown' {
  // Try built-in provider snapshot first (no API key needed)
  const capability = getProviderConfiguredReasoningCapability(name, model);
  if (capability !== 'unknown') return capability;
  // Fallback: check custom providers
  try {
    const custom = getCustomProvider(name);
    if (custom) return custom.getReasoningCapability(model);
  } catch {
    // Unknown custom providers should degrade to "unknown" without surfacing an exception.
  }
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

function getProviderCapabilityMetadata(
  name: string,
  model?: string,
): {
  capabilityProfile: KodaXProviderCapabilityProfile;
  reasoningCapability: KodaXReasoningCapability | 'unknown';
} | null {
  const capabilityProfile = getProviderCapabilityProfile(name);
  const reasoningCapability = getProviderReasoningCapability(name, model);

  if (capabilityProfile) {
    return {
      capabilityProfile,
      reasoningCapability,
    };
  }

  try {
    const provider = resolveProvider(name);
    return {
      capabilityProfile: provider.getCapabilityProfile(),
      reasoningCapability: provider.getReasoningCapability(model),
    };
  } catch {
    return null;
  }
}

export function getProviderCapabilitySnapshot(
  name: string,
  model?: string,
): KodaXProviderCapabilitySnapshot | null {
  const metadata = getProviderCapabilityMetadata(name, model);
  if (!metadata) {
    return null;
  }

  return buildProviderCapabilitySnapshot({
    providerName: name,
    model,
    capabilityProfile: metadata.capabilityProfile,
    reasoningCapability:
      metadata.reasoningCapability === 'unknown'
        ? undefined
        : metadata.reasoningCapability,
  });
}

export function getProviderPolicyDecision(
  name: string,
  model: string | undefined,
  reasoningMode: KodaXReasoningMode,
  hints?: KodaXProviderPolicyHints,
): KodaXProviderPolicyDecision | null {
  const metadata = getProviderCapabilityMetadata(name, model);
  if (!metadata) {
    return null;
  }

  return evaluateProviderPolicy({
    providerName: name,
    model,
    capabilityProfile: metadata.capabilityProfile,
    reasoningCapability:
      metadata.reasoningCapability === 'unknown'
        ? undefined
        : metadata.reasoningCapability,
    reasoningMode,
    hints,
  });
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
    case 'native-adaptive':
      return 'A';
    case 'none':
    case 'prompt-only':
    case 'unknown':
    default:
      return '-';
  }
}

export function formatReasoningEffortForDisplay(
  effort: string | undefined,
): string | undefined {
  if (!effort) {
    return undefined;
  }
  return effort === 'none' ? 'off' : effort;
}

function pushUniqueEffortDisplay(
  values: string[],
  effort: string | undefined,
): void {
  const display = formatReasoningEffortForDisplay(effort);
  if (display && !values.includes(display)) {
    values.push(display);
  }
}

export function getProviderReasoningEffortOptions(
  provider: string,
  model?: string,
): string[] {
  const values = ['auto'];
  const capability = resolveReasoningProfileForDisplay(provider, model);
  const presets = capability?.supportedEfforts?.filter(
    (preset) => preset.isUserVisible !== false,
  );
  if (!presets || presets.length === 0) {
    for (const effort of ['off', 'low', 'medium', 'high']) {
      pushUniqueEffortDisplay(values, effort);
    }
    return values;
  }
  for (const preset of presets) {
    if (
      preset.value === 'none'
      && capability?.supportsDisabledThinking === false
    ) {
      continue;
    }
    pushUniqueEffortDisplay(values, preset.value);
  }
  return values;
}

/**
 * Ordered effort ladder for the Ctrl+T cycle (and any keyboard stepper).
 *
 * Derived from the active model's reasoning profile so the rungs are always the
 * ones that model actually exposes. Two deliberate shaping rules:
 *
 * - `off` (the canonical disable stop) is included only when the model can
 *   disable thinking. A `none` preset on an explicitly always-on profile can be
 *   an alias to its lowest effort and does not create an `off` rung.
 * - Efforts that merely FOLD to off on this model — e.g. `minimal` on a toggle
 *   or budget provider where it sits in `disabledEfforts` — are dropped from the
 *   cycle so the user doesn't hit a second, redundant disable stop next to
 *   `off`. They remain reachable via the explicit `/effort <value>` command,
 *   which renders them honestly as `minimal->off`.
 *
 * `auto` (clear the explicit override → model default) is always the last rung.
 */
export function getProviderReasoningEffortCycle(
  provider: string,
  model?: string,
): string[] {
  const capability = resolveReasoningProfileForDisplay(provider, model);
  const disabled = new Set(capability?.disabledEfforts ?? []);
  const presets = capability?.supportedEfforts?.filter(
    (preset) => preset.isUserVisible !== false,
  );

  const concrete: string[] = [];
  let canDisable = capability?.supportsDisabledThinking === true;
  if (!presets || presets.length === 0) {
    for (const effort of ['low', 'medium', 'high']) {
      pushUniqueEffortDisplay(concrete, effort);
    }
    canDisable = true;
  } else {
    for (const preset of presets) {
      if (preset.value === 'none') {
        if (capability?.supportsDisabledThinking !== false) {
          canDisable = true;
        }
        continue;
      }
      if (disabled.has(preset.value)) {
        if (capability?.supportsDisabledThinking !== false) {
          canDisable = true;
        }
        continue;
      }
      pushUniqueEffortDisplay(concrete, preset.value);
    }
  }

  const cycle: string[] = [];
  if (canDisable) {
    cycle.push('off');
  }
  cycle.push(...concrete);
  cycle.push('auto');
  return cycle;
}

function legacyReasoningModeToEffortDisplay(
  mode: KodaXReasoningMode | undefined,
  thinking: boolean | undefined,
): string {
  if (thinking === false) {
    return 'off';
  }
  switch (mode) {
    case 'off':
      return 'off';
    case 'quick':
      return 'low';
    case 'balanced':
      return 'medium';
    case 'deep':
      return 'high';
    case 'auto':
    default:
      return 'auto';
  }
}

function resolveReasoningProfileForDisplay(
  provider: string,
  model: string | undefined,
): KodaXReasoningProfile | undefined {
  const modelId = model ?? getProviderModel(provider);
  if (!modelId) {
    return undefined;
  }
  const profile = resolveModelCapabilities(provider, modelId)?.reasoningProfile;
  if (!profile) {
    return undefined;
  }
  // Apply the runtime capability cache: efforts observed/probed to be rejected
  // by this provider/model are removed so the cycle, /effort options, and the
  // status label all stop offering them (single funnel for every display
  // consumer).
  return narrowReasoningProfile(profile, getCachedRejectedEfforts(provider, modelId));
}

export function formatReasoningEffortStatusLabel(input: {
  provider: string;
  model?: string;
  effort?: string;
  effortOverride?: boolean;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
}): string {
  const fallback = formatReasoningEffortForDisplay(input.effort)
    ?? legacyReasoningModeToEffortDisplay(input.reasoningMode, input.thinking);
  const capability = resolveReasoningProfileForDisplay(input.provider, input.model);
  if (!capability) {
    return fallback;
  }

  try {
    const resolved = resolveReasoningEffort({
      capability,
      explicitEffort: input.effortOverride ? input.effort : undefined,
      sessionEffort: input.effortOverride ? undefined : input.effort,
      legacyReasoningMode: input.reasoningMode,
      thinking: input.thinking,
    });
    const configured = formatReasoningEffortForDisplay(resolved.configuredEffort) ?? fallback;
    // A configured effort that sits in `disabledEfforts` (e.g. `minimal` on a
    // toggle/budget provider) folds to "off" at the wire layer (base.ts).
    // Reflect that truth so the status reads `minimal->off` instead of a bare
    // `minimal` that lies about thinking still being on.
    const foldsToOff = resolved.configuredEffort !== undefined
      && capability.supportsDisabledThinking !== false
      && capability.disabledEfforts?.includes(resolved.configuredEffort) === true;
    const effective = foldsToOff
      ? 'off'
      : formatReasoningEffortForDisplay(resolved.effectiveEffort);
    return effective && effective !== configured
      ? `${configured}->${effective}`
      : configured;
  } catch {
    if (input.effort) {
      try {
        const switchResolution = resolveReasoningEffortForModelSwitch({
          currentEffort: input.effort,
          capability,
        });
        const configured = formatReasoningEffortForDisplay(input.effort) ?? fallback;
        const effective = formatReasoningEffortForDisplay(switchResolution.effectiveEffort);
        return effective && effective !== configured
          ? `${configured}->${effective}`
          : configured;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

export function resolveProviderReasoningRuntimeEffort(input: {
  provider: string;
  model?: string;
  effort?: string;
  effortOverride?: boolean;
  permissionMode?: string;
  planModeEffort?: string;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
}): {
  configuredEffort?: string;
  runtimeEffort?: string;
  preserved: boolean;
  diagnostic?: string;
} {
  const configuredEffort = resolvePermissionModeEffort(input);
  if (!configuredEffort) {
    return { preserved: true };
  }

  const capability = resolveReasoningProfileForDisplay(input.provider, input.model);
  if (!capability) {
    return {
      configuredEffort,
      runtimeEffort: configuredEffort,
      preserved: true,
    };
  }
  const resolution = resolveReasoningEffortForModelSwitch({
    currentEffort: configuredEffort,
    capability,
  });

  return {
    configuredEffort,
    runtimeEffort: resolution.effectiveEffort,
    preserved: resolution.preserved,
    diagnostic: resolution.diagnostic,
  };
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
    case 'native-adaptive':
      return 'adaptive';
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
    case 'native-adaptive':
      return 'Model adaptively decides thinking depth (Opus 4.7+)';
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

class InvalidAgentModeConfigError extends Error {}

function migrateLegacyAgentModeConfig<
  T extends { readonly agentMode?: string; readonly schemaVersion?: number },
>(parsed: T): Omit<T, 'agentMode'> & { readonly agentMode?: KodaXAgentMode } {
  const mode = parsed.agentMode;
  if (mode === undefined || mode === 'ama' || mode === 'sa') {
    return parsed as Omit<T, 'agentMode'> & { readonly agentMode?: KodaXAgentMode };
  }
  if (mode !== 'amaw' && mode !== 'ama-workflow') {
    throw new InvalidAgentModeConfigError(
      `Invalid agentMode "${mode}" in ${KODAX_CONFIG_FILE}. Expected "ama" or "sa".`,
    );
  }
  const migrated = {
    ...parsed,
    agentMode: 'ama' as const,
    schemaVersion: Math.max(parsed.schemaVersion ?? 0, AGENT_MODE_CONFIG_SCHEMA_VERSION),
  };
  try {
    withCoreConfigWriteLock(KODAX_CONFIG_FILE, () => {
      const persisted = readPersistedCoreConfig();
      if (!persisted) return;
      const persistedMode = persisted.value.agentMode;
      if (persistedMode !== 'amaw' && persistedMode !== 'ama-workflow') return;
      writePersistedCoreConfig({
        ...persisted.value,
        agentMode: 'ama',
        schemaVersion: Math.max(
          typeof persisted.value.schemaVersion === 'number'
            ? persisted.value.schemaVersion
            : 0,
          AGENT_MODE_CONFIG_SCHEMA_VERSION,
        ),
      });
    });
  } catch {
    // Best-effort self-heal. A competing KodaX writer remains authoritative
    // on disk, while the current process uses the canonical in-memory value.
  }
  if (!agentModeMigrationNoticeEmitted) {
    process.emitWarning(
      `Migrated persisted agentMode "${mode}" to "ama". Workflow use is now explicit intent.`,
      { code: 'KODAX_AGENT_MODE_MIGRATED' },
    );
    agentModeMigrationNoticeEmitted = true;
  }
  return migrated;
}

// Load config from ~/.kodax/config.json
export function loadConfig(): {
  provider?: string;
  model?: string;
  runtimeMode?: 'embedded' | 'daemon';
  effort?: string;
  planModeEffort?: string;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
  /**
   * FEATURE_078 (v0.7.29): preferred name for `reasoningMode`. Both
   * fields map to the same runtime L1 user-ceiling semantic; when both
   * are present `reasoningCeiling` wins. Prefer this name in new
   * configs — `reasoningMode` is kept accepted for backward
   * compatibility and never auto-renamed (no user-visible churn).
   */
  reasoningCeiling?: KodaXReasoningMode;
  agentMode?: KodaXAgentMode;
  permissionMode?: string;
  autoMode?: AutoModeSettings;
  locale?: string;
  providerModels?: Record<string, string[]>;
  customProviders?: KodaXCustomProviderConfig[];
  extensions?: string[];
  mcpServers?: KodaXMcpServersConfig;
  repoIntelligenceMode?: 'auto' | 'off' | 'light' | 'full';
  repoIntelligenceTrace?: boolean;
  streamIdleTimeoutMs?: number;
  /**
   * FEATURE_184 Phase D.3 follow-up (v0.7.42) — opt-in Sidecar Verifier
   * observability. When `true`, the runtime emits a persisted note per
   * verifier call:
   *   `[Sidecar Verifier] {verdict} · {model} · {ms}ms · {trace}`
   * Mirrored to env var `KODAX_VERIFIER_LOG=1` so the agent-runtime
   * layer (which has no access to `~/.kodax/config.json`) can read it.
   */
  verifierLog?: boolean;
  /**
   * FEATURE_187 Phase C (v0.7.43) — opt-in Stall Sidecar observability.
   * When `true`, the runtime emits a persisted note per L2 stall
   * verdict (isStuck true OR false):
   *   `[Stall Sidecar] isStuck={true|false} · {provider}/{model} · {ms}ms · {trace}`
   * Mirrored to env var `KODAX_STALL_LOG=1`.
   */
  stallLog?: boolean;
  /**
   * FEATURE_102 Phase 3 (v0.7.45) — ordered cross-provider fallback chain for
   * child dispatch. When a child's primary provider is exhausted/down, the
   * runtime re-runs it on the next provider here. Empty/absent = OFF. Mirrored
   * to env var `KODAX_FALLBACK_PROVIDERS` (comma-separated) for the coding
   * layer, which has no config access. Set via the `/fallback` command.
   */
  fallbackProviders?: string[];
  /**
   * Per-agent model TIERS for the workflow / dispatch `model_hint` (M2 config
   * surface). Operators point a tier at a concrete provider+model; a workflow
   * script / dispatch then expresses intent via `modelHint: 'fast' | 'deep'`.
   * 'fast' routes read-only children only (write/codegen stays on the parent —
   * a quality guard); 'deep' routes any child. Mirrored to
   * KODAX_FAST/DEEP_PROVIDER/MODEL for the coding layer (which has no config
   * access); env wins if pre-set. An unset tier inherits the parent model.
   */
  fastProvider?: string;
  fastModel?: string;
  deepProvider?: string;
  deepModel?: string;
  /**
   * Config surface for settings the coding/llm layer reads only via env (it has
   * no config access). Bridged to their KODAX_* env vars in prepareRuntimeConfig
   * (env-wins). See CONFIG_ENV_BRIDGES for the mapping.
   */
  maxOutputTokens?: number;
  disablePromptCache?: boolean;
  lsp?: boolean;
  lspAutoDownload?: boolean;
  acpLogLevel?: string;
  sessionRetentionDays?: number;
  repoIntelligence?: {
    toolWaitMs?: number;
    workerTimeoutMs?: number;
    workerOldSpaceMb?: number;
    storageDir?: string;
  };
  workflow?: {
    maxConcurrency?: number;
  };
  sandbox?: {
    envPass?: string[];
  };
  /**
   * Worker-hosted embedded Runtime options. `configuredA2A` lets a
   * Worker-hosted embedded Runtime load and reconcile
   * `<homeDir>/.kodax/integrations/a2a.json` inside the Worker owner,
   * installing the full list/describe/preflight and external Actor dispatch
   * surface so configured A2A Agents appear as `external:<name>`.
   */
  worker?: {
    configuredA2A?: boolean;
  };
} {
  try {
    if (fsSync.existsSync(KODAX_CONFIG_FILE)) {
      const parsed = JSON.parse(fsSync.readFileSync(KODAX_CONFIG_FILE, 'utf-8')) as {
        provider?: string;
        model?: string;
        runtimeMode?: 'embedded' | 'daemon';
        effort?: string;
        planModeEffort?: string;
        thinking?: boolean;
        reasoningMode?: KodaXReasoningMode;
        reasoningCeiling?: KodaXReasoningMode;
        agentMode?: string;
        schemaVersion?: number;
        permissionMode?: string;
        autoMode?: AutoModeSettings;
        locale?: string;
        providerModels?: Record<string, string[]>;
        customProviders?: KodaXCustomProviderConfig[];
        extensions?: unknown;
        mcpServers?: KodaXMcpServersConfig;
        repoIntelligenceMode?: 'auto' | 'off' | 'light' | 'full';
        repoIntelligenceTrace?: boolean;
        streamIdleTimeoutMs?: number;
        verifierLog?: boolean;
        stallLog?: boolean;
        fallbackProviders?: string[];
        fastProvider?: string;
        fastModel?: string;
        deepProvider?: string;
        deepModel?: string;
        maxOutputTokens?: number;
        disablePromptCache?: boolean;
        lsp?: boolean;
        lspAutoDownload?: boolean;
        acpLogLevel?: string;
        sessionRetentionDays?: number;
        repoIntelligence?: {
          toolWaitMs?: number;
          workerTimeoutMs?: number;
          workerOldSpaceMb?: number;
          storageDir?: string;
        };
        workflow?: {
          maxConcurrency?: number;
        };
        sandbox?: unknown;
        worker?: {
          configuredA2A?: boolean;
        };
      };
      const migrated = migrateLegacyAgentModeConfig(parsed);
      // FEATURE_078: collapse `reasoningCeiling` (preferred) onto
      // `reasoningMode` so existing call sites that read
      // `options.reasoningMode` keep working unchanged. When both are
      // present we trust `reasoningCeiling` — that's the deliberately
      // named L1 ceiling field, and the legacy `reasoningMode` is
      // typically left over from older configs the user forgot about.
      const collapsedReasoning: KodaXReasoningMode | undefined =
        migrated.reasoningCeiling ?? migrated.reasoningMode;
      let effectiveExtensions: string[] = [];
      let effectiveMcpServers: KodaXMcpServersConfig = {};
      try {
        effectiveExtensions = [...readExtensionsIntegration(KODAX_DIR).document.paths];
      } catch {
        // The domain file is authoritative. Invalid startup config activates
        // nothing; long-lived hosts retain last-known-good through the domain
        // controller instead of falling back to shadowed legacy declarations.
      }
      try {
        effectiveMcpServers = readMcpIntegration(KODAX_DIR).document.servers;
      } catch {
        // See the Extension-domain note above.
      }
      return migrateAutoInProjectAliasInConfig(
        migrateLegacyPermissionModeInConfig({
          ...migrated,
          reasoningMode: collapsedReasoning,
          extensions: normalizeConfiguredExtensions(effectiveExtensions),
          mcpServers: effectiveMcpServers,
          sandbox: normalizeSandboxConfig(migrated.sandbox),
        }),
      );
    }
  } catch (error) {
    if (error instanceof InvalidAgentModeConfigError) throw error;
    // Unreadable user config should fall back to defaults instead of breaking startup.
  }
  // Split integration files are independently usable. A user does not need to
  // create an otherwise-empty core config.json before mcp.json or
  // extensions.json can become effective.
  let extensions: string[] | undefined;
  let mcpServers: KodaXMcpServersConfig | undefined;
  try {
    const snapshot = readExtensionsIntegration(KODAX_DIR);
    if (snapshot.source !== 'default') {
      extensions = normalizeConfiguredExtensions([...snapshot.document.paths]);
    }
  } catch {
    // Invalid authoritative domain files activate no new value at startup.
  }
  try {
    const snapshot = readMcpIntegration(KODAX_DIR);
    if (snapshot.source !== 'default') mcpServers = snapshot.document.servers;
  } catch {
    // See the Extension-domain note above.
  }
  return {
    ...(extensions === undefined ? {} : { extensions }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
  };
}

/**
 * F1 — first-launch onboarding. config.json must be STRICT JSON (no comments), so we
 * cannot ship a self-documenting config.json. Instead, on first launch (no config.json
 * yet) we write a heavily-commented `config.example.jsonc` REFERENCE file next to it.
 * It is never loaded by KodaX — it exists purely so a new user can see the minimal
 * fields and the inline guidance (especially custom-provider thinking/reasoning) and
 * copy what they need into config.json.
 *
 * Returns the example path only when it was just created (so the caller can print a
 * one-time pointer); returns undefined if config.json already exists, the example
 * already exists, or the write failed. Never throws — a template-write failure must
 * not block startup.
 */
export const KODAX_EXAMPLE_CONFIG_FILE = path.join(KODAX_DIR, 'config.example.jsonc');
export const KODAX_INTEGRATION_EXAMPLE_FILES = {
  mcp: path.join(KODAX_DIR, 'integrations', 'mcp.example.jsonc'),
  a2a: path.join(KODAX_DIR, 'integrations', 'a2a.example.jsonc'),
  extensions: path.join(KODAX_DIR, 'integrations', 'extensions.example.jsonc'),
} as const;

const EXAMPLE_FILES: readonly {
  readonly name: ConfigTemplateName;
  readonly path: string;
}[] = [
  { name: 'core', path: KODAX_EXAMPLE_CONFIG_FILE },
  { name: 'mcp', path: KODAX_INTEGRATION_EXAMPLE_FILES.mcp },
  { name: 'a2a', path: KODAX_INTEGRATION_EXAMPLE_FILES.a2a },
  { name: 'extensions', path: KODAX_INTEGRATION_EXAMPLE_FILES.extensions },
];

export { CONFIG_TEMPLATES, getConfigTemplate };
export type { ConfigTemplateName };

export function ensureExampleConfigFiles(): readonly string[] {
  const created: string[] = [];
  for (const example of EXAMPLE_FILES) {
    try {
      if (fsSync.existsSync(example.path)) continue;
      fsSync.mkdirSync(path.dirname(example.path), { recursive: true });
      fsSync.writeFileSync(example.path, getConfigTemplate(example.name), 'utf8');
      created.push(example.path);
    } catch {
      // Reference templates are best-effort and independent. Active config
      // never reads *.example.jsonc files.
    }
  }
  return created;
}

/** @deprecated Use ensureExampleConfigFiles() to observe every created path. */
export function ensureExampleConfigFile(): string | undefined {
  return ensureExampleConfigFiles()[0];
}

const projectedConfigEnvironment = new Map<string, string>();

export type ConfigEnvironmentSource = 'environment' | 'persisted' | 'unset';

/** Report provenance for a bridged env value without returning the value itself. */
export function inspectConfigEnvironmentSource(env: string): ConfigEnvironmentSource {
  const value = process.env[env];
  if (value === undefined) return 'unset';
  return projectedConfigEnvironment.get(env) === value ? 'persisted' : 'environment';
}

function projectConfigEnvironment(env: string, value: string | undefined): void {
  const current = process.env[env];
  const previousProjection = projectedConfigEnvironment.get(env);
  const ownedProjection = previousProjection !== undefined && current === previousProjection;
  if (current !== undefined && !ownedProjection) {
    projectedConfigEnvironment.delete(env);
    return;
  }

  if (value === undefined) {
    if (ownedProjection) delete process.env[env];
    projectedConfigEnvironment.delete(env);
    return;
  }

  process.env[env] = value;
  projectedConfigEnvironment.set(env, value);
}

/**
 * Config surface — the single table of config.json fields bridged to the KODAX_*
 * env vars the coding / llm / repo-intelligence layers read (they have no config
 * access). `value` returns the env string to install, or undefined to skip.
 * Env-wins: a shell-set var is never overwritten (a CI/script override beats the
 * file). ADD A NEW BRIDGED SETTING HERE — one row, plus the config-type field.
 * Process-bootstrap-only vars such as KODAX_HEAP_LIMIT are read before this
 * runs, so they stay env-only — see config.example.jsonc.
 */
const CONFIG_ENV_BRIDGES: ReadonlyArray<{
  readonly configPath: string;
  readonly env: string;
  readonly value: (config: ReturnType<typeof loadConfig>) => string | undefined;
}> = [
  { configPath: 'streamIdleTimeoutMs', env: 'KODAX_STREAM_IDLE_TIMEOUT_MS', value: (c) => configNumberString(c.streamIdleTimeoutMs) },
  { configPath: 'repoIntelligenceMode', env: 'KODAX_REPO_INTELLIGENCE', value: (c) => c.repoIntelligenceMode },
  { configPath: 'repoIntelligenceTrace', env: 'KODAX_REPO_INTELLIGENCE_TRACE', value: (c) => configBooleanString(c.repoIntelligenceTrace) },
  { configPath: 'verifierLog', env: 'KODAX_VERIFIER_LOG', value: (c) => configBooleanString(c.verifierLog) },
  { configPath: 'stallLog', env: 'KODAX_STALL_LOG', value: (c) => configBooleanString(c.stallLog) },
  { configPath: 'fallbackProviders', env: 'KODAX_FALLBACK_PROVIDERS', value: (c) => configStringList(c.fallbackProviders) },
  { configPath: 'fastProvider', env: 'KODAX_FAST_PROVIDER', value: (c) => normalizedConfigString(c.fastProvider) },
  { configPath: 'fastModel', env: 'KODAX_FAST_MODEL', value: (c) => normalizedConfigString(c.fastModel) },
  { configPath: 'deepProvider', env: 'KODAX_DEEP_PROVIDER', value: (c) => normalizedConfigString(c.deepProvider) },
  { configPath: 'deepModel', env: 'KODAX_DEEP_MODEL', value: (c) => normalizedConfigString(c.deepModel) },
  { configPath: 'provider', env: 'KODAX_PROVIDER', value: (c) => normalizedConfigString(c.provider) },
  { configPath: 'effort', env: 'KODAX_EFFORT', value: (c) => normalizedConfigString(c.effort) },
  { configPath: 'runtimeMode', env: 'KODAX_RUNTIME_MODE', value: (c) => c.runtimeMode },
  { configPath: 'sessionRetentionDays', env: 'KODAX_SESSION_RETENTION_DAYS', value: (c) => configNumberString(c.sessionRetentionDays) },
  { configPath: 'maxOutputTokens', env: 'KODAX_MAX_OUTPUT_TOKENS', value: (c) => configNumberString(c.maxOutputTokens) },
  { configPath: 'disablePromptCache', env: 'KODAX_DISABLE_PROMPT_CACHE', value: (c) => configBooleanString(c.disablePromptCache) },
  { configPath: 'lsp', env: 'KODAX_LSP', value: (c) => configBooleanString(c.lsp) },
  { configPath: 'lspAutoDownload', env: 'KODAX_LSP_DOWNLOAD', value: (c) => configBooleanString(c.lspAutoDownload) },
  { configPath: 'acpLogLevel', env: 'KODAX_ACP_LOG', value: (c) => normalizedConfigString(c.acpLogLevel) },
  { configPath: 'repoIntelligence.toolWaitMs', env: 'KODAX_REPO_INTELLIGENCE_TOOL_WAIT_MS', value: (c) => configNumberString(c.repoIntelligence?.toolWaitMs) },
  { configPath: 'repoIntelligence.workerTimeoutMs', env: 'KODAX_REPO_INTELLIGENCE_WORKER_TIMEOUT_MS', value: (c) => configNumberString(c.repoIntelligence?.workerTimeoutMs) },
  { configPath: 'repoIntelligence.workerOldSpaceMb', env: 'KODAX_REPO_INTELLIGENCE_WORKER_OLD_SPACE_MB', value: (c) => configNumberString(c.repoIntelligence?.workerOldSpaceMb) },
  { configPath: 'repoIntelligence.storageDir', env: 'KODAX_REPO_INTELLIGENCE_STORAGE_DIR', value: (c) => normalizedConfigString(c.repoIntelligence?.storageDir) },
  { configPath: 'workflow.maxConcurrency', env: 'KODAX_WORKFLOW_MAX_CONCURRENCY', value: (c) => configNumberString(c.workflow?.maxConcurrency) },
  { configPath: 'sandbox.envPass', env: 'KODAX_SANDBOX_ENV_PASS', value: (c) => configStringList(c.sandbox?.envPass) || undefined },
];

function applyConfigSurfaceBridges(config: ReturnType<typeof loadConfig>): void {
  for (const b of CONFIG_ENV_BRIDGES) {
    projectConfigEnvironment(b.env, b.value(config));
  }
}

function normalizedConfigString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function configNumberString(value: number | undefined): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function configBooleanString(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : value ? '1' : '0';
}

function configStringList(value: string[] | undefined): string | undefined {
  return value?.filter((entry) => entry.trim().length > 0).join(',');
}

export const KODAX_CONFIG_ENV_BINDINGS: ReadonlyArray<{
  readonly configPath: string;
  readonly env: string;
}> = [
  ...CONFIG_ENV_BRIDGES.map(({ configPath, env }) => ({ configPath, env })),
];

export function applyConfigEnvironment(config: ReturnType<typeof loadConfig>): void {
  applyConfigSurfaceBridges(config);
}

export function prepareRuntimeConfig(): ReturnType<typeof loadConfig> {
  ensureShellEnvironmentHydrated();
  const config = loadConfig();
  applyConfigEnvironment(config);
  registerConfiguredCustomProviders(config);
  // Initialize i18n locale from config (falls back to system LANG)
  setLocale(config.locale);
  return config;
}

// Save config to ~/.kodax/config.json
export function saveConfig(config: {
  provider?: string;
  model?: string;
  runtimeMode?: 'embedded' | 'daemon';
  effort?: string;
  planModeEffort?: string;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
  agentMode?: KodaXAgentMode;
  permissionMode?: string;
  locale?: string;
  providerModels?: Record<string, string[]>;
  customProviders?: KodaXCustomProviderConfig[];
  extensions?: string[];
  mcpServers?: KodaXMcpServersConfig;
  repoIntelligenceMode?: 'auto' | 'off' | 'light' | 'full';
  repoIntelligenceTrace?: boolean;
  /** FEATURE_184 Phase D.3 follow-up — opt-in verifier log line. */
  verifierLog?: boolean;
  /** FEATURE_187 Phase C — opt-in stall sidecar log line. */
  stallLog?: boolean;
  /** FEATURE_102 Phase 3 — cross-provider child fallback chain. */
  fallbackProviders?: string[];
  /** M2 — per-agent model tiers (workflow / dispatch model_hint). */
  fastProvider?: string;
  fastModel?: string;
  deepProvider?: string;
  deepModel?: string;
  /** Config surface bridged to KODAX_* env for the coding/llm layer. */
  maxOutputTokens?: number;
  disablePromptCache?: boolean;
  lsp?: boolean;
  lspAutoDownload?: boolean;
  acpLogLevel?: string;
  sessionRetentionDays?: number;
  repoIntelligence?: {
    toolWaitMs?: number;
    workerTimeoutMs?: number;
    workerOldSpaceMb?: number;
    storageDir?: string;
  };
  workflow?: {
    maxConcurrency?: number;
  };
  sandbox?: {
    envPass?: string[];
  };
}): void {
  const { extensions, mcpServers, ...coreConfig } = config;
  withCoreConfigWriteLock(KODAX_CONFIG_FILE, () => {
    let current: Record<string, unknown> = {};
    if (fsSync.existsSync(KODAX_CONFIG_FILE)) {
      try {
        const parsed = JSON.parse(fsSync.readFileSync(KODAX_CONFIG_FILE, 'utf8')) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch {
        // Preserve the existing public behavior: a malformed core config does
        // not block replacing it with a valid explicitly supplied snapshot.
      }
    }
    const merged: Record<string, unknown> = { ...current, ...coreConfig };
    for (const key of Object.keys(coreConfig) as Array<keyof typeof coreConfig>) {
      if (coreConfig[key] === undefined) delete merged[key];
    }
    fsSync.writeFileSync(KODAX_CONFIG_FILE, JSON.stringify(merged, null, 2));
  });

  if (extensions !== undefined) {
    const currentExtensions = readExtensionsIntegration(KODAX_DIR);
    writeIntegrationDocument({
      domain: 'extensions',
      configHome: KODAX_DIR,
      ...(currentExtensions.source === 'user'
        ? { expectedRevision: currentExtensions.revision }
        : {}),
      document: {
        version: 1,
        paths: normalizeConfiguredExtensions(extensions) ?? [],
      },
      validate: parseExtensionsIntegrationDocument,
    });
  }
  if (mcpServers !== undefined) {
    const currentMcp = readMcpIntegration(KODAX_DIR);
    writeIntegrationDocument({
      domain: 'mcp',
      configHome: KODAX_DIR,
      ...(currentMcp.source === 'user' ? { expectedRevision: currentMcp.revision } : {}),
      document: { version: 1, servers: mcpServers },
      validate: parseMcpIntegrationDocument,
    });
  }
}

/**
 * Reconstruct `effortOverride` at startup. A persisted `config.effort` only
 * ever comes from an explicit choice (Ctrl+T / `/effort <value>`; clearing to
 * auto deletes the field), so a present config effort must restore as an
 * override — otherwise the round-tripped value is mis-read as a session
 * default and the Ctrl+T position detector treats it as `auto`. The CLI
 * `--effort` flag or a concrete `KODAX_EFFORT` value also forces an override
 * for the launched session. The environment `auto`/`unset` sentinel clears
 * only that layer, so config can still supply the persisted preference.
 */
export function resolveInitialEffortOverride(
  options: { effort?: string },
  config: { effort?: string },
  environmentEffort?: string,
): boolean {
  return options.effort !== undefined
    || parseReasoningEffortEnv(environmentEffort).kind === 'value'
    || config.effort !== undefined;
}

function nonEmptySelection(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

export function resolveRuntimeProviderSelection(input: {
  explicitProvider?: string;
  environmentProvider?: string;
  configuredProvider?: string;
  defaultProvider: string;
}): string {
  return nonEmptySelection(input.explicitProvider)
    ?? nonEmptySelection(input.environmentProvider)
    ?? nonEmptySelection(input.configuredProvider)
    ?? input.defaultProvider;
}

export function resolveRuntimeModelSelection(input: {
  explicitProvider?: string;
  environmentProvider?: string;
  explicitModel?: string;
  configuredProvider?: string;
  configuredModel?: string;
}): string | undefined {
  const explicitModel = nonEmptySelection(input.explicitModel);
  if (explicitModel) return explicitModel;

  const configuredModel = nonEmptySelection(input.configuredModel);
  if (!configuredModel) return undefined;

  const providerOverride = nonEmptySelection(input.explicitProvider)
    ?? nonEmptySelection(input.environmentProvider);
  if (!providerOverride) return configuredModel;

  const configuredProvider = nonEmptySelection(input.configuredProvider);
  return configuredProvider === providerOverride ? configuredModel : undefined;
}

export function resolveRuntimeEffortSelection(input: {
  explicitEffort?: string;
  environmentEffort?: string;
  configuredEffort?: string;
}): string | undefined {
  if (input.explicitEffort !== undefined) {
    return normalizeReasoningEffortValue(input.explicitEffort);
  }

  const environmentEffort = parseReasoningEffortEnv(input.environmentEffort);
  if (environmentEffort.kind === 'value') {
    return environmentEffort.value;
  }

  return input.configuredEffort === undefined
    ? undefined
    : normalizeReasoningEffortValue(input.configuredEffort);
}

export function resolvePermissionModeEffort(config: {
  effort?: string;
  effortOverride?: boolean;
  permissionMode?: string;
  planModeEffort?: string;
}): string | undefined {
  if (
    config.permissionMode === 'plan'
    && config.effortOverride !== true
    && config.planModeEffort !== undefined
  ) {
    return config.planModeEffort;
  }
  return config.effort;
}

/**
 * Get git root directory.
 *
 * v0.7.46 fix — accepts optional `cwd` so in-process SDK embedders (KodaX
 * Space) that serve multiple projects from a single runtime can resolve
 * the git root of the project the user opened, NOT the embedder's
 * startup directory. Without `cwd`, `git rev-parse --show-toplevel`
 * inherits the host process's cwd, which mis-tags storage operations
 * for multi-project embedders (the same root cause as the
 * `saveSessionSnapshot` gitRoot bug in agent-runtime/middleware/ shipped in v0.7.45).
 *
 * No `cwd` arg → behaves identically to the pre-v0.7.46 form
 * (process.cwd() of the host).
 */
export async function getGitRoot(cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel', {
      cwd,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export function formatProviderSourceKind(
  sourceKind: KodaXProviderCapabilitySnapshot['sourceKind'],
): string {
  switch (sourceKind) {
    case 'builtin':
      return 'Built-in';
    case 'runtime':
      return 'Runtime extension';
    case 'custom':
      return 'Custom config';
    case 'unknown':
    default:
      return 'Unknown';
  }
}

export function formatProviderCapabilityDetailLines(
  snapshot: KodaXProviderCapabilitySnapshot,
): string[] {
  const transport =
    snapshot.transport === 'cli-bridge' ? 'CLI bridge' : 'Native API';
  const conversation =
    snapshot.conversationSemantics === 'last-user-message'
      ? 'latest-user-message only'
      : 'full conversation history';

  return [
    `Source: ${formatProviderSourceKind(snapshot.sourceKind)}`,
    `Transport: ${transport}`,
    `Conversation semantics: ${conversation}`,
    `Context fidelity: ${snapshot.contextFidelity}`,
    `Tool calling: ${snapshot.toolCallingFidelity}`,
    `Session behavior: ${snapshot.sessionSupport}`,
    `Long-running support: ${snapshot.longRunningSupport}`,
    `Evidence-heavy flows: ${snapshot.evidenceSupport}`,
    `Multimodal support: ${snapshot.multimodalSupport}`,
    `MCP support: ${snapshot.mcpSupport}`,
    `Reasoning control: ${describeReasoningCapabilityControl(snapshot.reasoningCapability)}`,
  ];
}

export function getProviderCommonPolicyScenarios(
  name: string,
  model: string | undefined,
  reasoningMode: KodaXReasoningMode,
): Array<{ label: string; decision: KodaXProviderPolicyDecision }> {
  const scenarios: Array<{
    label: string;
    hints: KodaXProviderPolicyHints;
  }> = [
    { label: 'General coding', hints: {} },
    { label: 'Evidence-heavy review', hints: { evidenceHeavy: true } },
    { label: 'Long-running task', hints: { longRunning: true } },
  ];

  return scenarios
    .map((scenario) => ({
      label: scenario.label,
      decision: getProviderPolicyDecision(
        name,
        model,
        reasoningMode,
        scenario.hints,
      ),
    }))
    .filter(
      (
        scenario,
      ): scenario is { label: string; decision: KodaXProviderPolicyDecision } =>
        scenario.decision !== null,
    );
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
