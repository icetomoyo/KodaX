import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKodaXProgram } from './program.js';

class ProcessExit extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** Parses argv against the real `kodax` tree and reports how the process would exit. */
async function parse(args: readonly string[]): Promise<{ exitCode: number | string | null | undefined; stderr: string }> {
  let stderr = '';
  vi.spyOn(process, 'exit').mockImplementation((code) => { throw new ProcessExit(code); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true; });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const { program } = createKodaXProgram({ version: '9.9.9' });
  try {
    await program.parseAsync(['node', 'kodax', ...args]);
    return { exitCode: undefined, stderr };
  } catch (error) {
    if (error instanceof ProcessExit) return { exitCode: error.code, stderr };
    throw error;
  }
}

describe('kodax exit codes', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    [['--bogus']],
    [['host', 'status', '--bogus']],
    [['mcp', 'list', '--bogus']],
    [['completion']],
  ])('exits 2 for the usage error in %j', async (args) => {
    expect((await parse(args)).exitCode).toBe(2);
  });

  it.each([[['--version']], [['host', '--help']]])('exits 0 for %j', async (args) => {
    expect((await parse(args)).exitCode).toBe(0);
  });
});

describe('removed root options', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    [['-n'], 'a new session is already the default'],
    [['--new', 'fix the bug'], 'a new session is already the default'],
    [['-y'], 'permissionMode'],
    [['--auto'], '/mode'],
    [['--extension', './ext.mjs'], 'kodax extensions add'],
  ])('rejects %j with a pointer to %s', async (args, pointer) => {
    const result = await parse(args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('was removed');
    expect(result.stderr).toContain(pointer);
  });

  it('keeps them out of help', () => {
    const { program } = createKodaXProgram({ version: '9.9.9' });
    expect(program.helpInformation()).not.toMatch(/--new|--auto|--extension/);
  });
});
