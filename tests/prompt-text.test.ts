import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const textDir = 'packages/coding/src/prompts/text';
const store = 'packages/coding/src/prompts/static-text.json';
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function runGenerator(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/prompt-text.mjs'), ...args], { cwd: root, encoding: 'utf8' });
}

/** A scratch checkout holding the generator and the given prompt sources. */
function scratchRoot(sources: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-prompt-text-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync('scripts/prompt-text.mjs', path.join(root, 'scripts/prompt-text.mjs'));
  for (const [relative, content] of Object.entries(sources)) {
    const target = path.join(root, textDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function readStore(root: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(root, store), 'utf8')) as Record<string, string>;
}

describe('prompt text sources', () => {
  it('match the committed packaged store', () => {
    const result = runGenerator(process.cwd(), '--check');
    expect(result.status, result.stderr).toBe(0);
  });

  it('compile a Windows CRLF checkout to the same store', () => {
    const sources: Record<string, string> = {};
    for (const entry of fs.readdirSync(textDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const relative = path.relative(textDir, path.join(entry.parentPath, entry.name));
      sources[relative] = fs.readFileSync(path.join(textDir, relative), 'utf8').replace(/\r\n?/g, '\n').replaceAll('\n', '\r\n');
    }
    const root = scratchRoot(sources);
    fs.copyFileSync(store, path.join(root, store));

    const result = runGenerator(root, '--check');
    expect(result.status, result.stderr).toBe(0);
  });

  it('keep body bytes exact and carry edge whitespace in the marker', () => {
    const root = scratchRoot({
      'a.md': '<!-- @key a.one -->\nLine one\n\n  indented line\n\n\n<!-- @key a.two lead="\\n" trail=" " -->\nEdged\n',
      'b.schemas.json': '{ "b.schema": { "type": "object", "properties": {} } }\n',
    });

    const result = runGenerator(root);
    expect(result.status, result.stderr).toBe(0);
    expect(readStore(root)).toEqual({
      'a.one': 'Line one\n\n  indented line',
      'a.two': '\nEdged ',
      'b.schema': '{"type":"object","properties":{}}',
    });
  });

  it.each([
    ['a duplicate key', { 'a.md': '<!-- @key k -->\nA\n', 'b.md': '<!-- @key k -->\nB\n' }, /duplicate key k/],
    ['an empty body', { 'a.md': '<!-- @key k -->\n\n<!-- @key j -->\nJ\n' }, /empty body/],
    ['an unmarked edge space', { 'a.md': '<!-- @key k -->\n Text\n' }, /use lead=/],
    ['text before the first marker', { 'a.md': 'Stray\n<!-- @key k -->\nA\n' }, /before the first/],
  ])('reject %s', (_label, sources, message) => {
    const result = runGenerator(scratchRoot(sources));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
  });
});
