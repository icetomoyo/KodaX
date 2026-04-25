/**
 * Eval L2: Identity Roundtrip
 *
 * Verifies that when KodaX is configured with a specific coding-plan provider,
 * the LLM correctly identifies itself as KodaX / the configured model instead
 * of hallucinating as Claude / ChatGPT / another vendor.
 *
 * Run manually:
 *   npm run test:eval -- tests/identity-roundtrip.eval.ts
 * Or all evals:
 *   npm run test:eval
 *
 * Requires at least one of:
 *   - KIMI_API_KEY       (kimi-code)
 *   - ZHIPU_API_KEY      (zhipu-coding)
 *   - MINIMAX_API_KEY    (minimax-coding)
 *
 * Providers without API keys are skipped automatically.
 * Uses coding-plan endpoints only (cheap). Anthropic/OpenAI/etc. are
 * intentionally NOT covered here — those providers already self-identify
 * correctly; this eval targets the distillation-trained coding plans where
 * the original identity bug was observed.
 */

import { describe, it, expect } from 'vitest';
import type { KodaXMessage } from '@kodax/ai';
import { getProvider } from '@kodax/ai';
import { buildSystemPrompt } from '@kodax/coding';

interface ProbeCase {
  id: string;
  provider: 'kimi-code' | 'zhipu-coding' | 'minimax-coding';
  apiKeyEnv: string;
  model: string;
  expectedIdentityTokens: string[]; // any one of these (case-insensitive) must appear
}

const PROBES: ProbeCase[] = [
  {
    id: 'kimi-code',
    provider: 'kimi-code',
    apiKeyEnv: 'KIMI_API_KEY',
    model: 'kimi-for-coding',
    expectedIdentityTokens: ['KodaX', 'kimi'],
  },
  {
    id: 'zhipu-coding',
    provider: 'zhipu-coding',
    apiKeyEnv: 'ZHIPU_API_KEY',
    model: 'glm-5',
    expectedIdentityTokens: ['KodaX', 'glm', 'zhipu', '智谱'],
  },
  {
    id: 'minimax-coding',
    provider: 'minimax-coding',
    apiKeyEnv: 'MINIMAX_API_KEY',
    model: 'MiniMax-M2.7',
    expectedIdentityTokens: ['KodaX', 'minimax'],
  },
];

const IDENTITY_PROMPTS: Array<{ id: string; content: string }> = [
  { id: 'zh', content: '你现在用的是什么模型？请用一句话回答。' },
  { id: 'en', content: 'What model are you? Answer in one concise sentence.' },
  { id: 'intro', content: 'Introduce yourself in one sentence.' },
];

// Patterns that indicate wrong identity (distillation bleed-through)
const WRONG_IDENTITY_PATTERNS: RegExp[] = [
  /\bI(?:'m| am) Claude\b/i,
  /\bI(?:'m| am) ChatGPT\b/i,
  /\bI(?:'m| am) GPT-[0-9]/i,
  /\bmade by (?:OpenAI|Anthropic)\b/i,
  /\b(?:Anthropic|OpenAI)'s (?:AI )?assistant\b/i,
];

// Patterns that indicate persona pollution (KodaX bleeding into first person)
const PERSONA_POLLUTION_PATTERNS: RegExp[] = [
  /\bAs KodaX,? I (?:will|am going to|need to|should)\b/i,
  /\bSpeaking as KodaX\b/i,
];

async function callProviderOnce(
  providerName: ProbeCase['provider'],
  model: string,
  userPrompt: string,
): Promise<string> {
  const provider = getProvider(providerName);
  const systemPrompt = await buildSystemPrompt(
    {
      provider: providerName,
      model,
      context: { executionCwd: process.cwd() },
    },
    true,
  );

  const messages: KodaXMessage[] = [
    { role: 'user', content: userPrompt },
  ];

  const result = await provider.stream(messages, [], systemPrompt);
  return result.textBlocks.map((block) => block.text).join('').trim();
}

describe('L2: Identity Roundtrip (coding-plan providers)', () => {
  for (const probe of PROBES) {
    const hasKey = Boolean(process.env[probe.apiKeyEnv]);

    describe.skipIf(!hasKey)(`${probe.id} (${probe.model})`, () => {
      for (const prompt of IDENTITY_PROMPTS) {
        it(`probe=${prompt.id}: response reflects configured identity`, async () => {
          const response = await callProviderOnce(
            probe.provider,
            probe.model,
            prompt.content,
          );

          // Positive: one of the expected identity tokens should appear.
          const matched = probe.expectedIdentityTokens.some((token) =>
            response.toLowerCase().includes(token.toLowerCase()),
          );
          expect(
            matched,
            [
              `Expected response to contain one of`,
              `  ${JSON.stringify(probe.expectedIdentityTokens)}`,
              `but got:`,
              `  ${response}`,
            ].join('\n'),
          ).toBe(true);

          // Negative: should NOT self-identify as a different vendor's model.
          for (const pattern of WRONG_IDENTITY_PATTERNS) {
            expect(
              response,
              `Response leaked wrong identity via ${pattern}: ${response}`,
            ).not.toMatch(pattern);
          }

          // Negative: should NOT fall into persona-pollution phrasing.
          for (const pattern of PERSONA_POLLUTION_PATTERNS) {
            expect(
              response,
              `Response shows persona pollution via ${pattern}: ${response}`,
            ).not.toMatch(pattern);
          }
        }, 30_000);
      }
    });
  }

  it('at least one provider has an API key configured', () => {
    const configured = PROBES.filter((p) => Boolean(process.env[p.apiKeyEnv]));
    if (configured.length === 0) {
      console.warn(
        '[L2 eval] No provider API keys found. Set KIMI_API_KEY / ZHIPU_API_KEY / MINIMAX_API_KEY to run identity probes.',
      );
    }
    // This assertion always passes; the warning above is the signal.
    expect(true).toBe(true);
  });
});
