import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  KodaXShellExecutionContract,
  KodaXToolExecutionContext,
} from '../types.js';
import { toolBash } from '../tools/bash.js';
import {
  buildNodeEnvironmentHelper,
  buildShellProbeArgs,
  clearShellExecutionEnvironmentCache,
} from './resolver.js';

function platformContract(
  setup?: string,
  refreshToken?: string,
): KodaXShellExecutionContract {
  return {
    version: 1,
    shell: {
      kind: process.platform === 'win32' ? 'cmd' : 'bash',
      profile: 'none',
    },
    environment: {
      inherit: 'filtered',
      ...(setup !== undefined ? { setup } : {}),
    },
    cache: { ttlMs: 60_000, ...(refreshToken ? { refreshToken } : {}) },
  };
}

function nodePrint(variable: string, powerShell = false): string {
  const script = `process.stdout.write(process.env.${variable}||'missing')`;
  if (powerShell) {
    return `& '${process.execPath.replaceAll("'", "''")}' -e "${script}"`;
  }
  return `"${process.execPath}" -e "${script}"`;
}

function context(
  executionCwd: string,
  shellExecution: KodaXShellExecutionContract,
): KodaXToolExecutionContext {
  return { backups: new Map(), executionCwd, shellExecution };
}

async function waitForFileText(filePath: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  clearShellExecutionEnvironmentCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolved shell execution', () => {
  it('inherits host credentials into profile setup and the final command', async () => {
    vi.stubEnv('GH_TOKEN', 'gh-secret');
    vi.stubEnv('OPENAI_API_KEY', 'provider-secret');
    vi.stubEnv('KODAX_SANDBOX_ENV_PASS', 'OPENAI_API_KEY');
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-env-pass-'));
    const setup = process.platform === 'win32'
      ? 'if defined GH_TOKEN (set "KODAX_SETUP_SAW_GH_TOKEN=yes") else (set "KODAX_SETUP_SAW_GH_TOKEN=no")'
      : 'if [ -n "${GH_TOKEN+x}" ]; then export KODAX_SETUP_SAW_GH_TOKEN=yes; else export KODAX_SETUP_SAW_GH_TOKEN=no; fi';
    const contract = platformContract(setup);
    const sdkContext = {
      ...context(cwd, contract),
      sandbox: { envPass: ['GH_TOKEN'] },
    };

    const allowed = await toolBash(
      { command: nodePrint('GH_TOKEN') },
      sdkContext,
    );
    const denied = await toolBash(
      { command: nodePrint('OPENAI_API_KEY') },
      sdkContext,
    );
    const setupObservation = await toolBash(
      { command: nodePrint('KODAX_SETUP_SAW_GH_TOKEN') },
      sdkContext,
    );

    expect(allowed).toContain('gh-secret');
    expect(denied).toContain('provider-secret');
    expect(setupObservation).toContain('yes');
  });

  it('lets two projects resolve different Node toolchains without cache crossover', async () => {
    const first = await mkdtemp(path.join(tmpdir(), 'kodax-shell-first-'));
    const second = await mkdtemp(path.join(tmpdir(), 'kodax-shell-second-'));
    for (const [cwd, version] of [[first, 'v20.project-a'], [second, 'v22.project-b']]) {
      const bin = path.join(cwd, 'toolchain-bin');
      await mkdir(bin);
      const executable = path.join(
        bin,
        process.platform === 'win32' ? 'node.cmd' : 'node',
      );
      await writeFile(
        executable,
        process.platform === 'win32'
          ? `@echo off\r\necho ${version}\r\n`
          : `#!/bin/sh\nprintf '${version}'\n`,
        'utf8',
      );
      if (process.platform !== 'win32') await chmod(executable, 0o755);
    }
    const setup = process.platform === 'win32'
      ? 'set "PATH=%CD%\\toolchain-bin;%PATH%"'
      : 'export PATH="$PWD/toolchain-bin:$PATH"';
    const contract = platformContract(setup);

    const firstResult = await toolBash(
      { command: 'node --version' },
      context(first, contract),
    );
    const secondResult = await toolBash(
      { command: 'node --version' },
      context(second, contract),
    );

    expect(firstResult).toContain('v20.project-a');
    expect(secondResult).toContain('v22.project-b');
  });

  it('strictly refreshes a cached environment when refreshToken changes', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-refresh-'));
    const valueFile = path.join(cwd, 'toolchain.txt');
    await writeFile(valueFile, 'first\n', 'utf8');
    const setup = process.platform === 'win32'
      ? `set /p KODAX_CACHE_VALUE=<"${valueFile}"`
      : `export KODAX_CACHE_VALUE="$(cat '${valueFile.replaceAll("'", "'\\''")}')"`;

    const first = await toolBash(
      { command: nodePrint('KODAX_CACHE_VALUE') },
      context(cwd, platformContract(setup, 'generation-1')),
    );
    await writeFile(valueFile, 'second\n', 'utf8');
    const cached = await toolBash(
      { command: nodePrint('KODAX_CACHE_VALUE') },
      context(cwd, platformContract(setup, 'generation-1')),
    );
    const refreshed = await toolBash(
      { command: nodePrint('KODAX_CACHE_VALUE') },
      context(cwd, platformContract(setup, 'generation-2')),
    );

    expect(first).toContain('first');
    expect(cached).toContain('first');
    expect(refreshed).toContain('second');
  });

  it('re-resolves the environment after the strict cache TTL expires', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-ttl-'));
    const valueFile = path.join(cwd, 'toolchain.txt');
    await writeFile(valueFile, 'first\n', 'utf8');
    const setup = process.platform === 'win32'
      ? `set /p KODAX_CACHE_VALUE=<"${valueFile}"`
      : `export KODAX_CACHE_VALUE="$(cat '${valueFile.replaceAll("'", "'\\''")}')"`;
    const contract: KodaXShellExecutionContract = {
      ...platformContract(setup),
      cache: { ttlMs: 100 },
    };

    const first = await toolBash(
      { command: nodePrint('KODAX_CACHE_VALUE') },
      context(cwd, contract),
    );
    await writeFile(valueFile, 'second\n', 'utf8');
    const cached = await toolBash(
      { command: nodePrint('KODAX_CACHE_VALUE') },
      context(cwd, contract),
    );
    now += 101;
    const refreshed = await toolBash(
      { command: nodePrint('KODAX_CACHE_VALUE') },
      context(cwd, contract),
    );

    expect(first).toContain('first');
    expect(cached).toContain('first');
    expect(refreshed).toContain('second');
  });

  it('does not share Session scratch variables through the cwd cache', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-scratch-'));
    const contract = platformContract();
    const first = await toolBash(
      { command: nodePrint('KODAX_SESSION_TMP') },
      {
        ...context(cwd, contract),
        sessionScratchDir: path.join(cwd, 'session-a'),
      },
    );
    const second = await toolBash(
      { command: nodePrint('KODAX_SESSION_TMP') },
      {
        ...context(cwd, contract),
        sessionScratchDir: path.join(cwd, 'session-b'),
      },
    );
    expect(first).toContain('session-a');
    expect(second).toContain('session-b');
  });

  it('inherits daemon provider credentials into the probe and command', async () => {
    vi.stubEnv('KODAX_TEST_API_KEY', 'must-not-leak');
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-secret-'));
    const result = await toolBash(
      { command: nodePrint('KODAX_TEST_API_KEY') },
      context(cwd, platformContract()),
    );
    expect(result).toContain('must-not-leak');
  });

  it('inherits inactive Provider credentials with non-standard names', async () => {
    vi.stubEnv('INACTIVE_PROVIDER_AUTH', 'must-not-leak');
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-inactive-secret-'));
    const result = await toolBash(
      { command: nodePrint('INACTIVE_PROVIDER_AUTH') },
      {
        ...context(cwd, platformContract()),
      },
    );
    expect(result).toContain('must-not-leak');
  });

  it('preserves daemon NODE_OPTIONS when starting the environment probe', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-node-options-'));
    const preload = path.join(cwd, 'node-options-preload.cjs');
    await writeFile(
      preload,
      "process.env.KODAX_NODE_OPTIONS_SEEN = 'yes';\n",
      'utf8',
    );
    vi.stubEnv('NODE_OPTIONS', `--require=${preload}`);
    const result = await toolBash(
      { command: nodePrint('KODAX_NODE_OPTIONS_SEEN') },
      context(cwd, platformContract()),
    );
    expect(result).toContain('yes');
    expect(result).not.toMatch(/configured shell environment could not be resolved/i);
  });

  it('fails closed when the selected shell is unavailable', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-missing-'));
    const contract: KodaXShellExecutionContract = {
      version: 1,
      shell: {
        kind: 'bash',
        executable: path.join(cwd, 'definitely-not-installed-shell'),
      },
    };
    const result = await toolBash(
      { command: nodePrint('PATH') },
      context(cwd, contract),
    );
    expect(result).toMatch(/configured shell is unavailable/i);
    expect(result).toMatch(/not started/i);
  });

  it.runIf(process.platform === 'win32')(
    'rejects pwsh login mode on Windows instead of silently ignoring it',
    async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-pwsh-login-'));
      const result = await toolBash(
        { command: 'echo should-not-run' },
        context(cwd, {
          version: 1,
          shell: { kind: 'pwsh', profile: 'login' },
        }),
      );
      expect(result).toMatch(/supported only on Linux and macOS/i);
      expect(result).toMatch(/not started/i);
    },
  );

  it('does not probe or start a configured shell after cancellation', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-cancelled-'));
    const controller = new AbortController();
    controller.abort();
    const result = await toolBash(
      { command: nodePrint('PATH') },
      {
        ...context(cwd, {
          version: 1,
          shell: {
            kind: 'bash',
            executable: path.join(cwd, 'missing-shell-must-not-be-probed'),
          },
        }),
        abortSignal: controller.signal,
      },
    );
    expect(result).toContain('[Cancelled] Operation cancelled by user');
    expect(result).not.toMatch(/configured shell is unavailable/i);
  });

  it('stops an in-flight environment probe when its only waiter is cancelled', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-mid-cancel-'));
    const pidFile = path.join(cwd, 'probe-child.pid');
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));`,
      'setTimeout(()=>{},5000)',
    ].join('');
    const encoded = Buffer.from(script).toString('base64');
    const setup =
      `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
    const controller = new AbortController();

    const pending = toolBash(
      { command: 'echo must-not-run' },
      {
        ...context(cwd, {
          ...platformContract(setup),
          cache: { ttlMs: 0 },
        }),
        abortSignal: controller.signal,
      },
    );
    const probePid = Number(await waitForFileText(pidFile));
    expect(Number.isInteger(probePid) && probePid > 0).toBe(true);
    controller.abort();

    expect(await pending).toContain('[Cancelled] Operation cancelled by user');
    expect(isPidAlive(probePid)).toBe(false);
  });

  it('keeps a shared environment probe alive for a remaining waiter', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-shared-probe-'));
    const delayScript = Buffer.from('setTimeout(()=>{},400)').toString('base64');
    const setup =
      `"${process.execPath}" -e "eval(Buffer.from('${delayScript}','base64').toString())"`;
    const contract: KodaXShellExecutionContract = {
      ...platformContract(setup),
      cache: { ttlMs: 0 },
    };
    const firstController = new AbortController();

    const cancelled = toolBash(
      { command: 'echo cancelled-command-must-not-run' },
      {
        ...context(cwd, contract),
        abortSignal: firstController.signal,
      },
    );
    const remaining = toolBash(
      { command: 'echo shared-probe-completed' },
      context(cwd, contract),
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    firstController.abort();

    expect(await cancelled).toContain('[Cancelled] Operation cancelled by user');
    expect(await remaining).toContain('shared-probe-completed');
  });

  it('starts a fresh probe for a caller arriving after the last waiter cancels', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-retry-probe-'));
    const probeCount = path.join(cwd, 'probe-count.txt');
    const delayScript = Buffer.from([
      `require("node:fs").appendFileSync(${JSON.stringify(probeCount)},"x");`,
      'setTimeout(()=>{},400)',
    ].join('')).toString('base64');
    const setup =
      `"${process.execPath}" -e "eval(Buffer.from('${delayScript}','base64').toString())"`;
    const contract: KodaXShellExecutionContract = {
      ...platformContract(setup),
      cache: { ttlMs: 60_000 },
    };
    const controller = new AbortController();
    const cancelled = toolBash(
      { command: 'echo cancelled-command-must-not-run' },
      {
        ...context(cwd, contract),
        abortSignal: controller.signal,
      },
    );
    await vi.waitFor(() => {
      expect(existsSync(probeCount)).toBe(true);
    }, { timeout: 2_000 });
    controller.abort();
    const retried = toolBash(
      { command: 'echo fresh-probe-completed' },
      context(cwd, contract),
    );
    expect(await cancelled).toContain('[Cancelled] Operation cancelled by user');

    const retryResult = await retried;
    expect(retryResult).toContain('fresh-probe-completed');
    expect(retryResult).not.toContain('[Cancelled]');
    expect(await readFile(probeCount, 'utf8')).toBe('xx');
  });

  it.runIf(process.platform === 'win32')(
    'loads a trusted PowerShell setup profile in the project cwd',
    async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-pwsh-'));
      const profile = path.join(cwd, 'toolchain-profile.ps1');
      await writeFile(
        profile,
        '$env:KODAX_PROFILE_CWD = (Get-Location).Path\n',
        'utf8',
      );
      const contract: KodaXShellExecutionContract = {
        version: 1,
        shell: { kind: 'powershell', profile: 'none' },
        environment: { setup: `. '${profile.replaceAll("'", "''")}'` },
      };
      const result = await toolBash(
        { command: nodePrint('KODAX_PROFILE_CWD', true) },
        context(cwd, contract),
      );
      expect(result.toLowerCase()).toContain((await realpath(cwd)).toLowerCase());
    },
  );

  it.runIf(process.platform === 'win32')(
    'resolves a command from the current Windows registry environment',
    async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-registry-'));
      const result = await toolBash(
        { command: nodePrint('SystemRoot', true) },
        context(cwd, {
          version: 1,
          shell: { kind: 'powershell', profile: 'none' },
          environment: { windowsPath: 'registry' },
          cache: { ttlMs: 0 },
        }),
      );
      expect(result).toContain(process.env.SystemRoot);
      expect(result).not.toMatch(/registry PATH could not be resolved/i);
    },
  );

  it.runIf(
    process.platform === 'win32'
      && existsSync('C:\\Program Files\\Git\\bin\\bash.exe'),
  )('does not append cmd-only hints to configured Git Bash output', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-shell-git-bash-'));
    const result = await toolBash(
      { command: "cat <<'EOF'\nhello\nEOF" },
      context(cwd, {
        version: 1,
        shell: {
          kind: 'bash',
          executable: 'C:\\Program Files\\Git\\bin\\bash.exe',
          profile: 'none',
        },
        cache: { ttlMs: 0 },
      }),
    );
    expect(result).toContain('hello');
    expect(result).not.toMatch(/Windows cmd does not support heredoc/i);
  });
});

describe('shell probe argv contract', () => {
  it('bounds packaged Electron Node mode to the environment helper invocation', () => {
    const executable =
      process.platform === 'win32'
        ? 'C:\\Program Files\\KodaX Space\\KodaX Space.exe'
        : '/Applications/KodaX Space.app/Contents/MacOS/KodaX Space';
    const sentinel = '__KODAX_ENV_TEST__';

    for (const kind of ['powershell', 'cmd', 'bash'] as const) {
      const command = buildNodeEnvironmentHelper(kind, sentinel, executable, true);
      expect(command).toContain('ELECTRON_RUN_AS_NODE');
      expect(command).toContain('--import');
      expect(command).toContain('delete%20process.env.ELECTRON_RUN_AS_NODE');
      expect(command).toContain(sentinel);
    }
  });

  it('keeps ordinary Node environment helpers free of Electron bootstrap state', () => {
    const command = buildNodeEnvironmentHelper(
      process.platform === 'win32' ? 'powershell' : 'bash',
      '__KODAX_ENV_TEST__',
      process.execPath,
      false,
    );

    expect(command).not.toContain('ELECTRON_RUN_AS_NODE');
    expect(command).not.toContain('--import');
  });

  it('runs the standalone executable as Bun for the JavaScript environment helper', () => {
    const command = buildNodeEnvironmentHelper(
      process.platform === 'win32' ? 'powershell' : 'bash',
      '__KODAX_ENV_TEST__',
      process.platform === 'win32' ? 'C:\\KodaX\\kodax.exe' : '/opt/kodax/kodax',
      false,
      true,
    );

    expect(command).toContain('BUN_BE_BUN');
    expect(command).toContain('-e');
    expect(command).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('places pwsh login first and does not contradict interactive mode', () => {
    const login = buildShellProbeArgs(
      'pwsh',
      ['-ExecutionPolicy', 'Bypass'],
      'login',
      'Write-Output ok',
    );
    expect(login[0]).toBe('-Login');
    expect(login).toContain('-NonInteractive');

    const interactive = buildShellProbeArgs(
      'pwsh',
      undefined,
      'login-interactive',
      'Write-Output ok',
    );
    expect(interactive[0]).toBe('-Login');
    expect(interactive).toContain('-Interactive');
    expect(interactive).not.toContain('-NonInteractive');
  });

  it('disables cmd delayed expansion before running probe commands', () => {
    const args = buildShellProbeArgs('cmd', undefined, 'default', 'echo !SECRET!');

    expect(args).toEqual(['/d', '/v:off', '/s', '/c', 'echo !SECRET!']);
  });

  it('loads PowerShell profiles only when the normalized profile policy allows it', () => {
    const defaultProfile = buildShellProbeArgs(
      'powershell',
      undefined,
      'default',
      'Write-Output ok',
    );
    const noProfile = buildShellProbeArgs(
      'powershell',
      undefined,
      'none',
      'Write-Output ok',
    );

    expect(defaultProfile).not.toContain('-NoProfile');
    expect(noProfile).toContain('-NoProfile');
    expect(defaultProfile.at(-2)).toBe('-Command');
    expect(noProfile.at(-2)).toBe('-Command');
  });
});
