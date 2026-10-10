/** Trusted Main bridge contracts; keep this leaf free of Node and Runtime implementation types. */
import type {
  ClientCommandInput, ClientReviewInput, ClientSubmitInput, ClientToolInvocationInput, ClientWorkflowStartInput,
} from '@kodax-ai/coding/client-contract';
import type { AgentSpawnInput } from '@kodax-ai/agent';

export interface RuntimeCredentialRequest {
  readonly leaseId: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly runId: string;
}

export type RuntimeCredentialBroker = (
  request: RuntimeCredentialRequest,
) => Promise<string | undefined>;

/** Public binding only carries authority; credential material never crosses this input. */
export type RuntimeCredentialBinding =
  | {
      readonly leaseId: string;
      /** v1 compatibility: one credential is acquired for the complete Run. */
      readonly provider: string;
    }
  | {
      readonly leaseId: string;
      readonly mode: "scoped";
      /** Operation-local narrowing of the registered v2 lease allowlist. */
      readonly providers: readonly string[];
    };

export type RuntimeScopedCredentialTarget =
  | {
      readonly kind: "run";
      readonly runId: string;
    }
  | {
      readonly kind: "operation";
      readonly operationId: string;
      readonly operation: "session.compact";
    }
  | {
      readonly kind: "actor_turn";
      readonly actorPath: string;
      readonly turnId: string;
      readonly parentRunId?: string;
    }
  | {
      readonly kind: "workflow";
      readonly workflowRunId: string;
      readonly parentRunId?: string;
    };

export type RuntimeScopedCredentialPurpose =
  | "primary"
  | "fallback"
  | "classifier"
  | "sidecar"
  | "compaction"
  | "workflow"
  | "utility";

export interface RuntimeScopedCredentialRequest {
  readonly requestId: string;
  readonly leaseId: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly target: RuntimeScopedCredentialTarget;
  readonly purpose: RuntimeScopedCredentialPurpose;
}

export type RuntimeScopedCredentialBroker = (
  request: RuntimeScopedCredentialRequest,
) => Promise<string | undefined>;

export interface RuntimeCredentialLease {
  readonly id: string;
  readonly providers: readonly string[];
  readonly expiresAt?: string;
  /** Absent on legacy v1 daemons. */
  readonly brokerVersion?: 1 | 2;
}

export interface RuntimeCredentialService {
  register(
    input: {
      readonly providers: readonly string[];
      readonly expiresAt?: string;
    },
    broker: RuntimeCredentialBroker,
  ): Promise<RuntimeCredentialLease>;
  resume(
    leaseId: string,
    broker: RuntimeCredentialBroker,
  ): Promise<RuntimeCredentialLease>;
  registerScoped(
    input: {
      readonly providers: readonly string[];
      readonly expiresAt?: string;
    },
    broker: RuntimeScopedCredentialBroker,
  ): Promise<RuntimeCredentialLease>;
  resumeScoped(
    leaseId: string,
    broker: RuntimeScopedCredentialBroker,
  ): Promise<RuntimeCredentialLease>;
  revoke(leaseId: string): Promise<boolean>;
}

export interface RuntimeHostToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly sideEffect: "none" | "idempotent" | "non_idempotent";
}

export interface RuntimeHostToolInvocation {
  readonly invocationId: string;
  readonly leaseId: string;
  readonly toolName: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface RuntimeHostToolResult {
  readonly content: string;
  readonly structuredContent?: unknown;
}

export type RuntimeHostToolHandler = (
  invocation: RuntimeHostToolInvocation,
) => Promise<RuntimeHostToolResult>;

export interface RuntimeHostToolLease {
  readonly id: string;
  readonly tools: readonly RuntimeHostToolDescriptor[];
}

export interface RuntimeHostToolInvocationStatus {
  readonly invocationId: string;
  readonly leaseId: string;
  readonly toolName: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly state:
    "prepared" | "dispatched" | "completed" | "unknown" | "not_dispatched";
  readonly updatedAt: string;
}

export interface RuntimeHostToolService {
  register(
    tools: readonly RuntimeHostToolDescriptor[],
    handlers: Readonly<Record<string, RuntimeHostToolHandler>>,
  ): Promise<RuntimeHostToolLease>;
  resume(
    leaseId: string,
    handlers: Readonly<Record<string, RuntimeHostToolHandler>>,
  ): Promise<RuntimeHostToolLease>;
  getInvocation(
    invocationId: string,
  ): Promise<RuntimeHostToolInvocationStatus | undefined>;
  revoke(leaseId: string): Promise<boolean>;
}

/** Narrow, Run-owned ceilings. Concurrency uses the existing Host workflow config. */
export interface KodaXClientWorkflowHostPolicy {
  readonly maxAgents?: number;
  /** Output-token budget; 0 keeps the existing unbounded-budget semantics. */
  readonly tokenBudget?: number;
}

/** Non-secret capabilities selected by trusted Main code, never by a Product input. */
export interface RuntimeExecutionAuthorization {
  readonly credential?: Extract<RuntimeCredentialBinding, { readonly mode: 'scoped' }>;
  readonly hostTools?: { readonly leaseId: string };
  /** Additional ceiling for independently admitted Actor turns. */
  readonly tools?: readonly string[];
  /** Captured for this Product Run, including its Workflow children; not arbitrary Run options. */
  readonly workflowHostPolicy?: KodaXClientWorkflowHostPolicy;
}

export type KodaXClientExecutionRequest =
  | { readonly kind: 'input'; readonly input: ClientSubmitInput }
  | { readonly kind: 'command'; readonly input: ClientCommandInput }
  | { readonly kind: 'review' | 'agents_lean'; readonly input: ClientReviewInput }
  | { readonly kind: 'tool'; readonly input: ClientToolInvocationInput }
  | { readonly kind: 'workflow'; readonly input: ClientWorkflowStartInput }
  | { readonly kind: 'agent_spawn'; readonly input: { readonly sessionId: string; readonly agent: AgentSpawnInput } }
  | { readonly kind: 'agent_followup'; readonly input: { readonly sessionId: string; readonly actorPath: string; readonly objective: string; readonly expectedRevision?: number } }
  | { readonly kind: 'compaction'; readonly input: { readonly sessionId: string; readonly customInstructions?: string } };

export type KodaXClientHostAuthorization = (
  request: KodaXClientExecutionRequest,
  services: { readonly credentials: RuntimeCredentialService; readonly hostTools: RuntimeHostToolService },
) => Promise<RuntimeExecutionAuthorization | undefined>;

