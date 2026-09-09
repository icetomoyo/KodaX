import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { readRuntimeBuildIdentity, resolveDaemonCliEntry } from './runtime-build-identity.js';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function installation(kind: 'src' | 'dist' | 'binary' = 'src'): { root: string; entry: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kodax-build-identity-'));
  temporary.push(root);
  const put = (relative: string, content = 'export {};'): void => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  put('package.json', '{"name":"@kodax-ai/kodax","version":"1.0.0","type":"module"}');
  put('package-lock.json', '{"lockfileVersion":3}');
  const entry = kind === 'binary' ? path.join(root, 'kodax.exe') : path.join(root, kind, `kodax_cli.${kind === 'src' ? 'ts' : 'js'}`);
  put(path.relative(root, entry));
  if (kind === 'src') {
    for (const name of ['llm', 'agent', 'coding', 'repl']) {
      put(`packages/${name}/dist/index.js`);
      put(`packages/${name}/package.json`, `{"name":"@kodax-ai/${name}"}`);
    }
    put('scripts/production-env.cjs');
    put('scripts/kodax-bin.cjs');
  }
  return { root, entry };
}

it('hashes production bytes rather than mtime, tests, source maps or declarations', () => {
  const { root, entry } = installation();
  const before = readRuntimeBuildIdentity(entry);
  utimesSync(entry, new Date(1), new Date(1));
  for (const suffix of ['test.ts', 'spec.ts', 'd.ts', 'js.map']) writeFileSync(path.join(root, 'src', `ignored.${suffix}`), 'changed');
  expect(readRuntimeBuildIdentity(entry)).toEqual(before);
  writeFileSync(path.join(root, 'packages/coding/dist/index.js'), 'export const changed = 1;');
  expect(readRuntimeBuildIdentity(entry).fingerprint).not.toBe(before.fingerprint);
});

it('includes dist code, native assets and builtin instructions, excluding build reports and binary outputs', () => {
  const { root, entry } = installation('dist');
  const before = readRuntimeBuildIdentity(entry);
  writeFileSync(path.join(root, 'dist/bundle-meta.json'), '{"generatedAt":"changed"}');
  mkdirSync(path.join(root, 'dist/binary'), { recursive: true });
  writeFileSync(path.join(root, 'dist/binary/kodax.exe'), 'unrelated');
  expect(readRuntimeBuildIdentity(entry)).toEqual(before);
  for (const asset of ['chunks/runtime.js', 'native/test/addon.node', 'builtin/test/SKILL.md', 'provider-capabilities.json']) {
    const previous = readRuntimeBuildIdentity(entry);
    const file = path.join(root, 'dist', asset);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'runtime asset');
    expect(readRuntimeBuildIdentity(entry).fingerprint).not.toBe(previous.fingerprint);
  }
});

it('includes source-mode native artifacts without treating unrelated root bundles as loaded code', () => {
  const { root, entry } = installation();
  const before = readRuntimeBuildIdentity(entry);
  const nativeDirectory = `${process.platform}-${process.arch}`;
  mkdirSync(path.join(root, 'dist/native', nativeDirectory), { recursive: true });
  mkdirSync(path.join(root, 'native/windows-sandbox-v2/target'), { recursive: true });
  writeFileSync(path.join(root, 'native/windows-sandbox-v2/target/build-cache'), 'not loaded native code');
  writeFileSync(path.join(root, 'dist/sdk-runtime.js'), 'unrelated bundled SDK');
  expect(readRuntimeBuildIdentity(entry)).toEqual(before);
  writeFileSync(path.join(root, 'dist/native', nativeDirectory, 'transaction.node'), 'actual source-mode native code');
  expect(readRuntimeBuildIdentity(entry).fingerprint).not.toBe(before.fingerprint);
});

it('distinguishes installation origins while identical copies retain the same content fingerprint', () => {
  const first = installation();
  const second = installation();
  expect(readRuntimeBuildIdentity(first.entry).origin).not.toBe(readRuntimeBuildIdentity(second.entry).origin);
  expect(readRuntimeBuildIdentity(first.entry).fingerprint).toBe(readRuntimeBuildIdentity(second.entry).fingerprint);
  expect(readRuntimeBuildIdentity(path.join(first.root, 'src/../src/kodax_cli.ts'))).toEqual(readRuntimeBuildIdentity(first.entry));
  expect(resolveDaemonCliEntry(pathToFileURL(path.join(first.root, 'src/runtime-build-identity.ts')).href, false)).toBe(first.entry);
  const dist = path.join(first.root, 'dist/kodax_cli.js');
  expect(resolveDaemonCliEntry(pathToFileURL(path.join(first.root, 'dist/chunks/runtime.js')).href, false)).toBe(dist);
  expect(resolveDaemonCliEntry(pathToFileURL(path.join(first.root, 'dist/sdk-runtime.js')).href, false)).toBe(dist);
  expect(resolveDaemonCliEntry(undefined, true)).toBeUndefined();
});

it('hashes the standalone executable and its sidecars', () => {
  const { root, entry } = installation('binary');
  const first = readRuntimeBuildIdentity(entry);
  writeFileSync(entry, 'new executable bytes');
  const second = readRuntimeBuildIdentity(entry);
  expect(second.fingerprint).not.toBe(first.fingerprint);
  writeFileSync(path.join(root, 'semantic-worker.js'), 'new worker bytes');
  expect(readRuntimeBuildIdentity(entry).fingerprint).not.toBe(second.fingerprint);
  const executable = Buffer.alloc(200_000, 7);
  writeFileSync(entry, executable);
  const large = readRuntimeBuildIdentity(entry);
  executable[executable.length - 1] = 8;
  writeFileSync(entry, executable);
  expect(readRuntimeBuildIdentity(entry).fingerprint).not.toBe(large.fingerprint);
});

it('throws on missing runtime files rather than publishing an unknown or partial identity', () => {
  const { root, entry } = installation();
  rmSync(path.join(root, 'packages/coding/dist'), { recursive: true });
  expect(() => readRuntimeBuildIdentity(entry)).toThrow();
  expect(() => readRuntimeBuildIdentity(path.join(root, 'missing.ts'))).toThrow();
});

it('freezes the loaded identity while a later disk read detects changed installed code', () => {
  const { root, entry } = installation();
  const modulePath = path.join(root, 'src/runtime-build-identity.ts');
  copyFileSync(fileURLToPath(new URL('./runtime-build-identity.ts', import.meta.url)), modulePath);
  const script = `
    import { writeFileSync } from 'node:fs';
    const loaded = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    const before = loaded.LOCAL_RUNTIME_BUILD;
    writeFileSync(${JSON.stringify(entry)}, 'export const changed = true;');
    const after = loaded.readRuntimeBuildIdentity();
    process.stdout.write(JSON.stringify({ frozen: Object.isFrozen(before),
      same: before === loaded.LOCAL_RUNTIME_BUILD, changed: before.fingerprint !== after.fingerprint }));
  `;
  const result = execFileSync(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, '--input-type=module', '-e', script],
    { encoding: 'utf8', env: { ...process.env, KODAX_BUNDLED: 'false' } });
  expect(JSON.parse(result)).toEqual({ frozen: true, same: true, changed: true });
});
