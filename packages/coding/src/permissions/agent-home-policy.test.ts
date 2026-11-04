import { afterEach, expect, it, vi } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  isAgentHomeHardMutationTarget,
  isAgentHomeHostLoadedTarget,
  isAutoReadableAgentHomePath,
  isProtectedAgentHomeReadTarget,
  isProtectedAgentHomeMutationTarget,
} from './agent-home-policy.js';

afterEach(() => vi.unstubAllEnvs());
it.each(['auth.json', 'auth.json.fixture.tmp', 'auth.json.bak', '.auth.json.fixture.tmp'])('protects managed credential path %s including unpublished copies', name => {
  const home = path.join(tmpdir(), 'kodax-auth-protection-fixture'); vi.stubEnv('KODAX_HOME', home);
  const file = path.join(home, name);
  expect(isAutoReadableAgentHomePath(file, home)).toBe(false);
  expect(isProtectedAgentHomeReadTarget(file)).toBe(true);
  expect(isProtectedAgentHomeMutationTarget(file)).toBe(true);
});

// The Host loads these directories as trusted code and live integrations, so a
// model-side write would install capabilities without a user action.
it.each(['extensions', 'extensions/planted.mjs', 'integrations', 'integrations/mcp.json'])(
  'refuses model mutation of Host-loaded state %s in every mode', relative => {
    const home = path.join(tmpdir(), 'kodax-host-loaded-fixture'); vi.stubEnv('KODAX_HOME', home);
    const file = path.join(home, relative);
    expect(isAgentHomeHardMutationTarget(file)).toBe(true);
    expect(isAgentHomeHostLoadedTarget(file)).toBe(true);
    expect(isProtectedAgentHomeMutationTarget(file)).toBe(true);
  },
);

it('keeps extension source readable and ordinary Agent Home files writable', () => {
  const home = path.join(tmpdir(), 'kodax-host-loaded-fixture'); vi.stubEnv('KODAX_HOME', home);
  expect(isAutoReadableAgentHomePath(path.join(home, 'extensions', 'planted.mjs'), home)).toBe(true);
  expect(isAgentHomeHardMutationTarget(path.join(home, 'notes', 'todo.md'))).toBe(false);
  expect(isAgentHomeHardMutationTarget(path.join(home, 'extensions-notes.md'))).toBe(false);
  // Host control state stays approvable for text tools through the outer permission policy.
  expect(isAgentHomeHostLoadedTarget(path.join(home, 'runtime', 'daemon.json'))).toBe(false);
  expect(isAgentHomeHostLoadedTarget(path.join(home, 'extensions-notes.md'))).toBe(false);
});
