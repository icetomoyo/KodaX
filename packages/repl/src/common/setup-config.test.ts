import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeSetupConfiguration } from './setup-config.js';

let configHome: string;

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'kodax-setup-config-'));
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
});

describe('initializeSetupConfiguration', () => {
  it('creates every missing active config and annotated template', () => {
    const result = initializeSetupConfiguration({ configHome });

    expect(result.files).toHaveLength(8);
    expect(result.files.every((file) => file.status === 'created')).toBe(true);
    expect(JSON.parse(readFileSync(join(configHome, 'config.json'), 'utf8'))).toEqual({});
    expect(JSON.parse(readFileSync(join(configHome, 'integrations', 'mcp.json'), 'utf8')))
      .toEqual({ version: 1, servers: {} });
    expect(JSON.parse(readFileSync(join(configHome, 'integrations', 'extensions.json'), 'utf8')))
      .toEqual({ version: 1, paths: [] });
    expect(JSON.parse(readFileSync(join(configHome, 'integrations', 'a2a.json'), 'utf8')))
      .toEqual({ version: 2, agents: {} });

    const coreTemplate = readFileSync(join(configHome, 'config.example.jsonc'), 'utf8');
    expect(coreTemplate.split(/\r?\n/u)[0]).toMatch(
      /mcp\.json.*extensions\.json.*a2a\.json/i,
    );
    expect(coreTemplate).not.toContain('"envPass"');
    expect(coreTemplate).toContain('"full-access"');
  });

  it('renders installed template paths from the actual config home', () => {
    initializeSetupConfiguration({ configHome });

    const coreTemplate = readFileSync(join(configHome, 'config.example.jsonc'), 'utf8');
    const firstLine = coreTemplate.split(/\r?\n/u)[0];
    expect(firstLine).toContain(configHome.replaceAll('\\', '/'));
    expect(firstLine).not.toContain('~/.kodax');
  });

  it('never overwrites existing active configs or templates', () => {
    const activeConfig = join(configHome, 'config.json');
    const coreTemplate = join(configHome, 'config.example.jsonc');
    writeFileSync(activeConfig, '{"provider":"existing"}\n', 'utf8');
    writeFileSync(coreTemplate, '// keep this template\n{}\n', 'utf8');

    const result = initializeSetupConfiguration({ configHome });

    expect(readFileSync(activeConfig, 'utf8')).toBe('{"provider":"existing"}\n');
    expect(readFileSync(coreTemplate, 'utf8')).toBe('// keep this template\n{}\n');
    expect(result.files.find((file) => file.path === activeConfig)?.status).toBe('existing');
    expect(result.files.find((file) => file.path === coreTemplate)?.status).toBe('existing');
  });

  it('preserves legacy MCP and Extension declarations when creating split files', () => {
    writeFileSync(join(configHome, 'config.json'), JSON.stringify({
      mcpServers: {
        local: { type: 'stdio', command: 'node', args: ['server.js'] },
      },
      extensions: ['C:/extensions/example.mjs'],
    }), 'utf8');

    initializeSetupConfiguration({ configHome });

    expect(JSON.parse(readFileSync(join(configHome, 'integrations', 'mcp.json'), 'utf8')))
      .toMatchObject({ servers: { local: { command: 'node' } } });
    expect(JSON.parse(readFileSync(join(configHome, 'integrations', 'extensions.json'), 'utf8')))
      .toEqual({ version: 1, paths: ['C:/extensions/example.mjs'] });
  });

  it.each([
    ['core', 'config.json', '{ broken'],
    ['mcp', join('integrations', 'mcp.json'), '{"version":2,"servers":{}}\n'],
    ['extensions', join('integrations', 'extensions.json'), '{"version":1,"paths":"broken"}\n'],
    ['a2a', join('integrations', 'a2a.json'), '{"version":3,"agents":{}}\n'],
  ] as const)('reports an invalid %s active file without changing any file', (domain, relativePath, content) => {
    const file = join(configHome, relativePath);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content, 'utf8');

    const result = initializeSetupConfiguration({ configHome });

    expect(result.files.find((entry) => entry.path === file)).toMatchObject({
      domain,
      kind: 'active',
      status: 'invalid',
      diagnostic: expect.any(String),
    });
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(result.files.some((entry) => entry.status === 'created')).toBe(false);
  });

  it('uses the host A2A validator before classifying a non-empty document as existing', () => {
    const a2aPath = join(configHome, 'integrations', 'a2a.json');
    mkdirSync(join(a2aPath, '..'), { recursive: true });
    writeFileSync(a2aPath, JSON.stringify({
      version: 2,
      agents: { bad: { cardUrl: 'not-a-url', effect: 'write' } },
    }), 'utf8');

    const result = initializeSetupConfiguration({
      configHome,
      validateA2A: () => {
        throw new Error('A2A outbound Agent "bad" cardUrl must be an absolute HTTP(S) URL.');
      },
    });

    expect(result.files.find((entry) => entry.path === a2aPath)).toMatchObject({
      status: 'invalid',
      diagnostic: expect.stringMatching(/cardUrl/i),
    });
    expect(result.files.some((entry) => entry.status === 'created')).toBe(false);
  });

  it('preflights every pending legacy integration before migrating either domain', () => {
    const configPath = join(configHome, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        local: { type: 'stdio', command: 'node' },
      },
      extensions: ['duplicate.mjs', 'duplicate.mjs'],
    }), 'utf8');

    const result = initializeSetupConfiguration({ configHome });

    expect(result.files.find((entry) => entry.path === configPath)).toMatchObject({
      status: 'invalid',
      diagnostic: expect.stringMatching(/legacy.*extension|extension.*legacy/i),
    });
    expect(result.files.some((entry) => entry.status === 'created')).toBe(false);
    expect(() => readFileSync(join(configHome, 'integrations', 'mcp.json'), 'utf8')).toThrow();
    expect(() => readFileSync(join(configHome, 'integrations', 'extensions.json'), 'utf8')).toThrow();
  });

  it.skipIf(process.platform === 'win32')('creates private config directories and files on POSIX', () => {
    chmodSync(configHome, 0o700);

    initializeSetupConfiguration({ configHome });

    expect(statSync(join(configHome, 'integrations')).mode & 0o777).toBe(0o700);
    expect(statSync(join(configHome, 'config.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(configHome, 'integrations', 'mcp.json')).mode & 0o777).toBe(0o600);
  });
});
