import type {
  KodaXBaseProvider,
  KodaXMessage,
  KodaXReasoningMode,
} from '@kodax/ai';
import type {
  KodaXExtensionSessionRecord,
  KodaXExtensionStore,
  KodaXJsonValue,
} from '../types.js';
import type {
  LocalToolDefinition,
  RegisteredToolDefinition,
} from '../tools/types.js';

export type CapabilityKind = 'tool' | 'resource' | 'prompt';

export interface CapabilityResult {
  kind: CapabilityKind;
  content?: string;
  structuredContent?: unknown;
  evidence?: unknown[];
  artifacts?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface CapabilityProvider {
  id: string;
  kinds: CapabilityKind[];
  search?: (
    query: string,
    options?: { kind?: CapabilityKind; limit?: number; server?: string },
  ) => Promise<unknown[]>;
  describe?: (id: string) => Promise<unknown>;
  execute?: (id: string, input: Record<string, unknown>) => Promise<CapabilityResult>;
  read?: (id: string, options?: Record<string, unknown>) => Promise<CapabilityResult>;
  getPrompt?: (id: string, args?: Record<string, unknown>) => Promise<unknown>;
  getPromptContext?: () => Promise<string | undefined> | string | undefined;
  getDiagnostics?: () => Record<string, unknown> | undefined;
  refresh?: () => Promise<void>;
  dispose?: () => Promise<void>;
}

export interface ModelProviderRegistration {
  name: string;
  factory: () => KodaXBaseProvider;
}

export interface ExtensionCommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  metadata?: Record<string, unknown>;
  handler: (
    args: string[],
    context: ExtensionCommandContext,
  ) => Promise<ExtensionCommandResult | void> | ExtensionCommandResult | void;
}

export interface ExtensionModelSelection {
  provider?: string;
  model?: string;
}

export interface ExtensionLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface ExtensionFileContributionSource {
  kind: 'extension';
  id: string;
  label: string;
  path: string;
}

export interface RuntimeContributionSource {
  kind: 'runtime';
  id: string;
  label: string;
  path?: string;
}

export type ExtensionContributionSource =
  | ExtensionFileContributionSource
  | RuntimeContributionSource;

export type ExtensionLoadSource = 'api' | 'cli' | 'config';

export interface LoadedExtensionDiagnostic {
  path: string;
  label: string;
  loadSource: ExtensionLoadSource;
  sessionStateKeys?: string[];
  sessionRecordCounts?: Record<string, number>;
}

export interface RegisteredCapabilityProviderDiagnostic {
  id: string;
  kinds: CapabilityKind[];
  source: ExtensionContributionSource;
  metadata?: Record<string, unknown>;
}

export interface RegisteredCommandDiagnostic {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  metadata?: Record<string, unknown>;
  source: ExtensionContributionSource;
}

export interface RegisteredToolDiagnostic {
  name: string;
  description: string;
  requiredParams: string[];
  source: RegisteredToolDefinition['source'];
  shadowedSources: RegisteredToolDefinition['source'][];
}

export interface RegisteredHookDiagnostic {
  hook: keyof ExtensionHookMap;
  order: number;
  source: ExtensionContributionSource;
}

export type ExtensionFailureStage = 'load' | 'reload' | 'event' | 'hook' | 'persistence';

export interface ExtensionFailureDiagnostic {
  stage: ExtensionFailureStage;
  target: string;
  message: string;
  occurredAt: string;
  source: ExtensionContributionSource;
}

export interface ExtensionRuntimeDiagnostics {
  loadedExtensions: LoadedExtensionDiagnostic[];
  capabilityProviders: RegisteredCapabilityProviderDiagnostic[];
  commands: RegisteredCommandDiagnostic[];
  tools: RegisteredToolDiagnostic[];
  hooks: RegisteredHookDiagnostic[];
  failures: ExtensionFailureDiagnostic[];
  defaults: {
    activeTools?: string[];
    modelSelection: ExtensionModelSelection;
    thinkingLevel?: KodaXReasoningMode;
  };
}

export interface ExtensionCommandInvocation {
  prompt: string;
  displayName?: string;
  disableModelInvocation?: boolean;
  allowedTools?: string;
  context?: 'fork';
  model?: string;
}

export interface ExtensionCommandResult {
  success?: boolean;
  message?: string;
  data?: unknown;
  invocation?: ExtensionCommandInvocation;
}

export interface ExtensionCommandContext {
  sessionId?: string;
  gitRoot?: string;
  workingDirectory: string;
  reloadExtensions: () => Promise<void>;
  getDiagnostics: () => ExtensionRuntimeDiagnostics;
  logger: ExtensionLogger;
}

export interface ExtensionToolBeforeHookContext {
  name: string;
  input: Record<string, unknown>;
  toolId?: string;
  executionCwd?: string;
  gitRoot?: string;
}

export interface ExtensionProviderBeforeHookContext {
  provider: string;
  model?: string;
  reasoningMode?: KodaXReasoningMode;
  systemPrompt: string;
  block: (reason: string) => void;
  replaceProvider: (provider: string) => void;
  replaceModel: (model?: string) => void;
  replaceSystemPrompt: (systemPrompt: string) => void;
  setThinkingLevel: (level: KodaXReasoningMode) => void;
}

export interface ExtensionTurnSettleHookContext {
  sessionId: string;
  lastText: string;
  hadToolCalls: boolean;
  success: boolean;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  queueUserMessage: (message: string | KodaXMessage) => void;
  setModelSelection: (next: ExtensionModelSelection) => void;
  setThinkingLevel: (level: KodaXReasoningMode) => void;
}

export interface ExtensionSessionHydrateHookContext {
  sessionId: string;
  getState: <T = KodaXJsonValue>(key: string) => T | undefined;
  setState: (key: string, value: KodaXJsonValue | undefined) => void;
  listRecords: (type?: string) => KodaXExtensionSessionRecord[];
  appendRecord: (
    type: string,
    data?: KodaXJsonValue,
    options?: { dedupeKey?: string },
  ) => KodaXExtensionSessionRecord | undefined;
  clearRecords: (type?: string) => number;
}

export interface ExtensionEventMap {
  'session:start': { provider: string; sessionId: string };
  'turn:start': { sessionId: string; iteration: number; maxIter: number };
  'text:delta': { text: string };
  'thinking:delta': { text: string };
  'thinking:end': { thinking: string };
  'tool:start': { name: string; id: string; input?: Record<string, unknown> };
  'tool:result': { id: string; name: string; content: string };
  'provider:selected': { provider: string; model?: string };
  'provider:rate-limit': { provider: string; attempt: number; maxRetries: number; delayMs: number };
  'capability:search': { providerId: string; query: string; kind?: CapabilityKind; limit?: number };
  'capability:describe': { providerId: string; capabilityId: string };
  'capability:invoke': { providerId: string; capabilityId: string; kind: CapabilityKind };
  'capability:refresh': { providerId: string };
  'stream:end': undefined;
  'turn:end': {
    sessionId: string;
    iteration: number;
    lastText: string;
    hadToolCalls: boolean;
    signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  };
  'complete': { success: boolean; signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE' };
  'error': { error: Error };
}

export interface ExtensionHookMap {
  'tool:before': (
    context: ExtensionToolBeforeHookContext,
  ) => Promise<void | string | false> | void | string | false;
  'provider:before': (
    context: ExtensionProviderBeforeHookContext,
  ) => Promise<void> | void;
  'turn:settle': (
    context: ExtensionTurnSettleHookContext,
  ) => Promise<void> | void;
  'session:hydrate': (
    context: ExtensionSessionHydrateHookContext,
  ) => Promise<void> | void;
}

export interface ExtensionRuntimeController {
  queueUserMessage(message: string | KodaXMessage): void;
  getSessionState<T = KodaXJsonValue>(key: string): T | undefined;
  setSessionState(key: string, value: KodaXJsonValue | undefined): void;
  appendSessionRecord(
    type: string,
    data?: KodaXJsonValue,
    options?: { dedupeKey?: string },
  ): KodaXExtensionSessionRecord | undefined;
  listSessionRecords(type?: string): KodaXExtensionSessionRecord[];
  clearSessionRecords(type?: string): number;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  getModelSelection(): ExtensionModelSelection;
  setModelSelection(next: ExtensionModelSelection): void;
  getThinkingLevel(): KodaXReasoningMode | undefined;
  setThinkingLevel(level: KodaXReasoningMode): void;
}

export interface KodaXExtensionAPI {
  registerTool: (definition: LocalToolDefinition) => () => void;
  getTool: (name: string) => RegisteredToolDefinition | undefined;
  getBuiltinTool: (name: string) => RegisteredToolDefinition | undefined;
  registerModelProvider: (registration: ModelProviderRegistration) => () => void;
  registerCapabilityProvider: (provider: CapabilityProvider) => () => void;
  registerCommand: (command: ExtensionCommandDefinition) => () => void;
  registerSkillPath: (skillPath: string) => () => void;
  on: <TEvent extends keyof ExtensionEventMap>(
    event: TEvent,
    handler: (payload: ExtensionEventMap[TEvent]) => Promise<void> | void,
  ) => () => void;
  hook: <THook extends keyof ExtensionHookMap>(
    hook: THook,
    handler: ExtensionHookMap[THook],
  ) => () => void;
  logger: ExtensionLogger;
  config: Readonly<Record<string, unknown>>;
  runtime: ExtensionRuntimeController;
  /** Extension-scoped key-value store that persists across sessions. */
  persistence: KodaXExtensionStore;
}

export type KodaXExtensionActivationResult =
  | void
  | (() => void | Promise<void>)
  | Promise<void | (() => void | Promise<void>)>;

export interface KodaXExtensionModule {
  default?: (api: KodaXExtensionAPI) => KodaXExtensionActivationResult;
  activate?: (api: KodaXExtensionAPI) => KodaXExtensionActivationResult;
}
