import path from 'node:path';
import type { KodaXOptions } from './types.js';
import { resolveExecutionCwd } from './runtime-paths.js';

// Matches the Host session id limit so distinct valid ids never share a scratch dir.
const MAX_SCRATCH_SESSION_ID_LENGTH = 128;

export function sanitizeScratchSessionId(sessionId: string): string {
  const sanitized = sessionId
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_SCRATCH_SESSION_ID_LENGTH);
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return 'session';
  }
  return sanitized;
}

export function getSessionScratchDir(
  options: Pick<KodaXOptions, 'context' | 'session'>,
): string | undefined {
  const sessionId = options.session?.id?.trim();
  if (!sessionId) {
    return undefined;
  }

  const gitRoot = options.context?.gitRoot?.trim();
  const root = gitRoot
    ? path.resolve(gitRoot)
    : resolveExecutionCwd(options.context);

  return path.resolve(
    root,
    '.agent',
    'tmp',
    'sessions',
    sanitizeScratchSessionId(sessionId),
  );
}
