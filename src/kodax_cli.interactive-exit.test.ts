import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type InteractiveSurface = 'ink' | 'classic';

interface RuntimeConfig {
  readonly provider?: string;
  readonly model?: string;
  readonly runtimeMode?: 'embedded' | 'daemon';
  readonly sessionRetentionDays?: number;
  readonly extensions?: readonly string[];
  readonly mcpServers?: Record<string, { readonly connect?: string }>;
  readonly worker?: { readonly configuredA2A?: boolean };
}

interface InteractiveMainHarness {
  readonly calls: string[];
  readonly runInkInteractiveMode: ReturnType<typeof vi.fn>;
  readonly runInteractiveMode: ReturnType<typeof vi.fn>;
  readonly shutdownDefaultLspService: ReturnType<typeof vi.fn>;
  readonly awaitLatestCodingMemoryReviewDrain: ReturnType<typeof vi.fn>;
  readonly cleanupRegisteredManagedChildren: ReturnType<typeof vi.fn>;
  readonly shutdownTracing: ReturnType<typeof vi.fn>;
  readonly runtimeDispose: ReturnType<typeof vi.fn>;
  readonly createKodaXRuntime: ReturnType<typeof vi.fn>;
  readonly runtimeOptions: unknown[];
  readonly runtimeStarts: unknown[];
  readonly runtimeDeletes: string[];
  readonly runManagedTask: ReturnType<typeof vi.fn>;
  readonly prepareRuntimeConfig: ReturnType<typeof vi.fn>;
  readonly inspectProviderSetupReadiness: ReturnType<typeof vi.fn>;
  readonly initializeSetupConfiguration: ReturnType<typeof vi.fn>;
  readonly renderSetupGuide: ReturnType<typeof vi.fn>;
  readonly runProviderSetupWizard: ReturnType<typeof vi.fn>;
  readonly daemonShutdown: ReturnType<typeof vi.fn>;
}

const originalArgv = process.argv;
const originalVitest = process.env.VITEST;
const originalRuntimeMode = process.env.KODAX_RUNTIME_MODE;
const originalProvider = process.env.KODAX_PROVIDER;
const originalMockProviderApiKey = process.env.MOCK_PROVIDER_API_KEY;
const originalExitCode = process.exitCode;
const originalDaemonCleanupTimeout = process.env.KODAX_INTERNAL_DAEMON_FINAL_CLEANUP_TIMEOUT_MS;
const originalInteractiveCleanupTimeout = process.env.KODAX_INTERNAL_INTERACTIVE_FINAL_CLEANUP_TIMEOUT_MS;
const originalDaemonServe = process.env.KODAX_DAEMON_SERVE;
const daemonTempHomes: string[] = [];

beforeEach(() => {
  vi.resetModules();
  process.argv = ['node', 'kodax'];
  process.env.VITEST = 'false';
  delete process.env.KODAX_RUNTIME_MODE;
  delete process.env.KODAX_PROVIDER;
  delete process.env.MOCK_PROVIDER_API_KEY;
  delete process.env.KODAX_DAEMON_SERVE;
  process.exitCode = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@kodax-ai/agent');
  vi.doUnmock('@kodax-ai/coding');
  vi.doUnmock('@kodax-ai/repl');
  vi.doUnmock('./sdk-runtime.js');
  vi.doUnmock('./sandbox-runtime.js');
  vi.doUnmock('./a2a/runtime-config.js');
  vi.doUnmock('./runtime-daemon/manager.js');
  process.argv = originalArgv;
  if (originalVitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = originalVitest;
  }
  process.exitCode = originalExitCode;
  if (originalRuntimeMode === undefined) delete process.env.KODAX_RUNTIME_MODE;
  else process.env.KODAX_RUNTIME_MODE = originalRuntimeMode;
  if (originalProvider === undefined) delete process.env.KODAX_PROVIDER;
  else process.env.KODAX_PROVIDER = originalProvider;
  if (originalMockProviderApiKey === undefined) delete process.env.MOCK_PROVIDER_API_KEY;
  else process.env.MOCK_PROVIDER_API_KEY = originalMockProviderApiKey;
  if (originalDaemonServe === undefined) delete process.env.KODAX_DAEMON_SERVE;
  else process.env.KODAX_DAEMON_SERVE = originalDaemonServe;
  if (originalDaemonCleanupTimeout === undefined) {
    delete process.env.KODAX_INTERNAL_DAEMON_FINAL_CLEANUP_TIMEOUT_MS;
  } else {
    process.env.KODAX_INTERNAL_DAEMON_FINAL_CLEANUP_TIMEOUT_MS = originalDaemonCleanupTimeout;
  }
  if (originalInteractiveCleanupTimeout === undefined) {
    delete process.env.KODAX_INTERNAL_INTERACTIVE_FINAL_CLEANUP_TIMEOUT_MS;
  } else {
    process.env.KODAX_INTERNAL_INTERACTIVE_FINAL_CLEANUP_TIMEOUT_MS = originalInteractiveCleanupTimeout;
  }
  for (const home of daemonTempHomes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

function createDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function importMainWithMocks(options: {
  readonly surface?: InteractiveSurface;
  readonly config?: RuntimeConfig;
  readonly lspShutdown?: () => Promise<void>;
  readonly runtimeClose?: () => Promise<void>;
  readonly memoryReviewDrain?: (timeoutMs: number) => Promise<void>;
  readonly mockSdkRuntime?: boolean;
  readonly prepareRuntimeConfig?: () => RuntimeConfig;
  readonly inspectProviderSetupReadiness?: (
    input: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
  readonly initializeSetupConfiguration?: () => {
    readonly configHome: string;
    readonly files: readonly Readonly<Record<string, unknown>>[];
  };
  readonly mockDaemonLease?: boolean;
} = {}): Promise<{
  readonly main: () => Promise<void>;
  readonly harness: InteractiveMainHarness;
}> {
  const calls: string[] = [];
  const runtimeOptions: unknown[] = [];
  const runtimeStarts: unknown[] = [];
  const runtimeDeletes: string[] = [];
  const surface = options.surface ?? 'ink';
  const config = options.config ?? {
    provider: 'mock-provider',
    mcpServers: {
      mock: { connect: 'lazy' },
    },
  };

  const runInkInteractiveMode = vi.fn(async () => {
    calls.push('run-ink');
  });
  const runInteractiveMode = vi.fn(async () => {
    calls.push('run-classic');
  });
  const shutdownDefaultLspService = vi.fn(async () => {
    calls.push('shutdown-lsp');
    await options.lspShutdown?.();
  });
  const awaitLatestCodingMemoryReviewDrain = vi.fn(async (timeoutMs: number) => {
    await options.memoryReviewDrain?.(timeoutMs);
  });
  const cleanupRegisteredManagedChildren = vi.fn(async (cleanupOptions?: { includeCurrentOwner?: boolean }) => {
    calls.push(cleanupOptions?.includeCurrentOwner ? 'cleanup-children-final' : 'cleanup-children-startup');
    return { killed: 0, pruned: 0, skipped: 0 };
  });
  const shutdownTracing = vi.fn(async () => {
    calls.push('shutdown-tracing');
  });
  const runtimeDispose = vi.fn(async () => {
    calls.push('runtime-dispose');
  });
  const runManagedTask = vi.fn(async () => ({
    success: true,
    lastText: 'legacy',
    messages: [],
    sessionId: 'legacy-session',
  }));
  const prepareRuntimeConfig = vi.fn(() => options.prepareRuntimeConfig?.() ?? config);
  const inspectProviderSetupReadiness = vi.fn((input: Readonly<Record<string, unknown>>) => (
    options.inspectProviderSetupReadiness?.(input) ?? {
      status: 'ready',
      configPath: 'C:/Users/test/.kodax/config.json',
      configRevision: 'test-revision',
      provider: 'mock-provider',
    }
  ));
  const initializeSetupConfiguration = vi.fn(() => (
    options.initializeSetupConfiguration?.() ?? {
      configHome: 'C:/Users/test/.kodax',
      files: [
        { domain: 'core', kind: 'active', status: 'created', path: 'C:/Users/test/.kodax/config.json' },
        { domain: 'mcp', kind: 'active', status: 'created', path: 'C:/Users/test/.kodax/integrations/mcp.json' },
      ],
    }
  ));
  const renderSetupGuide = vi.fn(() => 'KodaX setup guide');
  const runProviderSetupWizard = vi.fn(async () => ({ status: 'cancelled' as const }));
  const daemonShutdown = vi.fn(async () => {
    calls.push('daemon-shutdown');
  });
  const createKodaXRuntime = vi.fn(async (runtimeOptionsInput: unknown) => {
    runtimeOptions.push(runtimeOptionsInput);
    const runtimeOptionsRecord = runtimeOptionsInput !== null && typeof runtimeOptionsInput === 'object'
      ? runtimeOptionsInput as Record<string, unknown>
      : {};
    const runtimeMode = runtimeOptionsRecord.mode === 'daemon' ? 'daemon' : 'embedded';
    const runtimeProfile = typeof runtimeOptionsRecord.profile === 'string'
      ? runtimeOptionsRecord.profile
      : 'default';
    return {
      identity: {
        runtimeId: 'rt_mock_interactive',
        mode: runtimeMode,
        profile: runtimeProfile,
        startedAt: '2026-07-09T00:00:00.000Z',
        version: '0.7.66-test',
      },
      sessions: {
        async load() {
          return { id: 'session-1', title: 'Loaded' };
        },
        async create() {
          return { id: 'session-1', title: 'Created' };
        },
        async updateSettings() {
          return {};
        },
        async delete(sessionId: string) {
          runtimeDeletes.push(sessionId);
        },
      },
      runs: {
        async start(input: unknown) {
          runtimeStarts.push(input);
          return {
            runId: 'run-1',
            sessionId: 'cli-session-1',
            result: Promise.resolve({
              runId: 'run-1',
              sessionId: 'cli-session-1',
              phase: 'completed',
              result: { success: true, lastText: 'ok', messages: [], sessionId: 'cli-session-1' },
            }),
          };
        },
        async await() {
          return {
            runId: 'run-1',
            sessionId: 'session-1',
            phase: 'completed',
            result: { success: true, lastText: 'ok', messages: [] },
          };
        },
      },
      events: {
        subscribe() {
          return { close: vi.fn() };
        },
      },
      permissions: {
        async respond() {
          return true;
        },
      },
      status: {
        async snapshot() {
          return {
            runtimeId: 'rt_mock_interactive',
            mode: runtimeMode,
            profile: runtimeProfile,
            startedAt: '2026-07-09T00:00:00.000Z',
            sessions: [],
            runs: [],
            pendingPermissions: [],
            workflows: [],
          };
        },
      },
      async close() {
        calls.push('runtime-close');
        await options.runtimeClose?.();
      },
    };
  });

  vi.doMock('@kodax-ai/agent', () => ({
    applyProcessHardening: vi.fn(() => {
      calls.push('hardening');
    }),
    ELECTRON_NODE_ENV_SCRUB_IMPORT:
      'data:text/javascript,delete%20process.env.ELECTRON_RUN_AS_NODE',
    ELECTRON_RUN_AS_NODE_ENV: 'ELECTRON_RUN_AS_NODE',
    prepareInternalNodeLaunch: (input: {
      readonly args: readonly string[];
      readonly env: NodeJS.ProcessEnv;
    }) => ({ args: [...input.args], env: { ...input.env } }),
    isCurrentProcessWindowsJobContained: vi.fn(() => false),
    getAgentConfigHome: vi.fn(() => join(tmpdir(), 'kodax-cli-test-home')),
    cleanupRegisteredManagedChildren,
    shutdownTracing,
  }));

  vi.doMock('@kodax-ai/coding', () => ({
    runKodaX: vi.fn(),
    runManagedTask,
    awaitLatestCodingMemoryReviewDrain,
    KodaXClient: class KodaXClient {},
    KodaXEvents: class KodaXEvents {},
    KodaXAgentMode: {},
    KodaXReasoningMode: {},
    KODAX_REASONING_MODE_SEQUENCE: ['off', 'auto', 'quick', 'balanced', 'deep'],
    normalizeReasoningEffortValue: vi.fn((value: string) => value),
    parseReasoningEffortEnv: vi.fn(() => ({ kind: 'unset' })),
    createExtensionRuntime: vi.fn(() => ({
      activate: vi.fn(() => {
        calls.push('runtime-activate');
      }),
      dispose: runtimeDispose,
      loadExtensions: vi.fn(async () => undefined),
      reconcileExtensions: vi.fn(async () => undefined),
    })),
    dedupeExtensionPathsByEntrypoint: vi.fn(async (paths: readonly string[]) => [...paths]),
    discoverDefaultExtensions: vi.fn(async () => []),
    excludeExtensionPathsByEntrypoint: vi.fn(async (paths: readonly string[]) => [...paths]),
    registerConfiguredMcpCapabilityProvider: vi.fn(async () => {
      calls.push('register-mcp');
    }),
    replaceConfiguredMcpCapabilityProvider: vi.fn(async () => undefined),
    buildMcpReverseCapabilities: vi.fn(() => ({})),
    KODAX_DEFAULT_PROVIDER: 'mock-provider',
    checkPromiseSignal: vi.fn(),
    getProvider: vi.fn(),
    getAvailableProviderNames: vi.fn(() => ['mock-provider']),
    KODAX_TOOLS: [],
    KodaXTerminalError: class KodaXTerminalError extends Error {
      readonly suggestions: readonly string[] = [];
    },
    bootstrapTracing: vi.fn(() => {
      calls.push('bootstrap-tracing');
    }),
    shutdownDefaultLspService,
    generateSessionId: vi.fn(async () => 'cli-session-1'),
    parseSandboxEnvironmentPass: (value?: string): readonly string[] =>
      value ? value.split(',').filter(Boolean) : [],
  }));
  vi.doMock('@kodax-ai/repl', () => {
    class MockIntegrationConfigController {
      private readonly domain: 'mcp' | 'extensions';

      constructor(options: { readonly domain: 'mcp' | 'extensions' }) {
        this.domain = options.domain;
      }

      initialize(): Promise<{ readonly revision: string; readonly document: object }> {
        return Promise.resolve({
          revision: 'default',
          document: this.domain === 'mcp' ? { version: 1, servers: {} } : { version: 1, paths: [] },
        });
      }

      subscribe(): () => void { return () => undefined; }
      startWatching(): void {}
      close(): void {}
      status(): { readonly domain: string; readonly state: 'watching' } {
        return { domain: this.domain, state: 'watching' };
      }
    }

    class MockFileSessionStorage {
      cleanupOldSessions(): Promise<void> {
        calls.push('session-retention');
        return Promise.resolve();
      }
    }

    return {
      getGitRoot: vi.fn(() => undefined),
      createCliEvents: vi.fn(() => ({})),
      createJsonEvents: vi.fn(() => ({})),
      loadConfig: vi.fn(() => ({})),
      prepareRuntimeConfig,
      FileSessionStorage: MockFileSessionStorage,
      dedupeSessions: vi.fn(),
      KODAX_CONFIG_FILE: 'C:/Users/test/.kodax/config.json',
      KODAX_DIR: 'C:/Users/test/.kodax',
      IntegrationConfigController: MockIntegrationConfigController,
      parseMcpIntegrationDocument: vi.fn((value: unknown) => value),
      parseExtensionsIntegrationDocument: vi.fn((value: unknown) => value),
      readMcpIntegration: vi.fn(() => ({ revision: 'default', document: { version: 1, servers: {} } })),
      readExtensionsIntegration: vi.fn(() => ({ revision: 'default', document: { version: 1, paths: [] } })),
      ensureExampleConfigFiles: vi.fn(() => []),
      resolveInteractiveSurfacePreference: vi.fn(() => surface),
      resolveUserSkillInvocation: vi.fn(async () => undefined),
      prepareInvocationExecution: vi.fn(),
      runInteractiveMode,
      runInkInteractiveMode,
      inspectProviderSetupReadiness,
      initializeSetupConfiguration,
      getProviderSetupCatalog: vi.fn(() => [{
        name: 'mock-provider',
        apiKeyEnv: 'MOCK_PROVIDER_API_KEY',
        defaultModel: 'mock-model',
        models: ['mock-model'],
      }]),
      renderSetupGuide,
      providerSetupRestartInstructions: vi.fn(() => []),
      runProviderSetupWizard,
    };
  });

  if (options.mockSdkRuntime !== false) {
    vi.doMock('./sdk-runtime.js', () => ({
      createKodaXRuntime,
    }));
  }
  vi.doMock('./sandbox-runtime.js', () => ({
    prepareSandboxRuntimeForSetup: vi.fn(async () => ({
      status: 'ready' as const,
      attempted: false,
      doctor: {
        diagnostics: [] as readonly string[],
      },
      guidance: [] as readonly string[],
    })),
  }));
  vi.doMock('./a2a/runtime-config.js', () => ({
    createConfiguredA2ARuntimeIntegration: vi.fn(() => ({
      runtimeOptions: { factories: [], policy: vi.fn(() => ({ allowed: true })) },
      start: vi.fn(async () => ({
        status: vi.fn(() => ({ domain: 'a2a' })),
        reload: vi.fn(async () => undefined),
        close: vi.fn(),
      })),
    })),
  }));
  if (options.mockDaemonLease === true) {
    vi.doMock('./runtime-daemon/manager.js', () => ({
      acquireRuntimeDaemonLease: vi.fn(async (leaseOptions: {
        readonly createRuntime: (runtimeId: string) => Promise<{
          readonly close: () => Promise<void>;
        }>;
      }) => {
        const runtime = await leaseOptions.createRuntime('rt_mock_interactive');
        let shutdownAttempt: Promise<void> | undefined;
        daemonShutdown.mockImplementation(() => {
          shutdownAttempt ??= runtime.close().then(() => {
            calls.push('daemon-shutdown');
          });
          return shutdownAttempt;
        });
        return {
          transport: {},
          endpoint: { path: 'mock-daemon-endpoint' },
          paths: {},
          ownsHost: true,
          hostClosed: Promise.resolve(),
          close: vi.fn(async () => undefined),
          shutdown: daemonShutdown,
        };
      }),
    }));
  }

  const module = await import('./kodax_cli.js');
  return {
    main: module.main,
    harness: {
      calls,
      runInkInteractiveMode,
      runInteractiveMode,
      shutdownDefaultLspService,
      awaitLatestCodingMemoryReviewDrain,
      cleanupRegisteredManagedChildren,
      shutdownTracing,
      runtimeDispose,
      createKodaXRuntime,
      runtimeOptions,
      runtimeStarts,
      runtimeDeletes,
      runManagedTask,
      prepareRuntimeConfig,
      inspectProviderSetupReadiness,
      initializeSetupConfiguration,
      renderSetupGuide,
      runProviderSetupWizard,
      daemonShutdown,
    },
  };
}

describe('CLI interactive exit lifecycle', () => {
  it('completes process-level cleanup after a daemon serve host stops', async () => {
    const daemonHome = await mkdtemp(join(tmpdir(), 'kodax-daemon-cleanup-'));
    daemonTempHomes.push(daemonHome);
    process.env.VITEST = 'true';
    process.argv = [
      'node',
      'kodax',
      'daemon',
      'serve',
      '--home',
      daemonHome,
      '--profile',
      'daemon-cleanup',
      '--provider',
      'mock-provider',
    ];
    const { main, harness } = await importMainWithMocks({
      mockDaemonLease: true,
    });

    await main();

    expect(harness.daemonShutdown).toHaveBeenCalledTimes(1);
    const completed = harness.calls.filter((call) => [
      'runtime-close',
      'runtime-dispose',
      'shutdown-lsp',
      'cleanup-children-final',
      'shutdown-tracing',
    ].includes(call));
    expect(completed).toEqual([
      'runtime-close',
      'runtime-dispose',
      'shutdown-lsp',
      'cleanup-children-final',
      'shutdown-tracing',
    ]);
  });

  it('preserves the memory review drain budget beyond the generic daemon phase cap', async () => {
    const daemonHome = await mkdtemp(join(tmpdir(), 'kodax-daemon-cleanup-'));
    daemonTempHomes.push(daemonHome);
    process.env.VITEST = 'true';
    process.env.KODAX_INTERNAL_DAEMON_FINAL_CLEANUP_TIMEOUT_MS = '400';
    process.argv = [
      'node',
      'kodax',
      'daemon',
      'serve',
      '--home',
      daemonHome,
      '--profile',
      'daemon-memory-review-drain',
    ];
    const { main, harness } = await importMainWithMocks({
      mockDaemonLease: true,
      memoryReviewDrain: () => new Promise<void>((resolve) => setTimeout(resolve, 150)),
    });

    await expect(main()).resolves.toBeUndefined();
    expect(harness.awaitLatestCodingMemoryReviewDrain).toHaveBeenCalledWith(15_000);
    expect(harness.calls).toEqual(expect.arrayContaining([
      'cleanup-children-final',
      'shutdown-tracing',
    ]));
  });

  it('reports daemon process cleanup failure after attempting later resources', async () => {
    const daemonHome = await mkdtemp(join(tmpdir(), 'kodax-daemon-cleanup-'));
    daemonTempHomes.push(daemonHome);
    process.env.VITEST = 'true';
    process.argv = [
      'node',
      'kodax',
      'daemon',
      'serve',
      '--home',
      daemonHome,
      '--profile',
      'daemon-cleanup-failure',
    ];
    const { main, harness } = await importMainWithMocks({
      mockDaemonLease: true,
      lspShutdown: async () => {
        throw new Error('LSP child remained alive');
      },
    });

    await expect(main()).rejects.toThrow('Daemon LSP cleanup failed.');
    expect(harness.calls).toEqual(expect.arrayContaining([
      'shutdown-lsp',
      'cleanup-children-final',
      'shutdown-tracing',
    ]));
  });

  it('bounds a hung daemon cleanup phase and still attempts later resources', async () => {
    const daemonHome = await mkdtemp(join(tmpdir(), 'kodax-daemon-cleanup-'));
    daemonTempHomes.push(daemonHome);
    process.env.VITEST = 'true';
    process.env.KODAX_INTERNAL_DAEMON_FINAL_CLEANUP_TIMEOUT_MS = '25';
    process.argv = [
      'node',
      'kodax',
      'daemon',
      'serve',
      '--home',
      daemonHome,
      '--profile',
      'daemon-cleanup-timeout',
    ];
    const { main, harness } = await importMainWithMocks({
      mockDaemonLease: true,
      lspShutdown: () => new Promise<void>(() => undefined),
    });

    await expect(main()).rejects.toThrow(/LSP cleanup timed out/i);
    expect(harness.calls).toEqual(expect.arrayContaining([
      'shutdown-lsp',
      'cleanup-children-final',
      'shutdown-tracing',
    ]));
  });

  it('preserves a daemon host failure when final cleanup also fails', async () => {
    const daemonHome = await mkdtemp(join(tmpdir(), 'kodax-daemon-cleanup-'));
    daemonTempHomes.push(daemonHome);
    process.env.VITEST = 'true';
    process.argv = [
      'node',
      'kodax',
      'daemon',
      'serve',
      '--home',
      daemonHome,
      '--profile',
      'daemon-aggregate-failure',
    ];
    const { main } = await importMainWithMocks({
      mockDaemonLease: true,
      runtimeClose: async () => {
        throw new Error('Runtime host close failed');
      },
      lspShutdown: async () => {
        throw new Error('LSP child remained alive');
      },
    });

    const failure = await main().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    const messages = failure instanceof AggregateError
      ? failure.errors.map((error: unknown) => error instanceof Error ? error.message : String(error))
      : [];
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringMatching(/Runtime host close failed/i),
      expect.stringMatching(/Daemon LSP cleanup failed/i),
    ]));
  });

  it('hydrates Runtime configuration before deciding whether first-run setup is needed', async () => {
    const shellCredential = 'KODAX_TEST_SHELL_PROFILE_CREDENTIAL';
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    delete process.env[shellCredential];

    try {
      const { main, harness } = await importMainWithMocks({
        prepareRuntimeConfig: () => {
          process.env[shellCredential] = 'hydrated-by-login-shell';
          return { provider: 'mock-provider' };
        },
        inspectProviderSetupReadiness: () => ({
          status: process.env[shellCredential] ? 'ready' : 'needs-provider',
          configPath: 'C:/Users/test/.kodax/config.json',
          configRevision: 'test-revision',
        }),
      });
      vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);

      await main();

      expect(harness.prepareRuntimeConfig).toHaveBeenCalledOnce();
      expect(harness.inspectProviderSetupReadiness).toHaveBeenCalledOnce();
      expect(harness.prepareRuntimeConfig.mock.invocationCallOrder[0])
        .toBeLessThan(harness.inspectProviderSetupReadiness.mock.invocationCallOrder[0]!);
      expect(harness.runProviderSetupWizard).not.toHaveBeenCalled();
      expect(harness.runInkInteractiveMode).toHaveBeenCalledOnce();
    } finally {
      delete process.env[shellCredential];
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });

  it('prints read-only credential guidance when first launch has no provider environment variable', async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const { main, harness } = await importMainWithMocks({
        inspectProviderSetupReadiness: () => ({
          status: 'needs-provider',
          configPath: 'C:/Users/test/.kodax/config.json',
          configRevision: 'missing',
        }),
      });

      await main();

      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining(
        'KodaX did not detect a supported provider API key environment variable.',
      ));
      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining(
        'MOCK_PROVIDER_API_KEY',
      ));
      expect(harness.renderSetupGuide).not.toHaveBeenCalled();
      expect(harness.initializeSetupConfiguration).not.toHaveBeenCalled();
      expect(harness.runProviderSetupWizard).not.toHaveBeenCalled();
      expect(harness.runInkInteractiveMode).not.toHaveBeenCalled();
      expect(harness.runInteractiveMode).not.toHaveBeenCalled();
      expect(harness.createKodaXRuntime).not.toHaveBeenCalled();
      expect(writeSpy).toHaveBeenCalled();
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });

  it('prints the selected provider variable when an existing config is missing its credential', async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const { main, harness } = await importMainWithMocks({
        inspectProviderSetupReadiness: () => ({
          status: 'needs-credential',
          configPath: 'C:/Users/test/.kodax/config.json',
          configRevision: 'configured',
          provider: 'mock-provider',
          apiKeyEnv: 'MOCK_PROVIDER_API_KEY',
        }),
      });

      await main();

      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining(
        'MOCK_PROVIDER_API_KEY',
      ));
      expect(harness.initializeSetupConfiguration).not.toHaveBeenCalled();
      expect(harness.runProviderSetupWizard).not.toHaveBeenCalled();
      expect(harness.runInkInteractiveMode).not.toHaveBeenCalled();
      expect(harness.createKodaXRuntime).not.toHaveBeenCalled();
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });

  it('keeps metadata setup available when a supported provider credential already exists', async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    process.env.MOCK_PROVIDER_API_KEY = 'available-outside-kodax';
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const { main, harness } = await importMainWithMocks({
        inspectProviderSetupReadiness: () => ({
          status: 'needs-provider',
          configPath: 'C:/Users/test/.kodax/config.json',
          configRevision: 'missing',
        }),
      });

      await main();

      expect(harness.initializeSetupConfiguration).toHaveBeenCalledOnce();
      expect(harness.runProviderSetupWizard).toHaveBeenCalledOnce();
      expect(harness.runInkInteractiveMode).not.toHaveBeenCalled();
    } finally {
      delete process.env.MOCK_PROVIDER_API_KEY;
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });

  it('does not let KODAX_PROVIDER bypass first-run credential guidance when config.json is missing', async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    process.env.KODAX_PROVIDER = 'env-provider';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const { main, harness } = await importMainWithMocks({
        inspectProviderSetupReadiness: (input) => ({
          status: input.explicitProvider === undefined ? 'needs-provider' : 'ready',
          configPath: 'C:/Users/test/.kodax/config.json',
          configRevision: 'missing',
        }),
      });

      await main();

      expect(harness.inspectProviderSetupReadiness).toHaveBeenCalledWith(
        expect.objectContaining({ explicitProvider: undefined }),
      );
      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining(
        'KodaX did not detect a supported provider API key environment variable.',
      ));
      expect(harness.initializeSetupConfiguration).not.toHaveBeenCalled();
      expect(harness.runProviderSetupWizard).not.toHaveBeenCalled();
      expect(harness.runInkInteractiveMode).not.toHaveBeenCalled();
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });

  it('shows setup help before hardening, cleanup, tracing, config migration, or session retention', async () => {
    process.argv = ['node', 'kodax', 'setup', '--help'];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { main, harness } = await importMainWithMocks();

    await main();

    expect(harness.calls).toEqual([]);
    expect(harness.renderSetupGuide).toHaveBeenCalled();
    expect(harness.initializeSetupConfiguration).not.toHaveBeenCalled();
    expect(harness.runProviderSetupWizard).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();
  });

  it('stops explicit setup before the provider wizard when an active config is invalid', async () => {
    process.argv = ['node', 'kodax', 'setup'];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { main, harness } = await importMainWithMocks({
      initializeSetupConfiguration: () => ({
        configHome: 'C:/Users/test/.kodax',
        files: [{
          domain: 'mcp',
          kind: 'active',
          status: 'invalid',
          path: 'C:/Users/test/.kodax/integrations/mcp.json',
          diagnostic: 'MCP integration config version must be 1.',
        }],
      }),
    });

    await main();

    expect(harness.initializeSetupConfiguration).toHaveBeenCalledOnce();
    expect(harness.runProviderSetupWizard).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('invalid'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Setup stopped'));
  });

  it('keeps Ink cleanup host-owned and exits only after top-level cleanup', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      expect(code).toBe(0);
      return undefined as never;
    }) as typeof process.exit);
    const { main, harness } = await importMainWithMocks();

    await main();

    expect(harness.runInkInteractiveMode).toHaveBeenCalledTimes(1);
    expect(harness.runInkInteractiveMode).toHaveBeenCalledWith(expect.objectContaining({
      hardExitOnClose: false,
    }));
    expect(harness.runtimeDispose).toHaveBeenCalledTimes(1);
    expect(harness.shutdownDefaultLspService).toHaveBeenCalledTimes(1);
    expect(harness.cleanupRegisteredManagedChildren).toHaveBeenNthCalledWith(1);
    expect(harness.cleanupRegisteredManagedChildren).toHaveBeenNthCalledWith(2, { includeCurrentOwner: true });
    expect(harness.shutdownTracing).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(harness.calls).toEqual([
      'hardening',
      'cleanup-children-startup',
      'bootstrap-tracing',
      'session-retention',
      'register-mcp',
      'runtime-activate',
      'run-ink',
      'runtime-close',
      'runtime-dispose',
      'shutdown-lsp',
      'cleanup-children-final',
      'shutdown-tracing',
    ]);
  });

  it('does not exit before asynchronous cleanup resolves', async () => {
    const lspDeferred = createDeferred();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const { main, harness } = await importMainWithMocks({
      lspShutdown: () => lspDeferred.promise,
    });

    const mainPromise = main();
    await vi.waitFor(() => expect(harness.shutdownDefaultLspService).toHaveBeenCalledTimes(1));

    expect(exitSpy).not.toHaveBeenCalled();
    expect(harness.calls).toContain('runtime-dispose');
    expect(harness.calls).not.toContain('cleanup-children-final');

    lspDeferred.resolve();
    await mainPromise;

    expect(harness.calls).toContain('shutdown-tracing');
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('does not close Runtime or exit before a claimed memory review settles', async () => {
    process.env.KODAX_INTERNAL_INTERACTIVE_FINAL_CLEANUP_TIMEOUT_MS = '200';
    const reviewDeferred = createDeferred();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const { main, harness } = await importMainWithMocks({
      memoryReviewDrain: () => reviewDeferred.promise,
    });

    const mainPromise = main();
    await vi.waitFor(() => expect(harness.awaitLatestCodingMemoryReviewDrain).toHaveBeenCalledWith(15_000));

    expect(harness.calls).not.toContain('runtime-close');
    expect(exitSpy).not.toHaveBeenCalled();
    reviewDeferred.resolve();
    await mainPromise;
    expect(harness.calls).toContain('runtime-close');
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung interactive cleanup phase and continues releasing later resources', async () => {
    process.env.KODAX_INTERNAL_INTERACTIVE_FINAL_CLEANUP_TIMEOUT_MS = '60';
    const never = new Promise<void>(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const { main, harness } = await importMainWithMocks({ lspShutdown: () => never });

    const startedAt = Date.now();
    await main();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(harness.calls).toContain('shutdown-lsp');
    expect(harness.calls).toContain('cleanup-children-final');
    expect(harness.calls).toContain('shutdown-tracing');
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('LSP cleanup timed out'),
      expect.objectContaining({ code: 'KODAX_INTERACTIVE_CLEANUP' }),
    );
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('reserves time for managed-child cleanup when Runtime shutdown hangs', async () => {
    process.env.KODAX_INTERNAL_INTERACTIVE_FINAL_CLEANUP_TIMEOUT_MS = '60';
    const never = new Promise<void>(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const { main, harness } = await importMainWithMocks({ runtimeClose: () => never });

    await main();

    expect(harness.calls).toContain('runtime-close');
    expect(harness.calls).toContain('cleanup-children-final');
    expect(harness.calls).toContain('shutdown-tracing');
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('Runtime cleanup timed out'),
      expect.objectContaining({ code: 'KODAX_INTERACTIVE_CLEANUP' }),
    );
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('continues host cleanup when runtime close fails', async () => {
    const closeError = new Error('runtime close failed');
    const { main, harness } = await importMainWithMocks({
      runtimeClose: async () => { throw closeError; },
    });

    await expect(main()).rejects.toBe(closeError);

    expect(harness.calls).toEqual(expect.arrayContaining([
      'runtime-close',
      'runtime-dispose',
      'shutdown-lsp',
      'cleanup-children-final',
      'shutdown-tracing',
    ]));
  });

  it('uses the same cleanup-before-exit policy for classic interactive mode', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const { main, harness } = await importMainWithMocks({ surface: 'classic' });

    await main();

    expect(harness.runInteractiveMode).toHaveBeenCalledTimes(1);
    expect(harness.runInkInteractiveMode).not.toHaveBeenCalled();
    expect(harness.calls).toEqual(expect.arrayContaining([
      'run-classic',
      'runtime-dispose',
      'shutdown-lsp',
      'cleanup-children-final',
      'shutdown-tracing',
    ]));
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('can opt the interactive REPL into daemon runtime mode', async () => {
    const previousRuntimeMode = process.env.KODAX_RUNTIME_MODE;
    process.env.KODAX_RUNTIME_MODE = 'daemon';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    try {
      const { main, harness } = await importMainWithMocks({ mockSdkRuntime: true });

      await main();

      expect(harness.runInkInteractiveMode).toHaveBeenCalledTimes(1);
      expect(harness.createKodaXRuntime).toHaveBeenCalledTimes(1);
      expect(harness.runtimeOptions[0]).toMatchObject({
        mode: 'daemon',
        profile: 'default',
        autoStartDaemon: true,
        clientInfo: {
          name: 'kodax-cli',
          title: 'KodaX CLI',
          version: expect.any(String),
          clientType: 'cli',
        },
      });
      expect(harness.runtimeOptions[0]).not.toHaveProperty('homeDir');
      const replOptions = harness.runInkInteractiveMode.mock.calls[0]?.[0] as {
        getRuntimeStatus?: () => Promise<unknown>;
      };
      const getRuntimeStatus = replOptions.getRuntimeStatus;
      expect(getRuntimeStatus).toBeTypeOf('function');
      if (!getRuntimeStatus) throw new Error('Expected REPL runtime status callback.');
      await expect(getRuntimeStatus()).resolves.toMatchObject({
        mode: 'daemon',
        profile: 'default',
        runtimeId: 'rt_mock_interactive',
        sessions: 0,
        runs: 0,
      });
      expect(exitSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (previousRuntimeMode === undefined) {
        delete process.env.KODAX_RUNTIME_MODE;
      } else {
        process.env.KODAX_RUNTIME_MODE = previousRuntimeMode;
      }
    }
  });

  it('routes print mode through the configured daemon runtime', async () => {
    process.argv = ['node', 'kodax', '-p', 'inspect the repo'];
    const { main, harness } = await importMainWithMocks({
      config: { provider: 'mock-provider', runtimeMode: 'daemon' },
    });

    await main();

    expect(harness.createKodaXRuntime).toHaveBeenCalledOnce();
    expect(harness.runtimeOptions[0]).toMatchObject({
      mode: 'daemon',
      profile: 'default',
      autoStartDaemon: true,
    });
    expect(harness.runtimeOptions[0]).not.toHaveProperty('externalAgents');
    expect(harness.runtimeStarts).toHaveLength(1);
    expect(harness.runtimeStarts[0]).toMatchObject({
      sessionId: 'cli-session-1',
      prompt: 'inspect the repo',
      mode: 'managed_task',
      permissionBroker: 'runtime',
    });
    expect(harness.runManagedTask).not.toHaveBeenCalled();
    expect(harness.calls).toContain('runtime-close');
  });

  it('removes the transient runtime session for --no-session runs', async () => {
    process.argv = ['node', 'kodax', '-p', 'stateless task', '--no-session'];
    const { main, harness } = await importMainWithMocks({
      config: { provider: 'mock-provider', runtimeMode: 'embedded' },
    });

    await main();

    expect(harness.runtimeStarts).toHaveLength(1);
    expect(harness.runtimeDeletes).toEqual(['cli-session-1']);
    expect(harness.runManagedTask).not.toHaveBeenCalled();
  });

  it('applies CLI > env > config precedence to runtime mode and provider', async () => {
    process.env.KODAX_RUNTIME_MODE = 'daemon';
    process.env.KODAX_PROVIDER = 'env-provider';
    process.argv = [
      'node',
      'kodax',
      '-p',
      'precedence task',
      '--runtime-mode',
      'embedded',
    ];
    const { main, harness } = await importMainWithMocks({
      config: { provider: 'config-provider', runtimeMode: 'daemon' },
    });

    await main();

    expect(harness.runtimeOptions[0]).toMatchObject({
      mode: 'embedded',
      defaultProvider: 'env-provider',
      autoStartDaemon: false,
      externalAgents: expect.objectContaining({ factories: [] }),
    });
  });

  it('creates a Worker-hosted runtime with the configured A2A plane when worker.configuredA2A is set', async () => {
    process.argv = ['node', 'kodax', '-p', 'configured A2A task'];
    const { main, harness } = await importMainWithMocks({
      config: { provider: 'mock-provider', worker: { configuredA2A: true } },
    });

    await main();

    expect(harness.createKodaXRuntime).toHaveBeenCalledOnce();
    expect(harness.runtimeOptions[0]).toMatchObject({
      mode: 'embedded',
      profile: 'default',
      isolation: 'worker',
      worker: { configuredA2A: true },
    });
    // Function-valued externalAgents cannot cross the Worker boundary; the
    // Worker owner installs the configured A2A plane itself.
    expect(harness.runtimeOptions[0]).not.toHaveProperty('externalAgents');
  });

  it.each([
    {
      label: 'configured MCP servers',
      config: {
        provider: 'mock-provider',
        worker: { configuredA2A: true },
        mcpServers: { reporting: { connect: 'lazy' } },
      },
    },
    {
      label: 'configured extensions',
      config: {
        provider: 'mock-provider',
        worker: { configuredA2A: true },
        extensions: ['C:/extensions/reviewer.mjs'],
      },
    },
  ])('rejects Worker-hosted A2A when $label would be lost at the transport boundary', async ({
    config,
  }) => {
    process.argv = ['node', 'kodax', '-p', 'preserve all configured capabilities'];
    const { main, harness } = await importMainWithMocks({ config });

    await expect(main()).rejects.toThrow(/worker\.configuredA2A.*MCP.*Extensions.*inline/i);
    expect(harness.createKodaXRuntime).not.toHaveBeenCalled();
  });

  it('keeps the inline external-agents plane when worker.configuredA2A is unset', async () => {
    process.argv = ['node', 'kodax', '-p', 'inline A2A task'];
    const { main, harness } = await importMainWithMocks({
      config: { provider: 'mock-provider' },
    });

    await main();

    expect(harness.runtimeOptions[0]).toMatchObject({
      mode: 'embedded',
      externalAgents: expect.objectContaining({ factories: [] }),
    });
    expect(harness.runtimeOptions[0]).not.toHaveProperty('isolation');
    expect(harness.runtimeOptions[0]).not.toHaveProperty('worker');
  });

  it('does not fall through to interactive mode after daemon subcommands', async () => {
    process.env.VITEST = 'true';
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-daemon-cli-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      process.argv = [
        'node',
        'kodax',
        'daemon',
        'status',
        '--home',
        homeDir,
        '--profile',
        'test',
        '--json',
      ];
      const { main, harness } = await importMainWithMocks();

      await main();

      expect(harness.runInkInteractiveMode).not.toHaveBeenCalled();
      expect(harness.runInteractiveMode).not.toHaveBeenCalled();
      expect(harness.createKodaXRuntime).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"health": "missing"'));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('does not fall through when a root option precedes a subcommand', async () => {
    process.env.VITEST = 'true';
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-prefixed-daemon-cli-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      process.argv = [
        'node',
        'kodax',
        '--provider',
        'prefixed-provider',
        'daemon',
        'status',
        '--home',
        homeDir,
        '--profile',
        'test',
        '--json',
      ];
      const { main, harness } = await importMainWithMocks();

      await main();

      expect(harness.runInkInteractiveMode).not.toHaveBeenCalled();
      expect(harness.runInteractiveMode).not.toHaveBeenCalled();
      expect(harness.createKodaXRuntime).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"health": "missing"'));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
