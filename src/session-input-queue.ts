import { createHash } from 'node:crypto';
import { MessageQueue } from '@kodax-ai/agent';
import { parseInlineSkillReferences } from '@kodax-ai/coding';
import type { ClientInputAcceptance, ClientQueuedInput, ClientSubmitInput } from '@kodax-ai/coding/client-contract';

interface QueuedInputFact {
  readonly sessionId: string;
  readonly inputId: string;
  readonly digest: string;
  readonly messageId?: string;
  /** Syntax-level only; trusted expansion happens at consumption (T37). */
  readonly skill: boolean;
  state: ClientInputAcceptance['state'];
  runId?: string;
}

/**
 * An explicit Skill invocation keeps its own batch unit so its raw text is
 * never merged into a plain-text batch. A leading slash covers the explicit
 * head form; inline /skill: references are explicit by syntax. Mid-text bare
 * slashes stay plain — the submitting UI classifies those against the
 * registry before they reach the Host queue.
 */
function isSkillInvocationText(text: string): boolean {
  return text.trimStart().startsWith('/') || parseInlineSkillReferences(text).length > 0;
}

export function inputIntentDigest(input: ClientSubmitInput): string {
  // targetRunId is appended only when present so targetless inputs keep the
  // digest formula that earlier Host builds persisted in Run statuses.
  return createHash('sha256').update(JSON.stringify([
    input.text, input.delivery ?? 'immediate',
    ...(input.targetRunId !== undefined ? [input.targetRunId] : []),
  ])).digest('hex');
}

/** Host admission bound; matches the REPL pending-input footer limit (packages/repl/src/ui/utils/pending-inputs.ts, a UI-internal constant not exported from that package). */
const MAX_QUEUED_INPUTS = 5;
const MAX_QUEUE_PREVIEW_CHARS = 72;

function queuePreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_QUEUE_PREVIEW_CHARS) return normalized;
  return `${normalized.slice(0, MAX_QUEUE_PREVIEW_CHARS - 3)}...`;
}

/** Existing MessageQueue holds pending bodies; consumed facts retain only identity. */
export class SessionInputQueue {
  private readonly queue = new MessageQueue();
  private readonly facts = new Map<string, QueuedInputFact>();

  constructor(private readonly changed: (sessionId: string) => void) {}

  private key(sessionId: string, inputId: string): string {
    return JSON.stringify([sessionId, inputId]);
  }

  read(sessionId: string, inputId: string): ClientInputAcceptance | undefined {
    const fact = this.facts.get(this.key(sessionId, inputId));
    if (!fact) return undefined;
    return { sessionId, inputId, state: fact.state, ...(fact.runId ? { runId: fact.runId } : {}) };
  }

  find(input: ClientSubmitInput): ClientInputAcceptance | undefined {
    const fact = this.facts.get(this.key(input.sessionId, input.inputId));
    if (!fact) return undefined;
    if (fact.digest !== inputIntentDigest(input)) throw conflict('Input ID already belongs to a different intent.');
    return this.read(input.sessionId, input.inputId);
  }

  enqueue(input: ClientSubmitInput): ClientInputAcceptance {
    const duplicate = this.find(input);
    if (duplicate) return duplicate;
    if (this.queue.count({ agentId: input.sessionId, mode: 'prompt', maxPriority: 'user' }) >= MAX_QUEUED_INPUTS) {
      throw conflict(`Queued follow-up limit reached (${MAX_QUEUED_INPUTS}). Wait or withdraw an input.`);
    }
    const messageId = this.queue.enqueue({
      agentId: input.sessionId, mode: 'prompt', priority: 'user', content: input.text,
    });
    this.facts.set(this.key(input.sessionId, input.inputId), {
      sessionId: input.sessionId, inputId: input.inputId, digest: inputIntentDigest(input), messageId,
      skill: isSkillInvocationText(input.text), state: 'queued',
    });
    this.changed(input.sessionId);
    return this.read(input.sessionId, input.inputId)!;
  }

  /**
   * Identity for an input accepted outside the body queue (a steer input
   * lives in the target Run's interrupt record); keeps resubmission dedup.
   */
  recordAccepted(input: ClientSubmitInput, runId: string, state: ClientInputAcceptance['state']): ClientInputAcceptance {
    const duplicate = this.find(input);
    if (duplicate) return duplicate;
    this.facts.set(this.key(input.sessionId, input.inputId), {
      sessionId: input.sessionId, inputId: input.inputId, digest: inputIntentDigest(input),
      skill: false, state, runId,
    });
    this.changed(input.sessionId);
    return this.read(input.sessionId, input.inputId)!;
  }

  markSubmitted(sessionId: string, inputId: string): void {
    const fact = this.facts.get(this.key(sessionId, inputId));
    if (!fact || fact.state !== 'queued') return;
    fact.state = 'submitted';
    this.changed(sessionId);
  }

  /** A steer fact whose target Run settled before safe-point delivery. */
  markDropped(sessionId: string, inputId: string): void {
    const fact = this.facts.get(this.key(sessionId, inputId));
    if (!fact || fact.state !== 'queued' || fact.messageId !== undefined) return;
    fact.state = 'dropped';
    this.changed(sessionId);
  }

  list(sessionId: string): readonly ClientQueuedInput[] {
    return this.ordered(sessionId).map(({ input, enqueuedAt }) => ({
      inputId: input.inputId, text: queuePreview(input.text), enqueuedAt,
    }));
  }

  private ordered(sessionId: string): readonly { readonly input: ClientSubmitInput; readonly skill: boolean; readonly enqueuedAt: number }[] {
    const queued = this.queue.peek({ agentId: sessionId, mode: 'prompt', maxPriority: 'user' });
    const factByMessageId = new Map<string, QueuedInputFact>();
    for (const fact of this.facts.values()) {
      if (fact.sessionId === sessionId && fact.state === 'queued' && fact.messageId !== undefined) {
        factByMessageId.set(fact.messageId, fact);
      }
    }
    return queued.map((message) => {
      const fact = factByMessageId.get(message.id);
      if (!fact) throw conflict('Queued input is no longer available.');
      return {
        input: { sessionId, inputId: fact.inputId, text: message.content, delivery: 'after_turn' as const },
        skill: fact.skill,
        enqueuedAt: message.enqueuedAt,
      };
    });
  }

  /** One drain unit: consecutive plain texts merge; a Skill input drains alone. */
  batch(sessionId: string): readonly { readonly input: ClientSubmitInput; readonly enqueuedAt: number }[] {
    const ordered = this.ordered(sessionId);
    const first = ordered[0];
    if (!first) return [];
    const end = first.skill ? 1 : ordered.findIndex((item, index) => index > 0 && item.skill);
    return (end === -1 ? ordered : ordered.slice(0, end)).map(({ input, enqueuedAt }) => ({ input, enqueuedAt }));
  }

  submitBatch(sessionId: string, inputIds: readonly string[], runId: string): void {
    const facts = inputIds.map((inputId) => {
      const fact = this.facts.get(this.key(sessionId, inputId));
      if (!fact || fact.state !== 'queued' || fact.messageId === undefined) throw conflict('Queued input is no longer available.');
      return fact;
    });
    for (const fact of facts) {
      this.queue.dequeue({ agentId: sessionId, mode: 'prompt', maxPriority: 'user', id: fact.messageId });
      fact.state = 'submitted';
      fact.runId = runId;
    }
    this.changed(sessionId);
  }

  withdraw(sessionId: string, inputId: string): ClientSubmitInput {
    const fact = this.facts.get(this.key(sessionId, inputId));
    if (fact?.messageId === undefined) {
      throw conflict(fact
        ? 'Input is bound to its target Run and cannot be withdrawn from the queue.'
        : 'Input has already been submitted or withdrawn.');
    }
    if (fact.state !== 'queued') throw conflict('Input has already been submitted or withdrawn.');
    const [message] = this.queue.dequeue({ agentId: sessionId, mode: 'prompt', maxPriority: 'user', id: fact.messageId });
    if (!message) throw conflict('Input is already being submitted.');
    fact.state = 'withdrawn';
    this.changed(sessionId);
    return { sessionId, inputId, text: message.content, delivery: 'after_turn' };
  }

  releaseSession(sessionId: string): void {
    this.queue.dequeue({ agentId: sessionId, mode: 'prompt', maxPriority: 'user' });
    for (const [key, fact] of this.facts) if (fact.sessionId === sessionId) this.facts.delete(key);
    this.changed(sessionId);
  }

  close(): void {
    this.queue.clear();
    this.facts.clear();
  }
}

function conflict(message: string): Error & { readonly code: 'conflict' } {
  return Object.assign(new Error(message), { code: 'conflict' as const });
}
