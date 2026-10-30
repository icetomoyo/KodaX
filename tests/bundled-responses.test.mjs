import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomProvider, runWithProviderCredential, reconcileAssistantContent,
  openOAuthSession, createOAuthRefreshDriver, createOAuthProviderConfig, createProviderCredentialLeaseScope,
  runWithProviderCredentialLeaseScope, withProviderRequestCredential } from '../dist/sdk-llm.js';
import { bindOAuthCredentials } from '../dist/sdk-runtime.js';

test('published SDK sends native Responses and replays ordered stateless output', async t => {
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://responses-bundle.test/v1/responses');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer bundle-scoped-key');
    requests.push(JSON.parse(init.body));
    return Response.json({ status: 'completed', output: [
      { id: 'm', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] },
      { id: 'rs', type: 'reasoning', summary: [], encrypted_content: 'cipher' },
    ] });
  };
  t.after(() => { globalThis.fetch = previous; });
  const provider = createCustomProvider({ name: 'responses-bundle', protocol: 'openai', api: 'responses',
    baseUrl: 'https://responses-bundle.test/v1', apiKeyEnv: 'UNUSED_BUNDLE_KEY', model: 'fixture' });
  await runWithProviderCredential('responses-bundle', 'bundle-scoped-key', async () => {
    const result = await provider.complete([{ role: 'user', content: 'task' }], [], 'rules');
    const content = reconcileAssistantContent(result.contentBlocks, result);
    assert.deepEqual(content.map(b => b.type), ['text', 'thinking']);
    await provider.complete([{ role: 'assistant', content }], [], 'rules');
  });
  assert.equal(requests[0].stream, false);
  assert.equal(requests[0].store, false);
  assert.equal(requests[1].input[1].encrypted_content, 'cipher');
});

test('published OAuth SDK refreshes in the host and supplies only request bearers through the existing broker', async t => {
  const previous = globalThis.fetch;
  const wire = [];
  globalThis.fetch = async (url, init) => {
    wire.push({ url: String(url), body: String(init.body) });
    if (String(url) === 'https://auth.openai.com/api/accounts/oauth/token') {
      return Response.json({ access_token: 'bundled-new-access', refresh_token: 'bundled-next-refresh', expires_in: 3600,
        scope: 'resource.invoke chatgpt.tokens.use.direct' });
    }
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer bundled-new-access');
    assert.equal(JSON.parse(init.body).stream, true);
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  };
  t.after(() => { globalThis.fetch = previous; });
  let record = { id: 'registration', service: 'openai-chatgpt', clientId: 'issued', accountId: 'verified',
    credentials: { accessToken: 'expired', refreshToken: 'bundled-old-refresh', expiresAt: 1 } };
  const store = { async transact(_id, operation) {
    const update = await operation(structuredClone(record)); record = update.record; return update.result;
  } };
  const session = await openOAuthSession({ id: record.id, store, driver: createOAuthRefreshDriver('openai-chatgpt') });
  const connection = createOAuthProviderConfig({ service: 'openai-chatgpt', name: 'bundle-oauth', model: 'fixture' });
  let broker;
  let revoked = false;
  const binding = await bindOAuthCredentials({ session, provider: connection, credentials: {
    async registerScoped(_input, callback) { broker = callback; return { id: 'lease', providers: [connection.name], brokerVersion: 2 }; },
    async revoke(id) { assert.equal(id, 'lease'); revoked = true; return true; },
  } });
  const scope = createProviderCredentialLeaseScope({ allowedProviders: [connection.name], acquire: async provider => broker({
    requestId: 'request', leaseId: 'lease', provider, sessionId: 'session', target: { kind: 'run', runId: 'run' }, purpose: 'primary',
  }) });
  t.after(() => scope.close());
  await runWithProviderCredentialLeaseScope(scope, () => withProviderRequestCredential(connection.name, 'primary', undefined,
    () => createCustomProvider(connection).complete([], [], '')));
  assert.equal(record.credentials.refreshToken, 'bundled-next-refresh');
  assert.equal(wire.length, 2);
  assert.ok(!wire[1].body.includes('refresh'));
  await binding.close();
  assert.equal(revoked, true);
});
