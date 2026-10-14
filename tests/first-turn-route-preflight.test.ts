import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProvider, resolveModelCapabilities } from '../packages/llm/src/index.js';
import { observeProviderOperation, runWithProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { firstTurnReasoningFor } from './first-turn-eval-support.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('first-turn routes build one physical SDK request with the frozen effort', () => {
  for (const [provider, model, environment] of [
    ['zhipu-coding', 'glm-5.3-flash', 'ZHIPU_CODING_API_KEY'],
    ['zhipu-coding', 'glm-5.3', 'ZHIPU_CODING_API_KEY'],
    ['zai-coding', 'glm-5.3', 'ZAI_CODING_API_KEY'],
    ['zai-coding', 'glm-5.3-flash', 'ZAI_CODING_API_KEY'],
    ['deepseek', 'deepseek-flash', 'DEEPSEEK_API_KEY'],
    ['kimi-code', 'kimi-for-coding', 'KIMI_CODE_API_KEY'],
  ] as const) {
    it(`${provider}/${model}: no credential or HTTP leaves the mocked fetch`, async () => {
      vi.stubEnv(environment, `local-fixture-key-${provider}-${model}`);
      const requests: Record<string, unknown>[] = [];
      const facts: ProviderRequestObservation[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        requests.push(body);
        const anthropic = Object.hasOwn(body, 'system');
        const rows = anthropic ? [
          { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ] : [
          { choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 } },
        ];
        const sse = rows.map(row => `${anthropic && 'type' in row ? `event: ${row.type}\n` : ''}data: ${JSON.stringify(row)}\n\n`).join('') + (anthropic ? '' : 'data: [DONE]\n\n');
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
      }));
      const reasoning = firstTurnReasoningFor(provider);
      expect(resolveModelCapabilities(provider, model)?.reasoningProfile?.localRejectEfforts ?? []).not.toContain(reasoning.effort);
      const result = await runWithProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(provider, 'utility', undefined, () => getProvider(provider).stream([{ role: 'user', content: 'hello' }], [], 'fixture system', reasoning, { modelOverride: model, singleAttempt: true, maxOutputTokensOverride: 2048 })));
      expect(result.textBlocks.map(block => block.text).join('')).toBe('ok');
      expect(requests).toHaveLength(1);
      expect(new Set(facts.filter(f => f.boundary === 'physical_attempt' && f.state === 'started').map(f => f.requestId)).size).toBe(1);
      if (provider === 'kimi-code') {
        expect(requests[0]).not.toHaveProperty('thinking.type', 'disabled');
      } else if (provider === 'deepseek') {
        expect(JSON.stringify(requests[0])).toMatch(/disabled|"none"/);
      } else {
        expect(requests[0]).toHaveProperty('thinking.type', 'adaptive');
        expect(requests[0]).toHaveProperty('output_config.effort', 'low');
      }
    });
  }
});
