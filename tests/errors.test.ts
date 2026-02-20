/**
 * Tests for KodaX Error Classes
 */

import { describe, it, expect } from 'vitest';
import {
  KodaXError,
  KodaXProviderError,
  KodaXToolError,
  KodaXRateLimitError,
  KodaXSessionError,
  KodaXTerminalError,
} from '../src/core/errors.js';

describe('KodaXError', () => {
  it('should create base error with message', () => {
    const error = new KodaXError('Test error');
    expect(error.message).toBe('Test error');
    expect(error.name).toBe('KodaXError');
    expect(error.code).toBe('KODAX_ERROR');
  });

  it('should create error with custom code', () => {
    const error = new KodaXError('Test error', 'CUSTOM_CODE');
    expect(error.code).toBe('CUSTOM_CODE');
  });
});

describe('KodaXProviderError', () => {
  it('should create provider error', () => {
    const error = new KodaXProviderError('Provider failed', 'anthropic');
    expect(error.message).toBe('Provider failed');
    expect(error.name).toBe('KodaXProviderError');
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.provider).toBe('anthropic');
  });
});

describe('KodaXToolError', () => {
  it('should create tool error', () => {
    const error = new KodaXToolError('Tool failed', 'read', 'tool-123');
    expect(error.message).toBe('Tool failed');
    expect(error.name).toBe('KodaXToolError');
    expect(error.code).toBe('TOOL_ERROR');
    expect(error.toolName).toBe('read');
    expect(error.toolId).toBe('tool-123');
  });

  it('should create tool error without id', () => {
    const error = new KodaXToolError('Tool failed', 'write');
    expect(error.toolName).toBe('write');
    expect(error.toolId).toBeUndefined();
  });
});

describe('KodaXRateLimitError', () => {
  it('should create rate limit error', () => {
    const error = new KodaXRateLimitError('Rate limited', 60);
    expect(error.message).toBe('Rate limited');
    expect(error.name).toBe('KodaXRateLimitError');
    expect(error.code).toBe('RATE_LIMIT_ERROR');
    expect(error.retryAfter).toBe(60);
  });

  it('should create rate limit error without retryAfter', () => {
    const error = new KodaXRateLimitError('Rate limited');
    expect(error.retryAfter).toBeUndefined();
  });
});

describe('KodaXSessionError', () => {
  it('should create session error', () => {
    const error = new KodaXSessionError('Session failed', 'session-123');
    expect(error.message).toBe('Session failed');
    expect(error.name).toBe('KodaXSessionError');
    expect(error.code).toBe('SESSION_ERROR');
    expect(error.sessionId).toBe('session-123');
  });

  it('should create session error without id', () => {
    const error = new KodaXSessionError('Session failed');
    expect(error.sessionId).toBeUndefined();
  });
});

describe('KodaXTerminalError', () => {
  it('should create terminal error with suggestions', () => {
    const suggestions = [
      'kodax -p "your task"',
      'kodax -c',
    ];
    const error = new KodaXTerminalError('Terminal not supported', suggestions);
    expect(error.message).toBe('Terminal not supported');
    expect(error.name).toBe('KodaXTerminalError');
    expect(error.code).toBe('TERMINAL_ERROR');
    expect(error.suggestions).toEqual(suggestions);
  });

  it('should create terminal error without suggestions', () => {
    const error = new KodaXTerminalError('Terminal not supported');
    expect(error.suggestions).toEqual([]);
  });

  it('should be instance of KodaXError', () => {
    const error = new KodaXTerminalError('Terminal error');
    expect(error).toBeInstanceOf(KodaXError);
    expect(error).toBeInstanceOf(Error);
  });
});
