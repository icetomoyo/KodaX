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
});
