import { TransformStream } from 'node:stream/web';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import type {
  KodaXExtensionRuntime,
  KodaXOptions,
  KodaXReasoningMode,
  KodaXResult,
  RunningSession,
} from '@kodax-ai/coding';
import type { AcpLogLevel } from '../src/acp_logger.js';
import type { AcpEventSink, AcpRuntimeEvent } from '../src/acp_events.js';
import { FileSessionStorage } from '@kodax-ai/repl';

const {
  runKodaXMock,
  startKodaXMock,
  buildMcpReverseCapabilitiesMock,
  discoverDefaultExtensionsMock,
  registerConfiguredMcpCapabilityProviderMock,
} = vi.hoisted(() => ({
  runKodaXMock: vi.fn<[KodaXOptions, string], Promise<KodaXResult>>(),
  startKodaXMock: vi.fn<[KodaXOptions, string], RunningSession>(),
  buildMcpReverseCapabilitiesMock: vi.fn(),
  discoverDefaultExtensionsMock: vi.fn(async () => [] as string[]),
  registerConfiguredMcpCapabilityProviderMock: vi.fn(),
}));

const { prepareRuntimeConfigMock } = vi.hoisted(() => ({
  prepareRuntimeConfigMock: vi.fn(),
}));

// FEATURE_153 (v0.7.38) wired the LLM-backed `bashPrefixExtractor` into
// `isToolCallAllowed` for the ACP `allow_always` cache lookup. Without
// a stub, the test-env extractor has no real provider configured and
// the catch block in `permission.ts:478-491` returns false, causing
// every "remembered" bash command to fall through to a fresh
// `requestPermission` round-trip — `supports allow_always` then sees
// 2 permission requests where 1 is expected. Stub returns the same
// first-two-words extraction that `generateSavePattern` uses for the
// stored pattern, so the cache hit fires deterministically without any
// LLM call. Equality model matches
// `matchesBashPatternByExtractedPrefix(extracted, 'echo test')`.
vi.mock('@kodax-ai/coding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/coding')>();
  startKodaXMock.mockImplementation((options, prompt) => {
    const abortController = new AbortController();
    if (options.abortSignal?.aborted) {
      abortController.abort(options.abortSignal.reason);
    } else {
      options.abortSignal?.addEventListener(
        'abort',
        () => abortController.abort(options.abortSignal?.reason),
        { once: true },
      );
    }

    let provider = options.provider ?? '';
    let model = options.modelOverride ?? options.model;
    let reasoning: KodaXReasoningMode | undefined = options.reasoningMode;
    const result = Promise.resolve()
      .then(() => runKodaXMock({
        ...options,
        abortSignal: abortController.signal,
      }, prompt));

    return {
      id: options.session?.id ?? 'mock-session',
      get currentProvider() {
        return provider;
      },
      get currentModel() {
        return model;
      },
      get currentReasoning() {
        return reasoning;
      },
      get aborted() {
        return abortController.signal.aborted;
      },
      get attached() {
        return true;
      },
      setProvider(name) {
        provider = name;
      },
      setModel(nextModel) {
        model = nextModel;
      },
      setReasoning(nextReasoning) {
        reasoning = nextReasoning;
      },
      abort(reasonArg) {
        abortController.abort(reasonArg);
      },
      result,
    };
  });
  return {
    ...actual,
    runKodaX: runKodaXMock,
    startKodaX: startKodaXMock,
    buildMcpReverseCapabilities: buildMcpReverseCapabilitiesMock,
    discoverDefaultExtensions: discoverDefaultExtensionsMock,
    registerConfiguredMcpCapabilityProvider: registerConfiguredMcpCapabilityProviderMock,
    createBashPrefixExtractor: () => ({
      async extract(command: string) {
        const parts = command.trim().split(/\s+/);
        const value = parts.slice(0, Math.min(parts.length, 2)).join(' ');
        return { kind: 'prefix' as const, value };
      },
    }),
  };
});

vi.mock('@kodax-ai/repl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/repl')>();
  return {
    ...actual,
    prepareRuntimeConfig: prepareRuntimeConfigMock,
  };
});

import { KodaXAcpServer } from '../src/acp_server.js';
import { createKodaXRuntime, type KodaXRuntime } from '../src/sdk-runtime.js';

declare global {
  // eslint-disable-next-line no-var
  var __kodaxAcpExtensionActivations: string[] | undefined;
}

let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
const stderrLines: string[] = [];
const harnessServers = new Set<KodaXAcpServer>();
const harnessTempRoots = new Set<string>();
const harnessRuntimes = new Set<KodaXRuntime>();

function assertIsolatedAcpTestPath(candidate: string): void {
  const userStateRoot = path.resolve(os.homedir(), '.kodax');
  const resolved = path.resolve(candidate);
  const relative = path.relative(userStateRoot, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`ACP test storage must not use the real user state root: ${resolved}`);
  }
}

function createResult(overrides: Partial<Awaited<ReturnType<typeof runKodaXMock>>> = {}) {
  return {
    success: true,
    lastText: '',
    messages: [],
    sessionId: 'mock-session',
    interrupted: false,
    ...overrides,
  };
}

async function waitForCondition(
  label: string,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not happen`);
}

async function createHarness(options: {
  onPermissionRequest?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  onSessionUpdate?: (notification: SessionNotification) => Promise<void>;
  serverCwd?: string;
  sessionCwd?: string;
  logLevel?: AcpLogLevel;
  eventSinks?: AcpEventSink[];
  mcpServers?: McpServer[];
  storage?: FileSessionStorage;
  runtimeOwnedByTest?: boolean;
} = {}) {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-acp-harness-'));
  harnessTempRoots.add(runtimeHome);
  const storage = options.storage ?? new FileSessionStorage({
    sessionsDir: path.join(runtimeHome, '.kodax', 'sessions'),
  });
  assertIsolatedAcpTestPath(runtimeHome);
  assertIsolatedAcpTestPath(storage.getSessionsDir());
  const requestStream = new TransformStream<Uint8Array, Uint8Array>();
  const responseStream = new TransformStream<Uint8Array, Uint8Array>();
  const updates: SessionNotification[] = [];
  const permissionRequests: RequestPermissionRequest[] = [];
  const events: AcpRuntimeEvent[] = [];
  const recordingSink: AcpEventSink = {
    handleEvent(event) {
      events.push(event);
    },
  };

  const runtime = options.runtimeOwnedByTest
    ? await createKodaXRuntime({
        homeDir: runtimeHome,
        sessionsDir: storage.getSessionsDir(),
        profile: 'acp-test',
        defaultProvider: 'openai',
      })
    : undefined;
  if (runtime) harnessRuntimes.add(runtime);
  const server = new KodaXAcpServer({
    ...(options.serverCwd ? { cwd: options.serverCwd } : {}),
    provider: 'openai',
    permissionMode: 'accept-edits',
    agentVersion: 'test',
    homeDir: runtimeHome,
    logLevel: options.logLevel ?? 'off',
    eventSinks: [recordingSink, ...(options.eventSinks ?? [])],
    storage,
    ...(runtime ? { runtime } : {}),
  });
  harnessServers.add(server);
  server.attach(requestStream.readable, responseStream.writable);

  const client = new ClientSideConnection(
    () => ({
      sessionUpdate: async (notification: SessionNotification) => {
        updates.push(notification);
        await options.onSessionUpdate?.(notification);
      },
      requestPermission: async (request: RequestPermissionRequest) => {
        permissionRequests.push(request);
        if (options.onPermissionRequest) {
          return options.onPermissionRequest(request);
        }
        return {
          outcome: {
            outcome: 'selected',
            optionId: 'allow_once',
          },
        };
      },
    }),
    ndJsonStream(requestStream.writable, responseStream.readable),
  );

  await client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: {
      name: 'kodax-test-client',
      version: '1.0.0',
    },
  });

  const session = await client.newSession({
    cwd: options.sessionCwd ?? process.cwd(),
    mcpServers: options.mcpServers ?? [],
  });

  return {
    client,
    server,
    updates,
    events,
    permissionRequests,
    sessionId: session.sessionId,
    modes: session.modes,
    storage,
    runtimeHome,
    runtime,
  };
}

describe('KodaXAcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runKodaXMock.mockResolvedValue(createResult());
    prepareRuntimeConfigMock.mockReturnValue({
      provider: 'openai',
      thinking: false,
      reasoningMode: 'auto',
      permissionMode: 'accept-edits',
    });
    buildMcpReverseCapabilitiesMock.mockImplementation((workspace: { cwd: string }) => ({
      listRoots: () => [{ uri: `mock://${workspace.cwd}`, name: 'mock' }],
    }));
    discoverDefaultExtensionsMock.mockResolvedValue([]);
    registerConfiguredMcpCapabilityProviderMock.mockResolvedValue(undefined);
    stderrLines.length = 0;
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrLines.push(String(chunk).replace(/\r?\n$/, ''));
      return true;
    });
  });

  afterEach(async () => {
    stderrWriteSpy.mockRestore();
    delete globalThis.__kodaxAcpExtensionActivations;
    await Promise.all([...harnessServers].map((server) => server.dispose()));
    harnessServers.clear();
    await Promise.all([...harnessRuntimes].map((runtime) => runtime.close()));
    harnessRuntimes.clear();
    await Promise.all([...harnessTempRoots].map((root) => rm(root, { recursive: true, force: true })));
    harnessTempRoots.clear();
  });

  it('streams assistant and tool events over ACP notifications', async () => {
    runKodaXMock.mockImplementation(async (options, prompt: string) => {
      expect(prompt).toBe('Review this repository');
      options.events?.onTextDelta?.('Hello from ACP');
      options.events?.onToolUseStart?.({
        name: 'read',
        id: 'tool-read',
        input: { path: 'README.md' },
      });
      options.events?.onToolResult?.({
        id: 'tool-read',
        name: 'read',
        content: 'done',
      });
      return createResult({ lastText: 'Hello from ACP' });
    });

    const harness = await createHarness();
    const response = await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Review this repository' }],
    });

    expect(response.stopReason).toBe('end_turn');
    expect(harness.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: harness.sessionId,
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
          }),
        }),
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-read',
            title: 'read',
          }),
        }),
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-read',
            status: 'completed',
          }),
        }),
      ]),
    );
  });

  it('hydrates runtime config during ACP server construction', () => {
    new KodaXAcpServer({
      logLevel: 'off',
    });

    expect(prepareRuntimeConfigMock).toHaveBeenCalledTimes(1);
  });

  it('advertises only the four canonical permission profiles', async () => {
    const harness = await createHarness();

    expect(harness.modes).toEqual({
      currentModeId: 'accept-edits',
      availableModes: expect.arrayContaining([
        expect.objectContaining({ id: 'plan', name: 'Plan' }),
        expect.objectContaining({ id: 'accept-edits', name: 'Edits' }),
        expect.objectContaining({ id: 'auto', name: 'Auto[LLM]' }),
        expect.objectContaining({ id: 'full-access', name: 'Full Access' }),
      ]),
    });
    expect(harness.modes?.availableModes.map((mode) => mode.id)).toEqual([
      'plan',
      'accept-edits',
      'auto',
      'full-access',
    ]);
  });

  it('accepts the legacy auto-in-project input but publishes canonical Auto[LLM]', async () => {
    const harness = await createHarness();

    await harness.client.setSessionMode({
      sessionId: harness.sessionId,
      modeId: 'auto-in-project',
    });

    expect(harness.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: harness.sessionId,
        update: expect.objectContaining({
          sessionUpdate: 'current_mode_update',
          currentModeId: 'auto',
        }),
      }),
    ]));
  });

  it('uses the injected storage root for runtime-owned ACP sessions', async () => {
    const sessionsDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-acp-storage-'));
    const storage = new FileSessionStorage({ sessionsDir });
    const harness = await createHarness({ storage });

    try {
      expect(storage.getSessionsDir()).toBe(path.resolve(sessionsDir));
      await harness.client.prompt({
        sessionId: harness.sessionId,
        prompt: [{ type: 'text', text: 'Use isolated storage' }],
      });
      await expect(storage.load(harness.sessionId)).resolves.toMatchObject({
        runtimeInfo: expect.objectContaining({ surface: 'acp' }),
      });
    } finally {
      await harness.server.dispose();
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });

  it('keeps a new ACP session provisional until the first valid prompt', async () => {
    const harness = await createHarness();

    await expect(harness.storage.load(harness.sessionId)).resolves.toBeNull();

    await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Review session persistence' }],
    });

    await expect(harness.storage.load(harness.sessionId)).resolves.toMatchObject({
      title: 'Review session persistence',
      runtimeInfo: expect.objectContaining({ surface: 'acp' }),
    });
  });

  it('does not activate discovered extensions twice for sessions with client MCP servers', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-acp-ext-'));
    const extensionDir = path.join(tempDir, 'pdf4agent');
    const extensionPath = path.join(extensionDir, 'extension.mjs');
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      extensionPath,
      [
        'export default function() {',
        '  globalThis.__kodaxAcpExtensionActivations = globalThis.__kodaxAcpExtensionActivations ?? [];',
        '  globalThis.__kodaxAcpExtensionActivations.push("activated");',
        '}',
      ].join('\n'),
      'utf8',
    );
    discoverDefaultExtensionsMock.mockResolvedValue([extensionPath]);
    registerConfiguredMcpCapabilityProviderMock.mockImplementationOnce(
      async (runtime: KodaXExtensionRuntime) => {
        runtime.registerCapabilityProvider({
          id: 'mcp',
          kinds: ['tool'],
          search: async () => [{ id: 'session-mcp/tool:echo', kind: 'tool' }],
          getPromptContext: async () => 'session MCP context',
        });
        return undefined;
      },
    );
    runKodaXMock.mockImplementation(async (options) => {
      const runtime = options.extensionRuntime;
      expect(runtime).toBeDefined();
      if (!runtime) {
        throw new Error('Expected ACP prompt to receive extension runtime.');
      }
      expect(runtime.getDiagnostics().loadedExtensions).toEqual([
        expect.objectContaining({ path: extensionPath, label: 'pdf4agent' }),
      ]);
      await expect(runtime.searchCapabilities('mcp', 'echo', { kind: 'tool' }))
        .resolves
        .toEqual([expect.objectContaining({ id: 'session-mcp/tool:echo' })]);
      await expect(runtime.getCapabilityPromptContext('mcp'))
        .resolves
        .toContain('session MCP context');
      return createResult();
    });

    try {
      const harness = await createHarness({
        mcpServers: [{
          name: 'session-mcp',
          command: process.execPath,
          args: ['-e', ''],
          env: [],
        }],
      });

      expect(globalThis.__kodaxAcpExtensionActivations).toEqual(['activated']);
      await harness.client.prompt({
        sessionId: harness.sessionId,
        prompt: [{ type: 'text', text: 'Use extension once' }],
      });
      expect(globalThis.__kodaxAcpExtensionActivations).toEqual(['activated']);
      await harness.server.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps an Edits Bash call silent before its sandbox attempt', async () => {
    runKodaXMock.mockImplementation(async (options) => {
      const decision = await options.events?.beforeToolExecute?.(
        'bash',
        { command: 'echo test > README.md' },
        { toolId: 'tool-bash-write' },
      );

      expect(decision).toBe(true);
      return createResult();
    });

    const harness = await createHarness();
    await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Write a note' }],
    });

    expect(harness.permissionRequests).toHaveLength(0);
  });

  it('bridges an Auto[LLM] Runtime permission boundary through ACP', async () => {
    let harness: Awaited<ReturnType<typeof createHarness>>;
    runKodaXMock.mockImplementation(async () => {
      const runtime = harness.runtime;
      if (!runtime) throw new Error('Expected an injected Runtime.');
      const [run] = await runtime.runs.list({ sessionId: harness.sessionId });
      if (!run) throw new Error('Expected the ACP run to be active.');
      const decision = await runtime.permissions.request({
        sessionId: harness.sessionId,
        runId: run.runId,
        toolCallId: 'tool-host-boundary',
        toolName: 'bash',
        inputPreview: JSON.stringify({ command: 'git config --global user.name Test' }),
      });
      expect(decision).toEqual({ type: 'allow_once' });
      return createResult();
    });

    harness = await createHarness({ runtimeOwnedByTest: true });
    await harness.client.setSessionMode({
      sessionId: harness.sessionId,
      modeId: 'auto',
    });
    await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Configure Git' }],
    });

    expect(harness.permissionRequests).toHaveLength(1);
    expect(harness.permissionRequests[0]).toMatchObject({
      sessionId: harness.sessionId,
      toolCall: {
        toolCallId: 'tool-host-boundary',
        title: 'bash',
        rawInput: { command: 'git config --global user.name Test' },
      },
    });
  });

  it('keeps accept-edits mode aligned with REPL by not requesting permission for read tools', async () => {
    runKodaXMock.mockImplementation(async (options) => {
      const decision = await options.events?.beforeToolExecute?.(
        'read',
        { path: 'README.md' },
        { toolId: 'tool-read' },
      );

      expect(decision).toBe(true);
      return createResult();
    });

    const harness = await createHarness();
    await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Read a file' }],
    });

    expect(harness.permissionRequests).toHaveLength(0);
  });

  it('does not ask or change mode for repeated pre-sandbox Edits calls', async () => {
    runKodaXMock.mockImplementation(async (options) => {
      const firstDecision = await options.events?.beforeToolExecute?.(
        'bash',
        { command: 'echo test > README.md' },
        { toolId: 'tool-bash-write-1' },
      );
      const secondDecision = await options.events?.beforeToolExecute?.(
        'bash',
        { command: 'echo test > README.md' },
        { toolId: 'tool-bash-write-2' },
      );

      expect(firstDecision).toBe(true);
      expect(secondDecision).toBe(true);
      return createResult();
    });

    const harness = await createHarness();

    await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Persist two edits' }],
    });

    expect(harness.permissionRequests).toHaveLength(0);
    expect(harness.updates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: harness.sessionId,
          update: expect.objectContaining({
            sessionUpdate: 'current_mode_update',
          }),
        }),
      ]),
    );
  });

  it('cancels the active prompt through the ACP cancel notification', async () => {
    let sawAbort = false;

    runKodaXMock.mockImplementation(async (options) => {
      await new Promise<void>((resolve) => {
        options.abortSignal?.addEventListener('abort', () => {
          sawAbort = true;
          resolve();
        });
      });

      return createResult({
        interrupted: true,
      });
    });

    const harness = await createHarness();
    const promptPromise = harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Cancel this run' }],
    });

    await waitForCondition('active ACP coding run', () => runKodaXMock.mock.calls.length === 1);
    await harness.client.cancel({ sessionId: harness.sessionId });

    const response = await promptPromise;
    expect(sawAbort).toBe(true);
    expect(response.stopReason).toBe('cancelled');
  });

  it('rejects invalid ACP session modes instead of silently coercing them', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const harness = await createHarness();

      await expect(
        harness.client.setSessionMode({
          sessionId: harness.sessionId,
          modeId: 'architect',
        }),
      ).rejects.toMatchObject({
        code: -32602,
        message: expect.stringContaining('Invalid session mode'),
        data: {
          modeId: 'architect',
        },
      });
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('rejects empty ACP prompts before invoking the coding runtime', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const harness = await createHarness();

      await expect(
        harness.client.prompt({
          sessionId: harness.sessionId,
          prompt: [{ type: 'text', text: '   ' }],
        }),
      ).rejects.toMatchObject({
        code: -32602,
        message: expect.stringContaining('Prompt must include at least one text or resource block with content'),
      });

      expect(runKodaXMock).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('passes the session cwd as explicit execution context without mutating process cwd', async () => {
    const originalCwd = process.cwd();
    const sessionCwd = path.join(originalCwd, 'src');
    const harness = await createHarness({ sessionCwd });

    runKodaXMock.mockImplementation(async (options) => {
      expect(options.context?.executionCwd).toBe(path.resolve(sessionCwd));
      expect(process.cwd()).toBe(originalCwd);
      return createResult();
    });

    await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Use this session cwd' }],
    });

    expect(process.cwd()).toBe(originalCwd);
  });

  it('returns prompt usage and reuses the latest token snapshot on the next ACP turn', async () => {
    let callCount = 0;
    runKodaXMock.mockImplementation(async (options) => {
      callCount += 1;

      if (callCount === 1) {
        expect(options.context?.contextTokenSnapshot).toBeUndefined();
        return createResult({
          contextTokenSnapshot: {
            currentTokens: 120,
            baselineEstimatedTokens: 100,
            source: 'api',
            usage: {
              inputTokens: 120,
              outputTokens: 30,
              totalTokens: 150,
            },
          },
        });
      }

      expect(options.context?.contextTokenSnapshot).toEqual({
        currentTokens: 120,
        baselineEstimatedTokens: 100,
        source: 'api',
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        },
      });

      return createResult({
        contextTokenSnapshot: {
          currentTokens: 140,
          baselineEstimatedTokens: 120,
          source: 'api',
          usage: {
            inputTokens: 140,
            outputTokens: 20,
            totalTokens: 160,
          },
        },
      });
    });

    const harness = await createHarness();

    const firstResponse = await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'First prompt' }],
    });

    expect(firstResponse.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    });

    const secondResponse = await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Second prompt' }],
    });

    expect(secondResponse.usage).toEqual({
      inputTokens: 140,
      outputTokens: 20,
      totalTokens: 160,
    });
  });

  it('uses the configured server cwd for ACP sessions when provided', async () => {
    const defaultCwd = process.cwd();
    const harness = await createHarness({
      serverCwd: defaultCwd,
      sessionCwd: path.join(defaultCwd, 'some-other-dir'),
    });

    runKodaXMock.mockImplementationOnce(async (options) => {
      expect(options.context?.executionCwd).toBe(defaultCwd);
      return createResult();
    });

    await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Use configured cwd' }],
    });
  });

  it('uses the configured server cwd for global MCP reverse roots', async () => {
    const serverCwd = path.join(process.cwd(), 'configured-acp-root');
    const mcpServers = {
      local: {
        type: 'stdio' as const,
        command: process.execPath,
        args: ['-e', ''],
        connect: 'lazy' as const,
      },
    };
    prepareRuntimeConfigMock.mockReturnValue({
      provider: 'openai',
      thinking: false,
      reasoningMode: 'auto',
      permissionMode: 'accept-edits',
      mcpServers,
    });

    const server = new KodaXAcpServer({
      cwd: serverCwd,
      logLevel: 'off',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(buildMcpReverseCapabilitiesMock).toHaveBeenCalledWith({
      cwd: path.resolve(serverCwd),
    });
    expect(registerConfiguredMcpCapabilityProviderMock).toHaveBeenCalledWith(
      expect.anything(),
      mcpServers,
      { reverse: expect.objectContaining({ listRoots: expect.any(Function) }) },
    );
    await server.dispose();
  });

  it('fails closed when the ACP client cannot complete a permission request', async () => {
    runKodaXMock.mockImplementation(async (options) => {
      const decision = await options.events?.beforeToolExecute?.(
        'write',
        { path: 'README.md', content: '# test' },
        { toolId: 'tool-write' },
      );

      expect(decision).toContain('[Cancelled]');
      return createResult();
    });

    const harness = await createHarness({
      onPermissionRequest: async () => {
        throw new Error('client disconnected');
      },
    });

    await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Write a note' }],
    });
  });

  it('logs dropped ACP notifications without failing the prompt', async () => {
    runKodaXMock.mockImplementation(async (options) => {
      options.events?.onTextDelta?.('Hello from ACP');
      return createResult({ lastText: 'Hello from ACP' });
    });

    const harness = await createHarness({ logLevel: 'error' });
    const connection = (harness.server as unknown as {
      connection: { sessionUpdate: (...args: unknown[]) => Promise<void> };
    }).connection;
    vi.spyOn(connection, 'sessionUpdate').mockRejectedValue(
      new Error('notification sink offline'),
    );

    const response = await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Review this repository' }],
    });

    expect(response.stopReason).toBe('end_turn');
    await Promise.resolve();
    expect(stderrLines).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Failed to send assistant text chunk'),
        expect.stringContaining(`sessionId=${JSON.stringify(harness.sessionId)}`),
      ]),
    );
    expect(harness.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'notification_failed',
          sessionId: harness.sessionId,
          label: 'assistant text chunk',
          error: 'notification sink offline',
        }),
      ]),
    );
  });

  it('treats abort-style runtime errors as cancellation without emitting ACP error text', async () => {
    runKodaXMock.mockImplementation(async (options) => {
      options.abortSignal?.throwIfAborted?.();
      throw new DOMException('This operation was aborted', 'AbortError');
    });

    const harness = await createHarness({ logLevel: 'info' });
    const updatesBefore = harness.updates.length;

    const response = await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Cancel me via abort error' }],
    });

    expect(response.stopReason).toBe('cancelled');
    expect(harness.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'prompt_cancelled',
          sessionId: harness.sessionId,
        }),
      ]),
    );
    expect(harness.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'prompt_failed',
          sessionId: harness.sessionId,
        }),
      ]),
    );
    expect(harness.updates.slice(updatesBefore)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: expect.objectContaining({
              text: expect.stringContaining('[ACP Server Error]'),
            }),
          }),
        }),
      ]),
    );
  });

  it('emits ACP lifecycle runtime events and still writes stderr logs through the default sink', async () => {
    runKodaXMock.mockResolvedValue(createResult({ lastText: 'done' }));

    const harness = await createHarness({ logLevel: 'info' });
    await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Review this repository' }],
    });

    expect(harness.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'server_attached' }),
        expect.objectContaining({ type: 'initialize_completed' }),
        expect.objectContaining({
          type: 'session_created',
          sessionId: harness.sessionId,
        }),
        expect.objectContaining({
          type: 'prompt_started',
          sessionId: harness.sessionId,
        }),
        expect.objectContaining({
          type: 'prompt_finished',
          sessionId: harness.sessionId,
          stopReason: 'end_turn',
        }),
      ]),
    );
    expect(stderrLines).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ACP server attached'),
        expect.stringContaining('ACP initialize completed'),
        expect.stringContaining('ACP session created'),
        expect.stringContaining('ACP prompt started'),
        expect.stringContaining('ACP prompt finished'),
      ]),
    );
  });

  it('emits structured permission negotiation events', async () => {
    let harness: Awaited<ReturnType<typeof createHarness>>;
    runKodaXMock.mockImplementation(async () => {
      const runtime = harness.runtime;
      if (!runtime) throw new Error('Expected an injected Runtime.');
      const [run] = await runtime.runs.list({ sessionId: harness.sessionId });
      if (!run) throw new Error('Expected the ACP run to be active.');
      await runtime.permissions.request({
        sessionId: harness.sessionId,
        runId: run.runId,
        toolCallId: 'tool-bash-write',
        toolName: 'bash',
        inputPreview: JSON.stringify({ command: 'echo test > README.md' }),
      });
      return createResult();
    });

    harness = await createHarness({
      logLevel: 'info',
      runtimeOwnedByTest: true,
      onPermissionRequest: async () => ({
        outcome: {
          outcome: 'selected',
          optionId: 'allow_once',
        },
      }),
    });
    await harness.client.setSessionMode({
      sessionId: harness.sessionId,
      modeId: 'auto',
    });

    await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Write a note' }],
    });

    expect(harness.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_permission_evaluated',
          sessionId: harness.sessionId,
          tool: 'bash',
          toolId: 'tool-bash-write',
          permissionMode: 'auto',
        }),
        expect.objectContaining({ type: 'permission_requested' }),
        expect.objectContaining({ type: 'tool_permission_resolved' }),
      ]),
    );
  });
});
