import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import {
  ensureExampleConfigFiles,
  ensureExampleConfigFile,
  getConfigTemplate,
  KODAX_CONFIG_FILE,
  KODAX_CONFIG_ENV_BINDINGS,
  KODAX_DIR,
  KODAX_EXAMPLE_CONFIG_FILE,
  KODAX_INTEGRATION_EXAMPLE_FILES,
} from './utils.js';

describe('ensureExampleConfigFile (F1 first-launch template)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a commented config.example.jsonc when no config.json exists', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    const result = ensureExampleConfigFile();

    expect(result).toBe(KODAX_EXAMPLE_CONFIG_FILE);
    // Dir is created recursively BEFORE the write (first-launch on a fresh machine).
    expect(mkdir).toHaveBeenCalledWith(KODAX_DIR, { recursive: true });
    expect(write).toHaveBeenCalledTimes(4);
    const [writtenPath, content] = write.mock.calls[0]!;
    expect(writtenPath).toBe(KODAX_EXAMPLE_CONFIG_FILE);
    // Reference file is JSONC (leading // comment) and documents the custom-provider
    // thinking/reasoning config that motivated F1.
    expect(String(content)).toMatch(/^\/\//);
    expect(String(content)).toContain('customProviders');
    expect(String(content)).toContain('"compaction"');
    expect(String(content)).toContain('"triggerPercent": 75');
    expect(String(content)).toContain('"triggerTokens": 0');
    expect(String(content)).not.toContain('"envPass"');
    expect(String(content)).toContain('"full-access"');
    expect(String(content)).not.toContain('mcpServers');
    expect(write.mock.calls.map(([written]) => written)).toEqual([
      KODAX_EXAMPLE_CONFIG_FILE,
      KODAX_INTEGRATION_EXAMPLE_FILES.mcp,
      KODAX_INTEGRATION_EXAMPLE_FILES.a2a,
      KODAX_INTEGRATION_EXAMPLE_FILES.extensions,
    ]);
  });

  it('still installs missing integration examples when config.json already exists', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === KODAX_CONFIG_FILE);
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    expect(ensureExampleConfigFiles()).toHaveLength(4);
    expect(write).toHaveBeenCalledTimes(4);
  });

  it('does not overwrite an existing example file', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === KODAX_EXAMPLE_CONFIG_FILE);
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    expect(ensureExampleConfigFile()).toBe(KODAX_INTEGRATION_EXAMPLE_FILES.mcp);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('never throws — a write failure returns undefined', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => ensureExampleConfigFile()).not.toThrow();
    expect(ensureExampleConfigFile()).toBeUndefined();
  });

  it('returns the exact embedded canonical templates', () => {
    const core = getConfigTemplate('core');
    expect(core.split(/\r?\n/u)[0]).toMatch(/mcp\.json.*extensions\.json.*a2a\.json/i);
    expect(core).toContain('KodaX core configuration template');
    expect(core).toContain('kodax integrations migrate`');
    expect(core).not.toContain('migrate --dry-run');
    expect(core).toContain('"deepseek-v4-flash"');
    expect(core).toContain('"deepseek-v4-pro"');
    expect(core).not.toContain('"deepseek-reasoner"');
    expect(getConfigTemplate('mcp')).toContain('"version": 1');
    const a2a = getConfigTemplate('a2a');
    expect(a2a).toContain('"agents": {');
    expect(a2a.match(/^\s*"agents": \{/gmu)).toHaveLength(1);
    expect(a2a).toContain('isolated Skill Script is POSIX-only');
    expect(a2a).toContain('Windows is');
    expect(a2a).toContain('required per-command denyRead is unsupported');
    expect(getConfigTemplate('extensions')).toContain('"paths": []');
  });

  it('documents every config-to-environment binding plus non-bridged core settings', () => {
    const core = getConfigTemplate('core');
    for (const binding of KODAX_CONFIG_ENV_BINDINGS) {
      const field = binding.configPath.split('.').at(-1);
      expect(field, binding.configPath).toBeDefined();
      expect(core, binding.configPath).toContain(`"${field}"`);
    }
    for (const field of [
      'model',
      'planModeEffort',
      'reasoningCeiling',
      'agentMode',
      'permissionMode',
      'alwaysAllowTools',
      'autoMode',
      'locale',
      'providerModels',
      'customProviders',
      'compaction',
      'autoReview',
    ]) {
      expect(core, field).toContain(`"${field}"`);
    }
  });
});
