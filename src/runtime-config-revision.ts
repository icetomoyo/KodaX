import { createHash } from 'node:crypto';

/**
 * The revision of a Host's saved configuration as a client reads it, with its
 * secrets redacted. A client compares only what it can read, so a change to a
 * secret alone keeps the revision.
 */
export function runtimeConfigRevision(redactedConfig: unknown): string {
  return createHash('sha256').update(JSON.stringify(redactedConfig)).digest('hex').slice(0, 32);
}
