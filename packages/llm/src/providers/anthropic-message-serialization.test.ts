import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import { runWithScopedConfig } from '../run-scoped-config.js';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXToolDefinition,
} from '../types.js';

const TOOLS: KodaXToolDefinition[] = [];
const ARK_CODING_IMAGE_MODELS = [
  'doubao-seed-2.0-code',
  'doubao-seed-2.0-pro',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'MiniMax-M3',
] as const;
const REPORT_TOOL: KodaXToolDefinition = {
  name: 'emit_verdict',
  description: 'Report verdict.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};
const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createCompletedAnthropicStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      const events = [
        { type: 'message_start' },
        { type: 'message_stop' },
      ];
      return {
        next: async () => {
          if (index >= events.length) {
            return { done: true, value: undefined };
          }
          const value = events[index];
          index += 1;
          return { done: false, value };
        },
      };
    },
  };
}

class TestAnthropicProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'test-anthropic';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_API_KEY',
    model: 'test-model',
    supportsThinking: false,
    promptCacheAffinity: true,
  };

  constructor(client: unknown) {
    super();
    this.client = client as any;
  }

  protected override getApiKey(): string {
    return 'test-key';
  }
}

class UnverifiedAnthropicCompatProvider extends KodaXAnthropicCompatProvider {
  readonly name = 'unverified-anthropic-compat';
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'TEST_API_KEY',
    model: 'test-model',
    supportsThinking: false,
  };

  constructor(client: unknown) {
    super();
    this.client = client as Anthropic;
  }

  protected override getApiKey(): string {
    return 'test-key';
  }
}

class TestArkCodingProvider extends TestAnthropicProvider {
  override readonly name = 'ark-coding';
  protected override readonly config: KodaXProviderConfig;

  constructor(client: unknown, model: string) {
    super(client);
    this.config = {
      apiKeyEnv: 'TEST_API_KEY',
      model,
      supportsThinking: false,
    };
  }
}

describe('anthropic message serialization', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.KODAX_DISABLE_PROMPT_CACHE;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('omits empty tools from streaming and non-streaming wire requests', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(createCompletedAnthropicStream())
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 1 },
      });
    const provider = new TestAnthropicProvider({ messages: { create } });

    await provider.stream(
      [{ role: 'user', content: 'stream' }],
      [],
      'system',
      undefined,
      { forcedToolName: 'missing-tool' },
    );
    await provider.complete(
      [{ role: 'user', content: 'complete' }],
      [],
      'system',
      undefined,
      { forcedToolName: 'missing-tool' },
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('tools');
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('tool_choice');
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('tools');
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('tool_choice');
  });

  it('lowers a provider cache affinity key to metadata.user_id for stream and complete', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(createCompletedAnthropicStream())
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 1 },
      });
    const provider = new TestAnthropicProvider({ messages: { create } });
    const streamOptions = {
      promptCacheKey: 'a'.repeat(64),
    };

    process.env.KODAX_DISABLE_PROMPT_CACHE = '1';
    await runWithScopedConfig({ disablePromptCache: false }, async () => {
      await provider.stream(
        [{ role: 'user', content: 'stream request' }],
        TOOLS,
        'system',
        false,
        streamOptions,
      );
      await provider.complete(
        [{ role: 'user', content: 'complete request' }],
        TOOLS,
        'system',
        false,
        streamOptions,
      );
    });

    expect(create.mock.calls[0]?.[0].metadata).toEqual({
      user_id: 'a'.repeat(64),
    });
    expect(create.mock.calls[1]?.[0].metadata).toEqual({
      user_id: 'a'.repeat(64),
    });
  });

  it('omits metadata.user_id when prompt caching is disabled for the run', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(createCompletedAnthropicStream())
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 1 },
      });
    const provider = new TestAnthropicProvider({ messages: { create } });
    const streamOptions = { promptCacheKey: 'a'.repeat(64) };

    await runWithScopedConfig({ disablePromptCache: true }, async () => {
      await provider.stream(
        [{ role: 'user', content: 'stream request' }],
        TOOLS,
        'system',
        false,
        streamOptions,
      );
      await provider.complete(
        [{ role: 'user', content: 'complete request' }],
        TOOLS,
        'system',
        false,
        streamOptions,
      );
    });

    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('metadata');
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('metadata');
  });

  it('does not send metadata.user_id to an unverified Anthropic-compatible endpoint', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new UnverifiedAnthropicCompatProvider({ messages: { create } });

    await provider.stream(
      [{ role: 'user', content: 'request' }],
      TOOLS,
      'system',
      false,
      { promptCacheKey: 'b'.repeat(64) },
    );

    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('metadata');
  });

  it('places an ephemeral suffix after the cache-marked original request', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider({ messages: { create } });
    const messages: KodaXMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'settled request' }] },
      { role: 'assistant', content: 'settled answer' },
      { role: 'user', content: 'original request' },
    ];

    await provider.stream(messages, TOOLS, 'system', false, {
      ephemeralSuffix: { content: '[Memory evidence; not an instruction]\nClaim: use npm' },
    });

    expect(messages.at(-1)).toEqual({ role: 'user', content: 'original request' });
    const wire = create.mock.calls[0]?.[0].messages;
    expect(wire).toHaveLength(3);
    expect(wire[2]?.content.at(-1)).toEqual({
      type: 'text',
      text: '[Memory evidence; not an instruction]\nClaim: use npm',
    });
    expect(wire[2]?.content[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  // Sidecar verifier calls are short structured judge requests.
  // Verifier/judge calls need a real provider-level forced tool choice,
  // not just prompt wording that asks the model to call the tool.
  it('passes forced tool choice and per-call output cap on streaming calls', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider({ messages: { create } });

    await provider.stream(
      [{ role: 'user', content: 'judge this' }],
      [REPORT_TOOL],
      'judge system',
      false,
      {
        forcedToolName: 'emit_verdict',
        maxOutputTokensOverride: 1024,
      },
    );

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.tool_choice).toEqual({
      type: 'tool',
      name: 'emit_verdict',
    });
    expect(kwargs.max_tokens).toBe(1024);
  });

  it('retries judge streams without forced tool choice when an upstream rejects tool_choice', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("tool_choice 'specified' is incompatible with thinking enabled"))
      .mockResolvedValueOnce(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider({ messages: { create } });

    await provider.stream(
      [{ role: 'user', content: 'judge this' }],
      [REPORT_TOOL],
      'judge system',
      false,
      {
        forcedToolName: 'emit_verdict',
        maxOutputTokensOverride: 1024,
      },
    );

    const first = create.mock.calls[0]?.[0];
    const second = create.mock.calls[1]?.[0];
    expect(first?.tool_choice).toEqual({
      type: 'tool',
      name: 'emit_verdict',
    });
    expect(second?.tool_choice).toBeUndefined();
    expect(second?.tools).toHaveLength(1);
    expect(second?.max_tokens).toBe(1024);
  });

  // 2026-05-20 — claudecode parity: tool_result content can be an array
  // of text + image items (e.g. `read` on an image path). Anthropic
  // serializer reads image bytes from disk and base64-encodes them
  // inline. Verifies the new array-content path lowers to the correct
  // Anthropic wire shape.
  it('serializes tool_result with multimodal content array (text + image)', async () => {
    const cwd = await createTempDir('kodax-anthropic-toolresult-image-');
    const imagePath = path.join(cwd, 'pic.png');
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const expectedBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider({ messages: { create } });
    const messages: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_42', name: 'read', input: { path: imagePath } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_42',
            content: [
              { type: 'text', text: `[Read image: ${imagePath}]` },
              { type: 'image', path: imagePath, mediaType: 'image/png' },
            ],
          },
        ],
      },
    ];

    await provider.stream(messages, TOOLS, 'sys');

    const kwargs = create.mock.calls[0]?.[0];
    const userMsg = kwargs.messages.find((m: { role: string }) => m.role === 'user');
    const toolResult = userMsg.content.find((b: { type: string }) => b.type === 'tool_result');
    expect(Array.isArray(toolResult.content)).toBe(true);
    expect(toolResult.content).toHaveLength(2);
    expect(toolResult.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(imagePath) });
    expect(toolResult.content[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: expectedBase64 },
    });
  });

  it('replaces missing historical images in user and tool-result content', async () => {
    const cwd = await createTempDir('kodax-anthropic-missing-image-');
    const missingImagePath = path.join(cwd, 'deleted.png');
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider({ messages: { create } });
    const messages: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_missing', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_missing',
            content: [{ type: 'image', path: missingImagePath, mediaType: 'image/png' }],
          },
          { type: 'image', path: missingImagePath, mediaType: 'image/png' },
        ],
      },
    ];

    await provider.stream(messages, TOOLS, 'sys');

    const kwargs = create.mock.calls[0]?.[0];
    const userMsg = kwargs.messages.find((message: { role: string }) => message.role === 'user');
    const placeholder = {
      type: 'text',
      text: '[Historical image unavailable: the local attachment file is missing.]',
    };
    const toolResult = userMsg.content.find(
      (block: { type: string }) => block.type === 'tool_result',
    );
    expect(toolResult.content).toEqual([placeholder]);
    expect(userMsg.content).toContainEqual(expect.objectContaining(placeholder));
    expect(JSON.stringify(userMsg.content)).not.toContain(missingImagePath);
  });

  it('preserves inline system summaries and tool_result error flags', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider({
      messages: { create },
    });
    const messages: KodaXMessage[] = [
      { role: 'system', content: '[对话历史摘要]\n\nImportant summary' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'read', input: { path: 'README.md' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: '[Tool Error] read: failed', is_error: true }],
      },
    ];

    await provider.stream(messages, TOOLS, 'Base system prompt');

    const kwargs = create.mock.calls[0]?.[0];
    // FEATURE_116 (v0.7.37): system is now wrapped as a single
    // TextBlockParam carrying cache_control. Extract the text for
    // content assertions; fall through to string for the disabled-cache
    // shape.
    const systemText = typeof kwargs.system === 'string'
      ? kwargs.system
      : (kwargs.system as Array<{ text: string }>).map((b) => b.text).join('\n');
    expect(systemText).toContain('Base system prompt');
    expect(systemText).toContain('[对话历史摘要]');
    expect(kwargs.messages).toHaveLength(2);
    expect(kwargs.messages[1]?.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool_1',
      is_error: true,
    });
  });

  it('keeps tool-result recovery metadata local instead of serializing it to the wire', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider({ messages: { create } });
    const messages: KodaXMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_local', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool_local',
          content: 'preview',
          metadata: {
            outputPath: 'C:/private/full-output.txt',
            localOnlySentinel: 'must-not-reach-provider',
          },
        }],
      },
    ];

    await provider.stream(messages, TOOLS, 'sys');

    const kwargs = create.mock.calls[0]?.[0];
    const userMessage = kwargs.messages.find(
      (message: { role: string }) => message.role === 'user',
    );
    const toolResult = userMessage.content.find(
      (block: { type: string }) => block.type === 'tool_result',
    );
    expect(toolResult).toEqual({
      type: 'tool_result',
      tool_use_id: 'tool_local',
      content: 'preview',
      cache_control: { type: 'ephemeral' },
    });
    expect(JSON.stringify(kwargs)).not.toContain('must-not-reach-provider');
    expect(JSON.stringify(kwargs)).not.toContain('C:/private/full-output.txt');
  });

  // L5 (v0.7.28): strictThinkingSignature mode (Anthropic proper)
  // converts thinking blocks with empty/cross-provider signatures into
  // a <prior_reasoning> text block. This preserves the reasoning text
  // for the model to read while keeping the thinking-block channel
  // restricted to provider-issued, signature-verifiable content.
  it('converts cross-provider thinking to prior_reasoning text in strict mode', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    class StrictProvider extends KodaXAnthropicCompatProvider {
      readonly name = 'anthropic';
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'TEST_API_KEY',
        model: 'claude-opus-4-6',
        supportsThinking: true,
        strictThinkingSignature: true,
      };
      constructor(client: unknown) { super(); this.client = client as any; }
      protected override getApiKey(): string { return 'test-key'; }
    }
    const provider = new StrictProvider({ messages: { create } });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Continue from where we left off.' },
      {
        role: 'assistant',
        content: [
          // From a previous deepseek turn — empty signature.
          { type: 'thinking', thinking: 'I considered options A and B' },
          { type: 'text', text: 'Let me proceed with option A.' },
        ],
      },
      { role: 'user', content: 'OK.' },
    ];

    await provider.stream(messages, TOOLS, 'system');

    const kwargs = create.mock.calls[0]?.[0];
    const assistantWire = kwargs.messages.find((m: { role: string }) => m.role === 'assistant');
    expect(assistantWire).toBeDefined();

    // No thinking block on the wire — the cross-provider one was
    // converted, not passed through.
    const thinkingBlocks = assistantWire.content.filter((b: { type: string }) => b.type === 'thinking');
    expect(thinkingBlocks).toHaveLength(0);

    // The reasoning text rides on a text block tagged <prior_reasoning>
    // before the original visible text.
    const textBlocks = assistantWire.content.filter((b: { type: string }) => b.type === 'text');
    expect(textBlocks).toHaveLength(2);
    expect(textBlocks[0].text).toContain('<prior_reasoning>');
    expect(textBlocks[0].text).toContain('I considered options A and B');
    expect(textBlocks[1].text).toBe('Let me proceed with option A.');
  });

  // Lenient mode (default; third-party Anthropic-compat servers): same
  // input passes through unchanged because those servers don't verify
  // signatures and accept anything in the field.
  it('passes thinking through unchanged in lenient mode (third-party Anthropic-compat)', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    class LenientProvider extends KodaXAnthropicCompatProvider {
      readonly name = 'kimi-code';
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'TEST_API_KEY',
        model: 'kimi-for-coding',
        supportsThinking: true,
        // strictThinkingSignature: undefined (defaults to false / lenient)
      };
      constructor(client: unknown) { super(); this.client = client as any; }
      protected override getApiKey(): string { return 'test-key'; }
    }
    const provider = new LenientProvider({ messages: { create } });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'cross-provider reasoning' },
          { type: 'text', text: 'Hello!' },
        ],
      },
      { role: 'user', content: 'OK.' },
    ];

    await provider.stream(messages, TOOLS, 'system');

    const kwargs = create.mock.calls[0]?.[0];
    const assistantWire = kwargs.messages.find((m: { role: string }) => m.role === 'assistant');
    const thinkingBlocks = assistantWire.content.filter((b: { type: string }) => b.type === 'thinking');
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0].thinking).toBe('cross-provider reasoning');
    // No <prior_reasoning> conversion happened.
    const textBlocks = assistantWire.content.filter((b: { type: string }) => b.type === 'text');
    expect(textBlocks.every((b: { text: string }) => !b.text.includes('<prior_reasoning>'))).toBe(true);
  });

  // Strict mode + signed thinking (Anthropic round-trip): pass through.
  it('preserves Anthropic-signed thinking in strict mode (round-trip)', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    class StrictProvider extends KodaXAnthropicCompatProvider {
      readonly name = 'anthropic';
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'TEST_API_KEY',
        model: 'claude-opus-4-6',
        supportsThinking: true,
        strictThinkingSignature: true,
      };
      constructor(client: unknown) { super(); this.client = client as any; }
      protected override getApiKey(): string { return 'test-key'; }
    }
    const provider = new StrictProvider({ messages: { create } });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Anthropic-generated', signature: 'sig-abc-from-anthropic' },
          { type: 'text', text: 'Hello!' },
        ],
      },
      { role: 'user', content: 'OK.' },
    ];

    await provider.stream(messages, TOOLS, 'system');

    const kwargs = create.mock.calls[0]?.[0];
    const assistantWire = kwargs.messages.find((m: { role: string }) => m.role === 'assistant');
    const thinkingBlocks = assistantWire.content.filter((b: { type: string }) => b.type === 'thinking');
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0]).toMatchObject({
      type: 'thinking',
      thinking: 'Anthropic-generated',
      signature: 'sig-abc-from-anthropic',
    });
  });

  // Strict mode + redacted_thinking: drop silently. There's no
  // plaintext to convert and the data field's ciphertext is provider-
  // issued so it can't survive cross-provider replay anyway.
  it('drops cross-provider redacted_thinking in strict mode', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    class StrictProvider extends KodaXAnthropicCompatProvider {
      readonly name = 'anthropic';
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'TEST_API_KEY',
        model: 'claude-opus-4-6',
        supportsThinking: true,
        strictThinkingSignature: true,
      };
      constructor(client: unknown) { super(); this.client = client as any; }
      protected override getApiKey(): string { return 'test-key'; }
    }
    const provider = new StrictProvider({ messages: { create } });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'opaque-from-other-provider' },
          { type: 'text', text: 'Hello!' },
        ],
      },
      { role: 'user', content: 'OK.' },
    ];

    await provider.stream(messages, TOOLS, 'system');

    const kwargs = create.mock.calls[0]?.[0];
    const assistantWire = kwargs.messages.find((m: { role: string }) => m.role === 'assistant');
    const redactedBlocks = assistantWire.content.filter(
      (b: { type: string }) => b.type === 'redacted_thinking',
    );
    // Dropped silently — the visible text survives but redacted
    // ciphertext doesn't make it onto the wire.
    expect(redactedBlocks).toHaveLength(0);
    const textBlocks = assistantWire.content.filter((b: { type: string }) => b.type === 'text');
    expect(textBlocks.some((b: { text: string }) => b.text === 'Hello!')).toBe(true);
  });

  // Order regression: cross-provider reasoning text must appear in
  // the thinking slot (before tool_use), not between tool_use and
  // original text. The natural reading order on the wire is
  // "think → act → explain"; placing prior_reasoning AFTER tool_use
  // inverts that to "act → think → explain" which reads backwards
  // and may confuse the model.
  it('places prior_reasoning before tool_use in strict mode', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    class StrictProvider extends KodaXAnthropicCompatProvider {
      readonly name = 'anthropic';
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'TEST_API_KEY',
        model: 'claude-opus-4-6',
        supportsThinking: true,
        strictThinkingSignature: true,
      };
      constructor(client: unknown) { super(); this.client = client as any; }
      protected override getApiKey(): string { return 'test-key'; }
    }
    const provider = new StrictProvider({ messages: { create } });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Inspect package.json' },
      {
        role: 'assistant',
        content: [
          // From a previous deepseek turn — empty signature, with tool_use.
          { type: 'thinking', thinking: 'I should read package.json first.' },
          { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'package.json' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"name":"x"}' }],
      },
    ];

    await provider.stream(messages, TOOLS, 'system');

    const kwargs = create.mock.calls[0]?.[0];
    const assistantWire = kwargs.messages.find((m: { role: string }) => m.role === 'assistant');
    const types = assistantWire.content.map((b: { type: string }) => b.type);
    // text(prior_reasoning) → tool_use, NOT tool_use → text.
    expect(types).toEqual(['text', 'tool_use']);
    expect(assistantWire.content[0].text).toContain('<prior_reasoning>');
    expect(assistantWire.content[0].text).toContain('I should read package.json first.');
  });

  // Existing guard at anthropic.ts:704 injects a '...' thinking placeholder
  // when a tool-use turn has no thinking block (Kimi's strict field check).
  // In strictThinkingSignature mode, that placeholder would itself fail
  // Anthropic's signature verification (signature: '' is invalid). The
  // guard must skip in strict mode so we don't generate a guaranteed-
  // broken request — L3 self-heal handles any genuine thinking gap.
  it('skips Kimi-style thinking placeholder injection in strict mode', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    class StrictProvider extends KodaXAnthropicCompatProvider {
      readonly name = 'anthropic';
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'TEST_API_KEY',
        model: 'claude-opus-4-6',
        supportsThinking: true,
        strictThinkingSignature: true,
      };
      constructor(client: unknown) { super(); this.client = client as any; }
      protected override getApiKey(): string { return 'test-key'; }
    }
    const provider = new StrictProvider({ messages: { create } });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Run grep.' },
      {
        role: 'assistant',
        content: [
          // tool_use without thinking — would normally trigger Kimi guard
          { type: 'tool_use', id: 'call_1', name: 'grep', input: { pattern: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'no matches' }],
      },
    ];

    await provider.stream(messages, TOOLS, 'system');

    const kwargs = create.mock.calls[0]?.[0];
    const assistantWire = kwargs.messages.find((m: { role: string }) => m.role === 'assistant');
    // No injected '...' thinking with empty signature — strict mode
    // skips that guard to avoid the Anthropic signature 400.
    const thinkingBlocks = assistantWire.content.filter(
      (b: { type: string }) => b.type === 'thinking',
    );
    expect(thinkingBlocks).toHaveLength(0);
    // tool_use survives.
    const toolUseBlocks = assistantWire.content.filter(
      (b: { type: string }) => b.type === 'tool_use',
    );
    expect(toolUseBlocks).toHaveLength(1);
  });

  // Conversely: lenient mode (Kimi) still fires the guard, preserving
  // the legacy fallback behaviour for non-Anthropic-proper providers.
  it('still injects thinking placeholder in lenient mode', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    class LenientProvider extends KodaXAnthropicCompatProvider {
      readonly name = 'kimi-code';
      protected readonly config: KodaXProviderConfig = {
        apiKeyEnv: 'TEST_API_KEY',
        model: 'kimi-for-coding',
        supportsThinking: true,
        // lenient (default)
      };
      constructor(client: unknown) { super(); this.client = client as any; }
      protected override getApiKey(): string { return 'test-key'; }
    }
    const provider = new LenientProvider({ messages: { create } });

    const messages: KodaXMessage[] = [
      { role: 'user', content: 'Run grep.' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'grep', input: { pattern: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
      },
    ];

    await provider.stream(messages, TOOLS, 'system');

    const kwargs = create.mock.calls[0]?.[0];
    const assistantWire = kwargs.messages.find((m: { role: string }) => m.role === 'assistant');
    const thinkingBlocks = assistantWire.content.filter(
      (b: { type: string }) => b.type === 'thinking',
    );
    // Guard fires for lenient providers (preserves legacy Kimi behaviour).
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0]).toMatchObject({ thinking: '...', signature: '' });
  });

  // P2: wire-only orphan repair (defense-in-depth, mirrors the OpenAI-side
  // repairToolCallHistory). validateAndFixToolHistory removes orphans upstream
  // every turn; this is the Anthropic last-mile net so a stray orphan never
  // 400s the API ("tool_use ids were not found" / "unexpected tool_result").
  it('drops an orphan tool_result with no preceding tool_use', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider({ messages: { create } });
    const messages: KodaXMessage[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_missing', content: 'late' }] },
      { role: 'user', content: 'continue' },
    ];

    await provider.stream(messages, TOOLS, 'system');

    const kwargs = create.mock.calls[0]?.[0];
    const firstUser = kwargs.messages[0];
    const hasOrphanResult = (firstUser.content as Array<{ type: string }>).some(
      (b) => b.type === 'tool_result',
    );
    expect(hasOrphanResult).toBe(false);
  });

  it('drops an orphan tool_use with no following tool_result and replaces the emptied turn with a wire "..."', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider({ messages: { create } });
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'do x' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_orphan', name: 'read', input: {} }] },
      { role: 'user', content: 'continue' },
    ];

    await provider.stream(messages, TOOLS, 'system');

    const kwargs = create.mock.calls[0]?.[0];
    const assistant = kwargs.messages.find((m: { role: string }) => m.role === 'assistant');
    const toolUses = (assistant.content as Array<{ type: string }>).filter(
      (b) => b.type === 'tool_use',
    );
    expect(toolUses).toHaveLength(0);
    expect(assistant.content).toEqual([{ type: 'text', text: '...' }]);
  });

  it('keeps matched tool_use/tool_result pairs and drops only the unmatched', async () => {
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider({ messages: { create } });
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'do x' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a' } },
          { type: 'tool_use', id: 'call_b', name: 'read', input: { path: 'b' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'a' }] },
      { role: 'user', content: 'continue' },
    ];

    await provider.stream(messages, TOOLS, 'system');

    const kwargs = create.mock.calls[0]?.[0];
    const assistant = kwargs.messages.find((m: { role: string }) => m.role === 'assistant');
    const ids = (assistant.content as Array<{ type: string; id?: string }>)
      .filter((b) => b.type === 'tool_use')
      .map((b) => b.id);
    expect(ids).toEqual(['call_a']);
  });

  it('replaces an all-empty-text USER turn with a wire "..." (empty-marker on user role)', async () => {
    // A recovery pass (tool-guard) can strip a dropped tool_result that was a
    // user turn's sole content, leaving an empty-text marker on a USER turn.
    // It must serialize to a wire-only '...' (not an empty text block that 400s).
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider({ messages: { create } });
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: '' }] },
    ];

    await provider.stream(messages, TOOLS, 'system');

    const kwargs = create.mock.calls[0]?.[0];
    const lastUser = kwargs.messages[kwargs.messages.length - 1];
    expect(lastUser.role).toBe('user');
    expect(lastUser.content).toEqual([{
      type: 'text',
      text: '...',
      cache_control: { type: 'ephemeral' },
    }]);
  });

  it.each(ARK_CODING_IMAGE_MODELS)(
    'serializes ark-coding/%s image input as an Anthropic base64 block',
    async (model) => {
      const cwd = await createTempDir('kodax-anthropic-images-');
      const imagePath = path.join(cwd, 'diagram.png');
      await writeFile(imagePath, 'fake-image');
      const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
      const provider = new TestArkCodingProvider({
        messages: { create },
      }, model);
      const messages: KodaXMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Please inspect this image.' },
            { type: 'image', path: imagePath, mediaType: 'image/png' },
          ],
        },
      ];

      await provider.stream(messages, TOOLS, 'Base system prompt');

      const kwargs = create.mock.calls[0]?.[0];
      expect(kwargs.model).toBe(model);
      expect(kwargs.messages).toHaveLength(1);
      expect(kwargs.messages[0]).toMatchObject({
        role: 'user',
        content: [
          { type: 'text', text: 'Please inspect this image.' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: expect.any(String),
            },
          },
        ],
      });
    },
  );
});
