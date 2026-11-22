/**
 * Which Sessions are quarantined while their Actor tree heals, and since when.
 *
 * The Actor controller of a Session reports its health. `unknown` means a
 * settlement could not be confirmed as saved: the Session refuses new Runs and
 * the Runtime repairs it in the background. Once the repair has run past the
 * stall limit it still retries and still lifts the quarantine when it succeeds;
 * only the reported state changes, so a client can tell a Session that is
 * healing from one that needs a person.
 */
import type { AgentControllerHealth } from '@kodax-ai/agent';
import type { ClientSessionRecovery } from '@kodax-ai/coding/client-contract';

/** How long, from entering quarantine, a repair counts as in progress before it counts as stuck. */
export const SESSION_RECOVERY_STALL_MS = 10 * 60_000;

interface Quarantine {
  readonly since: number;
  readonly code: ClientSessionRecovery['code'];
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface SessionRecoveryTracker {
  /** Takes each health change the Actor controller of a Session reports. */
  observe(sessionId: string, health: AgentControllerHealth): void;
  /** Present only while the Session is quarantined. */
  get(sessionId: string): ClientSessionRecovery | undefined;
  /** The Session as read, carrying its current recovery and none left over from an earlier read. */
  attach<Session extends { readonly id: string; readonly recovery?: ClientSessionRecovery }>(session: Session): Session;
  close(): void;
}

/** `changed` hears of every Session entering quarantine, turning stalled, and leaving quarantine. */
export function createSessionRecoveryTracker(changed: (sessionId: string) => void): SessionRecoveryTracker {
  const quarantined = new Map<string, Quarantine>();
  const get = (sessionId: string): ClientSessionRecovery | undefined => {
    const quarantine = quarantined.get(sessionId);
    if (quarantine === undefined) return undefined;
    // Read from the clock, not the timer, so a late timer never reports a stuck repair as in progress.
    const stalled = Date.now() - quarantine.since >= SESSION_RECOVERY_STALL_MS;
    return { state: stalled ? 'stalled' : 'recovering', since: new Date(quarantine.since).toISOString(), code: quarantine.code };
  };
  return {
    observe(sessionId, health) {
      const current = quarantined.get(sessionId);
      if (health.state === 'unknown') {
        if (current !== undefined) return;
        const timer = setTimeout(() => changed(sessionId), SESSION_RECOVERY_STALL_MS);
        timer.unref?.();
        quarantined.set(sessionId, { since: Date.now(), code: health.code ?? 'actor_settlement_not_persisted', timer });
        changed(sessionId);
        return;
      }
      // `recovering` is a save being retried inside a healthy tree, not a quarantine.
      if (current === undefined) return;
      clearTimeout(current.timer);
      quarantined.delete(sessionId);
      changed(sessionId);
    },
    get,
    attach(session) {
      const recovery = get(session.id);
      if (recovery !== undefined) return { ...session, recovery };
      if (session.recovery === undefined) return session;
      const { recovery: _stale, ...rest } = session;
      return rest as typeof session;
    },
    close() {
      for (const { timer } of quarantined.values()) clearTimeout(timer);
      quarantined.clear();
    },
  };
}
