export interface QueuedPromptSequenceOptions<TResult> {
  initialPrompt: string;
  runRound: (prompt: string) => Promise<TResult>;
  shiftPendingPrompt: () => string | undefined;
  onRoundComplete?: (result: TResult) => Promise<void> | void;
  onBeforeQueuedRound?: (prompt: string) => Promise<void> | void;
  shouldContinue?: (result: TResult) => boolean;
}

export async function runQueuedPromptSequence<TResult>(
  options: QueuedPromptSequenceOptions<TResult>,
): Promise<TResult> {
  const {
    initialPrompt,
    runRound,
    shiftPendingPrompt,
    onRoundComplete,
    onBeforeQueuedRound,
    shouldContinue = () => true,
  } = options;

  let prompt = initialPrompt;
  let result = await runRound(prompt);

  while (true) {
    await onRoundComplete?.(result);

    if (!shouldContinue(result)) {
      return result;
    }

    let nextPrompt = shiftPendingPrompt();
    while (typeof nextPrompt === "string" && nextPrompt.trim().length === 0) {
      nextPrompt = shiftPendingPrompt();
    }

    if (!nextPrompt) {
      return result;
    }

    prompt = nextPrompt.trim();
    await onBeforeQueuedRound?.(prompt);
    result = await runRound(prompt);
  }
}
