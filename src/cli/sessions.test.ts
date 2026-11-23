import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliOptions } from '../cli_option_helpers.js';
import type { CliHost } from './cli-host.js';

const host = vi.hoisted(() => ({ call: vi.fn(), close: vi.fn() }));
const storage = vi.hoisted(() => ({ delete: vi.fn(async () => {}), deleteAll: vi.fn(async () => {}) }));
const acp = vi.hoisted(() => ({
  find: vi.fn(async () => [{ id: 'acp-1' }]),
  archive: vi.fn(async (_storage: unknown, candidates: readonly unknown[]) => candidates),
}));

vi.mock('../local-host-client.js', () => ({ ensureKodaXHostClient: vi.fn(async () => host) }));
vi.mock('../acp_session_cleanup.js', () => ({
  findAcpPollutionCandidates: acp.find,
  archiveAcpPollutionCandidates: acp.archive,
}));
vi.mock('@kodax-ai/repl', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kodax-ai/repl')>(),
  FileSessionStorage: class {
    delete = storage.delete;
    deleteAll = storage.deleteAll;
  },
}));

const { configureKodaXSessionsCommand, runLegacySessionOperation } = await import('./sessions.js');

const SESSION = { id: 'session-1', title: 'Fix the parser', archived: false, messageCount: 4, lastMessageAt: Date.parse('2026-11-20T10:00:00Z') };

let stdout = '';
let stderr = '';

async function kodax(...args: string[]): Promise<void> {
  const program = new Command().name('kodax').exitOverride();
  configureKodaXSessionsCommand(program, '9.9.9');
  await program.parseAsync(['node', 'kodax', ...args]);
}

function legacy(session: string, prompt: string[] = [], applySessionCleanup?: boolean): Promise<boolean> {
  const options = { session, prompt, outputMode: 'text' } as unknown as CliOptions;
  return runLegacySessionOperation(options, { applySessionCleanup }, async () => ({ client: host } as unknown as CliHost));
}

beforeEach(() => {
  stdout = '';
  stderr = '';
  host.call.mockResolvedValue({ items: [SESSION] });
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { stdout += `${parts.join(' ')}\n`; });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true; });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe('kodax sessions', () => {
  it.each([[['sessions']], [['sessions', 'list']]])('%j lists the project sessions from the Host', async (args) => {
    await kodax(...args);
    expect(host.call).toHaveBeenCalledWith('session.list', expect.objectContaining({ projectRoot: process.cwd() }));
    expect(stdout).toContain('session-1 [4]');
    expect(stdout).toContain('Fix the parser');
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it.each([[['sessions', 'list', '--json']], [['sessions', '--json']]])('%j prints the list as JSON', async (args) => {
    await kodax(...args);
    expect(JSON.parse(stdout)).toEqual([expect.objectContaining({ id: 'session-1', msgCount: 4 })]);
  });

  it('says so when there is nothing to resume', async () => {
    host.call.mockResolvedValue({ items: [] });
    await kodax('sessions', 'list');
    expect(stdout).toContain('No resumable sessions.');
  });

  it('deletes one session by id', async () => {
    await kodax('sessions', 'delete', 'session-1');
    expect(storage.delete).toHaveBeenCalledWith('session-1');
    expect(stdout).toContain('Deleted session: session-1');
  });

  it('deletes every session', async () => {
    await kodax('sessions', 'delete-all');
    expect(storage.deleteAll).toHaveBeenCalledTimes(1);
  });

  it('previews ACP cleanup and archives only with --apply', async () => {
    await kodax('sessions', 'cleanup-acp');
    expect(acp.archive).not.toHaveBeenCalled();
    expect(stdout).toContain('Re-run with --apply');
    await kodax('sessions', 'cleanup-acp', '--apply');
    expect(acp.archive).toHaveBeenCalledTimes(1);
  });
});

describe('legacy -s session operations', () => {
  it.each([
    ['list', 'kodax sessions list'],
    ['delete-all', 'kodax sessions delete-all'],
    ['cleanup-acp', 'kodax sessions cleanup-acp'],
  ])('-s %s still works and points at %s', async (operation, replacement) => {
    expect(await legacy(operation)).toBe(true);
    expect(stderr).toContain(`\`kodax -s ${operation}\` is now \`${replacement}\``);
    expect(stderr).toContain('0.7.100');
  });

  it('-s delete takes the id from the prompt or the quoted operation', async () => {
    await legacy('delete', ['session-1']);
    await legacy('delete session-2');
    expect(storage.delete.mock.calls).toEqual([['session-1'], ['session-2']]);
    expect(stderr).toContain('`kodax sessions delete <id>`');
  });

  it('-s cleanup-acp keeps --apply-session-cleanup', async () => {
    await legacy('cleanup-acp', [], true);
    expect(acp.archive).toHaveBeenCalledTimes(1);
  });

  it('leaves -s <id> and -s resume to the resume path', async () => {
    expect(await legacy('resume')).toBe(false);
    expect(await legacy('session-1')).toBe(false);
    expect(stderr).toBe('');
  });
});
