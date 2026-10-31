import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { getAgentConfigHome } from '../packages/agent/src/runtime/agent-home.js';

it('keeps the default test config home isolated after environment stubs are restored', () => {
  const configHome = getAgentConfigHome();
  expect(path.dirname(configHome)).toBe(path.resolve(tmpdir()));
  expect(path.basename(configHome)).toMatch(/^kodax-vitest-home-/);
  expect(configHome).not.toBe(path.join(homedir(), '.kodax'));
  vi.stubEnv('KODAX_HOME', path.join(configHome, 'explicit-test-override'));
  expect(getAgentConfigHome()).toBe(path.join(configHome, 'explicit-test-override'));
  vi.unstubAllEnvs();
  expect(getAgentConfigHome()).toBe(configHome);
});
