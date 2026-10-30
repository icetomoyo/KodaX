import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as sdk from '../dist/sdk-llm.js';
import { publishGeneratedImages } from '../dist/sdk-media.js';

test('published operation SDK keeps classification, image artifacts and restored background jobs behind fresh scoped authority', async t => {
  const previous = globalThis.fetch;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-published-operations-'));
  t.after(async () => { globalThis.fetch = previous; await rm(directory, { recursive: true, force: true }); });
  const bytes = await readFile(new URL('fixtures/images/valid-png.png', import.meta.url));
  const purposes = [], bearers = [];
  globalThis.fetch = async (url, init) => {
    bearers.push(new Headers(init.headers).get('authorization'));
    if (String(url).endsWith('/systemone')) return Response.json({ answers: { yes: { type: 'noul', noul: 0.9 } } });
    if (String(url).endsWith('/images')) return Response.json({ data: [{ b64_json: bytes.toString('base64'), media_type: 'image/png' }] });
    return Response.json({ id: 'resp_job', status: init.method === 'GET' ? 'completed' : String(url).endsWith('/cancel') ? 'cancelled' : 'queued',
      output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'complete' }] }], usage: { input_tokens: 10, output_tokens: 2 } });
  };
  const scope = sdk.createProviderCredentialLeaseScope({ allowedProviders: ['classifier', 'images', 'jobs'], async acquire(provider, purpose) {
    purposes.push(purpose); return `request-key-${provider}-${purposes.length}`;
  } });
  t.after(() => scope.close());
  await sdk.runWithProviderCredentialLeaseScope(scope, async () => {
    const base = { model: 'fixture', credentialSource: 'broker' };
    const classification = await sdk.classify(sdk.createProviderOperationConnection('typesafe', { ...base, name: 'classifier', api: 'typesafe-system-one' }),
      { state: 'Evidence', questions: { yes: { type: 'bool', instructions: 'Yes?' } } });
    assert.equal(classification.answers.yes.probability, 0.9);
    const generated = await sdk.generateImages(sdk.createProviderOperationConnection('openrouter', { ...base, name: 'images', api: 'openrouter-images', dialect: 'images' }), { prompt: 'Tree' });
    const artifacts = await publishGeneratedImages({ images: generated.images, directory, artifacts: {
      async create(input) { return { ...input, id: 'artifact', createdAt: new Date().toISOString(), sizeBytes: (await stat(input.path)).size }; },
      async delete() { return true; },
    } });
    assert.deepEqual(await readFile(artifacts[0].path), bytes);
    const connection = sdk.createProviderOperationConnection('openai', { ...base, name: 'jobs', api: 'openai-background-responses', accountScope: 'authorized-account' });
    const job = await sdk.submitDeferred(connection, { messages: [], system: '', tools: [], maxOutputTokens: 100 });
    assert.equal(job.status, 'queued');
    assert.ok(!JSON.stringify(job.reference).includes('request-key'));
    const restored = JSON.parse(JSON.stringify(job.reference));
    const completed = await sdk.fetchDeferred(connection, restored);
    assert.equal(completed.result.textBlocks[0].text, 'complete');
    assert.equal(completed.usageKind, 'cumulative');
    const cancelled = await sdk.cancelDeferred(connection, restored);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.partialUsage.inputTokens, 10);
  });
  assert.deepEqual(purposes, ['classifier', 'utility', 'utility', 'utility', 'utility']);
  assert.equal(new Set(bearers).size, 5);
});

test('standalone llm exports operations and the narrow error subpath preserves constructor identity', async () => {
  const llm = await import('../packages/llm/dist/index.js');
  const errors = await import('../packages/llm/dist/errors.js');
  assert.equal(llm.KodaXNetworkError, errors.KodaXNetworkError);
  assert.equal(typeof llm.generateImages, 'function'); assert.equal(typeof llm.classify, 'function');
  assert.equal(typeof llm.submitDeferred, 'function'); assert.equal(typeof llm.fetchDeferred, 'function'); assert.equal(typeof llm.cancelDeferred, 'function');
});
