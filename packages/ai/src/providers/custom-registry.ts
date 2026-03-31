/**
 * Custom Provider Registry
 *
 * In-memory registry for user-defined providers from config.json.
 * Custom providers are separate from built-in providers to avoid
 * modifying the closed ProviderName union.
 */

import type { KodaXCustomProviderConfig } from '../types.js';
import type { KodaXBaseProvider } from './base.js';
import {
  createCustomProvider,
  validateCustomProviderConfig,
} from './custom-provider.js';
import { KODAX_PROVIDERS } from './registry.js';
import {
  cloneCapabilityProfile,
  NATIVE_PROVIDER_CAPABILITY_PROFILE,
} from './capability-profile.js';

type CustomProviderFactory = () => KodaXBaseProvider;

const customProviders = new Map<string, KodaXCustomProviderConfig>();
const customFactories = new Map<string, CustomProviderFactory>();

/**
 * Register custom providers from config. Replaces all existing custom providers.
 */
export function registerCustomProviders(configs: KodaXCustomProviderConfig[]): void {
  const seen = new Set<string>();
  const nextProviders = new Map<string, KodaXCustomProviderConfig>();
  const nextFactories = new Map<string, CustomProviderFactory>();
  for (const config of configs) {
    validateCustomProviderConfig(config);
    if (seen.has(config.name)) {
      throw new Error(`Duplicate custom provider name: "${config.name}". Each custom provider must have a unique name.`);
    }
    if (config.name in KODAX_PROVIDERS) {
      console.warn(`[kodax] Custom provider "${config.name}" shadows a built-in provider. The built-in provider will be used. Choose a different name to use your custom provider.`);
    }
    seen.add(config.name);
    nextProviders.set(config.name, config);
    nextFactories.set(config.name, () => createCustomProvider(config));
  }

  customProviders.clear();
  customFactories.clear();
  for (const [name, config] of nextProviders) {
    customProviders.set(name, config);
  }
  for (const [name, factory] of nextFactories) {
    customFactories.set(name, factory);
  }
}

/**
 * Get a custom provider instance by name.
 * Returns undefined if not found in custom registry.
 * Note: This will throw if the provider's API key env var is not set.
 */
export function getCustomProvider(name: string): KodaXBaseProvider | undefined {
  const factory = customFactories.get(name);
  return factory ? factory() : undefined;
}

/**
 * Check if a name refers to a custom provider.
 */
export function isCustomProviderName(name: string): boolean {
  return customProviders.has(name);
}

/**
 * Get all custom provider names without instantiation.
 */
export function getCustomProviderNames(): string[] {
  return [...customProviders.keys()];
}

/**
 * Get display info for all registered custom providers.
 * Reads metadata from stored config without instantiating providers,
 * so it won't throw for unconfigured providers.
 */
export function getCustomProviderList(): Array<{
  name: string;
  model: string;
  models: string[];
  configured: boolean;
  reasoningCapability: string;
  capabilityProfile: import('../types.js').KodaXProviderCapabilityProfile;
  custom: true;
}> {
  const result: Array<{
    name: string;
    model: string;
    models: string[];
    configured: boolean;
    reasoningCapability: string;
    capabilityProfile: import('../types.js').KodaXProviderCapabilityProfile;
    custom: true;
  }> = [];
  for (const [name, config] of customProviders) {
    const configured = !!process.env[config.apiKeyEnv];
    const models = config.model && config.models?.length
      ? [...new Set([config.model, ...config.models])]
      : [config.model];
    result.push({
      name,
      model: config.model,
      models,
      configured,
      reasoningCapability: config.reasoningCapability ?? 'none',
      capabilityProfile: cloneCapabilityProfile(
        config.capabilityProfile ?? NATIVE_PROVIDER_CAPABILITY_PROFILE,
      ),
      custom: true,
    });
  }
  return result;
}

/**
 * Get available model IDs for a custom provider.
 * Reads from stored config without instantiation.
 * Returns undefined if not a custom provider.
 */
export function getCustomProviderModels(name: string): string[] | undefined {
  const config = customProviders.get(name);
  if (!config) return undefined;
  return config.model && config.models?.length
    ? [...new Set([config.model, ...config.models])]
    : [config.model];
}
