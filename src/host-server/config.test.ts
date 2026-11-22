import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '@kodax-ai/agent';
import { afterEach, describe, expect, it } from 'vitest';

import { createHostToolCeiling, parseHostIntegrationDocument, readHostIntegration } from './config.js';

const JWT = { issuer: 'https://idp.example.test/realm', audience: 'kodax-host-1', jwksUrl: 'https://idp.example.test/jwks' };
const LISTEN = { hostname: '0.0.0.0', port: 8787 };

describe('parseHostIntegrationDocument', () => {
  it('reads a Host that listens and admits its owner and a service by JWT', () => {
    const document = parseHostIntegrationDocument({
      version: 1,
      server: { listen: LISTEN, jwt: JWT, owner: 'user-42', services: ['backend'], allowedOrigins: ['https://app.example.test'] },
    });
    expect(document.server).toEqual({
      listen: LISTEN, jwt: JWT, owner: 'user-42', services: ['backend'], allowedOrigins: ['https://app.example.test'],
    });
  });

  it('fills in the lists a Host may leave out', () => {
    expect(parseHostIntegrationDocument({ version: 1, server: { listen: LISTEN, jwt: JWT, owner: 'user-42' } }).server)
      .toMatchObject({ services: [], allowedOrigins: [] });
  });

  it('reads a Host without a server block, which does not listen', () => {
    expect(parseHostIntegrationDocument({ version: 1 })).toEqual({ version: 1 });
  });

  it('listens on a socket path', () => {
    const document = parseHostIntegrationDocument({ version: 1, server: { listen: { socketPath: '/run/kodax/host.sock' }, jwt: JWT, owner: 'u' } });
    expect(document.server?.listen).toEqual({ socketPath: '/run/kodax/host.sock' });
  });

  it('reads the workspace network clients name projects in', () => {
    const workspaceRoot = path.resolve('/srv/kodax/workspace');
    expect(parseHostIntegrationDocument({ version: 1, server: { listen: LISTEN, jwt: JWT, owner: 'u', workspaceRoot } }).server)
      .toMatchObject({ workspaceRoot });
  });

  it('reads the tools every Run on the Host is limited to, with or without a listener', () => {
    expect(parseHostIntegrationDocument({ version: 1, server: { listen: LISTEN, jwt: JWT, owner: 'u', tools: ['read', 'grep'] } }).server)
      .toMatchObject({ tools: ['read', 'grep'] });
    expect(parseHostIntegrationDocument({ version: 1, server: { tools: [] } }).server).toEqual({ services: [], allowedOrigins: [], tools: [] });
  });

  it.each([
    ['a tool without a name', { tools: [''] }, /tools/u],
    ['a relative workspace', { listen: LISTEN, jwt: JWT, owner: 'u', workspaceRoot: 'workspace' }, /absolute/u],
    ['a field it does not know', { listen: LISTEN, jwt: JWT, owner: 'u', tls: true }, /tls/u],
    ['a listener without authentication', { listen: LISTEN }, /authentication/u],
    ['a JWT check that admits nobody', { listen: LISTEN, jwt: JWT }, /owner or server\.services/u],
    ['subjects without a JWT check', { listen: LISTEN, owner: 'u' }, /server\.jwt/u],
    ['a subject that is both owner and service', { listen: LISTEN, jwt: JWT, owner: 'u', services: ['u'] }, /both/u],
    ['an origin with a path', { listen: LISTEN, jwt: JWT, owner: 'u', allowedOrigins: ['https://app.example.test/ui'] }, /origin/u],
    ['a wildcard origin', { listen: LISTEN, jwt: JWT, owner: 'u', allowedOrigins: ['*'] }, /origin/u],
    ['a key set over plain HTTP', { listen: LISTEN, jwt: { ...JWT, jwksUrl: 'http://idp.internal/jwks' }, owner: 'u' }, /HTTPS/u],
    ['a port out of range', { listen: { hostname: '::', port: 70000 }, jwt: JWT, owner: 'u' }, /port/u],
    ['a hostname without a port', { listen: { hostname: '::' }, jwt: JWT, owner: 'u' }, /either/u],
    ['both a socket and a port', { listen: { ...LISTEN, socketPath: '/run/h.sock' }, jwt: JWT, owner: 'u' }, /either/u],
  ])('refuses %s, so the Host does not start', (_label, server, message) => {
    expect(() => parseHostIntegrationDocument({ version: 1, server })).toThrow(message);
  });

  it('refuses another version', () => {
    expect(() => parseHostIntegrationDocument({ version: 2 })).toThrow(/version/u);
  });
});

describe('createHostToolCeiling', () => {
  const homes: string[] = [];
  afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
  const home = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kodax-host-tools-'));
    homes.push(dir);
    mkdirSync(path.join(dir, 'integrations'));
    return dir;
  };
  const write = (configHome: string, content: unknown): void =>
    writeFileSync(path.join(configHome, 'integrations', 'host.json'), typeof content === 'string' ? content : JSON.stringify(content));

  it('reads the file for each Run, so a change applies to the next one', () => {
    const configHome = home();
    const ceiling = createHostToolCeiling(configHome);
    expect(ceiling()).toBeUndefined();
    write(configHome, { version: 1, server: { tools: ['read'] } });
    expect(ceiling()).toEqual(['read']);
    write(configHome, { version: 1 });
    expect(ceiling()).toBeUndefined();
  });

  it('refuses to start from a file it cannot read', () => {
    const configHome = home();
    write(configHome, { version: 1, server: { tools: [''] } });
    expect(() => createHostToolCeiling(configHome)).toThrow(/tools/u);
  });

  it('keeps the last limit it read when an edit cannot be read, and says so once', () => {
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink(diagnostic => diagnostics.push(diagnostic));
    try {
      const configHome = home();
      write(configHome, { version: 1, server: { tools: ['read'] } });
      const ceiling = createHostToolCeiling(configHome);
      write(configHome, '{ version: 1');
      expect([ceiling(), ceiling()]).toEqual([['read'], ['read']]);
      expect(diagnostics).toEqual([expect.objectContaining({ level: 'warn', detail: { error: expect.stringMatching(/host\.json/u) } })]);
      write(configHome, { version: 1, server: { tools: ['grep'] } });
      expect(ceiling()).toEqual(['grep']);
    } finally {
      restore();
    }
  });
});

describe('readHostIntegration', () => {
  const homes: string[] = [];
  afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
  const home = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kodax-host-config-'));
    homes.push(dir);
    return dir;
  };

  it('reads integrations/host.json in the config home', () => {
    const configHome = home();
    mkdirSync(path.join(configHome, 'integrations'));
    writeFileSync(path.join(configHome, 'integrations', 'host.json'),
      JSON.stringify({ version: 1, server: { listen: LISTEN, jwt: JWT, owner: 'u' } }));
    const snapshot = readHostIntegration(configHome);
    expect(snapshot).toMatchObject({ domain: 'host', source: 'user', path: path.join(configHome, 'integrations', 'host.json') });
    expect(snapshot.document.server?.owner).toBe('u');
  });

  it('reads a home without the file as a Host that does not listen', () => {
    const snapshot = readHostIntegration(home());
    expect(snapshot).toMatchObject({ domain: 'host', source: 'default', document: { version: 1 } });
  });

  it('refuses a file that is not JSON', () => {
    const configHome = home();
    mkdirSync(path.join(configHome, 'integrations'));
    writeFileSync(path.join(configHome, 'integrations', 'host.json'), '{ version: 1');
    expect(() => readHostIntegration(configHome)).toThrow(/host\.json/u);
  });
});
