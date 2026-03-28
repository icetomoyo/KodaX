import fs from 'fs/promises';

export async function safeReadJson<T>(
  filePath: string,
  validator?: (value: unknown) => value is T,
): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (validator && !validator(parsed)) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

export function debugLogRepoIntelligence(message: string, error?: unknown): void {
  if (!process.env.KODAX_DEBUG_REPO_INTELLIGENCE) {
    return;
  }
  if (error === undefined) {
    console.debug('[kodax:repo-intelligence]', message);
    return;
  }
  console.debug('[kodax:repo-intelligence]', message, error);
}
