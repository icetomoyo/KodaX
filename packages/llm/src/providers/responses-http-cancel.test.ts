import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import { createProviderCredentialLeaseScope, runWithProviderCredentialLeaseScope, withProviderRequestCredential } from '../provider-credential-context.js';

it.each(['cancel', 'revoke', 'disconnect'] as const)('Responses HTTP %s cannot return partial tools', async action => {
  const controller = new AbortController();
  let disconnect = (): void => { throw new Error('Stream not ready'); };
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'first' })}\n\n`);
      disconnect = () => response.destroy();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  const scope = createProviderCredentialLeaseScope({ allowedProviders: ['responses-http'], acquire: async () => 'lease-only' });
  vi.stubEnv('RESPONSES_HTTP_KEY', 'must-not-use');
  try {
    const provider = createCustomProvider({ name: 'responses-http', protocol: 'openai', api: 'responses', model: 'm',
      apiKeyEnv: 'RESPONSES_HTTP_KEY', baseUrl: `http://127.0.0.1:${address.port}/v1` });
    const operation = runWithProviderCredentialLeaseScope(scope, () => withProviderRequestCredential('responses-http', 'primary', controller.signal,
      signal => provider.stream([], [], '', undefined, { onTextDelta: () => {
        if (action === 'cancel') controller.abort();
        else if (action === 'revoke') scope.close();
        else disconnect();
      } }, signal)));
    if (action === 'disconnect') await expect(operation).rejects.not.toMatchObject({ name: 'AbortError' });
    else await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toBe(1);
  } finally {
    scope.close(); vi.unstubAllEnvs(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
