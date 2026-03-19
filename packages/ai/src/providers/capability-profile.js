export const NATIVE_PROVIDER_CAPABILITY_PROFILE = {
    transport: 'native-api',
    conversationSemantics: 'full-history',
    mcpSupport: 'none',
};
export const CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE = {
    transport: 'cli-bridge',
    conversationSemantics: 'last-user-message',
    mcpSupport: 'none',
};
export function cloneCapabilityProfile(profile) {
    return { ...profile };
}
