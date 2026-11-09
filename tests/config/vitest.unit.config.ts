import { createVitestConfig } from '../../vitest.config.js';
import {
  CONTRACT_TEST_FILES,
  FAST_TEST_FILES,
  INTEGRATION_TEST_FILES,
  SYSTEM_TEST_FILES,
} from './vitest.test-tiers.js';

// Deterministic tests outside the small edit-loop gate. Kept disjoint so
// test:full and CI do not spend time running the fast files twice.
export default createVitestConfig({
  exclude: [
    ...INTEGRATION_TEST_FILES,
    ...FAST_TEST_FILES,
    ...CONTRACT_TEST_FILES,
    ...SYSTEM_TEST_FILES,
  ],
});
