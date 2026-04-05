import type { KodaXProviderCapabilityProfile } from '../types.js';

export interface NormalizedKodaXProviderCapabilityProfile
  extends KodaXProviderCapabilityProfile {
  contextFidelity: NonNullable<KodaXProviderCapabilityProfile['contextFidelity']>;
  toolCallingFidelity: NonNullable<KodaXProviderCapabilityProfile['toolCallingFidelity']>;
  sessionSupport: NonNullable<KodaXProviderCapabilityProfile['sessionSupport']>;
  longRunningSupport: NonNullable<KodaXProviderCapabilityProfile['longRunningSupport']>;
  multimodalSupport: NonNullable<KodaXProviderCapabilityProfile['multimodalSupport']>;
  evidenceSupport: NonNullable<KodaXProviderCapabilityProfile['evidenceSupport']>;
}

export const NATIVE_PROVIDER_CAPABILITY_PROFILE: KodaXProviderCapabilityProfile = {
  transport: 'native-api',
  conversationSemantics: 'full-history',
  mcpSupport: 'none',
  contextFidelity: 'full',
  toolCallingFidelity: 'full',
  sessionSupport: 'full',
  longRunningSupport: 'full',
  multimodalSupport: 'none',
  evidenceSupport: 'full',
};

export const IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE: KodaXProviderCapabilityProfile = {
  ...NATIVE_PROVIDER_CAPABILITY_PROFILE,
  multimodalSupport: 'image-input',
};

export const CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE: KodaXProviderCapabilityProfile = {
  transport: 'cli-bridge',
  conversationSemantics: 'last-user-message',
  mcpSupport: 'none',
  contextFidelity: 'lossy',
  toolCallingFidelity: 'limited',
  sessionSupport: 'stateless',
  longRunningSupport: 'limited',
  multimodalSupport: 'none',
  evidenceSupport: 'limited',
};

export function normalizeCapabilityProfile(
  profile: KodaXProviderCapabilityProfile,
): NormalizedKodaXProviderCapabilityProfile {
  return {
    transport: profile.transport,
    conversationSemantics: profile.conversationSemantics,
    mcpSupport: profile.mcpSupport,
    contextFidelity: profile.contextFidelity ?? 'full',
    toolCallingFidelity: profile.toolCallingFidelity ?? 'full',
    sessionSupport: profile.sessionSupport ?? 'full',
    longRunningSupport: profile.longRunningSupport ?? 'full',
    multimodalSupport: profile.multimodalSupport ?? 'none',
    evidenceSupport: profile.evidenceSupport ?? 'full',
  };
}

export function cloneCapabilityProfile(
  profile: KodaXProviderCapabilityProfile,
): KodaXProviderCapabilityProfile {
  return { ...normalizeCapabilityProfile(profile) };
}
