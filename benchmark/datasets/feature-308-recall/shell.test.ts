/**
 * The recall shell answers the exploration the pilot's agents tried, so a
 * chain spends its rounds on the task rather than on the sandbox.
 */
import { describe, expect, it } from 'vitest';

import { toolBatchFailed } from '../../../packages/coding/src/memory/note-memory.js';
import { RECALL_CASES } from './cases.js';
import { answerShell, parseCommand } from './shell.js';

const world = (id: string) => RECALL_CASES.find((item) => item.id === id)!.world;
const run = (id: string, command: string): { exit: number; stdout: string; stderr: string; text: string } => {
  const text = answerShell(world(id), command);
  const match = /^Command: [\s\S]*?\nExit: (-?\d+)\n([\s\S]*?)(?:\n\[stderr\]\n([\s\S]*))?$/.exec(text)!;
  return { exit: Number(match[1]), stdout: match[2]!, stderr: match[3] ?? '', text };
};
const failed = (text: string): boolean => toolBatchFailed([{ type: 'tool_result', tool_use_id: 't', content: text }]);

describe('parseCommand', () => {
  it('splits at top-level operators and pipes, not inside quotes or $()', () => {
    expect(parseCommand('echo "a && b" | head -1; ls || echo $(pwd; ls)')).toEqual([
      { op: ';', stages: ['echo "a && b"', 'head -1'] },
      { op: ';', stages: ['ls'] },
      { op: '||', stages: ['echo $(pwd; ls)'] },
    ]);
  });
});

describe('answerShell', () => {
  it('answers pwd, echo and ls in one compound command', () => {
    const result = run('k-code-bug', 'pwd && echo "PATH=$PATH" && ls -la');
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain('/work/project\n');
    expect(result.stdout).toContain('PATH=/usr/local/sbin:');
    expect(result.stdout).toContain('package.json');
  });

  it('follows cd for later reads', () => {
    expect(run('l-shared-build', 'cd apps/web && cat package.json').stdout).toContain('"@acme/web"');
  });

  it('finds workspace files by name', () => {
    expect(run('k-code-bug', 'find . -type f -name "*.test.ts"').stdout).toBe('./src/cart/total.test.ts\n');
  });

  it('drops stderr sent to /dev/null and recovers through ||', () => {
    const result = run('k-code-bug', 'ls ~/.fnm 2>/dev/null || echo "no fnm"');
    expect(result).toMatchObject({ exit: 0, stdout: 'no fnm\n', stderr: '' });
    expect(failed(result.text)).toBe(false);
  });

  it('reports a missing file as a failure the reminder counts', () => {
    const result = run('k-code-bug', 'cat /etc/hostname');
    expect(result.exit).toBe(1);
    expect(failed(result.text)).toBe(true);
  });

  it('merges 2>&1 into a pipe, whose exit is the last stage, as bash does', () => {
    const result = run('l-port-devserver', 'npm run e2e 2>&1 | head -3');
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain('EADDRINUSE');
    expect(result.stderr).toBe('');
  });

  it('stops an && chain at the first failure', () => {
    const result = run('l-tls-ca', 'git pull origin main && echo pulled');
    expect(result.exit).toBe(128);
    expect(result.stdout).not.toContain('pulled');
  });

  it('answers versions and which for tools on PATH', () => {
    expect(run('k-code-bug', 'node --version && which npm').stdout).toBe('v22.11.0\n/usr/bin/npm\n');
  });

  it('matches canned commands at the command position only', () => {
    expect(run('l-node-path', 'find . -type f').stdout).toContain('./src/billing/invoice.ts');
    expect(run('l-shared-build', 'ls node_modules/.bin/tsc').stdout).not.toContain('TS2307');
    expect(run('l-shared-build', 'npm run typecheck -w apps/web').exit).toBe(2);
  });
});

describe('the node-path world', () => {
  it('has no node on PATH until the fnm bin directory is exported', () => {
    expect(run('l-node-path', 'node --version').exit).toBe(127);
    expect(run('l-node-path', 'which node').exit).toBe(1);
    const fixed = run('l-node-path', 'export PATH="$HOME/.local/share/fnm/node-versions/v22.11.0/installation/bin:$PATH" && node --version && which node');
    expect(fixed).toMatchObject({ exit: 0, stdout: 'v22.11.0\n/usr/bin/node\n' });
  });

  it('lets a search of the disk or the fnm directory find the installed Node', () => {
    expect(run('l-node-path', 'find / -name node -type f 2>/dev/null | head -5').stdout).toContain('fnm/node-versions/v22.11.0/installation/bin/node');
    expect(run('l-node-path', 'ls ~/.local/share/fnm/node-versions').stdout).toBe('v22.11.0\n');
    expect(run('l-node-path', '~/.local/share/fnm/node-versions/v22.11.0/installation/bin/node --version').stdout).toBe('v22.11.0\n');
  });
});
