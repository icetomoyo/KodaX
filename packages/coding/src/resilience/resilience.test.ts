/**
 * Resilience Regression Test Suite (Feature 045)
 *
 * Tests the resilience module's core components:
 * config resolution, error classification, stable boundary tracking,
 * recovery coordinator, tool guard.
 */

import { describe, it, expect } from 'vitest';
import { KodaXProviderError } from '@kodax/ai';
import { resolveResilienceConfig, DEFAULT_RESILIENCE_CONFIG } from './config.js';
import { classifyResilienceError } from './classifier.js';
import { StableBoundaryTracker } from './stable-boundary.js';
import { ProviderRecoveryCoordinator } from './recovery-coordinator.js';
import { reconstructMessagesWithToolGuard } from './tool-guard.js';

// ============== Config Tests ==============

describe('resolveResilienceConfig', () => {
  it('returns defaults when no config provided', () => {
    const config = resolveResilienceConfig('anthropic');
    expect(config.requestTimeoutMs).toBe(600_000);
    expect(config.streamIdleTimeoutMs).toBe(60_000);
    expect(config.maxRetries).toBe(3);
    expect(config.maxRetryDelayMs).toBe(60_000);
    expect(config.enableNonStreamingFallback).toBe(true);
  });

  it('merges global config overrides', () => {
    const config = resolveResilienceConfig('anthropic', {
      requestTimeoutMs: 120_000,
    });
    expect(config.requestTimeoutMs).toBe(120_000);
    expect(config.streamIdleTimeoutMs).toBe(60_000);
  });

  it('applies per-provider policy override', () => {
    const config = resolveResilienceConfig('anthropic', undefined, [
      { provider: 'anthropic', requestTimeoutMs: 300_000 },
    ]);
    expect(config.requestTimeoutMs).toBe(300_000);
  });

  it('unaffected provider keeps defaults', () => {
    const config = resolveResilienceConfig('openai', undefined, [
      { provider: 'anthropic', maxRetries: 5 },
    ]);
    expect(config.maxRetries).toBe(3);
  });
});

// ============== Classifier Tests ==============

describe('classifyResilienceError', () => {
  it('classifies AbortError as user_abort', () => {
    const error = new DOMException('The user aborted a request', 'AbortError');
    const result = classifyResilienceError(error);
    expect(result.errorClass).toBe('user_abort');
    expect(result.retryable).toBe(false);
  });

  it('classifies rate limit from message pattern', () => {
    const error = new Error('Rate limit exceeded: too many requests (429)');
    const result = classifyResilienceError(error);
    expect(result.errorClass).toBe('rate_limit');
    expect(result.retryable).toBe(true);
  });

  it('classifies connection failure from message pattern', () => {
    const error = new Error('socket hang up');
    const result = classifyResilienceError(error);
    expect(result.errorClass).toBe('connection_failure');
    expect(result.retryable).toBe(true);
  });

  it('classifies stream incomplete with stage context', () => {
    const error = new Error('Stream incomplete');
    error.name = 'StreamIncompleteError';
    const result = classifyResilienceError(error, 'mid_stream_text');
    expect(result.errorClass).toBe('incomplete_stream');
    expect(result.failureStage).toBe('mid_stream_text');
  });

  it('classifies stream idle timeout with explicit pattern', () => {
    const error = new Error('idle timeout: no data received for 60 seconds');
    const result = classifyResilienceError(error);
    expect(result.errorClass).toBe('stream_idle_timeout');
    expect(result.retryable).toBe(true);
  });

  it('classifies hard timeout', () => {
    const error = new Error('API Hard Timeout (10 minutes)');
    const result = classifyResilienceError(error);
    expect(result.errorClass).toBe('request_timeout');
    expect(result.retryable).toBe(true);
  });

  it('defaults to non_retryable for unknown errors', () => {
    const error = new Error('Something completely unexpected');
    const result = classifyResilienceError(error);
    expect(result.errorClass).toBe('non_retryable_provider_error');
    expect(result.retryable).toBe(false);
  });

  it('infers mid_stream_tool_input from tool message', () => {
    const error = new Error('Stream incomplete');
    error.name = 'StreamIncompleteError';
    const result = classifyResilienceError(error, 'mid_stream_tool_input');
    expect(result.failureStage).toBe('mid_stream_tool_input');
  });

  // Chinese provider error patterns (中文 provider 错误消息)
  it('classifies Chinese network error as connection_failure', () => {
    const error = new Error('zhipu-coding API error: 网络错误，错误id：abc123');
    const result = classifyResilienceError(error);
    expect(result.errorClass).toBe('connection_failure');
    expect(result.retryable).toBe(true);
  });

  it('classifies Chinese timeout error as request_timeout', () => {
    const error = new Error('zhipu API error: 请求超时');
    const result = classifyResilienceError(error);
    expect(result.errorClass).toBe('request_timeout');
    expect(result.retryable).toBe(true);
  });

  it('classifies Chinese service busy as provider_overloaded', () => {
    const error = new KodaXProviderError('deepseek API error: 服务繁忙，请稍后重试', 'deepseek');
    const result = classifyResilienceError(error);
    expect(result.errorClass).toBe('provider_overloaded');
    expect(result.retryable).toBe(true);
  });

  it('classifies Chinese rate limit as rate_limit', () => {
    const error = new Error('zhipu API error: 请求过多，请稍后再试');
    const result = classifyResilienceError(error);
    expect(result.errorClass).toBe('rate_limit');
    expect(result.retryable).toBe(true);
  });
});

// ============== Stable Boundary Tracker Tests ==============

describe('StableBoundaryTracker', () => {
  it('starts with initial state', () => {
    const tracker = new StableBoundaryTracker();
    const snap = tracker.snapshot();
    expect(snap.lastStableMessageIndex).toBe(0);
    expect(snap.executedToolCallIds).toEqual([]);
    expect(snap.pendingToolCallIds).toEqual([]);
  });

  it('sets lastStableMessageIndex on beginRequest', () => {
    const tracker = new StableBoundaryTracker();
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
    ];
    tracker.beginRequest('anthropic', 'claude-3', messages);
    const snap = tracker.snapshot();
    expect(snap.lastStableMessageIndex).toBe(2);
    expect(snap.provider).toBe('anthropic');
  });

  it('tracks text delta length', () => {
    const tracker = new StableBoundaryTracker();
    tracker.beginRequest('anthropic', 'claude-3', []);
    tracker.markTextDelta('Hello ');
    tracker.markTextDelta('World');
    const snap = tracker.snapshot();
    expect(snap.visibleLiveTextLength).toBe(11);
    expect(snap.failureStage).toBeUndefined();
  });

  it('tracks tool input as pending', () => {
    const tracker = new StableBoundaryTracker();
    tracker.beginRequest('anthropic', 'claude-3', []);
    tracker.markToolInputStart('tool_1');
    const snap = tracker.snapshot();
    expect(snap.pendingToolCallIds).toEqual(['tool_1']);
  });

  it('moves tool from pending to executed', () => {
    const tracker = new StableBoundaryTracker();
    tracker.beginRequest('anthropic', 'claude-3', []);
    tracker.markToolInputStart('tool_1');
    tracker.markToolExecuted('tool_1');
    const snap = tracker.snapshot();
    expect(snap.pendingToolCallIds).toEqual([]);
    expect(snap.executedToolCallIds).toEqual(['tool_1']);
  });

  it('recovers to stable boundary dropping pending tools', () => {
    const tracker = new StableBoundaryTracker();
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
    ];
    tracker.beginRequest('anthropic', 'claude-3', messages);
    tracker.markToolInputStart('tool_1');
    tracker.markTextDelta('some live text');

    const recovery = tracker.recoverToStableBoundary([
      ...messages,
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'tool_1', name: 'read', input: {} }] },
    ]);
    expect(recovery.messages.length).toBe(2);
    expect(recovery.droppedToolCallIds).toEqual(['tool_1']);
  });

  it('infers failure stage before first delta', () => {
    const tracker = new StableBoundaryTracker();
    tracker.beginRequest('anthropic', 'claude-3', []);
    expect(tracker.inferFailureStage()).toBe('before_first_delta');
  });

  it('infers failure stage mid_stream_text after delta', () => {
    const tracker = new StableBoundaryTracker();
    tracker.beginRequest('anthropic', 'claude-3', []);
    tracker.markTextDelta('hello');
    expect(tracker.inferFailureStage()).toBe('mid_stream_text');
  });

  it('infers failure stage mid_stream_tool_input', () => {
    const tracker = new StableBoundaryTracker();
    tracker.beginRequest('anthropic', 'claude-3', []);
    tracker.markToolInputStart('tool_1');
    expect(tracker.inferFailureStage()).toBe('mid_stream_tool_input');
  });
});

// ============== Recovery Coordinator Tests ==============

describe('ProviderRecoveryCoordinator', () => {
  it('selects manual_continue for non-retryable errors', () => {
    const tracker = new StableBoundaryTracker();
    const coordinator = new ProviderRecoveryCoordinator(tracker, {});
    const error = new DOMException('aborted', 'AbortError');
    const classified = classifyResilienceError(error);
    const decision = coordinator.decideRecoveryAction(error, classified, 1);
    expect(decision.action).toBe('manual_continue');
    expect(decision.ladderStep).toBe(4);
  });

  it('selects fresh_connection_retry for pre-delta failures', () => {
    const tracker = new StableBoundaryTracker();
    const coordinator = new ProviderRecoveryCoordinator(tracker, {});
    const error = new Error('socket hang up');
    const classified = classifyResilienceError(error, 'before_first_delta');
    const decision = coordinator.decideRecoveryAction(error, classified, 1);
    expect(decision.action).toBe('fresh_connection_retry');
    expect(decision.ladderStep).toBe(1);
  });

  it('selects stable_boundary_retry for mid-stream failures', () => {
    const tracker = new StableBoundaryTracker();
    const coordinator = new ProviderRecoveryCoordinator(tracker, {});
    const error = new Error('Stream incomplete');
    error.name = 'StreamIncompleteError';
    const classified = classifyResilienceError(error, 'mid_stream_text');
    const decision = coordinator.decideRecoveryAction(error, classified, 1);
    expect(decision.action).toBe('stable_boundary_retry');
    expect(decision.ladderStep).toBe(2);
  });

  it('selects manual_continue when retries exhausted', () => {
    const tracker = new StableBoundaryTracker();
    const coordinator = new ProviderRecoveryCoordinator(tracker, { maxRetries: 2 });
    const error = new Error('socket hang up');
    const classified = classifyResilienceError(error);
    const decision = coordinator.decideRecoveryAction(error, classified, 2);
    expect(decision.action).toBe('manual_continue');
    expect(decision.ladderStep).toBe(4);
  });

  it('fresh_connection_retry preserves messages', () => {
    const tracker = new StableBoundaryTracker();
    tracker.beginRequest('anthropic', 'claude-3', []);
    const coordinator = new ProviderRecoveryCoordinator(tracker, {});
    const messages = [
      { role: 'user' as const, content: 'hello' },
    ];
    const result = coordinator.executeRecovery(messages, {
      action: 'fresh_connection_retry',
      ladderStep: 1,
      delayMs: 1000,
      maxDelayMs: 60_000,
      shouldUseNonStreaming: false,
      reasonCode: 'connection_failure',
      failureStage: 'before_first_delta',
    });
    expect(result.messages.length).toBe(1);
    expect(result.fallbackUsed).toBe(false);
  });
});

// ============== Tool Guard Tests ==============

describe('reconstructMessagesWithToolGuard', () => {
  it('returns empty for empty messages', () => {
    const result = reconstructMessagesWithToolGuard([], [], []);
    expect(result).toEqual([]);
  });

  it('preserves messages with no tool calls', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
    ];
    const result = reconstructMessagesWithToolGuard(messages, [], []);
    expect(result.length).toBe(2);
  });

  it('filters out dropped tool calls', () => {
    const messages = [
      { role: 'user' as const, content: 'do something' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool_use' as const, id: 'tool_1', name: 'read', input: {} },
          { type: 'tool_use' as const, id: 'tool_2', name: 'write', input: {} },
        ],
      },
    ];
    const result = reconstructMessagesWithToolGuard(messages, [], ['tool_1']);
    const assistant = result[1] as { content: Array<{ type: string; id?: string }> };
    const toolIds = assistant.content.filter(b => b.type === 'tool_use').map(b => (b as { id: string }).id);
    expect(toolIds).toEqual(['tool_2']);
  });

  it('preserves executed tool results', () => {
    const messages = [
      { role: 'user' as const, content: 'read file' },
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use' as const, id: 'tool_1', name: 'read', input: { path: '/foo' } }],
      },
      {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: 'tool_1', content: 'file contents' }],
      },
    ];
    const result = reconstructMessagesWithToolGuard(messages, ['tool_1'], []);
    expect(result.length).toBe(3);
  });
});
