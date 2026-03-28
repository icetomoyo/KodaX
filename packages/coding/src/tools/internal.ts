export function readOptionalString<T extends string>(
  input: Record<string, unknown>,
  key: T,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string when provided.`);
  }
  return value;
}
