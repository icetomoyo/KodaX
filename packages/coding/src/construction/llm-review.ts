/**
 * LLM-driven static review for constructed tool handlers (DD §14.5.1).
 *
 * Two-tier static check sequence:
 *   1. AST hard rules (ast-rules.ts) — cheap, deterministic, AST-precise.
 *   2. LLM review (this module) — covers semantic-level patterns that
 *      AST rules cannot reasonably express (string concatenation
 *      obfuscation, indirect references, capabilities/code mismatch).
 *
 * The LLM reviewer is dependency-injected via `LlmReviewClient`, so:
 *   - Production wires a real KodaXClient call (Anthropic main path).
 *   - Mocked-LLM tests inject a fake reviewer for verdict-dispatch
 *     coverage (`.test.ts`, zero API cost).
 *   - Real-LLM accuracy tests (`.eval.ts`, gated by API key) inject a
 *     live client to measure precision/recall on a curated handler set.
 *
 * Verdict dispatch (handled by ConstructionRuntime.testArtifact):
 *   - 'safe'        → proceed to stage / activate.
 *   - 'suspicious'  → policy gate (caller decides; default ask-user).
 *   - 'dangerous'   → reject outright; do not enter policy gate.
 */

import type { Capabilities } from './types.js';

export type LlmReviewVerdict = 'safe' | 'suspicious' | 'dangerous';

export interface LlmReviewResult {
  readonly verdict: LlmReviewVerdict;
  readonly concerns: readonly string[];
  readonly suggestedCapabilities: readonly string[];
  /** Echoed for debugging; raw text from the LLM before parse. */
  readonly raw?: string;
}

/**
 * Caller-injected LLM client. Receives a fully-formed prompt; returns
 * the LLM's raw response text (must include a JSON object that
 * {@link parseLlmReviewVerdict} can extract).
 *
 * Kept at this minimal shape so wiring to KodaXClient (Anthropic main
 * path), to a mock, or to a real `.eval.ts` harness all stay trivial.
 */
export type LlmReviewClient = (prompt: string) => Promise<string>;

export interface BuildPromptInput {
  readonly handlerCode: string;
  readonly capabilities: Capabilities;
  /** Optional: name@version for prompt context. */
  readonly artifactRef?: string;
}

/**
 * Build the review prompt. Mirrors the structure described in
 * v0.7.28.md FEATURE_088 §安全考虑 — the LLM is told it IS KodaX
 * reviewing another KodaX agent's output (commit 74d4aaa self-identity
 * propagation), with explicit capability whitelist and pattern list.
 */
export function buildLlmReviewPrompt(input: BuildPromptInput): string {
  const declaredTools = input.capabilities.tools.length > 0
    ? input.capabilities.tools.map((t) => `'${t}'`).join(', ')
    : '<none>';

  const refLine = input.artifactRef
    ? `\nArtifact: ${input.artifactRef}\n`
    : '';

  return `You are KodaX reviewing a tool handler that another KodaX agent just generated. The handler will run in the host process with no JS-level sandbox; the only safety net at runtime is the capability whitelist below.${refLine}
Declared capabilities (the only builtin tools the handler may invoke through ctx.tools.<name>):
  ${declaredTools}

Look for any of these patterns and their obfuscated variants:
  - Any form of require / dynamic import / Function constructor (including string-concat aliases like ['req','uire'].join(''))
  - Access to process.* / globalThis.* / Buffer / __dirname / __filename
  - Global fetch / XMLHttpRequest / WebSocket
  - Top-level side effects (top-level await, writes to global object during module load)
  - ctx access beyond ctx.tools.<declared> — for example reading ctx.executionCwd to mutate the filesystem out-of-band, or pulling capabilities not in the whitelist
  - Hard-coded credentials, secret-looking strings, or network endpoints

Output STRICTLY a single JSON object on one line, no prose, no code fences:
{"verdict":"safe"|"suspicious"|"dangerous","concerns":["..."],"suggested_capabilities":["..."]}

Field semantics:
  - verdict: 'safe' = no detected risk, ready to stage. 'suspicious' = at least one pattern that warrants user confirmation. 'dangerous' = clear policy violation; should be rejected without prompting.
  - concerns: short bullet phrases describing what you found. Empty when verdict='safe'.
  - suggested_capabilities: the capability set you would expect this handler to need. May agree with or differ from the declared list — agreement is a 'safe' signal, divergence is informative.

Handler source:
\`\`\`javascript
${input.handlerCode}
\`\`\`
`;
}

/**
 * Parse a verdict JSON object out of the LLM's raw response. Tolerant
 * of surrounding prose / code fences (some models add them despite
 * instructions).
 *
 * Throws when no parseable verdict can be extracted — caller should
 * surface that as a `dangerous` outcome (defense in depth: a reviewer
 * that fails to produce a verdict cannot be trusted to clear).
 */
export function parseLlmReviewVerdict(raw: string): LlmReviewResult {
  const obj = extractJsonObject(raw);
  if (!obj) {
    throw new Error('LLM review output did not contain a JSON object.');
  }

  const verdictRaw = (obj as { verdict?: unknown }).verdict;
  if (verdictRaw !== 'safe' && verdictRaw !== 'suspicious' && verdictRaw !== 'dangerous') {
    throw new Error(
      `LLM review output had invalid verdict '${String(verdictRaw)}'; expected 'safe' | 'suspicious' | 'dangerous'.`,
    );
  }

  const concernsRaw = (obj as { concerns?: unknown }).concerns;
  const concerns = Array.isArray(concernsRaw)
    ? concernsRaw.filter((c): c is string => typeof c === 'string')
    : [];

  const suggestedRaw =
    (obj as { suggested_capabilities?: unknown }).suggested_capabilities;
  const suggestedCapabilities = Array.isArray(suggestedRaw)
    ? suggestedRaw.filter((c): c is string => typeof c === 'string')
    : [];

  return {
    verdict: verdictRaw,
    concerns,
    suggestedCapabilities,
    raw,
  };
}

/**
 * Convenience: build prompt → call client → parse verdict.
 * Errors from the client / parser bubble up unchanged.
 */
export async function runLlmReview(
  input: BuildPromptInput,
  client: LlmReviewClient,
): Promise<LlmReviewResult> {
  const prompt = buildLlmReviewPrompt(input);
  const raw = await client(prompt);
  return parseLlmReviewVerdict(raw);
}

// ----------------------------------------------------------------
// JSON extraction (handles fenced / prose-wrapped output)
// ----------------------------------------------------------------

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();

  // Fast path: entire response is a single JSON object.
  if (trimmed.startsWith('{')) {
    const obj = tryParseJson(trimmed);
    if (obj !== undefined) return obj;
  }

  // Strip a fenced code block if present.
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fenced) {
    const obj = tryParseJson(fenced[1].trim());
    if (obj !== undefined) return obj;
  }

  // Last resort: find the first balanced { ... } substring.
  const start = trimmed.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        const obj = tryParseJson(candidate);
        if (obj !== undefined) return obj;
        return undefined;
      }
    }
  }
  return undefined;
}

function tryParseJson(text: string): unknown {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}
