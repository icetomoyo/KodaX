/**
 * v0.7.35.1 FEATURE_145 — agent-home 3-tier resolution unit tests.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getActiveAgentHomes,
  getAgentConfigHome,
  getAgentConfigPath,
  getAppDataDir,
  isPathInsideDirectory,
  registerRuntimeAgentHome,
  resolveExecutionPath,
  resolveKodaXHome,
  setAgentConfigHome,
} from './agent-home.js';

describe('resolveKodaXHome — pure env/default resolution', () => {
  const absolute = join(resolve(tmpdir()), 'kodax-resolver-home');

  it('uses an absolute KODAX_HOME as the data root itself', () => {
    expect(resolveKodaXHome({ env: { KODAX_HOME: absolute } })).toEqual({ path: absolute, source: 'env' });
  });

  it('falls back to <homeDir>/.kodax, where homeDir owns .kodax like CLI --home', () => {
    const homeDir = join(resolve(tmpdir()), 'owner');
    expect(resolveKodaXHome({ env: {}, homeDir })).toEqual({ path: join(homeDir, '.kodax'), source: 'default' });
    expect(resolveKodaXHome({ env: {} })).toEqual({ path: join(homedir(), '.kodax'), source: 'default' });
  });

  it('treats an empty KODAX_HOME as unset without reporting it', () => {
    expect(resolveKodaXHome({ env: { KODAX_HOME: '' } })).toEqual({ path: join(homedir(), '.kodax'), source: 'default' });
  });

  it('ignores a relative KODAX_HOME and reports it so callers can warn', () => {
    expect(resolveKodaXHome({ env: { KODAX_HOME: 'relative/kodax' } })).toEqual({
      path: join(homedir(), '.kodax'),
      source: 'default',
      ignoredEnv: 'relative/kodax',
    });
  });

  it('does not read or change process state', () => {
    const before = process.env.KODAX_HOME;
    process.env.KODAX_HOME = join(resolve(tmpdir()), 'from-process');
    try {
      expect(resolveKodaXHome({ env: {} }).source).toBe('default');
      expect(process.env.KODAX_HOME).toBe(join(resolve(tmpdir()), 'from-process'));
    } finally {
      if (before === undefined) delete process.env.KODAX_HOME;
      else process.env.KODAX_HOME = before;
    }
  });

  it('reads process.env only when no env is given', () => {
    const before = process.env.KODAX_HOME;
    process.env.KODAX_HOME = absolute;
    try {
      expect(resolveKodaXHome()).toEqual({ path: absolute, source: 'env' });
    } finally {
      if (before === undefined) delete process.env.KODAX_HOME;
      else process.env.KODAX_HOME = before;
    }
  });

  it.each([
    ['unset', {}],
    ['empty', { KODAX_HOME: '' }],
    ['absolute', { KODAX_HOME: absolute }],
    ['relative', { KODAX_HOME: 'relative/kodax' }],
  ])('getAgentConfigHome agrees with the resolver when KODAX_HOME is %s', (_name, env) => {
    const before = process.env.KODAX_HOME;
    setAgentConfigHome(undefined);
    if (env.KODAX_HOME === undefined) delete process.env.KODAX_HOME;
    else process.env.KODAX_HOME = env.KODAX_HOME;
    try {
      expect(getAgentConfigHome()).toBe(resolveKodaXHome({ env }).path);
    } finally {
      if (before === undefined) delete process.env.KODAX_HOME;
      else process.env.KODAX_HOME = before;
    }
  });
});

describe('agent-home — 3-tier resolution', () => {
  const originalEnv = process.env.KODAX_HOME;

  beforeEach(() => {
    setAgentConfigHome(undefined);
    delete process.env.KODAX_HOME;
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    if (originalEnv === undefined) {
      delete process.env.KODAX_HOME;
    } else {
      process.env.KODAX_HOME = originalEnv;
    }
  });

  describe('tier 3 — default', () => {
    it('returns ~/.kodax when neither override nor env is set', () => {
      expect(getAgentConfigHome()).toBe(join(homedir(), '.kodax'));
    });

    it('getAgentConfigPath joins under the default home', () => {
      expect(getAgentConfigPath('mcp-tokens', 'foo.json')).toBe(
        join(homedir(), '.kodax', 'mcp-tokens', 'foo.json'),
      );
    });

    it('getAgentConfigPath with no segments returns the home dir itself', () => {
      expect(getAgentConfigPath()).toBe(getAgentConfigHome());
    });
  });

  describe('tier 2 — KODAX_HOME env var', () => {
    it('returns the env var value when set', () => {
      process.env.KODAX_HOME = '/tmp/kodax-test-env';
      expect(getAgentConfigHome()).toBe('/tmp/kodax-test-env');
    });

    it('sub-paths are joined under the env value', () => {
      process.env.KODAX_HOME = '/tmp/kodax-test-env';
      expect(getAgentConfigPath('skills', 'foo')).toBe(
        join('/tmp/kodax-test-env', 'skills', 'foo'),
      );
    });

    it('empty env var falls through to default', () => {
      process.env.KODAX_HOME = '';
      expect(getAgentConfigHome()).toBe(join(homedir(), '.kodax'));
    });
  });

  describe('tier 1 — programmatic override', () => {
    it('overrides env var', () => {
      process.env.KODAX_HOME = '/tmp/from-env';
      setAgentConfigHome('/tmp/from-override');
      expect(getAgentConfigHome()).toBe('/tmp/from-override');
    });

    it('overrides default', () => {
      setAgentConfigHome('/tmp/from-override');
      expect(getAgentConfigHome()).toBe('/tmp/from-override');
    });

    it('setting to undefined resets to env / default', () => {
      setAgentConfigHome('/tmp/something');
      setAgentConfigHome(undefined);
      expect(getAgentConfigHome()).toBe(join(homedir(), '.kodax'));
    });
  });

  describe('priority order — full 3-tier chain', () => {
    it('override > env > default — verifying full chain', () => {
      // Default (no override, no env)
      expect(getAgentConfigHome()).toBe(join(homedir(), '.kodax'));

      // Env beats default
      process.env.KODAX_HOME = '/from-env';
      expect(getAgentConfigHome()).toBe('/from-env');

      // Override beats env
      setAgentConfigHome('/from-override');
      expect(getAgentConfigHome()).toBe('/from-override');

      // Reset override → env wins again
      setAgentConfigHome(undefined);
      expect(getAgentConfigHome()).toBe('/from-env');

      // Unset env → default wins again
      delete process.env.KODAX_HOME;
      expect(getAgentConfigHome()).toBe(join(homedir(), '.kodax'));
    });
  });
});

describe('runtime path containment', () => {
  it('contains the directory itself and descendants without prefix confusion', () => {
    const root = join(homedir(), '.kodax');
    expect(isPathInsideDirectory(root, root)).toBe(true);
    expect(isPathInsideDirectory(join(root, 'runtime', 'state.json'), root)).toBe(true);
    expect(isPathInsideDirectory(`${root}-backup`, root)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('uses Windows case-insensitive semantics', () => {
    expect(isPathInsideDirectory(
      'C:\\Users\\Example\\.KODAX\\config.json',
      'c:\\users\\example\\.kodax',
    )).toBe(true);
  });

  it('handles filesystem roots without adding a duplicate separator', () => {
    const root = parse(homedir()).root;
    expect(isPathInsideDirectory(homedir(), root)).toBe(true);
  });

  it('resolves relative paths from executionCwd and expands home-relative paths', () => {
    const cwd = join(homedir(), 'workspace');
    expect(resolveExecutionPath('src/index.ts', cwd)).toBe(join(cwd, 'src', 'index.ts'));
    expect(resolveExecutionPath('~/.kodax/config.json', cwd)).toBe(
      join(homedir(), '.kodax', 'config.json'),
    );
  });
});

describe('runtime agent homes', () => {
  const processHome = join(tmpdir(), 'kodax-process-home');
  const runtimeHome = join(tmpdir(), 'kodax-runtime-home');

  beforeEach(() => {
    setAgentConfigHome(processHome);
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
  });

  it('lists only the process agent home when no Runtime registered one', () => {
    expect(getActiveAgentHomes()).toEqual([resolve(processHome)]);
  });

  it('adds a registered Runtime agent home until it is released', () => {
    const release = registerRuntimeAgentHome(runtimeHome);

    expect(getActiveAgentHomes()).toEqual([resolve(processHome), resolve(runtimeHome)]);

    release();
    expect(getActiveAgentHomes()).toEqual([resolve(processHome)]);
  });

  it('keeps a home while any of its registrations is open', () => {
    const first = registerRuntimeAgentHome(runtimeHome);
    const second = registerRuntimeAgentHome(runtimeHome);

    first();
    first();
    expect(getActiveAgentHomes()).toContain(resolve(runtimeHome));

    second();
    expect(getActiveAgentHomes()).not.toContain(resolve(runtimeHome));
  });

  it('does not repeat the process agent home when a Runtime registers it', () => {
    const release = registerRuntimeAgentHome(join(processHome, '.'));
    try {
      expect(getActiveAgentHomes()).toEqual([resolve(processHome)]);
    } finally {
      release();
    }
  });

  it.runIf(process.platform === 'win32')('treats differently cased Windows paths as one home', () => {
    const release = registerRuntimeAgentHome(processHome.toUpperCase());
    try {
      expect(getActiveAgentHomes()).toEqual([resolve(processHome)]);
    } finally {
      release();
    }
  });
});

describe('getAppDataDir — third-party namespace under ~/.kodax/apps/', () => {
  let tmpHome: string;
  const originalEnv = process.env.KODAX_HOME;

  beforeEach(() => {
    setAgentConfigHome(undefined);
    delete process.env.KODAX_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'kodax-appdata-test-'));
    setAgentConfigHome(tmpHome);
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    if (originalEnv === undefined) {
      delete process.env.KODAX_HOME;
    } else {
      process.env.KODAX_HOME = originalEnv;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates ~/.kodax/apps/<appId>/ and returns it', () => {
    const dir = getAppDataDir('space');
    expect(dir).toBe(join(tmpHome, 'apps', 'space'));
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('is idempotent — second call on existing dir returns same path', () => {
    const a = getAppDataDir('space');
    const b = getAppDataDir('space');
    expect(a).toBe(b);
  });

  it('accepts valid kebab-case appIds', () => {
    expect(() => getAppDataDir('vs-code-ext')).not.toThrow();
    expect(() => getAppDataDir('a1')).not.toThrow();
    expect(() => getAppDataDir('a'.repeat(32))).not.toThrow();
  });

  it.each([
    ['empty string', ''],
    ['single char (too short)', 'a'],
    ['too long (33 chars)', 'a'.repeat(33)],
    ['starts with digit', '1space'],
    ['starts with dash', '-space'],
    ['uppercase', 'Space'],
    ['underscore', 'my_app'],
    ['dot', 'my.app'],
    ['slash', 'my/app'],
    ['backslash', 'my\\app'],
    ['traversal', '..'],
    ['nested traversal', 'a/../b'],
    ['space char', 'my app'],
    ['unicode', 'spáce'],
  ])('rejects invalid appId: %s', (_label, appId) => {
    expect(() => getAppDataDir(appId)).toThrow(/invalid appId/);
  });

  it.each([
    ['reserved literal', 'kodax'],
    ['reserved prefix', 'kodax-space'],
    ['reserved prefix-only', 'kodax-'],
  ])('rejects reserved name: %s', (_label, appId) => {
    expect(() => getAppDataDir(appId)).toThrow(/reserved/);
  });

  it('rejects non-string appId', () => {
    // @ts-expect-error — testing runtime validation
    expect(() => getAppDataDir(undefined)).toThrow(/invalid appId/);
    // @ts-expect-error
    expect(() => getAppDataDir(123)).toThrow(/invalid appId/);
    // @ts-expect-error
    expect(() => getAppDataDir(null)).toThrow(/invalid appId/);
  });

  it('honors setAgentConfigHome override (programmatic)', () => {
    const dir = getAppDataDir('myapp');
    expect(dir.startsWith(tmpHome)).toBe(true);
  });
});
