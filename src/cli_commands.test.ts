import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  setAgentConfigHome,
  setKodaXDiagnosticSink,
  type KodaXDiagnostic,
} from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getDefaultCommandDir,
  loadCommands,
  resolveProgrammableCommandModuleUrl,
} from './cli_commands.js';

let commandDir: string;

beforeEach(async () => {
  commandDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-programmable-commands-'));
  await fs.writeFile(
    path.join(commandDir, 'package.json'),
    JSON.stringify({ type: 'module' }),
    'utf8',
  );
});

afterEach(async () => {
  await fs.rm(commandDir, { recursive: true, force: true });
});

describe('programmable command module loading', () => {
  it('converts a JavaScript filesystem path to a file URL', () => {
    const modulePath = path.join(commandDir, 'hello.js');

    const moduleUrl = resolveProgrammableCommandModuleUrl(modulePath);

    expect(moduleUrl.protocol).toBe('file:');
    expect(fileURLToPath(moduleUrl)).toBe(path.resolve(modulePath));
  });

  it('converts a TypeScript filesystem path without pre-judging runtime support', () => {
    const modulePath = path.join(commandDir, 'typed.ts');

    const moduleUrl = resolveProgrammableCommandModuleUrl(modulePath);

    expect(moduleUrl.protocol).toBe('file:');
    expect(fileURLToPath(moduleUrl)).toBe(path.resolve(modulePath));
  });

  it('loads and executes a JavaScript programmable command through its file URL', async () => {
    await fs.writeFile(
      path.join(commandDir, 'hello.js'),
      [
        'export async function command_hello(context) {',
        "  return `hello:${context.args ?? ''}`;",
        '}',
        "command_hello.description = 'Hello command';",
      ].join('\n'),
      'utf8',
    );

    const commands = await loadCommands(commandDir);
    const command = commands.get('hello');

    expect(command).toMatchObject({
      name: 'hello',
      description: 'Hello command',
      type: 'programmable',
    });
    await expect(command?.execute?.({
      args: 'world',
      runAgent: async () => {
        throw new Error('runAgent should not be called');
      },
    })).resolves.toBe('hello:world');
  });

  it('reports a TypeScript load failure with an actionable loader fallback', async () => {
    await fs.writeFile(
      path.join(commandDir, 'typed.ts'),
      'export const = ;',
      'utf8',
    );
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));

    try {
      const commands = await loadCommands(commandDir);
      expect(commands.has('typed')).toBe(false);
    } finally {
      restore();
    }

    expect(diagnostics).toContainEqual(expect.objectContaining({
      source: 'cli:commands',
      level: 'warn',
      message: expect.stringMatching(/TypeScript.*typed\.ts.*loader.*compile.*\.js/i),
    }));
  });

  it('loads a TypeScript command when the runtime supports TypeScript modules', async () => {
    await fs.writeFile(
      path.join(commandDir, 'typed.ts'),
      'export async function command_typed(): Promise<string> { return "typed"; }',
      'utf8',
    );

    const commands = await loadCommands(commandDir);

    await expect(commands.get('typed')?.execute?.({
      runAgent: async () => {
        throw new Error('runAgent should not be called');
      },
    })).resolves.toBe('typed');
  });

  it('reports a broken JavaScript module while continuing discovery', async () => {
    await fs.writeFile(path.join(commandDir, 'broken.js'), 'export const = ;', 'utf8');
    await fs.writeFile(
      path.join(commandDir, 'working.js'),
      'export async function command_working() { return "ok"; }',
      'utf8',
    );
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));

    try {
      const commands = await loadCommands(commandDir);
      expect(commands.has('working')).toBe(true);
      expect(commands.has('broken')).toBe(false);
    } finally {
      restore();
    }

    expect(diagnostics).toContainEqual(expect.objectContaining({
      source: 'cli:commands',
      level: 'warn',
      message: expect.stringContaining('broken.js'),
    }));
  });
});

describe('default command directory', () => {
  afterEach(() => {
    setAgentConfigHome(undefined);
  });

  it('follows the agent home at call time, like REPL command discovery', () => {
    setAgentConfigHome(commandDir);

    expect(getDefaultCommandDir()).toBe(path.join(commandDir, 'commands'));
  });

  it('loads prompt commands from the agent home when no directory is given', async () => {
    await fs.mkdir(path.join(commandDir, 'commands'));
    await fs.writeFile(path.join(commandDir, 'commands', 'greet.md'), '# Greet\nSay hello.\n', 'utf8');
    setAgentConfigHome(commandDir);

    const commands = await loadCommands();

    expect(commands.get('greet')?.type).toBe('prompt');
  });
});
