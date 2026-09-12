import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NewSessionRequest, PromptRequest, SetSessionModeRequest } from '@agentclientprotocol/sdk';
import type { KodaXResult } from '@kodax-ai/coding';

type RuntimeConfigMock = {
  provider: string;
  model?: string;
  thinking?: boolean;
  effort?: string;
  reasoningMode: string;
};

const originalProvider = process.env.KODAX_PROVIDER;
const originalEffort = process.env.KODAX_EFFORT;

const acpServerState = vi.hoisted(() => ({
  capturedOptions: [] as unknown[],
  startKodaX: vi.fn((options: { session?: { id?: string } }) => {
    acpServerState.capturedOptions.push(options);
    const sessionId = options.session?.id ?? 'missing-session';
    return {
      id: sessionId,
      attached: true,
      currentProvider: 'openai',
      currentModel: undefined,
      currentReasoning: undefined,
      aborted: false,
      setProvider: vi.fn(),
      setModel: vi.fn(),
      setReasoning: vi.fn(),
      abort: vi.fn(),
      result: Promise.resolve<KodaXResult>({
        lastText: "",
        interrupted: false,
        success: true,
        messages: [],
        sessionId,
      }),
    };
  }),
  prepareRuntimeConfig: vi.fn<() => RuntimeConfigMock>(() => ({
    provider: 'openai',
    reasoningMode: 'auto',
  })),
}));

vi.mock('@kodax-ai/coding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/coding')>();
  return {
    ...actual,
    KODAX_DEFAULT_PROVIDER: 'openai',
    buildMcpReverseCapabilities: vi.fn(() => ({})),
    combineExtensionRuntimes: vi.fn((primary: unknown) => primary),
    createBashPrefixExtractor: vi.fn(() => ({})),
    createExtensionRuntime: vi.fn(() => ({
      activate: vi.fn(),
      dispose: vi.fn(async () => undefined),
    })),
    dedupeExtensionPathsByEntrypoint: vi.fn((paths: string[]) => paths),
    discoverDefaultExtensions: vi.fn(async () => []),
    excludeExtensionPathsByEntrypoint: vi.fn((paths: string[]) => paths),
    isToolFileMutation: vi.fn(() => false),
    normalizeReasoningEffortValue: (value: string): string => {
      const normalized = value.trim().toLowerCase();
      if (!normalized) {
        throw new Error('Reasoning effort cannot be empty.');
      }
      return normalized;
    },
    parseReasoningEffortEnv: (raw: string | undefined) => {
      const normalized = raw?.trim().toLowerCase();
      if (!normalized) return { kind: 'unset' };
      if (normalized === 'auto' || normalized === 'unset') return { kind: 'clear' };
      return { kind: 'value', value: normalized };
    },
    registerConfiguredMcpCapabilityProvider: vi.fn(async () => undefined),
    registerCustomProviders: vi.fn(),
    resolveProvider: vi.fn(() => ({})),
    generateSessionId: vi.fn(async () => 'generated-session'),
    runManagedTask: vi.fn(),
    startKodaX: acpServerState.startKodaX,
    shutdownDefaultLspService: vi.fn(async () => undefined),
  };
});

vi.mock('@kodax-ai/repl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/repl')>();
  return {
    ...actual,
    KODAX_CONFIG_FILE: 'C:/Users/test/.kodax/config.json',
    collectBashWriteTargets: vi.fn(() => []),
    computeConfirmTools: vi.fn(() => []),
    generateSavePattern: vi.fn(() => ''),
    getBashOutsideProjectWriteRisk: vi.fn(() => ({ risky: false })),
    getPlanModeBlockReason: vi.fn(() => null),
    isAlwaysConfirmPath: vi.fn(() => false),
    isBashReadCommand: vi.fn(() => true),
    isPathInsideProject: vi.fn(() => true),
    isToolCallAllowed: vi.fn(() => ({ allowed: true })),
    prepareRuntimeConfig: acpServerState.prepareRuntimeConfig,
    resolveRuntimeProviderSelection: (input: {
      explicitProvider?: string;
      environmentProvider?: string;
      configuredProvider?: string;
      defaultProvider: string;
    }) => input.explicitProvider
      ?? input.environmentProvider
      ?? input.configuredProvider
      ?? input.defaultProvider,
    resolveRuntimeModelSelection: (input: {
      explicitProvider?: string;
      environmentProvider?: string;
      explicitModel?: string;
      configuredProvider?: string;
      configuredModel?: string;
    }) => {
      if (input.explicitModel) return input.explicitModel;
      const providerOverride = input.explicitProvider ?? input.environmentProvider;
      if (!providerOverride) return input.configuredModel;
      return providerOverride === input.configuredProvider ? input.configuredModel : undefined;
    },
    resolveRuntimeEffortSelection: (input: {
      explicitEffort?: string;
      environmentEffort?: string;
      configuredEffort?: string;
    }) => {
      if (input.explicitEffort !== undefined) return input.explicitEffort;
      const environmentEffort = input.environmentEffort?.trim().toLowerCase();
      if (environmentEffort && environmentEffort !== 'auto' && environmentEffort !== 'unset') {
        return environmentEffort;
      }
      return input.configuredEffort;
    },
  };
});

import {
  KodaXAcpServer,
  type KodaXAcpServerOptions,
} from './acp_server.js';
import { createKodaXRuntime } from './sdk-runtime.js';
import { FileSessionStorage } from '@kodax-ai/repl';

type PromptRequestWithEffort = PromptRequest & {
  effort?: string;
};

function makePrompt(sessionId: string, effort?: string): PromptRequestWithEffort {
  return {
    sessionId,
    prompt: [{ type: 'text', text: 'hello' }],
    ...(effort !== undefined ? { effort } : {}),
  } as PromptRequestWithEffort;
}

function lastRunOptions(): Record<string, unknown> {
  const options = acpServerState.capturedOptions.at(-1);
  expect(options).toBeDefined();
  return options as Record<string, unknown>;
}

describe('KodaXAcpServer reasoning effort forwarding', () => {
  let testHome: string;
  const testServers = new Set<KodaXAcpServer>();

  function createTestServer(options: KodaXAcpServerOptions): KodaXAcpServer {
    const server = new KodaXAcpServer({ homeDir: testHome, storage: new FileSessionStorage({ sessionsDir: path.join(testHome, 'sessions'), configHome: testHome }), ...options });
    testServers.add(server);
    return server;
  }

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-acp-unit-'));
    delete process.env.KODAX_PROVIDER;
    delete process.env.KODAX_EFFORT;
    acpServerState.capturedOptions = [];
    acpServerState.startKodaX.mockClear();
    acpServerState.prepareRuntimeConfig.mockClear();
    acpServerState.prepareRuntimeConfig.mockReturnValue({
      provider: 'openai',
      reasoningMode: 'auto',
    });
  });

  afterEach(async () => {
    await Promise.all([...testServers].map((server) => server.dispose()));
    testServers.clear();
    await fs.rm(testHome, { recursive: true, force: true });
    vi.clearAllMocks();
    if (originalProvider === undefined) delete process.env.KODAX_PROVIDER;
    else process.env.KODAX_PROVIDER = originalProvider;
    if (originalEffort === undefined) delete process.env.KODAX_EFFORT;
    else process.env.KODAX_EFFORT = originalEffort;
  });

  async function createSession(server: KodaXAcpServer): Promise<string> {
    const response = await server.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    } as NewSessionRequest);
    return response.sessionId;
  }

  async function switchToPlan(server: KodaXAcpServer, sessionId: string): Promise<void> {
    await server.setSessionMode({
      sessionId,
      modeId: 'plan',
    } as SetSessionModeRequest);
  }

  it('forwards the configured server effort to the Runtime run', async () => {
    const server = createTestServer({ provider: 'openai', effort: 'medium', logLevel: 'off' });
    const sessionId = await createSession(server);

    await server.prompt(makePrompt(sessionId));

    expect(lastRunOptions().effort).toBe('medium');
    await server.dispose();
  });

  it('inherits config model when ACP provider is not overridden', async () => {
    acpServerState.prepareRuntimeConfig.mockReturnValue({
      provider: 'openai',
      model: 'gpt-configured',
      reasoningMode: 'auto',
    });
    const server = createTestServer({ logLevel: 'off' });
    const sessionId = await createSession(server);

    await server.prompt(makePrompt(sessionId));

    expect(lastRunOptions()).toMatchObject({
      provider: 'openai',
      model: 'gpt-configured',
    });
    await server.dispose();
  });

  it('does not carry config model across an ACP provider override', async () => {
    acpServerState.prepareRuntimeConfig.mockReturnValue({
      provider: 'openai',
      model: 'gpt-configured',
      reasoningMode: 'auto',
    });
    const server = createTestServer({ provider: 'anthropic', logLevel: 'off' });
    const sessionId = await createSession(server);

    await server.prompt(makePrompt(sessionId));

    expect(lastRunOptions()).toMatchObject({ provider: 'anthropic' });
    expect(lastRunOptions().model).toBeUndefined();
    await server.dispose();
  });

  it('uses environment provider before config without carrying an incompatible model', async () => {
    process.env.KODAX_PROVIDER = 'anthropic';
    acpServerState.prepareRuntimeConfig.mockReturnValue({
      provider: 'openai',
      model: 'gpt-configured',
      reasoningMode: 'auto',
    });
    const server = createTestServer({ logLevel: 'off' });
    const sessionId = await createSession(server);

    await server.prompt(makePrompt(sessionId));

    expect(lastRunOptions()).toMatchObject({ provider: 'anthropic' });
    expect(lastRunOptions().model).toBeUndefined();
    await server.dispose();
  });

  it('uses environment effort before config effort', async () => {
    process.env.KODAX_EFFORT = 'high';
    acpServerState.prepareRuntimeConfig.mockReturnValue({
      provider: 'openai',
      effort: 'low',
      reasoningMode: 'auto',
    });
    const server = createTestServer({ logLevel: 'off' });
    const sessionId = await createSession(server);

    await server.prompt(makePrompt(sessionId));

    expect(lastRunOptions().effort).toBe('high');
    await server.dispose();
  });

  it('normalizes ACP effort none into legacy reasoning off fields', async () => {
    acpServerState.prepareRuntimeConfig.mockReturnValue({
      provider: 'openai',
      thinking: true,
      reasoningMode: 'deep',
      effort: 'none',
    });
    const server = createTestServer({ logLevel: 'off' });
    const sessionId = await createSession(server);

    await server.prompt(makePrompt(sessionId));

    expect(lastRunOptions()).toMatchObject({
      effort: 'none',
      thinking: false,
      reasoningMode: 'off',
    });
    await server.dispose();
  });

  it('lets a prompt effort override the server default', async () => {
    const server = createTestServer({ provider: 'openai', effort: 'medium', logLevel: 'off' });
    const sessionId = await createSession(server);

    await server.prompt(makePrompt(sessionId, 'high'));

    expect(lastRunOptions().effort).toBe('high');
    await server.dispose();
  });

  it('uses planModeEffort while the ACP session is in plan mode', async () => {
    const server = createTestServer({
      provider: 'openai',
      effort: undefined,
      planModeEffort: 'medium',
      logLevel: 'off',
    });
    const sessionId = await createSession(server);
    await switchToPlan(server, sessionId);

    await server.prompt(makePrompt(sessionId));

    expect(lastRunOptions().effort).toBe('medium');
    await server.dispose();
  });

  it('keeps explicit server effort ahead of planModeEffort', async () => {
    const server = createTestServer({
      provider: 'openai',
      effort: 'high',
      planModeEffort: 'medium',
      logLevel: 'off',
    });
    const sessionId = await createSession(server);
    await switchToPlan(server, sessionId);

    await server.prompt(makePrompt(sessionId));

    expect(lastRunOptions().effort).toBe('high');
    await server.dispose();
  });

  it('lets prompt effort auto clear the server default for one turn', async () => {
    const server = createTestServer({ provider: 'openai', effort: 'medium', logLevel: 'off' });
    const sessionId = await createSession(server);

    await server.prompt(makePrompt(sessionId, 'auto'));

    expect(lastRunOptions().effort).toBeUndefined();
    await server.dispose();
  });

  it('rejects invalid prompt effort before starting a Runtime run', async () => {
    const server = createTestServer({ provider: 'openai', effort: 'medium', logLevel: 'off' });
    const sessionId = await createSession(server);

    await expect(server.prompt(makePrompt(sessionId, '   '))).rejects.toThrow(/Reasoning effort cannot be empty/);
    expect(acpServerState.startKodaX).not.toHaveBeenCalled();
    await server.dispose();
  });

  it('returns cancelled for queued prompts cancelled before coding starts', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-acp-runtime-'));
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
      defaultProvider: 'openai',
    });
    const abortSpies: Array<ReturnType<typeof vi.fn>> = [];
    acpServerState.startKodaX.mockImplementation((options: { session?: { id?: string } }) => {
      acpServerState.capturedOptions.push(options);
      const sessionId = options.session?.id ?? 'missing-session';
      let resolveResult: ((result: KodaXResult) => void) | undefined;
      const result = new Promise<KodaXResult>((resolve) => {
        resolveResult = resolve;
      });
      const abort = vi.fn((_reason?: unknown) => {
        resolveResult?.({
          success: false,
          lastText: '',
          messages: [],
          sessionId,
          interrupted: true,
        });
        resolveResult = undefined;
      });
      abortSpies.push(abort);
      return {
        id: sessionId,
        attached: true,
        currentProvider: 'openai',
        currentModel: undefined,
        currentReasoning: undefined,
        aborted: false,
        setProvider: vi.fn(),
        setModel: vi.fn(),
        setReasoning: vi.fn(),
        abort,
        result,
      };
    });
    const server = createTestServer({ runtime, provider: 'openai', logLevel: 'off' });

    try {
      const sessionId = await createSession(server);
      const first = server.prompt(makePrompt(sessionId));
      await waitForCondition('first ACP coding run', () => acpServerState.startKodaX.mock.calls.length === 1);

      const second = server.prompt(makePrompt(sessionId));
      await waitForCondition('queued ACP runtime run', async () => {
        const runs = await runtime.runs.list({ sessionId });
        return runs.length === 2 && runs.some((run) => run.phase === 'queued');
      });

      const cancel = vi.spyOn(runtime.sessions, 'cancel');
      cancel.mockRejectedValueOnce(new Error('control transport unavailable'));
      await expect(server.cancel({ sessionId })).rejects.toThrow('control transport unavailable');
      expect(abortSpies[0]).not.toHaveBeenCalled();
      await server.cancel({ sessionId });
      expect(cancel.mock.calls[1]?.[0]).toEqual(cancel.mock.calls[0]?.[0]);

      await expect(expectSettles(first, 'first cancelled prompt')).resolves.toMatchObject({
        stopReason: 'cancelled',
      });
      await expect(expectSettles(second, 'queued cancelled prompt')).resolves.toMatchObject({
        stopReason: 'cancelled',
      });
      expect(acpServerState.startKodaX).toHaveBeenCalledTimes(1);
      expect(abortSpies[0]).toHaveBeenCalledOnce();
      const cancelledRuns = await runtime.runs.list({ sessionId });
      expect(cancelledRuns).toHaveLength(2);
      expect(cancelledRuns.map((run) => run.phase)).toEqual(['interrupted', 'cancelled']);
    } finally {
      await server.dispose();
      await runtime.close();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function waitForCondition(label: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not happen`);
}

async function expectSettles<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 250);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
