import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { KodaXShellExecutionContract } from '../../packages/coding/src/types.js';
import { buildShellProbeEnvironment } from '../../packages/coding/src/shell-execution/environment.js';

export const NATURAL_ENVIRONMENT_REVISION = '2026-10-28-topology-preflight-v2';

/** Host preflight, never a model tool or an expansion of the execution allowlist. */
export function checkUnmarkedTemporaryRoot(environment: NodeJS.ProcessEnv): { status: 'ready' | 'eval-invalid'; reason: string } {
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    let current = fs.mkdtempSync(path.join(os.tmpdir(), 'topology-probe-'));
    const root = current;
    let reason = 'unmarked-ancestors';
    try {
      for (;;) {
        try { fs.statSync(path.join(current, '.git')); reason = 'git-ancestor'; break; }
        catch (error) { if (error.code !== 'ENOENT') { reason = 'ancestor-probe-' + error.code; break; } }
        const parent = path.dirname(current); if (parent === current) break; current = parent;
      }
    } finally { fs.rmdirSync(root); }
    process.stdout.write(reason);
  `], { env: environment, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const reason = probe.status === 0 ? probe.stdout.trim() : 'probe-execution-failed';
  return { status: reason === 'unmarked-ancestors' ? 'ready' : 'eval-invalid', reason };
}

/** Controlled Node fixtures, not a security sandbox for hostile programs. */
export async function prepareNaturalExecutionEnvironment(workspace: string) {
  const home = path.join(workspace, '.agent', 'tmp', 'execution-home');
  const temporary = path.join(workspace, '.agent', 'tmp', 'execution-temp');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(temporary, { recursive: true });
  const userConfig = path.join(home, '.npmrc');
  const globalConfig = path.join(home, 'global.npmrc');
  await fs.writeFile(userConfig, '');
  await fs.writeFile(globalConfig, '');
  const flag = (name: string, value: string) => `${name}=${JSON.stringify(value.replaceAll('\\', '/'))}`;
  const runtimeDirectory = path.dirname(await fs.realpath(process.execPath));
  const nodeOptions = ['--experimental-permission', '--allow-child-process',
    flag('--allow-fs-read', workspace), flag('--allow-fs-read', runtimeDirectory),
    flag('--allow-fs-write', workspace)].join(' ');
  if (process.platform === 'win32' && /[%&|<>^\r\n]/u.test(nodeOptions)) throw new Error('Unsupported evaluation path for cmd environment setup');
  const setup = process.platform === 'win32' ? `set "NODE_OPTIONS=${nodeOptions}"`
    : `export NODE_OPTIONS='${nodeOptions.replaceAll("'", "'\"'\"'")}'`;
  const shellExecution: KodaXShellExecutionContract = {
    version: 1,
    shell: { kind: process.platform === 'win32' ? 'cmd' : 'bash', profile: 'none' },
    environment: { inherit: 'none', setup, set: {
      PATH: `${runtimeDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: home, USERPROFILE: home, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
      APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
      NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_CACHE: path.join(home, 'npm-cache'), NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    } },
  };
  return {
    shellExecution,
    /** Independent oracle gets its own acceptance directory, never the raw evidence directory. */
    environment(extraRead?: string): NodeJS.ProcessEnv {
      const environment = buildShellProbeEnvironment(process.env, shellExecution);
      environment.NODE_OPTIONS = extraRead ? `${nodeOptions} ${flag('--allow-fs-read', extraRead)}` : nodeOptions;
      return environment;
    },
  };
}
