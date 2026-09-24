import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // More-specific subpath aliases must precede the package-root alias
    // because Vite matches alias entries by prefix.
    //
    // Why every workspace package needs an alias here (v0.7.30 fix):
    // when vitest is invoked from this package directory it loads THIS
    // config (not the root vitest.config.ts). Without the alias, vitest
    // falls back to npm-workspace symlink resolution into
    // `node_modules/@kodax-ai/<pkg>/package.json`, whose `main` points to
    // `dist/index.js` — `dist/` is only present after `tsc -b`. In a
    // freshly-cloned checkout (or after `npm run clean`), test
    // collection fails with "Failed to resolve entry for package
    // @kodax-ai/<pkg>". Aliasing every workspace package straight to its
    // src/index.ts makes test runs source-truth and build-independent.
    //
    // Transitive deps matter: @kodax-ai/coding's source pulls in
    // @kodax-ai/llm and @kodax-ai/agent (capabilities/skills,
    // session-lineage, tracing subpaths after FEATURE_194 v0.7.43
    // consolidation) — even tests that don't import those directly will
    // fail at module-graph resolution if they're missing.
    alias: {
      '@kodax-ai/coding/media': path.resolve(__dirname, '..', 'coding', 'src', 'media', 'index.ts'),
      '@kodax-ai/agent/media': path.resolve(__dirname, '..', 'agent', 'src', 'media', 'index.ts'),
      '@kodax-ai/agent/capabilities/skills/shared/yaml': path.resolve(__dirname, '..', 'agent', 'src', 'capabilities', 'skills', 'shared', 'yaml.ts'),
      '@kodax-ai/agent/messaging/queue': path.resolve(__dirname, '..', 'agent', 'src', 'messaging', 'queue.ts'),
      '@kodax-ai/agent/runtime/macos-git': path.resolve(__dirname, '..', 'agent', 'src', 'runtime', 'macos-git.ts'),
      '@kodax-ai/agent/experimental-memory': path.resolve(__dirname, '..', 'agent', 'src', 'experimental-memory', 'index.ts'),
      '@kodax-ai/agent': path.resolve(__dirname, '..', 'agent', 'src', 'index.ts'),
      '@kodax-ai/llm': path.resolve(__dirname, '..', 'llm', 'src', 'index.ts'),
      '@kodax-ai/coding': path.resolve(__dirname, '..', 'coding', 'src', 'index.ts'),
      '@kodax-ai/agent/session-lineage': path.resolve(__dirname, '..', 'agent', 'src', 'session-lineage', 'index.ts'),
      '@kodax-ai/agent/capabilities/skills': path.resolve(__dirname, '..', 'agent', 'src', 'capabilities', 'skills', 'index.ts'),
      '@kodax-ai/agent/tracing': path.resolve(__dirname, '..', 'agent', 'src', 'tracing', 'index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Keep package-local runs aligned with the root Vitest config. Some
    // fs-heavy storage tests dynamically reload modules and can legitimately
    // approach Vitest's 5s default on Windows; a timeout should indicate a
    // real hang, not first-import/IO overhead.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
