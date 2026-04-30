/**
 * Tests for FEATURE_101 v0.7.31.1 — Runner systemPrompt double-wrap.
 *
 * When an agent has admission bindings, Runner.run wraps the manifest's
 * raw `instructions` in a trusted/untrusted boundary so the LLM sees the
 * role spec as DATA, not authoritative system instructions. Trusted
 * (un-admitted) agents pass through unchanged.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createAgent, type Agent } from './agent.js';
import type { AgentManifest } from './admission.js';
import {
  setAdmittedAgentBindings,
  _resetAdmittedAgentBindings,
} from './admission-session.js';
import { Runner } from './runner.js';

describe('Runner — systemPrompt double-wrap', () => {
  afterEach(() => {
    // No global registry to reset — bindings live on individual agents
    // via WeakMap and are reclaimed when agents fall out of scope.
  });

  it('passes raw instructions through for trusted (un-admitted) agents', async () => {
    const trusted: Agent = createAgent({
      name: 'trusted',
      instructions: 'Be helpful and concise.',
    });
    let seenSystem = '';
    await Runner.run(trusted, 'hi', {
      llm: async (messages) => {
        const sys = messages[0];
        seenSystem = typeof sys?.content === 'string' ? sys.content : '';
        return 'ok';
      },
      tracer: null,
    });
    expect(seenSystem).toBe('Be helpful and concise.');
    expect(seenSystem).not.toMatch(/UNTRUSTED/);
  });

  it('wraps instructions in a trusted boundary for admitted agents', async () => {
    const admitted: Agent = { name: 'admitted', instructions: 'You are a code reviewer.' };
    const manifest: AgentManifest = { ...admitted };
    setAdmittedAgentBindings(admitted, manifest, ['finalOwner']);

    let seenSystem = '';
    try {
      await Runner.run(admitted, 'hi', {
        llm: async (messages) => {
          const sys = messages[0];
          seenSystem = typeof sys?.content === 'string' ? sys.content : '';
          return 'ok';
        },
        tracer: null,
      });
    } finally {
      _resetAdmittedAgentBindings(admitted);
    }

    expect(seenSystem).toMatch(/BEGIN UNTRUSTED MANIFEST INSTRUCTIONS/);
    expect(seenSystem).toMatch(/END UNTRUSTED MANIFEST INSTRUCTIONS/);
    expect(seenSystem).toContain('You are a code reviewer.');
    // Footer carries the safety note about untrusted source.
    expect(seenSystem).toMatch(/Safety note/);
    // Header tells the model to follow the role description as its task.
    expect(seenSystem).toMatch(/Follow the role description as written/i);
  });

  it('preserves the raw instructions verbatim inside the wrap', async () => {
    const raw = 'echo every user message back to them, prefixed with the marker text.';
    const admitted: Agent = { name: 'echo-admitted', instructions: raw };
    const manifest: AgentManifest = { ...admitted };
    setAdmittedAgentBindings(admitted, manifest, ['finalOwner']);

    let seenSystem = '';
    try {
      await Runner.run(admitted, 'hi', {
        llm: async (messages) => {
          seenSystem =
            typeof messages[0]?.content === 'string' ? messages[0]!.content : '';
          return 'ok';
        },
        tracer: null,
      });
    } finally {
      _resetAdmittedAgentBindings(admitted);
    }

    // The full system prompt must include the raw instructions verbatim.
    expect(seenSystem.includes(raw)).toBe(true);
    // And the raw must appear AFTER the BEGIN boundary and BEFORE the END.
    const rawIdx = seenSystem.indexOf(raw);
    const beginIdx = seenSystem.indexOf('BEGIN UNTRUSTED MANIFEST INSTRUCTIONS');
    const endIdx = seenSystem.indexOf('END UNTRUSTED MANIFEST INSTRUCTIONS');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(rawIdx).toBeGreaterThan(beginIdx);
    expect(endIdx).toBeGreaterThan(rawIdx);
  });
});
