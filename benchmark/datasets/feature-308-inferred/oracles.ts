/**
 * Mechanical oracle for the inferred-lesson experiment. Diagnostics only: the
 * engineering conclusion comes from the blinded main-session review
 * (EVAL_GUIDELINES).
 *
 * The judged action is the first shell command that touches the situation the
 * lesson is about (`pick`). A lift case passes when that command already carries
 * the fix; a harm case fails when it carries the wrong rule. Matching is over the
 * structured `command` field of a bash call, never over free text (anti-pattern 7).
 */
import { bashCommands, firstActionSignature, textMentionsToolSyntax, type ModelOutput, type Scored } from '../feature-308-baseline/oracles.js';

export interface CommandOracle {
  /** The judged command is the first bash command matching this. */
  readonly pick: RegExp;
  /** Lift: the judged command must match one of these. */
  readonly needs?: readonly RegExp[];
  /** Harm: the judged command must match none of these. */
  readonly avoid?: readonly RegExp[];
}

export function scoreCommand(oracle: CommandOracle, output: ModelOutput): Scored {
  const command = bashCommands(output.toolCalls).find((item) => oracle.pick.test(item));
  if (command === undefined) {
    const inText = output.toolCalls.length === 0 && textMentionsToolSyntax(output.text, 'bash');
    return {
      verdict: 'needs_review',
      reasons: [output.toolCalls.length === 0 ? `no tool call; text-embedded bash syntax=${inText}` : `first action was ${firstActionSignature(output)}, no judged command yet`],
      diagnostics: { toolCalls: output.toolCalls.length },
    };
  }
  const missing = oracle.needs !== undefined && !oracle.needs.some((pattern) => pattern.test(command));
  const harmful = oracle.avoid?.find((pattern) => pattern.test(command));
  const reasons = [
    `judged command: ${command}`,
    ...(missing ? ['does not carry the fix'] : []),
    ...(harmful === undefined ? [] : [`carries ${String(harmful)}`]),
  ];
  return { verdict: missing || harmful !== undefined ? 'fail' : 'pass', reasons, diagnostics: { toolCalls: output.toolCalls.length } };
}
