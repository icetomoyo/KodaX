import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@kodax/agent': path.resolve(__dirname, '..', 'agent', 'src', 'index.ts'),
      '@kodax/coding': path.resolve(__dirname, '..', 'coding', 'src', 'index.ts'),
      '@kodax/skills': path.resolve(__dirname, '..', 'skills', 'src', 'index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
