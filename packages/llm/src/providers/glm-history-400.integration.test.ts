/** Opt-in diagnostic experiment: synthetic history/files; only the read tool is executed. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicSdkClient } from './anthropic.js';
import { KODAX_PROVIDERS } from './registry.js';
import type { KodaXContentBlock, KodaXMessage } from '../types.js';
import { KODAX_TOOLS } from '../../../coding/src/tools/registry.js';
import { cleanupIncompleteToolCalls, validateAndFixToolHistory } from '../../../agent/src/runtime-middleware/history-cleanup.js';
import { toolRead } from '../../../coding/src/tools/read.js';
import { KodaXProviderError } from '../errors.js';
import { Jimp } from 'jimp';
import { prepareHistoryImages, withPreparedImageHistory } from './image-serialization.js';

const enabled = process.env.KODAX_GLM_HISTORY_PROBE === '1';
const outputDir = path.join(tmpdir(), 'kodax-eval-dumps', 'glm-history-400-20260914');
const tools = KODAX_TOOLS.filter((tool) => tool.name === 'read');
const system = 'This is a synthetic document-editing protocol test. Do not call tools. Reply only OK.';
type WireRequest = Anthropic.Messages.MessageCreateParamsNonStreaming;
type Variant = { id: string; history: KodaXMessage[]; legacyOrder?: boolean; cleanup?: boolean; imageResult?: boolean; directImage?: boolean; defaultOutput?: boolean; stream?: boolean; invalidImage?: boolean };

function history(count = 1): KodaXMessage[] {
  return [
    { role: 'user', content: 'Use the provided quotation template. Inspect its format.' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'I will inspect the supplied template before editing.', signature: '' },
      { type: 'text', text: 'I will inspect the template.' },
      ...Array.from({ length: count }, (_, index): KodaXContentBlock => ({
        type: 'tool_use', id: `call_${index}`, name: 'read', input: { path: `synthetic-template-${index}.txt` },
      })),
    ] },
    { role: 'user', content: Array.from({ length: count }, (_, index): KodaXContentBlock => ({
      type: 'tool_result', tool_use_id: `call_${index}`, content: 'Template: quotation, three services, total 60000.',
    })) },
    { role: 'user', content: 'Change the total to 50000. No further tools needed; reply only OK.' },
  ];
}

function variants(): Variant[] {
  const split = history(2);
  const results = split[2]!.content as KodaXContentBlock[];
  split.splice(2, 1, { role: 'user', content: [results[0]!] }, { role: 'user', content: [results[1]!] });
  const orphan = history();
  orphan.splice(2, 1);
  const emptyThinking = history();
  (emptyThinking[1]!.content as KodaXContentBlock[])[0] = { type: 'thinking', thinking: '', signature: '' };
  const mixedEmptyText = history();
  (mixedEmptyText[1]!.content as KodaXContentBlock[]).splice(1, 0, { type: 'text', text: '' });
  const whitespaceId = history();
  (whitespaceId[1]!.content as KodaXContentBlock[]).push({ type: 'tool_use', id: '  ', name: 'read', input: { path: 'x' } });
  const thinkingOnly = history();
  thinkingOnly[1]!.content = [{ type: 'thinking', thinking: 'I should inspect the document.', signature: '' }];
  thinkingOnly.splice(2, 1);
  const emptyResult = history();
  emptyResult[2]!.content = [{ type: 'tool_result', tool_use_id: 'call_0', content: [] }];
  const nulResult = history();
  nulResult[2]!.content = [{ type: 'tool_result', tool_use_id: 'call_0', content: 'Binary Word header: \u0000\u0001\ufffd\ud800 end.' }];
  const duplicate = history();
  (duplicate[1]!.content as KodaXContentBlock[]).push({ type: 'tool_use', id: 'call_0', name: 'read', input: { path: 'second.txt' } });
  const redacted = history();
  (redacted[1]!.content as KodaXContentBlock[])[0] = { type: 'redacted_thinking', data: 'synthetic-foreign-provider-data' };
  const emptyUser = history();
  emptyUser.push({ role: 'assistant', content: 'OK' }, { role: 'user', content: '' });
  const interleaved = history();
  (interleaved[1]!.content as KodaXContentBlock[]).push({ type: 'thinking', thinking: 'Review the result next.', signature: 'synthetic-foreign-signature' });
  const invalidImageContinue = history();
  invalidImageContinue.push({ role: 'user', content: 'Continue.' });
  return [
    { id: 'canonical', history: history() },
    { id: 'legacy-order', history: history(), legacyOrder: true },
    { id: 'sixteen-calls', history: history(16) },
    { id: 'split-results', history: split },
    { id: 'split-results-runtime-cleanup', history: split, cleanup: true },
    { id: 'interrupted-continue', history: orphan },
    { id: 'empty-thinking', history: emptyThinking },
    { id: 'mixed-empty-text', history: mixedEmptyText },
    { id: 'whitespace-call-id', history: whitespaceId },
    { id: 'thinking-only-continue', history: thinkingOnly },
    { id: 'empty-result-array', history: emptyResult },
    { id: 'binary-text-result', history: nulResult },
    { id: 'tool-image-result', history: history(), imageResult: true },
    { id: 'direct-image', history: history(), directImage: true },
    { id: 'duplicate-call-id', history: duplicate },
    { id: 'redacted-thinking', history: redacted },
    { id: 'empty-user-string', history: emptyUser },
    { id: 'interleaved-thinking', history: interleaved },
    { id: 'default-output-reserve', history: history(), defaultOutput: true },
    { id: 'streaming-canonical', history: history(), stream: true },
    { id: 'invalid-tool-image', history: history(), imageResult: true, invalidImage: true },
    { id: 'invalid-tool-image-continue', history: invalidImageContinue, imageResult: true, invalidImage: true },
  ];
}

async function capture(name: 'zhipu-coding' | 'zai-coding', variant: Variant): Promise<WireRequest> {
  const provider = KODAX_PROVIDERS[name]();
  const create = vi.fn(async (_request: WireRequest) => ({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
  Reflect.set(provider, '_client', { messages: { create } });
  let messages = structuredClone(variant.history);
  if (variant.imageResult || variant.directImage) {
    await mkdir(outputDir, { recursive: true });
    const imagePath = path.join(outputDir, 'synthetic-pixel.png');
    await writeFile(imagePath, variant.invalidImage ? Buffer.from('not an image: synthetic failed document render') : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64'));
    const image = { type: 'image' as const, path: imagePath, mediaType: 'image/png' };
    if (variant.imageResult) messages[2]!.content = [{ type: 'tool_result', tool_use_id: 'call_0', content: [{ type: 'text', text: 'Rendered template preview.' }, image] }];
    else messages.push({ role: 'user', content: [{ type: 'text', text: 'A synthetic preview. Reply only OK.' }, image] });
  }
  if (variant.cleanup) messages = validateAndFixToolHistory(cleanupIncompleteToolCalls(messages));
  await provider.complete(messages, tools, system, { effort: 'auto' }, {
    modelOverride: 'glm-5.3-flash', ...(variant.defaultOutput ? {} : { maxOutputTokensOverride: 256 }),
  });
  const request = JSON.parse(JSON.stringify(create.mock.calls[0]![0])) as WireRequest;
  if (variant.legacyOrder) {
    for (const message of request.messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      const rank = (block: Anthropic.Messages.ContentBlockParam): number =>
        block.type === 'thinking' || block.type === 'redacted_thinking' ? 0 : block.type === 'tool_use' ? 1 : 2;
      message.content.sort((left, right) => rank(left) - rank(right));
    }
  }
  return request;
}

describe.skipIf(!enabled)('GLM HTTP 400 synthetic history investigation', () => {
  for (const name of ['zhipu-coding', 'zai-coding'] as const) {
    const keyName = name === 'zhipu-coding' ? 'ZHIPU_CODING_API_KEY' : 'ZAI_CODING_API_KEY';
    const endpoint = name === 'zhipu-coding'
      ? 'https://open.bigmodel.cn/api/anthropic/v1/messages'
      : 'https://api.z.ai/api/anthropic/v1/messages';
    for (const variant of variants()) {
      it(`${name}/${variant.id}`, async () => {
        const key = process.env[keyName];
        expect(key, `${keyName} must be configured`).toBeTruthy();
        const request = await capture(name, variant);
        const sentRequest = { ...request, ...(variant.stream ? { stream: true } : {}) };
        const started = Date.now();
        let status: number | undefined;
        let responseBody = '';
        let transportError: string | undefined;
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key!, 'user-agent': 'KodaX' },
            body: JSON.stringify(sentRequest), signal: AbortSignal.timeout(45000),
          });
          status = response.status;
          responseBody = await response.text();
        } catch (error) {
          transportError = error instanceof Error ? error.message : String(error);
        }
        const record = {
          provider: name, variant: variant.id, endpoint, request: sentRequest,
          requestHash: createHash('sha256').update(JSON.stringify(sentRequest)).digest('hex'),
          status, responseBody, transportError, durationMs: Date.now() - started,
          observedAt: new Date().toISOString(),
        };
        await mkdir(outputDir, { recursive: true });
        await writeFile(path.join(outputDir, `${name}-${variant.id}.json`), JSON.stringify(record, null, 2).replaceAll(key!, '<REDACTED>'));
        process.stdout.write(`${name}/${variant.id}: HTTP ${status ?? 'none'} (${record.durationMs}ms)\n`);
        // A completed probe is not a claim of provider acceptance. Inspect recorded status/body.
        expect(status ?? transportError).toBeDefined();
      }, 60000);
    }
  }
});

describe.skipIf(!enabled)('GLM actual SDK streaming round trip', () => {
  for (const name of ['zhipu-coding', 'zai-coding'] as const) {
    it(`${name}/sdk-round-trip-auto`, async () => {
      const key = process.env[name === 'zhipu-coding' ? 'ZHIPU_CODING_API_KEY' : 'ZAI_CODING_API_KEY'];
      expect(key).toBeTruthy();
      const records: unknown[] = [];
      const captures: Promise<void>[] = [];
      const baseURL = name === 'zhipu-coding' ? 'https://open.bigmodel.cn/api/anthropic' : 'https://api.z.ai/api/anthropic';
      const client = await createAnthropicSdkClient({
        apiKey: key, baseURL, maxRetries: 0,
        defaultHeaders: { 'User-Agent': 'KodaX' },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          const copy = response.clone();
          captures.push(copy.text().then((responseBody) => {
            records.push({ status: response.status, request: JSON.parse(String(init?.body)) as unknown, responseBody });
          }));
          return response;
        },
      });
      const provider = KODAX_PROVIDERS[name]();
      Reflect.set(provider, '_client', client);
      const messages: KodaXMessage[] = [{ role: 'user', content: 'Call read once for /synthetic/quotation-template.txt to inspect its layout. Do not guess its contents.' }];
      const outcomes: unknown[] = [];
      try {
        for (let round = 0; round < 3; round++) {
          const result = await provider.stream(
            validateAndFixToolHistory(cleanupIncompleteToolCalls(messages)), tools,
            'Synthetic protocol test. First read the requested file. After receiving its content, acknowledge with OK. No other tools.',
            { effort: 'auto' }, { modelOverride: 'glm-5.3-flash', maxOutputTokensOverride: 1024 }, AbortSignal.timeout(45000),
          );
          outcomes.push({ round, result });
          messages.push({ role: 'assistant', content: [...result.thinkingBlocks, ...result.textBlocks, ...result.toolBlocks] });
          if (round === 0) expect(result.toolBlocks.length, 'round-trip fixture must elicit an actual tool call').toBeGreaterThan(0);
          if (result.toolBlocks.length > 0) messages.push({ role: 'user', content: result.toolBlocks.map((call) => ({
            type: 'tool_result', tool_use_id: call.id, content: 'Synthetic quotation template: three services, total 60000; payment before work. Header: Example Firm.',
          })) });
          else messages.push({ role: 'user', content: 'Change the total to 50000. Reply only OK; no more tools.' });
        }
      } catch (error) {
        outcomes.push({ error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        await Promise.all(captures);
        await mkdir(outputDir, { recursive: true });
        await writeFile(path.join(outputDir, `${name}-sdk-round-trip-auto.json`), JSON.stringify({ provider: name, outcomes, records }, null, 2).replaceAll(key!, '<REDACTED>'));
      }
    }, 150000);
  }
});

describe.skipIf(!enabled)('GLM real SDK corrupt-image reproducer', () => {
  for (const name of ['zhipu-coding', 'zai-coding'] as const) {
    it(`${name}/sdk-corrupt-image-recovery`, async () => {
      const key = process.env[name === 'zhipu-coding' ? 'ZHIPU_CODING_API_KEY' : 'ZAI_CODING_API_KEY'];
      expect(key).toBeTruthy();
      await mkdir(outputDir, { recursive: true });
      const imagePath = path.join(outputDir, `${name}-corrupt-preview.png`);
      await writeFile(imagePath, Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex'));
      const content = await toolRead({ path: imagePath }, { backups: new Map(), executionCwd: outputDir });
      expect(typeof content).toBe('string');
      const messages = history();
      const assistant = messages[1]!.content as KodaXContentBlock[];
      messages[1]!.content = assistant.map((block) => block.type === 'tool_use'
        ? { ...block, input: { path: imagePath } } : block);
      // Simulate an old persisted image block, bypassing today's read admission check.
      messages[2]!.content = [{ type: 'tool_result', tool_use_id: 'call_0', content: [{ type: 'image', path: imagePath, mediaType: 'image/png' }] }];
      const provider = KODAX_PROVIDERS[name]();
      Reflect.set(provider, '_client', await createAnthropicSdkClient({
        apiKey: key, maxRetries: 0, defaultHeaders: { 'User-Agent': 'KodaX' },
        baseURL: name === 'zhipu-coding' ? 'https://open.bigmodel.cn/api/anthropic' : 'https://api.z.ai/api/anthropic',
      }));
      const observations: unknown[] = [];
      try {
        for (const phase of ['initial', 'continue', 'replace-image-bytes'] as const) {
          if (phase === 'continue') messages.push({ role: 'user', content: 'Continue.' });
          if (phase === 'replace-image-bytes') await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64'));
          let failure: unknown;
          try {
            const result = await provider.stream(validateAndFixToolHistory(cleanupIncompleteToolCalls(messages)), tools, system,
              { effort: 'auto' }, { modelOverride: 'glm-5.3-flash', maxOutputTokensOverride: 256 }, AbortSignal.timeout(45000));
            observations.push({ phase, result });
          } catch (error) {
            failure = error;
            observations.push({ phase, error: error instanceof Error ? error.message : String(error), metadata: error instanceof KodaXProviderError ? error.metadata : undefined });
          }
          expect(failure).toBeUndefined();
        }
      } finally {
        await writeFile(path.join(outputDir, `${name}-sdk-corrupt-image-recovery.json`), JSON.stringify({ provider: name, toolReadContent: content, observations }, null, 2).replaceAll(key!, '<REDACTED>'));
      }
    }, 150000);
  }
});

// Production regression, at most two provider calls: old poisoned history + valid companion image.
// Low effort is a test control for obtaining a short visible answer, not a recovery policy.
describe.skipIf(!enabled)('GLM production image recovery', () => {
  for (const name of ['zhipu-coding', 'zai-coding'] as const) {
    it(`${name}/sdk-image-projection`, async () => {
      const key = process.env[name === 'zhipu-coding' ? 'ZHIPU_CODING_API_KEY' : 'ZAI_CODING_API_KEY'];
      expect(key).toBeTruthy();
      const evidenceDir = path.join(outputDir, 'admission-recovery');
      await mkdir(evidenceDir, { recursive: true });
      const badPath = path.join(evidenceDir, `${name}-missing-sof.jpg`);
      const goodPath = path.join(evidenceDir, `${name}-valid-header.jpg`);
      const badBytes = Buffer.from('ffd8ffe000104a46494600010100000100010000ffe10008457869660000ffd9', 'hex');
      await writeFile(badPath, badBytes);
      await writeFile(goodPath, await new Jimp({ width: 160, height: 46, color: 0x2266ccff }).getBuffer('image/jpeg'));
      const content = await toolRead({ path: badPath }, { backups: new Map(), executionCwd: evidenceDir });
      expect(typeof content).toBe('string');
      expect(content).toContain('cannot be decoded');
      const messages = history();
      messages[2]!.content = [{ type: 'tool_result', tool_use_id: 'call_0', content: [
        { type: 'text', text: 'Keep the extracted template information.' },
        { type: 'image', path: badPath, mediaType: 'image/jpeg' },
        { type: 'image', path: goodPath, mediaType: 'image/jpeg' },
      ] }];
      messages.push({ role: 'user', content: 'Continue. The total should be 60000. Reply only OK.' });
      const original = structuredClone(messages);
      const provider = KODAX_PROVIDERS[name]();
      Reflect.set(provider, '_client', await createAnthropicSdkClient({ apiKey: key, maxRetries: 0,
        defaultHeaders: { 'User-Agent': 'KodaX' }, baseURL: name === 'zhipu-coding'
          ? 'https://open.bigmodel.cn/api/anthropic' : 'https://api.z.ai/api/anthropic' }));
      const result = await withPreparedImageHistory(async () => {
        await prepareHistoryImages(messages);
        return provider.stream(validateAndFixToolHistory(cleanupIncompleteToolCalls(messages)), tools, system,
          { effort: 'low' }, { modelOverride: 'glm-5.3-flash', maxOutputTokensOverride: 1024 }, AbortSignal.timeout(45000));
      });
      expect(result.textBlocks.some(block => block.text.trim().length > 0)).toBe(true);
      expect(messages).toEqual(original);
      expect(await readFile(badPath)).toEqual(badBytes);
      await writeFile(path.join(evidenceDir, `${name}.json`), JSON.stringify({
        provider: name, toolReadContent: content, originalHistoryPreserved: true, result,
      }, null, 2).replaceAll(key!, '<REDACTED>'));
    }, 60000);
  }
});
