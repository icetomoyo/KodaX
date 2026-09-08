import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  emitKodaXDiagnostic,
  type AgentArtifactPolicy,
  type AgentCredentialBroker,
  type ExternalAgentRegistration,
  type ExternalAgentRegistrationSummary,
} from '@kodax-ai/agent';
import {
  IntegrationConfigController,
  type IntegrationConfigStatus,
} from '@kodax-ai/repl';

import type { KodaXRuntime, RuntimeExternalAgentsOptions } from '../sdk-runtime.js';
import { createA2AAgentExecutorFactory, discoverA2ARegistration } from './client-executor.js';
import {
  parseA2AIntegrationDocument,
  readA2AIntegration,
  type A2AIntegrationDocument,
  type A2AOutboundAgentConfig,
  type A2AOutboundNetworkConfig,
} from './config.js';
import { A2A_EXECUTOR_ID, type A2ANetworkPolicy } from './types.js';

const CONFIG_OWNER = 'kodax-a2a-runtime-config-v1';
const CONFIG_REVISION_PREFIX = 'kodax-a2a-config-v1:';

interface ConfiguredRegistrationRevision {
  readonly fingerprint: string;
  readonly registrationRevision: string;
}

export interface ConfiguredA2ARuntimeHandle {
  readonly status: () => IntegrationConfigStatus;
  reload(): Promise<void>;
  close(): void;
}

export interface ConfiguredA2ARuntimeIntegration {
  readonly runtimeOptions: RuntimeExternalAgentsOptions;
  start(runtime: KodaXRuntime): Promise<ConfiguredA2ARuntimeHandle>;
}

function isExactLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

const DEFAULT_OUTBOUND_NETWORK: A2AOutboundNetworkConfig = {
  allowPrivateAddresses: false,
  allowInsecureHttp: false,
};

function networkPolicy(
  urls: readonly URL[],
  access: A2AOutboundNetworkConfig = DEFAULT_OUTBOUND_NETWORK,
): A2ANetworkPolicy {
  const loopback = urls.map((url) => isExactLoopback(url.hostname));
  if (loopback.some(Boolean) && !loopback.every(Boolean)) {
    throw new Error('Configured A2A Agent and OAuth endpoints must not mix loopback and public origins.');
  }
  return {
    allowedOrigins: [...new Set(urls.map((url) => url.origin))],
    allowPrivateAddresses: access.allowPrivateAddresses || loopback.every(Boolean),
    allowInsecureHttp: access.allowInsecureHttp,
    requestTimeoutMs: 10_000,
    maxResponseBytes: 1_000_000,
    maxRedirects: 3,
  };
}

export const CONFIGURED_A2A_TASK_RESPONSE_BYTES = 32 * 1024 * 1024;

function registrationUrl(registration: ExternalAgentRegistration): URL {
  const raw = registration.executorConfig?.interfaceUrl;
  if (typeof raw !== 'string') throw new Error('Configured A2A registration has no interface URL.');
  return new URL(raw);
}

function registrationNetworkUrls(registration: ExternalAgentRegistration): readonly URL[] {
  const urls = [registrationUrl(registration)];
  const authentication = registration.executorConfig?.authentication;
  if (authentication !== null && typeof authentication === 'object' && !Array.isArray(authentication)) {
    const tokenUrl = (authentication as Readonly<Record<string, unknown>>).tokenUrl;
    if (typeof tokenUrl === 'string') urls.push(new URL(tokenUrl));
  }
  return urls;
}

function registrationNetworkAccess(
  registration: ExternalAgentRegistration,
): A2AOutboundNetworkConfig {
  const network = registration.executorConfig?.network;
  if (network === null || typeof network !== 'object' || Array.isArray(network)) {
    return DEFAULT_OUTBOUND_NETWORK;
  }
  const source = network as Readonly<Record<string, unknown>>;
  return {
    allowPrivateAddresses: source.allowPrivateAddresses === true,
    allowInsecureHttp: source.allowInsecureHttp === true,
  };
}

function environmentCredentialBroker(): AgentCredentialBroker {
  const environmentName = (reference: string): string => {
    if (!reference.startsWith('env:') || reference.length === 4) {
      throw new Error('Configured A2A credentials must use an environment reference.');
    }
    return reference.slice(4);
  };
  return {
    isAvailable(reference) {
      const value = process.env[environmentName(reference)];
      return typeof value === 'string' && value.length > 0;
    },
    async withCredential(reference, use) {
      const value = process.env[environmentName(reference)];
      if (!value) throw new Error('Configured A2A credential is unavailable.');
      return use(value);
    },
  };
}

export const configuredA2AArtifactPolicy: AgentArtifactPolicy = ({ artifact }) => {
  if (artifact.provenance !== 'a2a' || !artifact.uri) {
    return { allowed: false, reason: 'Configured A2A artifacts require an A2A provenance URI.' };
  }
  let scheme: string;
  try {
    scheme = new URL(artifact.uri).protocol;
  } catch {
    return { allowed: false, reason: 'Configured A2A artifact URI is invalid.' };
  }
  if (scheme !== 'data:' && scheme !== 'http:' && scheme !== 'https:') {
    return { allowed: false, reason: `Configured A2A artifact URI scheme is not allowed: ${scheme}` };
  }
  // The executor has already bounded inline bytes. HTTP(S) values remain
  // provenance-bearing references; this policy never downloads them.
  return { allowed: true };
};

function registrationInput(name: string, config: A2AOutboundAgentConfig) {
  return {
    agentId: `external:${name}`,
    agentCardUrl: config.cardUrl,
    ...(config.credentialEnv ? { credentialRef: `env:${config.credentialEnv}` } : {}),
    ...(config.authentication ? {
      authentication: {
        type: 'oauth2-client-credentials' as const,
        scheme: config.authentication.scheme,
        issuer: config.authentication.issuer,
        tokenUrl: config.authentication.tokenUrl,
        clientId: config.authentication.clientId,
        clientSecretRef: `env:${config.authentication.clientSecretEnv}`,
        scopes: config.authentication.scopes,
        ...(config.authentication.resource ? { resource: config.authentication.resource } : {}),
        clientAuthentication: config.authentication.clientAuthentication,
      },
    } : {}),
    effects: { remote: config.effect },
  } as const;
}

function configFingerprint(config: A2AOutboundAgentConfig): string {
  const authentication = config.authentication
    ? [
        config.authentication.type,
        config.authentication.scheme,
        config.authentication.issuer,
        config.authentication.tokenUrl,
        config.authentication.clientId,
        config.authentication.clientSecretEnv,
        config.authentication.scopes,
        config.authentication.resource ?? null,
        config.authentication.clientAuthentication,
      ]
    : null;
  return createHash('sha256').update(JSON.stringify([
    config.cardUrl,
    config.credentialEnv ?? null,
    authentication,
    config.network ?? DEFAULT_OUTBOUND_NETWORK,
    config.effect,
  ])).digest('hex');
}

function parseConfiguredRegistrationRevision(
  revision: string,
): ConfiguredRegistrationRevision | undefined {
  if (!revision.startsWith(CONFIG_REVISION_PREFIX)) return undefined;
  const fingerprintStart = CONFIG_REVISION_PREFIX.length;
  const separator = revision.indexOf(':', fingerprintStart);
  if (separator < 0) return undefined;
  const fingerprint = revision.slice(fingerprintStart, separator);
  const registrationRevision = revision.slice(separator + 1);
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || registrationRevision.length === 0) return undefined;
  return { fingerprint, registrationRevision };
}

function configuredRegistrationRevision(fingerprint: string, revision: string): string {
  const source = parseConfiguredRegistrationRevision(revision)?.registrationRevision ?? revision;
  return `${CONFIG_REVISION_PREFIX}${fingerprint}:${source}`;
}

function markConfiguredRegistration(
  registration: ExternalAgentRegistration,
  fingerprint: string,
  config: A2AOutboundAgentConfig,
): ExternalAgentRegistration {
  return {
    ...registration,
    executorConfig: {
      ...registration.executorConfig,
      network: { ...(config.network ?? DEFAULT_OUTBOUND_NETWORK) },
    },
    managementOwner: CONFIG_OWNER,
    configurationRevision: configuredRegistrationRevision(fingerprint, registration.configurationRevision),
  };
}

export function createConfiguredA2ARuntimeIntegration(input: {
  readonly configHome: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly onEvent?: (message: string) => void;
}): ConfiguredA2ARuntimeIntegration {
  const runtimeOptions: RuntimeExternalAgentsOptions = {
    factories: [createA2AAgentExecutorFactory((registration) => ({
      networkPolicy: networkPolicy(
        registrationNetworkUrls(registration),
        registrationNetworkAccess(registration),
      ),
      maxTaskResponseBytes: CONFIGURED_A2A_TASK_RESPONSE_BYTES,
      pollIntervalMs: 500,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    }))],
    policy: () => ({ allowed: true }),
    credentialBroker: environmentCredentialBroker(),
    artifactPolicy: configuredA2AArtifactPolicy,
    // Without defaultContext, the runtime sets defaultAgentContext to undefined,
    // which prevents agentExecutorPlane from being injected into tool contexts.
    // list_dispatchable_agents and spawn_agent then cannot see configured A2A
    // agents even though registrations are written to disk successfully.
    // run.start may override this with a session-specific agentContext.
    defaultContext: { actorId: CONFIG_OWNER },
  };
  return {
    runtimeOptions,
    async start(runtime) {
      const knownRegistrations = new Map<string, ExternalAgentRegistration>();
      const appliedConfigs = new Map<string, A2AOutboundAgentConfig>();
      const notify = (message: string): void => {
        try {
          input.onEvent?.(message);
        } catch (error: unknown) {
          emitKodaXDiagnostic({
            source: 'a2a.runtime-config',
            level: 'warn',
            message: 'A2A Runtime event observer failed.',
            detail: error,
          });
        }
      };
      const reportEntryFailure = (
        agentId: string,
        outcome: string,
        error: unknown,
      ): void => {
        emitKodaXDiagnostic({
          source: 'a2a.runtime-config',
          level: 'warn',
          message: `A2A Agent "${agentId}" reconciliation failed; ${outcome}.`,
          detail: error,
        });
        notify(`A2A Agent "${agentId}" could not be reconciled; ${outcome}.`);
      };
      const controller = new IntegrationConfigController<A2AIntegrationDocument>({
        domain: 'a2a',
        configHome: input.configHome,
        validate: parseA2AIntegrationDocument,
        read: () => readA2AIntegration(input.configHome),
        coldStartDefault: { version: 2, agents: {} },
      });

      const persistDisabledFence = async (
        agentId: string,
        current: ExternalAgentRegistrationSummary,
      ): Promise<ExternalAgentRegistrationSummary | undefined> => {
        if (current.managementOwner !== undefined && current.managementOwner !== CONFIG_OWNER) {
          throw new Error(
            `A2A registration "${agentId}" is owned by ${current.managementOwner}.`,
          );
        }
        const known = knownRegistrations.get(agentId);
        const summary = await runtime.admin.agentRegistrations.setEnabled(agentId, false, {
          expectedConfigurationRevision: current.configurationRevision,
          expectedManagementOwner: current.managementOwner ?? null,
          ...(current.managementOwner === undefined ? { claimOwner: CONFIG_OWNER } : {}),
        });
        if (!summary) {
          knownRegistrations.delete(agentId);
          notify(`A2A registration "${agentId}" changed concurrently; disable was deferred.`);
          return undefined;
        }
        if (known?.configurationRevision === current.configurationRevision
          && known.endpointIdentityHash === current.endpointIdentityHash) {
          knownRegistrations.set(agentId, {
            ...known,
            managementOwner: CONFIG_OWNER,
            enabled: false,
          });
        } else {
          knownRegistrations.delete(agentId);
        }
        return summary;
      };

      const refreshConfiguredAgent = async (
        name: string,
        config: A2AOutboundAgentConfig,
        fingerprint: string,
        retainsLastKnownGood: boolean,
        expectedConfigurationRevision: string | null,
        expectedManagementOwner: string | null,
      ): Promise<void> => {
        const agentId = `external:${name}`;
        try {
          const url = new URL(config.cardUrl);
          const urls = [url, ...(config.authentication ? [new URL(config.authentication.tokenUrl)] : [])];
          networkPolicy(urls, config.network);
          const discovered = await discoverA2ARegistration(
            registrationInput(name, config),
            {
              networkPolicy: networkPolicy([url], config.network),
              pollIntervalMs: 500,
              ...(input.fetch ? { fetch: input.fetch } : {}),
            },
          );
          const registration = markConfiguredRegistration(
            discovered.registration,
            fingerprint,
            config,
          );
          await runtime.admin.agentRegistrations.upsert(registration, {
            expectedConfigurationRevision,
            expectedManagementOwner,
          });
          knownRegistrations.set(agentId, registration);
          appliedConfigs.set(agentId, config);
        } catch (error: unknown) {
          const outcome = retainsLastKnownGood
            ? 'the live registration was left unchanged'
            : 'the activation was not applied';
          emitKodaXDiagnostic({
            source: 'a2a.runtime-config',
            level: 'warn',
            message: `A2A Agent "${name}" refresh failed; ${outcome}.`,
            detail: error,
          });
          notify(`A2A Agent "${name}" could not be refreshed; ${outcome}.`);
        }
      };

      const reconcile = async (document: A2AIntegrationDocument): Promise<void> => {
        const current = await runtime.admin.agentRegistrations.list();
        const currentById = new Map(current.map((entry) => [entry.agentId, entry]));
        const desiredIds = new Set(Object.keys(document.agents).map((name) => `external:${name}`));

        for (const [agentId, registration] of currentById) {
          if (desiredIds.has(agentId)) continue;
          if (registration.managementOwner !== CONFIG_OWNER) continue;
          let removed: boolean;
          try {
            removed = await runtime.admin.agentRegistrations.remove(agentId, {
              expectedConfigurationRevision: registration.configurationRevision,
              expectedManagementOwner: CONFIG_OWNER,
            });
          } catch (error: unknown) {
            reportEntryFailure(agentId, 'removal was not applied', error);
            continue;
          }
          if (!removed) {
            knownRegistrations.delete(agentId);
            notify(`A2A registration "${agentId}" changed concurrently; removal was deferred.`);
            continue;
          }
          knownRegistrations.delete(agentId);
          appliedConfigs.delete(agentId);
          currentById.delete(agentId);
        }

        for (const [name, config] of Object.entries(document.agents)) {
          if (config.enabled) continue;
          const agentId = `external:${name}`;
          const currentRegistration = currentById.get(agentId);
          if (currentRegistration?.managementOwner !== undefined
            && currentRegistration.managementOwner !== CONFIG_OWNER) {
            reportEntryFailure(
              agentId,
              'the registration belongs to another manager',
              new Error(
                `A2A registration "${agentId}" is owned by ${currentRegistration.managementOwner}.`,
              ),
            );
            continue;
          }
          if (currentRegistration && (
            currentRegistration.enabled
            || currentRegistration.managementOwner !== CONFIG_OWNER
          )) {
            try {
              const summary = await persistDisabledFence(agentId, currentRegistration);
              if (summary) currentById.set(agentId, summary);
              else currentById.delete(agentId);
            } catch (error: unknown) {
              reportEntryFailure(agentId, 'the disabled fence was not applied', error);
              continue;
            }
          }
          appliedConfigs.set(agentId, config);
        }

        const refreshes: Array<Promise<void>> = [];
        for (const [name, config] of Object.entries(document.agents)) {
          if (!config.enabled) continue;
          const agentId = `external:${name}`;
          const fingerprint = configFingerprint(config);
          const previousConfig = appliedConfigs.get(agentId);
          const currentRegistration = currentById.get(agentId);
          if (currentRegistration?.managementOwner !== undefined
            && currentRegistration.managementOwner !== CONFIG_OWNER) {
            reportEntryFailure(
              agentId,
              'the registration belongs to another manager',
              new Error(
                `A2A registration "${agentId}" is owned by ${currentRegistration.managementOwner}.`,
              ),
            );
            continue;
          }
          const configuredRevision = currentRegistration
            ? parseConfiguredRegistrationRevision(currentRegistration.configurationRevision)
            : undefined;
          const known = knownRegistrations.get(agentId);
          const knownMatchesLive = known !== undefined && currentRegistration !== undefined
            && known.configurationRevision === currentRegistration.configurationRevision
            && known.endpointIdentityHash === currentRegistration.endpointIdentityHash;
          if (currentRegistration?.enabled && currentRegistration.managementOwner === CONFIG_OWNER
            && configuredRevision?.fingerprint === fingerprint && previousConfig
            && isDeepStrictEqual(previousConfig, config) && knownMatchesLive) {
            continue;
          }

          const retainsLastKnownGood = currentRegistration?.enabled === true
            && currentRegistration.managementOwner === CONFIG_OWNER
            && configuredRevision?.fingerprint === fingerprint
            && (known === undefined || knownMatchesLive);
          let expectedConfigurationRevision = currentRegistration?.configurationRevision ?? null;
          let expectedManagementOwner = currentRegistration?.managementOwner ?? null;
          if (currentRegistration && !retainsLastKnownGood && (
            currentRegistration.enabled || currentRegistration.managementOwner !== CONFIG_OWNER
          )) {
            let summary: ExternalAgentRegistrationSummary | undefined;
            try {
              summary = await persistDisabledFence(agentId, currentRegistration);
            } catch (error: unknown) {
              reportEntryFailure(agentId, 'the authority fence was not applied', error);
              continue;
            }
            if (!summary) {
              currentById.delete(agentId);
              continue;
            }
            currentById.set(agentId, summary);
            expectedConfigurationRevision = summary.configurationRevision;
            expectedManagementOwner = summary.managementOwner ?? null;
          }

          refreshes.push(refreshConfiguredAgent(
            name,
            config,
            fingerprint,
            retainsLastKnownGood,
            expectedConfigurationRevision,
            expectedManagementOwner,
          ));
        }
        await Promise.all(refreshes);
      };

      try {
        const initial = await controller.initialize();
        const initialDiagnostic = controller.status().diagnostic;
        if (initialDiagnostic) notify(`a2a: ${initialDiagnostic.message}`);
        await reconcile(initial.document);
        controller.subscribe(async (snapshot, previous) => {
          if (snapshot.revision === previous?.revision) return;
          await reconcile(snapshot.document);
          const enabled = Object.values(snapshot.document.agents).filter((agent) => agent.enabled).length;
          notify(`A2A configuration hot-reloaded (${enabled} enabled outbound Agents).`);
        });
        controller.startWatching();
        return {
          status: () => controller.status(),
          async reload() {
            const previous = controller.snapshot();
            const result = await controller.reload();
            if (result.ok && result.snapshot.revision === previous?.revision) {
              await reconcile(result.snapshot.document);
            }
          },
          close() { controller.close(); },
        };
      } catch (error: unknown) {
        controller.close();
        throw error;
      }
    },
  };
}
