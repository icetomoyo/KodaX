/**
 * KodaX Providers
 *
 * Provider 模块统一导出
 */

export { KodaXBaseProvider } from './base.js';
export { KodaXAnthropicCompatProvider } from './anthropic.js';
export { KodaXOpenAICompatProvider } from './openai.js';
export { KodaXAcpProvider } from './acp-base.js';
export {
  normalizeCapabilityProfile,
  KODAX_PROVIDERS,
  KODAX_PROVIDER_SNAPSHOTS,
  KODAX_DEFAULT_PROVIDER,
  getProvider,
  resetBuiltinProviderCache,
  getProviderConfiguredCapabilityProfile,
  getProviderConfiguredReasoningCapability,
  isProviderConfigured,
  getProviderModel,
  getProviderModels,
  getProviderList,
  isProviderName,
  // v0.7.43 SDK model-capability exposure (built-in providers).
  getProviderModelDescriptors,
  getModelCapabilities,
  listBuiltinModelCapabilities,
} from './registry.js';
export type { ProviderName, KodaXModelCapabilities } from './registry.js';
export { createCustomProvider, validateCustomProviderConfig } from './custom-provider.js';
export {
  registerCustomProviders,
  getCustomProvider,
  getCustomProviderCapabilityProfile,
  isCustomProviderName,
  getCustomProviderNames,
  getCustomProviderList,
  getCustomProviderModels,
  // v0.7.43 SDK model-capability exposure (custom providers).
  getCustomProviderModelDescriptors,
  getCustomModelCapabilities,
  listCustomProviderModelCapabilities,
} from './custom-registry.js';
export {
  registerModelProvider,
  getRuntimeModelProvider,
  isRuntimeModelProviderName,
  getRuntimeModelProviderNames,
  getRuntimeModelProviderCredentialEnvironmentNames,
  clearRuntimeModelProviders,
} from './runtime-registry.js';
export {
  resolveProvider,
  isKnownProvider,
  getAvailableProviderNames,
  getProviderCredentialEnvironmentNames,
  // v0.7.43 SDK model-capability dispatchers (built-in + custom unified).
  resolveProviderModelDescriptors,
  resolveModelCapabilities,
  listAllModelCapabilities,
  // v0.7.45 FEATURE_216 SDK credential verification + model listing.
  verifyProviderCredential,
  listProviderModels,
} from './resolver.js';
export {
  runVerifyCredential,
  classifyVerifyError,
} from './verify-credential.js';
export type { VerifyPrimitiveRunner, RunVerifyCredentialOpts } from './verify-credential.js';
