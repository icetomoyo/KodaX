import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import type { KodaXMessage, KodaXReasoningMode } from '@kodax/ai';
import {
  registerModelProvider,
} from '@kodax/ai';
import {
  registerPluginSkillPath,
} from '@kodax/skills';
import { tsImport } from 'tsx/esm/api';
import {
  getBuiltinRegisteredToolDefinition,
  getRegisteredToolDefinition,
  getToolRegistrations,
  listTools,
  registerTool,
} from '../tools/index.js';
import type {
  LocalToolDefinition,
  ToolRegistrationOptions,
} from '../tools/types.js';
import type {
  KodaXExtensionSessionRecord,
  KodaXExtensionStore,
  KodaXJsonValue,
} from '../types.js';
import { createExtensionStore } from '@kodax/agent';
import type {
  CapabilityProvider,
  ExtensionContributionSource,
  ExtensionFileContributionSource,
  ExtensionCommandDefinition,
  ExtensionEventMap,
  ExtensionFailureDiagnostic,
  ExtensionFailureStage,
  ExtensionHookMap,
  ExtensionLoadSource,
  ExtensionLogger,
  ExtensionModelSelection,
  ExtensionRuntimeDiagnostics,
  ExtensionRuntimeController,
  KodaXExtensionAPI,
  KodaXExtensionModule,
  ModelProviderRegistration,
} from './types.js';

type Disposable = () => void | Promise<void>;

interface RuntimeRecord<T> {
  id: string;
  value: T;
  source: ExtensionContributionSource;
}

interface LoadedExtensionRecord {
  path: string;
  label: string;
  loadSource: ExtensionLoadSource;
  disposeAll: () => Promise<void>;
}

interface RuntimeDefaultsSnapshot {
  activeTools?: string[];
  modelSelection: ExtensionModelSelection;
  thinkingLevel?: KodaXReasoningMode;
}

interface BoundExtensionRuntimeController {
  queueUserMessage(message: string | KodaXMessage): void;
  getSessionState<T = KodaXJsonValue>(extensionId: string, key: string): T | undefined;
  setSessionState(extensionId: string, key: string, value: KodaXJsonValue | undefined): void;
  getSessionStateSnapshot(extensionId: string): Record<string, KodaXJsonValue>;
  appendSessionRecord(
    extensionId: string,
    type: string,
    data?: KodaXJsonValue,
    options?: { dedupeKey?: string },
  ): KodaXExtensionSessionRecord;
  listSessionRecords(extensionId: string, type?: string): KodaXExtensionSessionRecord[];
  clearSessionRecords(extensionId: string, type?: string): number;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  getModelSelection(): ExtensionModelSelection;
  setModelSelection(next: ExtensionModelSelection): void;
  getThinkingLevel(): KodaXReasoningMode | undefined;
  setThinkingLevel(level: KodaXReasoningMode): void;
}

interface ExtensionLoadOptions {
  continueOnError?: boolean;
  loadSource?: ExtensionLoadSource;
  stage?: Extract<ExtensionFailureStage, 'load' | 'reload'>;
}

let activeExtensionRuntime: KodaXExtensionRuntime | null = null;

function dedupeStrings(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || result.includes(normalized)) {
      continue;
    }
    result.push(normalized);
  }
  return result;
}

function normalizeQueuedMessage(message: string | KodaXMessage): KodaXMessage {
  return typeof message === 'string'
    ? { role: 'user', content: message }
    : message;
}

function normalizeModelSelection(
  selection: ExtensionModelSelection,
): ExtensionModelSelection {
  const normalized: ExtensionModelSelection = {};
  if (selection.provider?.trim()) {
    normalized.provider = selection.provider.trim();
  }
  if (selection.model?.trim()) {
    normalized.model = selection.model.trim();
  }
  return normalized;
}

function isJsonValue(value: unknown): value is KodaXJsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

export class KodaXExtensionRuntime {
  private readonly capabilityProviders = new Map<string, RuntimeRecord<CapabilityProvider>[]>();
  private readonly commands = new Map<string, RuntimeRecord<ExtensionCommandDefinition>[]>();
  private readonly eventHandlers = new Map<string, RuntimeRecord<(payload: unknown) => Promise<void> | void>[]>();
  private readonly hookHandlers = new Map<string, RuntimeRecord<(payload: unknown) => Promise<unknown> | unknown>[]>();
  private readonly loadedExtensions = new Map<string, LoadedExtensionRecord>();
  private readonly failures: ExtensionFailureDiagnostic[] = [];
  private readonly runtimeDisposables: Disposable[] = [];
  private readonly runtimeLogger: ExtensionLogger;
  private readonly config: Readonly<Record<string, unknown>>;
  private readonly runtimeController: BoundExtensionRuntimeController;
  private nextRecordId = 0;
  private boundController: BoundExtensionRuntimeController | null = null;
  private defaultActiveTools: string[] | undefined;
  private defaultModelSelection: ExtensionModelSelection = {};
  private defaultThinkingLevel: KodaXReasoningMode | undefined;

  constructor(options: { config?: Readonly<Record<string, unknown>> } = {}) {
    this.config = options.config ?? {};
    this.runtimeLogger = {
      debug: (...args) => console.debug('[kodax:extension]', ...args),
      info: (...args) => console.info('[kodax:extension]', ...args),
      warn: (...args) => console.warn('[kodax:extension]', ...args),
      error: (...args) => console.error('[kodax:extension]', ...args),
    };
    this.runtimeController = this.createRuntimeControllerProxy();
  }

  activate(): this {
    activeExtensionRuntime = this;
    return this;
  }

  getDefaults(): RuntimeDefaultsSnapshot {
    return {
      activeTools: this.defaultActiveTools === undefined
        ? undefined
        : [...this.defaultActiveTools],
      modelSelection: { ...this.defaultModelSelection },
      thinkingLevel: this.defaultThinkingLevel,
    };
  }

  bindController(controller: BoundExtensionRuntimeController): () => void {
    const previous = this.boundController;
    this.boundController = controller;
    return () => {
      this.boundController = previous;
    };
  }

  async dispose(): Promise<void> {
    for (const loaded of Array.from(this.loadedExtensions.values()).reverse()) {
      await loaded.disposeAll();
    }
    this.loadedExtensions.clear();
    for (const dispose of this.runtimeDisposables.reverse()) {
      await dispose();
    }
    this.runtimeDisposables.length = 0;
    this.failures.length = 0;
    this.boundController = null;

    if (activeExtensionRuntime === this) {
      activeExtensionRuntime = null;
    }
  }

  async loadExtensions(paths: string[], options: ExtensionLoadOptions = {}): Promise<void> {
    for (const extensionPath of paths) {
      try {
        await this.loadExtension(extensionPath, {
          loadSource: options.loadSource,
          stage: options.stage ?? 'load',
        });
      } catch (error) {
        if (!options.continueOnError) {
          throw error;
        }
        this.runtimeLogger.warn(
          `Failed to load extension "${extensionPath}" during ${options.stage ?? 'load'}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async loadExtension(extensionPath: string, options: ExtensionLoadOptions = {}): Promise<void> {
    const resolvedPath = path.resolve(extensionPath);
    try {
      await fs.access(resolvedPath);
      const existing = this.loadedExtensions.get(resolvedPath);
      const loadSource = options.loadSource ?? existing?.loadSource ?? 'api';

      const module = await this.importExtensionModule(resolvedPath);
      const defaultExport = module.default as unknown;
      const nestedDefault =
        defaultExport && typeof defaultExport === 'object' && 'default' in defaultExport
          ? (defaultExport as { default?: unknown }).default
          : undefined;
      const nestedActivate =
        defaultExport && typeof defaultExport === 'object' && 'activate' in defaultExport
          ? (defaultExport as { activate?: unknown }).activate
          : undefined;
      const activate = typeof defaultExport === 'function'
        ? defaultExport
        : typeof nestedDefault === 'function'
          ? nestedDefault
          : typeof module.activate === 'function'
            ? module.activate
            : typeof nestedActivate === 'function'
              ? nestedActivate
              : undefined;

      if (!activate) {
        throw new Error(
          `Extension "${resolvedPath}" must export a default function or named activate() function.`,
        );
      }

      try {
        const disposables: Disposable[] = [];
        const api = this.createExtensionApi(resolvedPath, disposables, loadSource);
        const nextRecord: LoadedExtensionRecord = {
          path: resolvedPath,
          label: path.basename(resolvedPath),
          loadSource,
          disposeAll: async () => {
            for (const dispose of disposables.reverse()) {
              await dispose();
            }
          },
        };

        try {
          const cleanup = await activate(api);
          if (typeof cleanup === 'function') {
            disposables.push(cleanup);
          }
        } catch (error) {
          await nextRecord.disposeAll();
          throw error;
        }

        if (existing) {
          try {
            await existing.disposeAll();
          } catch (error) {
            await nextRecord.disposeAll();
            throw error;
          }
        }

        this.loadedExtensions.set(resolvedPath, nextRecord);
      } catch (error) {
        throw error;
      }
    } catch (error) {
      this.recordFailure(
        options.stage ?? (this.loadedExtensions.has(resolvedPath) ? 'reload' : 'load'),
        resolvedPath,
        this.createExtensionSource(
          resolvedPath,
          options.loadSource ?? this.loadedExtensions.get(resolvedPath)?.loadSource ?? 'api',
        ),
        error,
      );
      throw error;
    }
  }

  async reloadExtensions(
    options: Pick<ExtensionLoadOptions, 'continueOnError'> = { continueOnError: true },
  ): Promise<void> {
    const extensionPaths = Array.from(this.loadedExtensions.keys());
    for (const extensionPath of extensionPaths) {
      try {
        await this.loadExtension(extensionPath, {
          loadSource: this.loadedExtensions.get(extensionPath)?.loadSource,
          stage: 'reload',
        });
      } catch (error) {
        if (!options.continueOnError) {
          throw error;
        }
        this.runtimeLogger.warn(
          `Failed to reload extension "${extensionPath}":`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  listCapabilityProviders(): CapabilityProvider[] {
    return Array.from(this.capabilityProviders.values())
      .map((records) => records[records.length - 1]?.value)
      .filter((provider): provider is CapabilityProvider => provider !== undefined);
  }

  registerCapabilityProvider(
    provider: CapabilityProvider,
    options: { source?: ExtensionContributionSource } = {},
  ): () => void {
    const source = options.source ?? this.createRuntimeSource(
      `runtime:capability:${provider.id}`,
      provider.id,
    );
    const dispose = this.registerRecord(
      this.capabilityProviders,
      provider.id,
      provider,
      source,
      this.runtimeDisposables,
    );
    if (provider.dispose) {
      this.runtimeDisposables.push(() => provider.dispose?.());
    }
    return dispose;
  }

  registerTool(
    definition: LocalToolDefinition,
    options: ToolRegistrationOptions = {},
  ): () => void {
    const source = options.source ?? {
      kind: 'extension' as const,
      id: `runtime:tool:${definition.name}`,
      label: definition.name,
    };
    const dispose = registerTool(definition, { source });
    this.runtimeDisposables.push(dispose);
    return dispose;
  }

  registerHook<THook extends keyof ExtensionHookMap>(
    hook: THook,
    handler: ExtensionHookMap[THook],
    options: { source?: ExtensionContributionSource } = {},
  ): () => void {
    const source = options.source ?? this.createRuntimeSource(
      `runtime:hook:${String(hook)}`,
      String(hook),
    );
    const dispose = this.registerHookHandler(hook, handler, source);
    this.runtimeDisposables.push(dispose);
    return dispose;
  }

  listCommands(): ExtensionCommandDefinition[] {
    return Array.from(this.commands.values())
      .map((records) => records[records.length - 1]?.value)
      .filter((command): command is ExtensionCommandDefinition => command !== undefined);
  }

  getCommand(name: string): ExtensionCommandDefinition | undefined {
    const normalized = name.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    return this.listCommands().find((command) =>
      command.name.trim().toLowerCase() === normalized
      || (command.aliases ?? []).some((alias) => alias.trim().toLowerCase() === normalized),
    );
  }

  getDiagnostics(): ExtensionRuntimeDiagnostics {
    const capabilityProviders = Array.from(this.capabilityProviders.entries())
      .map(([providerId, records]) => {
        const active = records[records.length - 1];
        if (!active) {
          return undefined;
        }
        return {
          id: providerId,
          kinds: [...active.value.kinds],
          source: { ...active.source },
          metadata: active.value.getDiagnostics?.(),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id));

    const commands = Array.from(this.commands.entries())
      .map(([name, records]) => {
        const active = records[records.length - 1];
        if (!active) {
          return undefined;
        }
        return {
          name,
          aliases: active.value.aliases,
          description: active.value.description,
          usage: active.value.usage,
          metadata: active.value.metadata,
          source: { ...active.source },
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name));

    const tools = listTools()
      .map((name) => {
        const registrations = getToolRegistrations(name);
        const definition = registrations[registrations.length - 1];
        if (!definition) {
          return undefined;
        }
        return {
          name: definition.name,
          description: definition.description,
          requiredParams: [...definition.requiredParams],
          source: { ...definition.source },
          shadowedSources: registrations
            .slice(0, -1)
            .map((registration) => ({ ...registration.source })),
        };
      })
      .filter((definition): definition is NonNullable<typeof definition> => definition !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name));

    const loadedExtensions = Array.from(this.loadedExtensions.values())
      .map((loaded) => {
        const sessionStateKeys = this.boundController
          ? Object.keys(this.boundController.getSessionStateSnapshot(
            this.createExtensionSource(loaded.path, loaded.loadSource).id,
          )).sort((left, right) => left.localeCompare(right))
          : undefined;
        const sessionRecordCounts = this.boundController
          ? this.boundController
            .listSessionRecords(this.createExtensionSource(loaded.path, loaded.loadSource).id)
            .reduce<Record<string, number>>((counts, record) => {
              counts[record.type] = (counts[record.type] ?? 0) + 1;
              return counts;
            }, {})
          : undefined;

        return {
          path: loaded.path,
          label: loaded.label,
          loadSource: loaded.loadSource,
          sessionStateKeys: sessionStateKeys && sessionStateKeys.length > 0
            ? sessionStateKeys
            : undefined,
          sessionRecordCounts: sessionRecordCounts && Object.keys(sessionRecordCounts).length > 0
            ? sessionRecordCounts
            : undefined,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));

    const hooks = Array.from(this.hookHandlers.entries())
      .flatMap(([hook, records]) => records.map((record, index) => ({
        hook: hook as keyof ExtensionHookMap,
        order: index + 1,
        source: { ...record.source },
      })))
      .sort((left, right) => {
        const byHook = left.hook.localeCompare(right.hook);
        if (byHook !== 0) {
          return byHook;
        }
        return left.order - right.order;
      });

    return {
      loadedExtensions,
      capabilityProviders,
      commands,
      tools,
      hooks,
      failures: this.failures.map((failure) => ({
        ...failure,
        source: { ...failure.source },
      })),
      defaults: this.getDefaults(),
    };
  }

  getCapabilityProvider(providerId: string): CapabilityProvider | undefined {
    const records = this.capabilityProviders.get(providerId);
    if (!records || records.length === 0) {
      return undefined;
    }
    return records[records.length - 1]?.value;
  }

  async searchCapabilities(
    providerId: string,
    query: string,
    options: { kind?: CapabilityProvider['kinds'][number]; limit?: number; server?: string } = {},
  ): Promise<unknown[]> {
    const provider = this.getCapabilityProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown capability provider: ${providerId}`);
    }
    if (!provider.search) {
      return [];
    }

    await this.emit('capability:search', {
      providerId,
      query,
      kind: options.kind,
      limit: options.limit,
    });
    return provider.search(query, options);
  }

  async describeCapability(
    providerId: string,
    capabilityId: string,
  ): Promise<unknown> {
    const provider = this.getCapabilityProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown capability provider: ${providerId}`);
    }

    await this.emit('capability:describe', { providerId, capabilityId });
    return provider.describe?.(capabilityId);
  }

  async executeCapability(
    providerId: string,
    capabilityId: string,
    input: Record<string, unknown>,
  ): Promise<import('./types.js').CapabilityResult> {
    const provider = this.getCapabilityProvider(providerId);
    if (!provider?.execute) {
      throw new Error(`Capability provider "${providerId}" does not implement execute().`);
    }

    await this.emit('capability:invoke', {
      providerId,
      capabilityId,
      kind: 'tool',
    });
    return provider.execute(capabilityId, input);
  }

  async readCapability(
    providerId: string,
    capabilityId: string,
    options: Record<string, unknown> = {},
  ): Promise<import('./types.js').CapabilityResult> {
    const provider = this.getCapabilityProvider(providerId);
    if (!provider?.read) {
      throw new Error(`Capability provider "${providerId}" does not implement read().`);
    }

    await this.emit('capability:invoke', {
      providerId,
      capabilityId,
      kind: 'resource',
    });
    return provider.read(capabilityId, options);
  }

  async getCapabilityPrompt(
    providerId: string,
    capabilityId: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const provider = this.getCapabilityProvider(providerId);
    if (!provider?.getPrompt) {
      throw new Error(`Capability provider "${providerId}" does not implement getPrompt().`);
    }

    await this.emit('capability:invoke', {
      providerId,
      capabilityId,
      kind: 'prompt',
    });
    return provider.getPrompt(capabilityId, args);
  }

  async getCapabilityPromptContext(
    providerId: string,
  ): Promise<string | undefined> {
    const provider = this.getCapabilityProvider(providerId);
    if (!provider?.getPromptContext) {
      return undefined;
    }
    return provider.getPromptContext();
  }

  async refreshCapabilityProviders(providerId?: string): Promise<void> {
    if (providerId) {
      const provider = this.getCapabilityProvider(providerId);
      if (!provider) {
        throw new Error(`Unknown capability provider: ${providerId}`);
      }
      await this.emit('capability:refresh', { providerId });
      await provider.refresh?.();
      return;
    }

    for (const provider of this.listCapabilityProviders()) {
      await this.emit('capability:refresh', { providerId: provider.id });
      await provider.refresh?.();
    }
  }

  async hydrateSession(sessionId: string): Promise<void> {
    const handlers = this.hookHandlers.get('session:hydrate');
    if (!handlers || handlers.length === 0) {
      return;
    }

    const controller = this.boundController;
    if (!controller) {
      throw new Error('Session hydration requires an active KodaX session binding.');
    }

    for (const handler of handlers) {
      try {
        const source = handler.source;
        const warnPersistence = (target: string, message: string) => {
          const error = new Error(message);
          this.recordFailure('persistence', target, source, error);
          this.runtimeLogger.warn(message);
        };
        await handler.value({
          sessionId,
          getState: <T = KodaXJsonValue>(key: string) => controller.getSessionState<T>(source.id, key),
          setState: (key: string, value: KodaXJsonValue | undefined) => {
            if (value !== undefined && !isJsonValue(value)) {
              warnPersistence(
                `sessionState:${key}`,
                `Ignoring non-JSON session state for "${source.label}" key "${key}".`,
              );
              return;
            }
            controller.setSessionState(source.id, key, value);
          },
          listRecords: (type?: string) => controller.listSessionRecords(source.id, type),
          appendRecord: (
            type: string,
            data?: KodaXJsonValue,
            options?: { dedupeKey?: string },
          ) => {
            const normalizedType = type.trim();
            if (!normalizedType) {
              warnPersistence(
                'sessionRecord',
                `Ignoring session record with an empty type for "${source.label}".`,
              );
              return undefined;
            }
            if (data !== undefined && !isJsonValue(data)) {
              warnPersistence(
                `sessionRecord:${normalizedType}`,
                `Ignoring non-JSON session record "${normalizedType}" for "${source.label}".`,
              );
              return undefined;
            }
            return controller.appendSessionRecord(source.id, normalizedType, data, options);
          },
          clearRecords: (type?: string) => controller.clearSessionRecords(source.id, type),
        });
      } catch (error) {
        this.recordFailure('hook', 'session:hydrate', handler.source, error);
        this.runtimeLogger.warn(
          'Extension hook failed for "session:hydrate":',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async emit<TEvent extends keyof ExtensionEventMap>(
    event: TEvent,
    payload: ExtensionEventMap[TEvent],
  ): Promise<void> {
    const handlers = this.eventHandlers.get(event);
    if (!handlers || handlers.length === 0) {
      return;
    }

    for (const handler of handlers) {
      try {
        await handler.value(payload);
      } catch (error) {
        this.recordFailure('event', event, handler.source, error);
        this.runtimeLogger.warn(
          `Extension event handler failed for "${event}":`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async runHook<THook extends keyof ExtensionHookMap>(
    hook: THook,
    payload: Parameters<ExtensionHookMap[THook]>[0],
  ): Promise<Awaited<ReturnType<ExtensionHookMap[THook]>> | undefined> {
    const handlers = this.hookHandlers.get(hook);
    if (!handlers || handlers.length === 0) {
      return undefined;
    }

    for (const handler of handlers) {
      try {
        const result = await handler.value(payload);
        if (result !== undefined) {
          return result as Awaited<ReturnType<ExtensionHookMap[THook]>>;
        }
      } catch (error) {
        this.recordFailure('hook', hook, handler.source, error);
        this.runtimeLogger.warn(
          `Extension hook failed for "${hook}":`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return undefined;
  }

  private createExtensionSource(
    extensionPath: string,
    loadSource: ExtensionLoadSource = 'api',
  ): ExtensionFileContributionSource {
    return {
      kind: 'extension',
      id: `${loadSource}:extension:${extensionPath}`,
      label: path.basename(extensionPath),
      path: extensionPath,
    };
  }

  private createRuntimeSource(
    id: string,
    label: string,
  ): ExtensionContributionSource {
    return {
      kind: 'runtime',
      id,
      label,
    };
  }

  private recordFailure(
    stage: ExtensionFailureStage,
    target: string,
    source: ExtensionContributionSource,
    error: unknown,
  ): void {
    this.failures.push({
      stage,
      target,
      message: error instanceof Error ? error.message : String(error),
      occurredAt: new Date().toISOString(),
      source: { ...source },
    });

    if (this.failures.length > 50) {
      this.failures.shift();
    }
  }

  private createExtensionApi(
    extensionPath: string,
    disposables: Disposable[],
    loadSource: ExtensionLoadSource = 'api',
  ): KodaXExtensionAPI {
    const logger = this.createLogger(extensionPath);
    const source = this.createExtensionSource(extensionPath, loadSource);

    return {
      registerTool: (definition) => {
        const dispose = registerTool(definition, {
          source,
        });
        disposables.push(dispose);
        return dispose;
      },
      getTool: (name) => getRegisteredToolDefinition(name),
      getBuiltinTool: (name) => getBuiltinRegisteredToolDefinition(name),
      registerModelProvider: (registration: ModelProviderRegistration) => {
        const dispose = registerModelProvider(registration.name, registration.factory);
        disposables.push(dispose);
        return dispose;
      },
      registerCapabilityProvider: (provider) => {
        const dispose = this.registerRecord(
          this.capabilityProviders,
          provider.id,
          provider,
          source,
          disposables,
        );
        if (provider.dispose) {
          disposables.push(() => provider.dispose?.());
        }
        return dispose;
      },
      registerCommand: (command) => {
        return this.registerRecord(
          this.commands,
          command.name,
          command,
          source,
          disposables,
        );
      },
      registerSkillPath: (skillPath) => {
        const resolvedSkillPath = path.isAbsolute(skillPath)
          ? skillPath
          : path.resolve(path.dirname(extensionPath), skillPath);
        const dispose = registerPluginSkillPath(resolvedSkillPath);
        disposables.push(dispose);
        return dispose;
      },
      on: (event, handler) => {
        const dispose = this.registerEventHandler(event, handler, source);
        disposables.push(dispose);
        return dispose;
      },
      hook: (hook, handler) => {
        const dispose = this.registerHookHandler(hook, handler, source);
        disposables.push(dispose);
        return dispose;
      },
      logger,
      config: this.config,
      runtime: this.createExtensionApiRuntimeController(source, logger, disposables),
      persistence: createExtensionStore(source.id),
    };
  }

  private createLogger(extensionPath: string): ExtensionLogger {
    const label = path.basename(extensionPath);
    return {
      debug: (...args) => console.debug(`[kodax:extension:${label}]`, ...args),
      info: (...args) => console.info(`[kodax:extension:${label}]`, ...args),
      warn: (...args) => console.warn(`[kodax:extension:${label}]`, ...args),
      error: (...args) => console.error(`[kodax:extension:${label}]`, ...args),
    };
  }

  private createRuntimeControllerProxy(): BoundExtensionRuntimeController {
    return {
      queueUserMessage: (message) => {
        const controller = this.boundController;
        if (!controller) {
          throw new Error('No active KodaX session is bound to the extension runtime.');
        }
        controller.queueUserMessage(normalizeQueuedMessage(message));
      },
      getSessionState: (extensionId, key) => this.boundController?.getSessionState(extensionId, key),
      setSessionState: (extensionId, key, value) => {
        const controller = this.boundController;
        if (!controller) {
          throw new Error('Session state is only available while a KodaX session is active.');
        }
        controller.setSessionState(extensionId, key, value);
      },
      getSessionStateSnapshot: (extensionId) => {
        if (!this.boundController) {
          return {};
        }
        return this.boundController.getSessionStateSnapshot(extensionId);
      },
      appendSessionRecord: (extensionId, type, data, options) => {
        const controller = this.boundController;
        if (!controller) {
          throw new Error('Session records are only available while a KodaX session is active.');
        }
        return controller.appendSessionRecord(extensionId, type, data, options);
      },
      listSessionRecords: (extensionId, type) => {
        if (!this.boundController) {
          return [];
        }
        return this.boundController.listSessionRecords(extensionId, type);
      },
      clearSessionRecords: (extensionId, type) => {
        const controller = this.boundController;
        if (!controller) {
          throw new Error('Session records are only available while a KodaX session is active.');
        }
        return controller.clearSessionRecords(extensionId, type);
      },
      getActiveTools: () => {
        if (this.boundController) {
          return this.boundController.getActiveTools();
        }
        return this.defaultActiveTools === undefined
          ? listTools()
          : [...this.defaultActiveTools];
      },
      setActiveTools: (toolNames) => {
        const normalized = dedupeStrings(toolNames);
        if (this.boundController) {
          this.boundController.setActiveTools(normalized);
          return;
        }
        this.defaultActiveTools = normalized;
      },
      getModelSelection: () => {
        if (this.boundController) {
          return this.boundController.getModelSelection();
        }
        return { ...this.defaultModelSelection };
      },
      setModelSelection: (next) => {
        const normalized = normalizeModelSelection(next);

        if (this.boundController) {
          this.boundController.setModelSelection(normalized);
          return;
        }

        this.defaultModelSelection = normalized;
      },
      getThinkingLevel: () => this.boundController?.getThinkingLevel() ?? this.defaultThinkingLevel,
      setThinkingLevel: (level) => {
        if (this.boundController) {
          this.boundController.setThinkingLevel(level);
          return;
        }
        this.defaultThinkingLevel = level;
      },
    };
  }

  private createExtensionApiRuntimeController(
    source: ExtensionContributionSource,
    logger: ExtensionLogger,
    disposables: Disposable[],
  ): ExtensionRuntimeController {
    let capturedActiveTools = false;
    let previousActiveTools: string[] | undefined;
    let capturedModelSelection = false;
    let previousModelSelection: ExtensionModelSelection = {};
    let capturedThinkingLevel = false;
    let previousThinkingLevel: KodaXReasoningMode | undefined;

    const captureActiveToolsRestore = () => {
      if (capturedActiveTools || this.boundController) {
        return;
      }
      capturedActiveTools = true;
      previousActiveTools = this.defaultActiveTools === undefined
        ? undefined
        : [...this.defaultActiveTools];
      disposables.push(() => {
        this.defaultActiveTools = previousActiveTools === undefined
          ? undefined
          : [...previousActiveTools];
      });
    };

    const captureModelSelectionRestore = () => {
      if (capturedModelSelection || this.boundController) {
        return;
      }
      capturedModelSelection = true;
      previousModelSelection = { ...this.defaultModelSelection };
      disposables.push(() => {
        this.defaultModelSelection = { ...previousModelSelection };
      });
    };

    const captureThinkingLevelRestore = () => {
      if (capturedThinkingLevel || this.boundController) {
        return;
      }
      capturedThinkingLevel = true;
      previousThinkingLevel = this.defaultThinkingLevel;
      disposables.push(() => {
        this.defaultThinkingLevel = previousThinkingLevel;
      });
    };

    const recordPersistenceFailure = (
      target: string,
      message: string,
    ) => {
      const error = new Error(message);
      this.recordFailure('persistence', target, source, error);
      logger.warn(message);
    };

    return {
      queueUserMessage: (message) => this.runtimeController.queueUserMessage(normalizeQueuedMessage(message)),
      getSessionState: (key) => this.runtimeController.getSessionState(source.id, key),
      setSessionState: (key, value) => {
        if (value !== undefined && !isJsonValue(value)) {
          recordPersistenceFailure(
            `sessionState:${key}`,
            `Ignoring non-JSON session state for "${source.label}" key "${key}".`,
          );
          return;
        }
        this.runtimeController.setSessionState(source.id, key, value);
      },
      appendSessionRecord: (type, data, options) => {
        const normalizedType = type.trim();
        if (!normalizedType) {
          recordPersistenceFailure(
            'sessionRecord',
            `Ignoring session record with an empty type for "${source.label}".`,
          );
          return undefined;
        }
        if (data !== undefined && !isJsonValue(data)) {
          recordPersistenceFailure(
            `sessionRecord:${normalizedType}`,
            `Ignoring non-JSON session record "${normalizedType}" for "${source.label}".`,
          );
          return undefined;
        }
        return this.runtimeController.appendSessionRecord(source.id, normalizedType, data, options);
      },
      listSessionRecords: (type) => this.runtimeController.listSessionRecords(source.id, type),
      clearSessionRecords: (type) => this.runtimeController.clearSessionRecords(source.id, type),
      getActiveTools: () => this.runtimeController.getActiveTools(),
      setActiveTools: (toolNames) => {
        captureActiveToolsRestore();
        this.runtimeController.setActiveTools(toolNames);
      },
      getModelSelection: () => this.runtimeController.getModelSelection(),
      setModelSelection: (next) => {
        captureModelSelectionRestore();
        this.runtimeController.setModelSelection(next);
      },
      getThinkingLevel: () => this.runtimeController.getThinkingLevel(),
      setThinkingLevel: (level) => {
        captureThinkingLevelRestore();
        this.runtimeController.setThinkingLevel(level);
      },
    };
  }

  private registerRecord<T>(
    store: Map<string, RuntimeRecord<T>[]>,
    name: string,
    value: T,
    source: ExtensionContributionSource,
    disposables: Disposable[],
  ): () => void {
    const id = `runtime:${++this.nextRecordId}`;
    const records = store.get(name) ?? [];
    store.set(name, [...records, { id, value, source }]);

    const dispose = () => {
      const current = store.get(name) ?? [];
      const next = current.filter((record) => record.id !== id);
      if (next.length === 0) {
        store.delete(name);
      } else {
        store.set(name, next);
      }
    };
    disposables.push(dispose);
    return dispose;
  }

  private registerEventHandler<TEvent extends keyof ExtensionEventMap>(
    event: TEvent,
    handler: (payload: ExtensionEventMap[TEvent]) => Promise<void> | void,
    source: ExtensionContributionSource,
  ): () => void {
    const id = `runtime:${++this.nextRecordId}`;
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push({
      id,
      value: handler as (payload: unknown) => Promise<void> | void,
      source,
    });
    this.eventHandlers.set(event, handlers);

    return () => {
      const current = this.eventHandlers.get(event);
      if (!current) {
        return;
      }
      const next = current.filter((record) => record.id !== id);
      if (next.length === 0) {
        this.eventHandlers.delete(event);
        return;
      }
      this.eventHandlers.set(event, next);
    };
  }

  private registerHookHandler<THook extends keyof ExtensionHookMap>(
    hook: THook,
    handler: ExtensionHookMap[THook],
    source: ExtensionContributionSource,
  ): () => void {
    const id = `runtime:${++this.nextRecordId}`;
    const handlers = this.hookHandlers.get(hook) ?? [];
    handlers.push({
      id,
      value: handler as (payload: unknown) => Promise<unknown> | unknown,
      source,
    });
    this.hookHandlers.set(hook, handlers);

    return () => {
      const current = this.hookHandlers.get(hook);
      if (!current) {
        return;
      }
      const next = current.filter((record) => record.id !== id);
      if (next.length === 0) {
        this.hookHandlers.delete(hook);
        return;
      }
      this.hookHandlers.set(hook, next);
    };
  }

  private async unloadExtension(resolvedPath: string): Promise<void> {
    const existing = this.loadedExtensions.get(resolvedPath);
    if (!existing) {
      return;
    }

    await existing.disposeAll();
    this.loadedExtensions.delete(resolvedPath);
  }

  private async importExtensionModule(
    resolvedPath: string,
  ): Promise<KodaXExtensionModule> {
    const extension = path.extname(resolvedPath).toLowerCase();
    if (['.js', '.mjs', '.cjs'].includes(extension)) {
      const moduleUrl = new URL(pathToFileURL(resolvedPath).href);
      moduleUrl.searchParams.set('kodax_ext_reload', `${Date.now()}:${Math.random()}`);
      return import(moduleUrl.href) as Promise<KodaXExtensionModule>;
    }

    if (['.ts', '.mts', '.cts'].includes(extension)) {
      return tsImport(pathToFileURL(resolvedPath).href, {
        parentURL: import.meta.url,
      }) as Promise<KodaXExtensionModule>;
    }

    throw new Error(
      `Unsupported extension module "${resolvedPath}". FEATURE_034 currently loads .js/.mjs/.cjs/.ts/.mts/.cts files.`,
    );
  }
}

export function createExtensionRuntime(
  options: { config?: Readonly<Record<string, unknown>> } = {},
): KodaXExtensionRuntime {
  return new KodaXExtensionRuntime(options);
}

export function setActiveExtensionRuntime(
  runtime: KodaXExtensionRuntime | null,
): void {
  activeExtensionRuntime = runtime;
}

export function getActiveExtensionRuntime(): KodaXExtensionRuntime | null {
  return activeExtensionRuntime;
}

export async function emitActiveExtensionEvent<TEvent extends keyof ExtensionEventMap>(
  event: TEvent,
  payload: ExtensionEventMap[TEvent],
): Promise<void> {
  await activeExtensionRuntime?.emit(event, payload);
}

export async function runActiveExtensionHook<THook extends keyof ExtensionHookMap>(
  hook: THook,
  payload: Parameters<ExtensionHookMap[THook]>[0],
): Promise<Awaited<ReturnType<ExtensionHookMap[THook]>> | undefined> {
  return activeExtensionRuntime?.runHook(hook, payload);
}
