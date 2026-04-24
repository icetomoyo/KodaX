import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { KodaXOpenAICompatProvider } from './openai.js';
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

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

class TestOpenAIProvider extends KodaXOpenAICompatProvider {
  readonly name = 'test-openai';
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

describe('openai message serialization', () => {
  it('serializes image input blocks as image_url content parts', async () => {
    const cwd = await createTempDir('kodax-openai-images-');
    const imagePath = path.join(cwd, 'diagram.png');
    await writeFile(imagePath, 'fake-image');
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'done',
            tool_calls: [],
          },
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    });
    const provider = new TestOpenAIProvider({
      chat: {
        completions: { create },
      },
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

    await provider.complete(messages, TOOLS, 'Base system prompt');

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.messages).toHaveLength(2);
    expect(kwargs.messages[1]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Please inspect this image.' },
        {
          type: 'image_url',
          image_url: {
            url: expect.stringMatching(/^data:image\/png;base64,/),
          },
        },
      ],
    });
  });

  // Regression: third-party Qwen proxies reject any `role: 'system'` that is
  // not at position 0 ("System message must at the begin"). Post-compact
  // attachments + compaction summaries + handoff replaceSystemMessage could
  // otherwise leave secondary system entries mid-transcript.
  it('merges multiple role:system messages into a single wire system entry', async () => {
    const completion = {
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const create = vi.fn().mockResolvedValue(completion);
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });

    const messages: KodaXMessage[] = [
      { role: 'system', content: '[对话历史摘要]\n\nsummary-body' },
      { role: 'system', content: '[Post-compact: recent operations]\nledger' },
      { role: 'system', content: '[Post-compact: file content] /a.ts\n...' },
      { role: 'user', content: 'hello' },
    ];

    await provider.complete(messages, TOOLS, 'agent-system-prompt');

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.messages).toHaveLength(2);
    expect(kwargs.messages[0].role).toBe('system');
    expect(kwargs.messages[1].role).toBe('user');
    // All system content concatenated in order (top-param first, then each
    // embedded system message), joined by blank line.
    expect(kwargs.messages[0].content).toBe(
      'agent-system-prompt\n\n'
        + '[对话历史摘要]\n\nsummary-body\n\n'
        + '[Post-compact: recent operations]\nledger\n\n'
        + '[Post-compact: file content] /a.ts\n...',
    );
    // No other system entries sneaked into the wire.
    const systemCount = kwargs.messages.filter(
      (m: { role: string }) => m.role === 'system',
    ).length;
    expect(systemCount).toBe(1);
  });

  it('merges mid-transcript role:system into the leading system', async () => {
    const completion = {
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const create = vi.fn().mockResolvedValue(completion);
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });

    // Simulates the pathological shape after handoff + second compaction
    // where a system message ends up after a user/assistant exchange.
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: '[Post-compact: drifted after handoff]' },
      { role: 'user', content: 'q2' },
    ];

    await provider.complete(messages, TOOLS, 'agent-sys');

    const kwargs = create.mock.calls[0]?.[0];
    const roles = kwargs.messages.map((m: { role: string }) => m.role);
    // Exactly one system message, at position 0; the stray system has been
    // pulled up and the rest preserved in original order.
    expect(roles[0]).toBe('system');
    expect(roles.slice(1).every((r: string) => r !== 'system')).toBe(true);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    expect(kwargs.messages[0].content).toBe(
      'agent-sys\n\n[Post-compact: drifted after handoff]',
    );
  });

  it('skips empty system content but keeps a system entry at position 0', async () => {
    const completion = {
      choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const create = vi.fn().mockResolvedValue(completion);
    const provider = new TestOpenAIProvider({ chat: { completions: { create } } });

    const messages: KodaXMessage[] = [
      { role: 'system', content: '   ' },
      { role: 'user', content: 'hi' },
    ];

    await provider.complete(messages, TOOLS, '');

    const kwargs = create.mock.calls[0]?.[0];
    expect(kwargs.messages[0]).toEqual({ role: 'system', content: '' });
    expect(kwargs.messages[1]).toMatchObject({ role: 'user' });
    expect(kwargs.messages).toHaveLength(2);
  });
});
