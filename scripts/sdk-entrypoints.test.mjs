import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sdkEntriesFromPackage } from './sdk-entrypoints.mjs';

test('builds every published JS and type entry from the same manifest', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const entries = sdkEntriesFromPackage(pkg);
  assert.equal(Object.keys(entries).length, 14);
  assert.equal(entries['sdk-runtime'], 'src/sdk-runtime-public.ts');
  for (const source of Object.values(entries)) assert.ok(readFileSync(new URL(`../${source}`, import.meta.url)).length > 0);
});

test('rejects type/JS drift and duplicate or escaping entry targets', () => {
  const valid = { types: './dist/sdk-client.d.ts', import: './dist/sdk-client.js' };
  for (const exports of [
    { './client': { ...valid, types: './dist/sdk-runtime.d.ts' } },
    { './client': valid, './second': valid },
    { './client': { ...valid, import: '../../other.js' } },
  ]) assert.throws(() => sdkEntriesFromPackage({ exports }), /Invalid or duplicate SDK export/);
});
