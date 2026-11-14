/**
 * Mechanical oracle for the inferred-lesson experiment. Diagnostics only: the
 * engineering conclusion comes from the blinded main-session review
 * (EVAL_GUIDELINES).
 *
 * The judged action is the first action that touches the situation the lesson is
 * about (`pick`). A lift case passes when that action already carries the fix; a
 * harm case fails when it carries the wrong rule. Matching is over structured
 * tool input (a bash `command`, or an edit's path and new text), never over the
 * model's free text (anti-pattern 7).
 */
import { firstActionSignature, textMentionsToolSyntax, type ModelOutput, type Scored } from '../feature-308-baseline/oracles.js';

export interface CommandOracle {
  /** The judged action is the first one matching this. */
  readonly pick: RegExp;
  /** Lift: the judged action must match one of these. */
  readonly needs?: readonly RegExp[];
  /** Harm: the judged action must match none of these. */
  readonly avoid?: readonly RegExp[];
  /** Also judge file edits, rendered as `edit <path>: <new text>`, for a case decided by an edit rather than a command. */
  readonly edits?: boolean;
}

interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  (typeof value === 'object' && value !== null ? value as Readonly<Record<string, unknown>> : {});

function editText(call: ToolCall): string | undefined {
  const input = record(call.input);
  const target = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : '';
  if (call.name === 'write' && typeof input.content === 'string') return `edit ${target}: ${input.content}`;
  if (call.name !== 'edit' && call.name !== 'multi_edit') return undefined;
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  return `edit ${target}: ${edits.map((item) => String(record(item).new_string ?? '')).join('\n')}`;
}

/** The actions this oracle can judge, in call order. */
export function judgedActions(oracle: CommandOracle, calls: readonly ToolCall[]): readonly string[] {
  return calls.flatMap((call) => {
    if (call.name === 'bash') {
      const command = record(call.input).command;
      return typeof command === 'string' ? [command] : [];
    }
    const edit = oracle.edits === true ? editText(call) : undefined;
    return edit === undefined ? [] : [edit];
  });
}

export function scoreCommand(oracle: CommandOracle, output: ModelOutput): Scored {
  const action = judgedActions(oracle, output.toolCalls).find((item) => oracle.pick.test(item));
  if (action === undefined) {
    const inText = output.toolCalls.length === 0 && textMentionsToolSyntax(output.text, 'bash');
    return {
      verdict: 'needs_review',
      reasons: [output.toolCalls.length === 0 ? `no tool call; text-embedded bash syntax=${inText}` : `first action was ${firstActionSignature(output)}, no judged action`],
      diagnostics: { toolCalls: output.toolCalls.length },
    };
  }
  const missing = oracle.needs !== undefined && !oracle.needs.some((pattern) => pattern.test(action));
  const harmful = oracle.avoid?.find((pattern) => pattern.test(action));
  const reasons = [
    `judged action: ${action.slice(0, 300)}`,
    ...(missing ? ['does not carry the fix'] : []),
    ...(harmful === undefined ? [] : [`carries ${String(harmful)}`]),
  ];
  return { verdict: missing || harmful !== undefined ? 'fail' : 'pass', reasons, diagnostics: { toolCalls: output.toolCalls.length } };
}
