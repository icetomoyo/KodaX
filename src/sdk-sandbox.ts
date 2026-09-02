/**
 * SDK subpath entry — `@kodax-ai/kodax/sandbox`.
 *
 * Sandbox is a standalone containment capability. Auto[LLM] uses it for
 * selected shell calls, while SDK embedders can independently run their own
 * commands or scripts with explicit filesystem, network, environment, output,
 * and timeout controls.
 */

export {
  KODAX_ASRT_VERSION,
  doctorSandboxExecution as doctorKodaXSandbox,
  prepareSandboxRuntimeForSetup as activateKodaXSandbox,
  runKodaXSandboxed,
  sandboxRuntimeCapability as getKodaXSandboxCapability,
  sandboxSetupGuidance as getKodaXSandboxSetupGuidance,
  setupSandboxRuntime as setupKodaXSandbox,
} from './sandbox-runtime.js';

export type {
  KodaXSandboxFilesystemPolicy,
  KodaXSandboxCapability,
  KodaXSandboxNetworkPolicy,
  KodaXSandboxRunInput,
  KodaXSandboxRunResult,
  SandboxRuntimeDoctorResult as KodaXSandboxDoctorResult,
  SandboxSetupOutcome as KodaXSandboxSetupOutcome,
} from './sandbox-runtime.js';
