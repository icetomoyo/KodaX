/**
 * Kimi public API and Kimi Code real-wire smoke tests.
 *
 * Skipped by default because they spend API quota. Run explicitly with:
 *
 *   KODAX_INTEGRATION_TEST=1 KIMI_API_KEY=... npm run test:integration -- \
 *     packages/llm/src/providers/kimi-wire.integration.test.ts
 *
 * Set KIMI_CODE_API_KEY as well to exercise the subscription endpoint.
 *
 * These are mechanical compatibility checks, not prompt-quality evals.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXToolDefinition } from '../types.js';
import { resolveProvider } from './resolver.js';

const RUN_INTEGRATION =
  process.env.KODAX_INTEGRATION_TEST === '1' && Boolean(process.env.KIMI_API_KEY);
const RUN_KIMI_CODE_INTEGRATION =
  process.env.KODAX_INTEGRATION_TEST === '1' && Boolean(process.env.KIMI_CODE_API_KEY);

const EMIT_RESULT_TOOL: KodaXToolDefinition = {
  name: 'emit_result',
  description: 'Return the requested test result.',
  input_schema: {
    type: 'object',
    properties: {
      value: { type: 'string', enum: ['ok'] },
    },
    required: ['value'],
  },
};

describe.skipIf(!RUN_INTEGRATION)('Kimi public API — real provider HTTP', () => {
  it.each(['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed'])('streams public K3.1 model %s', async (model) => {
    const provider = resolveProvider('kimi');
    expect(provider.getAvailableModels()).toContain(model);
    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }], [],
      'Follow the user request exactly and keep the answer terse.',
      { enabled: true, effort: 'low' },
      { modelOverride: model, maxOutputTokensOverride: 1_024, singleAttempt: true },
      AbortSignal.timeout(45_000),
    );
    expect(result.textBlocks.map(block => block.text).join('').trim()).toBe('OK');
    expect(result.thinkingBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thinking', thinking: expect.stringMatching(/\S/) }),
    ]));
  }, 60_000);

  it('replays K3.1 reasoning_content and tool results through the public endpoint', async () => {
    const provider = resolveProvider('kimi');
    const prompt = 'Call emit_result with value "ok". After the tool result, reply with exactly: OK';
    const system = 'Use the provided tool before answering the user.';
    const reasoning = { enabled: true, effort: 'low' } as const;
    const options = { modelOverride: 'kimi-k3.1-pro', maxOutputTokensOverride: 2_048, singleAttempt: true };
    const result = await provider.stream(
      [{ role: 'user', content: prompt }], [EMIT_RESULT_TOOL], system,
      reasoning, options, AbortSignal.timeout(45_000),
    );
    expect(result.toolBlocks).toEqual([
      expect.objectContaining({ name: 'emit_result', input: { value: 'ok' } }),
    ]);
    const toolCall = result.toolBlocks[0]!;
    const followUp = await provider.stream([
      { role: 'user', content: prompt },
      { role: 'assistant', content: [...result.thinkingBlocks, ...result.textBlocks, ...result.toolBlocks] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: '{"accepted":true}' }] },
    ], [EMIT_RESULT_TOOL], system, reasoning, options, AbortSignal.timeout(45_000));
    expect(followUp.textBlocks.map(block => block.text).join('').trim()).toBe('OK');
  }, 100_000);

  it('streams the default K2.7 model with both thinking and text', async () => {
    const provider = resolveProvider('kimi');

    expect(provider.getModel()).toBe('kimi-k2.7-code');

    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      [],
      'Follow the user request exactly and keep the answer terse.',
      { enabled: true, effort: 'high' },
      { maxOutputTokensOverride: 512 },
      AbortSignal.timeout(45_000),
    );

    expect(result.textBlocks.map((block) => block.text).join('')).toMatch(/\S/);
    expect(result.thinkingBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          thinking: expect.stringMatching(/\S/),
        }),
      ]),
    );
  }, 60_000);

  it('streams public K3 with the shared K3 reasoning profile', async () => {
    const provider = resolveProvider('kimi');

    expect(provider.getAvailableModels()).toContain('kimi-k3');
    expect(provider.getEffectiveContextWindow('kimi-k3')).toBe(1_048_576);

    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      [],
      'Follow the user request exactly and keep the answer terse.',
      { enabled: true, effort: 'low' },
      {
        modelOverride: 'kimi-k3',
        maxOutputTokensOverride: 512,
      },
      AbortSignal.timeout(45_000),
    );

    expect(result.textBlocks.map((block) => block.text).join('')).toMatch(/\S/);
    expect(result.thinkingBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          thinking: expect.stringMatching(/\S/),
        }),
      ]),
    );
  }, 60_000);

  it('disables public K3 reasoning through the shared K3 control', async () => {
    const provider = resolveProvider('kimi');

    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      [],
      'Follow the user request exactly and keep the answer terse.',
      false,
      {
        modelOverride: 'kimi-k3',
        maxOutputTokensOverride: 512,
      },
      AbortSignal.timeout(45_000),
    );

    expect(result.textBlocks.map((block) => block.text).join('')).toMatch(/\S/);
    expect(result.thinkingBlocks).toEqual([]);
  }, 60_000);

  it('recovers when K2.7 rejects a forced tool choice', async () => {
    const provider = resolveProvider('kimi');

    const result = await provider.stream(
      [{ role: 'user', content: 'Call emit_result with value "ok". Do not answer in plain text.' }],
      [EMIT_RESULT_TOOL],
      'Use the provided tool to return the result.',
      { enabled: true, effort: 'high' },
      {
        forcedToolName: 'emit_result',
        maxOutputTokensOverride: 2_048,
      },
      AbortSignal.timeout(45_000),
    );

    expect(result.toolBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'emit_result' }),
      ]),
    );

    const toolCall = result.toolBlocks[0];
    expect(toolCall).toBeDefined();
    if (!toolCall) return;

    const followUp = await provider.stream(
      [
        { role: 'user', content: 'Call emit_result with value "ok". Do not answer in plain text.' },
        {
          role: 'assistant',
          content: [...result.thinkingBlocks, ...result.textBlocks, ...result.toolBlocks],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: toolCall.id, content: '{"accepted":true}' },
          ],
        },
      ],
      [EMIT_RESULT_TOOL],
      'Use the provided tool to return the result, then acknowledge its result.',
      { enabled: true, effort: 'high' },
      { maxOutputTokensOverride: 2_048 },
      AbortSignal.timeout(45_000),
    );

    expect(
      followUp.thinkingBlocks.length + followUp.textBlocks.length + followUp.toolBlocks.length,
    ).toBeGreaterThan(0);
  }, 60_000);

  it('disables thinking on K2.6 when the caller explicitly turns it off', async () => {
    const provider = resolveProvider('kimi');

    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      [],
      'Follow the user request exactly and keep the answer terse.',
      { enabled: false, effort: 'none' },
      {
        modelOverride: 'kimi-k2.6',
        maxOutputTokensOverride: 512,
      },
      AbortSignal.timeout(45_000),
    );

    expect(result.textBlocks.map((block) => block.text).join('')).toMatch(/\S/);
    expect(result.thinkingBlocks).toEqual([]);
  }, 60_000);
});

describe.skipIf(!RUN_KIMI_CODE_INTEGRATION)('Kimi Code — real provider HTTP', () => {
  it.each(['k3.1-pro', 'k3.1-pro-highspeed'])('streams K3.1 model %s with thinking enabled', async (model) => {
    const provider = resolveProvider('kimi-code');
    expect(provider.getAvailableModels()).toContain(model);

    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }], [],
      'Follow the user request exactly and keep the answer terse.',
      { enabled: true, effort: 'low' },
      { modelOverride: model, maxOutputTokensOverride: 1_024, singleAttempt: true },
      AbortSignal.timeout(45_000),
    );

    expect(result.textBlocks.map(block => block.text).join('').trim()).toBe('OK');
    expect(result.thinkingBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thinking', thinking: expect.stringMatching(/\S/) }),
    ]));
  }, 60_000);

  it('replays K3.1 thinking and tool results through the subscription endpoint', async () => {
    const provider = resolveProvider('kimi-code');
    const prompt = 'Call emit_result with value "ok". After the tool result, reply with exactly: OK';
    const system = 'Use the provided tool before answering the user.';
    const reasoning = { enabled: true, effort: 'low' } as const;
    const options = { modelOverride: 'k3.1-pro', maxOutputTokensOverride: 2_048, singleAttempt: true };
    const result = await provider.stream(
      [{ role: 'user', content: prompt }], [EMIT_RESULT_TOOL], system,
      reasoning, options, AbortSignal.timeout(45_000),
    );
    expect(result.toolBlocks).toEqual([
      expect.objectContaining({ name: 'emit_result', input: { value: 'ok' } }),
    ]);
    const toolCall = result.toolBlocks[0]!;
    const followUp = await provider.stream([
      { role: 'user', content: prompt },
      { role: 'assistant', content: [...result.thinkingBlocks, ...result.textBlocks, ...result.toolBlocks] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: '{"accepted":true}' }] },
    ], [EMIT_RESULT_TOOL], system, reasoning, options, AbortSignal.timeout(45_000));
    expect(followUp.textBlocks.map(block => block.text).join('').trim()).toBe('OK');
  }, 100_000);

  it('streams the default Moderato K3 tier over the direct k3-256k model id', async () => {
    const provider = resolveProvider('kimi-code');

    expect(provider.getModel()).toBe('k3-256k');
    expect(provider.getAvailableModels()).toEqual([
      'k3-256k',
      'k3.1-pro',
      'k3.1-pro-highspeed',
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ]);
    expect(provider.getEffectiveContextWindow('k3-256k')).toBe(262_144);

    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      [],
      'Follow the user request exactly and keep the answer terse.',
      undefined,
      { maxOutputTokensOverride: 512 },
      AbortSignal.timeout(45_000),
    );

    expect(result.textBlocks.map((block) => block.text).join('')).toMatch(/\S/);
    expect(result.thinkingBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          thinking: expect.stringMatching(/\S/),
        }),
      ]),
    );
  }, 60_000);

  it('honors the legacy reasoning=false control on K3', async () => {
    const provider = resolveProvider('kimi-code');

    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      [],
      'Follow the user request exactly and keep the answer terse.',
      false,
      { modelOverride: 'k3', maxOutputTokensOverride: 512 },
      AbortSignal.timeout(45_000),
    );

    expect(result.textBlocks.map((block) => block.text).join('')).toMatch(/\S/);
    expect(result.thinkingBlocks).toEqual([]);
  }, 60_000);

  it('retains the standard K2.7 Code subscription route', async () => {
    const provider = resolveProvider('kimi-code');

    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      [],
      'Follow the user request exactly and keep the answer terse.',
      { enabled: true, effort: 'high' },
      {
        modelOverride: 'kimi-for-coding',
        maxOutputTokensOverride: 512,
      },
      AbortSignal.timeout(45_000),
    );

    expect(result.textBlocks.map((block) => block.text).join('')).toMatch(/\S/);
    expect(result.thinkingBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          thinking: expect.stringMatching(/\S/),
        }),
      ]),
    );
  }, 60_000);

  it('streams the K2.7 Code HighSpeed subscription route', async () => {
    const provider = resolveProvider('kimi-code');

    const result = await provider.stream(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      [],
      'Follow the user request exactly and keep the answer terse.',
      { enabled: true, effort: 'high' },
      {
        modelOverride: 'kimi-for-coding-highspeed',
        maxOutputTokensOverride: 512,
      },
      AbortSignal.timeout(45_000),
    );

    expect(result.textBlocks.map((block) => block.text).join('')).toMatch(/\S/);
    expect(result.thinkingBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'thinking',
          thinking: expect.stringMatching(/\S/),
        }),
      ]),
    );
  }, 60_000);
});
