import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';
import { attachFailureResult, attachProviderFailure, readFailureResult, readProviderFailure } from '../execution-failure.js';
import type { KodaXExecutionFailure, KodaXResult } from '../types.js';
import { isHistoryRejected, recordRunError, recordRunResult } from './history-rejection.js';

const history: KodaXMessage[] = [
  { role: 'user', content: 'look at this' },
  { role: 'assistant', content: 'done' },
  { role: 'user', content: 'next' },
];

function failure(overrides: Partial<KodaXExecutionFailure> = {}): KodaXExecutionFailure {
  return { source: 'provider', message: 'Provider rejected the request (HTTP 400): invalid request', safeMessage: 'Provider rejected the request.',
    errorClass: 'non_retryable_provider_error', requestPhase: 'before_first_delta', provider: 'deepseek', model: 'deepseek-v4', httpStatus: 400,
    ...overrides };
}

function failed(value: KodaXExecutionFailure, messages: KodaXMessage[] = history): KodaXResult {
  return { success: false, lastText: '', messages, failure: value };
}

function thrown(value: KodaXExecutionFailure, messages: KodaXMessage[] = history): Error {
  const error = new Error(value.message);
  attachProviderFailure(error, value);
  attachFailureResult(error, failed(value, messages));
  return error;
}

const rejected = (result: KodaXResult): boolean => isHistoryRejected(result.failure);
const succeeded: KodaXResult = { success: true, lastText: 'ok', messages: history };

describe('history rejection', () => {
  it('marks the second identical rejection of a session with history', () => {
    const session = randomUUID();
    expect(rejected(recordRunResult(session, failed(failure())))).toBe(false);
    const second = recordRunResult(session, failed(failure()));
    expect(second.failure?.historyRejected).toBe(true);
    expect(isHistoryRejected(second.failure)).toBe(true);
    expect(recordRunResult(session, failed(failure())).failure?.historyRejected).toBe(true);
  });

  it('marks every carrier of a thrown repeat', () => {
    const session = randomUUID();
    const first = thrown(failure());
    recordRunError(session, first);
    expect(isHistoryRejected(first)).toBe(false);
    const second = thrown(failure());
    recordRunError(session, second);
    expect(isHistoryRejected(second)).toBe(true);
    expect(readProviderFailure(second)?.historyRejected).toBe(true);
    expect(readFailureResult(second)?.failure?.historyRejected).toBe(true);
    expect(readFailureResult(second)?.messages).toEqual(history);
  });

  it('starts over after a successful Run', () => {
    const session = randomUUID();
    recordRunResult(session, failed(failure()));
    expect(recordRunResult(session, succeeded)).toBe(succeeded);
    expect(rejected(recordRunResult(session, failed(failure())))).toBe(false);
  });

  it('keeps the streak across a failure that says nothing about the request', () => {
    const session = randomUUID();
    recordRunResult(session, failed(failure()));
    recordRunError(session, thrown(failure({ httpStatus: 503, errorClass: 'provider_overloaded' })));
    recordRunError(session, new Error('socket hang up'));
    expect(rejected(recordRunResult(session, failed(failure())))).toBe(true);
  });

  it.each([
    ['another model', failure({ model: 'deepseek-v4-pro' })],
    ['another provider', failure({ provider: 'kimi' })],
    ['another status', failure({ httpStatus: 422 })],
  ])('does not match a rejection from %s', (_label, next) => {
    const session = randomUUID();
    recordRunResult(session, failed(failure()));
    expect(rejected(recordRunResult(session, failed(next)))).toBe(false);
  });

  it.each([
    ['an account 400', failure({ message: 'Provider rejected the request (HTTP 400): Insufficient Balance' })],
    ['a 401', failure({ httpStatus: 401 })],
    ['a 404', failure({ httpStatus: 404 })],
    ['a 500', failure({ httpStatus: 500 })],
    ['a local failure', failure({ source: 'local', httpStatus: undefined })],
  ])('ignores %s, which recovering the session cannot fix', (_label, value) => {
    const session = randomUUID();
    recordRunResult(session, failed(value));
    expect(rejected(recordRunResult(session, failed(value)))).toBe(false);
  });

  it('does not blame a session that has no answered turn yet', () => {
    const session = randomUUID();
    const fresh: KodaXMessage[] = [{ role: 'user', content: 'hi' }, { role: 'user', content: 'hi again' }];
    recordRunResult(session, failed(failure(), fresh));
    expect(rejected(recordRunResult(session, failed(failure(), fresh)))).toBe(false);
  });

  it('tracks sessions separately and ignores Runs without a session', () => {
    const [left, right] = [randomUUID(), randomUUID()];
    recordRunResult(left, failed(failure()));
    expect(rejected(recordRunResult(right, failed(failure())))).toBe(false);
    recordRunResult(undefined, failed(failure()));
    expect(rejected(recordRunResult(undefined, failed(failure())))).toBe(false);
  });
});
