/**
 * KodaX Prefix Rename Map (FEATURE_086 子任务 A)
 *
 * Canonical mapping of every `KodaX*`-prefixed type/interface/class in the
 * monorepo to its v0.7.27 replacement. Review THIS file before running
 * any codemod — the entries encode design decisions, not mechanical
 * search-and-replace.
 *
 * Decision categories:
 *   - KEEP        : identifier stays verbatim (brand identity)
 *   - DROP        : remove KodaX prefix, rename everything else
 *   - INTERNALIZE : stop exporting (accidentally-public)
 *   - MERGE       : collapse into the listed target type
 *   - REMOVE      : delete entirely; callers migrate to the replacement
 *
 * Source list: `packages/ src/` `.ts`/`.tsx` files,
 *   `grep -E "^\s*export\s+(type|interface|class)\s+KodaX[A-Z]"`
 *   as of commit c24128f (2026-04-24).
 */

export type RenameDecision =
  | { kind: 'KEEP' }
  | { kind: 'DROP'; to: string }
  | { kind: 'INTERNALIZE' }
  | { kind: 'MERGE'; into: string }
  | { kind: 'REMOVE'; replacement: string };

export const KODAX_RENAME_MAP: Readonly<Record<string, RenameDecision>> = {
  // ============== KEEP (brand identity) ==============
  KodaXError: { kind: 'KEEP' },
  KodaXNetworkError: { kind: 'KEEP' },
  KodaXProviderError: { kind: 'KEEP' },
  KodaXRateLimitError: { kind: 'KEEP' },
  KodaXSessionError: { kind: 'KEEP' },
  KodaXTerminalError: { kind: 'KEEP' },
  KodaXToolCallIdError: { kind: 'KEEP' },
  KodaXToolError: { kind: 'KEEP' },
  KodaXClient: { kind: 'KEEP' },
  KodaXOptions: { kind: 'KEEP' },
  KodaXEvents: { kind: 'KEEP' },

  // ============== INTERNALIZE (stop exporting) ==============
  KodaXAmaControllerDecision: { kind: 'INTERNALIZE' },

  // ============== MERGE ==============
  KodaXToolDefinition: { kind: 'MERGE', into: 'Tool' },

  // ============== REMOVE ==============
  KodaXSessionLineage: { kind: 'REMOVE', replacement: 'Session + LineageExtension composition' },

  // ============== DROP (simple prefix removal) ==============
  KodaXAcpServer: { kind: 'DROP', to: 'AcpServer' },
  KodaXAcpServerOptions: { kind: 'DROP', to: 'AcpServerOptions' },
  KodaXAgentMode: { kind: 'DROP', to: 'AgentMode' },
  KodaXAgentWorkerSpec: { kind: 'DROP', to: 'AgentWorkerSpec' },
  KodaXAmaFanoutClass: { kind: 'DROP', to: 'AmaFanoutClass' },
  KodaXAmaFanoutPolicy: { kind: 'DROP', to: 'AmaFanoutPolicy' },
  KodaXAmaProfile: { kind: 'DROP', to: 'AmaProfile' },
  KodaXAmaTactic: { kind: 'DROP', to: 'AmaTactic' },
  KodaXAssuranceIntent: { kind: 'DROP', to: 'AssuranceIntent' },
  KodaXBudgetDisclosureZone: { kind: 'DROP', to: 'BudgetDisclosureZone' },
  KodaXBudgetExtensionRequest: { kind: 'DROP', to: 'BudgetExtensionRequest' },
  KodaXChildAgentResult: { kind: 'DROP', to: 'ChildAgentResult' },
  KodaXChildContextBundle: { kind: 'DROP', to: 'ChildContextBundle' },
  KodaXChildExecutionResult: { kind: 'DROP', to: 'ChildExecutionResult' },
  KodaXChildFinding: { kind: 'DROP', to: 'ChildFinding' },
  KodaXCodexCliProvider: { kind: 'DROP', to: 'CodexCliProvider' },
  KodaXCommand: { kind: 'DROP', to: 'Command' },
  KodaXCommandContext: { kind: 'DROP', to: 'CommandContext' },
  KodaXCompactMemoryProgress: { kind: 'DROP', to: 'CompactMemoryProgress' },
  KodaXCompactMemorySeed: { kind: 'DROP', to: 'CompactMemorySeed' },
  KodaXCompactionPromptSection: { kind: 'DROP', to: 'CompactionPromptSection' },
  KodaXCompactionPromptSnapshot: { kind: 'DROP', to: 'CompactionPromptSnapshot' },
  KodaXCompactionPromptVariant: { kind: 'DROP', to: 'CompactionPromptVariant' },
  KodaXContentBlock: { kind: 'DROP', to: 'ContentBlock' },
  KodaXContextOptions: { kind: 'DROP', to: 'ContextOptions' },
  KodaXContextTokenSnapshot: { kind: 'DROP', to: 'ContextTokenSnapshot' },
  KodaXCustomProviderConfig: { kind: 'DROP', to: 'CustomProviderConfig' },
  KodaXExecutionMode: { kind: 'DROP', to: 'ExecutionMode' },
  KodaXExecutionPattern: { kind: 'DROP', to: 'ExecutionPattern' },
  KodaXExtensionAPI: { kind: 'DROP', to: 'ExtensionAPI' },
  KodaXExtensionActivationResult: { kind: 'DROP', to: 'ExtensionActivationResult' },
  KodaXExtensionModule: { kind: 'DROP', to: 'ExtensionModule' },
  KodaXExtensionRuntime: { kind: 'DROP', to: 'ExtensionRuntime' },
  KodaXExtensionSessionRecord: { kind: 'DROP', to: 'ExtensionSessionRecord' },
  KodaXExtensionSessionState: { kind: 'DROP', to: 'ExtensionSessionState' },
  KodaXExtensionStore: { kind: 'DROP', to: 'ExtensionStore' },
  KodaXExtensionStoreEntry: { kind: 'DROP', to: 'ExtensionStoreEntry' },
  KodaXFanoutBranchLifecycle: { kind: 'DROP', to: 'FanoutBranchLifecycle' },
  KodaXFanoutBranchRecord: { kind: 'DROP', to: 'FanoutBranchRecord' },
  KodaXFanoutBranchTransition: { kind: 'DROP', to: 'FanoutBranchTransition' },
  KodaXFanoutSchedulerInput: { kind: 'DROP', to: 'FanoutSchedulerInput' },
  KodaXFanoutSchedulerPlan: { kind: 'DROP', to: 'FanoutSchedulerPlan' },
  KodaXGeminiCliProvider: { kind: 'DROP', to: 'GeminiCliProvider' },
  KodaXHarnessProfile: { kind: 'DROP', to: 'HarnessProfile' },
  KodaXImageBlock: { kind: 'DROP', to: 'ImageBlock' },
  KodaXInputArtifact: { kind: 'DROP', to: 'InputArtifact' },
  KodaXIntentGateDecision: { kind: 'DROP', to: 'IntentGateDecision' },
  KodaXJsonPrimitive: { kind: 'DROP', to: 'JsonPrimitive' },
  KodaXJsonValue: { kind: 'DROP', to: 'JsonValue' },
  KodaXManagedBudgetSnapshot: { kind: 'DROP', to: 'ManagedBudgetSnapshot' },
  KodaXManagedContractPayload: { kind: 'DROP', to: 'ManagedContractPayload' },
  KodaXManagedHandoffPayload: { kind: 'DROP', to: 'ManagedHandoffPayload' },
  KodaXManagedLiveEvent: { kind: 'DROP', to: 'ManagedLiveEvent' },
  KodaXManagedLiveEventPresentation: { kind: 'DROP', to: 'ManagedLiveEventPresentation' },
  KodaXManagedProtocolPayload: { kind: 'DROP', to: 'ManagedProtocolPayload' },
  KodaXManagedScoutPayload: { kind: 'DROP', to: 'ManagedScoutPayload' },
  KodaXManagedTask: { kind: 'DROP', to: 'ManagedTask' },
  KodaXManagedTaskHarnessTransition: { kind: 'DROP', to: 'ManagedTaskHarnessTransition' },
  KodaXManagedTaskPhase: { kind: 'DROP', to: 'ManagedTaskPhase' },
  KodaXManagedTaskRuntimeState: { kind: 'DROP', to: 'ManagedTaskRuntimeState' },
  KodaXManagedTaskStatusEvent: { kind: 'DROP', to: 'ManagedTaskStatusEvent' },
  KodaXManagedVerdictPayload: { kind: 'DROP', to: 'ManagedVerdictPayload' },
  KodaXMcpConnectMode: { kind: 'DROP', to: 'McpConnectMode' },
  KodaXMcpServerConfig: { kind: 'DROP', to: 'McpServerConfig' },
  KodaXMcpServersConfig: { kind: 'DROP', to: 'McpServersConfig' },
  KodaXMcpTransport: { kind: 'DROP', to: 'McpTransport' },
  KodaXMemoryStrategy: { kind: 'DROP', to: 'MemoryStrategy' },
  KodaXMessage: { kind: 'DROP', to: 'Message' },
  KodaXModelDescriptor: { kind: 'DROP', to: 'ModelDescriptor' },
  KodaXMutationSurface: { kind: 'DROP', to: 'MutationSurface' },
  KodaXOrchestrationVerdict: { kind: 'DROP', to: 'OrchestrationVerdict' },
  KodaXParentReductionContract: { kind: 'DROP', to: 'ParentReductionContract' },
  KodaXPromptSection: { kind: 'DROP', to: 'PromptSection' },
  KodaXPromptSectionDefinition: { kind: 'DROP', to: 'PromptSectionDefinition' },
  KodaXPromptSectionSlot: { kind: 'DROP', to: 'PromptSectionSlot' },
  KodaXPromptSectionStability: { kind: 'DROP', to: 'PromptSectionStability' },
  KodaXPromptSnapshot: { kind: 'DROP', to: 'PromptSnapshot' },
  KodaXPromptSnapshotMetadata: { kind: 'DROP', to: 'PromptSnapshotMetadata' },
  KodaXProtocolFamily: { kind: 'DROP', to: 'ProtocolFamily' },
  KodaXProviderCapabilityProfile: { kind: 'DROP', to: 'ProviderCapabilityProfile' },
  KodaXProviderCapabilitySnapshot: { kind: 'DROP', to: 'ProviderCapabilitySnapshot' },
  KodaXProviderConfig: { kind: 'DROP', to: 'ProviderConfig' },
  KodaXProviderContextFidelity: { kind: 'DROP', to: 'ProviderContextFidelity' },
  KodaXProviderConversationSemantics: { kind: 'DROP', to: 'ProviderConversationSemantics' },
  KodaXProviderEvidenceSupport: { kind: 'DROP', to: 'ProviderEvidenceSupport' },
  KodaXProviderLongRunningSupport: { kind: 'DROP', to: 'ProviderLongRunningSupport' },
  KodaXProviderMcpSupport: { kind: 'DROP', to: 'ProviderMcpSupport' },
  KodaXProviderMultimodalSupport: { kind: 'DROP', to: 'ProviderMultimodalSupport' },
  KodaXProviderPolicyDecision: { kind: 'DROP', to: 'ProviderPolicyDecision' },
  KodaXProviderPolicyHints: { kind: 'DROP', to: 'ProviderPolicyHints' },
  KodaXProviderPolicyIssue: { kind: 'DROP', to: 'ProviderPolicyIssue' },
  KodaXProviderPolicyIssueSeverity: { kind: 'DROP', to: 'ProviderPolicyIssueSeverity' },
  KodaXProviderSessionSupport: { kind: 'DROP', to: 'ProviderSessionSupport' },
  KodaXProviderSourceKind: { kind: 'DROP', to: 'ProviderSourceKind' },
  KodaXProviderStreamOptions: { kind: 'DROP', to: 'ProviderStreamOptions' },
  KodaXProviderToolCallingFidelity: { kind: 'DROP', to: 'ProviderToolCallingFidelity' },
  KodaXProviderTransport: { kind: 'DROP', to: 'ProviderTransport' },
  KodaXProviderUserAgentMode: { kind: 'DROP', to: 'ProviderUserAgentMode' },
  KodaXReasoningCapability: { kind: 'DROP', to: 'ReasoningCapability' },
  KodaXReasoningMode: { kind: 'DROP', to: 'ReasoningMode' },
  KodaXReasoningOverride: { kind: 'DROP', to: 'ReasoningOverride' },
  KodaXReasoningRequest: { kind: 'DROP', to: 'ReasoningRequest' },
  KodaXRedactedThinkingBlock: { kind: 'DROP', to: 'RedactedThinkingBlock' },
  KodaXRepoIntelligenceCapability: { kind: 'DROP', to: 'RepoIntelligenceCapability' },
  KodaXRepoIntelligenceCarrier: { kind: 'DROP', to: 'RepoIntelligenceCarrier' },
  KodaXRepoIntelligenceMode: { kind: 'DROP', to: 'RepoIntelligenceMode' },
  KodaXRepoIntelligenceResolvedMode: { kind: 'DROP', to: 'RepoIntelligenceResolvedMode' },
  KodaXRepoIntelligenceTrace: { kind: 'DROP', to: 'RepoIntelligenceTrace' },
  KodaXRepoIntelligenceTraceEvent: { kind: 'DROP', to: 'RepoIntelligenceTraceEvent' },
  KodaXRepoRoutingSignals: { kind: 'DROP', to: 'RepoRoutingSignals' },
  KodaXResult: { kind: 'DROP', to: 'Result' },
  KodaXRetrievalArtifact: { kind: 'DROP', to: 'RetrievalArtifact' },
  KodaXRetrievalFreshness: { kind: 'DROP', to: 'RetrievalFreshness' },
  KodaXRetrievalItem: { kind: 'DROP', to: 'RetrievalItem' },
  KodaXRetrievalResult: { kind: 'DROP', to: 'RetrievalResult' },
  KodaXRetrievalScope: { kind: 'DROP', to: 'RetrievalScope' },
  KodaXRetrievalToolName: { kind: 'DROP', to: 'RetrievalToolName' },
  KodaXRetrievalTrust: { kind: 'DROP', to: 'RetrievalTrust' },
  KodaXReviewScale: { kind: 'DROP', to: 'ReviewScale' },
  KodaXRiskLevel: { kind: 'DROP', to: 'RiskLevel' },
  KodaXRoleRoundSummary: { kind: 'DROP', to: 'RoleRoundSummary' },
  KodaXRuntimeVerificationContract: { kind: 'DROP', to: 'RuntimeVerificationContract' },
  KodaXScoutSuspiciousSignal: { kind: 'DROP', to: 'ScoutSuspiciousSignal' },
  KodaXSessionArchiveMarkerEntry: { kind: 'DROP', to: 'SessionArchiveMarkerEntry' },
  KodaXSessionArtifactLedgerEntry: { kind: 'DROP', to: 'SessionArtifactLedgerEntry' },
  KodaXSessionBranchSummaryEntry: { kind: 'DROP', to: 'SessionBranchSummaryEntry' },
  // Per design doc §FEATURE_086: drop BOTH prefixes, CompactionEntry is unique enough
  KodaXSessionCompactionEntry: { kind: 'DROP', to: 'CompactionEntry' },
  KodaXSessionData: { kind: 'DROP', to: 'SessionData' },
  KodaXSessionEntry: { kind: 'DROP', to: 'SessionEntry' },
  KodaXSessionEntryBase: { kind: 'DROP', to: 'SessionEntryBase' },
  KodaXSessionLabelEntry: { kind: 'DROP', to: 'SessionLabelEntry' },
  KodaXSessionMessageEntry: { kind: 'DROP', to: 'SessionMessageEntry' },
  KodaXSessionMeta: { kind: 'DROP', to: 'SessionMeta' },
  KodaXSessionNavigationOptions: { kind: 'DROP', to: 'SessionNavigationOptions' },
  KodaXSessionOptions: { kind: 'DROP', to: 'SessionOptions' },
  KodaXSessionRuntimeInfo: { kind: 'DROP', to: 'SessionRuntimeInfo' },
  KodaXSessionScope: { kind: 'DROP', to: 'SessionScope' },
  KodaXSessionStorage: { kind: 'DROP', to: 'SessionStorage' },
  KodaXSessionTreeNode: { kind: 'DROP', to: 'SessionTreeNode' },
  KodaXSessionUiHistoryItem: { kind: 'DROP', to: 'SessionUiHistoryItem' },
  KodaXSessionUiHistoryItemType: { kind: 'DROP', to: 'SessionUiHistoryItemType' },
  KodaXSessionWorkspaceKind: { kind: 'DROP', to: 'SessionWorkspaceKind' },
  KodaXSkillInvocationContext: { kind: 'DROP', to: 'SkillInvocationContext' },
  KodaXSkillMap: { kind: 'DROP', to: 'SkillMap' },
  KodaXSkillProjectionConfidence: { kind: 'DROP', to: 'SkillProjectionConfidence' },
  KodaXStreamResult: { kind: 'DROP', to: 'StreamResult' },
  KodaXTaskActionability: { kind: 'DROP', to: 'TaskActionability' },
  KodaXTaskBudgetOverrides: { kind: 'DROP', to: 'TaskBudgetOverrides' },
  KodaXTaskCapabilityHint: { kind: 'DROP', to: 'TaskCapabilityHint' },
  KodaXTaskComplexity: { kind: 'DROP', to: 'TaskComplexity' },
  KodaXTaskContract: { kind: 'DROP', to: 'TaskContract' },
  KodaXTaskEvidenceArtifact: { kind: 'DROP', to: 'TaskEvidenceArtifact' },
  KodaXTaskEvidenceBundle: { kind: 'DROP', to: 'TaskEvidenceBundle' },
  KodaXTaskEvidenceEntry: { kind: 'DROP', to: 'TaskEvidenceEntry' },
  KodaXTaskFamily: { kind: 'DROP', to: 'TaskFamily' },
  KodaXTaskRole: { kind: 'DROP', to: 'TaskRole' },
  KodaXTaskRoleAssignment: { kind: 'DROP', to: 'TaskRoleAssignment' },
  KodaXTaskRoutingDecision: { kind: 'DROP', to: 'TaskRoutingDecision' },
  KodaXTaskStatus: { kind: 'DROP', to: 'TaskStatus' },
  KodaXTaskSurface: { kind: 'DROP', to: 'TaskSurface' },
  KodaXTaskToolPolicy: { kind: 'DROP', to: 'TaskToolPolicy' },
  KodaXTaskType: { kind: 'DROP', to: 'TaskType' },
  KodaXTaskVerificationContract: { kind: 'DROP', to: 'TaskVerificationContract' },
  KodaXTaskVerificationCriterion: { kind: 'DROP', to: 'TaskVerificationCriterion' },
  KodaXTaskWorkIntent: { kind: 'DROP', to: 'TaskWorkIntent' },
  KodaXTaskWorkItem: { kind: 'DROP', to: 'TaskWorkItem' },
  KodaXTextBlock: { kind: 'DROP', to: 'TextBlock' },
  KodaXThinkingBlock: { kind: 'DROP', to: 'ThinkingBlock' },
  KodaXThinkingBudgetMap: { kind: 'DROP', to: 'ThinkingBudgetMap' },
  KodaXThinkingDepth: { kind: 'DROP', to: 'ThinkingDepth' },
  KodaXTokenUsage: { kind: 'DROP', to: 'TokenUsage' },
  KodaXToolExecutionContext: { kind: 'DROP', to: 'ToolExecutionContext' },
  KodaXToolResultBlock: { kind: 'DROP', to: 'ToolResultBlock' },
  KodaXToolUseBlock: { kind: 'DROP', to: 'ToolUseBlock' },
  KodaXVerificationScorecard: { kind: 'DROP', to: 'VerificationScorecard' },
  KodaXVerificationScorecardCriterion: { kind: 'DROP', to: 'VerificationScorecardCriterion' },
};

// ============== Self-check invariants ==============

const totals = (() => {
  const counts = { KEEP: 0, DROP: 0, INTERNALIZE: 0, MERGE: 0, REMOVE: 0 };
  for (const decision of Object.values(KODAX_RENAME_MAP)) {
    counts[decision.kind] += 1;
  }
  return counts;
})();

// Expected distribution (locked by design doc §FEATURE_086 子任务 A):
//   KEEP: 11 (8 errors + KodaXClient + KodaXOptions + KodaXEvents)
//   DROP: 176 (everything else, including 2 double-prefix drops)
//   INTERNALIZE: 1 (KodaXAmaControllerDecision)
//   MERGE: 1 (KodaXToolDefinition → Tool)
//   REMOVE: 1 (KodaXSessionLineage)
//   TOTAL: 190
export const KODAX_RENAME_MAP_TOTALS = totals;
