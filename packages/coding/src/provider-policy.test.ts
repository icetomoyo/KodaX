import { describe, expect, it } from 'vitest';
import {
  buildProviderCapabilitySnapshot,
  buildProviderPolicyPromptNotes,
  evaluateProviderPolicy,
} from './provider-policy.js';

const CLI_BRIDGE_PROFILE = {
  transport: 'cli-bridge',
  conversationSemantics: 'last-user-message',
  mcpSupport: 'none',
  contextFidelity: 'lossy',
  toolCallingFidelity: 'limited',
  sessionSupport: 'stateless',
  longRunningSupport: 'limited',
  multimodalSupport: 'none',
  evidenceSupport: 'limited',
} as const;

const NATIVE_MCP_PROFILE = {
  transport: 'native-api',
  conversationSemantics: 'full-history',
  mcpSupport: 'native',
  contextFidelity: 'full',
  toolCallingFidelity: 'full',
  sessionSupport: 'full',
  longRunningSupport: 'full',
  multimodalSupport: 'none',
  evidenceSupport: 'full',
} as const;

const IMAGE_INPUT_NATIVE_PROFILE = {
  ...NATIVE_MCP_PROFILE,
  multimodalSupport: 'image-input',
} as const;

describe('provider policy', () => {
  it('builds a normalized capability snapshot for bridge providers', () => {
    const snapshot = buildProviderCapabilitySnapshot({
      providerName: 'gemini-cli',
      capabilityProfile: CLI_BRIDGE_PROFILE,
      reasoningCapability: 'prompt-only',
    });

    expect(snapshot).toEqual({
      provider: 'gemini-cli',
      model: undefined,
      sourceKind: 'builtin',
      transport: 'cli-bridge',
      conversationSemantics: 'last-user-message',
      mcpSupport: 'none',
      contextFidelity: 'lossy',
      toolCallingFidelity: 'limited',
      sessionSupport: 'stateless',
      longRunningSupport: 'limited',
      multimodalSupport: 'none',
      evidenceSupport: 'limited',
      reasoningCapability: 'prompt-only',
    });
  });

  it('blocks long-running work on lossy bridge providers', () => {
    const decision = evaluateProviderPolicy({
      providerName: 'gemini-cli',
      capabilityProfile: CLI_BRIDGE_PROFILE,
      reasoningCapability: 'prompt-only',
      hints: {
        longRunning: true,
      },
      reasoningMode: 'off',
    });

    expect(decision.status).toBe('block');
    expect(decision.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['long-running-blocked']),
    );
  });

  it('keeps text-only MCP mentions out of hard gates', () => {
    const decision = evaluateProviderPolicy({
      providerName: 'gemini-cli',
      capabilityProfile: CLI_BRIDGE_PROFILE,
      reasoningCapability: 'prompt-only',
      prompt: 'Please explain what MCP is and how KodaX uses it.',
      reasoningMode: 'off',
    });

    expect(decision.status).toBe('allow');
    expect(decision.issues).toEqual([]);
  });

  it('keeps text-only project mode mentions out of hard gates', () => {
    const decision = evaluateProviderPolicy({
      providerName: 'gemini-cli',
      capabilityProfile: CLI_BRIDGE_PROFILE,
      reasoningCapability: 'prompt-only',
      prompt: 'Write release notes about the new project mode behavior.',
      reasoningMode: 'off',
    });

    expect(decision.status).toBe('allow');
    expect(decision.issues).toEqual([]);
  });

  it('keeps text-only screenshot support mentions out of hard gates', () => {
    const decision = evaluateProviderPolicy({
      providerName: 'gemini-cli',
      capabilityProfile: CLI_BRIDGE_PROFILE,
      reasoningCapability: 'prompt-only',
      prompt: 'Write release notes for the new screenshot support.',
      reasoningMode: 'off',
    });

    expect(decision.status).toBe('allow');
    expect(decision.issues).toEqual([]);
  });

  it('warns on evidence-heavy bridge flows without blocking simple execution', () => {
    const decision = evaluateProviderPolicy({
      providerName: 'gemini-cli',
      capabilityProfile: CLI_BRIDGE_PROFILE,
      reasoningCapability: 'prompt-only',
      hints: {
        evidenceHeavy: true,
      },
      reasoningMode: 'off',
    });

    expect(decision.status).toBe('warn');
    expect(decision.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'evidence-context-loss',
        'evidence-support-limited',
      ]),
    );
  });

  it('warns rather than blocks plan-execute-eval routing on bridge providers', () => {
    const decision = evaluateProviderPolicy({
      providerName: 'gemini-cli',
      capabilityProfile: CLI_BRIDGE_PROFILE,
      reasoningCapability: 'prompt-only',
      hints: {
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
      },
      reasoningMode: 'balanced',
    });

    expect(decision.status).toBe('warn');
    expect(decision.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'plan-execute-eval-bridge',
      ]),
    );
  });

  it('blocks multimodal and MCP-required flows when the provider does not support them', () => {
    const decision = evaluateProviderPolicy({
      providerName: 'codex-cli',
      capabilityProfile: CLI_BRIDGE_PROFILE,
      reasoningCapability: 'prompt-only',
      hints: {
        multimodal: true,
        mcpRequired: true,
      },
      reasoningMode: 'off',
    });

    expect(decision.status).toBe('block');
    expect(decision.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'multimodal-unsupported',
        'mcp-required',
      ]),
    );
  });

  it('still blocks explicit capability and multimodal requirements when hints are structured', () => {
    const decision = evaluateProviderPolicy({
      providerName: 'codex-cli',
      capabilityProfile: CLI_BRIDGE_PROFILE,
      reasoningCapability: 'prompt-only',
      hints: {
        capabilityRuntime: true,
        mcpRequired: true,
        multimodal: true,
      },
      reasoningMode: 'off',
    });

    expect(decision.status).toBe('block');
    expect(decision.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'mcp-required',
        'multimodal-unsupported',
      ]),
    );
  });

  it('detects image artifacts from context and allows them on image-input native providers', () => {
    const decision = evaluateProviderPolicy({
      providerName: 'openai',
      capabilityProfile: IMAGE_INPUT_NATIVE_PROFILE,
      reasoningCapability: 'native-effort',
      context: {
        inputArtifacts: [
          {
            kind: 'image',
            path: 'C:/repo/assets/mockup.png',
            source: 'user-inline',
            mediaType: 'image/png',
          },
        ],
      },
      reasoningMode: 'balanced',
    });

    expect(decision.status).toBe('allow');
    expect(decision.issues).toEqual([]);
  });

  it('allows MCP-native capability workflows on full native providers', () => {
    const decision = evaluateProviderPolicy({
      providerName: 'openai',
      capabilityProfile: NATIVE_MCP_PROFILE,
      reasoningCapability: 'native-effort',
      hints: {
        capabilityRuntime: true,
        mcpRequired: true,
      },
      reasoningMode: 'balanced',
    });

    expect(decision.status).toBe('allow');
    expect(decision.issues).toEqual([]);
  });

  it('renders provider prompt notes with semantics and constraints', () => {
    const decision = evaluateProviderPolicy({
      providerName: 'gemini-cli',
      capabilityProfile: CLI_BRIDGE_PROFILE,
      reasoningCapability: 'prompt-only',
      hints: {
        evidenceHeavy: true,
      },
      reasoningMode: 'balanced',
    });

    expect(buildProviderPolicyPromptNotes(decision)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('[Provider Policy] provider=gemini-cli'),
        expect.stringContaining('[Provider Semantics] transport=cli-bridge; context=lossy'),
        expect.stringContaining('[Provider Constraint] WARN:'),
      ]),
    );
  });
});
