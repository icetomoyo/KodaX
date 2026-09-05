#!/usr/bin/env node
// .d.ts bundler for SDK exports (v0.7.41).
//
// Replaces the trailing `tsc --emitDeclarationOnly` step in `npm run build`.
//
// Why: tsc --emitDeclarationOnly emits dist/index.d.ts and dist/sdk-*.d.ts as
// literal pass-throughs:
//   `export * from '@kodax-ai/coding'`
// The published @kodax-ai/kodax tarball does NOT ship the internal @kodax-ai/*
// sub-packages (esbuild already inlined them into dist/*.js), so consumer-side
// `tsc` reading those .d.ts files fails to resolve @kodax-ai/coding etc. with
// "no exported member" — even though the runtime import works.
//
// Fix: bundle the SDK entry .d.ts the same way esbuild bundles their .js,
// using rollup-plugin-dts with code-splitting. The output is self-contained:
// no residual @kodax-ai/* imports, only third-party externals stay as imports
// (consumers npm-install those anyway via root package.json#dependencies).
//
// Outputs (overwriting tsc's prior emit):
//   dist/index.d.ts
//   dist/sdk-agent.d.ts
//   dist/sdk-llm.d.ts
//   dist/sdk-coding.d.ts
//   dist/sdk-media.d.ts
//   dist/sdk-repl.d.ts
//   dist/sdk-skills.d.ts
//   dist/sdk-mcp.d.ts
//   dist/sdk-session.d.ts
//   dist/sdk-runtime.d.ts
//   dist/sdk-sandbox.d.ts
//   dist/types-chunks/*.d.ts     ← shared chunks (mirrors esbuild splitting)
//
// External list mirrors build-bundle.mjs: anything in root dependencies stays
// as a bare `import { X } from 'pkg'` in the bundled .d.ts (third-party types
// resolve via consumer node_modules). Node built-ins also external.
//
// See docs/ADR.md ADR-022 + ADR-024 for the SDK distribution architecture.

import { rollup } from 'rollup';
import { execFileSync } from 'node:child_process';
import dts from 'rollup-plugin-dts';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');

function log(msg) {
  console.log(`[build-dts] ${msg}`);
}

const rootPkg = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);
const thirdPartyDeps = new Set(Object.keys(rootPkg.dependencies || {}));

// External callback: bundle internal @kodax-ai/* + relative imports; everything
// else (third-party + Node built-ins) stays as an external `import` in the
// bundled .d.ts (consumer-side npm install resolves them).
function isExternal(id) {
  // Relative or absolute path imports → bundle (these resolve through the
  // workspace, including @kodax-ai/* symlinks under node_modules/).
  if (id.startsWith('.') || path.isAbsolute(id)) return false;

  // Internal sub-packages → bundle inline. The tarball does NOT ship them, so
  // their types MUST be inlined into dist/*.d.ts.
  if (id.startsWith('@kodax-ai/')) return false;

  // Node built-ins → external (consumer's tsc resolves via @types/node).
  if (id.startsWith('node:') || isBuiltin(id)) return true;

  // Third-party: bare specifier matching root deps (or its subpath like
  // `react/jsx-runtime`) → external. Consumer npm-installs them.
  const root = id.startsWith('@')
    ? id.split('/').slice(0, 2).join('/')
    : id.split('/')[0];
  return thirdPartyDeps.has(root);
}

const sdkEntries = {
  index: 'src/index.ts',
  'sdk-agent': 'src/sdk-agent.ts',
  'sdk-llm': 'src/sdk-llm.ts',
  'sdk-coding': 'src/sdk-coding.ts',
  'sdk-media': 'src/sdk-media.ts',
  'sdk-repl': 'src/sdk-repl.ts',
  'sdk-skills': 'src/sdk-skills.ts',
  'sdk-mcp': 'src/sdk-mcp.ts',
  'sdk-session': 'src/sdk-session.ts',
  'sdk-runtime': 'src/sdk-runtime.ts',
  'sdk-client': 'src/sdk-client.ts',
  'sdk-sandbox': 'src/sdk-sandbox.ts',
  'sdk-a2a': 'src/sdk-a2a.ts',
  'sdk-experimental-memory': 'src/sdk-experimental-memory.ts',
};

const internalSubpathDtsResolver = {
  name: 'internal-subpath-dts-resolver',
  resolveId(id) {
    if (id === '@kodax-ai/coding/client-contract') {
      return path.join(repoRoot, 'packages/coding/src/client-contract.ts');
    }
    if (id === '@kodax-ai/agent/experimental-memory') {
      return path.join(repoRoot, 'packages/agent/src/experimental-memory/index.ts');
    }
    if (id === '@kodax-ai/agent/memory-control') {
      return path.join(repoRoot, 'packages/agent/src/memory-control/index.ts');
    }
    if (id === '@kodax-ai/agent/media') {
      return path.join(repoRoot, 'packages/agent/src/media/index.ts');
    }
    if (id === '@kodax-ai/coding/media') {
      return path.join(repoRoot, 'packages/coding/src/media/index.ts');
    }
    return null;
  },
};

// Clean prior tsc emit so stale per-file .d.ts (acp_*.d.ts, cli_commands.d.ts,
// kodax_cli.d.ts, *.test.d.ts) don't ship. Only SDK entries + chunks
// remain after this script.
function cleanStaleEmit() {
  log('Cleaning stale dist/*.d.ts (prior tsc emit)…');
  // dist/ is created by build:bundle, which CI does not run (it runs
  // build:packages → build:dts only, to catch missing SDK exports). rollup's
  // bundle.write() below mkdir's dist/ itself, so a missing dist/ here just
  // means there is no prior emit to clean — skip rather than ENOENT.
  if (!existsSync(distDir)) {
    log('  ✓ no existing dist/ — nothing to clean');
    return;
  }
  let removed = 0;
  for (const entry of readdirSync(distDir)) {
    const full = path.join(distDir, entry);
    if (!statSync(full).isFile()) continue;
    if (entry.endsWith('.d.ts') || entry.endsWith('.d.ts.map')) {
      unlinkSync(full);
      removed += 1;
    }
  }
  // Also nuke prior types-chunks/ (if a prior build left a partial set).
  rmSync(path.join(distDir, 'types-chunks'), { recursive: true, force: true });
  log(`  ✓ removed ${removed} stale top-level *.d.ts file(s)`);
}

async function main() {
  cleanStaleEmit();

  log(`Bundling ${Object.keys(sdkEntries).length} SDK entry types…`);

  const bundle = await rollup({
    input: Object.fromEntries(
      Object.entries(sdkEntries).map(([name, p]) => [
        name,
        path.join(repoRoot, p),
      ]),
    ),
    external: isExternal,
    // respectExternal: don't try to inline third-party type definitions even
    // if they happen to be resolvable on disk. Keeps the bundle scoped to
    // first-party (@kodax-ai/*) + local src code.
    plugins: [internalSubpathDtsResolver, dts({ respectExternal: true })],
    // Silence Rollup's "unused external import" warnings only — type
    // re-exports legitimately produce these (e.g. `export type { X } from
    // 'pkg'` where X is the only consumer). Do NOT silence other warnings
    // (especially EMPTY_BUNDLE) — those signal real bugs (entry produced
    // zero output) and must be surfaced.
    onwarn(warning, warn) {
      if (warning.code === 'UNUSED_EXTERNAL_IMPORT') return;
      warn(warning);
    },
  });

  await bundle.write({
    dir: distDir,
    format: 'es',
    entryFileNames: '[name].d.ts',
    chunkFileNames: 'types-chunks/[name]-[hash].d.ts',
  });
  await bundle.close();

  // Report sizes — failing on missing entry catches incomplete bundle output
  // that rollup might emit silently if a plugin misbehaves.
  for (const name of Object.keys(sdkEntries)) {
    const p = path.join(distDir, `${name}.d.ts`);
    const bytes = statSync(p).size;
    log(`  ✓ dist/${name}.d.ts (${(bytes / 1024).toFixed(1)} kB)`);
  }

  // Hard assertion: every entry .d.ts must be self-contained (no `@kodax-ai/*`
  // bare-specifier imports). Such an import would only resolve at consumer-side
  // tsc if the consumer happened to have @kodax-ai/* installed — but the
  // published tarball does NOT ship them (esbuild already inlined the .js).
  // Pre-FEATURE_150 v0.7.40 release shipped this leak; v0.7.41 added this
  // bundler. This assertion is the structural guard so it can never regress
  // silently — any future build-dts edit that fails to inline `@kodax-ai/*`
  // types fails the build instead of producing a broken tarball.
  const INTERNAL_IMPORT_PATTERN = /from\s+['"]@kodax-ai\//;

  // Self-test the pattern against known shapes so a future regex edit that
  // breaks detection fails the build BEFORE producing a green check on
  // legitimately-clean output. Cheap (microseconds), catches regex drift.
  const POSITIVE_SAMPLES = [
    "export * from '@kodax-ai/coding';",
    `import { X } from "@kodax-ai/repl";`,
    "import {a, b} from   '@kodax-ai/llm';",
  ];
  const NEGATIVE_SAMPLES = [
    "import { K as KodaXBaseProvider } from './types-chunks/cost-tracker.d-BENnrGlF.js';",
    "// reference to @kodax-ai/foo in a comment is fine",
    "const s = '@kodax-ai/llm';",
  ];
  for (const s of POSITIVE_SAMPLES) {
    if (!INTERNAL_IMPORT_PATTERN.test(s)) {
      console.error(`[build-dts] ERROR: INTERNAL_IMPORT_PATTERN self-test failed (false negative): ${s}`);
      process.exit(1);
    }
  }
  for (const s of NEGATIVE_SAMPLES) {
    if (INTERNAL_IMPORT_PATTERN.test(s)) {
      console.error(`[build-dts] ERROR: INTERNAL_IMPORT_PATTERN self-test failed (false positive): ${s}`);
      process.exit(1);
    }
  }

  const violations = [];
  for (const name of Object.keys(sdkEntries)) {
    const p = path.join(distDir, `${name}.d.ts`);
    const content = await readFile(p, 'utf8');
    if (INTERNAL_IMPORT_PATTERN.test(content)) {
      const sample = content.match(INTERNAL_IMPORT_PATTERN)?.[0] ?? '<unknown>';
      violations.push({ entry: `dist/${name}.d.ts`, sample });
    }
  }
  if (violations.length > 0) {
    console.error('[build-dts] ERROR: bundled .d.ts entries leak internal @kodax-ai/* imports:');
    for (const v of violations) {
      console.error(`  - ${v.entry}: ${v.sample}`);
    }
    console.error('[build-dts] The published tarball does NOT ship @kodax-ai/* sub-packages.');
    console.error('[build-dts] Consumer-side tsc will fail to resolve these imports.');
    console.error('[build-dts] Fix: ensure isExternal() in this script bundles all @kodax-ai/* IDs.');
    process.exit(1);
  }

  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules/typescript/bin/tsc'),
    '-p', path.join(repoRoot, 'tests/fixtures/product-client-types/tsconfig.json'),
  ], { stdio: 'inherit', windowsHide: true });
  log('Done. SDK types are self-contained; product Client compiles without Node ambient types.');
}

main().catch((err) => {
  console.error('[build-dts] ERROR', err.stack || err.message);
  process.exit(1);
});
