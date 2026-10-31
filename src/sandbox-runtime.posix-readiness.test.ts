import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setAgentConfigHome } from '@kodax-ai/agent';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/sandbox-runtime', async (original) => ({
  ...(await original<typeof import('@anthropic-ai/sandbox-runtime')>()),
  SandboxManager: {
    isSupportedPlatform: () => true,
    checkDependencies: () => ({ errors: [], warnings: [] }),
  },
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import { doctorKodaXSandbox, getKodaXSandboxSetupGuidance } from './sdk-sandbox.js';
import { createAsrtShellSandbox, doctorSandboxRuntime, resetSandboxRuntimeForTest } from './sandbox-runtime.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const electron = Object.getOwnPropertyDescriptor(process.versions, 'electron');
let configHome: string;

beforeAll(async () => {
  configHome = await mkdtemp(path.join(os.tmpdir(), 'kodax-posix-readiness-'));
  setAgentConfigHome(configHome);
});

afterAll(async () => {
  setAgentConfigHome(undefined);
  await rm(configHome, { recursive: true, force: true });
});

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  delete process.versions.electron;
  vi.stubEnv('KODAX_BUNDLED', 'true');
  vi.stubEnv('KODAX_A2A_NODE', undefined);
  vi.stubEnv('PATH', '');
  vi.stubEnv('PROGRAMDATA', configHome);
  vi.mocked(spawnSync).mockClear();
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  if (electron) Object.defineProperty(process.versions, 'electron', electron);
  else delete process.versions.electron;
  await resetSandboxRuntimeForTest();
  vi.unstubAllEnvs();
});

describe('POSIX interpreter readiness', () => {
  it('diagnoses missing Node through the public doctor and setup guidance', async () => {
    const doctor = await doctorKodaXSandbox();
    expect(doctor).toMatchObject({ ready: false, setupRequired: true, platform: 'linux' });
    expect(doctor.diagnostics.join('\n')).toMatch(/JavaScript Skill interpreter is unavailable:.*ENOENT/);
    expect(getKodaXSandboxSetupGuidance(doctor).join('\n')).toContain('KODAX_A2A_NODE');
  });

  it.runIf(platform.value === 'linux')('does not gate ordinary Linux shell preparation on doctor readiness', async () => {
    await expect(doctorKodaXSandbox()).resolves.toMatchObject({ ready: false });
    const invocation = await createAsrtShellSandbox({ workspaceRoot: configHome, shouldSandbox: () => true })
      .prepare({ toolCallId: 'missing-node', toolInput: { command: 'echo ready' }, command: 'echo ready',
        cwd: process.cwd(), env: process.env, fallbackToNormalExecution: false });
    // Ordinary Bash still attempts the broker; readiness is not permission or a setup gate.
    expect(invocation).toBeDefined();
    await expect(invocation!.cleanup({ execution: 'not_started' })).resolves.toBeUndefined();
  });

  it.each([false, true])('reuses Electron or a supplied interpreter with no Node on PATH (override=%s)', async (override) => {
    Object.defineProperty(process.versions, 'electron', { configurable: true, value: 'test-electron' });
    if (override) vi.stubEnv('KODAX_A2A_NODE', process.execPath);
    await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({ ready: true, setupRequired: false });
    expect(spawnSync).toHaveBeenCalledOnce();
    expect(spawnSync).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(['--version']), expect.objectContaining({
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1', PATH: '' }),
    }));
  });

  it('uses an explicitly supplied Node interpreter outside Electron without searching PATH', async () => {
    vi.stubEnv('KODAX_A2A_NODE', process.execPath);
    await expect(doctorSandboxRuntime({ refresh: true })).resolves.toMatchObject({ ready: true });
    expect(spawnSync).toHaveBeenCalledWith(process.execPath, ['--version'], expect.objectContaining({
      env: expect.not.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    }));
  });
});
