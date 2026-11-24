import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { KodaXRuntime } from '../sdk-runtime.js';
import { parseA2AIntegrationDocument } from './config.js';
import { createHostA2AMount } from './host-mount.js';
import {
  createA2AServerHotOptions,
  createA2AServerOptionsFromConfig,
  createBearerEnvA2AAuthentication,
} from './product.js';

describe('FEATURE_267 A2A product authentication', () => {
  it('loads bearer secrets only from the named environment variable', async () => {
    const authentication = createBearerEnvA2AAuthentication({
      type: 'bearer-env', tokenEnv: 'TEST_A2A_TOKEN', principalId: 'partner',
    }, { TEST_A2A_TOKEN: 'secret-token' });

    await expect(authentication.authenticate(new Request('https://agent.example', {
      headers: { authorization: 'Bearer secret-token' },
    }))).resolves.toEqual({ subject: 'partner', scopes: ['a2a:invoke'] });
    await expect(authentication.authenticate(new Request('https://agent.example', {
      headers: { authorization: 'Bearer wrong-token' },
    }))).resolves.toBeNull();
    expect(authentication.securityRealm).toBe('bearer-env:TEST_A2A_TOKEN');
    expect(authentication.securitySchemes).toEqual({
      bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'opaque' } },
    });
    expect(authentication.securityRequirements).toEqual([
      { schemes: { bearer: { list: [] } } },
    ]);
  });

  it('fails before serving when the configured secret is absent', () => {
    expect(() => createBearerEnvA2AAuthentication({
      type: 'bearer-env', tokenEnv: 'MISSING_A2A_TOKEN', principalId: 'partner',
    }, {})).toThrow(/unset.*MISSING_A2A_TOKEN/i);
  });

  it('serves a declaration the Host checks only inside the Host, with the check its mount gives', () => {
    const listenBaseUrl = 'https://agent.example.test';
    const config = parseA2AIntegrationDocument({
      version: 2,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: {
          name: 'General Agent', description: 'General tasks', version: '0.7.97',
          skills: [], inputModes: ['text/plain'], outputModes: ['text/plain'],
        },
        publicBaseUrl: listenBaseUrl,
        authentication: { type: 'host' },
        dataDir: '~/.kodax/a2a/tasks',
      },
    }).server!;
    const runtime = {} as KodaXRuntime;
    expect(() => createA2AServerOptionsFromConfig({ runtime, config, listenBaseUrl })).toThrow(/Host/);
    const hostAuthentication = createHostA2AMount().authentication;
    expect(createA2AServerOptionsFromConfig({ runtime, config, listenBaseUrl, hostAuthentication }).authentication)
      .toBe(hostAuthentication);
    expect(createA2AServerHotOptions({ config, listenBaseUrl, hostAuthentication }).authentication).toBe(hostAuthentication);
  });

  it('maps one validated declaration into initial and hot server options', async () => {
    const config = parseA2AIntegrationDocument({
      version: 1,
      agents: {},
      server: {
        execution: { kind: 'runtime-default', profileId: 'a2a/general' },
        published: {
          name: 'General Agent', description: 'General tasks', version: '0.7.69',
          skills: [{ id: 'general', name: 'General', description: 'General tasks', tags: [] }],
          inputModes: ['text/plain'], outputModes: ['text/plain'],
        },
        authentication: {
          type: 'bearer-env', tokenEnv: 'TEST_A2A_TOKEN', principalId: 'partner',
        },
        dataDir: '~/.kodax/a2a/tasks',
      },
    }).server!;
    const runtime = {} as KodaXRuntime;
    const initial = createA2AServerOptionsFromConfig({
      runtime,
      config,
      listenBaseUrl: 'http://127.0.0.1:8765',
      env: { TEST_A2A_TOKEN: 'secret-token' },
    });
    const hot = createA2AServerHotOptions({
      config,
      listenBaseUrl: 'http://127.0.0.1:8765',
      env: { TEST_A2A_TOKEN: 'secret-token' },
    });

    expect(initial.runtime).toBe(runtime);
    expect(initial.dataDir).toBe(path.join(os.homedir(), '.kodax', 'a2a', 'tasks'));
    expect(initial.agent).toMatchObject({
      name: 'General Agent', publicBaseUrl: 'http://127.0.0.1:8765', profileId: 'a2a/general',
    });
    expect(hot.agent).toEqual(initial.agent);
    await expect(initial.authorize({
      principal: { subject: 'partner', scopes: [] },
      operation: 'send-message',
    })).resolves.toBe(true);
    await expect(hot.authentication.authenticate(new Request('https://agent.example')))
      .resolves.toBeNull();
  });

  it('wires the external OAuth2 JWT resource-server profile into initial and hot options', async () => {
    const config = parseA2AIntegrationDocument({
      version: 2,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: {
          name: 'OAuth Agent', description: 'OAuth tasks', version: '0.7.69',
          skills: [{ id: 'general', name: 'General', description: 'General tasks', tags: [] }],
          inputModes: ['text/plain'], outputModes: ['text/plain'],
        },
        authentication: {
          type: 'oauth2-jwt',
          scheme: 'enterprise-oauth',
          issuer: 'https://identity.example.com/',
          audience: 'https://agent.example.com/a2a',
          jwksUrl: 'https://identity.example.com/jwks',
          tokenUrl: 'https://identity.example.com/token',
          requiredScopes: ['a2a.invoke'],
        },
        dataDir: '~/.kodax/a2a/tasks',
      },
    }).server!;
    const runtime = {} as KodaXRuntime;
    const initial = createA2AServerOptionsFromConfig({
      runtime, config, listenBaseUrl: 'http://127.0.0.1:8765',
    });
    const hot = createA2AServerHotOptions({
      config, listenBaseUrl: 'http://127.0.0.1:8765',
    });

    expect(initial.authentication.securitySchemes).toEqual(hot.authentication.securitySchemes);
    expect(initial.authentication.securityRealm)
      .toBe('oauth2-jwt:https://identity.example.com/');
    expect(initial.authentication.securityRequirements).toEqual([
      { schemes: { 'enterprise-oauth': { list: ['a2a.invoke'] } } },
    ]);
    await expect(initial.authentication.authenticate(new Request('https://agent.example/a2a')))
      .resolves.toBeNull();
  });
});
