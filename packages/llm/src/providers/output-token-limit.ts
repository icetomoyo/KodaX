/** Shared validation for catalog JSON and programmatic custom providers. */
export function optionalOutputTokenLimit(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path}.outputTokenLimit must be a positive safe integer`);
  }
  return value;
}
