import { TransformStream } from 'node:stream/web';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AcpLogLevel } from '../src/acp_logger.js';
import type { AcpEventSink, AcpRuntimeEvent } from '../src/acp_events.js';

const { runKodaXMock } = vi.hoisted(() => ({
  runKodaXMock: vi.fn(),
}));

const { prepareRuntimeConfigMock } = vi.hoisted(() => ({
  prepareRuntimeConfigMock: vi.fn(),
}));

vi.mock('@kodax/coding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax/coding')>();
  return {
    ...actual,
    runKodaX: runKodaXMock,
  };
});

vi.mock('@kodax/repl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax/repl')>();
  return {
    ...actual,
    prepareRuntimeConfig: prepareRuntimeConfigMock,
  };
});

import { KodaXAcpServer } from '../src/acp_server.js';

let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
const stderrLines: string[] = [];

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

async function createHarness(options: {
  onPermissionRequest?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  onSessionUpdate?: (notification: SessionNotification) => Promise<void>;
  serverCwd?: string;
  sessionCwd?: string;
  logLevel?: AcpLogLevel;
  eventSinks?: AcpEventSink[];
} = {}) {
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

  const server = new KodaXAcpServer({
    ...(options.serverCwd ? { cwd: options.serverCwd } : {}),
    provider: 'openai',
    permissionMode: 'accept-edits',
    agentVersion: 'test',
    logLevel: options.logLevel ?? 'off',
    eventSinks: [recordingSink, ...(options.eventSinks ?? [])],
  });
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
    mcpServers: [],
  });

  return {
    client,
    server,
    updates,
    events,
    permissionRequests,
    sessionId: session.sessionId,
  };
}

describe('KodaXAcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareRuntimeConfigMock.mockReturnValue({
      provider: 'openai',
      thinking: false,
      reasoningMode: 'auto',
      permissionMode: 'accept-edits',
    });
    stderrLines.length = 0;
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrLines.push(String(chunk).replace(/\r?\n$/, ''));
      return true;
    });
  });

  afterEach(() => {
    stderrWriteSpy.mockRestore();
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

  it('bridges tool permission requests through ACP', async () => {
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

    expect(harness.permissionRequests).toHaveLength(1);
    expect(harness.permissionRequests[0]).toMatchObject({
      sessionId: harness.sessionId,
      toolCall: {
        toolCallId: 'tool-bash-write',
        title: 'bash',
        kind: 'execute',
        rawInput: { command: 'echo test > README.md' },
      },
    });
    expect(harness.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'permission_requested',
          sessionId: harness.sessionId,
          tool: 'bash',
          toolId: 'tool-bash-write',
        }),
        expect.objectContaining({
          type: 'tool_permission_resolved',
          sessionId: harness.sessionId,
          tool: 'bash',
          toolId: 'tool-bash-write',
          outcome: 'request_granted',
        }),
      ]),
    );
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

  it('supports allow_always without changing the ACP session mode', async () => {
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

    const harness = await createHarness({
      onPermissionRequest: async () => ({
        outcome: {
          outcome: 'selected',
          optionId: 'allow_always',
        },
      }),
    });

    await harness.client.prompt({
      sessionId: harness.sessionId,
      prompt: [{ type: 'text', text: 'Persist two edits' }],
    });

    expect(harness.permissionRequests).toHaveLength(1);
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

    await Promise.resolve();
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
    vi.spyOn((harness.server as any).connection, 'sessionUpdate').mockRejectedValue(
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
    runKodaXMock.mockImplementation(async (options) => {
      const decision = await options.events?.beforeToolExecute?.(
        'bash',
        { command: 'echo test > README.md' },
        { toolId: 'tool-bash-write' },
      );

      expect(decision).toBe(true);
      return createResult();
    });

    const harness = await createHarness({
      logLevel: 'info',
      onPermissionRequest: async () => ({
        outcome: {
          outcome: 'selected',
          optionId: 'allow_once',
        },
      }),
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
          permissionMode: 'accept-edits',
        }),
        expect.objectContaining({
          type: 'permission_requested',
          sessionId: harness.sessionId,
          tool: 'bash',
          toolId: 'tool-bash-write',
        }),
        expect.objectContaining({
          type: 'tool_permission_resolved',
          sessionId: harness.sessionId,
          tool: 'bash',
          toolId: 'tool-bash-write',
          outcome: 'request_granted',
        }),
      ]),
    );
  });
});
