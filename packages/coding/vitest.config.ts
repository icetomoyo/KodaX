import path from 'path';
import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

const isCoverageRun = process.argv.some((arg) => arg === '--coverage' || arg.startsWith('--coverage='));

export default defineConfig({
  resolve: {
    alias: {
      // More-specific subpath aliases must precede the package-root alias
      // because Vite matches alias entries by prefix.
      '@kodax-ai/agent/media': path.resolve(__dirname, '..', 'agent', 'src', 'media', 'index.ts'),
      '@kodax-ai/agent/capabilities/skills/shared/yaml': path.resolve(__dirname, '..', 'agent', 'src', 'capabilities', 'skills', 'shared', 'yaml.ts'),
      '@kodax-ai/llm': path.resolve(__dirname, '..', 'llm', 'src', 'index.ts'),
      '@kodax-ai/agent/messaging/queue': path.resolve(__dirname, '..', 'agent', 'src', 'messaging', 'queue.ts'),
      '@kodax-ai/agent/workflow': path.resolve(__dirname, '..', 'agent', 'src', 'workflow', 'index.ts'),
      '@kodax-ai/agent/experimental-memory': path.resolve(__dirname, '..', 'agent', 'src', 'experimental-memory', 'index.ts'),
      '@kodax-ai/agent': path.resolve(__dirname, '..', 'agent', 'src', 'index.ts'),
      '@kodax-ai/agent/capabilities/skills': path.resolve(__dirname, '..', 'agent', 'src', 'capabilities', 'skills', 'index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: Math.min(isCoverageRun ? 4 : 8, availableParallelism()),
    setupFiles: [path.resolve(__dirname, '..', '..', 'vitest.setup.queue.ts')],
    include: ['src/**/*.test.ts'],
  },
});
