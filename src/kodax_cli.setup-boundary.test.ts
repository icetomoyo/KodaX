import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let configHome: string;

beforeEach(() => {
  configHome = mkdtempSync(path.join(tmpdir(), 'kodax-setup-boundary-'));
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
});

function runSetup(args: readonly string[], input?: string) {
  return spawnSync(
    process.execPath,
    [path.join(process.cwd(), 'dist', 'kodax_bootstrap.js'), ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KODAX_HOME: configHome,
        KODAX_TRACING: '0',
        KODAX_SESSION_RETENTION_DAYS: '1',
      },
      encoding: 'utf8',
      input,
      timeout: 30_000,
    },
  );
}

function runSetupInteractively(
  args: readonly string[],
  exchanges: readonly { readonly prompt: string; readonly answer: string }[],
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(process.cwd(), 'dist', 'kodax_bootstrap.js'), ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          KODAX_HOME: configHome,
          KODAX_TRACING: '0',
          KODAX_SESSION_RETENTION_DAYS: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let exchangeIndex = 0;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Interactive setup test timed out.'));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const exchange = exchanges[exchangeIndex];
      if (exchange && stdout.includes(exchange.prompt)) {
        exchangeIndex += 1;
        child.stdin.write(`${exchange.answer}\n`);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

function relativeFiles(root: string): readonly string[] {
  const visit = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? visit(absolute) : [path.relative(root, absolute)];
    });
  return visit(root).sort();
}

describe('setup CLI process boundary', () => {
  it('saves a hidden key through setup, reports it after restart and removes it through auth', async () => {
    const key = 'offline-cli-saved-key';
    const result = await runSetupInteractively(['setup', '--custom'], [
      { prompt: 'Custom provider name', answer: 'saved-route' },
      { prompt: 'Select 1-', answer: '3' },
      { prompt: 'API Base URL', answer: 'https://saved-route.example/v1' },
      { prompt: 'Environment-variable name only', answer: 'KODAX_UNSET_SAVED_FIXTURE' },
      { prompt: 'Model identifier', answer: 'fixture' },
      { prompt: 'Credential source', answer: '1' },
      { prompt: 'API key (hidden;', answer: key },
      { prompt: 'config.json stores public metadata.', answer: 'y' },
    ]);
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).not.toContain(key); expect(result.stderr).not.toContain(key);
    expect(result.stdout).toContain('No environment-variable setup is required');
    expect(readFileSync(path.join(configHome, 'config.json'), 'utf8')).not.toContain(key);
    const status = runSetup(['auth', 'status', 'saved-route']); expect(status.status, status.stderr).toBe(0); expect(status.stdout).toContain('source: file'); expect(status.stdout).not.toContain(key);
    const removed = runSetup(['auth', 'remove-key', 'saved-route']); expect(removed.status, removed.stderr).toBe(0); expect(removed.stdout).toContain('source: missing');
    const saved = await runSetupInteractively(['auth', 'set-key', 'saved-route'], [{ prompt: 'API key (hidden;', answer: key }]);
    expect(saved.status, saved.stderr).toBe(0); expect(saved.stdout).not.toContain(key); expect(runSetup(['auth', 'status', 'saved-route']).stdout).toContain('source: file');
  }, 30_000);
  it('keeps setup --help read-only even when normal startup would migrate config', () => {
    const configPath = path.join(configHome, 'config.json');
    const original = '{"agentMode":"amaw","sessionRetentionDays":1}\n';
    writeFileSync(configPath, original, 'utf8');
    const before = relativeFiles(configHome);

    const result = runSetup(['setup', '--help']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('KodaX setup guide');
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(relativeFiles(configHome)).toEqual(before);
  }, 30_000);

  it('runs the real setup action, creates all eight files, and handles cancellation', () => {
    const result = runSetup(['setup'], 'q\n');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('KodaX setup guide');
    expect(result.stdout).toContain('Provider setup cancelled');
    const expected = [
      'config.example.jsonc',
      'config.json',
      path.join('integrations', 'a2a.example.jsonc'),
      path.join('integrations', 'a2a.json'),
      path.join('integrations', 'extensions.example.jsonc'),
      path.join('integrations', 'extensions.json'),
      path.join('integrations', 'mcp.example.jsonc'),
      path.join('integrations', 'mcp.json'),
    ].sort();
    expect(relativeFiles(configHome)).toEqual(expect.arrayContaining(expected));
    const firstLine = readFileSync(
      path.join(configHome, 'config.example.jsonc'),
      'utf8',
    ).split(/\r?\n/u)[0];
    expect(firstLine).toContain(configHome.replaceAll('\\', '/'));
    expect(existsSync(`${path.join(configHome, 'config.json')}.write.lock`)).toBe(false);
  }, 30_000);

  it('reports invalid active config and does not create missing siblings', () => {
    const integrationDirectory = path.join(configHome, 'integrations');
    mkdirSync(integrationDirectory, { recursive: true });
    const invalidPath = path.join(integrationDirectory, 'mcp.json');
    writeFileSync(invalidPath, '{"version":2,"servers":{}}\n', 'utf8');

    const result = runSetup(['setup']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('invalid');
    expect(`${result.stdout}\n${result.stderr}`).toContain('Setup stopped');
    expect(readFileSync(invalidPath, 'utf8')).toBe('{"version":2,"servers":{}}\n');
    expect(existsSync(path.join(configHome, 'config.json'))).toBe(false);
    expect(existsSync(path.join(configHome, 'config.example.jsonc'))).toBe(false);
    expect(existsSync(path.join(integrationDirectory, 'extensions.json'))).toBe(false);
    expect(existsSync(path.join(integrationDirectory, 'a2a.json'))).toBe(false);
  }, 30_000);

  it('uses the authoritative A2A schema before creating any sibling', () => {
    const integrationDirectory = path.join(configHome, 'integrations');
    mkdirSync(integrationDirectory, { recursive: true });
    const invalidPath = path.join(integrationDirectory, 'a2a.json');
    const invalid = JSON.stringify({
      version: 2,
      agents: { bad: { cardUrl: 'not-a-url', effect: 'write' } },
    });
    writeFileSync(invalidPath, invalid, 'utf8');

    const result = runSetup(['setup']);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/cardUrl|HTTP\\?\\(S\\?\\)/i);
    expect(readFileSync(invalidPath, 'utf8')).toBe(invalid);
    expect(existsSync(path.join(configHome, 'config.json'))).toBe(false);
    expect(existsSync(path.join(integrationDirectory, 'mcp.json'))).toBe(false);
  }, 30_000);

  it('cancels cleanly when stdin closes after one valid provider answer', () => {
    const result = runSetup(['setup'], '1\n');

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Provider setup cancelled');
    expect(JSON.parse(readFileSync(path.join(configHome, 'config.json'), 'utf8')))
      .toEqual({});
  }, 30_000);

  it('passes --custom through the real Commander action and stores metadata only', async () => {
    const result = await runSetupInteractively(['setup', '--custom'], [
      { prompt: 'Custom provider name', answer: 'private-relay' },
      { prompt: 'Select 1-', answer: '1' },
      { prompt: 'API Base URL', answer: 'https://relay.example.test/v1' },
      { prompt: 'Environment-variable name only', answer: 'RELAY_API_KEY' },
      { prompt: 'Model identifier', answer: 'relay-model' },
      { prompt: 'Credential source', answer: '2' },
      { prompt: 'config.json stores public metadata.', answer: 'y' },
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Provider setup saved: private-relay/relay-model');
    const persisted = readFileSync(path.join(configHome, 'config.json'), 'utf8');
    expect(persisted).toContain('RELAY_API_KEY');
    expect(persisted).not.toContain('private-runtime-value');
    expect(JSON.parse(persisted)).toMatchObject({
      provider: 'private-relay',
      model: 'relay-model',
    });
  }, 30_000);
});
