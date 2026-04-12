import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeHook } from './executor.js';
import type { HookEventContext, CommandHook, HttpHook, PromptHook } from './types.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

describe('executeHook', () => {
  const baseContext: HookEventContext = {
    eventType: 'PreToolUse',
    toolName: 'test-tool',
    sessionId: 'session-123',
    workingDir: '/test',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('http hooks', () => {
    it('returns allow on 200 response', async () => {
      const hook: HttpHook = {
        type: 'http',
        url: 'http://example.com/webhook',
        method: 'POST',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await executeHook(hook, baseContext);

      expect(result.action).toBe('allow');
    });

    it('returns pass on non-200 response', async () => {
      const hook: HttpHook = {
        type: 'http',
        url: 'http://example.com/webhook',
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
      });

      const result = await executeHook(hook, baseContext);

      expect(result.action).toBe('pass');
      expect(result.reason).toContain('403');
    });

    it('returns pass on network error', async () => {
      const hook: HttpHook = {
        type: 'http',
        url: 'http://example.com/webhook',
      };

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await executeHook(hook, baseContext);

      expect(result.action).toBe('pass');
      expect(result.reason).toContain('Network error');
    });

    it('sends custom headers', async () => {
      const hook: HttpHook = {
        type: 'http',
        url: 'http://example.com/webhook',
        headers: { 'X-Custom': 'value', Authorization: 'Bearer token' },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await executeHook(hook, baseContext);

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers['X-Custom']).toBe('value');
      expect(headers['Authorization']).toBe('Bearer token');
    });

    it('uses custom body when provided', async () => {
      const hook: HttpHook = {
        type: 'http',
        url: 'http://example.com/webhook',
        body: '{"custom": "payload"}',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await executeHook(hook, baseContext);

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(options.body).toBe('{"custom": "payload"}');
    });

    it('sends default body with event context', async () => {
      const hook: HttpHook = {
        type: 'http',
        url: 'http://example.com/webhook',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await executeHook(hook, baseContext);

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.event).toBe('PreToolUse');
      expect(body.toolName).toBe('test-tool');
      expect(body.sessionId).toBe('session-123');
      expect(body.timestamp).toBeDefined();
    });

    it('interpolates variables in URL', async () => {
      const hook: HttpHook = {
        type: 'http',
        url: 'http://example.com/webhook?session=$SESSION_ID',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await executeHook(hook, baseContext);

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain('session=session-123');
    });

    it('interpolates variables in body', async () => {
      const hook: HttpHook = {
        type: 'http',
        url: 'http://example.com/webhook',
        body: '{"tool": "$TOOL_NAME"}',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await executeHook(hook, baseContext);

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.tool).toBe('test-tool');
    });
  });

  describe('prompt hooks', () => {
    it('returns pass for prompt hooks (deferred implementation)', async () => {
      const hook: PromptHook = {
        type: 'prompt',
        prompt: 'Is this allowed?',
        model: 'claude-opus',
      };

      const result = await executeHook(hook, baseContext);

      expect(result.action).toBe('pass');
      expect(result.reason).toContain('deferred');
    });
  });

  describe('error handling', () => {
    it('returns pass when hook definition type is unknown', async () => {
      const hook = { type: 'unknown' } as any;

      const result = await executeHook(hook, baseContext);

      expect(result.action).toBe('pass');
      expect(result.reason).toContain('Unknown hook type');
    });

    it('fails open on unexpected errors in http hooks', async () => {
      const hook: HttpHook = {
        type: 'http',
        url: 'http://example.com/webhook',
      };

      mockFetch.mockRejectedValueOnce(new Error('Unexpected error'));

      const result = await executeHook(hook, baseContext);

      expect(result.action).toBe('pass');
      // HTTP hook errors contain "HTTP hook failed:" prefix
      expect(result.reason).toContain('Unexpected error');
    });
  });

  describe('timeout handling', () => {
    it('respects custom timeout for http hooks', async () => {
      const hook: HttpHook = {
        type: 'http',
        url: 'http://example.com/webhook',
        timeout: 5000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await executeHook(hook, baseContext);

      expect(mockFetch).toHaveBeenCalled();
    });
  });
});
