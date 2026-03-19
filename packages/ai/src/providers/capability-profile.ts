import type { KodaXProviderCapabilityProfile } from '../types.js';

export const NATIVE_PROVIDER_CAPABILITY_PROFILE: KodaXProviderCapabilityProfile = {
  transport: 'native-api',
  conversationSemantics: 'full-history',
  mcpSupport: 'none',
};

export const CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE: KodaXProviderCapabilityProfile = {
  transport: 'cli-bridge',
  conversationSemantics: 'last-user-message',
  mcpSupport: 'none',
};

export function cloneCapabilityProfile(
  profile: KodaXProviderCapabilityProfile,
): KodaXProviderCapabilityProfile {
  return { ...profile };
}
