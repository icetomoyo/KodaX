import { createHash } from 'node:crypto';
import { MessageQueue, type QueuedMessage } from '@kodax-ai/agent';
import type { ClientInputAcceptance, ClientInputAdmissionError, ClientQueuedInput, ClientSubmitInput } from '@kodax-ai/coding/client-contract';
import { currentProductExecution, productExecutionIntentKey, retainExecutionWorkMode, type ProductExecutionContext } from './product-execution-authorization.js';

interface QueuedInputFact {
  requiredWorkMode?: 'agent';
  explicitSkill?: string | null;
  plainRunBoundary?: true;
  admissionError?: ClientInputAdmissionError;
  execution?: ProductExecutionContext;
  readonly principalId?: string;
  awaitingBinding?: boolean;
  readonly sessionId: string;
  readonly inputId: string;
  digest: string;
  readonly messageId?: string;
  readonly delivery?: ClientSubmitInput['delivery'];
  readonly targetRunId?: string;
  /** Legacy persisted name: true requires a separate Run, for a Skill or changed authority/default method. */
  skill: boolean;
  state: ClientInputAcceptance['state'];
  runId?: string;
  /** A steer input lives in its target Run; the original stays here only while withdrawal can still return it. */
  steerInput?: ClientSubmitInput;
}

export interface PendingSessionInput {
  readonly requiredWorkMode?: 'agent';
  /** A name pins explicit intent; null marks a default/authority boundary.
   * Legacy explicit queues omit it; older null redirects are ambiguous without plainRunBoundary. */
  readonly explicitSkill?: string | null;
  /** Host-confirmed plain input deferred to a new Run; not a legacy explicit Skill. */
  readonly plainRunBoundary?: true;
  readonly admissionError?: ClientInputAdmissionError;
  readonly input: ClientSubmitInput;
  /** Keep this persisted name for old checkpoints; true is a Run boundary, not proof of a named Skill. */
  readonly skill: boolean;
  readonly principalId?: string;
}

/** Original input retained until its Session is released; never execution authority. */
export interface WithdrawnSessionInput {
  readonly input: ClientSubmitInput;
  readonly principalId?: string;
}

export interface SessionInputState {
  readonly pending: readonly PendingSessionInput[];
  readonly withdrawn: readonly WithdrawnSessionInput[];
}

export function inputIntentDigest(input: ClientSubmitInput, executionKey?: string): string {
  // targetRunId and inputArtifacts are appended only when present so
  // targetless artifact-free inputs keep the digest formula that earlier
  // Host builds persisted in Run statuses.
  return createHash('sha256').update(JSON.stringify([
    input.text, input.delivery ?? 'immediate',
    ...(input.targetRunId !== undefined ? [input.targetRunId] : []),
    ...(input.inputArtifacts !== undefined ? [input.inputArtifacts] : []),
    ...(executionKey !== undefined ? [executionKey] : []),
  ])).digest('hex');
}

/** Host admission bound; matches the REPL pending-input footer limit (packages/repl/src/ui/utils/pending-inputs.ts, a UI-internal constant not exported from that package). */
export const MAX_QUEUED_INPUTS = 5;
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
  private readonly withdrawals = new Map<string, WithdrawnSessionInput>();

  constructor(private readonly changed: (sessionId: string) => void,
    private readonly persist?: (sessionId: string, pending: readonly PendingSessionInput[], withdrawn: readonly WithdrawnSessionInput[]) => void) {}

  private restoring = false;

  private persistPending(sessionId: string, pending: readonly PendingSessionInput[],
    withdrawn = [...this.withdrawals.values()].filter(value => value.input.sessionId === sessionId)): void {
    if (!this.restoring) this.persist?.(sessionId, pending, withdrawn);
  }

  restoreWithdrawn(inputs: readonly WithdrawnSessionInput[]): void {
    for (const value of inputs) {
      const key = this.key(value.input.sessionId, value.input.inputId);
      if (this.facts.has(key)) throw conflict('Withdrawn input conflicts with pending input.');
      this.withdrawals.set(key, structuredClone(value));
      this.facts.set(key, { sessionId: value.input.sessionId, inputId: value.input.inputId,
        digest: inputIntentDigest(value.input), principalId: value.principalId, skill: false, state: 'withdrawn' });
    }
  }

  snapshot(sessionId: string): readonly PendingSessionInput[] {
    return this.ordered(sessionId).map(({ input, skill, principalId, explicitSkill, plainRunBoundary }) => {
      const fact = this.facts.get(this.key(sessionId, input.inputId));
      const error = fact?.admissionError;
      return { input: structuredClone(input), skill,
        ...(fact?.requiredWorkMode === undefined ? {} : { requiredWorkMode: fact.requiredWorkMode }),
        ...(explicitSkill === undefined ? {} : { explicitSkill }),
        ...(plainRunBoundary === undefined ? {} : { plainRunBoundary }),
        ...(error === undefined ? {} : { admissionError: structuredClone(error) }),
        ...(principalId ? { principalId } : {}) };
    });
  }

  validateRestore(inputs: readonly PendingSessionInput[]): void {
    const additions = new Map<string, Set<string>>();
    const intents = new Map<string, string>();
    for (const value of inputs) {
      if (value.requiredWorkMode !== undefined && value.requiredWorkMode !== 'agent') throw conflict('Malformed queued mode constraint.');
      if (value.explicitSkill !== undefined && value.explicitSkill !== null && (typeof value.explicitSkill !== 'string' || !value.explicitSkill.trim()
        || value.explicitSkill.length > 128)) throw conflict('Malformed queued Skill identity.');
      if (value.plainRunBoundary !== undefined && (value.plainRunBoundary !== true || value.skill !== true
        || value.explicitSkill !== null)) throw conflict('Malformed plain Run boundary.');
      const error = value.admissionError;
      if (error !== undefined && (error === null || typeof error !== 'object'
        || !['execution_binding_unavailable', 'execution_binding_rejected', 'execution_binding_changed', 'default_skill_unavailable', 'execution_mode_mismatch'].includes(error.code)
        || typeof error.message !== 'string' || error.message.length > 512)) throw conflict('Malformed queued admission error.');
      const key = this.key(value.input.sessionId, value.input.inputId);
      const intent = JSON.stringify([inputIntentDigest(value.input), value.principalId, value.requiredWorkMode]);
      if (intents.has(key) && intents.get(key) !== intent) throw conflict('Input ID already belongs to a different intent.');
      intents.set(key, intent);
      const existing = this.facts.get(key);
      if (existing) {
        if (existing.requiredWorkMode !== value.requiredWorkMode || existing.principalId !== value.principalId
          || existing.digest !== inputIntentDigest(value.input, existing.awaitingBinding ? undefined : productExecutionIntentKey(existing.execution))) {
          throw conflict('Input ID already belongs to a different intent.');
        }
        continue;
      }
      const ids = additions.get(value.input.sessionId) ?? new Set<string>();
      ids.add(value.input.inputId);
      additions.set(value.input.sessionId, ids);
    }
    for (const [sessionId, ids] of additions) {
      if (this.list(sessionId).length + ids.size > MAX_QUEUED_INPUTS) throw conflict(`Queued follow-up limit reached (${MAX_QUEUED_INPUTS}).`);
    }
  }

  restore(inputs: readonly PendingSessionInput[], deferAuthorization = false): void {
    this.prepareRestore(inputs, deferAuthorization)();
  }

  /** Persist intent first; install process-local authority only after the Run claim commits. */
  prepareRestore(inputs: readonly PendingSessionInput[], deferAuthorization = false): () => void {
    this.validateRestore(inputs);
    for (const sessionId of new Set(inputs.map(value => value.input.sessionId))) {
      if (!deferAuthorization) this.persistPending(sessionId, [...this.snapshot(sessionId), ...inputs.filter(value => value.input.sessionId === sessionId && !this.facts.has(this.key(sessionId, value.input.inputId)))]);
    }
    return () => {
      this.restoring = true;
      try {
        for (const value of inputs) {
          const execution = currentProductExecution();
          const key = this.key(value.input.sessionId, value.input.inputId);
          if (this.facts.has(key)) {
            if (!deferAuthorization && value.admissionError === undefined && value.principalId === execution?.principalId) this.rebind(value.input);
            continue;
          }
          const awaitingBinding = deferAuthorization || value.admissionError !== undefined || value.principalId !== execution?.principalId;
          this.enqueueWithExecution(value.input, value.skill, awaitingBinding ? undefined : execution, value.principalId, awaitingBinding, value.explicitSkill, value.plainRunBoundary, value.requiredWorkMode);
          if (value.admissionError !== undefined) this.facts.get(key)!.admissionError = structuredClone(value.admissionError);
        }
      } finally {
        this.restoring = false;
      }
    };
  }

  private key(sessionId: string, inputId: string): string {
    return JSON.stringify([sessionId, inputId]);
  }

  read(sessionId: string, inputId: string): ClientInputAcceptance | undefined {
    const fact = this.facts.get(this.key(sessionId, inputId));
    if (!fact) return undefined;
    return { sessionId, inputId, state: fact.state, ...(fact.runId ? { runId: fact.runId } : {}),
      ...(fact.admissionError === undefined ? {} : { admissionError: structuredClone(fact.admissionError) }) };
  }

  find(input: ClientSubmitInput): ClientInputAcceptance | undefined {
    const fact = this.facts.get(this.key(input.sessionId, input.inputId));
    if (!fact) return undefined;
    if (fact.state === 'withdrawn') {
      this.assertWithdrawalOwner(fact.principalId, currentProductExecution()?.principalId);
      if (fact.digest !== inputIntentDigest(input)) throw conflict('Input ID already belongs to a different intent.');
      return this.read(input.sessionId, input.inputId);
    }
    if (fact.awaitingBinding && fact.principalId !== currentProductExecution()?.principalId) throw conflict('Pending input requires its original principal to rebind.');
    if (fact.digest !== inputIntentDigest(input, fact.awaitingBinding ? undefined : productExecutionIntentKey(currentProductExecution()))) throw conflict('Input ID already belongs to a different intent.');
    return this.read(input.sessionId, input.inputId);
  }

  /** Original submitter resubmits the same input ID with fresh authority. */
  rebind(input: ClientSubmitInput): ClientInputAcceptance | undefined {
    const fact = this.facts.get(this.key(input.sessionId, input.inputId));
    if (fact?.state === 'queued' && fact.messageId !== undefined && !fact.awaitingBinding
      && fact.execution?.bindingAvailable?.() === false) {
      if (fact.principalId !== currentProductExecution()?.principalId) throw conflict('Pending input requires its original principal to rebind.');
      // Validate against the old declaration before replacing only its expired connection.
      if (fact.digest !== inputIntentDigest(input, productExecutionIntentKey(fact.execution))) throw conflict('Input ID already belongs to a different intent.');
      fact.execution = currentProductExecution();
      fact.digest = inputIntentDigest(input, productExecutionIntentKey(fact.execution));
    }
    const found = this.find(input);
    if (fact?.awaitingBinding) {
      if (fact.admissionError !== undefined) this.persistPending(input.sessionId, this.snapshot(input.sessionId).map(value => {
        if (value.input.inputId !== input.inputId) return value;
        const { admissionError: _error, ...rest } = value;
        return rest;
      }));
      fact.execution = currentProductExecution();
      fact.digest = inputIntentDigest(input, productExecutionIntentKey(fact.execution));
      fact.awaitingBinding = false;
      delete fact.admissionError;
      this.changed(input.sessionId);
    }
    return found === undefined ? undefined : this.read(input.sessionId, input.inputId);
  }

  enqueue(input: ClientSubmitInput, skill: boolean, explicitSkill?: string): ClientInputAcceptance {
    const duplicate = this.find(input);
    if (duplicate) return duplicate;
    return this.enqueueWithExecution(input, skill, currentProductExecution(), currentProductExecution()?.principalId, false, skill ? explicitSkill ?? null : undefined);
  }

  private enqueueWithExecution(input: ClientSubmitInput, skill: boolean, execution: ProductExecutionContext | undefined,
    principalId: string | undefined, awaitingBinding: boolean, explicitSkill?: string | null, plainRunBoundary?: true,
    requiredWorkMode = execution?.profile?.requiredWorkMode): ClientInputAcceptance {
    if (this.queue.count({ agentId: input.sessionId, mode: 'prompt', maxPriority: 'user' }) >= MAX_QUEUED_INPUTS) {
      throw conflict(`Queued follow-up limit reached (${MAX_QUEUED_INPUTS}). Wait or withdraw an input.`);
    }
    this.persistPending(input.sessionId, [...this.snapshot(input.sessionId), { input: structuredClone(input), skill,
      ...(requiredWorkMode === undefined ? {} : { requiredWorkMode }),
      ...(explicitSkill === undefined ? {} : { explicitSkill }),
      ...(plainRunBoundary === undefined ? {} : { plainRunBoundary }),
      ...(principalId ? { principalId } : {}) }]);
    const messageId = this.queue.enqueue({
      agentId: input.sessionId, mode: 'prompt', priority: 'user', content: input.text,
      ...(input.inputArtifacts !== undefined ? { inputArtifacts: structuredClone(input.inputArtifacts) } : {}),
    });
    this.facts.set(this.key(input.sessionId, input.inputId), {
      sessionId: input.sessionId, inputId: input.inputId, digest: inputIntentDigest(input, productExecutionIntentKey(execution)), messageId,
      delivery: input.delivery, targetRunId: input.targetRunId,
      execution, principalId, awaitingBinding, requiredWorkMode,
      explicitSkill,
      plainRunBoundary,
      skill, state: 'queued',
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
      sessionId: input.sessionId, inputId: input.inputId, digest: inputIntentDigest(input, productExecutionIntentKey(currentProductExecution())),
      principalId: currentProductExecution()?.principalId,
      skill: false, state, runId, steerInput: structuredClone(input),
    });
    this.changed(input.sessionId);
    return this.read(input.sessionId, input.inputId)!;
  }

  markSubmitted(sessionId: string, inputId: string): void {
    const fact = this.facts.get(this.key(sessionId, inputId));
    if (!fact || fact.state !== 'queued') return;
    fact.state = 'submitted';
    delete fact.steerInput;
    this.changed(sessionId);
  }

  /** A steer fact whose target Run settled before safe-point delivery. */
  markDropped(sessionId: string, inputId: string): void {
    const fact = this.facts.get(this.key(sessionId, inputId));
    if (!fact || fact.state !== 'queued' || fact.messageId !== undefined) return;
    fact.state = 'dropped';
    delete fact.steerInput;
    this.changed(sessionId);
  }

  list(sessionId: string): readonly ClientQueuedInput[] {
    return this.ordered(sessionId).map(({ input, enqueuedAt }) => ({
      inputId: input.inputId, text: queuePreview(input.text), enqueuedAt,
      ...(this.facts.get(this.key(sessionId, input.inputId))?.admissionError === undefined ? {} : {
        admissionError: structuredClone(this.facts.get(this.key(sessionId, input.inputId))!.admissionError),
      }),
    }));
  }

  deferToRunBoundary(sessionId: string, inputId: string): void {
    const fact = this.facts.get(this.key(sessionId, inputId));
    if (!fact || fact.state !== 'queued' || fact.skill) return;
    this.persistPending(sessionId, this.snapshot(sessionId).map(value => value.input.inputId === inputId ? { ...value, skill: true, explicitSkill: null, plainRunBoundary: true } : value));
    fact.skill = true;
    fact.explicitSkill = null;
    fact.plainRunBoundary = true;
    this.changed(sessionId);
  }

  block(sessionId: string, inputId: string, error: ClientInputAdmissionError): void {
    const fact = this.facts.get(this.key(sessionId, inputId));
    const queued = this.ordered(sessionId).find(value => value.input.inputId === inputId);
    if (!fact || !queued || fact.state !== 'queued') return;
    const admissionError = { code: error.code, message: error.message.slice(0, 512) };
    this.persistPending(sessionId, this.snapshot(sessionId).map(value => value.input.inputId === inputId ? { ...value, admissionError } : value));
    fact.admissionError = admissionError;
    fact.digest = inputIntentDigest(queued.input);
    fact.awaitingBinding = true;
    this.changed(sessionId);
  }

  private ordered(sessionId: string): readonly { readonly input: ClientSubmitInput; readonly skill: boolean; readonly explicitSkill?: string | null; readonly plainRunBoundary?: true; readonly enqueuedAt: number; readonly execution?: ProductExecutionContext; readonly principalId?: string; readonly awaitingBinding?: boolean }[] {
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
        input: { sessionId, inputId: fact.inputId, text: message.content,
          ...(fact.delivery !== undefined ? { delivery: fact.delivery } : {}),
          ...(fact.targetRunId !== undefined ? { targetRunId: fact.targetRunId } : {}),
          ...(message.inputArtifacts !== undefined ? { inputArtifacts: message.inputArtifacts } : {}) },
        skill: fact.skill,
        explicitSkill: fact.explicitSkill,
        plainRunBoundary: fact.plainRunBoundary,
        execution: retainExecutionWorkMode(fact.execution, fact.requiredWorkMode),
        principalId: fact.principalId, awaitingBinding: fact.awaitingBinding,
        enqueuedAt: message.enqueuedAt,
      };
    });
  }

  /**
   * One drain unit: compatible plain texts merge; legacy `skill: true`
   * drains alone at a new Run boundary. `explicitSkill` distinguishes a
   * named method from a default/authority boundary; expansion happens at consumption.
   */
  batch(sessionId: string): readonly { readonly input: ClientSubmitInput; readonly enqueuedAt: number; readonly skill: boolean; readonly explicitSkill?: string | null; readonly plainRunBoundary?: true; readonly execution?: ProductExecutionContext }[] {
    const ordered = this.ordered(sessionId);
    const first = ordered[0];
    if (!first || first.awaitingBinding) return [];
    const end = first.skill ? 1 : ordered.findIndex((item, index) => index > 0
      && (item.skill || item.awaitingBinding || item.execution?.key !== first.execution?.key
        || item.execution?.profile?.requiredWorkMode !== first.execution?.profile?.requiredWorkMode
        || item.execution?.principalId !== first.execution?.principalId));
    return end === -1 ? ordered : ordered.slice(0, end);
  }

  submitBatch(sessionId: string, inputIds: readonly string[], runId: string): void {
    const facts = inputIds.map((inputId) => {
      const fact = this.facts.get(this.key(sessionId, inputId));
      if (!fact || fact.state !== 'queued' || fact.messageId === undefined) throw conflict('Queued input is no longer available.');
      return fact;
    });
    this.persistPending(sessionId, this.snapshot(sessionId).filter(value => !inputIds.includes(value.input.inputId)));
    for (const fact of facts) {
      this.queue.dequeue({ agentId: sessionId, mode: 'prompt', maxPriority: 'user', id: fact.messageId });
      fact.state = 'submitted';
      fact.runId = runId;
      delete fact.execution;
    }
    this.changed(sessionId);
  }

  /** Caller holds the same Session operation lock used by withdrawal. */
  async consumePlainBatch(sessionId: string, runId: string,
    persist: (inputs: readonly QueuedMessage[]) => Promise<void>, executionKey?: string, principalId?: string,
    authorize?: (input: ClientSubmitInput, execution: ProductExecutionContext) => Promise<boolean>): Promise<readonly QueuedMessage[]> {
    let batch = this.batch(sessionId);
    if (batch.length === 0 || batch[0]!.skill
      || batch[0]!.execution?.principalId !== principalId) return [];
    if (batch[0]!.execution?.resolve === undefined && batch[0]!.execution?.key !== executionKey) return [];
    let count = 0;
    for (const item of batch) {
      if (item.execution?.resolve !== undefined || item.execution?.profile?.requiredWorkMode !== undefined) {
        if (!authorize || !await authorize(item.input, item.execution)) break;
      } else if (item.execution?.key !== executionKey) break;
      count += 1;
    }
    batch = batch.slice(0, count);
    if (!batch.length) return [];
    const prompts: QueuedMessage[] = batch.map(({ input, enqueuedAt }) => ({
      id: `product:${this.facts.get(this.key(sessionId, input.inputId))!.messageId!}`,
      agentId: sessionId, inputId: input.inputId, content: input.text,
      priority: 'user', mode: 'prompt', enqueuedAt,
      ...(input.inputArtifacts ? { inputArtifacts: input.inputArtifacts } : {}),
    }));
    await persist(prompts);
    this.submitBatch(sessionId, batch.map(({ input }) => input.inputId), runId);
    return prompts;
  }

  private assertWithdrawalOwner(original: string | undefined, principalId: string | undefined): void {
    if (original !== principalId) throw Object.assign(new Error('Input withdrawal requires its original principal.'), { code: 'permission_denied' });
  }

  /** `releaseSteer` synchronously removes an undelivered steer input from its Run; false means delivery has begun. */
  withdraw(sessionId: string, inputId: string, principalId = currentProductExecution()?.principalId,
    releaseSteer?: (runId: string) => boolean): ClientSubmitInput {
    const fact = this.facts.get(this.key(sessionId, inputId));
    if (fact) this.assertWithdrawalOwner(fact.principalId, principalId);
    const previous = this.withdrawals.get(this.key(sessionId, inputId));
    if (previous) return structuredClone(previous.input);
    if (!fact || fact.state !== 'queued') throw conflict('Input has already been submitted or withdrawn.');
    if (fact.messageId === undefined) return this.withdrawSteer(fact, releaseSteer);
    const original = this.snapshot(sessionId).find(value => value.input.inputId === inputId);
    if (!original) throw conflict('Input is already being submitted.');
    const receipt: WithdrawnSessionInput = { input: structuredClone(original.input),
      ...(fact.principalId === undefined ? {} : { principalId: fact.principalId }) };
    this.persistPending(sessionId, this.snapshot(sessionId).filter(value => value.input.inputId !== inputId),
      [...this.withdrawals.values()].filter(value => value.input.sessionId === sessionId).concat(receipt));
    const [message] = this.queue.dequeue({ agentId: sessionId, mode: 'prompt', maxPriority: 'user', id: fact.messageId });
    if (!message) throw conflict('Input is already being submitted.');
    fact.state = 'withdrawn';
    fact.digest = inputIntentDigest(receipt.input);
    this.withdrawals.set(this.key(sessionId, inputId), receipt);
    delete fact.execution;
    this.changed(sessionId);
    return structuredClone(receipt.input);
  }

  private withdrawSteer(fact: QueuedInputFact, release?: (runId: string) => boolean): ClientSubmitInput {
    const { sessionId, inputId, steerInput, runId } = fact;
    if (!steerInput || !runId) throw conflict('Input has already been submitted or withdrawn.');
    const receipt: WithdrawnSessionInput = { input: structuredClone(steerInput),
      ...(fact.principalId === undefined ? {} : { principalId: fact.principalId }) };
    const receipts = [...this.withdrawals.values()].filter(value => value.input.sessionId === sessionId);
    // Commit the receipt first; roll it back if the Run has already started delivering
    // the input or could not record the release.
    this.persistPending(sessionId, this.snapshot(sessionId), [...receipts, receipt]);
    let released = false;
    try {
      released = release?.(runId) === true;
    } finally {
      if (!released) this.persistPending(sessionId, this.snapshot(sessionId), receipts);
    }
    if (!released) throw conflict('Input is already being delivered to its Run.');
    fact.state = 'withdrawn';
    fact.digest = inputIntentDigest(receipt.input);
    delete fact.steerInput;
    this.withdrawals.set(this.key(sessionId, inputId), receipt);
    this.changed(sessionId);
    return structuredClone(receipt.input);
  }

  releaseSession(sessionId: string): void {
    this.persistPending(sessionId, [], []);
    this.queue.dequeue({ agentId: sessionId, mode: 'prompt', maxPriority: 'user' });
    for (const [key, fact] of this.facts) if (fact.sessionId === sessionId) this.facts.delete(key);
    for (const [key, receipt] of this.withdrawals) if (receipt.input.sessionId === sessionId) this.withdrawals.delete(key);
    this.changed(sessionId);
  }

  clientSessions(principalId: string): readonly string[] {
    return [...new Set([...this.facts.values()].filter(fact => fact.state === 'queued' && fact.principalId === principalId).map(fact => fact.sessionId))];
  }

  withdrawClient(principalId: string, sessionId: string): Array<{ sessionId: string; inputId: string }> {
    const withdrawn: Array<{ sessionId: string; inputId: string }> = [];
    for (const fact of this.facts.values()) {
      // Steer inputs settle with their Run, which client cleanup stops separately.
      if (fact.sessionId !== sessionId || fact.state !== 'queued' || fact.principalId !== principalId
        || fact.messageId === undefined) continue;
      this.withdraw(fact.sessionId, fact.inputId, principalId);
      withdrawn.push({ sessionId: fact.sessionId, inputId: fact.inputId });
    }
    return withdrawn;
  }

  close(): void {
    this.queue.clear();
    this.facts.clear();
    this.withdrawals.clear();
  }
}

function conflict(message: string): Error & { readonly code: 'conflict' } {
  return Object.assign(new Error(message), { code: 'conflict' as const });
}
