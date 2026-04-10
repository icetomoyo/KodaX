/**
 * KodaX Non-Streaming Fallback (Feature 045)
 *
 * Provides the ability to fall back from streaming to non-streaming mode
 * when streaming repeatedly fails. This is Step 3 of the recovery ladder.
 *
 * Each request chain may use non-streaming fallback at most once.
 * The fallback result is delivered through the same callback interface
 * (onTextDelta, onToolUseStart, etc.) for transparency.
 */

import type { KodaXMessage } from '@kodax/ai';

// ============== Types ==============

export interface NonStreamingFallbackOptions {
  /** Whether this provider supports non-streaming fallback. */
  supportsNonStreaming: boolean;
  /** Messages to send to the provider. */
  messages: KodaXMessage[];
  /** The provider client to use for the non-streaming call. */
  callNonStreaming: (messages: KodaXMessage[]) => Promise<KodaXMessage>;
  /** Callback to deliver text content from the fallback response. */
  onTextDelta: (text: string) => void;
  /** Callback to deliver tool use blocks from the fallback response. */
  onToolUseStart?: (tool: { name: string; id: string; input?: Record<string, unknown> }) => void;
}

// ============== Fallback Executor ==============

/**
 * Executes a non-streaming fallback call when streaming has failed repeatedly.
 *
 * The fallback:
 * 1. Calls the provider in non-streaming mode
 * 2. Delivers the complete response through the same callback interface
 * 3. Returns the complete assistant message for integration
 *
 * @param options - Fallback configuration and callbacks
 * @returns The complete assistant message from the non-streaming response
 * @throws Error if the provider doesn't support non-streaming or the call fails
 */
export async function executeNonStreamingFallback(
  options: NonStreamingFallbackOptions,
): Promise<KodaXMessage> {
  if (!options.supportsNonStreaming) {
    throw new Error(
      'Non-streaming fallback requested but provider does not support it',
    );
  }

  // The actual non-streaming call is delegated to the provider adapter.
  const response = await options.callNonStreaming(options.messages);

  // Deliver content through callbacks for transparency.
  if (typeof response.content === 'string') {
    options.onTextDelta(response.content);
  } else {
    for (const block of response.content) {
      if (block.type === 'text') {
        options.onTextDelta(block.text);
      } else if (block.type === 'tool_use' && options.onToolUseStart) {
        options.onToolUseStart({
          name: block.name,
          id: block.id,
          input: block.input,
        });
      }
    }
  }

  return response;
}

/**
 * Checks whether a given provider supports non-streaming fallback.
 * This should be checked before attempting fallback.
 */
export function providerSupportsFallback(
  providerCapabilities: { supportsNonStreamingFallback?: boolean } | undefined,
): boolean {
  return providerCapabilities?.supportsNonStreamingFallback ?? false;
}
