import { createVitestConfig } from '../../vitest.config.js';
import {
  CONTRACT_TEST_FILES,
  FAST_TEST_FILES,
  INTEGRATION_TEST_FILES,
  SYSTEM_TEST_FILES,
} from './vitest.test-tiers.js';

export default createVitestConfig({
  include: FAST_TEST_FILES,
  exclude: [...INTEGRATION_TEST_FILES, ...CONTRACT_TEST_FILES, ...SYSTEM_TEST_FILES],
});
