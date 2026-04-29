/**
 * FEATURE_089 — admission-bridge unit tests.
 *
 * Pure function coverage: ref parsing + AgentContent → AgentManifest
 * lifting. No I/O, no registry needed.
 */

import { describe, expect, it } from 'vitest';

import { buildAdmissionManifest, parseToolNameFromRef } from './admission-bridge.js';
import type { AgentContent } from './types.js';

describe('parseToolNameFromRef', () => {
  it('extracts the bare name from a builtin: ref', () => {
    expect(parseToolNameFromRef('builtin:read')).toBe('read');
    expect(parseToolNameFromRef('builtin:bash')).toBe('bash');
  });

  it('strips the @version suffix from a constructed ref', () => {
    expect(parseToolNameFromRef('constructed:foo@1.0.0')).toBe('foo');
    expect(parseToolNameFromRef('constructed:my-tool@2.3.4')).toBe('my-tool');
  });

  it('returns the whole string when no scheme prefix is present (legacy fallback)', () => {
    expect(parseToolNameFromRef('plain-name')).toBe('plain-name');
  });
});

describe('buildAdmissionManifest', () => {
  it('lifts a minimal AgentContent to a Manifest with name + instructions', () => {
    const content: AgentContent = { instructions: 'do work' };
    const manifest = buildAdmissionManifest({ name: 'minimal', content });
    expect(manifest.name).toBe('minimal');
    expect(manifest.instructions).toBe('do work');
    expect(manifest.tools).toBeUndefined();
    expect(manifest.handoffs).toBeUndefined();
  });

  it('resolves tool refs to {name} structurally so admission can classify capability', () => {
    const content: AgentContent = {
      instructions: 'mix of refs',
      tools: [
        { ref: 'builtin:read' },
        { ref: 'constructed:my-tool@1.0.0' },
      ],
    };
    const manifest = buildAdmissionManifest({ name: 'm', content });
    expect(manifest.tools).toEqual([{ name: 'read' }, { name: 'my-tool' }]);
  });

  it('resolves handoff target refs to stub Agent objects (admission walks names)', () => {
    const content: AgentContent = {
      instructions: 'plan + delegate',
      handoffs: [
        { target: { ref: 'builtin:generator' }, kind: 'continuation' },
        { target: { ref: 'constructed:vuln-classifier@1.0.0' }, kind: 'as-tool', description: 'classify' },
      ],
    };
    const manifest = buildAdmissionManifest({ name: 'planner', content });
    expect(manifest.handoffs).toHaveLength(2);
    expect(manifest.handoffs?.[0]?.target.name).toBe('generator');
    expect(manifest.handoffs?.[0]?.kind).toBe('continuation');
    expect(manifest.handoffs?.[1]?.target.name).toBe('vuln-classifier');
    expect(manifest.handoffs?.[1]?.description).toBe('classify');
  });

  it('passes through reasoning / model / provider / outputSchema / maxBudget unchanged', () => {
    const content: AgentContent = {
      instructions: 'i',
      reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: true },
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      maxBudget: 5000,
    };
    const manifest = buildAdmissionManifest({ name: 'rich', content });
    expect(manifest.reasoning?.default).toBe('balanced');
    expect(manifest.model).toBe('claude-sonnet-4-6');
    expect(manifest.provider).toBe('anthropic');
    expect(manifest.outputSchema).toEqual({
      type: 'object',
      properties: { ok: { type: 'boolean' } },
    });
    expect(manifest.maxBudget).toBe(5000);
  });

  it('lifts guardrail refs to {kind, name} preserving the kind discriminant', () => {
    const content: AgentContent = {
      instructions: 'i',
      guardrails: [
        { kind: 'output', ref: 'builtin:pii-filter' },
        { kind: 'tool', ref: 'constructed:custom-gate@1.0.0' },
      ],
    };
    const manifest = buildAdmissionManifest({ name: 'g', content });
    expect(manifest.guardrails).toEqual([
      { kind: 'output', name: 'pii-filter' },
      { kind: 'tool', name: 'custom-gate' },
    ]);
  });

  it('passes declaredInvariants through unchanged so admission can surface unknown ids as errors', () => {
    // The bridge no longer filters unknown ids — admission's schema
    // validation (admission-audit.ts) catches them and produces a
    // retryable error the LLM can act on. This avoids hiding typos.
    const content: AgentContent = {
      instructions: 'i',
      declaredInvariants: ['harnessSelectionTiming', 'unknownInvariant', 'finalOwner'],
    };
    const manifest = buildAdmissionManifest({ name: 'd', content });
    expect(manifest.declaredInvariants).toEqual([
      'harnessSelectionTiming',
      'unknownInvariant',
      'finalOwner',
    ]);
  });

  it('omits empty optional fields (no spurious tools: [], handoffs: [], etc.)', () => {
    const content: AgentContent = { instructions: 'i', tools: [] };
    const manifest = buildAdmissionManifest({ name: 'empty', content });
    expect(manifest.tools).toBeUndefined();
  });
});
