import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type InteractiveSurface = 'ink' | 'classic';

interface RuntimeConfig {
  readonly provider?: string;
  readonly model?: string;
  readonly sessionRetentionDays?: number;
  readonly extensions?: readonly string[];
  readonly mcpServers?: Record<string, { readonly connect?: string }>;
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
  readonly createKodaXHostRuntime: ReturnType<typeof vi.fn>;
  readonly ensureKodaXRuntime: ReturnType<typeof vi.fn>;
  readonly connectReplHost: ReturnType<typeof vi.fn>;
  /** What each one-shot Run was given: the options and the prompt. */
  readonly oneShotRuns: Array<{ readonly options: Record<string, unknown>; readonly prompt: string }>;
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
  vi.doUnmock('./repl-host/connect.js');
  vi.doUnmock('./sandbox-runtime.js');
  vi.doUnmock('./a2a/runtime-config.js');
  vi.doUnmock('./runtime-daemon/manager.js');
  vi.doUnmock('./runtime-daemon/lifecycle.js');
  vi.doUnmock('./runtime-daemon/process.js');
  vi.doUnmock('./provider-credential-manager.js');
  vi.doUnmock('./cli-provider-credentials.js');
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
  /** Runs when the REPL's v2 connection to the Host is closed. */
  readonly hostClose?: () => void;
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
  /** Another Host with this PID already serves the home, so `daemon serve` only attaches. */
  readonly attachedDaemonLeaseOwnerPid?: number;
} = {}): Promise<{
  readonly main: () => Promise<void>;
  readonly harness: InteractiveMainHarness;
}> {
  const calls: string[] = [];
  vi.doMock('./provider-credential-manager.js', () => ({ createProviderCredentialManager: () => ({ describe: async () => ({ stored: false }) }) }));
  vi.doMock('./cli-provider-credentials.js', () => ({ createCliProviderCredentialAccess: () => ({ authorizeExecution: async () => undefined, close: async () => undefined }) }));
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
  const createMockRuntime = async (runtimeOptionsInput: unknown, runtimeMode: 'daemon' | 'embedded') => {
    runtimeOptions.push(runtimeOptionsInput);
    const runtimeOptionsRecord = runtimeOptionsInput !== null && typeof runtimeOptionsInput === 'object'
      ? runtimeOptionsInput as Record<string, unknown>
      : {};
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
        async observeView() {
          return { close: vi.fn() };
        },
        async load() {
          return { id: 'session-1', title: 'Loaded' };
        },
        async create() {
          return { id: 'session-1', title: 'Created' };
        },
        async updateSettings() {
          return {};
        },
        async getSettings() {
          return {};
        },
        async getSettingsVersioned() {
          return { revision: 0, value: {} };
        },
        async updateSettingsVersioned() {
          return { revision: 1, value: {} };
        },
        async delete(sessionId: string) {
          runtimeDeletes.push(sessionId);
        },
      },
      runs: {
        async acceptInput(input: unknown) {
          runtimeStarts.push(input);
          return { inputId: 'input-1', runId: 'run-1', sessionId: 'session-1' };
        },
        async getInput() {
          return { inputId: 'input-1', state: 'delivered' };
        },
        async get() {
          return { runId: 'run-1', sessionId: 'session-1', phase: 'completed' };
        },
        async abort() {
          return { accepted: true };
        },
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
  };
  const createKodaXHostRuntime = vi.fn((input: { readonly mode?: string } = {}) =>
    createMockRuntime(input, input.mode === 'daemon' ? 'daemon' : 'embedded'));
  const ensureKodaXRuntime = vi.fn((input: unknown) => createMockRuntime(input, 'daemon'));

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
    installWindowsProcessHelper: vi.fn(),
    getAgentConfigHome: vi.fn(() => join(tmpdir(), 'kodax-cli-test-home')),
    resolveKodaXHome: vi.fn(() => ({ path: join(tmpdir(), 'kodax-cli-test-home'), source: 'default' })),
    getAgentConfigPath: vi.fn((...segments: string[]) => join(tmpdir(), 'kodax-cli-test-home', ...segments)),
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
    discoverExtensionsInDirectory: vi.fn(async () => []),
    excludeExtensionPathsByEntrypoint: vi.fn(async (paths: readonly string[]) => [...paths]),
    registerConfiguredMcpCapabilityProvider: vi.fn(async () => {
      calls.push('register-mcp');
    }),
    replaceConfiguredMcpCapabilityProvider: vi.fn(async () => undefined),
    buildMcpReverseCapabilities: vi.fn(() => ({})),
    KODAX_DEFAULT_PROVIDER: 'mock-provider',
    DEFAULT_CLASSIFIER_TIMEOUT_MS: 90_000,
    DEFAULT_CLASSIFIER_RETRY_TIMEOUT_MS: 180_000,
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

  // The REPL's v2 connection to the Host.
  const connectReplHost = vi.fn(async (_input: unknown) => ({
    client: {
      call: vi.fn(async (method: string) => (method === 'host.get'
        ? {
          host: { id: 'rt_mock_interactive', version: '0.7.66-test', mode: 'daemon', profile: 'default', startedAt: Date.parse('2026-07-09T00:00:00.000Z') },
          counts: { sessions: 0, runs: 0, activeRuns: 0, queuedRuns: 0, workflows: 0 },
        }
        : { items: [] })),
      close: () => {
        calls.push('host-close');
        options.hostClose?.();
      },
    },
    leases: async () => undefined,
  }));
  vi.doMock('./repl-host/connect.js', () => ({ connectReplHost, createReplHostBindings: vi.fn(() => ({})) }));
  const oneShotRuns: InteractiveMainHarness['oneShotRuns'] = [];
  vi.doMock('./one-shot-task.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./one-shot-task.js')>()),
    runOneShotClientTask: vi.fn(async (input: { options: Record<string, unknown>; prompt: string }) => {
      oneShotRuns.push({ options: input.options, prompt: input.prompt });
      return { success: true, lastText: 'done', messages: [], sessionId: 'session-1' };
    }),
  }));
  if (options.mockSdkRuntime !== false) {
    vi.doMock('./sdk-runtime.js', () => ({
      createKodaXHostRuntime,
      ensureKodaXRuntime,
      resolveHostRuntimeConfigFile: (homeDir: string | undefined) => join(homeDir ?? tmpdir(), '.kodax', 'config.json'),
    }));
  }
  vi.doMock('./sandbox-runtime.js', () => ({
    isWindowsSandboxV2SetupCurrent: vi.fn(() => true),
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
  if (options.attachedDaemonLeaseOwnerPid !== undefined) {
    const ownerPid = options.attachedDaemonLeaseOwnerPid;
    vi.doMock('./runtime-daemon/manager.js', () => ({
      acquireRuntimeDaemonLease: vi.fn(async () => ({
        transport: {},
        endpoint: { path: 'mock-daemon-endpoint' },
        paths: {},
        ownsHost: false,
        close: vi.fn(async () => undefined),
        shutdown: daemonShutdown,
      })),
    }));
    vi.doMock('./runtime-daemon/lifecycle.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./runtime-daemon/lifecycle.js')>()),
      observeRuntimeDaemonHealth: vi.fn(async () => ({
        state: { pid: ownerPid },
        pidAlive: true,
        endpointReachable: true,
        identityMatches: true,
      })),
    }));
    // The real one redirects this worker's stdout and stderr into the bootstrap log.
    vi.doMock('./runtime-daemon/process.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./runtime-daemon/process.js')>()),
      detachRuntimeDaemonBootstrapOutput: vi.fn(),
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
      createKodaXHostRuntime,
      ensureKodaXRuntime,
      connectReplHost,
      oneShotRuns,
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
      'host',
      'serve',
      '--home',
      daemonHome,
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
      'shutdown-lsp',
      'cleanup-children-final',
      'shutdown-tracing',
    ].includes(call));
    expect(completed).toEqual([
      'runtime-close',
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
      'host',
      'serve',
      '--home',
      daemonHome,
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
      'host',
      'serve',
      '--home',
      daemonHome,
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
      'host',
      'serve',
      '--home',
      daemonHome,
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
      'host',
      'serve',
      '--home',
      daemonHome,
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

  it('ends a daemon serve whose Host never finishes closing with final cleanup, a failed outcome and exit 1', async () => {
    const daemonHome = await mkdtemp(join(tmpdir(), 'kodax-daemon-cleanup-'));
    daemonTempHomes.push(daemonHome);
    process.argv = ['node', 'kodax', 'host', 'serve', '--home', daemonHome, '--provider', 'mock-provider'];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { main, harness } = await importMainWithMocks({
      mockDaemonLease: true,
      runtimeClose: () => new Promise<void>(() => undefined),
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let settled = false;
      const outcome = main().then(() => undefined, (error: unknown) => error).finally(() => { settled = true; });
      await vi.waitFor(() => expect(harness.daemonShutdown).toHaveBeenCalled());
      // The Host keeps the whole 90-second close slice of the shutdown deadline.
      await vi.advanceTimersByTimeAsync(85_000);
      expect(settled).toBe(false);
      expect(harness.calls).not.toContain('shutdown-lsp');
      await vi.advanceTimersByTimeAsync(5_000);
      // Final cleanup then runs in real time; its own phase bounds stay far away.
      for (let turn = 0; !settled && turn < 2_000; turn += 1) {
        await vi.advanceTimersByTimeAsync(1);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      const failure = await outcome;
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/Host did not finish closing within 90 seconds/);
    } finally {
      vi.useRealTimers();
    }
    expect(harness.calls).toEqual(expect.arrayContaining(['shutdown-lsp', 'cleanup-children-final', 'shutdown-tracing']));
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/\[Error\].*did not finish closing/s);
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
    const written = (await readdir(daemonHome, { recursive: true })).filter((entry) => entry.includes('shutdown-outcome.'));
    expect(written).toHaveLength(1);
    expect(JSON.parse(await readFile(join(daemonHome, written[0]!), 'utf8'))).toMatchObject({ status: 'failed' });
  });

  it('fails an operator-run daemon serve when another Host already serves the home', async () => {
    const daemonHome = await mkdtemp(join(tmpdir(), 'kodax-daemon-owned-'));
    daemonTempHomes.push(daemonHome);
    process.argv = ['node', 'kodax', 'host', 'serve', '--home', daemonHome];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { main, harness } = await importMainWithMocks({ attachedDaemonLeaseOwnerPid: 4242 });

    await expect(main()).rejects.toThrow(/PID 4242/);

    const reported = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(reported).toMatch(/\[Error\].*PID 4242.*only one Host/s);
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
    expect(harness.daemonShutdown).not.toHaveBeenCalled();
    expect(harness.runtimeDispose).toHaveBeenCalledTimes(1);
    const written = await readdir(daemonHome, { recursive: true });
    expect(written.filter((entry) => entry.includes('shutdown-outcome.'))).toEqual([]);
  });

  it('keeps a clean exit for an SDK auto-start child that lost the startup race', async () => {
    const daemonHome = await mkdtemp(join(tmpdir(), 'kodax-daemon-owned-'));
    daemonTempHomes.push(daemonHome);
    process.env.KODAX_DAEMON_SERVE = '1';
    process.argv = ['node', 'kodax', 'host', 'serve', '--home', daemonHome];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { main, harness } = await importMainWithMocks({ attachedDaemonLeaseOwnerPid: 4242 });

    await expect(main()).resolves.toBeUndefined();

    expect(exitSpy.mock.calls.filter(([code]) => code !== undefined && code !== 0)).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('[Error]'));
    expect(harness.daemonShutdown).not.toHaveBeenCalled();
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

  it('opens hidden-key setup when first launch has no provider environment variable', async () => {
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

      expect(harness.initializeSetupConfiguration).toHaveBeenCalledOnce();
      expect(harness.runProviderSetupWizard).toHaveBeenCalledOnce();
      expect(harness.renderSetupGuide).toHaveBeenCalledOnce();
      expect(harness.runInkInteractiveMode).not.toHaveBeenCalled();
      expect(harness.runInteractiveMode).not.toHaveBeenCalled();
      expect(harness.createKodaXHostRuntime).not.toHaveBeenCalled();
      expect(harness.ensureKodaXRuntime).not.toHaveBeenCalled();
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
      expect(harness.createKodaXHostRuntime).not.toHaveBeenCalled();
      expect(harness.ensureKodaXRuntime).not.toHaveBeenCalled();
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
        'KodaX setup guide',
      ));
      expect(harness.initializeSetupConfiguration).toHaveBeenCalledOnce();
      expect(harness.runProviderSetupWizard).toHaveBeenCalledOnce();
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
    expect(harness.shutdownDefaultLspService).toHaveBeenCalledTimes(1);
    expect(harness.cleanupRegisteredManagedChildren).toHaveBeenCalledExactlyOnceWith({
      scope: 'current-owner', includeCurrentOwner: true,
    });
    expect(harness.shutdownTracing).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    // FEATURE_298 T27 — fixed Host: no client-side extension runtime, MCP
    // provider registration, or extension dispose (the Host owns those).
    expect(harness.calls).toEqual([
      'hardening',
      'bootstrap-tracing',
      'session-retention',
      'run-ink',
      'host-close',
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
    expect(harness.calls).toContain('shutdown-lsp');
    expect(harness.calls).not.toContain('cleanup-children-final');

    lspDeferred.resolve();
    await mainPromise;

    expect(harness.calls).toContain('shutdown-tracing');
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('does not close the Host connection or exit before a claimed memory review settles', async () => {
    process.env.KODAX_INTERNAL_INTERACTIVE_FINAL_CLEANUP_TIMEOUT_MS = '200';
    const reviewDeferred = createDeferred();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const { main, harness } = await importMainWithMocks({
      memoryReviewDrain: () => reviewDeferred.promise,
    });

    const mainPromise = main();
    await vi.waitFor(() => expect(harness.awaitLatestCodingMemoryReviewDrain).toHaveBeenCalledWith(15_000));

    expect(harness.calls).not.toContain('host-close');
    expect(exitSpy).not.toHaveBeenCalled();
    reviewDeferred.resolve();
    await mainPromise;
    expect(harness.calls).toContain('host-close');
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

  it('continues host cleanup when closing the Host connection fails', async () => {
    const closeError = new Error('host close failed');
    const { main, harness } = await importMainWithMocks({
      hostClose: () => { throw closeError; },
    });

    await expect(main()).rejects.toBe(closeError);

    expect(harness.calls).toEqual(expect.arrayContaining([
      'host-close',
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
      'shutdown-lsp',
      'cleanup-children-final',
      'shutdown-tracing',
    ]));
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('runs the interactive REPL on the fixed Host regardless of the retired KODAX_RUNTIME_MODE env', async () => {
    const previousRuntimeMode = process.env.KODAX_RUNTIME_MODE;
    process.env.KODAX_RUNTIME_MODE = 'daemon';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    try {
      const { main, harness } = await importMainWithMocks({ mockSdkRuntime: true });

      await main();

      expect(harness.runInkInteractiveMode).toHaveBeenCalledTimes(1);
      // The REPL runs on the Host over v2; nothing opens a v1 connection.
      expect(harness.connectReplHost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        version: expect.any(String),
        authorize: expect.any(Function),
      }));
      expect(harness.ensureKodaXRuntime).not.toHaveBeenCalled();
      expect(harness.createKodaXHostRuntime).not.toHaveBeenCalled();
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
        startedAt: '2026-07-09T00:00:00.000Z',
        sessions: 0,
        runs: 0,
        pendingPermissions: 0,
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

  it('runs print mode on the Host over v2', async () => {
    process.argv = ['node', 'kodax', '-p', 'inspect the repo'];
    const { main, harness } = await importMainWithMocks({
      config: { provider: 'mock-provider' },
    });

    await main();

    expect(harness.connectReplHost).toHaveBeenCalledOnce();
    expect(harness.ensureKodaXRuntime).not.toHaveBeenCalled();
    expect(harness.createKodaXHostRuntime).not.toHaveBeenCalled();
    expect(harness.oneShotRuns).toEqual([expect.objectContaining({ prompt: 'inspect the repo' })]);
    expect(harness.runManagedTask).not.toHaveBeenCalled();
    expect(harness.calls).toContain('host-close');
  });

  it('asks for a temporary Session for --no-session runs', async () => {
    process.argv = ['node', 'kodax', '-p', 'stateless task', '--no-session'];
    const { main, harness } = await importMainWithMocks({
      config: { provider: 'mock-provider' },
    });

    await main();

    // No session option means a temporary Session, which the Host deletes when its Run ends.
    expect(harness.oneShotRuns).toHaveLength(1);
    expect(harness.oneShotRuns[0]?.options.session).toBeUndefined();
    expect(harness.runtimeDeletes).toEqual([]);
  });

  it('applies CLI > env > config precedence to the provider on the fixed Host', async () => {
    process.env.KODAX_PROVIDER = 'env-provider';
    process.argv = ['node', 'kodax', '-p', 'precedence task'];
    const { main, harness } = await importMainWithMocks({
      config: { provider: 'config-provider' },
    });

    await main();

    // Env still wins over config for the provider the Run uses.
    expect(harness.oneShotRuns[0]?.options).toMatchObject({ provider: 'env-provider' });
  });

  it('ignores the retired worker.configuredA2A key and stays on the fixed Host', async () => {
    process.argv = ['node', 'kodax', '-p', 'inline A2A task'];
    const { main, harness } = await importMainWithMocks({
      config: {
        provider: 'mock-provider',
        ...({ worker: { configuredA2A: true } } as Record<string, unknown>),
      },
    });

    await main();

    expect(harness.connectReplHost).toHaveBeenCalledOnce();
    expect(harness.ensureKodaXRuntime).not.toHaveBeenCalled();
    expect(harness.createKodaXHostRuntime).not.toHaveBeenCalled();
    expect(harness.oneShotRuns[0]?.options).not.toHaveProperty('worker');
  });

  it('does not fall through to interactive mode after daemon subcommands', async () => {
    process.env.VITEST = 'true';
    const homeDir = await mkdtemp(join(tmpdir(), 'kodax-daemon-cli-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      process.argv = [
        'node',
        'kodax',
        'host',
        'status',
        '--home',
        homeDir,
        '--json',
      ];
      const { main, harness } = await importMainWithMocks();

      await main();

      expect(harness.runInkInteractiveMode).not.toHaveBeenCalled();
      expect(harness.runInteractiveMode).not.toHaveBeenCalled();
      expect(harness.createKodaXHostRuntime).not.toHaveBeenCalled();
      expect(harness.ensureKodaXRuntime).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"health": "stopped"'));
      expect(process.exitCode).toBe(3);
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
        'host',
        'status',
        '--home',
        homeDir,
        '--json',
      ];
      const { main, harness } = await importMainWithMocks();

      await main();

      expect(harness.runInkInteractiveMode).not.toHaveBeenCalled();
      expect(harness.runInteractiveMode).not.toHaveBeenCalled();
      expect(harness.createKodaXHostRuntime).not.toHaveBeenCalled();
      expect(harness.ensureKodaXRuntime).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"health": "stopped"'));
      expect(process.exitCode).toBe(3);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
