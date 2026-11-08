import { createVitestConfig } from '../../vitest.config.js';

export default createVitestConfig({ include: ['tests/fixtures/actor-crash.fixture.ts'], exclude: [] });
