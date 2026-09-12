import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExtensionRuntime, setActiveExtensionRuntime } from '@kodax-ai/coding';
import {
  CommandCompleter,
  FileCompleter,
  createCompleter,
  findCommandSlashIndex,
  getCompletionSuggestions,
} from './autocomplete.js';
import { SkillCompleter } from './completers/skill-completer.js';
import { getRecentWorkingSetFiles } from './recent-files.js';
import { getCommandRegistry } from './commands.js';
import { createAutocompleteProvider } from './autocomplete-provider.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setActiveExtensionRuntime(null);
});

describe('CommandCompleter boundaries', () => {
  const completer = new CommandCompleter();

  it('completes Host-only names and aliases through Ink and readline without a local runtime', async () => {
    setActiveExtensionRuntime(null);
    const listHostCommands = vi.fn(async () => [{ name: 'remote-note', aliases: ['rnote'],
      description: 'Remote notes', source: 'extension' }]);
    const provider = createAutocompleteProvider({ gitRoot: '/workspace', listHostCommands });
    expect((await provider.fetchImmediate('/remote', 7)).map((item) => item.text)).toContain('/remote-note');
    expect((await provider.fetchImmediate('/rnote', 6)).map((item) => item.text)).toContain('/rnote');
    const readline = createCompleter('/workspace', listHostCommands);
    expect((await readline('/rnote'))[0]).toContain('/rnote');
    expect(listHostCommands).toHaveBeenCalledWith('/workspace');
    provider.cancel();
  });

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
      // Empty recent provider keeps this dir-cache test hermetic (no real git
      // I/O under fake timers).
      const scopedCompleter = new FileCompleter(tempDir, async () => []);
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

  it('can follow a dynamic workspace root after session/runtime changes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-autocomplete-dynamic-'));
    const firstRoot = path.join(tempDir, 'first');
    const secondRoot = path.join(tempDir, 'second');

    try {
      await fs.mkdir(firstRoot, { recursive: true });
      await fs.mkdir(secondRoot, { recursive: true });
      await fs.writeFile(path.join(firstRoot, 'alpha.txt'), 'alpha');
      await fs.writeFile(path.join(secondRoot, 'beta.txt'), 'beta');

      let currentRoot = firstRoot;
      const scopedCompleter = new FileCompleter(() => currentRoot, async () => []);

      const firstCompletions = await scopedCompleter.getCompletions('@', 1);
      expect(firstCompletions.some((item) => item.display === 'alpha.txt')).toBe(true);
      expect(firstCompletions.some((item) => item.display === 'beta.txt')).toBe(false);

      currentRoot = secondRoot;
      const secondCompletions = await scopedCompleter.getCompletions('@', 1);
      expect(secondCompletions.some((item) => item.display === 'alpha.txt')).toBe(false);
      expect(secondCompletions.some((item) => item.display === 'beta.txt')).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('FileCompleter — FEATURE_207 recent files', () => {
  const recent = ['src/deep/foo.ts', 'README.md', 'pkg/bar.ts'];
  const fakeProvider = async () => recent;

  it('surfaces recent files first on a bare @, keeping the cwd listing', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-f207-'));
    try {
      await fs.writeFile(path.join(tempDir, 'zeta.txt'), 'z');
      const completer = new FileCompleter(tempDir, fakeProvider);
      const out = await completer.getCompletions('@', 1);
      expect(out.slice(0, 3).map((c) => c.text)).toEqual(['@src/deep/foo.ts', '@README.md', '@pkg/bar.ts']);
      expect(out[0]!.description).toBe('recent');
      // cwd listing still present after the recent block
      expect(out.some((c) => c.display === 'zeta.txt')).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('filters recent files by basename prefix', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-f207-'));
    try {
      const completer = new FileCompleter(tempDir, fakeProvider);
      const out = await completer.getCompletions('@ba', 3);
      expect(out.filter((c) => c.description === 'recent').map((c) => c.text)).toEqual(['@pkg/bar.ts']);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does NOT surface recent files once navigating a path (@dir/)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-f207-'));
    try {
      await fs.mkdir(path.join(tempDir, 'src'));
      const completer = new FileCompleter(tempDir, fakeProvider);
      const out = await completer.getCompletions('@src/', 5);
      expect(out.some((c) => c.description === 'recent')).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('de-dupes a recent file that is also a direct cwd child', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-f207-'));
    try {
      await fs.writeFile(path.join(tempDir, 'README.md'), '#');
      const completer = new FileCompleter(tempDir, async () => ['README.md']);
      const out = await completer.getCompletions('@', 1);
      expect(out.filter((c) => c.text === '@README.md')).toHaveLength(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('yields no recent files on git failure (graceful degradation)', async () => {
    // A non-existent cwd makes the git spawn fail deterministically, exercising
    // the try/catch → [] path regardless of where the test tmp lives.
    const files = await getRecentWorkingSetFiles(path.join(os.tmpdir(), 'kodax-f207-nonexistent-xyz'));
    expect(files).toEqual([]);
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

describe('legacy completion helpers', () => {
  it('include /workflow subcommands in UI completion suggestions', async () => {
    const completions = await getCompletionSuggestions('/workflow ', 10);

    expect(completions.some((item) => item.type === 'argument' && item.display === 'runs')).toBe(true);
    expect(completions.some((item) => item.type === 'argument' && item.display === 'stop')).toBe(true);
  });

  it('returns readline-safe full-line workflow argument completions', async () => {
    const completer = createCompleter();
    const [completions, original] = await completer('/workflow ');

    expect(original).toBe('/workflow ');
    expect(completions).toContain('/workflow runs');
    expect(completions).toContain('/workflow stop');
  });

  it('keeps the command prefix when completing bare workflow commands', async () => {
    const completer = createCompleter();
    const [completions, original] = await completer('/workflow');

    expect(original).toBe('/workflow');
    expect(completions).toContain('/workflow runs');
    expect(completions).not.toContain('runs');
  });

  it('includes skill-name completions in the classic readline completer', async () => {
    vi.spyOn(SkillCompleter.prototype, 'canComplete').mockReturnValue(true);
    vi.spyOn(SkillCompleter.prototype, 'getCompletions').mockResolvedValue([
      {
        text: '/code-review',
        display: 'code-review',
        description: 'Review code',
        type: 'skill',
      },
    ]);

    const completer = createCompleter();
    const [completions, original] = await completer('/code');

    expect(original).toBe('/code');
    expect(completions).toContain('/code-review');
  });
});
