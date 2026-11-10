/** Shared SDK/Host capability vocabulary. No Host startup or Node imports. */
export interface RuntimeCapabilityRequirements {
  readonly sideChat?: 1;
  readonly productHistoryTurnResolution?: 1 | 2;
  readonly productHistoryLocation?: 1 | 2;
  readonly productExitControl?: 1;
  readonly productExecutionFacts?: 1;
  readonly productActorAuthorization?: 1;
  readonly providerProbeAuthorization?: 1;
  readonly providerCredentialConnectionBinding?: 1;
  readonly productHistoryBoundaries?: 1;
  readonly productExecutionAuthorization?: 1 | 2;
  /** Unified product business operations and current-view lifecycle. */
  readonly productClient?: 1;
  readonly sessionDrafts?: 1;
  readonly sessionPromotion?: 1;
  readonly productExecutionBinding?: 1;
  readonly productInputRecovery?: 1;
  readonly productExecutionModeConstraint?: 1;
  /** Reject hosts that do not advertise an installed external Agent executor plane. */
  readonly externalAgents?: boolean;
  /** Require owner/revision-fenced external Agent registration administration. */
  readonly externalAgentAdmin?: 1;
  /** Require a daemon that owns and hot-reconciles its A2A integration config. */
  readonly a2aConfigReconciler?: 1;
  readonly sessionObservation?: 1;
  readonly afterTurnInput?: 1;
  readonly learningCenter?: 1;
  readonly skillLearningLoop?: 1;
  readonly interruptInput?: 1;
  readonly askUserTransport?: 1;
  readonly permissionCas?: 1;
  readonly providerCredentialBroker?: 1 | 2;
  /** v1: run-bound host tool leases. v2 additionally materializes bound host tools into the agent tool table and cached capability catalog. */
  readonly runBoundHostTools?: 1 | 2;
  readonly coderOwnerFencing?: 1;
  readonly crashOutcomeModel?: 1 | 2;
  readonly coderFeatureMatrix?: 1;
  readonly sessionAdmission?: 1;
  readonly completeObservationSnapshot?: 1;
  /** Require always-on thresholds, stable context identity, and canonical compact events. */
  readonly contextCompaction?: 1 | 2 | 3;
  /** Require bounded transcript slices plus page/chunk recovery. */
  readonly transcriptPaging?: 1;
  /** Require deterministic exact-history search over merged persisted lineage. */
  readonly transcriptSearch?: 1;
  /** v2 also requires topology-transparent managed context and direct clone provenance. */
  readonly conversationHistory?: 1 | 2;
  readonly connectionLifecycle?: 1;
  readonly typedRuntimeEvents?: 1;
  readonly daemonSafeRunInput?: 1;
  readonly sharedSessionSettings?: 1 | 2;
  readonly durableRecoveryQueries?: 1;
  /** Require durable accepted-input and completed-turn boundaries for managed Runs. */
  readonly managedRunDurability?: 1;
  /** Require fail-closed root fencing plus automatic same-owner Actor settlement repair. */
  readonly actorSettlementConvergence?: 1 | 2;
  /** Require Session-local event ordering and scoped event access. */
  readonly daemonManagement?: 1;
  /** Require a read-only inventory of initialized logical daemon clients. */
  readonly daemonClientInventory?: 1;
  /** Require an auto-started daemon whose current host has orphan idle-exit enabled. */
  readonly daemonOrphanExit?: 1;
  /** Require authoritative durable shutdown plus kernel-backed process containment. */
  readonly daemonShutdownVerification?: 1;
  /** Require source-level bounded coalescing before sequence allocation and persistence. */
  readonly runtimeEventCoalescing?: 1;
  /** Require provider-request-owned live output with explicit replacement semantics. */
  readonly liveOutputSegments?: 1;
  /** Optional integration failures are isolated, observable, and hot-recoverable. */
  readonly integrationConfigResilience?: 1;
  /** Require a secret-safe snapshot of applied Runtime configuration provenance. */
  readonly effectiveConfig?: 1;
  readonly actorControlPlane?: 1;
  /** Require the sandbox-first execution chain and permission fallback revision. */
  readonly sandboxRuntime?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  /** Runtime owns Auto[LLM] review at the proven host boundary. */
  readonly runtimeAutoModeGuardrail?: 1 | 2 | 3 | 4 | 5 | 6;
}


/** Implemented SDK contracts; Host availability is checked separately. */
export const KODAX_RUNTIME_SDK_CAPABILITIES = Object.freeze({
  sideChat: 1,
  productHistoryTurnResolution: 2,
  productHistoryLocation: 2,
  productExitControl: 1,
  productExecutionFacts: 1,
  productActorAuthorization: 1,
  providerProbeAuthorization: 1,
  providerCredentialConnectionBinding: 1,
  productHistoryBoundaries: 1,
  productExecutionAuthorization: 2,
  productClient: 1,
  sessionDrafts: 1,
  sessionPromotion: 1,
  productExecutionBinding: 1,
  productInputRecovery: 1,
  productExecutionModeConstraint: 1,
  externalAgentAdmin: 1,
  a2aConfigReconciler: 1,
  sessionObservation: 1,
  afterTurnInput: 1,
  learningCenter: 1,
  skillLearningLoop: 1,
  interruptInput: 1,
  askUserTransport: 1,
  permissionCas: 1,
  providerCredentialBroker: 2,
  runBoundHostTools: 2,
  coderOwnerFencing: 1,
  crashOutcomeModel: 2,
  coderFeatureMatrix: 1,
  sessionAdmission: 1,
  completeObservationSnapshot: 1,
  contextCompaction: 3,
  transcriptPaging: 1,
  transcriptSearch: 1,
  conversationHistory: 2,
  connectionLifecycle: 1,
  typedRuntimeEvents: 1,
  daemonSafeRunInput: 1,
  sharedSessionSettings: 2,
  durableRecoveryQueries: 1,
  managedRunDurability: 1,
  actorSettlementConvergence: 2,
  daemonManagement: 1,
  daemonClientInventory: 1,
  daemonOrphanExit: 1,
  daemonShutdownVerification: 1,
  runtimeEventCoalescing: 1,
  liveOutputSegments: 1,
  integrationConfigResilience: 1,
  effectiveConfig: 1,
  actorControlPlane: 1,
  sandboxRuntime: 11,
  runtimeAutoModeGuardrail: 6,
} as const satisfies Required<Omit<RuntimeCapabilityRequirements, 'externalAgents'>>);

export type RuntimeCapabilityName = keyof typeof KODAX_RUNTIME_SDK_CAPABILITIES;
export interface ClientCapabilityService {
  readonly sdk: typeof KODAX_RUNTIME_SDK_CAPABILITIES;
  /** Reads the current connection, including after launcher-owned reconnection. */
  supports<Name extends RuntimeCapabilityName>(name: Name,
    version: NonNullable<RuntimeCapabilityRequirements[Name]>): boolean;
}

export function supportsRuntimeCapability<Name extends RuntimeCapabilityName>(
  host: Readonly<Record<string, unknown>> | undefined, name: Name,
  minimum: NonNullable<RuntimeCapabilityRequirements[Name]>,
): boolean {
  const fact = host?.[name];
  return typeof fact === 'object' && fact !== null && 'version' in fact
    && Number.isSafeInteger(fact.version) && Number(fact.version) >= minimum;
}

export function requireRuntimeCapability<Name extends RuntimeCapabilityName>(
  host: Readonly<Record<string, unknown>> | undefined, name: Name,
  version: NonNullable<RuntimeCapabilityRequirements[Name]>,
): void {
  if (!supportsRuntimeCapability(host, name, version)) throw Object.assign(
    new Error(`Use ensureKodaXClient for ${name}:${version}.`),
    { code: 'daemon_upgrade_required', data: { capability: name, requiredVersion: version } },
  );
}
