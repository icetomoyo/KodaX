import { validateCustomProviderConfig, type KodaXCloudCredential, type KodaXCustomProviderConfig } from '@kodax-ai/llm';

/** Explicit trusted-Main opt-in. The daemon never starts an ambient credential chain. */
export function createNativeCloudCredentialResolver(connection: KodaXCustomProviderConfig,
  environment: () => Readonly<Record<string, string | undefined>> = () => process.env): (signal: AbortSignal) => Promise<KodaXCloudCredential> {
  validateCustomProviderConfig(connection); connection = structuredClone(connection);
  if (!connection.cloud) throw new Error('Native cloud credential resolver requires cloud metadata.');
  let google: import('google-auth-library').GoogleAuth | undefined;
  let azure: import('@azure/identity').DefaultAzureCredential | undefined;
  let aws: ReturnType<typeof import('@aws-sdk/credential-provider-node').defaultProvider> | undefined;
  return async signal => {
    signal.throwIfAborted();
    try {
      const key = environment()[connection.apiKeyEnv];
      if (key?.trim()) return connection.cloud!.service === 'bedrock' ? { type: 'bearer', token: key } : { type: 'api-key', key };
      let credential: KodaXCloudCredential;
      switch (connection.cloud!.service) {
        case 'gemini': throw new Error('Gemini API key is unavailable.');
        case 'vertex': {
          if (connection.cloud!.service !== 'vertex' || !connection.cloud!.project) throw new Error('Vertex ADC requires project/location.');
          google ??= new (await import('google-auth-library')).GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
          const token = await google.getAccessToken();
          if (!token) throw new Error('Google access token is unavailable.');
          credential = { type: 'bearer', token }; break;
        }
        case 'azure': {
          azure ??= new (await import('@azure/identity')).DefaultAzureCredential();
          const token = await azure.getToken('https://cognitiveservices.azure.com/.default', { abortSignal: signal });
          if (!token) throw new Error('Entra access token is unavailable.');
          credential = { type: 'bearer', token: token.token, expiresAt: token.expiresOnTimestamp }; break;
        }
        case 'bedrock': {
          aws ??= (await import('@aws-sdk/credential-provider-node')).defaultProvider();
          const token = await aws();
          credential = { type: 'aws', accessKeyId: token.accessKeyId, secretAccessKey: token.secretAccessKey,
            ...(token.sessionToken ? { sessionToken: token.sessionToken } : {}), ...(token.expiration ? { expiresAt: token.expiration.getTime() } : {}) }; break;
        }
      }
      signal.throwIfAborted(); return credential;
    } catch { signal.throwIfAborted(); throw new Error('Native cloud credential acquisition failed. Configure the approved API key or the trusted Main cloud identity.'); }
  };
}
