import { describe, expect, it, vi } from 'vitest';

import {
  buildLlmReviewPrompt,
  parseLlmReviewVerdict,
  runLlmReview,
  type LlmReviewClient,
} from './llm-review.js';

describe('buildLlmReviewPrompt', () => {
  it('embeds the declared capabilities and handler source', () => {
    const prompt = buildLlmReviewPrompt({
      handlerCode: 'export async function handler(){}',
      capabilities: { tools: ['read', 'grep'] },
    });
    expect(prompt).toMatch(/'read', 'grep'/);
    expect(prompt).toMatch(/export async function handler\(\)\{\}/);
    expect(prompt).toMatch(/You are KodaX/);
  });

  it("renders '<none>' when capabilities is empty", () => {
    const prompt = buildLlmReviewPrompt({
      handlerCode: 'export async function handler(){}',
      capabilities: { tools: [] },
    });
    expect(prompt).toMatch(/<none>/);
  });

  it('includes the artifact reference when provided', () => {
    const prompt = buildLlmReviewPrompt({
      handlerCode: 'export async function handler(){}',
      capabilities: { tools: [] },
      artifactRef: 'oauth-scanner@1.0.0',
    });
    expect(prompt).toMatch(/Artifact: oauth-scanner@1\.0\.0/);
  });
});

describe('parseLlmReviewVerdict', () => {
  it('parses a clean JSON object', () => {
    const raw = '{"verdict":"safe","concerns":[],"suggested_capabilities":["read"]}';
    const result = parseLlmReviewVerdict(raw);
    expect(result.verdict).toBe('safe');
    expect(result.concerns).toEqual([]);
    expect(result.suggestedCapabilities).toEqual(['read']);
  });

  it('parses suspicious + concerns', () => {
    const raw =
      '{"verdict":"suspicious","concerns":["uses fetch without declaration"],"suggested_capabilities":["bash"]}';
    const result = parseLlmReviewVerdict(raw);
    expect(result.verdict).toBe('suspicious');
    expect(result.concerns).toEqual(['uses fetch without declaration']);
  });

  it('strips a json code fence around the object', () => {
    const raw = '```json\n{"verdict":"dangerous","concerns":["calls eval"],"suggested_capabilities":[]}\n```';
    const result = parseLlmReviewVerdict(raw);
    expect(result.verdict).toBe('dangerous');
  });

  it('extracts the JSON when the model adds prose around it', () => {
    const raw =
      'Sure, here is my review:\n\n{"verdict":"safe","concerns":[],"suggested_capabilities":["grep"]}\n\nLet me know if you need more.';
    const result = parseLlmReviewVerdict(raw);
    expect(result.verdict).toBe('safe');
  });

  it('throws when no JSON object is present', () => {
    expect(() => parseLlmReviewVerdict('I refuse to review this.')).toThrow(
      /JSON object/,
    );
  });

  it("throws on invalid verdict literal", () => {
    const raw = '{"verdict":"maybe","concerns":[],"suggested_capabilities":[]}';
    expect(() => parseLlmReviewVerdict(raw)).toThrow(/invalid verdict/);
  });

  it('tolerates missing concerns / suggested_capabilities arrays (defaults to [])', () => {
    const raw = '{"verdict":"safe"}';
    const result = parseLlmReviewVerdict(raw);
    expect(result.concerns).toEqual([]);
    expect(result.suggestedCapabilities).toEqual([]);
  });

  it('filters non-string entries from concerns / suggested_capabilities', () => {
    const raw = '{"verdict":"safe","concerns":["ok",42,null],"suggested_capabilities":[true,"read"]}';
    const result = parseLlmReviewVerdict(raw);
    expect(result.concerns).toEqual(['ok']);
    expect(result.suggestedCapabilities).toEqual(['read']);
  });
});

describe('runLlmReview', () => {
  it('builds prompt and parses the client response into a verdict', async () => {
    const client: LlmReviewClient = vi.fn(async () =>
      '{"verdict":"safe","concerns":[],"suggested_capabilities":["read"]}',
    );
    const result = await runLlmReview(
      { handlerCode: 'export async function handler(){}', capabilities: { tools: ['read'] } },
      client,
    );
    expect(result.verdict).toBe('safe');
    expect(client).toHaveBeenCalledOnce();
    const promptArg = (client as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(promptArg).toMatch(/handler\(\)\{\}/);
  });

  it('propagates client errors unchanged', async () => {
    const client: LlmReviewClient = async () => {
      throw new Error('rate limit');
    };
    await expect(
      runLlmReview(
        { handlerCode: 'export async function handler(){}', capabilities: { tools: [] } },
        client,
      ),
    ).rejects.toThrow(/rate limit/);
  });
});
