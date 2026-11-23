import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { renderCompletionScript } from './completion.js';
import { createKodaXProgram } from './program.js';

const bash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

async function script(shell: 'bash' | 'zsh' | 'fish'): Promise<string> {
  return renderCompletionScript(createKodaXProgram({ version: '9.9.9' }), shell);
}

/** What bash offers after the given words; the last word is the one being completed. */
function complete(source: string, words: readonly string[]): string[] {
  const array = words.map((word) => `'${word}'`).join(' ');
  // Through stdin: Windows command-line quoting mangles a script passed with -c.
  const run = spawnSync('bash', [], {
    input: `${source}
COMP_WORDS=(${array}); COMP_CWORD=${words.length - 1}; _kodax_complete; printf '%s\\n' "\${COMPREPLY[@]}"`,
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.split('\n').filter(Boolean);
}

describe('kodax completion', () => {
  it.each(['bash', 'zsh', 'fish'] as const)('%s leaves out removed and hidden names', async (shell) => {
    const text = await script(shell);
    expect(text).not.toMatch(/--extension|--auto|--new\b|apply-session-cleanup|agent-mode/);
    // The hidden `daemon` alias is never offered; descriptions may still say "daemon".
    expect(text).not.toMatch(/'daemon'|" daemon"|words="[^"]*\bdaemon\b/);
    expect(text).toContain('host');
  });

  it.runIf(bash)('completes subcommands at any depth', async () => {
    const source = await script('bash');
    expect(complete(source, ['kodax', 'ho'])).toEqual(['host']);
    expect(complete(source, ['kodax', 'host', 'st'])).toEqual(expect.arrayContaining(['start', 'status', 'stop']));
    expect(complete(source, ['kodax', 'mcp', ''])).toContain('list');
    expect(complete(source, ['kodax', 'auth', ''])).toContain('login');
  });

  it.runIf(bash)('completes option values the parser knows', async () => {
    const source = await script('bash');
    expect(complete(source, ['kodax', '--provider', ''])).toContain('anthropic');
    expect(complete(source, ['kodax', '--effort', 'x'])).toEqual(['xhigh']);
    expect(complete(source, ['kodax', 'completion', ''])).toEqual(['bash', 'zsh', 'fish']);
    expect(complete(source, ['kodax', 'acp', 'serve', '--permission-mode', 'a'])).toEqual(expect.arrayContaining(['accept-edits', 'auto']));
  });

  it.runIf(bash)('leaves free-form values to file completion', async () => {
    expect(complete(await script('bash'), ['kodax', '--model', ''])).toEqual([]);
  });

  it.runIf(bash)('generates valid bash', async () => {
    const run = spawnSync('bash', ['-n'], { input: await script('bash'), encoding: 'utf8' });
    expect(run.stderr).toBe('');
  });
});
