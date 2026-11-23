export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function normalizeCliError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
