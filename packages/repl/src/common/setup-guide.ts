import path from 'node:path';

import { getAgentConfigHome } from '@kodax-ai/agent';
import { KODAX_PROVIDER_SNAPSHOTS } from '@kodax-ai/coding';

import {
  getProviderSetupCatalog,
  type ProviderSetupCatalogEntry,
} from './provider-setup.js';
import { DEFAULT_SHORTCUTS } from '../ui/shortcuts/defaultShortcuts.js';
import type { KeyBinding } from '../ui/shortcuts/types.js';

export interface RenderSetupGuideInput {
  readonly configHome?: string;
  readonly catalog?: readonly ProviderSetupCatalogEntry[];
  readonly cliBridges?: readonly string[];
}

function formatBinding(binding: KeyBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.meta) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  const namedKeys: Readonly<Record<string, string>> = {
    tab: 'Tab',
    escape: 'Esc',
    enter: 'Enter',
    backspace: 'Backspace',
  };
  parts.push(
    namedKeys[binding.key]
      ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key),
  );
  return parts.join('+');
}

function shortcut(id: 'toggleThinking' | 'togglePermissionMode' | 'toggleAgentMode'): string {
  const definition = DEFAULT_SHORTCUTS.find((candidate) => candidate.id === id);
  const binding = definition?.defaultBindings[0];
  return binding ? formatBinding(binding) : '<unavailable>';
}

function defaultCliBridges(): readonly string[] {
  return Object.entries(KODAX_PROVIDER_SNAPSHOTS)
    .filter(([, snapshot]) => snapshot.capabilityProfile.transport === 'cli-bridge')
    .map(([name]) => name)
    .sort();
}

export function renderSetupGuide(input: RenderSetupGuideInput = {}): string {
  const configHome = path.resolve(input.configHome ?? getAgentConfigHome());
  const catalog = input.catalog ?? getProviderSetupCatalog();
  const cliBridges = input.cliBridges ?? defaultCliBridges();
  const providerLines = catalog.map((provider) => (
    `  ${provider.name.padEnd(18)} ${provider.apiKeyEnv} (default model: ${provider.defaultModel})`
  ));

  return [
    'KodaX setup guide',
    '',
    'Configuration files (existing files are never overwritten by setup):',
    `  Core:                 ${path.join(configHome, 'config.json')}`,
    `  Annotated template:   ${path.join(configHome, 'config.example.jsonc')}`,
    `  MCP:                  ${path.join(configHome, 'integrations', 'mcp.json')}`,
    `  Extensions:           ${path.join(configHome, 'integrations', 'extensions.json')}`,
    `  A2A:                  ${path.join(configHome, 'integrations', 'a2a.json')}`,
    `  Integration templates: ${path.join(configHome, 'integrations', '*.example.jsonc')}`,
    '  Existing active files are validated first. If one is invalid, setup reports',
    '  it and stops without creating or overwriting any configuration file.',
    '  The annotated core template documents the four permission profiles and Auto review.',
    '',
    'Built-in API providers and credential environment variables:',
    ...providerLines,
    ...(cliBridges.length > 0
      ? [`  CLI bridges: ${cliBridges.join(', ')} (authenticate with the provider CLI; no KodaX API-key variable)`]
      : []),
    '',
    'Set the variable named for your provider; keep the credential out of config.json:',
    '  Custom providers: `apiKeyEnv` is the environment-variable name stored in config.json,',
    '                    never the API key value.',
    '  Put the provider\'s actual API key in the value of that exact environment variable.',
    '  KodaX does not set this environment variable for you.',
    '  Windows PowerShell (persistent user variable):',
    '    [Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "<your-key>", "User")',
    '  macOS/Linux shell profile:',
    '    export OPENAI_API_KEY="<your-key>"',
    '  Obtain the key from the provider console, then close and restart the terminal.',
    '  Run `kodax doctor` to verify local configuration without sending an LLM request.',
    '',
    'Setup commands:',
    '  kodax setup             Initialize missing files and choose a built-in or custom provider',
    '  kodax setup --custom    Configure only a custom OpenAI/Anthropic-compatible provider',
    '  kodax setup --help      Show this guide without changing files',
    '',
    'Sandbox containment (Edits and Auto attempt it before a host-boundary decision):',
    '  `kodax setup`, first-run setup, and `/setup` check sandbox readiness once.',
    '  Windows: setup can launch the one-time UAC provisioning flow; the terminal itself',
    '           does not need to run as Administrator. Declining UAC is non-fatal.',
    '  macOS:   ASRT uses Seatbelt/sandbox-exec; install ripgrep with `brew install ripgrep`.',
    '  Linux:   ASRT uses bubblewrap; install bubblewrap, socat, and ripgrep with apt,',
    '           dnf, or pacman. KodaX never invokes sudo or a package manager automatically.',
    '  Ordinary startup and tool calls do not repeat setup reminders or trigger UAC.',
    '  Inspect/activate explicitly: `kodax sandbox doctor` / `kodax sandbox setup`.',
    '  Sandboxed commands inherit the host environment, including normal development identity.',
    '  Fixed KodaX/Electron execution-control variables remain blocked.',
    '  Restart KodaX (and any persistent daemon) after changing host variables.',
    '  SDK: `@kodax-ai/kodax/sandbox` exposes doctor, activation, capability metadata,',
    '       and policy-controlled command execution independent of Auto[LLM].',
    '',
    'CLI basics:',
    '  kodax                   Enter the interactive REPL',
    '  kodax -p "task"         Run one task and exit',
    '  kodax -r                Search and resume a saved session',
    '  kodax -c                Continue the most recent non-empty session',
    '',
    'Inside the REPL:',
    '  /model [provider[/model]]  List or switch provider/model',
    '  /mode [plan|accept-edits|auto|full-access]  Switch permission mode',
    '  /effort [off|auto|low|medium|high|xhigh|max]  Set reasoning depth',
    '  /agent-mode [ama|sa|toggle]  Switch AMA/SA execution',
    '  /setup --help           Show this guide',
    '',
    'Default shortcuts:',
    `  ${shortcut('toggleThinking')}       Cycle reasoning effort`,
    `  ${shortcut('togglePermissionMode')}    Cycle permission mode`,
    `  ${shortcut('toggleAgentMode')}       Cycle AMA/SA`,
    '  Tab          Accept completion',
    '  Esc          Cancel or clear input',
  ].join('\n');
}
