/**
 * FEATURE_093 (v0.7.24): minimal contract interface for the coding extension
 * runtime. Extracted so `@kodax/coding/src/types.ts` can reference the
 * extension runtime at the type level without importing `./extensions/runtime.js`,
 * which in turn imports from `types.ts` — a cycle that lasted since v0.7.20.
 *
 * Scope: only the methods that `KodaXOptions.extensionRuntime` and
 * `KodaXToolExecutionContext.extensionRuntime` consumers actually invoke.
 * The concrete `KodaXExtensionRuntime` class in `./runtime.ts` implements
 * this contract plus ~40 additional internal methods that are not exposed
 * through Options/Context fields.
 *
 * File must have NO imports from `../types.js` (that is the cycle we are
 * breaking). Capability types come from `@kodax/core`.
 */

import type { CapabilityKind, CapabilityResult } from '@kodax/core';

export interface ExtensionRuntimeContract {
  searchCapabilities(
    providerId: string,
    query: string,
    options?: { kind?: CapabilityKind; limit?: number; server?: string },
  ): Promise<unknown[]>;

  describeCapability(providerId: string, capabilityId: string): Promise<unknown>;

  executeCapability(
    providerId: string,
    capabilityId: string,
    input: Record<string, unknown>,
  ): Promise<CapabilityResult>;

  readCapability(
    providerId: string,
    capabilityId: string,
    options?: Record<string, unknown>,
  ): Promise<CapabilityResult>;

  getCapabilityPrompt(
    providerId: string,
    capabilityId: string,
    args?: Record<string, unknown>,
  ): Promise<unknown>;

  getCapabilityPromptContext(providerId: string): Promise<string | undefined>;
}
