import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProviderSetupCatalogEntry } from '../common/provider-setup.js';
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
      sendTerminalAnswers(input, ['0', '1', '2', 'y']),
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
