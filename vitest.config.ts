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
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      // FEATURE_104 prompt-eval harness self-test (zero-LLM unit tests).
      // Benchmark module + datasets + gitignored run results live under benchmark/.
      'benchmark/**/*.test.ts',
    ],
  },
});
