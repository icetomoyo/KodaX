import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseHostIntegrationDocument, readHostIntegration } from './config.js';

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

  it.each([
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
