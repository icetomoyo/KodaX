import { describe, expect, it } from 'vitest';

import type { ProviderSetupCatalogEntry } from './provider-setup.js';
import { renderSetupGuide } from './setup-guide.js';

const catalog: readonly ProviderSetupCatalogEntry[] = [{
  name: 'alpha',
  apiKeyEnv: 'ALPHA_API_KEY',
  defaultModel: 'alpha-default',
  models: ['alpha-default'],
}];

describe('renderSetupGuide', () => {
  it('covers providers, config paths, terminal restart, CLI, REPL, and shortcuts', () => {
    const guide = renderSetupGuide({
      configHome: 'C:/Users/test/.kodax',
      catalog,
      cliBridges: ['codex-cli'],
    });

    expect(guide).toContain('alpha');
    expect(guide).toContain('ALPHA_API_KEY');
    expect(guide).toContain('codex-cli');
    expect(guide).toContain('restart');
    expect(guide).toContain('config.example.jsonc');
    expect(guide).toContain('integrations');
    expect(guide).toContain('mcp.json');
    expect(guide).toContain('extensions.json');
    expect(guide).toContain('a2a.json');
    expect(guide).toContain('kodax -r');
    expect(guide).toContain('kodax -c');
    expect(guide).toContain('/model');
    expect(guide).toContain('/mode');
    expect(guide).toContain('full-access');
    expect(guide).toContain('/effort');
    expect(guide).toContain('/agent-mode');
    expect(guide).toContain('AMA');
    expect(guide).toContain('SA');
    expect(guide).toContain('Ctrl+T');
    expect(guide).toContain('Shift+Tab');
    expect(guide).toContain('Alt+M');
    expect(guide).toContain('kodax setup --custom');
    expect(guide).toMatch(/custom provider.*apiKeyEnv.*name.*config\.json/is);
    expect(guide).toMatch(/actual API key.*value.*environment variable/is);
    expect(guide).toMatch(/KodaX does not set.*environment variable/is);
    expect(guide).toContain('kodax sandbox doctor');
    expect(guide).toContain('UAC');
    expect(guide).toContain('brew install ripgrep');
    expect(guide).toContain('bubblewrap, socat, and ripgrep');
    expect(guide).toContain('@kodax-ai/kodax/sandbox');
    expect(guide).toContain('inherit the host environment');
    expect(guide).toContain('execution-control variables remain blocked');
  });
});
