import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXProviderStreamOptions,
  KodaXToolDefinition,
} from '../types.js';
import type { AcpClientOptions } from '../cli-events/acp-client.js';

const acpMockState = vi.hoisted(() => ({
  instances: [] as MockAcpClient[],
  nextSessionId: 1,
  promptImpl: undefined as
    | ((client: MockAcpClient, text: string, sessionId: string, signal?: AbortSignal) => Promise<{
      usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    } | void> | {
      usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    } | void)
    | undefined,
}));

class MockAcpClient {
  readonly connect = vi.fn(async () => {});
  readonly createNewSession = vi.fn(async () => `acp-session-${acpMockState.nextSessionId++}`);
  readonly disconnect = vi.fn(() => {});
  readonly prompt = vi.fn(async (text: string, sessionId: string, signal?: AbortSignal) => {
    return await acpMockState.promptImpl?.(this, text, sessionId, signal);
  });

  constructor(
    readonly options: { onSessionUpdate?: (notification: unknown) => void },
  ) {
    acpMockState.instances.push(this);
  }

  emit(update: unknown, sessionId = 'acp-session-1'): void {
    this.options.onSessionUpdate?.({ sessionId, update });
  }
}

vi.mock('../cli-events/acp-client.js', () => ({
  AcpClient: MockAcpClient,
}));

const { KodaXAcpProvider } = await import('./acp-base.js');

const EXPECTED_CLI_BRIDGE_PROFILE = {
  transport: 'cli-bridge',
  conversationSemantics: 'last-user-message',
  mcpSupport: 'none',
  contextFidelity: 'lossy',
  toolCallingFidelity: 'limited',
  sessionSupport: 'stateless',
  longRunningSupport: 'limited',
  multimodalSupport: 'none',
  evidenceSupport: 'limited',
} as const;

class TestAcpProvider extends KodaXAcpProvider {
  readonly name = 'test-acp';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_ACP_API_KEY',
    model: 'test-model',
    supportsThinking: false,
    reasoningCapability: 'prompt-only',
  };

  protected readonly acpClientOptions: AcpClientOptions;

  constructor(executor?: AcpClientOptions['executor']) {
    super();
    this.acpClientOptions = {
      inputStream: new ReadableStream<Uint8Array>(),
      outputStream: new WritableStream<Uint8Array>(),
      executor,
    };
  }
}

describe('KodaXAcpProvider', () => {
  beforeEach(() => {
    acpMockState.instances.length = 0;
    acpMockState.nextSessionId = 1;
    acpMockState.promptImpl = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is always configured and returns a cloned CLI-bridge capability profile', () => {
    const provider = new TestAcpProvider();

    expect(provider.isConfigured()).toBe(true);
    expect(provider.getCapabilityProfile()).toEqual(EXPECTED_CLI_BRIDGE_PROFILE);

    const first = provider.getCapabilityProfile();
    first.transport = 'native-api';
    expect(provider.getCapabilityProfile()).toEqual(EXPECTED_CLI_BRIDGE_PROFILE);
  });

  it('streams prompt updates, relays ACP session events, and reuses ACP sessions', async () => {
    const provider = new TestAcpProvider();
    const onTextDelta = vi.fn();
    const onToolInputDelta = vi.fn();

    acpMockState.promptImpl = async (client, text, sessionId) => {
      expect(text).toBe('latest prompt');
      expect(sessionId).toBe('acp-session-1');
      client.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello from ACP' },
      }, sessionId);
      client.emit({
        sessionUpdate: 'tool_call',
        title: 'read',
        arguments: { file: 'src/index.ts' },
      }, sessionId);
      client.emit({
        sessionUpdate: 'tool_call_update',
        status: 'completed',
      }, sessionId);
    };

    const streamOptions: KodaXProviderStreamOptions = {
      sessionId: 'thread-1',
      onTextDelta,
      onToolInputDelta,
    };
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'ignored prompt' },
      { role: 'user', content: 'latest prompt' },
    ];
    const result = await provider.stream(messages, [] as KodaXToolDefinition[], 'system', undefined, streamOptions);

    expect(result.toolBlocks).toEqual([]);
    expect(result.textBlocks).toEqual([
      {
        type: 'text',
        text:
          'Hello from ACP\n> [Tool Use] read: {"file":"src/index.ts"}\n> [Tool Result] completed\n\n',
      },
    ]);
    expect(onTextDelta).toHaveBeenCalledWith('Hello from ACP');
    expect(onTextDelta).toHaveBeenCalledWith('\n> [Tool Use] read: {"file":"src/index.ts"}\n');
    expect(onTextDelta).toHaveBeenCalledWith('> [Tool Result] completed\n\n');
    expect(onToolInputDelta).toHaveBeenCalledWith('read', '{"file":"src/index.ts"}');

    const firstClient = acpMockState.instances[0]!;
    expect(firstClient.connect).toHaveBeenCalledTimes(1);
    expect(firstClient.createNewSession).toHaveBeenCalledTimes(1);
    expect(firstClient.prompt).toHaveBeenCalledTimes(1);

    await provider.stream(messages, [] as KodaXToolDefinition[], 'system', undefined, streamOptions);
    expect(firstClient.connect).toHaveBeenCalledTimes(1);
    expect(firstClient.createNewSession).toHaveBeenCalledTimes(1);
    expect(firstClient.prompt).toHaveBeenCalledTimes(2);
  });

  it('propagates ACP prompt usage when the prompt response includes it', async () => {
    const provider = new TestAcpProvider();

    acpMockState.promptImpl = async () => ({
      usage: {
        inputTokens: 90,
        outputTokens: 15,
        totalTokens: 105,
      },
    });

    const result = await provider.stream(
      [{ role: 'user', content: 'latest prompt' }],
      [] as KodaXToolDefinition[],
      'system',
      undefined,
      { sessionId: 'thread-usage' },
    );

    expect(result.usage).toEqual({
      inputTokens: 90,
      outputTokens: 15,
      totalTokens: 105,
    });
  });

  it('fails closed when the backing CLI executor is not installed', async () => {
    const provider = new TestAcpProvider({
      isInstalled: async () => false,
    } as AcpClientOptions['executor']);

    await expect(
      provider.stream(
        [{ role: 'user', content: 'hello' }],
        [] as KodaXToolDefinition[],
        'system',
      ),
    ).rejects.toThrow(/CLI/i);

    expect(acpMockState.instances).toHaveLength(0);
  });

  it('treats AbortError as a cancelled stream and resets cached state on disconnect', async () => {
    const provider = new TestAcpProvider();
    acpMockState.promptImpl = async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };

    await expect(
      provider.stream(
        [{ role: 'user', content: 'cancel me' }],
        [] as KodaXToolDefinition[],
        'system',
        undefined,
        { sessionId: 'thread-1' },
      ),
    ).resolves.toEqual({
      textBlocks: [],
      toolBlocks: [],
      thinkingBlocks: [],
    });

    const firstClient = acpMockState.instances[0]!;
    provider.disconnect();
    expect(firstClient.disconnect).toHaveBeenCalledTimes(1);

    acpMockState.promptImpl = undefined;
    await provider.stream(
      [{ role: 'user', content: 'fresh run' }],
      [] as KodaXToolDefinition[],
      'system',
      undefined,
      { sessionId: 'thread-1' },
    );

    expect(acpMockState.instances).toHaveLength(2);
    expect(acpMockState.instances[1]!.createNewSession).toHaveBeenCalledTimes(1);
  });
});
