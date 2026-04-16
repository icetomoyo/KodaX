import { describe, expect, it } from 'vitest';
import { exec, webhook } from './helpers.js';

describe('exec', () => {
  it('runs a simple command and returns stdout', async () => {
    const result = await exec('echo hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
  });

  it('returns non-zero exit code on failure', async () => {
    const result = await exec('exit 42');
    expect(result.exitCode).not.toBe(0);
  });

  it('does not leak API keys from process.env', async () => {
    // Set a fake secret in process.env
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-secret-test';
    try {
      const result = await exec(
        process.platform === 'win32'
          ? 'echo %OPENAI_API_KEY%'
          : 'echo $OPENAI_API_KEY',
      );
      // The variable should NOT be available — stdout should be empty or the literal variable name
      expect(result.stdout).not.toContain('sk-secret-test');
    } finally {
      if (original !== undefined) {
        process.env.OPENAI_API_KEY = original;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
  });

  it('injects custom env variables', async () => {
    const result = await exec(
      process.platform === 'win32'
        ? 'Write-Output $env:MY_VAR'
        : 'echo $MY_VAR',
      { env: { MY_VAR: 'test-value' } },
    );
    expect(result.stdout).toContain('test-value');
  });

  it('respects timeout', async () => {
    const result = await exec(
      process.platform === 'win32'
        ? 'ping -n 10 127.0.0.1'
        : 'sleep 10',
      { timeout: 500 },
    );
    expect(result.exitCode).not.toBe(0);
  });
});

describe('webhook', () => {
  it('returns ok:false for unreachable URLs', async () => {
    const result = await webhook('http://127.0.0.1:1', { test: true }, { timeout: 1000 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });

  it('returns error body on timeout', async () => {
    const result = await webhook('http://10.255.255.1:1', { test: true }, { timeout: 500 });
    expect(result.ok).toBe(false);
  });
});
