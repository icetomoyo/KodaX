import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalAgentRegistration } from '@kodax-ai/agent';
import { createKodaXRuntime } from "../../tests/runtime-fixture.js";
import { writeIntegrationDocument } from '@kodax-ai/repl';
import {
  A2A_EXECUTOR_ID,
  createConfiguredA2ARuntimeIntegration,
  discoverA2ARegistration,
  parseA2AIntegrationDocument,
  type A2AIntegrationDocument,
} from './index.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-a2a-runtime-config-'));
  roots.push(root);
  return root;
}

function card(name: string, includeOAuth = false): Response {
  return new Response(JSON.stringify({
    name,
    description: `${name} description`,
    version: '1.0.0',
    supportedInterfaces: [{
      url: `https://127.0.0.1/${name.toLowerCase()}/a2a`,
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    }],
    capabilities: { streaming: false },
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'opaque' } },
      ...(includeOAuth ? {
        oauth: {
          oauth2SecurityScheme: {
            flows: {
              clientCredentials: {
                tokenUrl: 'https://127.0.0.1/oauth/token',
                scopes: { 'a2a.invoke': 'Invoke this Agent' },
              },
            },
          },
        },
      } : {}),
    },
    securityRequirements: [
      { schemes: { bearer: { list: [] } } },
      ...(includeOAuth ? [{ schemes: { oauth: { list: ['a2a.invoke'] } } }] : []),
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'general', name: 'General', description: 'General tasks', tags: [] }],
  }), { headers: { 'content-type': 'application/json' } });
}

function writeA2A(configHome: string, document: A2AIntegrationDocument): void {
  writeIntegrationDocument({
    domain: 'a2a',
    configHome,
    document,
    validate: parseA2AIntegrationDocument,
  });
}

function manualRegistration(
  agentId: string,
  overrides: Partial<ExternalAgentRegistration> = {},
): ExternalAgentRegistration {
  return {
    agentId,
    displayName: 'Manual Agent',
    description: 'Registered by an SDK embedder.',
    enabled: true,
    executorId: A2A_EXECUTOR_ID,
    protocol: 'a2a',
    configurationRevision: `manual-${agentId}`,
    endpointIdentityHash: `manual-endpoint-${agentId}`,
    executorConfig: { interfaceUrl: 'https://127.0.0.1/manual/a2a' },
    capabilities: {
      streaming: 'unsupported',
      durableTasks: 'supported',
      inputRequired: 'supported',
      cancellation: 'supported',
      artifacts: 'supported',
    },
    effects: { remote: 'read', workspace: 'proposal' },
    ...overrides,
  };
}

function persistedRegistrations(runtimeHome: string): readonly ExternalAgentRegistration[] {
  const file = path.join(runtimeHome, '.kodax', 'runtime', 'agents', 'registrations.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as readonly ExternalAgentRegistration[];
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('configured A2A Runtime integration', () => {

  it('exposes a defaultContext so agentExecutorPlane reaches tool contexts', () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    const integration = createConfiguredA2ARuntimeIntegration({ configHome });
    // Without defaultContext, the runtime leaves defaultAgentContext undefined,
    // which breaks the agentExecutorPlane injection into tool contexts —
    // list_dispatchable_agents and spawn_agent cannot see configured A2A agents.
    expect(integration.runtimeOptions.defaultContext).toBeDefined();
    expect(integration.runtimeOptions.defaultContext?.actorId).toBe('kodax-a2a-runtime-config-v1');
  });

  it('starts with no outbound agents when the A2A file is invalid and recovers after repair', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    const integrationDir = path.join(configHome, 'integrations');
    fs.mkdirSync(integrationDir, { recursive: true });
    fs.writeFileSync(path.join(integrationDir, 'a2a.json'), '{ broken', 'utf8');
    const observedEvents: string[] = [];
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      onEvent: (message) => observedEvents.push(message),
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: path.join(root, 'runtime-invalid-cold-start'),
      externalAgents: integration.runtimeOptions,
    });
    const handle = await integration.start(runtime);
    try {
      expect(handle.status()).toMatchObject({
        domain: 'a2a',
        source: 'user',
        diagnostic: { code: 'invalid-config' },
      });
      expect(await runtime.admin.agentRegistrations.list()).toEqual([]);
      expect(observedEvents).toContainEqual(expect.stringMatching(/a2a:.*invalid/i));

      writeA2A(configHome, {
        version: 2,
        agents: {
          repaired: {
            cardUrl: 'https://127.0.0.1/repaired/card',
            enabled: false,
            effect: 'read',
          },
        },
      });
      await handle.reload();
      expect(handle.status()).toMatchObject({ source: 'user' });
      expect(handle.status().diagnostic).toBeUndefined();
      expect(await runtime.admin.agentRegistrations.list()).toEqual([]);
    } finally {
      handle.close();
      await runtime.close();
    }
  });

  it('preserves bounded inline and remote artifact references without fetching remote URLs', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    const runtimeHome = path.join(root, 'runtime-artifacts');
    writeA2A(configHome, {
      version: 2,
      agents: {
        documents: {
          cardUrl: 'https://127.0.0.1/documents/card',
          enabled: true,
          effect: 'read',
        },
      },
    });
    const inline = Buffer.from('presentation-content', 'utf8').toString('base64');
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith('/card')) {
        return new Response(JSON.stringify({
          name: 'Document Agent',
          description: 'Creates documents and presentations.',
          version: '1.0.0',
          supportedInterfaces: [{
            url: 'https://127.0.0.1/documents/a2a',
            protocolBinding: 'JSONRPC',
            protocolVersion: '1.0',
          }],
          capabilities: { streaming: false },
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['application/pdf'],
          skills: [{ id: 'documents', name: 'Documents', description: 'Creates files.', tags: [] }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      const request = JSON.parse(String(init?.body)) as { readonly id: string };
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          message: {
            messageId: 'document-response',
            role: 'ROLE_AGENT',
            parts: [
              { raw: inline, filename: 'deck.pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
              { url: 'https://files.example/report.pdf', filename: 'report.pdf', mediaType: 'application/pdf' },
            ],
          },
        },
      }), { headers: { 'content-type': 'application/json' } });
    });
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: runtimeHome,
      externalAgents: integration.runtimeOptions,
    });
    const handle = await integration.start(runtime);
    try {
      const session = await runtime.sessions.create({
        sessionId: 'runtime-config-test', title: 'A2A artifact test',
      });
      const started = await runtime.agents.spawn(session.id, {
        taskName: 'documents',
        kind: 'external',
        objective: 'Create a presentation and report.',
        metadata: { agentId: 'external:documents' },
      });
      const deadline = Date.now() + 2_000;
      let completed = await runtime.agents.output(session.id, '/root/documents', started.turnId);
      while (completed.state === 'accepted' || completed.state === 'running') {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${started.turnId}.`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        completed = await runtime.agents.output(session.id, '/root/documents', started.turnId);
      }
      expect(completed).toMatchObject({
        state: 'completed',
        artifacts: [
          expect.stringContaining('data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,'),
          'https://files.example/report.pdf',
        ],
      });
      expect(fetchImpl.mock.calls.some(([called]) => String(called).includes('files.example'))).toBe(false);
    } finally {
      handle.close();
      await runtime.close();
    }
  });

  it('activates and dispatches an explicitly authorized private HTTP Agent', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    const runtimeHome = path.join(root, 'runtime-private-http');
    writeA2A(configHome, {
      version: 2,
      agents: {
        intranet: {
          cardUrl: 'http://10.20.30.40/card',
          enabled: true,
          network: {
            allowPrivateAddresses: true,
            allowInsecureHttp: true,
          },
          effect: 'read',
        },
      },
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/card') {
        return new Response(JSON.stringify({
          name: 'Intranet Agent',
          description: 'Runs on an explicitly trusted private HTTP endpoint.',
          version: '1.0.0',
          supportedInterfaces: [{
            url: `${url.origin}/a2a`,
            protocolBinding: 'JSONRPC',
            protocolVersion: '1.0',
          }],
          capabilities: { streaming: false },
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: [{ id: 'general', name: 'General', description: 'General tasks', tags: [] }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      const request = JSON.parse(String(init?.body)) as { readonly id: string };
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          message: {
            messageId: 'intranet-result',
            role: 'ROLE_AGENT',
            parts: [{ text: 'private HTTP completed', mediaType: 'text/plain' }],
          },
        },
      }), { headers: { 'content-type': 'application/json' } });
    });
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: runtimeHome,
      externalAgents: integration.runtimeOptions,
    });
    const handle = await integration.start(runtime);
    try {
      const listings = await runtime.agents.listDispatchable({ actorId: 'runtime-config-test' });
      expect(listings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          descriptor: expect.objectContaining({ agentId: 'external:intranet' }),
        }),
      ]));
      const registration = persistedRegistrations(runtimeHome)
        .find((entry) => entry.agentId === 'external:intranet');
      expect(registration?.executorConfig?.network).toEqual({
        allowPrivateAddresses: true,
        allowInsecureHttp: true,
      });

      const session = await runtime.sessions.create({
        sessionId: 'runtime-private-http', title: 'Private HTTP A2A',
      });
      const started = await runtime.agents.spawn(session.id, {
        taskName: 'intranet',
        kind: 'external',
        objective: 'Complete the private task.',
        metadata: { agentId: 'external:intranet' },
      });
      const deadline = Date.now() + 2_000;
      let completed = await runtime.agents.output(session.id, '/root/intranet', started.turnId);
      while (completed.state === 'accepted' || completed.state === 'running') {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${started.turnId}.`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        completed = await runtime.agents.output(session.id, '/root/intranet', started.turnId);
      }
      expect(completed).toMatchObject({
        state: 'completed',
        output: 'private HTTP completed',
      });

      const grantedRevision = registration?.configurationRevision;
      writeA2A(configHome, {
        version: 2,
        agents: {
          intranet: {
            cardUrl: 'http://127.0.0.1/card',
            enabled: true,
            network: {
              allowPrivateAddresses: true,
              allowInsecureHttp: true,
            },
            effect: 'read',
          },
        },
      });
      await handle.reload();
      const loopbackGranted = persistedRegistrations(runtimeHome)
        .find((entry) => entry.agentId === 'external:intranet');
      expect(loopbackGranted?.configurationRevision).not.toBe(grantedRevision);
      expect(loopbackGranted?.executorConfig?.network).toEqual({
        allowPrivateAddresses: true,
        allowInsecureHttp: true,
      });

      writeA2A(configHome, {
        version: 2,
        agents: {
          intranet: {
            cardUrl: 'http://127.0.0.1/card',
            enabled: true,
            effect: 'read',
          },
        },
      });
      await handle.reload();
      const revoked = persistedRegistrations(runtimeHome)
        .find((entry) => entry.agentId === 'external:intranet');
      expect(revoked?.configurationRevision).not.toBe(
        loopbackGranted?.configurationRevision,
      );
      expect(revoked?.executorConfig?.network).toEqual({
        allowPrivateAddresses: false,
        allowInsecureHttp: false,
      });
    } finally {
      handle.close();
      await runtime.close();
    }
  });

  it('preserves unrelated registrations and performs no discovery for disabled configuration', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    const runtimeHome = path.join(root, 'runtime-preserve');
    writeA2A(configHome, {
      version: 2,
      agents: {
        disabled: {
          cardUrl: 'https://127.0.0.1/disabled/card',
          enabled: false,
          credentialEnv: 'DISABLED_TOKEN',
          effect: 'read',
        },
      },
    });
    const fetchImpl = vi.fn(async () => card('unexpected'));
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: runtimeHome,
      externalAgents: integration.runtimeOptions,
    });
    await runtime.admin.agentRegistrations.upsert(manualRegistration('external:sdk-manual'));
    const handle = await integration.start(runtime);
    try {
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await runtime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({ agentId: 'external:sdk-manual', enabled: true }),
      ]);

      writeA2A(configHome, { version: 2, agents: {} });
      await handle.reload();
      expect(await runtime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({ agentId: 'external:sdk-manual', enabled: true }),
      ]);
    } finally {
      handle.close();
      await runtime.close();
    }
  });

  it('atomically claims a same-id disabled registration and removes it with the desired config', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    const runtimeHome = path.join(root, 'runtime-disabled-claim');
    writeA2A(configHome, {
      version: 2,
      agents: {
        claimed: {
          cardUrl: 'https://127.0.0.1/claimed/card',
          enabled: false,
          credentialEnv: 'CLAIMED_TOKEN',
          effect: 'read',
        },
      },
    });
    const fetchImpl = vi.fn(async () => card('unexpected'));
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: runtimeHome,
      externalAgents: integration.runtimeOptions,
    });
    const original = manualRegistration('external:claimed');
    await runtime.admin.agentRegistrations.upsert(original);
    const handle = await integration.start(runtime);
    try {
      expect(persistedRegistrations(runtimeHome)).toEqual([{
        ...original,
        enabled: false,
        managementOwner: 'kodax-a2a-runtime-config-v1',
      }]);
      expect(fetchImpl).not.toHaveBeenCalled();

      writeA2A(configHome, { version: 2, agents: {} });
      await handle.reload();
      expect(await runtime.admin.agentRegistrations.list()).toEqual([]);
    } finally {
      handle.close();
      await runtime.close();
    }
  });

  it('isolates another manager ownership conflict while reconciling unrelated agents', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    writeA2A(configHome, {
      version: 2,
      agents: {
        conflict: {
          cardUrl: 'https://127.0.0.1/conflict/card',
          enabled: false,
          credentialEnv: 'CONFLICT_TOKEN',
          effect: 'read',
        },
        peer: {
          cardUrl: 'https://127.0.0.1/peer/card',
          enabled: true,
          credentialEnv: 'PEER_TOKEN',
          effect: 'read',
        },
      },
    });
    const observedEvents: string[] = [];
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: vi.fn(async () => card('peer')) as typeof fetch,
      onEvent(message) {
        observedEvents.push(message);
        throw new Error('observer must not control reconciliation');
      },
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: path.join(root, 'runtime-owner-conflict'),
      externalAgents: integration.runtimeOptions,
    });
    await runtime.admin.agentRegistrations.upsert(manualRegistration('external:conflict', {
      managementOwner: 'sdk-host-manager',
    }));
    let handle: Awaited<ReturnType<typeof integration.start>> | undefined;
    try {
      handle = await integration.start(runtime);
      expect(await runtime.admin.agentRegistrations.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          agentId: 'external:conflict',
          enabled: true,
          managementOwner: 'sdk-host-manager',
        }),
        expect.objectContaining({
          agentId: 'external:peer',
          enabled: true,
          managementOwner: 'kodax-a2a-runtime-config-v1',
        }),
      ]));
      expect(observedEvents.join(' ')).toMatch(/external:conflict.*another manager/i);
    } finally {
      handle?.close();
      await runtime.close();
    }
  });

  it('does not remove or disable a concurrent same-id SDK replacement', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    writeA2A(configHome, {
      version: 2,
      agents: {
        removed: {
          cardUrl: 'https://127.0.0.1/removed/card',
          enabled: true,
          credentialEnv: 'REMOVED_TOKEN',
          effect: 'read',
        },
        disabled: {
          cardUrl: 'https://127.0.0.1/disabled/card',
          enabled: true,
          credentialEnv: 'DISABLED_TOKEN',
          effect: 'read',
        },
      },
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return card(url.pathname.split('/').filter(Boolean)[0] ?? 'agent');
    });
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const runtimeHome = path.join(root, 'runtime-owner-cas');
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: runtimeHome,
      externalAgents: integration.runtimeOptions,
    });
    const handle = await integration.start(runtime);
    try {
      writeA2A(configHome, {
        version: 2,
        agents: {
          disabled: {
            cardUrl: 'https://127.0.0.1/disabled/card',
            enabled: false,
            credentialEnv: 'DISABLED_TOKEN',
            effect: 'read',
          },
        },
      });
      const registrations = runtime.admin.agentRegistrations;
      const list = registrations.list;
      vi.spyOn(registrations, 'list').mockImplementationOnce(async () => {
        const snapshot = await list();
        const persisted = persistedRegistrations(runtimeHome);
        const removed = persisted.find((entry) => entry.agentId === 'external:removed')!;
        const disabled = persisted.find((entry) => entry.agentId === 'external:disabled')!;
        await registrations.upsert({
          ...removed,
          managementOwner: 'sdk-host-manager',
        });
        await registrations.upsert({
          ...disabled,
          managementOwner: 'sdk-host-manager',
        });
        return snapshot;
      });

      await handle.reload();
      expect(await registrations.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          agentId: 'external:removed',
          enabled: true,
          managementOwner: 'sdk-host-manager',
          configurationRevision: expect.stringMatching(/^kodax-a2a-config-v1:/),
        }),
        expect.objectContaining({
          agentId: 'external:disabled',
          enabled: true,
          managementOwner: 'sdk-host-manager',
          configurationRevision: expect.stringMatching(/^kodax-a2a-config-v1:/),
        }),
      ]));
    } finally {
      handle.close();
      await runtime.close();
    }
  });

  it('fences an unmarked same-id registration and claims it after successful migration', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    const runtimeHome = path.join(root, 'runtime-migrate');
    writeA2A(configHome, {
      version: 2,
      agents: {
        alpha: {
          cardUrl: 'https://127.0.0.1/alpha/card',
          enabled: true,
          credentialEnv: 'ALPHA_TOKEN',
          effect: 'read',
        },
      },
    });
    let available = false;
    const fetchImpl = vi.fn(async () => {
      if (!available) throw new Error('temporary migration failure');
      return card('alpha');
    });
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: runtimeHome,
      externalAgents: integration.runtimeOptions,
    });
    await runtime.admin.agentRegistrations.upsert(manualRegistration('external:alpha'));
    const handle = await integration.start(runtime);
    try {
      expect(await runtime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({
          agentId: 'external:alpha',
          enabled: false,
          managementOwner: 'kodax-a2a-runtime-config-v1',
          configurationRevision: 'manual-external:alpha',
        }),
      ]);
      expect(persistedRegistrations(runtimeHome)[0]?.executorConfig).toEqual(expect.objectContaining({
        interfaceUrl: 'https://127.0.0.1/manual/a2a',
      }));

      available = true;
      await handle.reload();
      expect(await runtime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({
          agentId: 'external:alpha',
          displayName: 'alpha',
          enabled: true,
          managementOwner: 'kodax-a2a-runtime-config-v1',
          configurationRevision: expect.stringMatching(/^kodax-a2a-config-v1:/),
        }),
      ]);
      expect(persistedRegistrations(runtimeHome)[0]?.managementOwner)
        .toBe('kodax-a2a-runtime-config-v1');
    } finally {
      handle.close();
      await runtime.close();
    }
  });

  it('persists a disabled fence before refreshing changed authority and retries safely', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    const runtimeHome = path.join(root, 'runtime-fence');
    const initial: A2AIntegrationDocument = {
      version: 2,
      agents: {
        authority: {
          cardUrl: 'https://127.0.0.1/authority/card',
          enabled: true,
          credentialEnv: 'OLD_TOKEN',
          effect: 'write',
        },
      },
    };
    const changed: A2AIntegrationDocument = {
      version: 2,
      agents: {
        authority: {
          cardUrl: 'https://127.0.0.1/authority/card',
          enabled: true,
          authentication: {
            type: 'oauth2-client-credentials',
            scheme: 'oauth',
            issuer: 'https://127.0.0.1',
            tokenUrl: 'https://127.0.0.1/oauth/token',
            clientId: 'kodax-runtime-test',
            clientSecretEnv: 'NEW_CLIENT_SECRET',
            scopes: ['a2a.invoke'],
            clientAuthentication: 'client-secret-basic',
          },
          effect: 'read',
        },
      },
    };
    writeA2A(configHome, initial);
    let available = true;
    const fetchImpl = vi.fn(async () => {
      if (!available) throw new Error('temporary authority refresh failure');
      return card('authority', true);
    });
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: runtimeHome,
      externalAgents: integration.runtimeOptions,
    });
    const handle = await integration.start(runtime);
    try {
      expect(await runtime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({ agentId: 'external:authority', enabled: true }),
      ]);

      available = false;
      writeA2A(configHome, changed);
      await handle.reload();
      expect(await runtime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({
          agentId: 'external:authority',
          enabled: false,
          effects: { remote: 'write', workspace: 'proposal' },
        }),
      ]);

      available = true;
      await handle.reload();
      expect(await runtime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({
          agentId: 'external:authority',
          enabled: true,
          effects: { remote: 'read', workspace: 'proposal' },
        }),
      ]);
      expect(persistedRegistrations(runtimeHome)[0]).toEqual(expect.objectContaining({
        credentialRef: 'env:NEW_CLIENT_SECRET',
        executorConfig: expect.objectContaining({
          authentication: expect.objectContaining({ type: 'oauth2-client-credentials' }),
        }),
      }));
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      handle.close();
      await runtime.close();
    }
  });

  it('refreshes changed enabled peers concurrently after applying disables', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    writeA2A(configHome, {
      version: 2,
      agents: {
        alpha: {
          cardUrl: 'https://127.0.0.1/alpha/card',
          enabled: true,
          credentialEnv: 'ALPHA_TOKEN',
          effect: 'read',
        },
      },
    });
    let releaseSlow: (() => void) | undefined;
    let signalSlowStarted: (() => void) | undefined;
    const slowStarted = new Promise<void>((resolve) => { signalSlowStarted = resolve; });
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.startsWith('/slow/')) {
        signalSlowStarted?.();
        await slowGate;
        return card('slow');
      }
      const name = url.pathname.split('/').filter(Boolean)[0] ?? 'agent';
      return card(name);
    });
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: path.join(root, 'runtime-concurrent'),
      externalAgents: integration.runtimeOptions,
    });
    const handle = await integration.start(runtime);
    try {
      writeA2A(configHome, {
        version: 2,
        agents: {
          alpha: {
            cardUrl: 'https://127.0.0.1/alpha/card',
            enabled: false,
            credentialEnv: 'ALPHA_TOKEN',
            effect: 'read',
          },
          slow: {
            cardUrl: 'https://127.0.0.1/slow/card',
            enabled: true,
            credentialEnv: 'SLOW_TOKEN',
            effect: 'read',
          },
          fast: {
            cardUrl: 'https://127.0.0.1/fast/card',
            enabled: true,
            credentialEnv: 'FAST_TOKEN',
            effect: 'none',
          },
        },
      });
      const reload = handle.reload();
      await slowStarted;
      await vi.waitFor(async () => {
        const entries = await runtime.admin.agentRegistrations.list();
        expect(entries).toEqual(expect.arrayContaining([
          expect.objectContaining({ agentId: 'external:alpha', enabled: false }),
          expect.objectContaining({ agentId: 'external:fast', enabled: true }),
        ]));
      });
      releaseSlow?.();
      await reload;
      expect(await runtime.admin.agentRegistrations.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentId: 'external:slow', enabled: true }),
        expect.objectContaining({ agentId: 'external:fast', enabled: true }),
      ]));
    } finally {
      releaseSlow?.();
      handle.close();
      await runtime.close();
    }
  });

  it('does not rediscover an unchanged enabled peer when another peer changes', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    const agent = (name: string, effect: 'none' | 'read') => ({
      cardUrl: `https://127.0.0.1/${name}/card`,
      enabled: true,
      credentialEnv: `${name.toUpperCase()}_TOKEN`,
      effect,
    }) as const;
    writeA2A(configHome, {
      version: 2,
      agents: { alpha: agent('alpha', 'read'), beta: agent('beta', 'none') },
    });
    const calls = new Map<string, number>();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const name = url.pathname.split('/').filter(Boolean)[0] ?? 'agent';
      calls.set(name, (calls.get(name) ?? 0) + 1);
      return card(name);
    });
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: path.join(root, 'runtime-peers'),
      externalAgents: integration.runtimeOptions,
    });
    const handle = await integration.start(runtime);
    try {
      writeA2A(configHome, {
        version: 2,
        agents: { alpha: agent('alpha', 'read'), beta: agent('beta', 'read') },
      });
      await handle.reload();
      expect(calls).toEqual(new Map([['alpha', 1], ['beta', 2]]));
    } finally {
      handle.close();
      await runtime.close();
    }
  });

  it('retains a same-config registration on transient startup refresh failure and still owns its removal', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    const runtimeHome = path.join(root, 'runtime-restart');
    writeA2A(configHome, {
      version: 2,
      agents: {
        durable: {
          cardUrl: 'https://127.0.0.1/durable/card',
          enabled: true,
          credentialEnv: 'DURABLE_TOKEN',
          effect: 'read',
        },
      },
    });
    let available = true;
    const fetchImpl = vi.fn(async () => {
      if (!available) throw new Error('temporary startup refresh outage');
      return card('durable');
    });

    const firstIntegration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const firstRuntime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: runtimeHome,
      externalAgents: firstIntegration.runtimeOptions,
    });
    const firstHandle = await firstIntegration.start(firstRuntime);
    firstHandle.close();
    await firstRuntime.close();

    available = false;
    const secondIntegration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const secondRuntime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: runtimeHome,
      externalAgents: secondIntegration.runtimeOptions,
    });
    const secondHandle = await secondIntegration.start(secondRuntime);
    try {
      expect(await secondRuntime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({ agentId: 'external:durable', enabled: true }),
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      writeA2A(configHome, { version: 2, agents: {} });
      await secondHandle.reload();
      expect(await secondRuntime.admin.agentRegistrations.list()).toEqual([]);
    } finally {
      secondHandle.close();
      await secondRuntime.close();
    }
  });

  it('preserves the complete persisted registration when disabling after Runtime restart', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    const runtimeHome = path.join(root, 'runtime-disable-restart');
    const enabled: A2AIntegrationDocument = {
      version: 2,
      agents: {
        durable: {
          cardUrl: 'https://127.0.0.1/durable/card',
          enabled: true,
          credentialEnv: 'DURABLE_TOKEN',
          effect: 'read',
        },
      },
    };
    writeA2A(configHome, enabled);
    const fetchImpl = vi.fn(async () => card('durable'));
    const firstIntegration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const firstRuntime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: runtimeHome,
      externalAgents: firstIntegration.runtimeOptions,
    });
    const firstHandle = await firstIntegration.start(firstRuntime);
    const completeRegistration = persistedRegistrations(runtimeHome)[0];
    expect(completeRegistration).toBeDefined();
    firstHandle.close();
    await firstRuntime.close();

    writeA2A(configHome, {
      version: 2,
      agents: { durable: { ...enabled.agents.durable!, enabled: false } },
    });
    const secondIntegration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const secondRuntime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: runtimeHome,
      externalAgents: secondIntegration.runtimeOptions,
    });
    const secondHandle = await secondIntegration.start(secondRuntime);
    try {
      expect(persistedRegistrations(runtimeHome)).toEqual([
        { ...completeRegistration!, enabled: false },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      secondHandle.close();
      await secondRuntime.close();
    }
  });

  it('rejects same-revision route drift and repairs changed-revision live drift', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    const runtimeHome = path.join(root, 'runtime-owned-drift');
    writeA2A(configHome, {
      version: 2,
      agents: {
        owned: {
          cardUrl: 'https://127.0.0.1/owned/card',
          enabled: true,
          credentialEnv: 'OWNED_TOKEN',
          effect: 'read',
        },
      },
    });
    const fetchImpl = vi.fn(async () => card('owned'));
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: runtimeHome,
      externalAgents: integration.runtimeOptions,
    });
    const handle = await integration.start(runtime);
    try {
      const expected = persistedRegistrations(runtimeHome)[0]!;
      await expect(runtime.admin.agentRegistrations.upsert({
        ...expected,
        displayName: 'Endpoint Drift',
        endpointIdentityHash: 'sha256:drifted-endpoint',
      })).rejects.toThrow(/revision.*reused/i);

      await runtime.admin.agentRegistrations.upsert({
        ...expected,
        displayName: 'Revision Drift',
        configurationRevision: `${expected.configurationRevision}-drift`,
        endpointIdentityHash: 'sha256:drifted-endpoint',
      });
      await handle.reload();
      expect(await runtime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({
          displayName: 'owned',
          configurationRevision: expected.configurationRevision,
          endpointIdentityHash: expected.endpointIdentityHash,
        }),
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      handle.close();
      await runtime.close();
    }
  });

  it('repairs a missing live registration on same-revision manual reload', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    writeA2A(configHome, {
      version: 2,
      agents: {
        repair: {
          cardUrl: 'https://127.0.0.1/repair/card',
          enabled: true,
          credentialEnv: 'REPAIR_TOKEN',
          effect: 'read',
        },
      },
    });
    const fetchImpl = vi.fn(async () => card('repair'));
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: path.join(root, 'runtime-live-repair'),
      externalAgents: integration.runtimeOptions,
    });
    const handle = await integration.start(runtime);
    try {
      await runtime.admin.agentRegistrations.remove('external:repair');
      expect(await runtime.admin.agentRegistrations.list()).toEqual([]);

      await handle.reload();
      expect(await runtime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({ agentId: 'external:repair', enabled: true }),
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      handle.close();
      await runtime.close();
    }
  });

  it('does not report a hot reload when the A2A revision is unchanged', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    writeA2A(configHome, { version: 2, agents: {} });
    const events: string[] = [];
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      onEvent: (message) => events.push(message),
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: path.join(root, 'runtime-revision-notice'),
      externalAgents: integration.runtimeOptions,
    });
    const handle = await integration.start(runtime);
    try {
      await handle.reload();
      expect(events.filter((message) => message.includes('hot-reloaded'))).toEqual([]);

      writeA2A(configHome, {
        version: 2,
        agents: {
          disabled: {
            cardUrl: 'https://127.0.0.1/disabled/card',
            enabled: false,
            effect: 'none',
          },
        },
      });
      await handle.reload();
      expect(events.filter((message) => message.includes('hot-reloaded'))).toEqual([
        'A2A configuration hot-reloaded (0 enabled outbound Agents).',
      ]);
    } finally {
      handle.close();
      await runtime.close();
    }
  });

  it('registers configured Agents and reconciles add, failure, and removal without restart', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    const runtimeHome = path.join(root, 'runtime');
    const documents: A2AIntegrationDocument[] = [{
      version: 2,
      agents: {
        alpha: { cardUrl: 'https://127.0.0.1/alpha/card', enabled: true, credentialEnv: 'ALPHA_TOKEN', effect: 'read' },
      },
    }, {
      version: 2,
      agents: {
        alpha: { cardUrl: 'https://127.0.0.1/broken/card', enabled: true, credentialEnv: 'ALPHA_TOKEN', effect: 'write' },
        beta: { cardUrl: 'https://127.0.0.1/beta/card', enabled: true, credentialEnv: 'BETA_TOKEN', effect: 'none' },
      },
    }, {
      version: 2,
      agents: { beta: { cardUrl: 'https://127.0.0.1/beta/card', enabled: false, credentialEnv: 'BETA_TOKEN', effect: 'none' } },
    }, {
      version: 2,
      agents: { beta: { cardUrl: 'https://127.0.0.1/beta/card', enabled: true, credentialEnv: 'BETA_TOKEN', effect: 'none' } },
    }, {
      version: 2,
      agents: {},
    }];
    writeA2A(configHome, documents[0]);
    const events: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const name = url.pathname.split('/').filter(Boolean)[0] ?? 'agent';
      if (name === 'broken') throw new Error('secret upstream detail');
      return card(name);
    });
    await expect(discoverA2ARegistration({
      agentId: 'probe',
      agentCardUrl: 'https://127.0.0.1/alpha/card',
      credentialRef: 'env:ALPHA_TOKEN',
      effects: { remote: 'read' },
    }, {
      networkPolicy: {
        allowedOrigins: ['https://127.0.0.1'],
        allowPrivateAddresses: true,
        requestTimeoutMs: 1_000,
        maxResponseBytes: 1_000_000,
        maxRedirects: 0,
      },
      pollIntervalMs: 100,
      fetch: fetchImpl as typeof fetch,
    })).resolves.toEqual(expect.objectContaining({ registration: expect.objectContaining({ agentId: 'probe' }) }));
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
      onEvent: (message) => events.push(message),
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: runtimeHome,
      externalAgents: integration.runtimeOptions,
    });
    const handle = await integration.start(runtime);
    try {
      expect(await runtime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({ agentId: 'external:alpha', credentialConfigured: true }),
      ]);

      writeA2A(configHome, documents[1]);
      await handle.reload();
      const afterFailure = await runtime.admin.agentRegistrations.list();
      expect(afterFailure.map((entry) => entry.agentId).sort()).toEqual(['external:alpha', 'external:beta']);
      expect(afterFailure.find((entry) => entry.agentId === 'external:alpha'))
        .toEqual(expect.objectContaining({ displayName: 'alpha' }));
      expect(events.some((message) => message.includes('alpha') && !message.includes('secret upstream detail'))).toBe(true);

      const fetchesBeforeDisable = fetchImpl.mock.calls.length;
      writeA2A(configHome, documents[2]);
      await handle.reload();
      expect(fetchImpl).toHaveBeenCalledTimes(fetchesBeforeDisable);
      expect(await runtime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({ agentId: 'external:beta', enabled: false }),
      ]);

      writeA2A(configHome, documents[3]);
      await handle.reload();
      expect(await runtime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({ agentId: 'external:beta', enabled: true }),
      ]);

      writeA2A(configHome, documents[4]);
      await handle.reload();
      expect(await runtime.admin.agentRegistrations.list()).toEqual([]);
    } finally {
      handle.close();
      await runtime.close();
    }
  });

  it('retries a failed enabled entry on manual reload without rewriting the file', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    writeA2A(configHome, {
      version: 2,
      agents: {
        retry: {
          cardUrl: 'https://127.0.0.1/retry/card',
          enabled: true,
          credentialEnv: 'RETRY_TOKEN',
          effect: 'read',
        },
      },
    });
    let available = false;
    const fetchImpl = vi.fn(async () => {
      if (!available) throw new Error('temporary upstream outage');
      return card('retry');
    });
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: path.join(root, 'runtime-retry'),
      externalAgents: integration.runtimeOptions,
    });
    const handle = await integration.start(runtime);
    try {
      expect(await runtime.admin.agentRegistrations.list()).toEqual([]);
      available = true;
      await handle.reload();
      expect(await runtime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({ agentId: 'external:retry', enabled: true }),
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      handle.close();
      await runtime.close();
    }
  });
});
