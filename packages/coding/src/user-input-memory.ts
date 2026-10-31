import { staticText } from './prompts/static-text.js';
import { ContextCapacityError, countTokens, estimateTokens, exceedsContextCapacity } from '@kodax-ai/agent';
import { withProviderRequestCredential, resolveDefaultSideQueryReasoning } from '@kodax-ai/llm';
import type { KodaXBaseProvider, KodaXTokenUsage } from '@kodax-ai/llm';
import { applyAccountingDelta } from './goal/state.js';
import type { GoalRuntimeBinding } from './goal/runtime-wiring.js';

export class UserInputMemoryBudgetError extends Error {
  constructor() { super('Goal token budget exhausted during user context preparation.'); this.name = 'UserInputMemoryBudgetError'; }
}

export const USER_INPUT_MEMORY_SYSTEM = staticText("t12.user-input-memory.0");

/** Append-only, verbatim memory. A small window cannot justify silently dropping an obligation. */
export async function retainUserInput(
  original: string, contextWindow: number, generate: (chunk: string) => Promise<string>,
): Promise<string[]> {
  const retained: string[] = [];
  const chunkBudget = Math.max(128, Math.floor(contextWindow / 4));
  let offset = 0;
  while (offset < original.length) {
    let high = original.length - offset;
    let low = 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (countTokens(original.slice(offset, offset + mid)) <= chunkBudget) low = mid;
      else high = mid - 1;
    }
    let end = offset + low;
    // Prefer whole lines, while still making progress on unbroken Unicode text.
    const newline = original.lastIndexOf('\n', end - 1);
    if (end < original.length && newline >= offset + low / 2) end = newline + 1;
    if (end < original.length && /[\uD800-\uDBFF]/u.test(original[end - 1]!)) end -= 1;
    const chunk = original.slice(offset, end);
    const raw = await generate(chunk);
    let quotes: unknown;
    try { quotes = JSON.parse(raw); }
    catch (cause) { throw new Error('User input memory must be a JSON array.', { cause }); }
    if (!Array.isArray(quotes) || quotes.some(quote => typeof quote !== 'string' || !quote.trim() || !chunk.includes(quote))) {
      throw new Error('User input memory must contain only verbatim quotations.');
    }
    for (const quote of quotes as string[]) if (!retained.includes(quote)) retained.push(quote);
    if (countTokens(JSON.stringify(retained)) > chunkBudget) {
      throw new ContextCapacityError({ contextWindow, currentTokens: countTokens(JSON.stringify(retained)),
        reservedResponseTokens: 1000 }, 'Retained user constraints exceed working memory capacity');
    }
    offset = end;
  }
  return retained;
}

export async function prepareUserInputMemory(input: {
  original: string; contextWindow: number; provider: Pick<KodaXBaseProvider, 'name' | 'stream' | 'getReasoningProfile'>; model?: string;
  signal?: AbortSignal; timeoutMs?: number; onUsage?: (usage: KodaXTokenUsage) => void;
  goalRuntime?: Pick<GoalRuntimeBinding, 'refresh' | 'lifecycleCtx'>;
}): Promise<string[]> {
  return retainUserInput(input.original, input.contextWindow, async chunk => {
    input.signal?.throwIfAborted();
    await input.goalRuntime?.refresh?.();
    if (input.goalRuntime?.lifecycleCtx.getGoal()?.status === 'budget_limited') throw new UserInputMemoryBudgetError();
    const budget = { contextWindow: input.contextWindow,
      currentTokens: estimateTokens([{ role: 'user', content: chunk }]) + countTokens(USER_INPUT_MEMORY_SYSTEM),
      reservedResponseTokens: Math.max(128, Math.floor(input.contextWindow / 4)) };
    if (exceedsContextCapacity(budget)) throw new ContextCapacityError(budget, 'User constraint extraction');
    const signals = [input.signal, input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined]
      .filter((signal): signal is AbortSignal => signal !== undefined);
    const result = await withProviderRequestCredential(input.provider, 'compaction',
      signals.length ? AbortSignal.any(signals) : undefined, signal =>
      input.provider.stream([{ role: 'user', content: chunk }], [], USER_INPUT_MEMORY_SYSTEM,
        resolveDefaultSideQueryReasoning(input.provider.getReasoningProfile?.(input.model)) ?? false, {
          ...(input.model ? { modelOverride: input.model } : {}),
          maxOutputTokensOverride: budget.reservedResponseTokens, singleAttempt: true,
        }, signal));
    if (result.usage) input.onUsage?.(result.usage);
    const goalContext = input.goalRuntime?.lifecycleCtx;
    if (goalContext && result.usage && goalContext.getPermissionMode?.() !== 'plan') {
      await input.goalRuntime?.refresh?.();
      const goal = goalContext.getGoal();
      if (goal?.status === 'active') {
        const accounting = applyAccountingDelta(goal, result.usage, 0);
        if (accounting.nextState !== goal) await goalContext.persistEvent(accounting.nextState,
          accounting.budgetLimited ? 'budget_limited' : 'updated');
        if (accounting.budgetLimited) throw new UserInputMemoryBudgetError();
      }
    }
    if (result.toolBlocks.length || result.stopReason === 'max_tokens') throw new Error('Incomplete user input memory response.');
    return result.textBlocks.map(block => block.text).join('');
  });
}
