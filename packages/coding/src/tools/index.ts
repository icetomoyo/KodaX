/**
 * KodaX Tools
 *
 * 工具模块统一导出
 */

export type {
  ToolHandler,
  ToolRegistry,
  ToolSideEffect,
  LocalToolDefinition,
  RegisteredToolDefinition,
  ToolDefinitionSource,
  ToolRegistrationOptions,
  RuntimeRemoteToolContract,
  RuntimeRemoteToolContext,
  RuntimeRemoteToolDecision,
  RuntimeRemoteWorkspaceBroker,
  KodaXRetrievalToolName,
  KodaXRetrievalScope,
  KodaXRetrievalTrust,
  KodaXRetrievalFreshness,
  KodaXRetrievalArtifact,
  KodaXRetrievalItem,
  KodaXRetrievalResult,
} from './types.js';
export {
  KODAX_TOOLS,
  REPO_INTELLIGENCE_WORKING_TOOL_NAMES,
  registerTool,
  getTool,
  getToolDefinition,
  getRegisteredToolDefinition,
  getToolRegistrations,
  getBuiltinToolDefinition,
  getBuiltinRegisteredToolDefinition,
  createBuiltinToolDefinition,
  listBuiltinToolDefinitions,
  getAllRegisteredTools,
  isToolPlanModeAllowed,
  isToolFileMutation,
  isToolNetworkRead,
  isToolMutation,
  getRequiredToolParams,
  listTools,
  listToolDefinitions,
  isRepoIntelligenceWorkingToolName,
  filterRepoIntelligenceWorkingToolNames,
  filterMcpToolNames,
  MCP_TOOL_NAMES,
  executeTool,
} from './registry.js';
export { toolRead } from './read.js';
export { toolWrite } from './write.js';
export {
  toolEdit,
  inspectEditFailure,
  parseEditToolError,
  type EditRecoveryDiagnostic,
  type EditToolErrorCode,
} from './edit.js';
export { toolInsertAfterAnchor } from './insert-after-anchor.js';
export { toolBash } from './bash.js';
export { toolRunSkillScript } from './skill-script.js';
export { toolGlob } from './glob.js';
export { toolGrep } from './grep.js';
export { toolUndo } from './undo.js';
export {
  activateSessionHistoryTools,
  SESSION_HISTORY_READ_TOOL_NAME,
  SESSION_HISTORY_SEARCH_TOOL_NAME,
  SESSION_HISTORY_TOOL_NAMES,
  toolSessionHistoryRead,
  toolSessionHistorySearch,
} from './session-history.js';
export { toolAskUserQuestion } from './ask-user-question.js';
export { toolExitPlanMode } from './exit-plan-mode.js';
export { toolRepoOverview } from './repo-overview.js';
export { toolChangedScope } from './changed-scope.js';
export { toolChangedDiff, toolChangedDiffBundle } from './changed-diff.js';
export { toolModuleContext } from './module-context.js';
export { toolSymbolContext } from './symbol-context.js';
export { toolProcessContext } from './process-context.js';
export { toolImpactEstimate } from './impact-estimate.js';
export { toolWebSearch } from './web-search.js';
export { toolWebFetch } from './web-fetch.js';
export { toolCodeSearch } from './code-search.js';
export { toolSemanticLookup } from './semantic-lookup.js';
export { toolMcpSearch } from './mcp-search.js';
export { toolMcpDescribe } from './mcp-describe.js';
export { toolMcpCall } from './mcp-call.js';
export { toolMcpReadResource } from './mcp-read-resource.js';
export { toolMcpGetPrompt } from './mcp-get-prompt.js';
export { toolWorktreeCreate, toolWorktreeRemove } from './worktree.js';
export {
  toolAgentOutput,
  toolFollowupTask,
  toolInterruptAgent,
  toolListAgents,
  toolSendAgentMessage,
  toolSpawnAgent,
  toolWaitAgent,
} from './agent-collaboration.js';
export {
  CONSTRUCTION_TOOL_NAMES,
  isConstructionToolName,
  filterConstructionToolNames,
  toolScaffoldTool,
  toolValidateTool,
  toolStageConstruction,
  toolTestTool,
  toolActivateTool,
} from './construction.js';
export {
  AGENT_CONSTRUCTION_TOOL_NAMES,
  filterAgentConstructionToolNames,
} from './agent-construction.js';
export {
  stripHtmlToText,
  extractHtmlTitle,
  renderRetrievalResult,
  finalizeRetrievalResult,
  convertProviderSearchResults,
  convertCapabilityReadResult,
} from './retrieval.js';
export {
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_MAX_LINES,
  READ_DEFAULT_LIMIT,
  READ_PREFLIGHT_SIZE_BYTES,
  READ_MAX_LINE_CHARS,
  formatSize,
  truncateHead,
  truncateTail,
  truncateLine,
  persistToolOutput,
  resolveToolOutputDir,
} from './truncate.js';
export {
  cleanupExpiredToolOutputs,
  cleanupUnreferencedToolOutputs,
  maybeRunReferenceAwareToolOutputGc,
  maybeRunToolOutputGc,
} from './tool-output-gc.js';
export type { ToolOutputGcResult } from './tool-output-gc.js';
export {
  applyToolResultGuardrail,
  getToolResultPolicy,
  ToolResultBatchCapacityError,
} from './tool-result-policy.js';
export type {
  GuardedToolResultBatch,
  ToolResultBatchDebt,
  ToolResultBatchEntry,
} from './tool-result-policy.js';
export {
  buildToolResultBudget,
  buildToolResultBudgetFromUsage,
  clampToolResultPolicyToBudget,
} from './tool-result-budget.js';
export type {
  ToolResultBudget,
  ToolResultBudgetReason,
  ToolResultBudgetUsageInput,
  ToolResultCapacity,
} from './tool-result-budget.js';
export {
  TOOL_CALL_DEFINITION,
  TOOL_CALL_NAME,
  TOOL_DESCRIBE_DEFINITION,
  TOOL_DESCRIBE_NAME,
  resolveToolBridgeTarget,
  type ToolBridgeTargetResolution,
} from './tool-bridge.js';
