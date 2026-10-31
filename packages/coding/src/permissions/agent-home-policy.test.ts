import { afterEach, expect, it, vi } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { isAutoReadableAgentHomePath, isProtectedAgentHomeReadTarget, isProtectedAgentHomeMutationTarget } from './agent-home-policy.js';

afterEach(() => vi.unstubAllEnvs());
it.each(['auth.json', 'auth.json.fixture.tmp', 'auth.json.bak', '.auth.json.fixture.tmp'])('protects managed credential path %s including unpublished copies', name => {
  const home = path.join(tmpdir(), 'kodax-auth-protection-fixture'); vi.stubEnv('KODAX_HOME', home);
  const file = path.join(home, name);
  expect(isAutoReadableAgentHomePath(file, home)).toBe(false);
  expect(isProtectedAgentHomeReadTarget(file)).toBe(true);
  expect(isProtectedAgentHomeMutationTarget(file)).toBe(true);
});
