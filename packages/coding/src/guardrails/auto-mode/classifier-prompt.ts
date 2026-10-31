import { staticText } from '../../prompts/static-text.js';
/**
 * Classifier prompt builder — FEATURE_092 Phase 2b.3 (v0.7.33).
 *
 * Builds the system prompt + user message for the auto-mode classifier
 * sideQuery. Inert XML envelope: transcript and action are wrapped as
 * data, not as continuation of the conversation.
 *
 * Anti-injection defenses:
 *   1. The system prompt explicitly instructs the model to treat
 *      <transcript> as data, never as instructions.
 *   2. User-controlled strings (transcript content and action) are
 *      passed through `neutralizeStructuralDelimiters` so they can't
 *      forge a closing </transcript> or a fake <action>.
 *   3. Output format is constrained to a decision + concrete hazard contract
 *      with explicit "Do NOT include thinking or preamble" guidance.
 */

import type { KodaXMessage } from '@kodax-ai/llm';
import type { ToolCallSignal } from './signals.js';
import type { PermissionIntentEvidence } from './permission-intent.js';

export interface BuildClassifierPromptInput {
  /** @deprecated Legacy compatibility input. Auto rules are ignored. */
  readonly rules?: {
    readonly allow: readonly string[];
    readonly soft_deny: readonly string[];
    readonly environment: readonly string[];
  };
  /** Optional trusted administrator policy supplied by the host. */
  readonly administratorPolicy?: string;
  /** Optional user policy from config.json#autoReview.policy. */
  readonly reviewPolicy?: string;
  /** Optional guidance attached to the selected reviewer model/catalog. */
  readonly modelGuidance?: string;
  readonly claudeMd?: string;
  readonly transcript: readonly KodaXMessage[];
  readonly action: string;
  /** Compact user-only authority evidence for structured permission review. */
  readonly intentEvidence?: PermissionIntentEvidence;
  /**
   * FEATURE_158 (v0.7.39): mechanical pattern matches over the tool call
   * (dangerous_pattern / protected_path / outside_project / network / etc.).
   * Surfaced to the model as **informational input** — NOT verdicts. The
   * model weighs signals alongside transcript to produce the
   * final allow / ask decision.
   *
   * Empty / undefined → no `<signals>` block emitted (back-compat shape
   * for callers that don't yet supply signals).
   */
  readonly signals?: readonly ToolCallSignal[];
}

export interface ClassifierPrompt {
  readonly system: string;
  readonly messages: readonly KodaXMessage[];
}

const MAX_CLAUDE_MD_LEN = 4000;
const MAX_REVIEW_POLICY_LEN = 4000;
const TRUNCATED_MARKER = '\n…[truncated]…';

const SYSTEM_PROMPT_HEADER = staticText("t11.guardrails/auto-mode/classifier-prompt.0");

const BUNDLED_POLICY = staticText("t11.guardrails/auto-mode/classifier-prompt.1");

const OUTPUT_CONTRACT = staticText("t11.guardrails/auto-mode/classifier-prompt.2");

export function buildClassifierPrompt(input: BuildClassifierPromptInput): ClassifierPrompt {
  const system = buildSystem(input);
  const userContent = buildUserMessage(input);
  return {
    system,
    messages: [{ role: 'user', content: userContent }],
  };
}

function buildSystem(input: BuildClassifierPromptInput): string {
  const parts: string[] = [SYSTEM_PROMPT_HEADER, ''];

  pushPolicySection(parts, 'administrator_policy', input.administratorPolicy);
  pushPolicySection(parts, 'user_policy', input.reviewPolicy);
  pushPolicySection(parts, 'model_guidance', input.modelGuidance);

  if (!input.intentEvidence && input.claudeMd && input.claudeMd.length > 0) {
    // Neutralize FIRST then truncate — slicing first risks slicing into a
    // multi-byte sequence whose suffix would land in the prompt as a
    // malformed character; neutralize replaces only ASCII < and > so it
    // does not change byte length unpredictably.
    let md = neutralize(input.claudeMd);
    if (md.length > MAX_CLAUDE_MD_LEN) {
      md = md.slice(0, MAX_CLAUDE_MD_LEN) + TRUNCATED_MARKER;
    }
    parts.push('');
    parts.push('<claude_md>');
    parts.push(md);
    parts.push('</claude_md>');
  }

  parts.push('<bundled_policy>', BUNDLED_POLICY, '</bundled_policy>', '', OUTPUT_CONTRACT);

  return parts.join('\n');
}

function pushPolicySection(
  parts: string[],
  tag: 'administrator_policy' | 'user_policy' | 'model_guidance',
  value: string | undefined,
): void {
  if (value === undefined || value.trim().length === 0) return;
  let policy = neutralize(value.trim());
  if (policy.length > MAX_REVIEW_POLICY_LEN) {
    policy = policy.slice(0, MAX_REVIEW_POLICY_LEN) + TRUNCATED_MARKER;
  }
  parts.push(`<${tag}>`, policy, `</${tag}>`);
}

function buildUserMessage(input: BuildClassifierPromptInput): string {
  if (input.intentEvidence) return buildCompactUserMessage(input);
  const parts: string[] = ['<transcript>'];
  for (const msg of input.transcript) {
    parts.push(serializeMessage(msg));
  }
  parts.push('</transcript>');

  if (input.signals && input.signals.length > 0) {
    parts.push('<signals>');
    for (const signal of input.signals) {
      parts.push(`  - ${formatSignal(signal)}`);
    }
    parts.push('</signals>');
  }

  parts.push(`<action>${neutralize(input.action)}</action>`);
  return parts.join('\n');
}

function buildCompactUserMessage(input: BuildClassifierPromptInput): string {
  const evidence = input.intentEvidence!;
  const parts: string[] = [];
  if (evidence.currentUserContent) {
    parts.push(
      evidence.currentUserContentTruncated === true
        ? '<root_user_intent truncated="true">'
        : '<root_user_intent>',
      neutralize(evidence.currentUserContent),
      '</root_user_intent>',
    );
  }
  if (evidence.delegatedObjective) {
    parts.push(
      evidence.delegatedObjectiveTruncated === true
        ? '<delegated_objective truncated="true">'
        : '<delegated_objective>',
      neutralize(evidence.delegatedObjective),
      '</delegated_objective>',
    );
  }
  if (evidence.bindingConstraints && evidence.bindingConstraints.length > 0) {
    parts.push(
      '<binding_constraints>',
      ...evidence.bindingConstraints.map((constraint) => `  - ${neutralize(constraint)}`),
      '</binding_constraints>',
    );
  }
  if (evidence.scopeHint) {
    parts.push(`<scope_hint binding="false">${neutralize(evidence.scopeHint)}</scope_hint>`);
  }
  parts.push(`<runtime_capabilities read_only="${evidence.readOnly === true ? 'true' : 'false'}" />`);
  parts.push(
    `<intent_evidence status="${evidence.status}" source_bytes="${evidence.sourceBytes}" included_bytes="${evidence.includedBytes}" omitted_bytes="${evidence.omittedBytes}" sha256="${evidence.sha256}">`,
    neutralize(evidence.content),
    '</intent_evidence>',
  );
  if (input.signals && input.signals.length > 0) {
    parts.push('<signals>');
    for (const signal of input.signals) parts.push(`  - ${formatSignal(signal)}`);
    parts.push('</signals>');
  }
  parts.push(`<operation_facts>${neutralize(input.action)}</operation_facts>`);
  return parts.join('\n');
}

/**
 * Render a signal as a single human-readable line for the classifier
 * prompt. All user-controlled strings flow through `neutralize` so a
 * malicious path/pattern can't forge structural delimiters.
 */
function formatSignal(signal: ToolCallSignal): string {
  switch (signal.kind) {
    case 'dangerous_pattern':
      return `dangerous_pattern (${signal.severity}): ${neutralize(signal.pattern)}`;
    case 'protected_path':
      return `protected_path (zone=${signal.zone}): ${neutralize(signal.path)}`;
    case 'outside_project':
      return `outside_project: ${neutralize(signal.path)}`;
    case 'shell_redirect_outside':
      return `shell_redirect_outside: ${neutralize(signal.target)}`;
    case 'package_install':
      return `package_install: ${signal.manager}`;
    case 'git_write':
      return `git_write: ${signal.verb}`;
    case 'network':
      return `network: ${signal.tool}`;
    case 'file_modification':
      return `file_modification: ${signal.targets.map(neutralize).join(', ')}`;
  }
}

function serializeMessage(msg: KodaXMessage): string {
  if (typeof msg.content === 'string') {
    return `[${msg.role}] ${neutralize(msg.content)}`;
  }
  const lines: string[] = [`[${msg.role}]`];
  for (const block of msg.content) {
    if (block.type === 'text') {
      lines.push(`  text: ${neutralize(block.text)}`);
    } else if (block.type === 'tool_use') {
      const inputJson = safeJsonStringify(block.input);
      lines.push(`  tool_use(${neutralize(block.name)}): ${neutralize(inputJson)}`);
    } else if (block.type === 'tool_result') {
      lines.push(`  tool_result: ${neutralize(typeof block.content === 'string' ? block.content : block.content.filter(i => i.type === 'text').map(i => i.type === 'text' ? i.text : '').join(''))}`);
    }
    // thinking / redacted_thinking / image — already stripped upstream;
    // if they slip through here, just skip them (don't leak to classifier).
  }
  return lines.join('\n');
}

/**
 * Defang structural delimiters in user-controlled text so it cannot forge
 * `</transcript>`, `<action>`, etc. Replaces angle brackets with their
 * unicode look-alikes — the classifier reads the same intent, but the
 * string can no longer be parsed as XML structure.
 */
function neutralize(s: string): string {
  return s.replace(/</g, '‹').replace(/>/g, '›');
}

function safeJsonStringify(value: unknown): string {
  try {
    const out = JSON.stringify(value);
    return out === undefined ? '[unserializable]' : out;
  } catch {
    return '[unserializable]';
  }
}
