/**
 * KodaX AskUserQuestion Tool
 *
 * 交互式提问工具 - 允许 LLM 在需要时主动向用户提问
 */

import type { KodaXToolExecutionContext } from '../types.js';

export interface AskUserQuestionOption {
  label: string;
  description?: string;
  value?: string;
}

export interface AskUserQuestionInput {
  question: string;
  options: AskUserQuestionOption[];
  default?: string;
  intent?: "generic" | "plan-handoff";
  target_mode?: "accept-edits";
  scope?: "session";
  resume_behavior?: "continue";
}

/**
 * Ask user a question with multiple choice options
 *
 * This tool requires context.askUser callback to be provided by the REPL layer
 */
export async function toolAskUserQuestion(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext
): Promise<string> {
  // Validate input
  if (!input.question || typeof input.question !== 'string') {
    return '[Tool Error] ask_user_question: Missing or invalid required parameter: question';
  }

  if (!Array.isArray(input.options) || input.options.length === 0) {
    return '[Tool Error] ask_user_question: Missing required parameter: options (must be a non-empty array)';
  }

  // Check if askUser callback is available
  if (!ctx.askUser) {
    return '[Tool Error] ask_user_question: Interactive mode not available (askUser callback not provided)';
  }

  try {
    // Call the interactive callback
    const userChoice = await ctx.askUser({
      question: input.question,
      options: input.options.map((opt: any) => ({
        label: opt.label || String(opt),
        description: opt.description,
        value: opt.value || opt.label || String(opt),
      })),
      default: input.default as string | undefined,
      intent: input.intent as "generic" | "plan-handoff" | undefined,
      targetMode: input.target_mode as "accept-edits" | undefined,
      scope: input.scope as "session" | undefined,
      resumeBehavior: input.resume_behavior as "continue" | undefined,
    });

    return JSON.stringify({
      success: true,
      choice: userChoice,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return `[Tool Error] ask_user_question: ${errorMsg}`;
  }
}
