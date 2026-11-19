import { staticText } from '../prompts/static-text.js';

/**
 * FEATURE_218 — the single short prompt rule that routes product questions to
 * the kodax_manual tool. Kept ≤250 tokens so the base/system prompt cache
 * region stays clean (no manual content injected here — read on demand).
 * FEATURE_221 — `productName` re-brands the rule for SDK consumers (e.g. a
 * product built on KodaX); defaults to "KodaX".
 */

export function buildSelfKnowledgeRoutingRule(productName = 'KodaX'): string {
  // FEATURE_221: the ~/.kodax / KODAX_* config-path specifics only belong on
  // KodaX's own rule; a re-branded product keeps the anti-Claude-Code/Codex
  // framing without leaking KodaX paths into the system prompt. Matches
  // `scopeAnchor` + the kodax_manual tool description. Default byte-identical.
  const configLines = productName === 'KodaX'
    ? [
        `Claude Code and Codex CLI knowledge that does not match ${productName} — ${productName} uses`,
        '~/.kodax/config.json and KODAX_* env vars, not .claude/settings.json or',
        'config.toml. Only bring up Claude Code or Codex when the user explicitly asks',
      ]
    : [
        `Claude Code and Codex CLI knowledge that does not match ${productName}.`,
        'Only bring up Claude Code or Codex when the user explicitly asks',
      ];
  return [
    `${productName} self-knowledge: when the user asks how to use, install, configure,`,
    `troubleshoot, or extend ${productName} itself — providers, custom providers, config,`,
    'permissions, slash commands, tools, custom agents, skills, extensions, MCP, repo',
    'intelligence, sessions, the doctor command, or the SDK — call the',
    'kodax_manual tool first and answer from it.',
    '',
    `Treat kodax_manual as the version-bound source of truth for ${productName} product`,
    'behavior. Do not answer these from pretraining, because pretraining mixes in',
    ...configLines,
    'to compare. Project AGENTS.md still governs work in the current repo; the',
    `manual governs questions about ${productName} as a product.`,
  ].join('\n');
}

/** The Worker's dense wording, for a Worker that has the kodax_manual tool. */
export function buildWorkerSelfKnowledgeRoutingRule(productName = 'KodaX'): string {
  return staticText("self-knowledge.worker-routing-rule").replaceAll('KodaX', productName);
}

/** Default KodaX routing rule (backward-compatible const). */
export const SELF_KNOWLEDGE_ROUTING_RULE = buildSelfKnowledgeRoutingRule();
