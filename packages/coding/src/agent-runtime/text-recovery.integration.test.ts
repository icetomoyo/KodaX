import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { clearRuntimeModelProviders, createCustomProvider, KodaXProviderError, registerModelProvider } from '@kodax-ai/llm';
import { runKodaX } from '../agent.js';
import { runManagedTaskViaRunner } from '../task-engine/runner-driven.js';
import { _resetMessageQueueForTests, actorQueueId, getMessageQueue } from '@kodax-ai/agent';
import { CodingActorSession } from './actor-runtime.js';
import * as validation from '../../../llm/src/image-validation.js';

let directory: string | undefined;
afterEach(async () => {
  _resetMessageQueueForTests(); vi.restoreAllMocks(); clearRuntimeModelProviders(); vi.unstubAllEnvs();
  if (directory) { expect(path.dirname(directory)).toBe(tmpdir()); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

it.each(['SA', 'AMA'] as const)('%s diagnoses an image rejected after admission and continues without changing raw history', async runtime => {
  directory = await mkdtemp(path.join(tmpdir(), 'kodax-text-recovery-runtime-'));
  vi.stubEnv('KODAX_HOME', directory); vi.stubEnv('TEXT_RECOVERY_KEY', 'test');
  const file = path.join(directory, 'header.png');
  await writeFile(file, await readFile('tests/fixtures/images/valid-png.png'));
  const image = { type: 'image' as const, path: file };
  const history = [{ role: 'user' as const, content: [image] }];
  const original = structuredClone(history);
  // Admission cannot decode in this host; the later read-only inspection can.
  vi.spyOn(validation, 'validateImageBytes').mockResolvedValueOnce({ status: 'unverified', reason: 'decoder_unavailable' })
    .mockResolvedValue({ status: 'invalid' });
  const provider = createCustomProvider({ name: 'text-recovery', protocol: 'anthropic', model: 'vision',
    baseUrl: 'https://unused.invalid', apiKeyEnv: 'TEXT_RECOVERY_KEY', imageInput: true });
  const stream = vi.spyOn(provider, 'stream').mockImplementation(async messages => {
    if (JSON.stringify(messages).includes('"type":"image"')) {
      throw new KodaXProviderError('400 [1210] 图片输入格式/解析错误', 'text-recovery', { httpStatus: 400, upstreamCode: '1210' });
    }
    return { textBlocks: [{ type: 'text', text: '六万元，每项两万元，启动前支付。' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  });
  const diagnose = vi.spyOn(provider, 'complete').mockImplementation(async messages => {
    expect(messages.every(message => typeof message.content === 'string')).toBe(true);
    expect(JSON.stringify(messages)).toContain('m0/b0');
    return { textBlocks: [{ type: 'text', text: '{"action":"omit_attachment","attachmentId":"m0/b0","reason":"local inspection confirms invalid image"}' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  });
  registerModelProvider('text-recovery', () => provider);
  const result = await (runtime === 'SA' ? runKodaX : runManagedTaskViaRunner)({ provider: 'text-recovery', reasoningMode: 'off', maxIter: 2,
    context: { executionCwd: directory, managedTaskWorkspaceDir: directory }, session: { initialMessages: history } }, '总价六万元，每项两万元，启动前支付');
  expect(result.success).toBe(true);
  expect(diagnose).toHaveBeenCalledOnce(); expect(stream).toHaveBeenCalledTimes(runtime === 'SA' ? 2 : 3);
  expect(stream.mock.calls[1]![4]).toMatchObject({ singleAttempt: true });
  expect(stream.mock.calls.slice(1).every(call => !JSON.stringify(call[0]).includes('"type":"image"'))).toBe(true);
  expect(history).toEqual(original);
  expect(await readFile(file)).toEqual(await readFile('tests/fixtures/images/valid-png.png'));
});

for (const runtime of ['SA', 'AMA'] as const) {
  for (const outcome of ['resume', 'queued-input', 'second-rejection'] as const) {
    it(`${runtime} uses actual wire image evidence and handles ${outcome}`, async () => {
      directory = await mkdtemp(path.join(tmpdir(), 'kodax-text-recovery-wire-'));
      vi.stubEnv('KODAX_HOME', directory); vi.stubEnv('TEXT_RECOVERY_KEY', 'test');
      const file = path.join(directory, 'header.png');
      await writeFile(file, await readFile('tests/fixtures/images/valid-png.png'));
      const history = [{ role: 'user' as const, content: [{ type: 'image' as const, path: file }] }];
      const original = structuredClone(history);
      const sessionId = `text-recovery-${runtime}-${outcome}`;
      const actorSession = new CodingActorSession({ sessionId });
      const provider = createCustomProvider({ name: 'wire-recovery', protocol: 'openai', model: 'vision',
        baseUrl: 'https://unused.invalid', apiKeyEnv: 'TEXT_RECOVERY_KEY', imageInput: true });
      let diagnostics = 0;
      let streams = 0;
      const create = vi.fn(async (request: { stream?: boolean; messages: { content: unknown }[] }, options?: { maxRetries?: number }) => {
        if (!request.stream) {
          diagnostics++;
          expect(options?.maxRetries).toBe(0);
          const text = JSON.stringify(request.messages);
          expect(text).not.toContain('data:image/');
          const id = text.match(/m\d+\/b\d+(?:\/i\d+)?/)?.[0];
          expect(id).toBeDefined();
          if (outcome === 'queued-input') getMessageQueue().enqueue({ agentId: actorQueueId(sessionId, '/root'),
            priority: 'user', mode: 'prompt', content: 'New user input received during diagnosis' });
          return { choices: [{ message: { content: JSON.stringify({ action: 'omit_attachment', attachmentId: id,
            reason: 'Provider identified the exact rejected payload.' }) }, finish_reason: 'stop' }] };
        }
        streams++;
        if (streams === 1) {
          const message = request.messages.findIndex(item => JSON.stringify(item.content).includes('image_url'));
          const content = request.messages[message]!.content as { type: string }[];
          const block = content.findIndex(item => item.type === 'image_url');
          throw Object.assign(new Error(`Invalid image format at messages[${message}].content[${block}].image_url.url`), { status: 400 });
        }
        if (streams === 2) expect(options?.maxRetries).toBe(0);
        expect(JSON.stringify(request.messages)).not.toContain('data:image/');
        if (outcome === 'second-rejection') throw Object.assign(new Error('Service rate limit'), { status: 429 });
        return (async function* () { yield { choices: [{ delta: { content: '六万元，每项两万元，启动前支付。' }, finish_reason: 'stop' }] }; })();
      });
      Reflect.set(provider, '_client', { chat: { completions: { create } } });
      registerModelProvider('wire-recovery', () => provider);
      try {
        const result = await (runtime === 'SA' ? runKodaX : runManagedTaskViaRunner)({ provider: 'wire-recovery',
          reasoningMode: 'off', maxIter: 2, lsp: false, session: { id: sessionId, initialMessages: history },
          context: { executionCwd: directory, managedTaskWorkspaceDir: directory, actorSession } },
        '总价六万元，每项两万元，启动前支付').catch(error => {
          if (runtime === 'AMA' && outcome !== 'resume') return { success: false };
          throw error;
        });
        expect(diagnostics).toBe(1);
        expect(result.success).toBe(outcome === 'resume');
        if (outcome !== 'resume') expect(streams).toBe(outcome === 'queued-input' ? 1 : 2);
        expect(history).toEqual(original);
      } finally { await actorSession.close('test complete'); }
    });
  }
}
