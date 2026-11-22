import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '@kodax-ai/agent';
import { describe, expect, it } from 'vitest';

import { reportHostSecurityEvent } from './security-log.js';

describe('reportHostSecurityEvent', () => {
  it('sends each event as a host.security diagnostic named by the event, a refused credential as a warning', () => {
    const seen: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink(diagnostic => seen.push(diagnostic));
    try {
      reportHostSecurityEvent({ event: 'device_revoked', device: 'dev_1', name: 'Phone' });
      reportHostSecurityEvent({ event: 'auth_failed', reason: 'invalid_credential', origin: 'https://app.example.test' });
    } finally {
      restore();
    }
    expect(seen).toEqual([
      { source: 'host.security', level: 'info', message: 'device_revoked', detail: { event: 'device_revoked', device: 'dev_1', name: 'Phone' } },
      {
        source: 'host.security', level: 'warn', message: 'auth_failed',
        detail: { event: 'auth_failed', reason: 'invalid_credential', origin: 'https://app.example.test' },
      },
    ]);
  });
});
