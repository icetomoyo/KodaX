import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { KodaXAnthropicCompatProvider } from './anthropic.js';
import type {
  KodaXMessage,
  KodaXProviderConfig,
  KodaXToolDefinition,
} from '../types.js';

const TOOLS: KodaXToolDefinition[] = [];
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
  };

  constructor(client: unknown) {
    super();
    this.client = client as any;
  }

  protected override getApiKey(): string {
    return 'test-key';
  }
}

describe('anthropic message serialization', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
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
    expect(kwargs.system).toContain('Base system prompt');
    expect(kwargs.system).toContain('[对话历史摘要]');
    expect(kwargs.messages).toHaveLength(2);
    expect(kwargs.messages[1]?.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool_1',
      is_error: true,
    });
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

  it('serializes image input blocks as base64 image parts', async () => {
    const cwd = await createTempDir('kodax-anthropic-images-');
    const imagePath = path.join(cwd, 'diagram.png');
    await writeFile(imagePath, 'fake-image');
    const create = vi.fn().mockResolvedValue(createCompletedAnthropicStream());
    const provider = new TestAnthropicProvider({
      messages: { create },
    });
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
  });
});
