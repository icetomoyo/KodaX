import { describe, expect, it } from 'vitest';

import { INFERRED_CASES } from './cases.js';
import { answerToolCall, noteFileMap, turnSettles, type World } from './world.js';

const WORLD: World = {
  files: {
    'package.json': '{ "scripts": { "test": "vitest run" } }\n',
    'src/a.ts': 'export const a = 1;\n',
    'src/deep/b.test.ts': "it('b', () => {});\n",
  },
  commands: [{ match: /\bwhich\s+npx\b/, exit: 1, stdout: '', stderr: 'npx: command not found' }],
};
const NO_NOTES = noteFileMap([]);

describe('feature-308 inferred session-2 world', () => {
  it('reads files by workspace-relative or absolute path, and reports a missing one', () => {
    expect(answerToolCall(WORLD, NO_NOTES, { name: 'read', input: { path: '/work/project/src/a.ts' } })).toBe('export const a = 1;\n');
    expect(answerToolCall(WORLD, NO_NOTES, { name: 'read', input: { path: 'package.json' } })).toContain('vitest run');
    expect(answerToolCall(WORLD, NO_NOTES, { name: 'read', input: { path: 'src/missing.ts' } })).toMatch(/^\[Tool Error\]/);
  });

  it('returns the real note file for a read of a stored note, whatever the slash direction', () => {
    const notes = noteFileMap([{ path: 'C:\\Temp\\fx\\notes\\node-path.md', content: '---\nname: node-path\n---\nUse fnm.' }]);
    expect(answerToolCall(WORLD, notes, { name: 'read', input: { path: 'c:/temp/fx/notes/node-path.md' } })).toContain('Use fnm.');
  });

  it('answers glob, grep, ls, cat and canned commands in the bash tool format', () => {
    expect(answerToolCall(WORLD, NO_NOTES, { name: 'glob', input: { pattern: '**/*.test.ts' } })).toBe('src/deep/b.test.ts');
    expect(answerToolCall(WORLD, NO_NOTES, { name: 'glob', input: { pattern: '*.{json,yml}' } })).toBe('package.json');
    expect(answerToolCall(WORLD, NO_NOTES, { name: 'grep', input: { pattern: 'export', path: 'src' } })).toBe('src/a.ts:1:export const a = 1;');
    expect(answerToolCall(WORLD, NO_NOTES, { name: 'bash', input: { command: 'ls -la' } })).toBe('Command: ls -la\nExit: 0\npackage.json\nsrc/\n');
    expect(answerToolCall(WORLD, NO_NOTES, { name: 'bash', input: { command: 'cat src/a.ts' } })).toBe('Command: cat src/a.ts\nExit: 0\nexport const a = 1;\n');
    expect(answerToolCall(WORLD, NO_NOTES, { name: 'bash', input: { command: 'which npx' } })).toBe('Command: which npx\nExit: 1\n\n[stderr]\nnpx: command not found');
  });

  it('settles a turn on the judged command or on a turn without tools, not on exploration', () => {
    const oracle = { pick: /\bvitest\b/ };
    expect(turnSettles(oracle, [])).toBe(true);
    expect(turnSettles(oracle, [{ name: 'bash', input: { command: 'npx vitest run src' } }])).toBe(true);
    expect(turnSettles(oracle, [{ name: 'glob', input: { pattern: '**/*.test.ts' } }, { name: 'bash', input: { command: 'which npx' } }])).toBe(false);
  });

  it('every case world answers the files its session-2 history already showed', () => {
    for (const item of INFERRED_CASES) {
      for (const message of item.sessionTwo.history) {
        if (message.role !== 'assistant' || typeof message.content === 'string') continue;
        for (const block of message.content) {
          if (block.type !== 'tool_use' || block.name !== 'read') continue;
          const target = String((block.input as { path?: unknown }).path);
          expect(answerToolCall(item.world, NO_NOTES, { name: 'read', input: { path: target } }), `${item.id} ${target}`).not.toMatch(/^\[Tool Error\]/);
        }
      }
    }
  });
});
