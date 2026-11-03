import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { getAgentConfigHome } from '@kodax-ai/agent';
import { withCoreConfigWriteLock, writeCoreConfigAtomically } from './core-config-lock.js';

import { getConfigTemplate, type ConfigTemplateName } from './generated-config-templates.js';
import {
  migrateLegacyIntegrationConfig,
  parseExtensionsIntegrationDocument,
  parseMcpIntegrationDocument,
  planLegacyIntegrationMigration,
} from './integration-config.js';

export type SetupConfigDomain = 'core' | 'mcp' | 'extensions' | 'a2a';
export type SetupConfigFileKind = 'active' | 'template';
export type SetupConfigFileStatus = 'created' | 'existing' | 'invalid' | 'missing';

export interface SetupConfigFileResult {
  readonly domain: SetupConfigDomain;
  readonly kind: SetupConfigFileKind;
  readonly path: string;
  readonly status: SetupConfigFileStatus;
  readonly diagnostic?: string;
}

export interface SetupConfigurationResult {
  readonly configHome: string;
  readonly files: readonly SetupConfigFileResult[];
}

export interface InitializeSetupConfigurationInput {
  readonly configHome?: string;
  /**
   * Host-owned canonical A2A parser. The standalone REPL package can safely
   * recognize only the inert empty document without this dependency.
   */
  readonly validateA2A?: (value: unknown) => unknown;
}

interface SetupConfigFile {
  readonly domain: SetupConfigDomain;
  readonly kind: SetupConfigFileKind;
  readonly path: string;
  readonly content: string;
}

const ACTIVE_DOCUMENTS: Readonly<Record<SetupConfigDomain, unknown>> = {
  core: {},
  mcp: { version: 1, servers: {} },
  extensions: { version: 1, paths: [] },
  a2a: { version: 2, agents: {} },
};

const CONFIG_DOMAINS: readonly SetupConfigDomain[] = [
  'core',
  'mcp',
  'extensions',
  'a2a',
];

function activePath(configHome: string, domain: SetupConfigDomain): string {
  if (domain === 'core') return path.join(configHome, 'config.json');
  return path.join(configHome, 'integrations', `${domain}.json`);
}

function templatePath(configHome: string, domain: SetupConfigDomain): string {
  if (domain === 'core') return path.join(configHome, 'config.example.jsonc');
  return path.join(configHome, 'integrations', `${domain}.example.jsonc`);
}

function configFiles(configHome: string): readonly SetupConfigFile[] {
  const installedHome = configHome.replaceAll('\\', '/');
  return CONFIG_DOMAINS.flatMap((domain) => [
    {
      domain,
      kind: 'active',
      path: activePath(configHome, domain),
      content: `${JSON.stringify(ACTIVE_DOCUMENTS[domain], null, 2)}\n`,
    },
    {
      domain,
      kind: 'template',
      path: templatePath(configHome, domain),
      content: getConfigTemplate(domain as ConfigTemplateName)
        .replaceAll('~/.kodax', installedHome),
    },
  ]);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function validateA2ADocument(
  value: unknown,
  validateA2A: ((value: unknown) => unknown) | undefined,
): void {
  const document = requireRecord(value, 'A2A config');
  const unknown = Object.keys(document).find((key) => !['version', 'agents', 'server'].includes(key));
  if (unknown) throw new Error(`A2A config contains unknown field "${unknown}".`);
  if (document.version !== 1 && document.version !== 2) {
    throw new Error('A2A config version must be 1 or 2.');
  }
  const agents = requireRecord(document.agents, 'A2A config agents');
  if (document.server !== undefined) requireRecord(document.server, 'A2A config server');
  if (validateA2A) {
    validateA2A(value);
  } else if (Object.keys(agents).length > 0 || document.server !== undefined) {
    throw new Error(
      'A2A config contains active declarations that require the KodaX host validator.',
    );
  }
}

function validateActiveFile(
  file: SetupConfigFile,
  validateA2A: ((value: unknown) => unknown) | undefined,
): void {
  const raw = readFileSync(file.path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${file.domain} config is invalid JSON.`);
  }
  if (file.domain === 'core') {
    requireRecord(parsed, 'Core config');
  } else if (file.domain === 'mcp') {
    parseMcpIntegrationDocument(parsed);
  } else if (file.domain === 'extensions') {
    parseExtensionsIntegrationDocument(parsed);
  } else {
    validateA2ADocument(parsed, validateA2A);
  }
}

function existingFileResult(
  file: SetupConfigFile,
  validateA2A: ((value: unknown) => unknown) | undefined,
): SetupConfigFileResult {
  if (!existsSync(file.path)) {
    return { domain: file.domain, kind: file.kind, path: file.path, status: 'missing' };
  }
  if (file.kind === 'template') {
    return { domain: file.domain, kind: file.kind, path: file.path, status: 'existing' };
  }
  try {
    validateActiveFile(file, validateA2A);
    return { domain: file.domain, kind: file.kind, path: file.path, status: 'existing' };
  } catch (error) {
    return {
      domain: file.domain,
      kind: file.kind,
      path: file.path,
      status: 'invalid',
      diagnostic: error instanceof Error ? error.message : `${file.domain} config is invalid.`,
    };
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'EEXIST';
}

function createIfMissing(
  file: SetupConfigFile,
  validateA2A: ((value: unknown) => unknown) | undefined,
): SetupConfigFileResult {
  if (file.domain === 'core' && file.kind === 'active') {
    const existing = existingFileResult(file, validateA2A);
    if (existing.status !== 'missing') return existing;
    return withCoreConfigWriteLock(file.path, () => {
      const current = existingFileResult(file, validateA2A);
      if (current.status !== 'missing') return current;
      writeCoreConfigAtomically(file.path, file.content);
      return { domain: file.domain, kind: file.kind, path: file.path, status: 'created' };
    });
  }
  mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file.path, file.content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return { domain: file.domain, kind: file.kind, path: file.path, status: 'created' };
  } catch (error) {
    if (isAlreadyExists(error)) {
      return existingFileResult(file, validateA2A);
    }
    throw error;
  }
}

function legacyIntegrationDiagnostic(configHome: string): string | undefined {
  const corePath = activePath(configHome, 'core');
  if (!existsSync(corePath)) return undefined;
  try {
    const core = requireRecord(
      JSON.parse(readFileSync(corePath, 'utf8')) as unknown,
      'Core config',
    );
    const plan = planLegacyIntegrationMigration(configHome);
    if (plan.mcp.action === 'create') {
      parseMcpIntegrationDocument({ version: 1, servers: core.mcpServers });
    }
    if (plan.extensions.action === 'create') {
      parseExtensionsIntegrationDocument({ version: 1, paths: core.extensions });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Legacy integration config is invalid.';
    return `Legacy integration configuration is invalid: ${message}`;
  }
  return undefined;
}

/**
 * Install the inert active documents and annotated references needed by setup.
 * Existing files are authoritative and are never rewritten.
 */
export function initializeSetupConfiguration(
  input: InitializeSetupConfigurationInput = {},
): SetupConfigurationResult {
  const configHome = path.resolve(input.configHome ?? getAgentConfigHome());
  const files = configFiles(configHome);
  let preflight = files.map((file) => existingFileResult(file, input.validateA2A));
  if (preflight.some((file) => file.status === 'invalid')) {
    return { configHome, files: preflight };
  }
  const legacyDiagnostic = legacyIntegrationDiagnostic(configHome);
  if (legacyDiagnostic) {
    const corePath = activePath(configHome, 'core');
    preflight = preflight.map((file) => file.path === corePath
      ? { ...file, status: 'invalid', diagnostic: legacyDiagnostic }
      : file);
    return { configHome, files: preflight };
  }
  // Preserve legacy core declarations before empty authoritative split files
  // are installed. Cleanup remains an explicit migration choice.
  migrateLegacyIntegrationConfig({ configHome });
  return {
    configHome,
    files: files.map((file) => createIfMissing(file, input.validateA2A)),
  };
}
