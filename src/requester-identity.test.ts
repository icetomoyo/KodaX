import { describe, expect, it } from 'vitest';
import { sameRequester } from './requester-identity.js';

describe('sameRequester', () => {
  it('matches two client instances of the same person', () => {
    expect(sameRequester(
      { principalId: 'client_laptop', subject: 'person' },
      { principalId: 'client_phone', subject: 'person' },
    )).toBe(true);
  });

  it('keeps a service apart from the person and from another service', () => {
    expect(sameRequester(
      { principalId: 'client_a', subject: 'service:billing' },
      { principalId: 'client_a', subject: 'person' },
    )).toBe(false);
    expect(sameRequester(
      { principalId: 'client_a', subject: 'service:billing' },
      { principalId: 'client_b', subject: 'service:support' },
    )).toBe(false);
  });

  it('compares by client instance when either side was recorded before subjects existed', () => {
    expect(sameRequester({ principalId: 'client_a' }, { principalId: 'client_a', subject: 'person' })).toBe(true);
    expect(sameRequester({ principalId: 'client_a' }, { principalId: 'client_b', subject: 'person' })).toBe(false);
    expect(sameRequester({ principalId: 'client_a', subject: 'person' }, { principalId: 'client_a' })).toBe(true);
  });

  it('treats two embedded callers without any identity as the same caller', () => {
    expect(sameRequester(undefined, undefined)).toBe(true);
    expect(sameRequester({}, undefined)).toBe(true);
    expect(sameRequester(undefined, { principalId: 'client_a' })).toBe(false);
  });
});
