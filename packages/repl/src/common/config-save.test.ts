import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); vi.resetModules(); });

it.each(['{"apiKeys":{"anthropic":"fixture-retain"},', 'fixture-retain', '[]', 'null'])('does not replace, expose or default unreadable configuration credentials: case %#', async raw => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-config-corrupt-'));
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, raw); vi.stubEnv('KODAX_HOME', home); vi.resetModules();
  try {
    const { saveConfig, loadConfig } = await import('./utils.js');
    expect(() => loadConfig()).toThrow(/core configuration/i);
    expect(() => saveConfig({ effort: 'high' })).toThrow(/configuration|JSON/i);
    try { saveConfig({ effort: 'high' }); }
    catch (error) { expect(String(error)).not.toContain('fixture-retain'); }
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    fs.writeFileSync(file, JSON.stringify({ provider: 'deepseek', apiKeys: { deepseek: 'fixture-retained-account' } }));
    expect(loadConfig().provider).toBe('deepseek');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it('rejects a denied core read instead of silently using a default provider, then preserves the selected account after repair', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-config-denied-'));
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ provider: 'deepseek' }));
  vi.stubEnv('KODAX_HOME', home); vi.resetModules();
  const { loadConfig } = await import('./utils.js');
  const read = fs.readFileSync;
  const fault = vi.spyOn(fs, 'readFileSync').mockImplementation((target, ...args) => {
    if (target === file) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    return read(target, ...args);
  });
  try {
    expect(() => loadConfig()).toThrow(/core configuration/i);
    fault.mockRestore();
    expect(loadConfig().provider).toBe('deepseek');
    const stat = fs.lstatSync;
    const deniedEntry = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      if (target === file) throw Object.assign(new Error('fixture entry denied'), { code: 'EACCES' });
      return stat(target, ...args);
    });
    try { expect(() => loadConfig()).toThrow(/core configuration/i); }
    finally { deniedEntry.mockRestore(); }
    expect(loadConfig().provider).toBe('deepseek');
  } finally { fault.mockRestore(); fs.rmSync(home, { recursive: true, force: true }); }
});

it('preserves the entire old configuration when atomic publication fails, then retries without losing legacy credentials', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-config-atomic-'));
  const file = path.join(home, 'config.json');
  const original = JSON.stringify({ provider: 'anthropic', apiKeys: { anthropic: 'fixture-old-key' }, unknown: { retain: true } });
  fs.writeFileSync(file, original);
  vi.stubEnv('KODAX_HOME', home); vi.resetModules();
  const { saveConfig } = await import('./utils.js');
  const rename = fs.renameSync;
  const fault = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === file) throw Object.assign(new Error('fixture publication busy'), { code: 'EBUSY' });
    rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    expect(() => saveConfig({ effort: 'high' })).toThrow('fixture publication busy');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    fault.mockRestore(); syncBuiltinESMExports();
    saveConfig({ effort: 'high' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ provider: 'anthropic', apiKeys: { anthropic: 'fixture-old-key' }, unknown: { retain: true }, effort: 'high' });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
