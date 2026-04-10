/**
 * KodaX Provider Resilience Module (Feature 045)
 *
 * Provides structured failure recovery for provider API calls:
 * - Fine-grained error classification with failure stages
 * - 4-step recovery ladder (fresh retry → boundary retry → fallback → manual)
 * - Stable boundary tracking for safe mid-stream recovery
 * - Tool side-effect replay prevention
 * - Configurable timeouts and retry policies
 *
 * This module is purely additive — it does not modify the existing
 * withRetry/classifyError infrastructure. Integration with agent.ts
 * happens via the ProviderRecoveryCoordinator.
 */

// ============== Types ==============
export type {
  ResilienceErrorClass,
  FailureStage,
  RecoveryAction,
  RecoveryLadderStep,
  ResilienceClassification,
  ProviderExecutionState,
  RecoveryDecision,
  RecoveryResult,
  ProviderRecoveryEvent,
  ProviderResilienceConfig,
  ProviderResiliencePolicy,
} from './types.js';

// ============== Config ==============
export {
  DEFAULT_RESILIENCE_CONFIG,
  resolveResilienceConfig,
} from './config.js';

// ============== Classifier ==============
export {
  classifyResilienceError,
} from './classifier.js';

// ============== Stable Boundary ==============
export {
  StableBoundaryTracker,
} from './stable-boundary.js';

// ============== Recovery Coordinator ==============
export {
  ProviderRecoveryCoordinator,
} from './recovery-coordinator.js';

// ============== Tool Guard ==============
export {
  reconstructMessagesWithToolGuard,
} from './tool-guard.js';

// ============== Non-Streaming Fallback ==============
export {
  executeNonStreamingFallback,
  providerSupportsFallback,
} from './non-streaming-fallback.js';

// ============== Telemetry ==============
export {
  telemetryClassify,
  telemetryDecision,
  telemetryBoundary,
  telemetryRecovery,
} from './telemetry.js';
