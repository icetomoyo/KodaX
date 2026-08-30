import { describe, expect, it } from 'vitest';

import { parseRuntimeEvent } from './runtime-event.js';

function event(type: string, payload: unknown): Record<string, unknown> {
  return {
    id: 'evt-1',
    seq: 1,
    cursor: { sessionId: 'session-1', journalEpoch: 'epoch-1', seq: 1 },
    time: '2026-07-14T00:00:00.000Z',
    sessionId: 'session-1',
    runId: 'run-1',
    type,
    payload,
  };
}

describe('parseRuntimeEvent', () => {
  it('requires a complete Session journal cursor', () => {
    const withoutCursor = event(
      'session.loaded',
      { id: 'session-1', title: 'Coder session' },
    );
    delete withoutCursor.cursor;
    expect(parseRuntimeEvent(withoutCursor).ok).toBe(false);
    expect(parseRuntimeEvent({
      ...withoutCursor,
      cursor: { sessionId: 'session-1', journalEpoch: '', seq: 1 },
    }).ok).toBe(false);
  });

  it('rejects a cursor that does not identify the event Session and sequence', () => {
    expect(parseRuntimeEvent({
      ...event('session.loaded', { id: 'session-1', title: 'Coder session' }),
      cursor: { sessionId: 'another-session', journalEpoch: 'epoch-1', seq: 1 },
    }).ok).toBe(false);
    expect(parseRuntimeEvent({
      ...event('session.loaded', { id: 'session-1', title: 'Coder session' }),
      cursor: { sessionId: 'session-1', journalEpoch: 'epoch-1', seq: 2 },
    }).ok).toBe(false);
  });

  it('accepts both explicit and provider-backed session.loaded payloads', () => {
    expect(parseRuntimeEvent(event('session.loaded', {
      id: 'session-1',
      title: 'Coder session',
    })).ok).toBe(true);
    expect(parseRuntimeEvent(event('session.loaded', {
      provider: 'anthropic',
      sessionId: 'provider-session-1',
    })).ok).toBe(true);
  });

  it('rejects malformed known payloads without throwing', () => {
    expect(parseRuntimeEvent(event('session.loaded', { sessionId: 'missing-provider' })))
      .toEqual({
        ok: false,
        error: 'session.loaded requires a RuntimeSession or provider session payload.',
      });
  });

  it('accepts only canonical sandbox observation unions', () => {
    const payload = {
      update: {
        id: 'bash-1',
        observation: {
          version: 1,
          state: 'applied',
          backend: 'windows-restricted-user',
          policyId: 'kodax-workspace-shell-v1',
        },
      },
    };
    expect(parseRuntimeEvent(event('tool.sandbox', payload)).ok).toBe(true);
    expect(parseRuntimeEvent(event('tool.sandbox', {
      update: {
        ...payload.update,
        observation: { ...payload.update.observation, backend: 'raw-process' },
      },
    })).ok).toBe(false);
    expect(parseRuntimeEvent(event('tool.sandbox', {
      update: {
        id: 'bash-1',
        observation: {
          version: 1,
          state: 'fallback',
          reason: 'unknown_failure',
          execution: 'normal_permission_policy',
        },
      },
    })).ok).toBe(false);
  });

  it('accepts the emitted session settings CAS payload', () => {
    expect(parseRuntimeEvent(event('session.settings.updated', {
      sessionId: 'session-1',
      revision: 2,
      settings: { agentMode: 'ama', permissionMode: 'auto' },
      patch: { agentMode: 'ama', permissionMode: 'auto' },
    })).ok).toBe(true);
  });

  it('accepts shared and embedded user input request payloads', () => {
    expect(parseRuntimeEvent(event('user_input.requested', {
      id: 'request-1',
      revision: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      kind: 'askUser',
      options: { question: 'Continue?' },
      createdAt: '2026-07-14T00:00:00.000Z',
      expiresAt: '2026-07-14T00:05:00.000Z',
    })).ok).toBe(true);
    expect(parseRuntimeEvent(event('user_input.requested', {
      requestId: 'request-2',
      kind: 'askUserMulti',
      options: { questions: [] },
    })).ok).toBe(true);
  });

  it('accepts queued and ordered-batch interrupt input events', () => {
    expect(parseRuntimeEvent(event('run.input.queued', {
      input: {
        inputId: 'input-1',
        afterRunId: 'run-1',
        delivery: 'interrupt',
        state: 'queued',
        contentPreview: 'first',
        queuedAt: '2026-07-14T00:00:01.000Z',
      },
    })).ok).toBe(true);
    expect(parseRuntimeEvent(event('run.input.delivered', {
      inputs: [
        {
          inputId: 'input-1',
          afterRunId: 'run-1',
          input: { type: 'text', text: 'first' },
          queuedAt: '2026-07-14T00:00:01.000Z',
          deliveredAt: '2026-07-14T00:00:03.000Z',
        },
        {
          inputId: 'input-2',
          afterRunId: 'run-1',
          input: { type: 'text', text: 'second' },
          queuedAt: '2026-07-14T00:00:02.000Z',
          deliveredAt: '2026-07-14T00:00:03.000Z',
          entryId: 'entry_interrupt_2',
        },
      ],
    })).ok).toBe(true);
  });

  it('rejects a malformed interrupt delivery batch', () => {
    expect(parseRuntimeEvent(event('run.input.delivered', {
      inputs: [{ inputId: 'input-1', input: { type: 'text' } }],
    }))).toEqual({
      ok: false,
      error: 'run.input.delivered requires an ordered interrupt input batch.',
    });
  });

  it('rejects a present invalid interrupt entry reference while allowing legacy absence', () => {
    expect(parseRuntimeEvent(event('run.input.delivered', {
      inputs: [{
        inputId: 'input-1',
        afterRunId: 'run-1',
        input: { type: 'text', text: 'first' },
        queuedAt: '2026-07-14T00:00:01.000Z',
        deliveredAt: '2026-07-14T00:00:03.000Z',
        entryId: 1,
      }],
    })).ok).toBe(false);
    expect(parseRuntimeEvent(event('run.input.delivered', {
      inputs: [{
        inputId: 'input-1',
        afterRunId: 'run-1',
        input: { type: 'text', text: 'first' },
        queuedAt: '2026-07-14T00:00:01.000Z',
        deliveredAt: '2026-07-14T00:00:03.000Z',
        entryId: '',
      }],
    })).ok).toBe(false);
  });

  it('accepts only complete canonical compaction facts', () => {
    const payload = {
      contextId: 'session-1',
      contextKind: 'root',
      contextRevision: 3,
      beforeRevision: 2,
      afterRevision: 3,
      source: 'automatic_threshold',
      tokensBefore: 322_973,
      tokensAfter: 92_000,
      committed: true,
      elapsedMs: 250,
    };
    expect(parseRuntimeEvent(event('context.compaction.finished', payload)).ok).toBe(true);
    expect(parseRuntimeEvent(event('context.compaction.finished', {
      ...payload,
      tokensAfter: undefined,
    }))).toEqual({
      ok: false,
      error: 'context.compaction.finished requires a canonical compaction payload.',
    });
  });

  it('accepts structured compaction skips and rejects unknown reasons', () => {
    const payload = {
      reason: 'compactable_below_threshold',
      currentTokens: 280_000,
      compactableTokens: 255_999,
      contextWindow: 400_000,
      triggerPercent: 90,
      effectiveTriggerTokens: 256_000,
      cooldownTurnsRemaining: 0,
      lowSavingsStreak: 0,
      consecutiveFailures: 0,
      circuitBreakerLimit: 3,
      circuitBreakerState: 'closed',
    };

    expect(parseRuntimeEvent(event('context.compaction.skipped', payload)).ok).toBe(true);
    expect(parseRuntimeEvent(event('context.compaction.skipped', {
      ...payload,
      reason: 'silent_noop',
    })).ok).toBe(false);
    expect(parseRuntimeEvent(event('context.compaction.skipped', {
      ...payload,
      consecutiveFailures: 'three',
    })).ok).toBe(false);
  });

  it('accepts legacy ended events and validates new failure outcomes', () => {
    expect(parseRuntimeEvent(event('context.compaction.ended', { meta: {} })).ok).toBe(true);
    expect(parseRuntimeEvent(event('context.compaction.ended', {
      reason: 'summary_generation_failed',
      consecutiveFailures: 3,
    })).ok).toBe(false);
    const failed = {
      outcome: 'failed',
      reason: 'summary_generation_failed',
      failurePhase: 'summary_generation',
      currentTokens: 300_000,
      compactableTokens: 280_000,
      consecutiveFailures: 3,
      circuitBreakerLimit: 3,
      circuitBreakerState: 'open',
      cooldownTurnsRemaining: 2,
    };
    expect(parseRuntimeEvent(event('context.compaction.ended', failed)).ok).toBe(true);
    expect(parseRuntimeEvent(event('context.compaction.ended', {
      ...failed,
      reason: 'unknown_failure',
    }))).toEqual({
      ok: false,
      error: 'context.compaction.ended requires a structured compaction outcome.',
    });
    expect(parseRuntimeEvent(event('context.compaction.ended', {
      ...failed,
      failurePhase: 'persistence',
    })).ok).toBe(false);
    expect(parseRuntimeEvent(event('context.compaction.ended', {
      ...failed,
      outcome: 'compacted',
    })).ok).toBe(false);
  });
});
