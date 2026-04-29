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
    // `node_modules/@kodax/<pkg>/package.json`, whose `main` points to
    // `dist/index.js` — `dist/` is only present after `tsc -b`. In a
    // freshly-cloned checkout (or after `npm run clean`), test
    // collection fails with "Failed to resolve entry for package
    // @kodax/<pkg>". Aliasing every workspace package straight to its
    // src/index.ts makes test runs source-truth and build-independent.
    //
    // Transitive deps matter: @kodax/coding's source pulls in
    // @kodax/ai, @kodax/core, @kodax/mcp, @kodax/repointel-protocol,
    // @kodax/session-lineage — even tests that don't import those
    // directly will fail at module-graph resolution if they're missing.
    alias: {
      '@kodax/skills/shared/yaml': path.resolve(__dirname, '..', 'skills', 'src', 'shared', 'yaml.ts'),
      '@kodax/agent': path.resolve(__dirname, '..', 'agent', 'src', 'index.ts'),
      '@kodax/ai': path.resolve(__dirname, '..', 'ai', 'src', 'index.ts'),
      '@kodax/coding': path.resolve(__dirname, '..', 'coding', 'src', 'index.ts'),
      '@kodax/core': path.resolve(__dirname, '..', 'core', 'src', 'index.ts'),
      '@kodax/mcp': path.resolve(__dirname, '..', 'mcp', 'src', 'index.ts'),
      '@kodax/repointel-protocol': path.resolve(__dirname, '..', 'repointel-protocol', 'src', 'index.ts'),
      '@kodax/session-lineage': path.resolve(__dirname, '..', 'session-lineage', 'src', 'index.ts'),
      '@kodax/skills': path.resolve(__dirname, '..', 'skills', 'src', 'index.ts'),
      '@kodax/tracing': path.resolve(__dirname, '..', 'tracing', 'src', 'index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
