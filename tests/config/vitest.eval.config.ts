import path from 'path';
import { defineConfig, type Plugin } from 'vitest/config';

const resolveFromRoot = (...segments: string[]): string =>
  path.resolve(__dirname, '..', '..', ...segments);

function stripShebang(): Plugin {
  return {
    name: 'strip-shebang',
    transform(code, id) {
      if (id.endsWith('.js') && code.startsWith('#!')) {
        return { code: code.replace(/^#![^\n]*\n/, ''), map: null };
      }
    },
  };
}

/**
 * Eval-only vitest config.
 *
 * `.eval.ts` files opt INTO manual runs — they may call real LLM APIs,
 * cost money, or be slow. They are NOT included in the default `npm test`
 * runner (see the root `vitest.config.ts`).
 *
 * Run all evals:           npm run test:eval
 * Run one eval file:       npx vitest run -c tests/config/vitest.eval.config.ts tests/identity-roundtrip.eval.ts
 */
export default defineConfig({
  plugins: [stripShebang()],
  resolve: {
    alias: {
      '@kodax-ai/agent/capabilities/skills/shared/yaml': resolveFromRoot('packages', 'agent', 'src', 'capabilities', 'skills', 'shared', 'yaml.ts'),
      '@kodax-ai/llm': resolveFromRoot('packages', 'llm', 'src', 'index.ts'),
      '@kodax-ai/agent/session-lineage': resolveFromRoot('packages', 'agent', 'src', 'session-lineage', 'index.ts'),
      '@kodax-ai/agent/capabilities/skills': resolveFromRoot('packages', 'agent', 'src', 'capabilities', 'skills', 'index.ts'),
      '@kodax-ai/agent/tracing': resolveFromRoot('packages', 'agent', 'src', 'tracing', 'index.ts'),
      '@kodax-ai/agent/experimental-memory': resolveFromRoot('packages', 'agent', 'src', 'experimental-memory', 'index.ts'),
      '@kodax-ai/agent/media': resolveFromRoot('packages', 'agent', 'src', 'media', 'index.ts'),
      '@kodax-ai/agent': resolveFromRoot('packages', 'agent', 'src', 'index.ts'),
      '@kodax-ai/coding': resolveFromRoot('packages', 'coding', 'src', 'index.ts'),
      '@kodax-ai/repl': resolveFromRoot('packages', 'repl', 'src', 'index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.eval.ts'],
    // Archived evals (e.g. FEATURE_155 retired feature-148-post-dispatch-probe
    // because its target tool `await_child_task` was deleted in v0.7.39
    // Slice C1) live under `tests/_archive/` for historical reference.
    // They must not run via `npm run test:eval`.
    exclude: ['tests/_archive/**', '**/node_modules/**', '**/dist/**'],
    testTimeout: 60_000,
  },
});
