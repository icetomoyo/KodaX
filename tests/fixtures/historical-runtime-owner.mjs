import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Exact historical owner-policy implementations, not a simulated old SDK. The
// package barrel aliases below select their original process/credential exports;
// every executed implementation and relative dependency comes from this commit.
// This proves the owner-policy boundary, not a complete old daemon installation.
const common = {
  'packages/agent/src/diagnostics.ts': '736486072df931fefe5fcc1cda9e5c316c6b82c0054c19ebf7a459b315bbf8f3',
  'packages/llm/src/providers/rejected-image.ts': '33cf6c9d569b130194b2bd88a05f70c25a867f09588b897987ec135f6c505c2c',
};
export const HISTORICAL_OWNERS = [
  {
    version: 'v0.7.96', revision: 'c2c8fdc41f4e0b50fa1c2d0b24142586f155777c',
    hashes: {
      ...common,
      'src/runtime-daemon/state.ts': '25f8d16561b726893dc401fb8c712293048d85f0d86c6e0404967ec9db97c859',
      'packages/agent/src/runtime/process-tree.ts': '06acb3e11bed359ab26d6fb1b29a498daffd979b4794d94428ed44ae02b39ece',
      'packages/llm/src/provider-credential-context.ts': '7e1ad58c9ae57661d61c3cfd22b9989f7d4551ef23bb2b962ef1b661d1da6cf6',
    },
  },
  {
    version: 'v0.7.97-alpha.11', revision: '0f3930e95e0286fd360826cf14f6f5c0d63d0fa5',
    hashes: {
      ...common,
      'src/runtime-daemon/state.ts': 'c74d4d351e45849f819e61c10768c0e7b1630839299d0e6899a3482b93ff1a34',
      'packages/agent/src/runtime/process-tree.ts': '757ac529d536b4a79a0bc6aba96e44daafb0ccca90ff3e1c1505830ed3edeb0c',
      'packages/llm/src/provider-credential-context.ts': 'b66013888c4203ef198cdb61d118e768e812eb00612975b30c46ef737c318973',
      'packages/llm/src/provider-request-observation.ts': '1192bf287d66c2c25c1d2b255a86937c4482717fbc74bcf0c8b8b1525d1e6e1a',
    },
  },
];

export async function loadHistoricalOwner(snapshot, directory) {
  const repository = path.resolve(import.meta.dirname, '../..');
  const outfile = path.join(directory, `owner-${snapshot.version}.mjs`);
  const aliases = {
    '@kodax-ai/agent': 'packages/agent/src/runtime/process-tree.ts',
    '@kodax-ai/llm': 'packages/llm/src/provider-credential-context.ts',
  };
  await build({
    entryPoints: ['src/runtime-daemon/state.ts'], outfile, bundle: true,
    platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
    plugins: [{ name: 'pinned-historical-source', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path.startsWith('node:')) return { path: args.path, external: true };
        const source = aliases[args.path] ?? (args.kind === 'entry-point' ? path.posix.normalize(args.path)
          : path.posix.normalize(path.posix.join(path.posix.dirname(args.importer), args.path)).replace(/\.js$/, '.ts'));
        assert.ok(snapshot.hashes[source], `Unpinned historical dependency: ${source}`);
        return { path: source, namespace: 'historical' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'historical' }, args => {
        let bytes;
        try {
          bytes = execFileSync('git', ['show', `${snapshot.revision}:${args.path}`], {
            cwd: repository, windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
          });
        } catch (cause) {
          throw new Error(`Historical regression requires Git commit ${snapshot.revision}; make that exact revision available before running this test.`, { cause });
        }
        assert.equal(createHash('sha256').update(bytes).digest('hex'), snapshot.hashes[args.path]);
        return { contents: bytes.toString('utf8'), loader: 'ts' };
      });
    } }],
  });
  return import(pathToFileURL(outfile).href);
}
