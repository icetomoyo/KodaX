import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string): string => readFileSync(resolve(relativePath), 'utf8');

function resolveLocalImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const unresolved = resolve(dirname(importer), specifier);
  const candidates = extname(unresolved) === '.js'
    ? [`${unresolved.slice(0, -3)}.ts`]
    : extname(unresolved) === ''
      ? [`${unresolved}.ts`, resolve(unresolved, 'index.ts')]
      : [unresolved];
  return candidates.find(existsSync);
}

interface DependencyClosure {
  readonly files: ReadonlySet<string>;
  readonly externalSpecifiers: ReadonlySet<string>;
}

function localDependencyClosure(entries: readonly string[]): DependencyClosure {
  const pending = entries.map((entry) => resolve(entry));
  const visited = new Set<string>();
  const externalSpecifiers = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const source = readFileSync(current, 'utf8');
    const specifiers = [
      ...source.matchAll(/\b(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((match) => match[1]!);
    for (const specifier of specifiers) {
      const dependency = resolveLocalImport(current, specifier);
      if (dependency !== undefined) pending.push(dependency);
      else externalSpecifiers.add(specifier);
    }
  }
  return { files: visited, externalSpecifiers };
}

describe('FEATURE_295 trusted text-tool production boundary', () => {
  it('routes every controlled text tool through the trusted text transaction seam', () => {
    for (const tool of ['write', 'edit', 'multi-edit', 'insert-after-anchor', 'undo']) {
      expect(readSource(`packages/coding/src/tools/${tool}.ts`), tool)
        .toContain('withTextFileMutation');
    }
  });

  it('keeps the trusted text transaction outside filesystem-effect leases', () => {
    const source = readSource(
      'packages/coding/src/tools/_internal/text-file-mutation.ts',
    );

    for (const forbidden of [
      'KodaXTextFileMutationSandbox',
      'textFileMutationSandbox',
      'withFileMutation',
      'withHostFileSystemMutation',
      'acquireFileSystemMutationLease',
      'fileSystemEffectLease',
      'withSandboxedFileMutation',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('keeps the production text-tool dependency closure outside shell and effect modules', () => {
    const graph = localDependencyClosure([
      'packages/coding/src/tools/write.ts',
      'packages/coding/src/tools/edit.ts',
      'packages/coding/src/tools/multi-edit.ts',
      'packages/coding/src/tools/insert-after-anchor.ts',
      'packages/coding/src/tools/undo.ts',
    ]);
    const relativeGraph = [...graph.files].map((file) => (
      file.slice(resolve('.').length + 1).replaceAll('\\', '/')
    ));

    expect(relativeGraph).toContain(
      'packages/coding/src/tools/_internal/text-file-mutation.ts',
    );
    expect(relativeGraph).toContain(
      'packages/coding/src/tools/_internal/file-mutation-primitives.ts',
    );
    for (const forbidden of [
      'packages/coding/src/tools/_internal/file-mutation-queue.ts',
      'packages/coding/src/tools/bash.ts',
      'src/sandbox-runtime.ts',
      'src/windows-sandbox-v2.ts',
    ]) {
      expect(relativeGraph, forbidden).not.toContain(forbidden);
    }
    expect([...graph.externalSpecifiers]).not.toContain('@anthropic-ai/sandbox-runtime');
    for (const file of graph.files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\brequire\s*\(/);
      expect(source, file).not.toContain('createRequire');
    }
  });

  it('keeps the concrete Windows text provider outside the shell provider graph', () => {
    const graph = localDependencyClosure(['src/windows-text-transaction.ts']);
    const relativeGraph = [...graph.files].map((file) => (
      file.slice(resolve('.').length + 1).replaceAll('\\', '/')
    ));

    expect(relativeGraph).toEqual(expect.arrayContaining([
      'src/windows-text-transaction.ts',
      'src/windows-native-artifacts.ts',
    ]));
    expect(relativeGraph).not.toContain('src/windows-sandbox-v2.ts');
    expect(relativeGraph).not.toContain('src/sandbox-runtime.ts');
    expect([...graph.externalSpecifiers]).not.toContain('@anthropic-ai/sandbox-runtime');

    const provider = readSource('src/windows-text-transaction.ts');
    expect(provider).toContain("require(bindingPath)");
    expect(provider).not.toContain('resolveWindowsSandboxV2Executable');
    expect(provider).not.toContain('createAsrtShellSandbox');
  });

  it('wires the concrete trusted provider into Runtime-owned tool context', () => {
    const sdk = readSource('src/sdk-runtime.ts');

    expect(sdk).toContain('createTrustedTextMutationHost(');
    expect(sdk).toContain('{ trustedTextMutationHost }');
    expect(sdk).not.toContain('createAsrtTextFileMutationSandbox');
  });

  it('wires every KodaX-owned direct coding entry to the same native authority', () => {
    const entry = readSource('src/trusted-coding-entry.ts');
    const root = readSource('src/index.ts');
    const coding = readSource('src/sdk-coding.ts');
    const cli = readSource('src/kodax_cli.ts');

    expect(entry).toContain('createTrustedTextMutationHost(');
    expect(entry).toContain('workspaceSandboxRoots?.list()');
    expect(entry).toContain('createCodingKodaXTaskRunner({');
    expect(entry).not.toContain('createAsrt');
    for (const source of [root, coding]) {
      for (const name of [
        'Client',
        'createDefaultCodingAgent',
        'createKodaXTaskRunner',
        'KodaXClient',
        'runKodaX',
        'runManagedTask',
        'startKodaX',
      ]) expect(source).toContain(name);
      expect(source).toContain("from './trusted-coding-entry.js'");
    }
    expect(cli).toContain("from './trusted-coding-entry.js'");
    expect(cli).toContain('runManagedTask');
  });

  it('does not expose or propagate a text sandbox capability', () => {
    const productionSources = [
      'packages/coding/src/types.ts',
      'packages/coding/src/index.ts',
      'packages/coding/src/agent-runtime/tool-execution-context.ts',
      'packages/coding/src/child-executor.ts',
      'src/sdk-runtime.ts',
    ].map(readSource).join('\n');

    expect(productionSources).not.toContain('KodaXTextFileMutationSandbox');
    expect(productionSources).not.toContain('textFileMutationSandbox');
    expect(productionSources).not.toContain('createAsrtTextFileMutationSandbox');
  });

  it('keeps retired text-sandbox request types out of the public coding API', () => {
    const publicIndex = readSource('packages/coding/src/index.ts');

    expect(publicIndex).not.toContain('KodaXTextFileMutationRequest');
    expect(publicIndex).not.toContain('KodaXTextFileSnapshot');
    expect(publicIndex).not.toContain('KodaXTrustedTextMutationBackupReceipt');
  });

  it('has no ASRT text-mutation helper or production factory', () => {
    const source = readSource('src/sandbox-runtime.ts');

    expect(source).not.toContain('TEXT_FILE_MUTATION_HELPER');
    expect(source).not.toContain('createAsrtTextFileMutationSandbox');
  });
});
