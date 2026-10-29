import { executeVisualTool, getModelInputCapabilities, VISUAL_TOOL_DEFINITIONS } from '@kodax-ai/agent/media';
import { resolveProvider } from '@kodax-ai/llm';
import type { LocalToolDefinition } from './types.js';
import { getToolResultAdmissionLimits } from './tool-result-policy.js';

export const VISUAL_CODING_TOOLS: LocalToolDefinition[] = VISUAL_TOOL_DEFINITIONS.map(definition => ({
  ...definition, sideEffect: 'readonly', toClassifierInput: () => '',
  handler: async (input, ctx) => {
    if (!ctx.visualObservationOwner || !ctx.reserveVisualOutput) return '[Tool Error] Visual observation capability unavailable in this owner.';
    const model = ctx.visualModelSelection?.() ?? ctx.parentAgentConfig;
    if (definition.name === 'visual_inspect' && model) {
      const profile = resolveProvider(model.provider).getCapabilityProfile();
      if (profile.transport !== 'native-api' || (profile.multimodalSupport !== 'image-input' && profile.multimodalSupport !== 'full'
        && !getModelInputCapabilities(model).image.sdkSupported)) {
        return '[Tool Error] Visual image route unavailable for this provider/model; visual verification remains unverified.';
      }
    }
    return (await executeVisualTool(definition.name, input, { owner: ctx.visualObservationOwner,
      reserveOutput: (tokens, textBytes) => {
        const limits = getToolResultAdmissionLimits(definition.name);
        if (textBytes !== undefined && (textBytes > limits.maxBytes || tokens > limits.perEntryTokens)) {
          throw new Error('Pixel output exceeds final result admission; request fewer samples or views.');
        }
        return ctx.reserveVisualOutput!(tokens);
      }, signal: ctx.abortSignal })).content;
  },
}));
