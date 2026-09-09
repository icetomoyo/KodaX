import { createHash, type Hash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RuntimeBuildIdentity {
  readonly origin: string;
  readonly fingerprint: string;
}

/** Resolve the Host this installation actually launches, including split SDK bundles. */
export function resolveDaemonCliEntry(
  moduleUrl = import.meta.url,
  bundled = process.env.KODAX_BUNDLED === 'true',
): string | undefined {
  if (bundled) return undefined;
  const current = fileURLToPath(moduleUrl);
  const directory = path.dirname(current);
  if (current.endsWith('.ts')) return path.join(directory, 'kodax_cli.ts');
  return path.join(path.basename(directory) === 'chunks' ? path.dirname(directory) : directory, 'kodax_cli.js');
}

const OMITTED_DIRECTORIES = new Set(['.git', 'node_modules', 'docs', 'tests', '__tests__', 'types-chunks', 'binary']);
function isRuntimeFile(file: string): boolean {
  return !(/\.(?:test|spec)\.[^.]+$|\.d\.[cm]?ts$|\.map$|\.tsbuildinfo$/u.test(file)
    || /^(?:bundle-meta|bun-build-metadata)\.json$/u.test(file)
    || /^(?:README|CHANGELOG|LICENSE|NOTICE)(?:[.-]|$)/iu.test(file));
}

function collectRuntimeFiles(directory: string, files: Set<string>, ancestors = new Set<string>()): void {
  const realDirectory = realpathSync(directory);
  if (ancestors.has(realDirectory)) throw new Error(`Runtime build contains a directory cycle: ${directory}`);
  const nextAncestors = new Set(ancestors).add(realDirectory);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const metadata = entry.isSymbolicLink() ? statSync(file) : entry;
    if (metadata.isDirectory()) {
      if (!OMITTED_DIRECTORIES.has(entry.name)) collectRuntimeFiles(file, files, nextAncestors);
    } else if (metadata.isFile() && isRuntimeFile(entry.name)) files.add(file);
  }
}

function addOptionalFileOrDirectory(file: string, files: Set<string>): void {
  const metadata = statSync(file, { throwIfNoEntry: false });
  if (metadata?.isDirectory()) collectRuntimeFiles(file, files);
  else if (metadata?.isFile()) files.add(file);
}

function hashRuntimeFile(hash: Hash, file: string, relative: string, buffer: Buffer): void {
  const descriptor = openSync(file, 'r');
  try {
    hash.update(`${relative}\0${fstatSync(descriptor).size}\0`);
    let bytes: number;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { closeSync(descriptor); }
}

/** Read only installed runtime code/assets, never the selected user's configuration. */
export function readRuntimeBuildIdentity(
  entry = resolveDaemonCliEntry() ?? process.execPath,
): RuntimeBuildIdentity {
  const resolvedEntry = realpathSync(entry);
  const source = resolvedEntry.endsWith('.ts');
  const moduleBundle = resolvedEntry.endsWith('.js');
  const entryDirectory = path.dirname(resolvedEntry);
  const installation = source || moduleBundle ? path.dirname(entryDirectory) : entryDirectory;
  const files = new Set<string>([resolvedEntry]);
  if (source || moduleBundle) {
    collectRuntimeFiles(entryDirectory, files);
    files.add(path.join(installation, 'package.json'));
    for (const relative of ['package-lock.json', 'config-templates', 'scripts/production-env.cjs', 'scripts/kodax-bin.cjs']) {
      addOptionalFileOrDirectory(path.join(installation, relative), files);
    }
    if (source) {
      // Source CLI still loads compiled native artifacts from these candidates.
      const nativeDirectory = `${process.platform}-${process.arch}`;
      for (const relative of ['native', 'dist/native']) {
        addOptionalFileOrDirectory(path.join(installation, relative, nativeDirectory), files);
      }
      for (const name of ['llm', 'agent', 'coding', 'repl']) {
        const packageRoot = path.join(installation, 'packages', name);
        files.add(path.join(packageRoot, 'package.json'));
        collectRuntimeFiles(path.join(packageRoot, 'dist'), files);
      }
    }
  } else {
    for (const relative of ['builtin', 'vendor', 'native', 'provider-capabilities.json',
      'semantic-worker.js', 'constructed-handler-worker.js', 'sandbox-network-broker.js']) {
      addOptionalFileOrDirectory(path.join(installation, relative), files);
    }
  }
  const hash = createHash('sha256');
  const sorted = [...files].map(file => ({ file, relative: path.relative(installation, file).replaceAll('\\', '/') }))
    .sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (const { file, relative } of sorted) hashRuntimeFile(hash, file, relative, buffer);
  return { origin: process.platform === 'win32' ? resolvedEntry.toLowerCase() : resolvedEntry,
    fingerprint: hash.digest('hex') };
}

// The running module's identity must never become the identity of replacement files.
export const LOCAL_RUNTIME_BUILD: RuntimeBuildIdentity = Object.freeze(readRuntimeBuildIdentity());
