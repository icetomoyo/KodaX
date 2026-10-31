import type { KodaXReasoningProfile, KodaXProviderStreamOptions } from '../types.js';
import { KodaXProviderError } from '../errors.js';

export const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';
export function hasThinkingBinding(params: object): boolean {
  const thinking: unknown = (params as Record<string, unknown>).thinking;
  return !!thinking && typeof thinking === 'object' && 'block_binding' in thinking;
}
/** Capabilities are declared per model; names and regions never imply beta controls. */
export function applyAnthropicThinkingOptions(params: object, profile: KodaXReasoningProfile | undefined,
  options: KodaXProviderStreamOptions | undefined, provider: string, bedrock = false): void {
  const display = options?.thinkingDisplay;
  if (display !== undefined && (!['summarized', 'omitted'].includes(display) || profile?.supportsThinkingDisplay !== true)) {
    throw new KodaXProviderError('Thinking display requires a declared supported native model.', provider, { retryable: false });
  }
  const thinking: unknown = (params as Record<string, unknown>).thinking;
  if (!thinking || typeof thinking !== 'object' || !('type' in thinking) || !['adaptive', 'enabled'].includes(thinking.type as string)) return;
  if (profile?.supportsThinkingDisplay) Object.assign(thinking, { display: display ?? 'summarized' });
  if (profile?.supportsThinkingBlockBinding && thinking.type === 'adaptive') {
    Object.assign(thinking, { block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    if (bedrock) Object.assign(params, { anthropic_beta: [THINKING_BINDING_BETA] });
  }
}
