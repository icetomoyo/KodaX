import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // More-specific subpath aliases must precede the package-root alias
    // because Vite matches alias entries by prefix. Mirrors the alias
    // shape in the root vitest.config.ts (FEATURE_086 子任务 B 第 5 条
    // added the subpath alias there but missed this per-package copy,
    // which is why running `npm test --workspaces` fails 14 files at
    // collection time when discovery.ts pulls in @kodax/skills/shared/yaml).
    alias: {
      '@kodax/skills/shared/yaml': path.resolve(__dirname, '..', 'skills', 'src', 'shared', 'yaml.ts'),
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
