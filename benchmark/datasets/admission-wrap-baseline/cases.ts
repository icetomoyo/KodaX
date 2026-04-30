/**
 * Admission systemPrompt double-wrap baseline — dataset for FEATURE_101
 * v0.7.31.1, design open question Q6 (non-degradation real-LLM lane).
 *
 * See ./README.md for the product question. This module exports:
 *
 *   - `WRAP_TASKS`       — 5 canonical role-spec scenarios with deterministic
 *                          judges (no LLM-as-judge overhead).
 *   - `WRAP_VARIANT_IDS` — `unwrapped` (raw role spec) vs `wrapped`
 *                          (production buildSystemPrompt output).
 *   - `buildJudges(task)` — task-id-keyed judge factory.
 *   - `buildPromptVariants(task)` — pivot to PromptVariant[] for runBenchmark.
 *
 * Wrap text is sourced verbatim from the production runner via
 * `buildSystemPrompt` — when TRUSTED_HEADER / TRUSTED_FOOTER change in
 * `packages/core/src/runner.ts`, this dataset re-imports the new version
 * automatically. No copy-pasted wrap chrome to drift.
 */

import {
  buildSystemPrompt,
  setAdmittedAgentBindings,
  type Agent,
  type AgentManifest,
} from '@kodax/core';

import type { PromptJudge } from '../../harness/judges.js';
import {
  mustContainAll,
  mustMatch,
  mustNotContain,
  mustNotMatch,
  parseAndAssert,
} from '../../harness/judges.js';
import type { PromptVariant } from '../../harness/harness.js';

export type WrapTaskId =
  | 'echo'
  | 'prefix-bullet'
  | 'count-words'
  | 'uppercase'
  | 'json-extract';

export type WrapVariantId = 'unwrapped' | 'wrapped';

export interface WrapTaskCase {
  readonly id: WrapTaskId;
  readonly description: string;
  readonly roleSpec: string;
  readonly userMessage: string;
}

export const WRAP_TASKS: readonly WrapTaskCase[] = Object.freeze([
  {
    id: 'echo',
    description:
      'Single-line echo with prefix — the simplest possible role spec, '
      + 'baseline check that the wrap does not break basic instruction following.',
    roleSpec:
      'Repeat back the user message exactly, prefixed with "echo: ". '
      + 'Do not add commentary, explanation, or quotation marks.',
    userMessage: 'hello world from the wrap test',
  },
  {
    id: 'prefix-bullet',
    description:
      'Per-line transformation — slightly harder than echo, requires the model '
      + 'to apply a transformation to every line of input.',
    roleSpec:
      'For each line of the user input, output the same line prefixed with "* ". '
      + 'Output only the transformed lines, nothing else.',
    userMessage: 'apple\nbanana\ncarrot',
  },
  {
    id: 'count-words',
    description:
      'Analytical — model must count words in the input. Tests whether the wrap '
      + 'distracts the model from a simple analysis task.',
    roleSpec:
      'Count the number of whitespace-separated words in the user message and '
      + 'reply with exactly "WORD_COUNT: <n>" where <n> is the integer count. '
      + 'Output nothing else.',
    userMessage: 'the quick brown fox jumps over the lazy dog',
  },
  {
    id: 'uppercase',
    description:
      'Format-preserving transform — uppercase the input verbatim. Tests whether '
      + 'the wrap causes the model to add stray commentary or framing.',
    roleSpec:
      'Convert the user message to UPPERCASE and emit the result. Do not add '
      + 'any commentary, explanation, or quotation marks. Output only the '
      + 'transformed text.',
    userMessage: 'wrap stability is the question',
  },
  {
    id: 'json-extract',
    description:
      'Structured output — model must produce a JSON object with two keys. '
      + 'Tests whether the wrap interferes with structured-output adherence.',
    roleSpec:
      'Output a single JSON object describing the user message with these keys:\n'
      + '  - "subject": short string naming what the message is about\n'
      + '  - "sentiment": one of "positive", "negative", "neutral"\n'
      + 'Output ONLY the JSON object, no surrounding markdown fences or commentary.',
    userMessage: 'I really enjoyed the new product launch event yesterday.',
  },
]);

// ---------------------------------------------------------------------------
// Variant builder — uses production `buildSystemPrompt`.
// ---------------------------------------------------------------------------

function wrapInstructions(roleSpec: string): string {
  // Per-call agent stub — bindings live in a WeakMap so the entry is GC'd
  // when the stub falls out of scope. Single closed-set invariant id is
  // enough to flip buildSystemPrompt's bindings check from
  // "trusted → return raw" to "admitted → wrap".
  const stubAgent: Agent = {
    name: 'admission-wrap-baseline-stub',
    instructions: roleSpec,
  };
  const stubManifest: AgentManifest = { ...stubAgent };
  setAdmittedAgentBindings(stubAgent, stubManifest, ['finalOwner']);
  return buildSystemPrompt(stubAgent, roleSpec);
}

export function buildPromptVariants(task: WrapTaskCase): readonly PromptVariant[] {
  return Object.freeze([
    {
      id: 'unwrapped',
      description: 'raw roleSpec sent as systemPrompt (trusted-agent path)',
      systemPrompt: task.roleSpec,
      userMessage: task.userMessage,
    },
    {
      id: 'wrapped',
      description: 'production buildSystemPrompt output (admitted-agent path)',
      systemPrompt: wrapInstructions(task.roleSpec),
      userMessage: task.userMessage,
    },
  ]);
}

// ---------------------------------------------------------------------------
// Per-task judges — deterministic, no LLM-as-judge.
// ---------------------------------------------------------------------------

function uppercaseExact(source: string): PromptJudge {
  const expected = source.toUpperCase();
  return {
    name: `uppercase-exact(${JSON.stringify(source.slice(0, 40))})`,
    category: 'correctness',
    judge(output: string) {
      const trimmed = output.trim();
      const passed = trimmed === expected || trimmed.includes(expected);
      return passed
        ? { passed: true }
        : {
            passed: false,
            reason: `expected uppercase exact match of "${source}"; got: ${JSON.stringify(trimmed.slice(0, 200))}`,
          };
    },
  };
}

function wordCountExact(expected: number): PromptJudge {
  return {
    name: `word-count-exact(${expected})`,
    category: 'correctness',
    judge(output: string) {
      const m = output.match(/WORD_COUNT:\s*(\d+)/);
      if (!m) {
        return {
          passed: false,
          reason: `no WORD_COUNT marker in: ${output.slice(0, 200)}`,
        };
      }
      const got = Number.parseInt(m[1]!, 10);
      if (got !== expected) {
        return { passed: false, reason: `expected WORD_COUNT: ${expected}, got: ${got}` };
      }
      return { passed: true };
    },
  };
}

function jsonShape(): PromptJudge {
  return parseAndAssert<{ subject: string; sentiment: string }>(
    (output) => {
      const stripped = output.replace(/^```(?:json)?\s*|\s*```\s*$/g, '').trim();
      try {
        const value = JSON.parse(stripped) as Record<string, unknown>;
        if (typeof value.subject === 'string' && typeof value.sentiment === 'string') {
          return { subject: value.subject, sentiment: value.sentiment };
        }
        return null;
      } catch {
        return null;
      }
    },
    (value) => {
      if (value.subject.length === 0) return false;
      const sentiment = value.sentiment;
      return sentiment === 'positive' || sentiment === 'negative' || sentiment === 'neutral';
    },
    'json-shape',
  );
}

export function buildJudges(taskId: WrapTaskId): readonly PromptJudge[] {
  switch (taskId) {
    case 'echo':
      return [
        mustMatch(/^echo:\s*hello world from the wrap test/i, 'echo-prefix'),
        mustNotMatch(/\b(I will|here is|let me|sure,)/i, 'no-explanation'),
      ];
    case 'prefix-bullet':
      return [
        mustContainAll('* apple', '* banana', '* carrot'),
        mustNotContain('\napple\n', '\nbanana\n', '\ncarrot\n'),
      ];
    case 'count-words':
      return [wordCountExact(9)];
    case 'uppercase':
      return [
        uppercaseExact('wrap stability is the question'),
        mustNotMatch(/\b(here is|the result|converted to)/i, 'no-commentary'),
      ];
    case 'json-extract':
      return [jsonShape()];
    default: {
      const _exhaustive: never = taskId;
      throw new Error(`buildJudges: unhandled taskId ${_exhaustive as string}`);
    }
  }
}

export const WRAP_VARIANT_IDS: readonly WrapVariantId[] = Object.freeze([
  'unwrapped',
  'wrapped',
]);
