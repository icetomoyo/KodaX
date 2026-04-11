import { describe, expect, it } from 'vitest';
import { KodaXProviderError } from '@kodax/ai';
import { classifyError, ErrorCategory } from './error-classification.js';

describe('classifyError', () => {
  it('treats provider connection errors as transient', () => {
    const error = new KodaXProviderError(
      'minimax-coding API error: Connection error.',
      'minimax-coding',
    );

    expect(classifyError(error)).toMatchObject({
      category: ErrorCategory.TRANSIENT,
      retryable: true,
      maxRetries: 3,
      shouldCleanup: true,
    });
  });

  it('treats provider fetch failures as transient', () => {
    const error = new KodaXProviderError(
      'openai API error: fetch failed',
      'openai',
    );

    expect(classifyError(error)).toMatchObject({
      category: ErrorCategory.TRANSIENT,
      retryable: true,
      maxRetries: 3,
      shouldCleanup: true,
    });
  });

  it('treats provider timed out wording as transient', () => {
    const error = new KodaXProviderError(
      'newapi-anthropic API error: Request timed out.',
      'newapi-anthropic',
    );

    expect(classifyError(error)).toMatchObject({
      category: ErrorCategory.TRANSIENT,
      retryable: true,
      maxRetries: 3,
      shouldCleanup: true,
    });
  });

  it('treats stalled generic errors as transient', () => {
    const error = new Error('Stream stalled or delayed response (60s idle)');

    expect(classifyError(error)).toMatchObject({
      category: ErrorCategory.TRANSIENT,
      retryable: true,
      maxRetries: 2,
      shouldCleanup: true,
    });
  });

  it('treats Chinese network error from provider as transient', () => {
    const error = new KodaXProviderError(
      'zhipu-coding API error: {"type":"error","error":{"message":"网络错误，错误id：202604111352273367dc705f3c4786，请联系客服。","code":"1234"}}',
      'zhipu-coding',
    );

    expect(classifyError(error)).toMatchObject({
      category: ErrorCategory.TRANSIENT,
      retryable: true,
      maxRetries: 3,
      shouldCleanup: true,
    });
  });

  it('treats Chinese timeout error from provider as transient', () => {
    const error = new KodaXProviderError(
      'zhipu API error: 请求超时',
      'zhipu',
    );

    expect(classifyError(error)).toMatchObject({
      category: ErrorCategory.TRANSIENT,
      retryable: true,
      maxRetries: 3,
      shouldCleanup: true,
    });
  });

  it('treats Chinese service busy error from provider as transient', () => {
    const error = new KodaXProviderError(
      'deepseek API error: 服务繁忙，请稍后重试',
      'deepseek',
    );

    expect(classifyError(error)).toMatchObject({
      category: ErrorCategory.TRANSIENT,
      retryable: true,
      maxRetries: 3,
      shouldCleanup: true,
    });
  });
});
