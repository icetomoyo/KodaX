import { createVitestConfig } from '../../vitest.config.js';
import { CONTRACT_TEST_FILES } from './vitest.test-tiers.js';

export default createVitestConfig({ include: CONTRACT_TEST_FILES, exclude: [] });
