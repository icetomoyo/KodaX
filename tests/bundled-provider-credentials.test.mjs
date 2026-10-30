import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Run with Node, outside Vitest's source aliases: the published SDK graph is
// the boundary under test, including shared chunks and its credential ALS.
const llm = await import('../dist/sdk-llm.js');
const { generateSummary } = await import('../dist/sdk-agent.js');
test('published file credentials survive store reconstruction and share the SDK credential scope', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-bundled-file-auth-'));
  const file = path.join(folder, 'auth.json');
  const provider = llm.createCustomProvider({ name: 'published-file', protocol: 'openai', api: 'responses', model: 'fixture', baseUrl: 'https://published-file.invalid/v1', apiKeyEnv: 'KODAX_FILE_UNSET' });
  const binding = { profile: 'default', provider: provider.name, connectionFingerprint: provider.getCredentialConnectionFingerprint() };
  await llm.createFileProviderCredentialStore(file).setApiKey(binding, 'published-file-fixture');
  const store = llm.createFileProviderCredentialStore(file), scope = llm.createProviderCredentialLeaseScope(llm.createFileProviderCredentialAccess({ store, bindings: [binding] }));
  const original = globalThis.fetch; let wires = 0;
  t.after(async () => { globalThis.fetch = original; scope.close(); await rm(folder, { recursive: true, force: true }); });
  globalThis.fetch = async (_url, init) => { wires++; assert.equal(new Headers(init.headers).get('authorization'), 'Bearer published-file-fixture'); return Response.json({ status: 'completed', output: [] }); };
  await llm.runWithProviderCredentialLeaseScope(scope, () => provider.complete([], [], ''));
  assert.equal(wires, 1); assert.equal(JSON.stringify(await store.describeApiKey(binding)).includes('published-file-fixture'), false);
  await store.removeApiKey(binding);
  await assert.rejects(llm.runWithProviderCredentialLeaseScope(scope, () => provider.complete([], [], '')), /unavailable/);
  assert.equal(wires, 1);
});
const customProviders = ['openai', 'anthropic'].map((protocol) => ({
  name: `credential-test-${protocol}`,
  protocol,
  baseUrl: 'https://credential-test.invalid/v1',
  apiKeyEnv: 'KODAX_BUNDLE_TEST_API_KEY',
  model: 'credential-test-model',
}));
llm.registerCustomProviders(customProviders);

for (const name of ['TimeoutError', 'AbortError']) {
  test(`bundled SDK preserves redacted ${name} and nested causes`, async (t) => {
    const secret = 'fake-bundled-error-secret';
    const original = new DOMException(`failed ${secret}`, name);
    Object.defineProperty(original, 'cause', { value: new Error(`nested ${secret}`) });
    const scope = llm.createProviderCredentialLeaseScope({
      allowedProviders: ['openai'], acquire: async () => secret,
    });
    t.after(() => scope.close());
    await assert.rejects(llm.runWithProviderCredentialLeaseScope(scope, () =>
      llm.withProviderRequestCredential('openai', 'primary', undefined, () => { throw original; })), (error) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, name);
      assert.equal(error.code, name === 'AbortError' ? 20 : 23);
      assert.equal(error.message, 'failed [REDACTED_CREDENTIAL]');
      assert.equal(error.cause.message, 'nested [REDACTED_CREDENTIAL]');
      assert.equal(error.stack, original.stack.replaceAll(secret, '[REDACTED_CREDENTIAL]'));
      assert.equal(original.message, `failed ${secret}`);
      return true;
    });
  });
}

for (const providerName of ['openai', 'anthropic', ...customProviders.map(({ name }) => name)]) {
  for (const cached of [false, true]) {
    test(`${providerName}: ${cached ? 'cached managed' : 'manual'} summary acquires its scoped credential`, async (t) => {
      const provider = llm.resolveProvider(providerName);
      const requests = [];
      const scope = llm.createProviderCredentialLeaseScope({
        allowedProviders: [providerName],
        async acquire(name, purpose, signal) {
          requests.push({ name, purpose });
          assert.equal(signal.aborted, false);
          return 'bundle-test-scoped-key';
        },
      });
      const originalFetch = globalThis.fetch;
      let wireRequests = 0;
      globalThis.fetch = async (_url, options) => {
        wireRequests += 1;
        const headers = new Headers(options.headers);
        assert.ok(headers.get('authorization') === 'Bearer bundle-test-scoped-key'
          || headers.get('x-api-key') === 'bundle-test-scoped-key');
        return new Response(JSON.stringify({ error: { message: 'bundle-test-auth-rejection' } }), {
          status: 401, headers: { 'content-type': 'application/json' },
        });
      };
      t.after(() => {
        globalThis.fetch = originalFetch;
        scope.close();
      });
      await assert.rejects(llm.runWithProviderCredentialLeaseScope(scope, () => generateSummary(
        [{ role: 'user', content: 'Continue the current task.' }],
        provider,
        { readFiles: [], modifiedFiles: [] },
        undefined, undefined, undefined, undefined, undefined, undefined,
        cached ? { tools: [], reasoning: false } : undefined,
      )), /bundle-test-auth-rejection/);
      assert.deepEqual(requests, [{ name: providerName, purpose: 'compaction' }]);
      assert.equal(wireRequests, 1);
    });
  }
}

test('bundled summaries retain legacy exact credentials and unbound environment mode', async (t) => {
  const provider = llm.resolveProvider('openai');
  const envName = provider.getApiKeyEnv();
  const originalKey = process.env[envName];
  const originalFetch = globalThis.fetch;
  const received = [];
  process.env[envName] = 'bundle-test-ambient-key';
  globalThis.fetch = async (_url, options) => {
    received.push(new Headers(options.headers).get('authorization'));
    return new Response(JSON.stringify({ error: { message: 'bundle-test-auth-rejection' } }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env[envName];
    else process.env[envName] = originalKey;
  });
  const summarize = () => generateSummary([], provider, { readFiles: [], modifiedFiles: [] });
  await assert.rejects(summarize(), /bundle-test-auth-rejection/);
  await assert.rejects(llm.runWithProviderCredential('openai', 'bundle-test-exact-key', summarize), /bundle-test-auth-rejection/);
  assert.deepEqual(received, ['Bearer bundle-test-ambient-key', 'Bearer bundle-test-exact-key']);
});

for (const failure of ['disallowed', 'closed', 'empty']) {
  test(`bundled summary fails closed for a ${failure} credential lease`, async (t) => {
    let acquisitions = 0;
    const scope = llm.createProviderCredentialLeaseScope({
      allowedProviders: [failure === 'disallowed' ? 'anthropic' : 'openai'],
      async acquire() { acquisitions += 1; return ''; },
    });
    if (failure === 'closed') scope.close();
    const originalFetch = globalThis.fetch;
    let wireRequests = 0;
    globalThis.fetch = async () => { wireRequests += 1; throw new Error('unexpected HTTP request'); };
    t.after(() => { globalThis.fetch = originalFetch; scope.close(); });
    await assert.rejects(llm.runWithProviderCredentialLeaseScope(scope, () => generateSummary(
      [], llm.resolveProvider('openai'), { readFiles: [], modifiedFiles: [] },
    )), failure === 'empty' ? /broker returned no credential/ : /does not allow|no longer active|inactive|closed/);
    assert.equal(acquisitions, failure === 'empty' ? 1 : 0);
    assert.equal(wireRequests, 0);
  });
}
