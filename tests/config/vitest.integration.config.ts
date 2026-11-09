import { createVitestConfig } from '../../vitest.config.js';
import { INTEGRATION_TEST_FILES } from './vitest.test-tiers.js';

export default createVitestConfig({ include: INTEGRATION_TEST_FILES, exclude: [] });
