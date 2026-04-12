import { describe, expect, it, vi } from 'vitest';
import type { ElicitationRequest } from './elicitation.js';
import {
  formatElicitationPrompt,
  handleElicitation,
} from './elicitation.js';

describe('Elicitation', () => {
  describe('handleElicitation', () => {
    it('returns user response', async () => {
      const request: ElicitationRequest = {
        message: 'Enter your name:',
        requestId: 'req-123',
      };

      const askUser = vi.fn(async () => 'John Doe');

      const response = await handleElicitation(request, askUser);

      expect(response.requestId).toBe('req-123');
      expect(response.response).toBe('John Doe');
      expect(response.cancelled).toBeUndefined();
      expect(askUser).toHaveBeenCalledWith('Enter your name:');
    });

    it('returns cancelled when user cancels', async () => {
      const request: ElicitationRequest = {
        message: 'Enter your name:',
        requestId: 'req-123',
      };

      const askUser = vi.fn(async () => null);

      const response = await handleElicitation(request, askUser);

      expect(response.requestId).toBe('req-123');
      expect(response.response).toBe('');
      expect(response.cancelled).toBe(true);
    });

    it('includes schema in prompt when provided', async () => {
      const request: ElicitationRequest = {
        message: 'Enter your details:',
        requestId: 'req-123',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
          },
        },
      };

      const askUser = vi.fn(async () => 'response');

      await handleElicitation(request, askUser);

      const calls = askUser.mock.calls as unknown[][];
      const call = calls[0]?.[0] as string;
      expect(call).toContain('Enter your details:');
      expect(call).toContain('Expected format:');
      expect(call).toContain('name');
      expect(call).toContain('age');
    });

    it('does not include schema in prompt when not provided', async () => {
      const request: ElicitationRequest = {
        message: 'Enter your name:',
        requestId: 'req-123',
      };

      const askUser = vi.fn(async () => 'response');

      await handleElicitation(request, askUser);

      const calls = askUser.mock.calls as unknown[][];
      const call = calls[0]?.[0] as string;
      expect(call).toBe('Enter your name:');
      expect(call).not.toContain('Expected format:');
    });
  });

  describe('formatElicitationPrompt', () => {
    it('formats with message only', () => {
      const request: ElicitationRequest = {
        message: 'What is your name?',
        requestId: 'req-123',
      };

      const formatted = formatElicitationPrompt(request);

      expect(formatted).toContain('[MCP Server Request] What is your name?');
      expect(formatted).not.toContain('Expected format:');
    });

    it('formats with message and schema', () => {
      const request: ElicitationRequest = {
        message: 'Enter JSON data:',
        requestId: 'req-123',
        schema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
          },
        },
      };

      const formatted = formatElicitationPrompt(request);

      expect(formatted).toContain('[MCP Server Request] Enter JSON data:');
      expect(formatted).toContain('Expected format:');
      expect(formatted).toContain('key');
    });

    it('formats schema with proper indentation', () => {
      const request: ElicitationRequest = {
        message: 'Enter data:',
        requestId: 'req-123',
        schema: {
          type: 'object',
          properties: {
            nested: {
              type: 'object',
              properties: {
                value: { type: 'string' },
              },
            },
          },
        },
      };

      const formatted = formatElicitationPrompt(request);

      expect(formatted).toContain('"type": "object"');
      expect(formatted).toContain('"nested"');
    });
  });
});
