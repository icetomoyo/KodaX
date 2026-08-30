import { Command, InvalidArgumentError } from 'commander';
import {
  KodaXAgentMode,
  KodaXOptions,
  KodaXExtensionRuntime,
  type KodaXRepoIntelligenceMode,
  KodaXReasoningMode,
  KODAX_REASONING_MODE_SEQUENCE,
  normalizeReasoningEffortValue,
  parseReasoningEffortEnv,
} from '@kodax-ai/coding';
import {
  createCliEvents,
  createJsonEvents,
  FileSessionStorage,
} from '@kodax-ai/repl';
import type { AcpPermissionMode } from './acp_server.js';

export const ACP_PERMISSION_MODES: AcpPermissionMode[] = [
  'plan',
  'accept-edits',
  'auto',
  'full-access',
];
export const CLI_OUTPUT_MODES = ['text', 'json'] as const;
export const CLI_RUNTIME_MODES = ['embedded', 'daemon'] as const;
export const KODAX_AGENT_MODES = ['ama', 'sa'] as const;
export const KODAX_REPO_INTELLIGENCE_MODES: KodaXRepoIntelligenceMode[] = [
  'auto',
  'off',
  'light',
  'full',
];
export const KODAX_REPO_INTELLIGENCE_PUBLIC_MODES = ['auto', 'full', 'light', 'off'] as const;
export type CliOutputMode = typeof CLI_OUTPUT_MODES[number];
export type CliRuntimeMode = typeof CLI_RUNTIME_MODES[number];

export interface CliOptions {
  provider: string;
  model?: string;
  effort?: string;
  thinking: boolean;
  reasoningMode: KodaXReasoningMode;
  agentMode: KodaXAgentMode;
  outputMode: CliOutputMode;
  runtimeMode?: CliRuntimeMode;
  extensions?: string[];
  extensionRuntime?: KodaXExtensionRuntime;
  session?: string;
  maxIter?: number;
  prompt: string[];
  continue?: boolean;
  resume?: string;
  noSession: boolean;
  print?: boolean;
}

export interface NormalizedCliSessionFlags {
  session?: string;
  noSession: boolean;
}

/** Merge accepted parent options while keeping the selected command authoritative. */
export function mergeCommandOptionsWithGlobals<T extends object>(
  localOptions: T,
  command: Command,
): T {
  return { ...command.optsWithGlobals(), ...localOptions };
}

export function normalizeCliSessionFlags(opts: {
  session?: unknown;
  noSession?: unknown;
}): NormalizedCliSessionFlags {
  return {
    session: typeof opts.session === 'string' ? opts.session : undefined,
    noSession: opts.noSession === true || opts.session === false,
  };
}

function resolveRepoIntelligenceModeFromEnv():
  | 'auto'
  | 'off'
  | 'light'
  | 'full'
  | undefined {
  const value = process.env.KODAX_REPO_INTELLIGENCE?.trim();
  if (value && KODAX_REPO_INTELLIGENCE_MODES.includes(value as KodaXRepoIntelligenceMode)) {
    return value as KodaXRepoIntelligenceMode;
  }
  return undefined;
}

function resolveRepoIntelligenceTraceFromEnv(): boolean | undefined {
  return process.env.KODAX_REPO_INTELLIGENCE_TRACE === '1'
    ? true
    : undefined;
}

export function parseOutputModeOption(value: string): CliOutputMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'json') {
    return normalized;
  }

  throw new InvalidArgumentError(
    `Expected "json". Text mode is the default and does not need --mode.`,
  );
}

export function parseRuntimeModeOption(value: string): CliRuntimeMode {
  const normalized = value.trim().toLowerCase();
  if ((CLI_RUNTIME_MODES as readonly string[]).includes(normalized)) {
    return normalized as CliRuntimeMode;
  }
  throw new InvalidArgumentError(
    `Expected one of: ${CLI_RUNTIME_MODES.join(', ')}.`,
  );
}

export function resolveCliProviderSelection(
  cliValue: string | undefined,
  envValue: string | undefined,
  configValue: string | undefined,
  defaultValue: string,
): string {
  return firstNonEmpty(cliValue, envValue, configValue) ?? defaultValue;
}

export function resolveCliRuntimeMode(
  cliValue: string | undefined,
  envValue: string | undefined,
  configValue: string | undefined,
): CliRuntimeMode {
  const value = firstNonEmpty(cliValue, envValue, configValue);
  return value === undefined ? 'embedded' : parseRuntimeModeOption(value);
}

function firstNonEmpty(...values: ReadonlyArray<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function normalizeSessionTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function findSessionTitleMatches<T extends { readonly title: string }>(
  sessions: readonly T[],
  title: string,
): T[] {
  const normalizedTitle = normalizeSessionTitle(title);
  if (!normalizedTitle) return [];
  return sessions.filter((session) => normalizeSessionTitle(session.title) === normalizedTitle);
}

export function validateCliModeSelection(
  cliOptions: CliOptions,
  extras: { resumeWithoutId?: boolean } = {},
): void {
  if (cliOptions.outputMode !== 'json') {
    return;
  }

  if (cliOptions.print) {
    throw new Error('`--mode json` cannot be combined with `-p/--print`. Pass the prompt as a positional argument instead.');
  }

  if (
    cliOptions.session === 'list'
    || cliOptions.session === 'delete'
    || cliOptions.session === 'delete-all'
    || cliOptions.session === 'cleanup-acp'
    || cliOptions.session?.startsWith('delete ')
  ) {
    throw new Error('`--mode json` does not support session management sub-modes.');
  }

  if (extras.resumeWithoutId) {
    throw new Error('`--mode json` requires an explicit session ID or exact title for `--resume`, or use `--continue`.');
  }

  if (!cliOptions.prompt?.length) {
    throw new Error('`--mode json` requires a prompt as positional arguments.');
  }
}

export function parsePermissionModeOption(value: string): AcpPermissionMode {
  if (value === 'auto-in-project') {
    return 'auto';
  }
  if (ACP_PERMISSION_MODES.includes(value as AcpPermissionMode)) {
    return value as AcpPermissionMode;
  }
  throw new InvalidArgumentError(
    `Expected one of: ${ACP_PERMISSION_MODES.join(', ')}.`,
  );
}

export function parseAgentModeOption(value: string): KodaXAgentMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'amaw' || normalized === 'ama-workflow') {
    throw new InvalidArgumentError(
      `Agent mode "${normalized}" was retired in v0.7.72. Use "ama"; `
      + 'Workflow activation is now explicit intent, not a separate mode.',
    );
  }
  if ((KODAX_AGENT_MODES as readonly string[]).includes(normalized)) {
    return normalized as KodaXAgentMode;
  }

  throw new InvalidArgumentError(
    `Expected one of: ${KODAX_AGENT_MODES.join(', ')}.`,
  );
}

export function parseReasoningModeOption(value: string): KodaXReasoningMode {
  const normalized = value.trim().toLowerCase();
  if (KODAX_REASONING_MODE_SEQUENCE.includes(normalized as KodaXReasoningMode)) {
    return normalized as KodaXReasoningMode;
  }

  throw new InvalidArgumentError(
    `Expected one of: ${KODAX_REASONING_MODE_SEQUENCE.join(', ')}.`,
  );
}

export function parseEffortOption(value: string): string {
  try {
    return normalizeReasoningEffortValue(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidArgumentError(message);
  }
}

export function parseRepoIntelligenceModeOption(value: string): KodaXRepoIntelligenceMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'full') {
    return 'full';
  }
  if (normalized === 'light') {
    return 'light';
  }
  if (KODAX_REPO_INTELLIGENCE_MODES.includes(normalized as KodaXRepoIntelligenceMode)) {
    return normalized as KodaXRepoIntelligenceMode;
  }

  throw new InvalidArgumentError(
    `Expected one of: ${KODAX_REPO_INTELLIGENCE_PUBLIC_MODES.join(', ')}.`,
  );
}

export function resolveCliReasoningMode(
  program: Command,
  opts: Record<string, unknown>,
  config: { reasoningMode?: KodaXReasoningMode; thinking?: boolean },
): KodaXReasoningMode {
  const reasoningSource = program.getOptionValueSource('reasoning');
  if (reasoningSource === 'cli' && typeof opts.reasoning === 'string') {
    return parseReasoningModeOption(opts.reasoning);
  }

  const thinkingSource = program.getOptionValueSource('thinking');
  if (thinkingSource === 'cli' && opts.thinking === true) {
    return 'auto';
  }

  if (config.reasoningMode) {
    return config.reasoningMode;
  }

  if (config.thinking === true) {
    return 'auto';
  }

  return 'auto';
}

export function resolveCliEffort(
  program: Command,
  opts: Record<string, unknown>,
  config: { effort?: string },
): string | undefined {
  const effortSource = program.getOptionValueSource('effort');
  if (effortSource === 'cli' && typeof opts.effort === 'string') {
    return parseEffortOption(opts.effort);
  }

  const envEffort = parseReasoningEffortEnv(process.env.KODAX_EFFORT);
  if (envEffort.kind === 'value') {
    return envEffort.value;
  }

  if (config.effort) {
    return normalizeReasoningEffortValue(config.effort);
  }

  return undefined;
}

export function resolveCliAgentMode(
  program: Command,
  opts: Record<string, unknown>,
  config: { agentMode?: KodaXAgentMode },
): KodaXAgentMode {
  const agentModeSource = program.getOptionValueSource('agentMode');
  if (agentModeSource === 'cli' && typeof opts.agentMode === 'string') {
    if (opts.agentMode === 'amaw' || opts.agentMode === 'ama-workflow') {
      throw new Error(
        `Agent mode "${opts.agentMode}" was retired in v0.7.72. Use "ama"; `
        + 'Workflow activation is now explicit intent.',
      );
    }
    if (!(KODAX_AGENT_MODES as readonly string[]).includes(opts.agentMode)) {
      throw new Error(
        `Invalid agent mode "${opts.agentMode}". Expected one of: ${KODAX_AGENT_MODES.join(', ')}`,
      );
    }
    return opts.agentMode as KodaXAgentMode;
  }

  return config.agentMode === 'amaw' ? 'ama' : config.agentMode ?? 'ama';
}

export function resolveCliModelSelection(
  requestedProvider: string | undefined,
  requestedModel: string | undefined,
  configuredProvider: string | undefined,
  configuredModel: string | undefined,
): string | undefined {
  if (requestedModel) {
    return requestedModel;
  }

  if (!configuredModel) {
    return undefined;
  }

  if (!requestedProvider) {
    return configuredModel;
  }

  if (!configuredProvider) {
    // If the user explicitly switches providers, only preserve a configured
    // model when we know it belongs to the same provider. Providerless saved
    // models are ambiguous and can silently target an incompatible backend.
    return undefined;
  }

  return requestedProvider === configuredProvider
    ? configuredModel
    : undefined;
}

export function parseOptionalNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidArgumentError(
      `Expected a non-negative integer, got "${value}".`,
    );
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(
      `Expected a non-negative integer, got "${value}".`,
    );
  }

  return parsed;
}

export function createKodaXOptions(cliOptions: CliOptions, isPrintMode = false): KodaXOptions {
  return {
    provider: cliOptions.provider,
    model: cliOptions.model,
    effort: cliOptions.effort,
    thinking: cliOptions.effort === 'none' ? false : cliOptions.thinking,
    reasoningMode: cliOptions.effort === 'none' ? 'off' : cliOptions.reasoningMode,
    agentMode: cliOptions.agentMode,
    maxIter: cliOptions.maxIter,
    extensionRuntime: cliOptions.extensionRuntime,
    session: buildSessionOptions(cliOptions),
    context: {
      repoIntelligenceMode: resolveRepoIntelligenceModeFromEnv(),
      repoIntelligenceTrace: resolveRepoIntelligenceTraceFromEnv(),
    },
    events: cliOptions.outputMode === 'json'
      ? createJsonEvents()
      : createCliEvents(!isPrintMode),
  };
}

export function buildSessionOptions(
  cliOptions: CliOptions,
): { id?: string; resume?: boolean; storage: FileSessionStorage; autoResume?: boolean; scope: 'user' } | undefined {
  const storage = new FileSessionStorage({ cwd: process.cwd() });

  if ((cliOptions.print || cliOptions.outputMode === 'json') && cliOptions.noSession) {
    return undefined;
  }

  if (cliOptions.resume) {
    return { id: cliOptions.resume, storage, scope: 'user' };
  }

  if (cliOptions.continue) {
    return { resume: true, storage, scope: 'user' };
  }

  if (cliOptions.session === 'resume') {
    return { resume: true, storage, scope: 'user' };
  }

  if (
    cliOptions.session
    && cliOptions.session !== 'list'
    && cliOptions.session !== 'delete'
    && cliOptions.session !== 'delete-all'
    && !cliOptions.session.startsWith('delete ')
  ) {
    return { id: cliOptions.session, storage, scope: 'user' };
  }

  if (cliOptions.print) {
    return { storage, scope: 'user' };
  }

  if (!cliOptions.prompt?.length) {
    return { storage, scope: 'user' };
  }

  return { storage, scope: 'user' };
}
