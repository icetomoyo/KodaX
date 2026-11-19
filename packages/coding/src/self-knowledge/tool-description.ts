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
  // product keeps the other-product framing without KodaX specifics.
  return [
    `First source for using, installing, configuring, troubleshooting or extending ${name} itself, including its SDK.`,
    staticText("kodax-manual.answer-source"),
    ...(name === DEFAULT_PRODUCT_NAME ? [staticText("kodax-manual.config-paths")] : []),
    staticText("kodax-manual.lookup"),
  ].join(' ');
}

/**
 * Re-brand the `kodax_manual` tool description with the consumer's product name
 * when building the model-visible tool list. Returns the def unchanged for any
 * other tool, or when no (or the default 'KodaX') product name is set — so the
 * default Coding Agent tool surface is byte-identical. Generic over the def
 * shape so both the direct-engine (`getActiveToolDefinitions`) and AMA
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
