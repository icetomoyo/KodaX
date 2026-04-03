/**
 * KodaX Stable Boundary Tracker (Feature 045)
 *
 * Tracks the "stable boundary" during provider streaming — the point
 * up to which all content is fully committed and can be safely recovered to.
 *
 * Stable boundary = index after the last fully committed assistant message
 * or tool result. Content beyond this point (live streaming text, incomplete
 * tool call JSON) is considered unstable and will be discarded on recovery.
 */

import type { KodaXMessage } from '@kodax/ai';
import type {
  FailureStage,
  ProviderExecutionState,
} from './types.js';

// ============== Tracker ==============

let requestIdCounter = 0;

function nextRequestId(): string {
  return `req_${Date.now()}_${++requestIdCounter}`;
}

export class StableBoundaryTracker {
  private state: ProviderExecutionState;
  private hasReceivedFirstDelta = false;
  private currentToolInputId: string | undefined;

  constructor() {
    this.state = this.createInitialState();
  }

  // ============== Lifecycle ==============

  /**
   * Called before each provider request attempt.
   * Resets streaming state but preserves stable boundary position.
   */
  beginRequest(
    provider: string,
    model: string,
    messages: KodaXMessage[],
    attempt: number = 1,
    fallbackUsed: boolean = false,
  ): void {
    this.state = {
      requestId: nextRequestId(),
      provider,
      model,
      attempt,
      lastStableMessageIndex: messages.length,
      executedToolCallIds: [...this.state.executedToolCallIds],
      pendingToolCallIds: [],
      visibleLiveTextLength: 0,
      visibleThinkingLength: 0,
      fallbackUsed,
      startedAt: Date.now(),
    };
    this.hasReceivedFirstDelta = false;
    this.currentToolInputId = undefined;
  }

  /**
   * Called when the first stream delta is received.
   * Updates the failure stage from "before_first_delta" to "mid_stream_*".
   */
  markFirstDelta(): void {
    this.hasReceivedFirstDelta = true;
  }

  /**
   * Called when text delta is received.
   * Tracks the amount of live (unstable) text.
   */
  markTextDelta(text: string): void {
    if (!this.hasReceivedFirstDelta) {
      this.markFirstDelta();
    }
    this.state.visibleLiveTextLength += text.length;
  }

  /**
   * Called when thinking delta is received.
   */
  markThinkingDelta(text: string): void {
    if (!this.hasReceivedFirstDelta) {
      this.markFirstDelta();
    }
    this.state.visibleThinkingLength += text.length;
  }

  /**
   * Called when tool input streaming starts.
   * Adds the tool call to the pending list.
   */
  markToolInputStart(toolCallId: string): void {
    if (!this.hasReceivedFirstDelta) {
      this.markFirstDelta();
    }
    this.currentToolInputId = toolCallId;
    if (!this.state.pendingToolCallIds.includes(toolCallId)) {
      this.state.pendingToolCallIds.push(toolCallId);
    }
  }

  /**
   * Called when a tool has been successfully executed.
   * Moves the tool from pending to executed and advances the stable boundary.
   */
  markToolExecuted(toolCallId: string): void {
    // Remove from pending
    this.state.pendingToolCallIds = this.state.pendingToolCallIds.filter(
      id => id !== toolCallId,
    );

    // Add to executed
    if (!this.state.executedToolCallIds.includes(toolCallId)) {
      this.state.executedToolCallIds.push(toolCallId);
    }

    if (this.currentToolInputId === toolCallId) {
      this.currentToolInputId = undefined;
    }
  }

  /**
   * Called when the assistant message is complete (stream ended normally).
   * This advances the stable boundary past the current assistant message.
   */
  markAssistantComplete(messages: KodaXMessage[]): void {
    this.state.lastStableMessageIndex = messages.length;
    this.state.visibleLiveTextLength = 0;
    this.state.visibleThinkingLength = 0;
    this.state.pendingToolCallIds = [];
    this.hasReceivedFirstDelta = false;
  }

  // ============== State Access ==============

  /**
   * Returns the current failure stage based on tracker state.
   */
  inferFailureStage(): FailureStage {
    if (!this.hasReceivedFirstDelta) {
      return 'before_first_delta';
    }
    if (this.currentToolInputId) {
      return 'mid_stream_tool_input';
    }
    if (this.state.visibleThinkingLength > 0 && this.state.visibleLiveTextLength === 0) {
      return 'mid_stream_thinking';
    }
    if (this.state.executedToolCallIds.length > 0) {
      return 'post_tool_execution_pre_assistant_close';
    }
    return 'mid_stream_text';
  }

  /**
   * Returns a read-only snapshot of the current execution state.
   */
  snapshot(): Readonly<ProviderExecutionState> {
    return { ...this.state };
  }

  /**
   * Whether any delta has been received in the current request.
   */
  get hasReceivedDelta(): boolean {
    return this.hasReceivedFirstDelta;
  }

  // ============== Recovery ==============

  /**
   * Recovers to the last stable boundary.
   *
   * Reconstructs the message list from the stable boundary forward,
   * preserving executed tool results and discarding unstable content.
   *
   * @param messages - The current (possibly corrupted) message list
   * @returns Recovery info with reconstructed messages and metadata
   */
  recoverToStableBoundary(messages: KodaXMessage[]): {
    messages: KodaXMessage[];
    droppedToolCallIds: string[];
    executedToolCallIds: string[];
  } {
    const stableIndex = Math.min(
      this.state.lastStableMessageIndex,
      messages.length,
    );

    // Take messages up to the stable boundary
    const stableMessages = messages.slice(0, stableIndex);

    // Pending tool calls are dropped
    const droppedToolCallIds = [...this.state.pendingToolCallIds];

    // Executed tool calls are preserved
    const executedToolCallIds = [...this.state.executedToolCallIds];

    return {
      messages: stableMessages,
      droppedToolCallIds,
      executedToolCallIds,
    };
  }

  // ============== Reset ==============

  /**
   * Resets the tracker to initial state for a new conversation.
   */
  reset(): void {
    this.state = this.createInitialState();
    this.hasReceivedFirstDelta = false;
    this.currentToolInputId = undefined;
  }

  // ============== Private ==============

  private createInitialState(): ProviderExecutionState {
    return {
      requestId: nextRequestId(),
      provider: '',
      model: '',
      attempt: 1,
      lastStableMessageIndex: 0,
      executedToolCallIds: [],
      pendingToolCallIds: [],
      visibleLiveTextLength: 0,
      visibleThinkingLength: 0,
      fallbackUsed: false,
      startedAt: Date.now(),
    };
  }
}
