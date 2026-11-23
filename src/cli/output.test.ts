import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reported, renderText, withJsonOption } from './output.js';

describe('renderText', () => {
  it('prints nested results as indented key: value lines', () => {
    expect(renderText({ name: 'local', removed: true, config: { type: 'stdio', args: ['a', 'b'] }, none: [] })).toBe([
      'name: local',
      'removed: yes',
      'config:',
      '  type: stdio',
      '  args:',
      '    - a',
      '    - b',
      'none: (none)',
    ].join('\n'));
  });

  it('prints a list of objects as dash items and skips absent fields', () => {
    expect(renderText([{ domain: 'mcp', state: 'valid', note: undefined }, { domain: 'a2a', state: 'invalid' }])).toBe([
      '- domain: mcp',
      '  state: valid',
      '- domain: a2a',
      '  state: invalid',
    ].join('\n'));
    expect(renderText({})).toBe('(none)');
    expect(renderText('plain')).toBe('plain');
  });
});

describe('reported', () => {
  afterEach(() => { process.exitCode = undefined; });

  async function run(args: readonly string[], ok?: (value: { readonly ok: boolean }) => boolean): Promise<string> {
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
    try {
      const program = new Command().name('kodax').exitOverride();
      withJsonOption(program.command('check').argument('<flag>')).action(reported(
        (flag: string) => ({ ok: flag === 'good', flag }),
        value => `checked ${value.flag}`,
        ok,
      ));
      await program.parseAsync(['node', 'kodax', 'check', ...args]);
      return output;
    } finally {
      write.mockRestore();
    }
  }

  it('prints text by default and the unchanged JSON value with --json', async () => {
    expect(await run(['good'])).toBe('checked good\n');
    expect(JSON.parse(await run(['good', '--json']))).toEqual({ ok: true, flag: 'good' });
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 when the result says it failed, in both formats', async () => {
    const failed = (value: { readonly ok: boolean }) => value.ok;
    expect(await run(['bad'], failed)).toBe('checked bad\n');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(JSON.parse(await run(['bad', '--json'], failed))).toMatchObject({ ok: false });
    expect(process.exitCode).toBe(1);
  });
});
