import { describe, expect, it } from 'vitest';

import {
  hasProviderCredentialEnvironment,
  renderMissingProviderCredentialGuide,
  shouldAutoLaunchProviderSetup,
} from './provider-setup-cli.js';

describe('shouldAutoLaunchProviderSetup', () => {
  it('allows only a bare, interactive text launch', () => {
    expect(shouldAutoLaunchProviderSetup({
      outputMode: 'text',
      prompt: [],
      isInputTty: true,
      isOutputTty: true,
    })).toBe(true);
  });

  it.each([
    { outputMode: 'json' as const, prompt: [], isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: ['inspect'], isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], print: true, isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], continue: true, isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], resumeRequested: true, isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], sessionRequested: true, isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], helpRequested: true, isInputTty: true, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], isInputTty: false, isOutputTty: true },
    { outputMode: 'text' as const, prompt: [], isInputTty: true, isOutputTty: false },
  ])('does not interrupt explicit or non-interactive invocation %#', (input) => {
    expect(shouldAutoLaunchProviderSetup(input)).toBe(false);
  });
});

describe('first-run provider credential guidance', () => {
  it('detects only non-empty supported provider environment variables', () => {
    expect(hasProviderCredentialEnvironment(
      ['ALPHA_API_KEY', 'BETA_API_KEY'],
      { ALPHA_API_KEY: '  ', BETA_API_KEY: 'available' },
    )).toBe(true);
    expect(hasProviderCredentialEnvironment(
      ['ALPHA_API_KEY'],
      { UNRELATED_API_KEY: 'available' },
    )).toBe(false);
  });

  it('lists supported variables, every OS method, and the terminal restart boundary', () => {
    const guide = renderMissingProviderCredentialGuide([
      'ALPHA_API_KEY',
      'BETA_API_KEY',
      'ALPHA_API_KEY',
    ]);

    expect(guide).toContain('did not detect');
    expect(guide.match(/  - ALPHA_API_KEY/g)).toHaveLength(1);
    expect(guide).toContain('BETA_API_KEY');
    expect(guide).toMatch(/choose one.*listed variable/i);
    expect(guide).toContain(
      '[Environment]::SetEnvironmentVariable("ALPHA_API_KEY", "<your-key>", "User")',
    );
    expect(guide).not.toContain('<PROVIDER_API_KEY>');
    expect(guide).toContain('Windows PowerShell');
    expect(guide).toContain('macOS');
    expect(guide).toContain('Linux');
    expect(guide).toMatch(/close.*terminal.*new terminal/is);
    expect(guide).toContain('kodax setup');
    expect(guide).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});
