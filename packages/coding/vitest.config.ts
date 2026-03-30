import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@kodax/ai': path.resolve(__dirname, '..', 'ai', 'src', 'index.ts'),
      '@kodax/agent': path.resolve(__dirname, '..', 'agent', 'src', 'index.ts'),
      '@kodax/skills': path.resolve(__dirname, '..', 'skills', 'src', 'index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
