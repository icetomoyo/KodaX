import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyA2AServerChange,
  migrateA2AIntegrationV1,
  parseA2AIntegrationDocument,
  readA2AIntegration,
  removeA2AOutboundAgent,
  setA2AOutboundAgentEnabled,
  setA2AServerConfig,
  upsertA2AOutboundAgent,
} from './config.js';

let configHome: string;

beforeEach(() => {
  configHome = mkdtempSync(path.join(tmpdir(), 'kodax-a2a-config-'));
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
});

function published() {
  return {
    name: 'KodaX Agent',
    description: 'Completes approved general tasks.',
    version: '0.7.69',
    skills: [{
      id: 'general',
      name: 'General',
      description: 'Complete general tasks.',
      tags: [],
    }],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
  } as const;
}

function authentication() {
  return {
    type: 'bearer-env',
    tokenEnv: 'KODAX_A2A_TOKEN',
    principalId: 'configured-client',
  } as const;
}

describe('FEATURE_267/268 A2A integration config', () => {
  it('materializes safe managed-workspace defaults', () => {
    const parsed = parseA2AIntegrationDocument({
      version: 2,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        authentication: authentication(),
        dataDir: '~/.kodax/a2a/tasks',
      },
    });
    expect(parsed.server?.execution.workspace).toEqual({ mode: 'managed' });
    expect(parsed.server?.execution.toolPolicy).toEqual({
      workspace: 'write',
      process: 'deny',
      network: { mode: 'deny' },
      tools: [],
      mcp: {},
      skillScripts: {},
      subagents: 'deny',
    });
    expect(parsed.server?.limits.maxConcurrentTasks).toBe(4);
    expect(parsed.server?.limits.maxTaskWaitMs).toBe(30_000);
  });

  it('rejects partial policy, wildcard authority, and process/script mismatches', () => {
    const base = {
      version: 2,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        authentication: authentication(),
        dataDir: '~/.kodax/a2a/tasks',
      },
    };
    expect(() => parseA2AIntegrationDocument({
      ...base,
      server: {
        ...base.server,
        execution: { kind: 'runtime-default', toolPolicy: { workspace: 'read' } },
      },
    })).toThrow(/toolPolicy/i);
    expect(() => parseA2AIntegrationDocument({
      ...base,
      server: {
        ...base.server,
        execution: {
          kind: 'runtime-default',
          toolPolicy: {
            workspace: 'write', process: 'deny', network: { mode: 'deny' },
            tools: ['*'], mcp: {}, skillScripts: {}, subagents: 'deny',
          },
        },
      },
    })).toThrow(/wildcard/i);
    expect(() => parseA2AIntegrationDocument({
      ...base,
      server: {
        ...base.server,
        execution: {
          kind: 'runtime-default',
          toolPolicy: {
            workspace: 'write', process: 'isolated', network: { mode: 'deny' },
            tools: [], mcp: {}, skillScripts: {}, subagents: 'deny',
          },
        },
      },
    })).toThrow(/skillScripts/i);
  });

  it('admits exact hostTools and rejects duplicates, wildcards, and invalid names', () => {
    const document = (hostTools: unknown) => parseA2AIntegrationDocument({
      version: 2,
      agents: {},
      server: {
        execution: {
          kind: 'runtime-default',
          toolPolicy: {
            workspace: 'write', process: 'deny', network: { mode: 'deny' },
            tools: [], mcp: {}, skillScripts: {}, subagents: 'deny',
            ...(hostTools === undefined ? {} : { hostTools }),
          },
        },
        published: published(),
        authentication: authentication(),
        dataDir: '~/.kodax/a2a/tasks',
      },
    });
    expect(document(['host_search', 'host_write']).server?.execution.toolPolicy.hostTools)
      .toEqual(['host_search', 'host_write']);
    expect(document(undefined).server?.execution.toolPolicy.hostTools).toBeUndefined();
    expect(() => document(['host_search', 'host_search'])).toThrow(/duplicates/i);
    expect(() => document(['*'])).toThrow(/wildcard/i);
    expect(() => document(['1host'])).toThrow(/valid host tool names/i);
  });

  it('rejects credentials embedded in outbound and public A2A URLs', () => {
    expect(() => parseA2AIntegrationDocument({
      version: 2,
      agents: {
        reporting: {
          cardUrl: 'https://user:secret@agents.example.com/.well-known/agent-card.json',
          effect: 'read',
        },
      },
    })).toThrow(/embedded credentials/i);
    expect(() => parseA2AIntegrationDocument({
      version: 2,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        publicBaseUrl: 'https://user:secret@agents.example.com',
        authentication: authentication(),
        dataDir: '~/.kodax/a2a/tasks',
      },
    })).toThrow(/embedded credentials/i);
  });

  it('accepts IPv6 loopback HTTP and rejects endpoint fragments before activation', () => {
    const parsed = parseA2AIntegrationDocument({
      version: 2,
      agents: {
        local: { cardUrl: 'http://[::1]:8765/card', effect: 'none' },
      },
    });
    expect(parsed.agents.local?.cardUrl).toBe('http://[::1]:8765/card');

    expect(() => parseA2AIntegrationDocument({
      version: 2,
      agents: {
        invalid: {
          cardUrl: 'https://agents.example.com/card',
          effect: 'read',
          authentication: {
            type: 'oauth2-client-credentials',
            scheme: 'oauth',
            issuer: 'https://identity.example.com',
            tokenUrl: 'https://identity.example.com/token#fragment',
            clientId: 'kodax',
            clientSecretEnv: 'CLIENT_SECRET',
            scopes: [],
          },
        },
      },
    })).toThrow(/fragment/i);
  });

  it('requires explicit persisted authorization for non-loopback HTTP agents', () => {
    expect(() => parseA2AIntegrationDocument({
      version: 2,
      agents: {
        intranet: {
          cardUrl: 'http://10.20.30.40/agent-card.json',
          effect: 'read',
        },
      },
    })).toThrow(/HTTPS|loopback/i);

    const parsed = parseA2AIntegrationDocument({
      version: 2,
      agents: {
        intranet: {
          cardUrl: 'http://10.20.30.40/agent-card.json',
          network: {
            allowPrivateAddresses: true,
            allowInsecureHttp: true,
          },
          effect: 'read',
        },
      },
    });
    expect(parsed.agents.intranet?.network).toEqual({
      allowPrivateAddresses: true,
      allowInsecureHttp: true,
    });
  });

  it('strictly validates persisted outbound network authorization', () => {
    const agent = (network: unknown) => ({
      version: 2,
      agents: {
        invalid: {
          cardUrl: 'https://agent.example/card',
          network,
          effect: 'read',
        },
      },
    });
    expect(() => parseA2AIntegrationDocument(agent({
      allowPrivateAddresses: 'yes',
      allowInsecureHttp: false,
    }))).toThrow(/allowPrivateAddresses.*boolean/i);
    expect(() => parseA2AIntegrationDocument(agent({
      allowPrivateAddresses: false,
      allowInsecureHttp: false,
      wildcard: true,
    }))).toThrow(/unknown field/i);

    expect(() => parseA2AIntegrationDocument({
      version: 2,
      agents: {
        oauth: {
          cardUrl: 'http://10.20.30.40/card',
          network: {
            allowPrivateAddresses: true,
            allowInsecureHttp: true,
          },
          authentication: {
            type: 'oauth2-client-credentials',
            scheme: 'oauth',
            issuer: 'https://identity.example.com',
            tokenUrl: 'http://10.20.30.41/token',
            clientId: 'kodax',
            clientSecretEnv: 'CLIENT_SECRET',
            scopes: [],
          },
          effect: 'read',
        },
      },
    })).toThrow(/tokenUrl.*HTTPS|HTTPS.*tokenUrl/i);
  });

  it('applies the shared OAuth URI rules while preserving exact issuer and resource strings', () => {
    const oauthAuthentication = (overrides: Readonly<Record<string, unknown>> = {}) => ({
      type: 'oauth2-client-credentials',
      scheme: 'oauth',
      issuer: 'https://identity.example.com',
      tokenUrl: 'https://identity.example.com/token',
      clientId: 'kodax',
      clientSecretEnv: 'CLIENT_SECRET',
      scopes: [],
      ...overrides,
    });
    const outbound = (overrides: Readonly<Record<string, unknown>>) => parseA2AIntegrationDocument({
      version: 2,
      agents: {
        remote: {
          cardUrl: 'https://agent.example.com/.well-known/agent-card.json',
          effect: 'read',
          authentication: oauthAuthentication(overrides),
        },
      },
    });

    const parsed = outbound({
      issuer: '  https://identity.example.com  ',
      tokenUrl: 'https://identity.example.com/token?tenant=one',
      resource: ' urn:example:a2a:agent ',
    });
    expect(parsed.agents.remote?.authentication).toMatchObject({
      issuer: 'https://identity.example.com',
      tokenUrl: 'https://identity.example.com/token?tenant=one',
      resource: 'urn:example:a2a:agent',
    });

    expect(() => outbound({ issuer: 'https://identity.example.com?' })).toThrow(/issuer/i);
    expect(() => outbound({ tokenUrl: 'https://@identity.example.com/token' })).toThrow(/tokenUrl/i);
    expect(() => outbound({ resource: 'urn:example:a2a#' })).toThrow(/resource/i);

    expect(() => parseA2AIntegrationDocument({
      version: 2,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        authentication: {
          type: 'oauth2-jwt',
          scheme: 'oauth',
          issuer: 'https://identity.example.com',
          audience: 'https://agent.example.com',
          jwksUrl: 'https://identity.example.com/jwks',
          tokenUrl: 'https://identity.example.com/token',
          metadataUrl: 'https://identity.example.com/metadata#',
          requiredScopes: [],
        },
        dataDir: '~/.kodax/a2a/tasks',
      },
    })).toThrow(/metadataUrl/i);
  });

  it('parses explicit activation and OAuth2 client credentials without storing secrets', () => {
    const parsed = parseA2AIntegrationDocument({
      version: 2,
      agents: {
        reporting: {
          cardUrl: 'https://agents.example.com/.well-known/agent-card.json',
          enabled: false,
          effect: 'read',
          authentication: {
            type: 'oauth2-client-credentials',
            scheme: 'enterprise-oauth',
            issuer: 'https://identity.example.com',
            tokenUrl: 'https://identity.example.com/oauth/token',
            clientId: 'kodax-reporting',
            clientSecretEnv: 'REPORTING_CLIENT_SECRET',
            scopes: ['a2a.invoke'],
            resource: 'https://agents.example.com/',
            clientAuthentication: 'client-secret-basic',
          },
        },
      },
    });

    expect(parsed.agents.reporting).toEqual({
      cardUrl: 'https://agents.example.com/.well-known/agent-card.json',
      enabled: false,
      effect: 'read',
      authentication: {
        type: 'oauth2-client-credentials',
        scheme: 'enterprise-oauth',
        issuer: 'https://identity.example.com',
        tokenUrl: 'https://identity.example.com/oauth/token',
        clientId: 'kodax-reporting',
        clientSecretEnv: 'REPORTING_CLIENT_SECRET',
        scopes: ['a2a.invoke'],
        resource: 'https://agents.example.com/',
        clientAuthentication: 'client-secret-basic',
      },
    });
    expect(JSON.stringify(parsed)).not.toContain('client-secret-value');
  });

  it('defaults legacy outbound entries to enabled and rejects ambiguous authentication', () => {
    const parsed = parseA2AIntegrationDocument({
      version: 1,
      agents: {
        legacy: {
          cardUrl: 'https://agents.example.com/.well-known/agent-card.json',
          credentialEnv: 'LEGACY_A2A_TOKEN',
          effect: 'read',
        },
      },
    });
    expect(parsed.version).toBe(2);
    expect(parsed.agents.legacy?.enabled).toBe(true);

    expect(() => parseA2AIntegrationDocument({
      version: 1,
      agents: {
        invalidModernEntry: {
          cardUrl: 'https://agents.example.com/.well-known/agent-card.json',
          enabled: false,
          effect: 'read',
        },
      },
    })).toThrow(/enabled/i);

    expect(() => parseA2AIntegrationDocument({
      version: 2,
      agents: {
        ambiguous: {
          cardUrl: 'https://agents.example.com/.well-known/agent-card.json',
          enabled: true,
          credentialEnv: 'LEGACY_A2A_TOKEN',
          authentication: {
            type: 'oauth2-client-credentials',
            scheme: 'oauth',
            issuer: 'https://identity.example.com/',
            tokenUrl: 'https://identity.example.com/token',
            clientId: 'kodax',
            clientSecretEnv: 'CLIENT_SECRET',
            scopes: ['a2a.invoke'],
          },
          effect: 'read',
        },
      },
    })).toThrow(/credentialEnv.*authentication/i);
  });

  it('fails closed on ordinary mutations of a non-empty v1 file until explicit migration', () => {
    const file = path.join(configHome, 'integrations', 'a2a.json');
    mkdirSync(path.dirname(file), { recursive: true });
    const legacy = `${JSON.stringify({
      version: 1,
      agents: {
        legacy: {
          cardUrl: 'https://agents.example.com/.well-known/agent-card.json',
          credentialEnv: 'LEGACY_A2A_TOKEN',
          effect: 'read',
        },
      },
    }, null, 2)}\n`;
    writeFileSync(file, legacy, 'utf8');

    const operations = [
      () => upsertA2AOutboundAgent(configHome, 'new-agent', {
        cardUrl: 'https://new.example.com/.well-known/agent-card.json',
        effect: 'none',
      }),
      () => removeA2AOutboundAgent(configHome, 'legacy'),
      () => setA2AOutboundAgentEnabled(configHome, 'legacy', false),
      () => setA2AServerConfig(configHome, undefined),
    ];
    for (const operation of operations) {
      expect(operation).toThrow(/explicit migration|a2a migrate/i);
      expect(readFileSync(file, 'utf8')).toBe(legacy);
    }

    const result = migrateA2AIntegrationV1(configHome);
    expect(result.migrated).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      version: 2,
      agents: { legacy: { enabled: true, credentialEnv: 'LEGACY_A2A_TOKEN' } },
    });
    expect(migrateA2AIntegrationV1(configHome).migrated).toBe(false);
  });

  it('allows an empty v1 file to upgrade through the first ordinary write', () => {
    const file = path.join(configHome, 'integrations', 'a2a.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"version":1,"agents":{}}\n', 'utf8');

    upsertA2AOutboundAgent(configHome, 'first', {
      cardUrl: 'https://first.example.com/.well-known/agent-card.json',
      effect: 'none',
    });

    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      version: 2,
      agents: { first: { enabled: true } },
    });
  });

  it('parses an RFC 9068 JWT resource-server authentication profile', () => {
    expect(() => parseA2AIntegrationDocument({
      version: 1,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        authentication: { type: 'oauth2-jwt' },
        dataDir: '~/.kodax/a2a/tasks',
      },
    })).toThrow(/requires.*version 2/i);

    const parsed = parseA2AIntegrationDocument({
      version: 2,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        authentication: {
          type: 'oauth2-jwt',
          scheme: 'enterprise-oauth',
          issuer: 'https://identity.example.com',
          audience: 'https://agent.example.com/',
          jwksUrl: 'https://identity.example.com/.well-known/jwks.json',
          tokenUrl: 'https://identity.example.com/oauth/token',
          metadataUrl: 'https://identity.example.com/.well-known/oauth-authorization-server',
          requiredScopes: ['a2a.invoke'],
        },
        dataDir: '~/.kodax/a2a/tasks',
      },
    });
    expect(parsed.server?.authentication).toEqual({
      type: 'oauth2-jwt',
      scheme: 'enterprise-oauth',
      issuer: 'https://identity.example.com',
      audience: 'https://agent.example.com/',
      jwksUrl: 'https://identity.example.com/.well-known/jwks.json',
      tokenUrl: 'https://identity.example.com/oauth/token',
      metadataUrl: 'https://identity.example.com/.well-known/oauth-authorization-server',
      requiredScopes: ['a2a.invoke'],
    });
  });

  it('rejects OAuth scope values that are not RFC 6749 scope-tokens', () => {
    expect(() => parseA2AIntegrationDocument({
      version: 2,
      agents: {
        invalid: {
          cardUrl: 'https://agents.example.com/.well-known/agent-card.json',
          effect: 'read',
          authentication: {
            type: 'oauth2-client-credentials',
            scheme: 'oauth',
            issuer: 'https://identity.example.com',
            tokenUrl: 'https://identity.example.com/token',
            clientId: 'kodax',
            clientSecretEnv: 'CLIENT_SECRET',
            scopes: ['a2a.invoke\r\nX-Injected: true'],
          },
        },
      },
    })).toThrow(/scope-token/i);

    expect(() => parseA2AIntegrationDocument({
      version: 2,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        authentication: {
          type: 'oauth2-jwt',
          scheme: 'oauth',
          issuer: 'https://identity.example.com',
          audience: 'https://agent.example.com',
          jwksUrl: 'https://identity.example.com/jwks',
          tokenUrl: 'https://identity.example.com/token',
          requiredScopes: ['bad scope'],
        },
      },
    })).toThrow(/scope-token/i);
  });

  it('forces fixed writable workspaces to serial task admission', () => {
    expect(() => parseA2AIntegrationDocument({
      version: 2,
      agents: {},
      server: {
        execution: {
          kind: 'runtime-default',
          workspace: { mode: 'fixed', root: path.resolve(configHome, 'workspace') },
          toolPolicy: {
            workspace: 'write', process: 'deny', network: { mode: 'deny' },
            tools: [], mcp: {}, skillScripts: {}, subagents: 'deny',
          },
        },
        published: published(),
        authentication: authentication(),
        limits: {
          maxRequestBytes: 1024,
          maxPartBytes: 512,
          maxConcurrentTasks: 2,
          maxActiveTasksPerPrincipal: 2,
          maxRetainedTasksPerPrincipal: 10,
          maxEventsPerTask: 100,
          maxEventBytesPerTask: 4096,
          maxWorkspaceBytesPerContext: 8192,
        },
        dataDir: '~/.kodax/a2a/tasks',
      },
    })).toThrow(/maxConcurrentTasks.*1/i);
  });

  it('preserves the inbound singleton across outbound mutations and vice versa', () => {
    const server = parseA2AIntegrationDocument({
      version: 2,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        authentication: authentication(),
        dataDir: '~/.kodax/a2a/tasks',
      },
    }).server!;
    setA2AServerConfig(configHome, server);
    upsertA2AOutboundAgent(configHome, 'reporting', {
      cardUrl: 'https://agents.example.com/.well-known/agent-card.json',
      enabled: true,
      credentialEnv: 'REPORTING_A2A_TOKEN',
      effect: 'read',
    });
    upsertA2AOutboundAgent(configHome, 'research', {
      cardUrl: 'https://research.example.com/.well-known/agent-card.json',
      effect: 'none',
    });
    setA2AOutboundAgentEnabled(configHome, 'reporting', false);
    expect(readA2AIntegration(configHome).document.server).toEqual(server);
    expect(readA2AIntegration(configHome).document.agents.research?.enabled).toBe(true);
    expect(readA2AIntegration(configHome).document.agents.reporting?.enabled).toBe(false);
    expect(readA2AIntegration(configHome).document.agents.reporting?.credentialEnv)
      .toBe('REPORTING_A2A_TOKEN');
    expect(removeA2AOutboundAgent(configHome, 'reporting')).toBe(true);
    expect(readA2AIntegration(configHome).document.server).toEqual(server);
  });

  it('classifies publication/auth/limits as hot and execution/store as restart-required', () => {
    const current = parseA2AIntegrationDocument({
      version: 2,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        authentication: authentication(),
        dataDir: '~/.kodax/a2a/tasks',
      },
    }).server!;
    const hot = { ...current, published: { ...current.published, description: 'Updated.' } };
    expect(classifyA2AServerChange(current, hot)).toEqual({
      kind: 'hot',
      fields: ['published'],
    });
    const restart = {
      ...current,
      execution: { ...current.execution, profileId: 'a2a/new-profile' },
    };
    expect(classifyA2AServerChange(current, restart)).toEqual({
      kind: 'restart-required',
      fields: ['execution'],
    });
  });

  it('parses bootstrap listen addresses and requires a Host restart when they change (T21)', () => {
    const server = parseA2AIntegrationDocument({
      version: 2,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        listen: { hostname: '127.0.0.1', port: 7311 },
        authentication: authentication(),
        dataDir: '~/.kodax/a2a/tasks',
      },
    }).server!;
    expect(server.listen).toEqual({ hostname: '127.0.0.1', port: 7311 });

    expect(() => parseA2AIntegrationDocument({
      version: 2,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        listen: { hostname: '0.0.0.0', port: 7311 },
        authentication: authentication(),
        dataDir: '~/.kodax/a2a/tasks',
      },
    })).toThrow(/listen\.hostname must be a loopback/i);
    expect(() => parseA2AIntegrationDocument({
      version: 2,
      agents: {},
      server: {
        execution: { kind: 'runtime-default' },
        published: published(),
        listen: { hostname: '127.0.0.1', port: 70_000 },
        authentication: authentication(),
        dataDir: '~/.kodax/a2a/tasks',
      },
    })).toThrow(/listen\.port/i);

    const moved = { ...server, listen: { hostname: '127.0.0.1', port: 7312 } };
    expect(classifyA2AServerChange(server, moved)).toEqual({
      kind: 'restart-required',
      fields: ['listen'],
    });
  });
});
