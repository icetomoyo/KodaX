import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setAgentConfigHome } from '@kodax-ai/agent';
import type { RunnerToolCall } from '@kodax-ai/agent';

import {
  replBashPathSignalCollector,
  replBashUserKodaxWriteDeny,
} from './repl-bash-signals.js';

const PROJECT_ROOT = path.resolve('/tmp/kodax-repl-bash-signals-test');
const USER_KODAX = path.resolve('/tmp/kodax-repl-bash-signals-test-home/.kodax');

function bash(command: string): RunnerToolCall {
  return { id: 'c', name: 'bash', input: { command } };
}

describe('replBashPathSignalCollector — tool name', () => {
  it('matches bash only', () => {
    expect(replBashPathSignalCollector.toolNames.has('bash')).toBe(true);
    expect(replBashPathSignalCollector.toolNames.has('write')).toBe(false);
  });
});

describe('replBashPathSignalCollector — protected_path detection', () => {
  beforeEach(() => {
    setAgentConfigHome(USER_KODAX);
  });
  afterEach(() => {
    setAgentConfigHome(undefined);
  });

  it('detects ~/.kodax write target via redirect', () => {
    const cmd = `echo x > ${USER_KODAX}/leak.txt`;
    const signals = replBashPathSignalCollector.collect(bash(cmd), PROJECT_ROOT);
    expect(signals.some((s) => s.kind === 'protected_path' && s.zone === 'user-kodax')).toBe(true);
  });

  it('detects <projectRoot>/.kodax path via argv', () => {
    const cmd = `cat ${PROJECT_ROOT}/.kodax/permissions.json`;
    const signals = replBashPathSignalCollector.collect(bash(cmd), PROJECT_ROOT);
    expect(signals.some((s) => s.kind === 'protected_path' && s.zone === 'project-kodax')).toBe(true);
  });
});

describe('replBashPathSignalCollector — outside_project', () => {
  beforeEach(() => {
    setAgentConfigHome(USER_KODAX);
  });
  afterEach(() => {
    setAgentConfigHome(undefined);
  });

  it('does NOT emit outside_project for system temp (safe scratchpad)', () => {
    // Use os.tmpdir() directly — `/tmp` is POSIX-only; on Windows it resolves
    // to `C:\tmp` which is NOT the actual system temp dir.
    const tempScratch = path.join(os.tmpdir(), 'scratch.txt');
    const signals = replBashPathSignalCollector.collect(
      bash(`echo x > ${JSON.stringify(tempScratch.replaceAll('\\', '/'))}`),
      PROJECT_ROOT,
    );
    expect(signals.some((s) => s.kind === 'outside_project')).toBe(false);
    expect(signals.some((s) => s.kind === 'shell_redirect_outside')).toBe(false);
  });

  it.runIf(process.platform === 'win32')('does not turn either short-name temp spelling into an outside-project signal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-signal-short-'));
    try {
      const alias = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${root}") do @echo %~sI`],
        { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
      expect(alias.status).toBe(0);
      const canonical = fs.realpathSync.native(root);
      const short = alias.stdout.trim();
      expect(fs.realpathSync.native(short).toLowerCase()).toBe(canonical.toLowerCase());
      for (const shortSide of ['environment', 'target']) {
        for (const name of ['TEMP', 'TMP', 'TMPDIR']) vi.stubEnv(name, shortSide === 'environment' ? short : canonical);
        const target = path.join(shortSide === 'target' ? short : canonical, 'scratch.txt');
        const signals = replBashPathSignalCollector.collect(bash(`echo x > ${JSON.stringify(target.replaceAll('\\', '/'))}`), PROJECT_ROOT);
        expect(signals).toEqual([]);
      }
    } finally { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('resolves redirects from executionCwd without changing the project boundary', () => {
    const executionCwd = path.join(PROJECT_ROOT, 'packages', 'app');
    const signals = replBashPathSignalCollector.collect(
      bash('echo x > ../../src/generated.ts'),
      PROJECT_ROOT,
      executionCwd,
    );

    expect(signals.some((s) => s.kind === 'outside_project')).toBe(false);
    expect(signals.some((s) => s.kind === 'shell_redirect_outside')).toBe(false);
  });
});

describe('replBashPathSignalCollector — empty / invalid input', () => {
  it('returns empty for empty projectRoot', () => {
    const signals = replBashPathSignalCollector.collect(bash('rm foo'), '');
    expect(signals).toEqual([]);
  });

  it('returns empty for missing command', () => {
    const signals = replBashPathSignalCollector.collect({ id: 'c', name: 'bash', input: {} }, PROJECT_ROOT);
    expect(signals).toEqual([]);
  });
});

// ============== FEATURE_158 Step 9 — Issue 131 (Windows-flag) pipeline regression ==============

describe('FEATURE_158 Step 9 — Windows-flag false-positive pipeline regression (Issue 131)', () => {
  it.runIf(process.platform === 'win32')(
    'findstr /R argv does NOT trigger protected_path or outside_project signal',
    () => {
      // Headline regression: the entire reason FEATURE_158 fixes Issue 131
      // is that `/R` was being misclassified as a POSIX absolute path.
      // Post-fix the repl-side collector must produce no false signals.
      const signals = replBashPathSignalCollector.collect(
        bash('findstr /R needle file.txt'),
        process.cwd(),
      );
      expect(signals.some((s) => s.kind === 'protected_path')).toBe(false);
      expect(signals.some((s) => s.kind === 'outside_project')).toBe(false);
      expect(signals.some((s) => s.kind === 'shell_redirect_outside')).toBe(false);
    },
  );

  it.runIf(process.platform === 'win32').each([
    ['dir /B'],
    ['xcopy src dst /Y'],
    ['where /R . node.exe'],
    ['fc /B a.bin b.bin'],
    ['robocopy src dst /MIR'],
    ['findstr /A:H pattern file'],
  ])('Windows-flag command "%s" produces no false signals', (cmd) => {
    const signals = replBashPathSignalCollector.collect(bash(cmd), process.cwd());
    expect(signals.some((s) => s.kind === 'protected_path')).toBe(false);
    expect(signals.some((s) => s.kind === 'outside_project')).toBe(false);
    expect(signals.some((s) => s.kind === 'shell_redirect_outside')).toBe(false);
  });
});

describe('replBashUserKodaxWriteDeny', () => {
  beforeEach(() => {
    setAgentConfigHome(USER_KODAX);
  });
  afterEach(() => {
    setAgentConfigHome(undefined);
  });

  it('hard-denies deterministic redirect writes to the configured credential zone', () => {
    expect(replBashUserKodaxWriteDeny(
      bash(`echo secret > ${USER_KODAX}/credentials.json`),
      PROJECT_ROOT,
      PROJECT_ROOT,
    )).toMatchObject({ denied: true, patternId: 'user_kodax_write' });
  });

  it('hard-denies a proven redirect even when unrelated shell syntax is unparseable', () => {
    expect(replBashUserKodaxWriteDeny(
      bash(`echo secret > ${USER_KODAX}/credentials.json $(dynamic-source)`),
      PROJECT_ROOT,
      PROJECT_ROOT,
    )).toMatchObject({ denied: true, patternId: 'user_kodax_write' });
  });

  it('hard-denies an unparseable redirect inside a nested shell payload', () => {
    expect(replBashUserKodaxWriteDeny(
      bash('bash -c "echo secret > ~/.kodax/credentials.json `dynamic-source`"'),
      PROJECT_ROOT,
      PROJECT_ROOT,
    )).toMatchObject({ denied: true, patternId: 'user_kodax_write' });
  });

  it.runIf(process.platform === 'win32')('hard-denies case-varied Windows redirect targets', () => {
    expect(replBashUserKodaxWriteDeny(
      bash(`echo secret > ${USER_KODAX.toUpperCase()}\\CREDENTIALS.JSON`),
      PROJECT_ROOT,
      PROJECT_ROOT,
    )).toMatchObject({ denied: true, patternId: 'user_kodax_write' });
  });

  it('hard-denies nested shell redirects to literal ~/.kodax', () => {
    expect(replBashUserKodaxWriteDeny(
      bash('bash -c "echo secret > ~/.kodax/credentials.json"'),
      PROJECT_ROOT,
      PROJECT_ROOT,
    )).toMatchObject({ denied: true, patternId: 'user_kodax_write' });
  });

  it('hard-denies shell-expanded home aliases that target ~/.kodax', () => {
    const aliases = process.platform === 'win32'
      ? ['$HOME', '${HOME}', '%USERPROFILE%', '$env:USERPROFILE']
      : ['$HOME', '${HOME}'];
    for (const alias of aliases) {
      expect(replBashUserKodaxWriteDeny(
        bash(`echo secret > "${alias}/.kodax/credentials.json"`),
        PROJECT_ROOT,
        PROJECT_ROOT,
      ), alias).toMatchObject({ denied: true, patternId: 'user_kodax_write' });
    }
  });

  it('distinguishes a protected read source from the actual write destination', () => {
    expect(replBashUserKodaxWriteDeny(
      bash('cp "$HOME/.kodax/config.json" ./config-backup.json'),
      PROJECT_ROOT,
      PROJECT_ROOT,
    )).toEqual({ denied: false });
    expect(replBashUserKodaxWriteDeny(
      bash('cat "$HOME/.kodax/config.json" > ./config-backup.json'),
      PROJECT_ROOT,
      PROJECT_ROOT,
    )).toEqual({ denied: false });
    expect(replBashUserKodaxWriteDeny(
      bash('echo "example > $HOME/.kodax/config.json" > ./example.txt'),
      PROJECT_ROOT,
      PROJECT_ROOT,
    )).toEqual({ denied: false });
    expect(replBashUserKodaxWriteDeny(
      bash('cp ./replacement.json "$HOME/.kodax/config.json"'),
      PROJECT_ROOT,
      PROJECT_ROOT,
    )).toMatchObject({ denied: true, patternId: 'user_kodax_write' });
  });

  it.each([
    `Copy-Item replacement.json "${USER_KODAX}/copied.json"`,
    `Move-Item -Force replacement.json "${USER_KODAX}/moved.json"`,
    `Set-Content -Value data "${USER_KODAX}/set.json"`,
    `Out-File -InputObject data -FilePath "${USER_KODAX}/out.json"`,
    `New-Item -ItemType File "${USER_KODAX}/new.json"`,
    `Remove-Item -Filter harmless.txt "${USER_KODAX}/old.json"`,
  ])('hard-denies command-bound PowerShell mutation target: %s', (command) => {
    expect(replBashUserKodaxWriteDeny(
      bash(command),
      PROJECT_ROOT,
      PROJECT_ROOT,
    )).toMatchObject({ denied: true, patternId: 'user_kodax_write' });
  });

  it('hard-denies redirects through an absolute nested shell executable', () => {
    const shell = process.platform === 'win32'
      ? '"C:\\Program Files\\Git\\bin\\bash.exe"'
      : '/bin/bash';
    expect(replBashUserKodaxWriteDeny(
      bash(`${shell} -c "echo secret > ~/.kodax/credentials.json"`),
      PROJECT_ROOT,
      PROJECT_ROOT,
    )).toMatchObject({ denied: true, patternId: 'user_kodax_write' });
  });

  it('does not interpret quoted Python or regex source as a write target', () => {
    expect(replBashUserKodaxWriteDeny(
      bash('python -c "print(\'~/.kodax/config.json\')"'),
      PROJECT_ROOT,
      PROJECT_ROOT,
    )).toEqual({ denied: false });
    expect(replBashUserKodaxWriteDeny(
      bash('rg "~/.kodax/[a-z]+" src'),
      PROJECT_ROOT,
      PROJECT_ROOT,
    )).toEqual({ denied: false });
  });

  it('allows read-only access to continue to classifier policy', () => {
    expect(replBashUserKodaxWriteDeny(
      bash(`cat ${USER_KODAX}/config.json`),
      PROJECT_ROOT,
      PROJECT_ROOT,
    )).toEqual({ denied: false });
  });
});
