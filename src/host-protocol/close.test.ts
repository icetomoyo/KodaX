import { describe, expect, it } from 'vitest';

import { HOST_CLOSE_CODES, hostLinkEnd } from './close.js';

describe('what a client does after the Host closed its link', () => {
  it.each([
    ['protocol', 'stop', 'invalid_state'],
    ['credential', 'reconnect', 'unauthorized'],
    ['revoked', 'stop', 'unauthorized'],
    ['idle', 'reconnect', 'timeout'],
    ['replaced', 'stop', 'conflict'],
    ['overloaded', 'back_off', 'overloaded'],
    ['unavailable', 'back_off', 'unavailable'],
  ] as const)('%s asks it to %s, as %s', (reason, action, kodaxCode) => {
    const end = hostLinkEnd({ code: HOST_CLOSE_CODES[reason], reason });
    expect(end.action).toBe(action);
    expect(end.error).toMatchObject({ kodaxCode, reason, retryable: action !== 'stop' });
  });

  it('keeps the reason the Host gave over the name of the code', () => {
    const end = hostLinkEnd({ code: HOST_CLOSE_CODES.revoked, reason: 'origin_not_allowed' });
    expect(end.error).toMatchObject({ kodaxCode: 'unauthorized', reason: 'origin_not_allowed' });
  });

  it('reconnects after any other close, as after a lost connection', () => {
    for (const code of [1000, 1001, 1006, 4999]) {
      const end = hostLinkEnd({ code, reason: '' });
      expect(end.action).toBe('reconnect');
      expect(end.error).toMatchObject({ kodaxCode: 'unavailable', reason: 'connection_closed', retryable: true });
    }
  });
});
