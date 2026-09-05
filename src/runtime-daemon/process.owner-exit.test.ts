import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';
import { waitForRuntimeDaemonOwnerExit } from './process.js';
import { readRuntimeOwnerProcessStartIdentity } from './state.js';

describe('Host launcher waits for the original process', () => {
  it('waits for actual process exit and does not kill a live owner on timeout', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); process.stdin.resume();'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      const pid = child.pid;
      if (pid === undefined) throw new Error('Child did not start');
      const processStartIdentity = readRuntimeOwnerProcessStartIdentity(pid);
      if (processStartIdentity === undefined) throw new Error('Child process identity unavailable');
      const owner = { pid, processStartIdentity };
      await expect(waitForRuntimeDaemonOwnerExit(owner, 30)).rejects.toThrow('still running');
      expect(child.exitCode).toBeNull();
      expect(() => process.kill(pid, 0)).not.toThrow();

      const waiting = waitForRuntimeDaemonOwnerExit(owner, 5_000);
      child.stdin.end();
      await exited;
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });
});
