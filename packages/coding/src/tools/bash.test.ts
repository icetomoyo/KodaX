import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolBash } from './bash.js';

describe('toolBash', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-bash-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('keeps the tail for large command output', async () => {
    const command = 'node -e "for (let i = 1; i <= 3000; i++) console.log(`line-${i}`)"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('line-3000');
    expect(result).toContain('Bash output truncated to the tail');
  });

  it('includes stderr in timeout previews', async () => {
    const command = 'node -e "process.stderr.write(\'timeout-error\\n\'); setTimeout(() => {}, 5000)"';
    const result = await toolBash({ command, timeout: 1 }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result).toContain('[Timeout]');
    expect(result).toContain('timeout-error');
  });

  it('runs command in background and returns output file path', async () => {
    const command = 'node -e "console.log(\'bg-output\')"';
    const result = await toolBash({ command, run_in_background: true }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('Command started in background');
    expect(result).toContain('PID:');
    expect(result).toContain('Output:');
    expect(result).toContain('kodax-bg-');

    // Wait briefly for the background process to complete and write output
    await new Promise(resolve => setTimeout(resolve, 500));

    const outputMatch = result.match(/Output:\s*(.+)/);
    expect(outputMatch).toBeTruthy();
    const outputPath = outputMatch![1]!.trim();
    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toContain('bg-output');
    expect(content).toContain('[Exit:');
  });
});
