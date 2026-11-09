import { defineConfig, mergeConfig } from 'vitest/config';

import { createVitestConfig } from '../../vitest.config.js';
import { SYSTEM_TEST_FILES } from './vitest.test-tiers.js';

// These tests compete for real subprocesses, daemon ports, repositories, and
// filesystem handles. Keep them serial so production timeout contracts are
// measured against the code rather than Windows worker starvation.
export default mergeConfig(
  createVitestConfig({ include: SYSTEM_TEST_FILES, exclude: [] }),
  defineConfig({ test: { maxWorkers: 1 } }),
);
