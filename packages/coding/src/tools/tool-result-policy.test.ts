import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyToolResultGuardrail, getToolResultPolicy } from './tool-result-policy.js';
import { TOOL_OUTPUT_DIR_ENV } from './truncate.js';

describe('tool result guardrail', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-tool-guardrail-'));
    process.env[TOOL_OUTPUT_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    delete process.env[TOOL_OUTPUT_DIR_ENV];
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('spills oversized generic output to a file', async () => {
    const content = Array.from({ length: 3000 }, (_, index) => `line-${index + 1}`).join('\n');
    const result = await applyToolResultGuardrail('write', content, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result.truncated).toBe(true);
    expect(result.content).toContain('Full output saved to:');
    const files = await fs.readdir(tempDir);
    expect(files.length).toBe(1);
  });

  it('uses tail policy for bash output', async () => {
    const content = Array.from({ length: 1200 }, (_, index) => `line-${index + 1}`).join('\n');
    const result = await applyToolResultGuardrail('bash', content, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result.truncated).toBe(true);
    expect(result.content).toContain('line-1200');
    expect(result.content).not.toContain('line-1\nline-2');
  });

  it('returns small output unchanged', async () => {
    const result = await applyToolResultGuardrail('read', 'small output', {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result.truncated).toBe(false);
    expect(result.content).toBe('small output');
  });

  it('exposes tool-specific policy', () => {
    expect(getToolResultPolicy('bash').direction).toBe('tail');
    expect(getToolResultPolicy('read').direction).toBe('head');
    expect(getToolResultPolicy('web_fetch').maxBytes).toBe(24 * 1024);
    expect(getToolResultPolicy('semantic_lookup').spillToFile).toBe(true);
  });
});
