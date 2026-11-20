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

// FEATURE_134 v0.7.40 — CLI bridges that DO accept image input via a
// file-include prompt syntax (Gemini CLI 2.x `@<path>`). The flag controls
// the provider-policy multimodal gate (`provider-policy.ts:299`). Codex CLI's
// `codex exec --json --full-auto` mode has no image surface, so codex-cli
// continues to use the plain `CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE`.
export const IMAGE_INPUT_CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE: KodaXProviderCapabilityProfile = {
  ...CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  multimodalSupport: 'image-input',
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
