import type {
  AgentBudgetExhausted,
  AgentLimitReached,
  AgentMetadataValue,
} from './types.js';

/** Executor failure carrying bounded metadata that belongs on the failed turn. */
export class AgentExecutionError extends Error {
  constructor(
    message: string,
    readonly turnMetadata: Readonly<Record<string, AgentMetadataValue>>,
  ) {
    super(message);
    this.name = 'AgentExecutionError';
  }
}

export class AgentLimitReachedError extends Error implements AgentLimitReached {
  readonly code = 'agent_limit_reached' as const;
  readonly availableNonRootSlots = 0 as const;
  readonly retryable = true as const;

  constructor(
    readonly maxConcurrentThreads: number,
    readonly activeNonRootTurns: number,
  ) {
    super('Agent concurrency limit reached.');
    this.name = 'AgentLimitReachedError';
  }
}

export class AgentBudgetExhaustedError extends Error implements AgentBudgetExhausted {
  readonly code = 'agent_budget_exhausted' as const;
  readonly retryable = false as const;

  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AgentBudgetExhaustedError';
  }
}

export class AgentRevisionConflictError extends Error {
  readonly code = 'revision_conflict' as const;

  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(`Actor revision ${expectedRevision} is stale; current revision is ${currentRevision}.`);
    this.name = 'AgentRevisionConflictError';
  }
}

export class AgentActorStoreConflictError extends Error {
  readonly code = 'actor_snapshot_conflict' as const;

  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
    scope?: string,
  ) {
    super(
      `Actor snapshot revision conflict${scope ? ` for ${scope}` : ''}: `
      + `expected ${expectedRevision}, actual ${currentRevision}.`,
    );
    this.name = 'AgentActorStoreConflictError';
  }
}

export class AgentOwnerConflictError extends Error {
  readonly code = 'actor_owner_conflict' as const;
  readonly retryable = false as const;

  constructor(
    readonly ownerRuntimeId: string | undefined,
    readonly currentRevision: number,
    readonly localExecutionsAborted: boolean,
  ) {
    super(
      ownerRuntimeId
        ? `Actor tree is owned by live Runtime ${ownerRuntimeId}.`
        : 'Actor tree ownership changed in another Runtime.',
    );
    this.name = 'AgentOwnerConflictError';
  }
}

export class AgentOwnerUnknownError extends Error {
  readonly code = 'actor_owner_unknown' as const;
  readonly retryable = false as const;

  constructor(readonly currentRevision: number) {
    super(
      'Actor snapshot has active turns but no Runtime owner identity. '
      + 'Wait for the owner handoff to finish or stop the pre-v0.7.78 Runtime cleanly before retrying.',
    );
    this.name = 'AgentOwnerUnknownError';
  }
}

export class AgentSettlementPersistenceError extends Error {
  readonly code = 'actor_settlement_not_persisted' as const;
  readonly retryable = false as const;

  constructor(
    readonly turnId: string,
    readonly cause: unknown,
  ) {
    super(`Executor settlement for ${turnId} could not be persisted before the retry deadline.`);
    this.name = 'AgentSettlementPersistenceError';
  }
}

export class AgentShutdownPersistenceError extends Error {
  readonly code = 'actor_shutdown_not_persisted' as const;
  readonly retryable = false as const;

  constructor(readonly cause: unknown) {
    super('Actor shutdown could not be durably confirmed before its deadline.');
    this.name = 'AgentShutdownPersistenceError';
  }
}

export type AgentControlErrorCode =
  | 'actor_closed'
  | 'actor_not_found'
  | 'invalid_actor_path'
  | 'invalid_capabilities'
  | 'invalid_fork_turns'
  | 'invalid_forward_reference'
  | 'invalid_message'
  | 'invalid_task_name'
  | 'message_cycle_detected'
  | 'name_collision'
  | 'no_active_turn'
  | 'permission_denied'
  | 'unsupported_operation';

export class AgentControlError extends Error {
  constructor(readonly code: AgentControlErrorCode, message: string) {
    super(message);
    this.name = 'AgentControlError';
  }
}
