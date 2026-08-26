#!/usr/bin/env node
// FEATURE_150 (v0.7.37) — npm distribution bundle builder.
// ADR-024 (v0.7.39) — SDK subpath exports added (agent / llm / coding / repl / skills).
// Later releases added mcp / session / media subpaths.
//
// Produces the following artifacts under dist/:
//   1. dist/kodax_bootstrap.js — lightweight CLI entry (bin command runs this)
//   2. dist/kodax_resume.js  — bare-resume discovery and picker
//   3. dist/kodax_cli.js     — full CLI entry (self-contained)
//   4. dist/index.js         — SDK root entry (`@kodax-ai/kodax`)
//   5. dist/sdk-agent.js     — SDK subpath `@kodax-ai/kodax/agent`
//   6. dist/sdk-llm.js       — SDK subpath `@kodax-ai/kodax/llm`
//   7. dist/sdk-coding.js    — SDK subpath `@kodax-ai/kodax/coding`
//   8. dist/sdk-media.js     — SDK subpath `@kodax-ai/kodax/media`
//   9. dist/sdk-repl.js      — SDK subpath `@kodax-ai/kodax/repl`
//  10. dist/sdk-skills.js    — SDK subpath `@kodax-ai/kodax/skills`
//  11. dist/sdk-mcp.js       — SDK subpath `@kodax-ai/kodax/mcp` (v0.7.42)
//  12. dist/sdk-session.js   — SDK subpath `@kodax-ai/kodax/session`
//  13. dist/sdk-runtime.js   — SDK subpath `@kodax-ai/kodax/runtime`
//  14. dist/sdk-sandbox.js   — SDK subpath `@kodax-ai/kodax/sandbox`
//  15. dist/chunks/*.js      — shared chunks produced by ESM code-splitting
//                                across the SDK entries (avoids repeated bundle bloat).
//  15. dist/builtin/         — verbatim copy of
//                                packages/agent/dist/capabilities/skills/builtin/
//                                (FEATURE_194 v0.7.43; pre-v0.7.43 source was
//                                packages/skills/dist/builtin/).
//                                Path MUST stay 'dist/builtin/' (not 'builtin-skills/')
//                                because agent's resolveBuiltinPath() at
//                                packages/agent/src/capabilities/skills/types.ts
//                                computes `path.join(__dirname, 'builtin')` and esbuild
//                                rewrites __dirname to the bundled dist/ directory.
//
// All 4 internal @kodax-ai/* sub-packages (post-FEATURE_194 v0.7.43:
// llm + agent + coding + repl) are inlined into the bundles via
// esbuild's automatic transitive import tracking. All third-party packages
// (and node built-ins) stay external and are listed in root package.json#dependencies.
//
// The full CLI stays self-contained; the bootstrap only imports it after
// optional bare-resume routing. The SDK entries share code via `splitting: true`
// so re-exporting the same
// internal package from multiple subpaths doesn't multiply tarball size.
//
// See docs/ADR.md ADR-022 + ADR-024 + docs/HLD.md §12 for architecture rationale.
//
// CONTRACT: dist layout is the helper-script's load contract — DO NOT
// change without updating skills helper scripts that depend on
// '../../../index.js' relative resolution (3 levels up, not 4):
//   dist/builtin/<skill>/scripts/X.js  →  ../  ../  ../  → dist/  →  index.js
// See HLD §12.4 risk 3.

// Layout contract constant — used by sanity check below + helper scripts.
const HELPER_SCRIPT_DEPTH_TO_DIST = 3;

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRuntimeWorkerWindowsHide } from './audit-runtime-windows-hide.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const productionPreloadSource = readFileSync(
  path.join(repoRoot, 'scripts', 'production-env.cjs'),
  'utf8',
);

// CLI flags
const argv = process.argv.slice(2);
const withSourcemap = argv.includes('--with-sourcemap');
const writeMetafile = argv.includes('--metafile');

// ---- helpers -------------------------------------------------------------

function log(msg) {
  console.log(`[build-bundle] ${msg}`);
}

function readPkg(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function listJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function assertNoRawAgentDynamicImport(dir) {
  const directAgentImportPattern = /\bimport\(\s*(['"])\.\/agent\.js\1\s*\)/;
  const computedAgentImportPattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])\.\/agent\.js\2[\s\S]{0,500}?\bimport\(\s*\1\s*\)/;
  const violations = [];

  for (const file of listJsFiles(dir)) {
    const source = readFileSync(file, 'utf8');
    if (directAgentImportPattern.test(source) || computedAgentImportPattern.test(source)) {
      violations.push(path.relative(repoRoot, file));
    }
  }

  if (violations.length > 0) {
    console.error(
      '[build-bundle] ERROR: bundle still contains a raw dynamic import of ./agent.js. ' +
      'Use a literal import that esbuild can rewrite into the bundled agent chunk.',
    );
    for (const file of violations) {
      console.error(`[build-bundle]   ${file}`);
    }
    process.exit(1);
  }
}

function assertSemanticWorkerSidecar(dir) {
  const workerPath = path.join(dir, 'semantic-worker.js');
  if (!existsSync(workerPath)) {
    console.error('[build-bundle] ERROR: dist/semantic-worker.js missing.');
    console.error('[build-bundle] The repo-intelligence worker must be emitted as a sidecar for full mode.');
    process.exit(1);
  }
}

const STARTUP_HEAVY_IMPORTS = [
  '@agentclientprotocol/sdk',
  '@anthropic-ai/sdk',
  'jimp',
  'openai',
  'typescript',
  '@anthropic-ai/sandbox-runtime',
  'tsx',
  'vscode-languageserver-protocol',
];
const RESUME_HEAVY_IMPORTS = [
  ...STARTUP_HEAVY_IMPORTS,
];

function packageImportMatches(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function assertStartupImportBoundary(label, result, options = {}) {
  const forbidden = options.forbidden ?? STARTUP_HEAVY_IMPORTS;
  const imports = Object.values(result.metafile?.outputs ?? {})
    .flatMap((output) => output.imports ?? []);
  const violations = imports.filter((entry) =>
    (!options.eagerOnly || entry.kind !== 'dynamic-import')
    && (
      forbidden.some((packageName) => packageImportMatches(entry.path, packageName))
      || (options.exactForbidden ?? []).includes(entry.path)
    ));
  if (violations.length === 0) return;
  throw new Error(
    `${label} startup dependency boundary violated: `
    + violations.map((entry) => `${entry.path} (${entry.kind})`).join(', '),
  );
}

function assertStartupInputBoundary(label, result, forbiddenInputs) {
  const inputs = Object.keys(result.metafile?.inputs ?? {})
    .map((input) => input.replaceAll('\\', '/'));
  const violations = forbiddenInputs.filter((forbidden) =>
    inputs.some((input) => forbidden.endsWith('/')
      ? input.includes(forbidden)
      : input.endsWith(forbidden)));
  if (violations.length === 0) return;
  throw new Error(`${label} startup input boundary violated: ${violations.join(', ')}`);
}

function assertBundleSize(label, bytes, maximumBytes) {
  if (bytes <= maximumBytes) return;
  throw new Error(
    `${label} bundle size ${Math.ceil(bytes / 1024)} kB exceeds the audited `
    + `${Math.ceil(maximumBytes / 1024)} kB startup budget`,
  );
}

// ---- compute external list from root package.json ------------------------

// Everything in root deps stays external (npm installs them on the user
// machine). Only @kodax-ai/* internal sub-packages get inlined.
// Exception: react-devtools-core + ws are intercepted by stubVendoredInkDevDepsPlugin
// before reaching the external check (see plugin docstring above).
const rootPkg = readPkg(path.join(repoRoot, 'package.json'));
const STUBBED_PACKAGES = new Set(['react-devtools-core', 'ws']);
const thirdPartyExternals = Object.keys(rootPkg.dependencies || {})
  .filter((name) => !STUBBED_PACKAGES.has(name));

// Node built-ins are always external by virtue of platform: 'node'.
// We DO NOT external @kodax-ai/* — esbuild will resolve them via
// workspace symlinks (root node_modules has them via npm workspaces)
// and inline transitively.

const external = [...thirdPartyExternals];

log(`External packages: ${external.length} third-party + node built-ins`);

// ---- pre-build prep ------------------------------------------------------

const distDir = path.join(repoRoot, 'dist');
log(`Cleaning ${path.relative(repoRoot, distDir)}`);
mkdirSync(distDir, { recursive: true });
for (const entry of readdirSync(distDir)) {
  if (entry === 'native') continue;
  rmSync(path.join(distDir, entry), { recursive: true, force: true });
}

const nativeBuildArch = process.env.KODAX_NATIVE_TARGET_ARCH ?? process.arch;
const nativeManifestPath = path.join(
  distDir,
  'native',
  `${process.platform}-${nativeBuildArch}`,
  'manifest.json',
);
const nativeManifestJson = existsSync(nativeManifestPath)
  ? readFileSync(nativeManifestPath, 'utf8')
  : undefined;
const nativeManifestMap = {};
const nativeRoot = path.join(distDir, 'native');
if (existsSync(nativeRoot)) {
  for (const entry of readdirSync(nativeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(nativeRoot, entry.name, 'manifest.json');
    if (existsSync(manifestPath)) {
      nativeManifestMap[entry.name] = readFileSync(manifestPath, 'utf8');
    }
  }
}
const nativeManifestsJson = Object.keys(nativeManifestMap).length === 0
  ? undefined
  : JSON.stringify(nativeManifestMap);

// Sub-packages must be built first so esbuild can resolve their dist/.
// We rely on `npm run build:packages` having been run upstream; check
// for the canary file packages/coding/dist/index.js.
const codingDistEntry = path.join(repoRoot, 'packages/coding/dist/index.js');
try {
  readFileSync(codingDistEntry);
} catch {
  console.error('[build-bundle] ERROR: packages/coding/dist/index.js missing.');
  console.error('[build-bundle] Run `npm run build:packages` first.');
  process.exit(1);
}

// ---- esbuild plugin: stub react-devtools-core ---------------------------
//
// Vendored ink fork's reconciler.js does:
//   if (isDev()) { await import('./devtools.js'); }
// where devtools.js does `import devtools from 'react-devtools-core'`.
// esbuild inlines the dynamic import target and hoists its react-devtools-core
// import to module top-level. react-devtools-core's CJS backend.js evaluates
// `self.X = ...` on load → ReferenceError: self is not defined under Node.js.
// `isDev()` is a runtime function call so define-based DCE can't eliminate
// the caller-site branch.
//
// Solution: redirect `react-devtools-core` to an empty stub. Production CLI
// path never enters isDev() branch (DEV env var unset), so the stub's
// initialize() / connectToDevTools() are never actually called — they exist
// only for module-load-time linkage.

const stubVendoredInkDevDepsPlugin = {
  name: 'stub-vendored-ink-dev-deps',
  setup(build) {
    // react-devtools-core: see docstring above.
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core-stub',
      namespace: 'stub',
    }));
    build.onLoad({ filter: /^react-devtools-core-stub$/, namespace: 'stub' }, () => ({
      contents: `
        const noop = () => {};
        export default { initialize: noop, connectToDevTools: noop };
        export const initialize = noop;
        export const connectToDevTools = noop;
      `,
      loader: 'js',
    }));
    // ws: vendored ink fork's devtools-window-polyfill.js does
    //   import ws from 'ws'; customGlobal.WebSocket ||= ws;
    // — only used inside the dev-mode devtools branch (gated by isDev()).
    // Stub it so we don't drag the full ws ^8 surface into the bundle's
    // top-level static imports just for a dev-mode shim that production
    // CLI never enters. The stub is identity-shaped: WebSocket constructor.
    // ws still appears in root package.json#dependencies because openai's
    // peerOptional 'ws@^8.18.0' must be satisfiable for `npm install -g`
    // to succeed under npm 11 strict-peer-deps; npm 11 satisfies the peer
    // by finding ws in node_modules even when the bundle doesn't import it.
    build.onResolve({ filter: /^ws$/ }, () => ({
      path: 'ws-stub',
      namespace: 'stub',
    }));
    build.onLoad({ filter: /^ws-stub$/, namespace: 'stub' }, () => ({
      contents: `
        // Stub: real ws never loaded in production CLI (vendored ink dev path only).
        class WebSocketStub {}
        export default WebSocketStub;
        export { WebSocketStub as WebSocket };
      `,
      loader: 'js',
    }));
  },
};

// ---- esbuild common options ---------------------------------------------

const commonOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external,
  // Minify: drop whitespace/identifiers; keep function names for readable
  // stacks. Reduces bundle ~30-40% per HLD §12.4 risk 5 mitigation.
  minify: true,
  keepNames: true,
  // Source map: opt-in via --with-sourcemap. Default off because:
  //   - source maps add ~13 MB unpacked (~3 MB gzipped) to tarball
  //   - path B SDK consumers (rare) can rebuild from GitHub source
  //   - dev mode and `npm run dev` use tsx which has its own source mapping
  // Per HLD §12.4 risk 4: source map is opt-in, not always-on.
  sourcemap: withSourcemap ? 'external' : false,
  // Static replace process.env values so esbuild's DCE eliminates the
  // dev-only `if (isDev())` branch in vendored ink fork. Without this:
  //   - vendored ink reconciler.js imports './devtools.js' (dynamic)
  //   - esbuild inlines the dynamic import → react-devtools-core
  //     becomes a top-level static import
  //   - react-devtools-core's CJS backend.js evaluates `self.X = ...` on
  //     load → ReferenceError: self is not defined under Node.js
  // By statically replacing process.env.DEV → "false" the entire if-branch
  // is dead-code-eliminated and react-devtools-core never enters the bundle.
  // (Production `kodax` always has DEV unset; dev mode runs via tsx not bundle.)
  //
  // KODAX_VERSION: bake the root package.json version into the bundle so
  // `getVersion()` in packages/repl/src/common/utils.ts hits the env-var
  // branch and never reaches the brittle filesystem lookup (which assumes
  // `../../package.json` from `import.meta.url`, true only for the dev
  // tsx path — after esbuild + npm install the bundle lives at
  // node_modules/@kodax-ai/kodax/dist/ and `../../` resolves to the
  // @kodax-ai/ scope dir, NOT the package root, so the lookup falls back
  // to '0.0.0' in the banner). Same mechanism Bun --compile uses for the
  // standalone binary build (see packages/repl/src/common/utils.ts:265).
  define: {
    KODAX_NATIVE_MANIFESTS_JSON: nativeManifestsJson === undefined
      ? 'undefined'
      : JSON.stringify(nativeManifestsJson),
    KODAX_NATIVE_MANIFEST_JSON: nativeManifestJson === undefined
      ? 'undefined'
      : JSON.stringify(nativeManifestJson),
    KODAX_WINDOWS_NATIVE_MANIFEST_JSON: nativeManifestJson === undefined
      ? 'undefined'
      : JSON.stringify(nativeManifestJson),
    'process.env.DEV': '"false"',
    'process.env.NODE_ENV': '"production"',
    'process.env.KODAX_VERSION': JSON.stringify(rootPkg.version),
    'process.env.KODAX_MODULE_BUNDLE': '"true"',
  },
  // Output ESM with .js extensions in source — keep the import structure
  // that already works in dev (--import tsx).
  banner: {
    js: '// @kodax-ai/kodax — bundled distribution. See docs/ADR.md ADR-022 + ADR-024.',
  },
  // Metafile (opt-in via --metafile): bundle composition for CI inspection.
  // Default off because the file is ~1 MB and consumers don't need it.
  metafile: writeMetafile,
  plugins: [stubVendoredInkDevDepsPlugin],
  // Resolve workspace internals via symlinks under root node_modules (npm
  // workspaces creates symlinks for @kodax-ai/* into packages/*/dist).
  // The resolveExtensions order ensures we prefer compiled .js (faster build,
  // matches what consumers see).
  resolveExtensions: ['.js', '.mjs', '.cjs'],
  // Log level: warning to surface unresolved dynamic imports etc.
  logLevel: 'warning',
};

// ---- build CLI entry -----------------------------------------------------

log('Building dist/kodax_cli.js (CLI entry)…');
const cliResult = await build({
  ...commonOptions,
  metafile: true,
  entryPoints: [path.join(repoRoot, 'src/kodax_cli.ts')],
  outfile: path.join(distDir, 'kodax_cli.js'),
});
assertStartupImportBoundary('CLI', cliResult, { eagerOnly: true });

const cliBytes = statSync(path.join(distDir, 'kodax_cli.js')).size;
assertBundleSize('CLI', cliBytes, 5 * 1024 * 1024);
log(`  ✓ dist/kodax_cli.js (${(cliBytes / 1024).toFixed(0)} kB)`);

// Bare `-r` must show the picker without evaluating the full CLI graph.
log('Building dist/kodax_resume.js (bare-resume entry)…');
const resumeResult = await build({
  ...commonOptions,
  metafile: true,
  entryPoints: [path.join(repoRoot, 'src/kodax_resume.ts')],
  outfile: path.join(distDir, 'kodax_resume.js'),
});
assertStartupImportBoundary('Resume', resumeResult, {
  forbidden: RESUME_HEAVY_IMPORTS,
  exactForbidden: ['es-toolkit/compat'],
});
assertStartupInputBoundary('Resume', resumeResult, [
  'packages/agent/',
  'packages/coding/',
  'packages/llm/',
  'packages/repl/src/interactive/storage.ts',
  'packages/repl/src/session/conversation-page-cache.ts',
]);
const resumeBytes = statSync(path.join(distDir, 'kodax_resume.js')).size;
assertBundleSize('Resume', resumeBytes, 160 * 1024);
log(`  ✓ dist/kodax_resume.js (${(resumeBytes / 1024).toFixed(0)} kB)`);

// Keep these imports external so the bootstrap remains genuinely lightweight.
// The preload is embedded for standalone binaries, which do not use the CJS shim.
log('Building dist/kodax_bootstrap.js (lightweight CLI entry)…');
const bootstrapResult = await build({
  ...commonOptions,
  entryPoints: [path.join(repoRoot, 'src/kodax_bootstrap.ts')],
  outfile: path.join(distDir, 'kodax_bootstrap.js'),
  external: [...external, './kodax_cli.js', './kodax_resume.js'],
  banner: {
    js: `${commonOptions.banner.js}\n${productionPreloadSource}`,
  },
});
const bootstrapBytes = statSync(path.join(distDir, 'kodax_bootstrap.js')).size;
log(`  ✓ dist/kodax_bootstrap.js (${(bootstrapBytes / 1024).toFixed(0)} kB)`);

// ---- build SDK entries (multi-entry + code-splitting) -------------------
//
// ADR-024: SDK entries (root + subpaths) share large internal
// packages (e.g. sdk-coding re-exports @kodax-ai/coding which also surfaces
// through the root index.ts). Without splitting, each entry would inline
// the same code across entries. With `splitting: true`, esbuild emits
// shared `dist/chunks/*.js` and each entry imports only what it needs.
//
// Helper scripts (`loadKodaXSDK()`) use `await import('../../../index.js')`
// — Node's ESM resolver follows chunk imports transparently, so splitting
// does not affect the helper-depth contract verified below.

const sdkEntryNames = ['index', 'sdk-agent', 'sdk-llm', 'sdk-coding', 'sdk-media', 'sdk-repl', 'sdk-skills', 'sdk-mcp', 'sdk-session', 'sdk-runtime', 'sdk-sandbox', 'sdk-a2a', 'sdk-experimental-memory'];
const sdkEntryPoints = sdkEntryNames.map((name) => {
  // index.ts lives directly under src/, the others as src/sdk-<name>.ts.
  const filename = name === 'index' ? 'index.ts' : `${name}.ts`;
  return path.join(repoRoot, 'src', filename);
});

log(`Building ${sdkEntryNames.length} SDK entries (splitting on)…`);
const sdkResult = await build({
  ...commonOptions,
  entryPoints: sdkEntryPoints,
  outdir: distDir,
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
});

const sdkBytesByEntry = Object.fromEntries(
  sdkEntryNames.map((name) => {
    const outPath = path.join(distDir, `${name}.js`);
    return [name, statSync(outPath).size];
  }),
);
for (const name of sdkEntryNames) {
  log(`  ✓ dist/${name}.js (${(sdkBytesByEntry[name] / 1024).toFixed(0)} kB)`);
}
const sdkBytes = sdkBytesByEntry.index;

// ---- build repo-intelligence worker sidecar -----------------------------
//
// semantic-worker-client starts a Node worker by URL at runtime. The main CLI
// and SDK entries are bundled, so esbuild cannot discover that sidecar from a
// computed `new Worker(resolveWorkerUrl())` call. Build it explicitly and keep
// it next to the bundled entries/chunks.
log('Building dist/semantic-worker.js (repo-intelligence worker sidecar)...');
const workerResult = await build({
  ...commonOptions,
  entryPoints: [path.join(repoRoot, 'packages/coding/dist/repo-intelligence/semantic-worker.js')],
  outfile: path.join(distDir, 'semantic-worker.js'),
});
const workerBytes = statSync(path.join(distDir, 'semantic-worker.js')).size;
log(`  OK dist/semantic-worker.js (${(workerBytes / 1024).toFixed(0)} kB)`);

log('Building dist/runtime-worker.js (SDK Runtime worker sidecar)...');
const runtimeWorkerResult = await build({
  ...commonOptions,
  entryPoints: [path.join(repoRoot, 'src/runtime-worker/entry.ts')],
  outfile: path.join(distDir, 'runtime-worker.js'),
  metafile: true,
});
const runtimeWorkerBytes = statSync(path.join(distDir, 'runtime-worker.js')).size;
log(`  OK dist/runtime-worker.js (${(runtimeWorkerBytes / 1024).toFixed(0)} kB)`);
const runtimeWindowsAudit = auditRuntimeWorkerWindowsHide({
  repoRoot,
  metafile: runtimeWorkerResult.metafile,
  bundlePath: path.join(distDir, 'runtime-worker.js'),
});
log(
  `  OK Runtime Worker child-process audit: ${runtimeWindowsAudit.calls.length} calls, `
  + `${runtimeWindowsAudit.exceptions.length} intentional exceptions`,
);

log('Building dist/sandbox-network-broker.js (Windows ASRT network sidecar)...');
await build({
  ...commonOptions,
  entryPoints: [path.join(repoRoot, 'src/sandbox-network-broker-entry.ts')],
  outfile: path.join(distDir, 'sandbox-network-broker.js'),
});
const sandboxNetworkBrokerBytes = statSync(
  path.join(distDir, 'sandbox-network-broker.js'),
).size;
log(
  `  OK dist/sandbox-network-broker.js `
  + `(${(sandboxNetworkBrokerBytes / 1024).toFixed(0)} kB)`,
);

log('Building dist/constructed-handler-worker.js (constructed tool sidecar)...');
const constructedHandlerWorkerResult = await build({
  ...commonOptions,
  entryPoints: [path.join(repoRoot, 'packages/coding/dist/construction/handler-worker.js')],
  outfile: path.join(distDir, 'constructed-handler-worker.js'),
});
const constructedHandlerWorkerBytes = statSync(path.join(distDir, 'constructed-handler-worker.js')).size;
log(`  OK dist/constructed-handler-worker.js (${(constructedHandlerWorkerBytes / 1024).toFixed(0)} kB)`);

// ---- copy builtin skill resources ---------------------------------------

// Layout contract (see HLD §12.4 risk 3):
//   dist/builtin/<skill-name>/{SKILL.md, scripts/, references/, agents/}
// Helper scripts compute SDK path as path.resolve(here, '../../../index.js')
// so the depth must stay at HELPER_SCRIPT_DEPTH_TO_DIST levels:
//   here = dist/builtin/<skill>/scripts → SDK = dist/index.js
//   relative depth: scripts (1) → <skill> (2) → builtin (3) → dist (root)
//
// CRITICAL: directory MUST be 'builtin' (not 'builtin-skills') because
// agent's `resolveBuiltinPath()` at
// packages/agent/src/capabilities/skills/types.ts computes
// `path.join(__dirname, 'builtin')`. esbuild rewrites __dirname to the
// runtime bundled dist/ location, so we must mirror that name here.
//
// FEATURE_194 (v0.7.43): skills inlined into agent at
// `packages/agent/src/capabilities/skills/`; bundled builtin output now
// lives at `packages/agent/dist/capabilities/skills/builtin` (produced by
// `npm run copy:builtin -w @kodax-ai/agent` during `build:packages`).
const skillsBuiltinSrc = path.join(repoRoot, 'packages/agent/dist/capabilities/skills/builtin');
const skillsBuiltinDst = path.join(distDir, 'builtin');
log(`Copying builtin skills: ${path.relative(repoRoot, skillsBuiltinSrc)} → ${path.relative(repoRoot, skillsBuiltinDst)}`);
cpSync(skillsBuiltinSrc, skillsBuiltinDst, { recursive: true });
log(`  ✓ dist/builtin/ copied`);

// ---- copy provider-capabilities.json (FEATURE_198 v0.7.44) --------------
//
// The loader reads this JSON at runtime via `fs.readFileSync(__dirname +
// 'provider-capabilities.json')`. In the bundled output the loader is
// inlined into dist/index.js, so `import.meta.url` resolves to dist/ —
// we copy the JSON to dist/ root so the lookup hits.
//
// Hot-update path: SDK consumers can edit dist/provider-capabilities.json
// in-place and restart their process to see new capability values
// without waiting for a KodaX release.
//
// esbuild's default JSON loader would INLINE the import — we avoid that
// by reading via `fs.readFileSync` (string, not `import`), keeping the
// JSON external and patchable.
const capJsonSrc = path.join(repoRoot, 'packages/llm/src/providers/provider-capabilities.json');
const capJsonDst = path.join(distDir, 'provider-capabilities.json');
log(`Copying provider-capabilities.json → ${path.relative(repoRoot, capJsonDst)}`);
cpSync(capJsonSrc, capJsonDst);
log(`  ✓ dist/provider-capabilities.json copied`);

// ---- sanity check: helper script depth contract -------------------------

// Verify the layout contract: a known helper script must be exactly
// HELPER_SCRIPT_DEPTH_TO_DIST levels below dist/. If a future refactor
// adds an intermediate directory, this fails the build instead of
// silently breaking loadKodaXSDK() at runtime in user installs.
const sampleHelper = path.join(distDir, 'builtin/skill-creator/scripts/utils.js');
if (!existsSync(sampleHelper)) {
  console.error('[build-bundle] ERROR: sample helper script missing at expected path:', sampleHelper);
  process.exit(1);
}
const distRelativeDepth = path
  .relative(distDir, path.dirname(sampleHelper))
  .split(/[\\/]/)
  .filter(Boolean).length;
if (distRelativeDepth !== HELPER_SCRIPT_DEPTH_TO_DIST) {
  console.error(
    `[build-bundle] ERROR: helper script depth contract violated. ` +
    `Expected ${HELPER_SCRIPT_DEPTH_TO_DIST} levels, got ${distRelativeDepth}. ` +
    `Update HELPER_SCRIPT_DEPTH_TO_DIST + utils.js loadKodaXSDK() relative path.`,
  );
  process.exit(1);
}
log(`  ✓ helper depth contract: ${distRelativeDepth} levels (matches HELPER_SCRIPT_DEPTH_TO_DIST)`);

// ---- copy other dist artifacts that bin uses -----------------------------

// Root tsconfig produces dist/cli_commands.js etc. that kodax_cli.ts imports
// via "./cli_commands.js". Now that kodax_cli is a single bundle, those
// files are inlined and the per-file dist artifacts are not needed in the
// published tarball. But ACP server type declarations and SDK .d.ts may
// still be useful — generate them via tsc separately if needed (out of scope
// for this script).

// ---- write metafile for audit (opt-in) ----------------------------------

if (writeMetafile) {
  const meta = {
    bootstrap: bootstrapResult.metafile,
    resume: resumeResult.metafile,
    cli: cliResult.metafile,
    sdk: sdkResult.metafile,
    worker: workerResult.metafile,
    runtimeWorker: runtimeWorkerResult.metafile,
    constructedHandlerWorker: constructedHandlerWorkerResult.metafile,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(
    path.join(distDir, 'bundle-meta.json'),
    JSON.stringify(meta, null, 2),
    'utf8',
  );
  log(`  ✓ dist/bundle-meta.json (esbuild analysis)`);
}

assertNoRawAgentDynamicImport(distDir);
log(`  OK bundle import guard: no raw ./agent.js dynamic import`);
assertSemanticWorkerSidecar(distDir);
log(`  OK worker sidecar guard: dist/semantic-worker.js present`);
if (!existsSync(path.join(distDir, 'runtime-worker.js'))) {
  throw new Error('[build-bundle] runtime-worker.js sidecar is missing.');
}
log(`  OK worker sidecar guard: dist/runtime-worker.js present`);
if (!existsSync(path.join(distDir, 'sandbox-network-broker.js'))) {
  throw new Error('[build-bundle] sandbox-network-broker.js sidecar is missing.');
}
log('  OK worker sidecar guard: dist/sandbox-network-broker.js present');
if (!existsSync(path.join(distDir, 'constructed-handler-worker.js'))) {
  throw new Error('[build-bundle] constructed-handler-worker.js sidecar is missing.');
}
log(`  OK worker sidecar guard: dist/constructed-handler-worker.js present`);

// ---- summary -------------------------------------------------------------

log('');
log('Bundle complete:');
log(`  Bootstrap: ${(bootstrapBytes / 1024).toFixed(0)} kB → dist/kodax_bootstrap.js`);
log(`  Resume:    ${(resumeBytes / 1024).toFixed(0)} kB → dist/kodax_resume.js`);
log(`  CLI:  ${(cliBytes / 1024).toFixed(0)} kB → dist/kodax_cli.js`);
for (const name of sdkEntryNames) {
  const label = name === 'index' ? 'SDK (root) ' : `SDK ${name.replace('sdk-', '/')}`.padEnd(11);
  log(`  ${label}:  ${(sdkBytesByEntry[name] / 1024).toFixed(0)} kB → dist/${name}.js`);
}
log(`  Builtin skills: dist/builtin/`);
log(`  Worker:         dist/semantic-worker.js`);
log(`  Runtime worker: dist/runtime-worker.js`);
log(`  Handler worker: dist/constructed-handler-worker.js`);
log(`  Shared chunks:  dist/chunks/`);
log('');
log('Next: `npm pack` to produce the publish-ready tarball.');
