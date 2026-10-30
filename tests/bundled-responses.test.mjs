import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomProvider, runWithProviderCredential, reconcileAssistantContent } from '../dist/sdk-llm.js';

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
