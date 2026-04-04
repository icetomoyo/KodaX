import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExtensionRuntime, setActiveExtensionRuntime } from '@kodax/coding';
import { CommandCompleter, FileCompleter, findCommandSlashIndex } from './autocomplete.js';
import { getCommandRegistry } from './commands.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setActiveExtensionRuntime(null);
});

describe('CommandCompleter boundaries', () => {
  const completer = new CommandCompleter();

  it('triggers at line start and after whitespace', () => {
    expect(completer.canComplete('/help', 5)).toBe(true);
    expect(completer.canComplete('hello /help', 11)).toBe(true);
    expect(completer.canComplete('hello\n/help', 11)).toBe(true);
    expect(completer.canComplete('hello\t/help', 11)).toBe(true);
  });

  it('does not trigger inside non-whitespace-delimited text', () => {
    expect(completer.canComplete('https://example.com', 19)).toBe(false);
    expect(completer.canComplete('foo/help', 8)).toBe(false);
  });

  it('includes newly registered builtin commands', async () => {
    const completions = await completer.getCompletions('/n', 2);
    expect(completions.some((item) => item.display === '/new')).toBe(true);
  });

  it('does not expose the retired /project shell in command completions', async () => {
    const completions = await completer.getCompletions('/pro', 4);
    expect(completions.some((item) => item.display === '/project')).toBe(false);
    expect(completions.some((item) => item.display === '/proj')).toBe(false);
  });

  it('refreshes command completions after runtime registration', async () => {
    const registry = getCommandRegistry();
    registry.unregister('deploy');

    registry.register({
      name: 'deploy',
      aliases: ['dep'],
      description: 'Deploy the current project',
      source: 'extension',
      handler: async () => {},
    });

    try {
      const completions = await completer.getCompletions('/dep', 4);
      expect(completions.some((item) => item.display === '/deploy')).toBe(true);
      expect(completions.some((item) => item.display === '/dep')).toBe(true);
    } finally {
      registry.unregister('deploy');
    }
  });

  it('does not suggest non-user-invocable commands', async () => {
    const registry = getCommandRegistry();
    registry.unregister('internal-sync');

    registry.register({
      name: 'internal-sync',
      description: 'Internal sync command',
      source: 'extension',
      userInvocable: false,
      handler: async () => {},
    });

    try {
      const completions = await completer.getCompletions('/internal', 9);
      expect(completions.some((item) => item.display === '/internal-sync')).toBe(false);
    } finally {
      registry.unregister('internal-sync');
    }
  });

  it('includes active extension runtime commands in completions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-autocomplete-ext-'));
    const extensionPath = path.join(tempDir, 'ext.mjs');
    await fs.writeFile(
      extensionPath,
      `
        export default function(api) {
          api.registerCommand({
            name: 'show-ext-state',
            aliases: ['ses'],
            description: 'Show extension state',
            handler: async () => ({ message: 'ok' }),
          });
        }
      `,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    try {
      await runtime.loadExtension(extensionPath);
      const completions = await completer.getCompletions('/show', 5);
      expect(completions.some((item) => item.display === '/show-ext-state')).toBe(true);

      const aliasCompletions = await completer.getCompletions('/ses', 4);
      expect(aliasCompletions.some((item) => item.display === '/ses')).toBe(true);
    } finally {
      await runtime.dispose();
      setActiveExtensionRuntime(null);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('FileCompleter boundaries', () => {
  const completer = new FileCompleter();

  it('triggers at line start and after whitespace', () => {
    expect(completer.canComplete('@src', 4)).toBe(true);
    expect(completer.canComplete('hello @src', 10)).toBe(true);
    expect(completer.canComplete('hello\n@src', 10)).toBe(true);
    expect(completer.canComplete('hello\t@src', 10)).toBe(true);
  });

  it('does not trigger inside email-like text', () => {
    expect(completer.canComplete('name@example.com', 16)).toBe(false);
    expect(completer.canComplete('foo@src', 7)).toBe(false);
  });

  it('evicts expired directory cache entries lazily instead of scheduling timers', async () => {
    vi.useFakeTimers();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-autocomplete-'));

    try {
      await fs.writeFile(path.join(tempDir, 'alpha.txt'), 'alpha');
      const scopedCompleter = new FileCompleter(tempDir);
      const internals = scopedCompleter as unknown as {
        cache: Map<string, { entries: string[]; expiresAt: number }>;
      };

      const initial = await scopedCompleter.getCompletions('@', 1);
      expect(initial.some((item) => item.display === 'alpha.txt')).toBe(true);
      expect(internals.cache.has(tempDir)).toBe(true);

      await fs.writeFile(path.join(tempDir, 'beta.txt'), 'beta');
      const staleRead = await scopedCompleter.getCompletions('@', 1);
      expect(staleRead.some((item) => item.display === 'beta.txt')).toBe(false);

      internals.cache.set(tempDir, {
        entries: ['alpha.txt'],
        expiresAt: Date.now() - 1,
      });

      const refreshed = await scopedCompleter.getCompletions('@', 1);
      expect(refreshed.some((item) => item.display === 'beta.txt')).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('findCommandSlashIndex', () => {
  it('returns index of / at position 0', () => {
    expect(findCommandSlashIndex('/help')).toBe(0);
    expect(findCommandSlashIndex('/model anthropic/cl')).toBe(0);
    expect(findCommandSlashIndex('/model')).toBe(0);
  });

  it('returns index of / preceded by whitespace', () => {
    expect(findCommandSlashIndex('hello /help')).toBe(6);
    expect(findCommandSlashIndex('hello  /help')).toBe(7);
    expect(findCommandSlashIndex('hello\n/help')).toBe(6);
    expect(findCommandSlashIndex('hello\t/help')).toBe(6);
  });

  it('skips slashes not preceded by whitespace', () => {
    // In "/model anthropic/cl", the second / at index 16 is preceded by 'c', not whitespace
    expect(findCommandSlashIndex('/model anthropic/cl')).toBe(0);
    // "a/b/c" — last / is at 4 preceded by 'b', next is at 2 preceded by 'a', no valid slash
    expect(findCommandSlashIndex('a/b/c')).toBe(-1);
    // "x /y/z" — the / at 2 is valid (preceded by space), /y/z is the command
    expect(findCommandSlashIndex('x /y/z')).toBe(2);
  });

  it('returns -1 when no valid command prefix slash exists', () => {
    expect(findCommandSlashIndex('https://example.com')).toBe(-1);
    expect(findCommandSlashIndex('foo/help')).toBe(-1);
    expect(findCommandSlashIndex('a/b')).toBe(-1);
    expect(findCommandSlashIndex('')).toBe(-1);
    expect(findCommandSlashIndex('no slash here')).toBe(-1);
  });
});
