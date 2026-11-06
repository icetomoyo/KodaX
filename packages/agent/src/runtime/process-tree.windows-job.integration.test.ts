import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWindowsJobActiveProcessCount } from './process-tree.js';
import { containWindowsEffectProcess, terminateWindowsEffectJob } from './windows-effect-job.js';

const HOLDER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RetainedJobHandle {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
}
'@
$handle = [RetainedJobHandle]::OpenJobObjectW(4, $false, $env:KODAX_TEST_RETAINED_JOB)
if ($handle -eq [IntPtr]::Zero) { throw 'Fixture could not retain the Job handle.' }
while ($true) {
  [IO.File]::AppendAllText($env:KODAX_TEST_RETAINED_JOB_HEARTBEAT, '.')
  Start-Sleep -Milliseconds 25
}
`;

const GATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$jobName = [Console]::ReadLine()
$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = 'powershell.exe'
$info.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + $env:KODAX_TEST_JOB_HOLDER_SCRIPT
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.EnvironmentVariables['KODAX_TEST_RETAINED_JOB'] = $jobName
$child = [Diagnostics.Process]::Start($info)
[Console]::Out.WriteLine('{"holderPid":' + $child.Id + '}')
[Console]::Out.Flush()
while ($true) { Start-Sleep -Milliseconds 50 }
`;

describe.runIf(process.platform === 'win32')('Windows Job recovery evidence', () => {
  it('keeps a surviving writer visible after its Host and supervisor exit while it retains a Job handle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-job-recovery-proof-'));
    const heartbeat = path.join(root, 'writer');
    const gate = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(GATE_SCRIPT, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
        KODAX_TEST_JOB_HOLDER_SCRIPT: Buffer.from(HOLDER_SCRIPT, 'utf16le').toString('base64'),
        KODAX_TEST_RETAINED_JOB_HEARTBEAT: heartbeat },
    });
    const gateExited = once(gate, 'exit');
    let gateDiagnostic = '';
    gate.stderr!.on('data', (chunk: Buffer) => { gateDiagnostic += chunk.toString(); });
    let jobName: string | undefined;
    try {
      if (gate.pid === undefined) throw new Error('Fixture Host did not expose its PID.');
      const job = await containWindowsEffectProcess(gate.pid);
      jobName = job.jobName;
      const ready = once(gate.stdout!, 'data');
      gate.stdin!.write(`${jobName}\n`);
      const [readiness] = await ready;
      expect(JSON.parse(String(readiness))).toMatchObject({ holderPid: expect.any(Number) });
      try {
        await expect.poll(async () => (await readFile(heartbeat, 'utf8')).length, { timeout: 10_000 }).toBeGreaterThan(0);
      } catch (error) {
        throw new Error(`Fixture writer failed: ${gateDiagnostic}`, { cause: error });
      }
      process.kill(job.supervisorPid);
      await expect(job.drained).rejects.toThrow('supervisor exited');
      gate.kill();
      await gateExited;
      const written = (await readFile(heartbeat, 'utf8')).length;
      await expect.poll(async () => (await readFile(heartbeat, 'utf8')).length, { timeout: 10_000 }).toBeGreaterThan(written);
      expect(await readWindowsJobActiveProcessCount(jobName)).toBeGreaterThan(0);
      await terminateWindowsEffectJob(jobName);
      expect(await readWindowsJobActiveProcessCount(jobName)).toBe(0);
    } finally {
      if (jobName !== undefined) await terminateWindowsEffectJob(jobName);
      gate.kill();
      await gateExited;
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 30_000);
});
