import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKodaXProgram } from './program.js';
import { showKodaXHelp } from './help.js';

let stdout = '';
let stderr = '';

async function help(topic: string | true): Promise<void> {
  await showKodaXHelp(createKodaXProgram({ version: '9.9.9' }), topic);
}

beforeEach(() => {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true; });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('kodax -h', () => {
  it('lists the commands from the tree, then examples', async () => {
    await help(true);
    for (const command of ['host', 'sessions', 'setup', 'mcp', 'acp', 'skill', 'completion']) {
      expect(stdout).toMatch(new RegExp(`^  ${command}\\b`, 'm'));
    }
    expect(stdout).toContain('kodax -h <command>');
    expect(stdout).not.toMatch(/--new|--auto|--extension|\/project|daemon/);
  });

  it.each(['host', 'sessions', 'mcp', 'auth', 'acp', 'skill'])('-h %s prints that command\'s help', async (name) => {
    await help(name);
    expect(stdout).toContain(`Usage: kodax ${name}`);
    expect(process.exitCode).toBeUndefined();
  });

  it('lists the subcommands of a lazy group', async () => {
    await help('auth');
    expect(stdout).toContain('login');
  });

  it('keeps the guides that are not commands', async () => {
    await help('provider');
    expect(stdout).toContain('anthropic');
    await help('thinking');
    expect(stdout).toContain('Levels: off, auto, low, medium, high, xhigh, max');
    expect(stdout).not.toMatch(/none|minimal/);
  });

  it.each(['bogus', 'project', 'auto'])('-h %s is a usage error', async (topic) => {
    await help(topic);
    expect(stderr).toContain(`Unknown help topic: ${topic}`);
    expect(process.exitCode).toBe(2);
  });
});

describe('command help footers', () => {
  it('acp serve explains its log level', async () => {
    const program = createKodaXProgram({ version: '9.9.9' });
    const serve = program.commands.find((command) => command.name() === 'acp')!.commands[0]!;
    serve.outputHelp();
    expect(stdout).toContain('stdio ACP server');
    expect(stdout).toContain('KODAX_ACP_LOG');
    expect(stdout).toContain('--cwd C:\\repo');
  });
});
