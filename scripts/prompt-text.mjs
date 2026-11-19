#!/usr/bin/env node
// Compiles packages/coding/src/prompts/text/ into static-text.json, the packaged
// prompt store read by staticText(). Edit the sources, then run `npm run prompts:text`;
// `--check` (`npm run prompts:text:check`) reports drift without writing.
//
// Sources mirror their consumer: text for `tools/read.ts` lives in `text/tools/read.md`.
// A `.md` file is a sequence of entries:
//
//   <!-- @key some.key -->
//   Body text, kept byte-exact (CRLF read as LF).
//
// A body runs to the next marker; blank lines before it are separators. Bodies never
// start or end with whitespace. A value that does carries it in the marker as JSON
// strings: <!-- @key some.key lead="\n" trail=" " -->.
// A `.json` file maps keys to JSON values, stored as compact JSON text (tool schemas).

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textDir = path.join(root, 'packages/coding/src/prompts/text');
const output = path.join(root, 'packages/coding/src/prompts/static-text.json');

const MARKER = /^<!-- @key ([A-Za-z0-9._/-]+)((?: (?:lead|trail)="(?:[^"\\]|\\.)*")*) -->$/;
const ATTRIBUTE = / (lead|trail)=("(?:[^"\\]|\\.)*")/g;
const normalizeLineEndings = (content) => content.replace(/\r\n?/g, '\n');

async function listSources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listSources(full) : [full];
  }));
  return files.flat().filter(file => /\.(md|json)$/.test(file)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function parseEdges(attributes, where) {
  const edges = { lead: '', trail: '' };
  for (const [, name, quoted] of attributes.matchAll(ATTRIBUTE)) {
    const value = JSON.parse(quoted);
    if (!/^\s+$/.test(value)) throw new Error(`${where}: ${name} must be whitespace only`);
    edges[name] = value;
  }
  return edges;
}

function parseMarkdown(content, file) {
  const lines = normalizeLineEndings(content).split('\n');
  const entries = [];
  let current;
  for (const [index, line] of lines.entries()) {
    const marker = MARKER.exec(line);
    if (marker) {
      current = { key: marker[1], ...parseEdges(marker[2], `${file}:${index + 1}`), lines: [], line: index + 1 };
      entries.push(current);
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim() !== '') {
      throw new Error(`${file}:${index + 1}: text before the first <!-- @key --> marker`);
    }
  }
  return entries.map(({ key, lead, trail, lines: body, line }) => {
    const text = body.join('\n').replace(/\n+$/, '');
    const where = `${file}:${line} (${key})`;
    if (text === '') throw new Error(`${where}: empty body`);
    if (/^\s|\s$/.test(text)) throw new Error(`${where}: body starts or ends with whitespace; use lead="..." or trail="..."`);
    return [key, lead + text + trail];
  });
}

function parseJson(content, file) {
  const data = JSON.parse(content);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file}: expected an object of keys`);
  return Object.entries(data).map(([key, value]) => [key, JSON.stringify(value)]);
}

export async function compilePromptText() {
  const store = {};
  for (const file of await listSources(textDir)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const content = await readFile(file, 'utf8');
    const entries = file.endsWith('.md') ? parseMarkdown(content, relative) : parseJson(content, relative);
    for (const [key, value] of entries) {
      if (Object.hasOwn(store, key)) throw new Error(`${relative}: duplicate key ${key}`);
      store[key] = value;
    }
  }
  return JSON.stringify(store, null, 2) + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expected = await compilePromptText();
  let current = '';
  try {
    current = normalizeLineEndings(await readFile(output, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (current !== expected) {
    if (process.argv.includes('--check')) {
      process.stderr.write(`[prompt-text] drift: ${path.relative(root, output)}; run node scripts/prompt-text.mjs\n`);
      process.exitCode = 1;
    } else {
      await writeFile(output, expected, 'utf8');
    }
  }
}
