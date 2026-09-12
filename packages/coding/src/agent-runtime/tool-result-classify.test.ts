import { describe, expect, it } from 'vitest';
import {
  extractStructuredToolErrorCode,
  isCancelledToolResultContent,
  isToolResultErrorContent,
} from './tool-result-classify.js';

describe('structured Exec Policy tool results', () => {
  it.each(['exec_policy_forbidden', 'exec_policy_prompt_unavailable', 'exec_policy_invalid'])(
    'classifies %s as a policy failure rather than success or user cancellation', (code) => {
      const content = JSON.stringify({
        code, denialSource: 'explicit_rule', retryable: false,
        message: 'KodaX policy rejected execution', matchedRules: [],
      });
      expect(isToolResultErrorContent(content)).toBe(true);
      expect(extractStructuredToolErrorCode(content)).toBe(code);
      expect(isCancelledToolResultContent(content)).toBe(false);
    },
  );

  it.each(['{"code":"ok"}', '{malformed', 'ordinary output', '{"code":"exec_policy_forbidden"}'])(
    'does not turn ordinary output into a policy error: %s', (content) => {
      expect(isToolResultErrorContent(content)).toBe(false);
      expect(extractStructuredToolErrorCode(content)).toBeUndefined();
    },
  );

  it('retains legacy error and cancellation classification', () => {
    expect(isToolResultErrorContent('[Blocked] explicit deny')).toBe(true);
    expect(isCancelledToolResultContent('[Cancelled] user stopped')).toBe(true);
    expect(extractStructuredToolErrorCode('[Tool Error] bash: ACCESS_DENIED: denied'))
      .toBe('ACCESS_DENIED');
  });
});
