import { staticText } from '../prompts/static-text.js';
/**
 * FEATURE_218 / FEATURE_221 — the `kodax_manual` tool DESCRIPTION the model
 * reads (deciding when to call the tool), built from a product name so an SDK
 * consumer can white-label it. Sibling to `buildSelfKnowledgeRoutingRule` in
 * routing-rule.ts.
 *
 * `buildManualToolDescription()` (default 'KodaX') is the single source of truth
 * for the built-in tool description — `BUILTIN_TOOL_DEFINITIONS` uses it, so the
 * default output is byte-identical to the prior literal (pinned by a test). The
 * KodaX-specific config-path clause (`~/.kodax/config.json` + `KODAX_*`) is
 * gated on `productName === 'KodaX'`, matching `scopeAnchor`'s existing rule, so
 * a re-branded product does not leak KodaX config paths into the model's tool
 * surface.
 */

const DEFAULT_PRODUCT_NAME = 'KodaX';

export function buildManualToolDescription(productName = DEFAULT_PRODUCT_NAME): string {
  const name = productName.trim() || DEFAULT_PRODUCT_NAME;
  // Only KodaX's own manual asserts the ~/.kodax / KODAX_* paths; a re-branded
  // product keeps the anti-Claude-Code/Codex framing without KodaX specifics.
  const configClause = name === DEFAULT_PRODUCT_NAME
    ? ` — ${name} uses ~/.kodax/config.json and KODAX_* env vars, not .claude/settings.json or config.toml.`
    : '.';
  return [
    `Look up how to use, install, configure, troubleshoot, or extend ${name} itself.`,
    staticText("t12.self-knowledge/tool-description.0"),
    `Call this first for any "how do I … in ${name}" question and answer from its result.`,
    `Do not answer ${name} product questions from pretraining, because pretraining mixes in Claude Code and Codex CLI details that do not match ${name}${configClause}`,
    'Pass an exact topic id, or a free-text query, or neither to get the topic index. It explains where to check a value rather than reading your secrets.',
  ].join('\n');
}

/**
 * Re-brand the `kodax_manual` tool description with the consumer's product name
 * when building the model-visible tool list. Returns the def unchanged for any
 * other tool, or when no (or the default 'KodaX') product name is set — so the
 * default Coding Agent tool surface is byte-identical. Generic over the def
 * shape so both the SA (`getActiveToolDefinitions`) and AMA
 * (`buildAgentToolsFromRegistry`) assembly paths can share it.
 */
export function withManualToolBranding<
  T extends { readonly name: string; readonly description: string },
>(def: T, productName?: string): T {
  if (def.name !== 'kodax_manual') return def;
  const name = productName?.trim();
  if (!name || name === DEFAULT_PRODUCT_NAME) return def;
  return { ...def, description: buildManualToolDescription(name) };
}
