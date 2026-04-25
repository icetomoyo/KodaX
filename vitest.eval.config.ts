import path from 'path';
import { defineConfig, type Plugin } from 'vitest/config';

const resolveFromRoot = (...segments: string[]): string =>
  path.resolve(__dirname, ...segments);

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
 * runner (see `vitest.config.ts`).
 *
 * Run all evals:           npm run test:eval
 * Run one eval file:       npx vitest run -c vitest.eval.config.ts tests/identity-roundtrip.eval.ts
 */
export default defineConfig({
  plugins: [stripShebang()],
  resolve: {
    alias: {
      '@kodax/skills/shared/yaml': resolveFromRoot('packages', 'skills', 'src', 'shared', 'yaml.ts'),
      '@kodax/ai': resolveFromRoot('packages', 'ai', 'src', 'index.ts'),
      '@kodax/agent': resolveFromRoot('packages', 'agent', 'src', 'index.ts'),
      '@kodax/coding': resolveFromRoot('packages', 'coding', 'src', 'index.ts'),
      '@kodax/repl': resolveFromRoot('packages', 'repl', 'src', 'index.ts'),
      '@kodax/repointel-protocol': resolveFromRoot('packages', 'repointel-protocol', 'src', 'index.ts'),
      '@kodax/skills': resolveFromRoot('packages', 'skills', 'src', 'index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.eval.ts'],
    testTimeout: 60_000,
  },
});
