import { defineConfig, mergeConfig } from 'vitest/config';
import { createVitestConfig } from './vitest.config.js';
import { discoverWindowsTestFiles } from './scripts/windows-test-files.mjs';
import { globSync } from 'glob';
import { INTEGRATION_TEST_FILES, SYSTEM_TEST_FILES } from './vitest.test-tiers.js';

const tier = process.env.KODAX_WINDOWS_TEST_TIER;
if (tier !== undefined && tier !== 'portable' && tier !== 'system') throw new Error('Unknown Windows test tier.');
const system = new Set(globSync(SYSTEM_TEST_FILES, { cwd: __dirname, posix: true }));
const include = discoverWindowsTestFiles(__dirname).filter(file => tier === undefined || system.has(file) === (tier === 'system'));

// Discovery keeps new platform-gated regressions from silently falling through
// Linux skips and a stale Windows workflow list. Real backend opt-ins stay intact.
export default mergeConfig(
  createVitestConfig({ include, exclude: INTEGRATION_TEST_FILES }),
  defineConfig({ test: { maxWorkers: 1 } }),
);
