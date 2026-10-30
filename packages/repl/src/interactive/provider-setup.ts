import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import chalk from 'chalk';
import { createCloudProviderConfig, createOAuthProviderConfig } from '@kodax-ai/llm';

import {
  ProviderSetupInvalidConfigError,
  getProviderSetupCatalog,
  inspectProviderSetupReadiness,
  persistProviderSetupChoice,
  validateProviderSetupCustomMetadata,
  type PersistedProviderSetupChoice,
  type ProviderSetupCatalogEntry,
  type ProviderSetupChoice,
} from '../common/provider-setup.js';

export interface ProviderSetupInteraction {
  readonly choose: (
    message: string,
    items: readonly { readonly value: string; readonly label: string }[],
  ) => Promise<string | undefined>;
  readonly text: (message: string, defaultValue?: string) => Promise<string | undefined>;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly close?: () => void;
}

export type ProviderSetupWizardResult =
  | { readonly status: 'configured'; readonly selection: PersistedProviderSetupChoice }
  | { readonly status: 'cancelled' };

export interface RunProviderSetupWizardInput {
  readonly configPath?: string;
  readonly catalog?: readonly ProviderSetupCatalogEntry[];
  readonly interaction?: ProviderSetupInteraction;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly customOnly?: boolean;
}

/**
 * Run the standalone first-use setup flow. It intentionally has no API-key
 * field: only public provider metadata crosses this boundary.
 */
export async function runProviderSetupWizard(
  input: RunProviderSetupWizardInput = {},
): Promise<ProviderSetupWizardResult> {
  const catalog = input.catalog ?? getProviderSetupCatalog();
  const readiness = inspectProviderSetupReadiness({
    ...(input.configPath ? { configPath: input.configPath } : {}),
    catalog,
  });
  if (readiness.status === 'invalid-config') {
    throw new ProviderSetupInvalidConfigError(readiness.configPath, readiness.reason);
  }
  if (catalog.length === 0) {
    throw new Error('No built-in API providers are available for setup.');
  }

  const ownsInteraction = input.interaction === undefined;
  const interaction = input.interaction ?? createTerminalProviderSetupInteraction({
    input: input.input ?? process.stdin,
    output: input.output ?? process.stdout,
  });
  try {
    const route = input.customOnly ? 'custom' : await interaction.choose(
      'Choose a provider. KodaX will save metadata only and will never ask for an API key.',
      [
        ...catalog.map((entry) => ({
          value: `builtin:${entry.name}`,
          label: `${entry.name} — ${entry.defaultModel} (set ${entry.apiKeyEnv})`,
        })),
        { value: 'custom', label: 'Custom compatible or native provider' },
        { value: 'cancel', label: 'Cancel' },
      ],
    );
    if (!route || route === 'cancel') return { status: 'cancelled' };

    const choice = route === 'custom'
      ? await collectCustomChoice(interaction)
      : await collectBuiltinChoice(interaction, catalog, route.slice('builtin:'.length));
    if (!choice) return { status: 'cancelled' };

    const summary = summarizeChoice(choice, catalog);
    if (!await interaction.confirm(
      `Save ${summary}? config.json stores public connection metadata only. API-key routes use the named environment variable; OAuth requires kodax auth login and cloud routes use the trusted Main resolver.`,
    )) {
      return { status: 'cancelled' };
    }

    const selection = persistProviderSetupChoice({
      configPath: readiness.configPath,
      expectedRevision: readiness.configRevision,
      catalog,
      choice,
    });
    return { status: 'configured', selection };
  } finally {
    if (ownsInteraction) interaction.close?.();
  }
}

async function collectBuiltinChoice(
  interaction: ProviderSetupInteraction,
  catalog: readonly ProviderSetupCatalogEntry[],
  providerName: string,
): Promise<ProviderSetupChoice | undefined> {
  const provider = catalog.find((entry) => entry.name === providerName);
  if (!provider) throw new Error(`Unknown setup provider: ${providerName}`);
  const models = [...new Set(provider.models)];
  const model = await interaction.choose(
    `Choose a model for ${provider.name}.`,
    models.map((value) => ({
      value,
      label: value === provider.defaultModel ? `${value} (default)` : value,
    })),
  );
  return model ? { kind: 'builtin', provider: provider.name, model } : undefined;
}

async function collectCustomChoice(
  interaction: ProviderSetupInteraction,
): Promise<ProviderSetupChoice | undefined> {
  const name = await requiredText(
    interaction,
    'Custom provider name (a unique local alias used by /model and config.json)',
  );
  if (!name) return undefined;
  const protocol = await interaction.choose(
    'Protocol (select the actual provider API)',
    [
      { value: 'openai', label: 'OpenAI-compatible' },
      { value: 'anthropic', label: 'Anthropic-compatible' },
      { value: 'responses', label: 'OpenAI Responses' },
      { value: 'gemini', label: 'Gemini native' },
      { value: 'vertex', label: 'Vertex native' },
      { value: 'bedrock', label: 'Amazon Bedrock Converse' },
      { value: 'azure', label: 'Azure OpenAI Responses' },
      { value: 'mistral', label: 'Mistral native' },
      { value: 'pi-messages', label: 'Pi Messages' },
      { value: 'oauth', label: 'OAuth subscription (your own registered client)' },
    ],
  );
  if (!protocol) return undefined;
  if (protocol === 'oauth') return collectOAuthChoice(interaction, name);
  if (['gemini', 'vertex', 'bedrock', 'azure'].includes(protocol)) return collectCloudChoice(interaction, name, protocol);
  if (!['openai', 'responses', 'anthropic', 'mistral', 'pi-messages'].includes(protocol)) return undefined;
  const baseUrl = await requiredText(
    interaction,
    'API Base URL from the provider documentation, for example https://example.com/v1',
  );
  if (!baseUrl) return undefined;
  const apiKeyEnv = await requiredText(
    interaction,
    [
      'Environment-variable name only (for example MY_PROVIDER_API_KEY).',
      'Do not paste an API key here.',
      'config.json stores this name only.',
      'After setup, set this environment variable\'s value to this provider\'s API key.',
    ].join(' '),
  );
  if (!apiKeyEnv) return undefined;
  const model = await requiredText(
    interaction,
    'Model identifier from the provider documentation, for example provider/model-name',
  );
  if (!model) return undefined;
  return {
    kind: 'custom',
    provider: validateProviderSetupCustomMetadata({
      name,
      protocol: protocol === 'responses' ? 'openai' : protocol as 'openai' | 'anthropic' | 'mistral' | 'pi-messages',
      ...(protocol === 'responses' ? { api: 'responses' as const } : {}),
      baseUrl,
      apiKeyEnv,
      model,
    }),
  };
}

async function collectOAuthChoice(interaction: ProviderSetupInteraction, name: string): Promise<ProviderSetupChoice | undefined> {
  const services = ['openai-chatgpt', 'openai-codex', 'github-copilot', 'anthropic', 'openrouter', 'kimi-coding', 'meta', 'xai', 'radius'] as const;
  const selected = await interaction.choose('OAuth service (requires your issued client registration)', services.map(value => ({ value, label: value })));
  const service = services.find(value => value === selected); if (!service) return undefined;
  const model = await requiredText(interaction, 'Model identifier from the provider documentation'); if (!model) return undefined;
  let api: 'responses' | 'chat-completions' | 'anthropic-messages' | undefined;
  if (service === 'github-copilot') {
    const selectedApi = await interaction.choose('Copilot model API', [{ value: 'responses', label: 'Responses' }, { value: 'chat-completions', label: 'Chat Completions' }, { value: 'anthropic-messages', label: 'Anthropic Messages' }]);
    if (!selectedApi) return undefined; api = selectedApi as typeof api;
  }
  return { kind: 'custom', provider: createOAuthProviderConfig({ name, model, service, ...(api ? { api } : {}) }) };
}

async function collectCloudChoice(interaction: ProviderSetupInteraction, name: string, service: string): Promise<ProviderSetupChoice | undefined> {
  let connection;
  if (service === 'vertex') {
    const project = await requiredText(interaction, 'Google Cloud project ID');
    const location = project && await requiredText(interaction, 'Vertex location (for example global or us-central1)');
    if (!project || !location) return undefined;
    connection = createCloudProviderConfig({ name, model: 'pending', service, project, location });
  } else if (service === 'bedrock') {
    const region = await requiredText(interaction, 'AWS region'); if (!region) return undefined;
    connection = createCloudProviderConfig({ name, model: 'pending', service, region });
  } else if (service === 'azure') {
    const endpoint = await requiredText(interaction, 'Azure HTTPS resource endpoint'); if (!endpoint) return undefined;
    connection = createCloudProviderConfig({ name, model: 'pending', service, endpoint });
  } else connection = createCloudProviderConfig({ name, model: 'pending', service: 'gemini' });
  const apiKeyEnv = await requiredText(interaction, 'Environment-variable name only; native cloud identities may use the trusted Host credential resolver instead.');
  const model = apiKeyEnv && await requiredText(interaction, 'Model identifier from the provider documentation');
  if (!apiKeyEnv || !model) return undefined;
  return { kind: 'custom', provider: validateProviderSetupCustomMetadata({ ...connection, apiKeyEnv, model }) };
}

async function requiredText(
  interaction: ProviderSetupInteraction,
  message: string,
): Promise<string | undefined> {
  const value = await interaction.text(message);
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function summarizeChoice(
  choice: ProviderSetupChoice,
  catalog: readonly ProviderSetupCatalogEntry[],
): string {
  if (choice.kind === 'custom') {
    const provider = choice.provider;
    return `provider=${provider.name}, protocol=${provider.protocol}, baseUrl=${provider.baseUrl}, model=${provider.model}, apiKeyEnv=${provider.apiKeyEnv}`;
  }
  const provider = catalog.find((entry) => entry.name === choice.provider);
  return `provider=${choice.provider}, model=${choice.model}, apiKeyEnv=${provider?.apiKeyEnv ?? '<unknown>'}`;
}

function createTerminalProviderSetupInteraction(input: {
  readonly input: Readable;
  readonly output: Writable;
}): ProviderSetupInteraction {
  const rl = readline.createInterface({ input: input.input, output: input.output });
  let readlineClosed = false;
  rl.on('close', () => {
    readlineClosed = true;
  });
  rl.on('SIGINT', () => rl.close());

  const question = (prompt: string): Promise<string | undefined> => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      rl.removeListener('close', onClose);
      resolve(value);
    };
    const onClose = (): void => finish(undefined);
    if (readlineClosed) {
      finish(undefined);
      return;
    }
    rl.once('close', onClose);
    try {
      rl.question(prompt, (answer) => finish(answer));
    } catch (error) {
      rl.removeListener('close', onClose);
      if (readlineClosed) {
        finish(undefined);
      } else {
        reject(error);
      }
    }
  });

  return {
    async choose(message, items) {
      input.output.write(`\n${chalk.cyan(message)}\n`);
      items.forEach((item, index) => input.output.write(`  ${index + 1}. ${item.label}\n`));
      while (true) {
        const answer = await question(chalk.dim(`Select 1-${items.length} (q to cancel): `));
        if (answer === undefined || answer.trim().toLowerCase() === 'q') return undefined;
        const index = Number.parseInt(answer.trim(), 10) - 1;
        const selected = items[index];
        if (selected) return selected.value;
        input.output.write(chalk.yellow('Choose one of the numbered options.\n'));
      }
    },
    async text(message, defaultValue) {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      const answer = await question(`${message}${suffix} (q to cancel): `);
      if (answer === undefined || answer.trim().toLowerCase() === 'q') return undefined;
      return answer.trim() || defaultValue;
    },
    async confirm(message) {
      const answer = await question(`${message} [y/N]: `);
      return answer?.trim().toLowerCase() === 'y';
    },
    close: () => rl.close(),
  };
}
