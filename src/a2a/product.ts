import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { KodaXRuntime } from '../sdk-runtime.js';
import type { A2ABearerAuthenticationConfig, A2AServerConfig } from './config.js';
import { createOAuth2JwtA2AAuthentication } from './server-auth.js';
import type {
  A2AAuthentication,
  A2AServerHotOptions,
  A2AServerOptions,
} from './types.js';

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer ([^\s]+)$/i.exec(header) : null;
  return match?.[1];
}

function equalSecret(left: string, right: string): boolean {
  const expected = Buffer.from(left);
  const actual = Buffer.from(right);
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

export function createBearerEnvA2AAuthentication(
  config: A2ABearerAuthenticationConfig,
  env: NodeJS.ProcessEnv = process.env,
): A2AAuthentication {
  const expected = env[config.tokenEnv];
  if (!expected) throw new Error(`A2A bearer token environment variable is unset: ${config.tokenEnv}.`);
  return {
    securityRealm: `bearer-env:${config.tokenEnv}`,
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'opaque' } },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    async authenticate(request) {
      const actual = bearerToken(request);
      return actual && equalSecret(expected, actual)
        ? { subject: config.principalId, scopes: ['a2a:invoke'] }
        : null;
    },
  };
}

function createConfiguredAuthentication(
  config: A2AServerConfig['authentication'],
  env: NodeJS.ProcessEnv | undefined,
  hostAuthentication: A2AAuthentication | undefined,
): A2AAuthentication {
  if (config.type === 'bearer-env') return createBearerEnvA2AAuthentication(config, env);
  if (config.type === 'oauth2-jwt') return createOAuth2JwtA2AAuthentication(config);
  if (hostAuthentication === undefined) {
    throw new Error('A2A host authentication is served only by a Host listening on the network; run `kodax host serve`.');
  }
  return hostAuthentication;
}

function publishedAgent(config: A2AServerConfig, baseUrl: string) {
  return {
    name: config.published.name,
    description: config.published.description,
    version: config.published.version,
    publicBaseUrl: config.publicBaseUrl ?? baseUrl,
    skills: config.published.skills,
    inputModes: config.published.inputModes,
    outputModes: config.published.outputModes,
    ...(config.execution.profileId ? { profileId: config.execution.profileId } : {}),
  };
}

function authorization(): Promise<boolean> {
  return Promise.resolve(true);
}

export function createA2AServerOptionsFromConfig(input: {
  readonly runtime: KodaXRuntime;
  readonly config: A2AServerConfig;
  readonly listenBaseUrl: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The check the Host's port gives, for a declaration whose authentication is `host`. */
  readonly hostAuthentication?: A2AAuthentication;
}): A2AServerOptions {
  return {
    runtime: input.runtime,
    agent: publishedAgent(input.config, input.listenBaseUrl),
    execution: input.config.execution,
    dataDir: expandHome(input.config.dataDir),
    limits: input.config.limits,
    authentication: createConfiguredAuthentication(input.config.authentication, input.env, input.hostAuthentication),
    authorize: authorization,
  };
}

export function createA2AServerHotOptions(input: {
  readonly config: A2AServerConfig;
  readonly listenBaseUrl: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly hostAuthentication?: A2AAuthentication;
}): A2AServerHotOptions {
  return {
    agent: publishedAgent(input.config, input.listenBaseUrl),
    limits: input.config.limits,
    authentication: createConfiguredAuthentication(input.config.authentication, input.env, input.hostAuthentication),
    authorize: authorization,
  };
}
