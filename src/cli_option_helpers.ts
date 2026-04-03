import { Command, InvalidArgumentError } from 'commander';
import {
  KodaXAgentMode,
  KodaXOptions,
  KodaXExtensionRuntime,
  KodaXReasoningMode,
  KODAX_REASONING_MODE_SEQUENCE,
} from '@kodax/coding';
import {
  createCliEvents,
  createJsonEvents,
  FileSessionStorage,
  type PermissionMode,
} from '@kodax/repl';

export const ACP_PERMISSION_MODES: PermissionMode[] = ['plan', 'accept-edits', 'auto-in-project'];
export const CLI_OUTPUT_MODES = ['text', 'json'] as const;
export const KODAX_AGENT_MODES = ['ama', 'sa'] as const;
export type CliOutputMode = typeof CLI_OUTPUT_MODES[number];

export interface CliOptions {
  provider: string;
  model?: string;
  thinking: boolean;
  reasoningMode: KodaXReasoningMode;
  agentMode: KodaXAgentMode;
  outputMode: CliOutputMode;
  extensions?: string[];
  extensionRuntime?: KodaXExtensionRuntime;
  session?: string;
  parallel: boolean;
  team?: string;
  init?: string;
  append: boolean;
  overwrite: boolean;
  maxIter?: number;
  autoContinue: boolean;
  maxSessions: number;
  maxHours: number;
  prompt: string[];
  continue?: boolean;
  resume?: string;
  noSession: boolean;
  print?: boolean;
}

function resolveRepoIntelligenceModeFromEnv():
  | 'auto'
  | 'off'
  | 'oss'
  | 'premium-shared'
  | 'premium-native'
  | undefined {
  const value = process.env.KODAX_REPO_INTELLIGENCE_MODE?.trim();
  if (
    value === 'auto'
    || value === 'off'
    || value === 'oss'
    || value === 'premium-shared'
    || value === 'premium-native'
  ) {
    return value;
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

  if (cliOptions.init || cliOptions.autoContinue || cliOptions.team) {
    throw new Error('`--mode json` currently supports single non-interactive agent runs only.');
  }

  if (
    cliOptions.session === 'list'
    || cliOptions.session === 'delete-all'
    || cliOptions.session?.startsWith('delete ')
  ) {
    throw new Error('`--mode json` does not support session management sub-modes.');
  }

  if (extras.resumeWithoutId) {
    throw new Error('`--mode json` requires an explicit session id for `--resume`, or use `--continue`.');
  }

  if (!cliOptions.prompt?.length) {
    throw new Error('`--mode json` requires a prompt as positional arguments.');
  }
}

export function parsePermissionModeOption(value: string): PermissionMode {
  if (ACP_PERMISSION_MODES.includes(value as PermissionMode)) {
    return value as PermissionMode;
  }

  throw new InvalidArgumentError(
    `Expected one of: ${ACP_PERMISSION_MODES.join(', ')}.`,
  );
}

export function parseAgentModeOption(value: string): KodaXAgentMode {
  const normalized = value.trim().toLowerCase();
  if ((KODAX_AGENT_MODES as readonly string[]).includes(normalized)) {
    return normalized as KodaXAgentMode;
  }

  throw new InvalidArgumentError(
    `Expected one of: ${KODAX_AGENT_MODES.join(', ')}.`,
  );
}

export function resolveCliReasoningMode(
  program: Command,
  opts: Record<string, unknown>,
  config: { reasoningMode?: KodaXReasoningMode; thinking?: boolean },
): KodaXReasoningMode {
  const reasoningSource = program.getOptionValueSource('reasoning');
  if (reasoningSource === 'cli' && typeof opts.reasoning === 'string') {
    if (!KODAX_REASONING_MODE_SEQUENCE.includes(opts.reasoning as KodaXReasoningMode)) {
      throw new Error(
        `Invalid reasoning mode "${opts.reasoning}". Expected one of: ${KODAX_REASONING_MODE_SEQUENCE.join(', ')}`,
      );
    }
    return opts.reasoning as KodaXReasoningMode;
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

export function resolveCliParallel(
  program: Command,
  opts: Record<string, unknown>,
  config: { parallel?: boolean },
): boolean {
  const parallelSource = program.getOptionValueSource('parallel');
  if (parallelSource === 'cli') {
    return opts.parallel === true;
  }

  return config.parallel ?? false;
}

export function resolveCliAgentMode(
  program: Command,
  opts: Record<string, unknown>,
  config: { agentMode?: KodaXAgentMode },
): KodaXAgentMode {
  const agentModeSource = program.getOptionValueSource('agentMode');
  if (agentModeSource === 'cli' && typeof opts.agentMode === 'string') {
    if (!(KODAX_AGENT_MODES as readonly string[]).includes(opts.agentMode)) {
      throw new Error(
        `Invalid agent mode "${opts.agentMode}". Expected one of: ${KODAX_AGENT_MODES.join(', ')}`,
      );
    }
    return opts.agentMode as KodaXAgentMode;
  }

  return config.agentMode ?? 'ama';
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

export function mergeConfiguredExtensions(
  cliExtensions: string[] = [],
  configExtensions: string[] = [],
): string[] {
  const merged: string[] = [];

  for (const value of [...configExtensions, ...cliExtensions]) {
    const normalized = value.trim();
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }

  return merged;
}

export function parseOptionalNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError(
      `Expected a non-negative integer, got "${value}".`,
    );
  }

  return parsed;
}

export function parseNonNegativeIntWithFallback(value: string | undefined, fallback: number): number {
  return parseOptionalNonNegativeInt(value) ?? fallback;
}

export function parsePositiveNumberWithFallback(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(
      `Expected a positive number, got "${value}".`,
    );
  }

  return parsed;
}

export function createKodaXOptions(cliOptions: CliOptions, isPrintMode = false): KodaXOptions {
  return {
    provider: cliOptions.provider,
    model: cliOptions.model,
    thinking: cliOptions.thinking,
    reasoningMode: cliOptions.reasoningMode,
    agentMode: cliOptions.agentMode,
    maxIter: cliOptions.maxIter,
    parallel: cliOptions.parallel,
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
  const storage = new FileSessionStorage();

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
