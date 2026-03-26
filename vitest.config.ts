import path from 'path';
import { defineConfig } from 'vitest/config';

const resolveFromRoot = (...segments: string[]): string =>
  path.resolve(__dirname, ...segments);

export default defineConfig({
  resolve: {
    alias: {
      '@kodax/ai': resolveFromRoot('packages', 'ai', 'src', 'index.ts'),
      '@kodax/agent': resolveFromRoot('packages', 'agent', 'src', 'index.ts'),
      '@kodax/coding': resolveFromRoot('packages', 'coding', 'src', 'index.ts'),
      '@kodax/repl': resolveFromRoot('packages', 'repl', 'src', 'index.ts'),
      '@kodax/skills': resolveFromRoot('packages', 'skills', 'src', 'index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx'],
  },
});
