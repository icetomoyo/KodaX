import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { expect, it, vi } from 'vitest';
import { withCoreConfigWriteLock, writeCoreConfigAtomically } from '@kodax-ai/repl';
import { readRuntimeDaemonState, resolveRuntimeDaemonPaths, writeRuntimeDaemonState } from './state.js';

it.skipIf(process.platform !== 'win32').each(['daemon', 'configuration'] as const)
  ('publishes %s after a real Windows reader releases its non-delete-sharing handle', async kind => {
    const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kodax-reader-held-'));
    const paths = resolveRuntimeDaemonPaths(home, 'reader-held');
    const original = { runtimeId: 'fixture', profile: paths.profile, pid: process.pid,
      startedAt: '2026-11-02T00:00:00.000Z', endpoint: 'fixture', version: 'fixture', status: 'starting' as const };
    writeRuntimeDaemonState(paths, original);
    const file = kind === 'daemon' ? paths.stateFile : path.join(home, 'config.json');
    if (kind === 'configuration') withCoreConfigWriteLock(file, () => writeCoreConfigAtomically(file, '{"model":"before"}'));
    const begin = path.join(home, 'begin');
    const reader = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
      $stream = [System.IO.File]::Open($env:KODAX_FIXTURE_FILE, 'Open', 'Read', 'ReadWrite');
      try {
        [Console]::Out.WriteLine('held');
        $deadline = [DateTime]::UtcNow.AddSeconds(15);
        while (-not [System.IO.File]::Exists($env:KODAX_FIXTURE_BEGIN)) {
          if ([DateTime]::UtcNow -gt $deadline) { throw 'Fixture writer did not begin'; }
          Start-Sleep -Milliseconds 10;
        }
        Start-Sleep -Milliseconds 500;
      } finally { $stream.Dispose(); }
    `], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      KODAX_FIXTURE_FILE: file, KODAX_FIXTURE_BEGIN: begin } });
    let diagnostic = '';
    reader.stderr.on('data', bytes => { diagnostic = (diagnostic + String(bytes)).slice(-2000); });
    const exited = new Promise<number | null>((resolve, reject) => {
      reader.once('error', reject); reader.once('exit', code => resolve(code));
    });
    try {
      await Promise.race([
        new Promise<void>(resolve => reader.stdout.on('data', bytes => { if (String(bytes).includes('held')) resolve(); })),
        exited.then(code => { throw new Error(`Fixture reader exited before holding: ${code}: ${diagnostic}`); }),
      ]);
      const rename = fs.renameSync;
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        fs.writeFileSync(begin, 'begin');
        return rename(from, to);
      });
      syncBuiltinESMExports();
      if (kind === 'daemon') {
        writeRuntimeDaemonState(paths, { ...original, status: 'ready' });
        expect(readRuntimeDaemonState(paths)?.status).toBe('ready');
      } else {
        withCoreConfigWriteLock(file, () => writeCoreConfigAtomically(file, '{"model":"after"}'));
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ model: 'after' });
      }
      expect(await exited).toBe(0);
    } finally {
      vi.restoreAllMocks(); syncBuiltinESMExports();
      if (reader.exitCode === null && reader.signalCode === null) reader.kill();
      await exited;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
