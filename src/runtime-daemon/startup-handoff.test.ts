import { closeSync, existsSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureRuntimeDaemonStartupHandoff } from './startup-handoff.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function decisionFile(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kodax-handoff-'));
  directories.push(directory);
  return path.join(directory, 'decision');
}

describe('daemon publication handoff', () => {
  it('never reopens publication after startup was cancelled, even if its marker disappears', () => {
    const file = decisionFile();
    closeSync(openSync(file, 'wx'));
    const commit = captureRuntimeDaemonStartupHandoff({ KODAX_INTERNAL_WINDOWS_JOB_HANDOFF: file });
    expect(commit).toThrow();
    rmSync(file);
    expect(commit).toThrow(/cancelled before service publication/);
    expect(existsSync(file)).toBe(false);
  });

  it('reports a filesystem failure without granting publication or retrying authority', () => {
    const file = decisionFile();
    const commit = captureRuntimeDaemonStartupHandoff({ KODAX_INTERNAL_WINDOWS_JOB_HANDOFF: path.join(file, 'missing') });
    expect(commit).toThrow(/ENOENT/);
    expect(existsSync(file)).toBe(false);
  });

  it('leaves embedded and non-supervised hosts free of a handoff', () => {
    expect(captureRuntimeDaemonStartupHandoff({})).not.toThrow();
  });

  it('captures private startup authority before children inherit the environment and commits once', () => {
    const file = decisionFile();
    const env = { KODAX_INTERNAL_WINDOWS_JOB_HANDOFF: file };
    const commit = captureRuntimeDaemonStartupHandoff(env);
    expect(env.KODAX_INTERNAL_WINDOWS_JOB_HANDOFF).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    commit();
    expect(existsSync(file)).toBe(true);
    rmSync(file); // The persistent wrapper may remove its decision after observing commit.
    commit();
    expect(existsSync(file)).toBe(false);
  });
});
