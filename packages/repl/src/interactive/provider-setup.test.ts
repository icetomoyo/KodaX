import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProviderSetupCatalogEntry } from '../common/provider-setup.js';
import { createCustomProvider, createFileProviderCredentialStore } from '@kodax-ai/llm';
import {
  runProviderSetupWizard,
  type ProviderSetupInteraction,
} from './provider-setup.js';

let tempDirectory: string;
let configPath: string;

const catalog: readonly ProviderSetupCatalogEntry[] = [{
  name: 'alpha',
  apiKeyEnv: 'ALPHA_API_KEY',
  defaultModel: 'alpha-default',
  models: ['alpha-default', 'alpha-fast'],
}];

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tmpdir(), 'kodax-provider-wizard-'));
  configPath = join(tempDirectory, 'config.json');
});

afterEach(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});

function scriptedInteraction(input: {
  readonly choices?: readonly string[];
  readonly texts?: readonly string[];
  readonly confirm?: boolean;
}): { readonly interaction: ProviderSetupInteraction; readonly prompts: string[] } {
  const choices = [...(input.choices ?? [])];
  const texts = [...(input.texts ?? [])];
  const prompts: string[] = [];
  return {
    prompts,
    interaction: {
      choose: async (message) => {
        prompts.push(message);
        return choices.shift();
      },
      text: async (message) => {
        prompts.push(message);
        return texts.shift();
      },
      confirm: async (message) => {
        prompts.push(message);
        return input.confirm ?? false;
      },
    },
  };
}

async function sendTerminalAnswers(
  input: PassThrough,
  answers: readonly string[],
): Promise<void> {
  for (const answer of answers) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write(`${answer}\n`);
  }
  input.end();
}

describe('runProviderSetupWizard', () => {
  it.each([
    { service: 'vertex', texts: ['native', 'project', 'global', 'NATIVE_KEY', 'fixture'] },
    { service: 'bedrock', texts: ['native', 'us-east-1', 'NATIVE_KEY', 'fixture'] },
    { service: 'azure', texts: ['native', 'https://native.openai.azure.com', 'NATIVE_KEY', 'fixture'] },
  ])('preserves native $service routing through setup', async ({ service, texts }) => {
    const scripted = scriptedInteraction({ choices: ['custom', service], texts, confirm: true });
    expect((await runProviderSetupWizard({ configPath, catalog, interaction: scripted.interaction })).status).toBe('configured');
    expect(JSON.parse(readFileSync(configPath, 'utf8')).customProviders[0].cloud.service).toBe(service);
  });
  it.each(['openai-chatgpt', 'github-copilot'])('keeps %s on its OAuth route without asking for an API key', async service => {
    const scripted = scriptedInteraction({ choices: ['custom', 'oauth', service, 'responses'], texts: ['subscription', 'fixture'], confirm: true });
    expect((await runProviderSetupWizard({ configPath, catalog, interaction: { ...scripted.interaction, secret: async () => { throw new Error('must not ask for key'); } } })).status).toBe('configured');
    expect(JSON.parse(readFileSync(configPath, 'utf8')).customProviders[0].oauth).toBe(service);
  });
  it('hides and saves a custom Key outside config, without requiring environment setup', async () => {
    const scripted = scriptedInteraction({ choices: ['custom', 'responses', 'save-key'], texts: ['saved', 'https://saved.example/v1', 'UNSET_SAVED_KEY', 'fixture'], confirm: true });
    const interaction = { ...scripted.interaction, secret: async () => 'wizard-saved-fixture' };
    const result = await runProviderSetupWizard({ configPath, catalog, interaction });
    expect(result).toMatchObject({ status: 'configured', credentialSource: 'file', selection: { provider: 'saved' } });
    const config = JSON.parse(readFileSync(configPath, 'utf8')), provider = createCustomProvider(config.customProviders[0]);
    const store = createFileProviderCredentialStore(join(tempDirectory, 'auth.json'));
    expect((await store.readApiKey({ profile: 'default', provider: 'saved', connectionFingerprint: provider.getCredentialConnectionFingerprint() }))?.key).toBe('wizard-saved-fixture');
    expect(JSON.stringify(config)).not.toContain('wizard-saved-fixture'); expect(scripted.prompts.join('')).not.toContain('wizard-saved-fixture');
  });
  it('keeps the previous key and effective config when setup loses its config CAS', async () => {
    const metadata = { name: 'saved', protocol: 'openai' as const, api: 'responses' as const, baseUrl: 'https://saved.example/v1', apiKeyEnv: 'KEY', model: 'fixture' };
    const { writeFileSync } = await import('node:fs');
    const original = { provider: 'saved', customProviders: [metadata] }; writeFileSync(configPath, JSON.stringify(original));
    const store = createFileProviderCredentialStore(join(tempDirectory, 'auth.json')), binding = { profile: 'default', provider: 'saved', connectionFingerprint: createCustomProvider(metadata).getCredentialConnectionFingerprint() };
    await store.setApiKey(binding, 'previous-key');
    const scripted = scriptedInteraction({ choices: ['custom', 'responses', 'save-key'], texts: ['saved', metadata.baseUrl, 'KEY', 'fixture'], confirm: true });
    const changed = { ...original, model: 'concurrent' };
    const interaction = { ...scripted.interaction, secret: async () => 'must-roll-back', confirm: async () => { writeFileSync(configPath, JSON.stringify(changed)); return true; } };
    await expect(runProviderSetupWizard({ configPath, catalog, interaction })).rejects.toThrow(/configuration changed/);
    expect((await store.readApiKey(binding))?.key).toBe('previous-key'); expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(changed);
  });
  it('honors an explicit environment choice by removing the previous saved key for that exact connection', async () => {
    const metadata = { name: 'saved', protocol: 'openai' as const, api: 'responses' as const, baseUrl: 'https://saved.example/v1', apiKeyEnv: 'KEY', model: 'fixture' };
    const store = createFileProviderCredentialStore(join(tempDirectory, 'auth.json')), binding = { profile: 'default', provider: 'saved', connectionFingerprint: createCustomProvider(metadata).getCredentialConnectionFingerprint() };
    await store.setApiKey(binding, 'old-saved');
    const scripted = scriptedInteraction({ choices: ['custom', 'responses', 'environment'], texts: ['saved', metadata.baseUrl, 'KEY', 'fixture'], confirm: true });
    expect((await runProviderSetupWizard({ configPath, catalog, interaction: { ...scripted.interaction, secret: async () => { throw new Error('must not ask for key'); } } })).status).toBe('configured');
    expect(await store.readApiKey(binding)).toBeUndefined();
  });
  it('does not change config when hidden Key input is cancelled or credential storage fails', async () => {
    const { mkdirSync } = await import('node:fs');
    for (const cancel of [true, false]) {
      const scripted = scriptedInteraction({ choices: ['custom', 'responses', 'save-key'], texts: ['saved', 'https://saved.example/v1', 'KEY', 'fixture'], confirm: true });
      if (!cancel) mkdirSync(join(tempDirectory, 'auth.json'));
      const operation = runProviderSetupWizard({ configPath, catalog, interaction: { ...scripted.interaction, secret: async () => cancel ? undefined : 'must-not-commit' } });
      if (cancel) expect(await operation).toEqual({ status: 'cancelled' }); else await expect(operation).rejects.toThrow(/storage/);
      expect(() => readFileSync(configPath, 'utf8')).toThrow();
    }
  });
  it('persists a built-in provider/model without ever collecting a secret', async () => {
    const scripted = scriptedInteraction({
      choices: ['builtin:alpha', 'alpha-fast'],
      confirm: true,
    });

    const result = await runProviderSetupWizard({
      configPath,
      catalog,
      interaction: scripted.interaction,
    });

    expect(result).toMatchObject({
      status: 'configured',
      selection: { provider: 'alpha', model: 'alpha-fast', apiKeyEnv: 'ALPHA_API_KEY' },
    });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      provider: 'alpha',
      model: 'alpha-fast',
    });
    expect(scripted.prompts.join('\n')).not.toMatch(/enter|paste|input.*api key/i);
  });

  it('cancels without creating config', async () => {
    const scripted = scriptedInteraction({ choices: ['cancel'] });

    await expect(runProviderSetupWizard({
      configPath,
      catalog,
      interaction: scripted.interaction,
    })).resolves.toEqual({ status: 'cancelled' });
    expect(() => readFileSync(configPath, 'utf8')).toThrow();
  });

  it('treats terminal EOF as cancellation instead of hanging or writing config', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    input.end();

    await expect(runProviderSetupWizard({
      configPath,
      catalog,
      input,
      output,
    })).resolves.toEqual({ status: 'cancelled' });
    expect(() => readFileSync(configPath, 'utf8')).toThrow();
  });

  it('treats EOF after a valid answer as cancellation instead of using a closed readline', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const [result] = await Promise.all([
      runProviderSetupWizard({ configPath, catalog, input, output }),
      sendTerminalAnswers(input, ['1']),
    ]);

    expect(result).toEqual({ status: 'cancelled' });
    expect(() => readFileSync(configPath, 'utf8')).toThrow();
  });

  it('drives the terminal built-in route and retries an invalid numeric choice', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const outputChunks: string[] = [];
    output.on('data', (chunk: Buffer) => outputChunks.push(chunk.toString('utf8')));

    const [result] = await Promise.all([
      runProviderSetupWizard({ configPath, catalog, input, output }),
      sendTerminalAnswers(input, ['0', '1', '2', '2', 'y']),
    ]);

    expect(result).toMatchObject({
      status: 'configured',
      selection: { provider: 'alpha', model: 'alpha-fast' },
    });
    expect(outputChunks.join('')).toMatch(/choose one of the numbered options/i);
  });

  it('drives terminal custom prompts and honors a negative confirmation', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const [result] = await Promise.all([
      runProviderSetupWizard({
        configPath,
        catalog,
        input,
        output,
        customOnly: true,
      }),
      sendTerminalAnswers(input, [
        'local',
        '0',
        '2',
        'https://example.test',
        'LOCAL_API_KEY',
        'local-model',
        'n',
      ]),
    ]);

    expect(result).toEqual({ status: 'cancelled' });
    expect(() => readFileSync(configPath, 'utf8')).toThrow();
  });

  it('offers native Gemini setup and persists cloud metadata with an environment name only', async () => {
    const scripted = scriptedInteraction({ choices: ['custom', 'gemini'], texts: ['native-gemini', 'GEMINI_API_KEY', 'gemini-fixture'], confirm: true });
    const result = await runProviderSetupWizard({ configPath, catalog, interaction: scripted.interaction });
    expect(result.status).toBe('configured');
    expect(JSON.parse(readFileSync(configPath, 'utf8')).customProviders[0]).toMatchObject({ name: 'native-gemini', protocol: 'google', cloud: { service: 'gemini' }, apiKeyEnv: 'GEMINI_API_KEY', model: 'gemini-fixture' });
  });

  it('persists only public custom-provider metadata', async () => {
    const scripted = scriptedInteraction({
      choices: ['custom', 'openai'],
      texts: ['local', 'https://example.test/v1', 'LOCAL_API_KEY', 'local-model'],
      confirm: true,
    });

    const result = await runProviderSetupWizard({
      configPath,
      catalog,
      interaction: scripted.interaction,
    });

    expect(result.status).toBe('configured');
    const persisted = readFileSync(configPath, 'utf8');
    expect(persisted).toContain('LOCAL_API_KEY');
    expect(persisted).not.toMatch(/apiKeyValue|secret|token/i);
  });

  it('supports a custom-only route with explanatory prompts', async () => {
    const scripted = scriptedInteraction({
      choices: ['anthropic'],
      texts: ['private-relay', 'https://relay.example.test', 'RELAY_API_KEY', 'relay-model'],
      confirm: true,
    });

    const result = await runProviderSetupWizard({
      configPath,
      catalog,
      interaction: scripted.interaction,
      customOnly: true,
    });

    expect(result.status).toBe('configured');
    expect(scripted.prompts[0]).toMatch(/local alias|provider name/i);
    expect(scripted.prompts.join('\n')).toMatch(/provider documentation|api documentation/i);
    expect(scripted.prompts.join('\n')).toMatch(/environment.variable name/i);
    expect(scripted.prompts.join('\n')).toMatch(/config\.json.*name only/i);
    expect(scripted.prompts.join('\n')).toMatch(/do not paste.*API key/i);
    expect(scripted.prompts.join('\n')).toMatch(
      /set.*environment variable.*value.*provider.*API key/i,
    );
  });

  it('rejects credential-bearing endpoint metadata before confirmation can echo it', async () => {
    const privateUrl = 'https://user:private-value@example.test/v1';
    const scripted = scriptedInteraction({
      choices: ['custom', 'openai'],
      texts: ['unsafe', privateUrl, 'UNSAFE_API_KEY', 'unsafe-model'],
      confirm: true,
    });

    await expect(runProviderSetupWizard({
      configPath,
      catalog,
      interaction: scripted.interaction,
    })).rejects.toThrow(/must not contain credentials/i);
    expect(scripted.prompts.join('\n')).not.toContain(privateUrl);
    expect(() => readFileSync(configPath, 'utf8')).toThrow();
  });
});
