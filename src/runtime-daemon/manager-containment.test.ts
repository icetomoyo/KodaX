import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitKodaXDiagnostic, setKodaXDiagnosticSink } from '@kodax-ai/agent';
import * as daemonState from './state.js';

const { jobProbe } = vi.hoisted(() => ({ jobProbe: vi.fn(() => true) }));

vi.mock('@kodax-ai/agent', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kodax-ai/agent')>(),
  isCurrentProcessWindowsJobContained: jobProbe,
}));

import { acquireRuntimeDaemonLease } from './manager.js';

const temporaryDirectories: string[] = [];
const originalSupervisorPid = process.env.KODAX_DAEMON_JOB_SUPERVISOR_PID;

afterEach(() => {
  jobProbe.mockReset().mockReturnValue(true);
  vi.restoreAllMocks();
  if (originalSupervisorPid === undefined) {
    delete process.env.KODAX_DAEMON_JOB_SUPERVISOR_PID;
  } else {
    process.env.KODAX_DAEMON_JOB_SUPERVISOR_PID = originalSupervisorPid;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('runtime daemon containment ownership', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])(
    'captures pre-host probes and restores the sink (log failure=%s, probe throws=%s)', async (logFailure, probeThrows) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-probe-log-'));
    temporaryDirectories.push(homeDir);
    const paths = daemonState.resolveRuntimeDaemonPathsFromConfigHome(path.join(homeDir, '.kodax'), 'default');
    const diagnostic = { source: 'runtime:windows', level: 'warn' as const,
      message: 'Windows process probe completed.',
      detail: { stage: 'job-membership', cached: false, available: false, errorCode: 'ETIMEDOUT', timeoutMs: 5000 } };
    jobProbe.mockImplementation(() => {
      emitKodaXDiagnostic(diagnostic);
      if (probeThrows) throw new Error('probe failure');
      return false;
    });
    vi.spyOn(daemonState, 'readRuntimeOwnerProcessStartIdentity').mockReturnValue('fixture-identity');
    const previous = vi.fn(() => { throw new Error('previous sink failure'); });
    const restore = setKodaXDiagnosticSink(previous);
    if (logFailure) vi.spyOn(daemonState, 'appendRuntimeDaemonLog').mockImplementation(() => { throw new Error('disk failure'); });
    const createRuntime = vi.fn(async () => { throw new Error('runtime fixture stop'); });
    try {
      await expect(acquireRuntimeDaemonLease({ homeDir, createRuntime })).rejects.toThrow(
        probeThrows ? 'probe failure' : 'runtime fixture stop',
      );
      expect(jobProbe).toHaveBeenCalledTimes(1);
      expect(createRuntime).toHaveBeenCalledTimes(probeThrows ? 0 : 1);
      if (!logFailure) {
        const entries = fs.readFileSync(paths.logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { data: unknown });
        expect(entries).toContainEqual(expect.objectContaining({ data: {
          source: diagnostic.source, level: diagnostic.level, detail: diagnostic.detail,
        } }));
      }
      emitKodaXDiagnostic({ source: 'test', level: 'info', message: 'restored' });
      expect(previous).toHaveBeenCalledExactlyOnceWith({ source: 'test', level: 'info', message: 'restored' });
    } finally { restore(); }
  });
  it('refuses to publish a new Windows Job owner without the supervisor generation', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-contained-manager-'));
    temporaryDirectories.push(homeDir);
    process.env.KODAX_DAEMON_JOB_SUPERVISOR_PID = '2147483000';
    const createRuntime = vi.fn(async () => {
      throw new Error('Runtime creation must not start without an exact supervisor identity.');
    });

    await expect(acquireRuntimeDaemonLease({
      homeDir,
      createRuntime,
    })).rejects.toThrow('Could not read the Windows Job supervisor process identity');
    expect(createRuntime).not.toHaveBeenCalled();
  });
});
