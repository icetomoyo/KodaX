import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSessionScratchDir, sanitizeScratchSessionId } from './session-scratch.js';

describe('session scratch directory', () => {
  it('sanitizes session ids for a path segment', () => {
    expect(sanitizeScratchSessionId(' session A/../B:zh ')).toBe('session_A_.._B_zh');
  });

  it('falls back for empty or parent-directory ids', () => {
    expect(sanitizeScratchSessionId('   ')).toBe('session');
    expect(sanitizeScratchSessionId('.')).toBe('session');
    expect(sanitizeScratchSessionId('..')).toBe('session');
  });

  it('keeps every valid Host id distinct and truncates only longer ones', () => {
    const sharedPrefix = 'a'.repeat(100);
    expect(sanitizeScratchSessionId(`${sharedPrefix}-one`)).not.toBe(sanitizeScratchSessionId(`${sharedPrefix}-two`));
    expect(sanitizeScratchSessionId('a'.repeat(200))).toHaveLength(128);
  });

  it('returns undefined without a concrete session id', () => {
    const root = path.resolve(process.cwd(), 'tmp-repo');

    expect(getSessionScratchDir({ context: { gitRoot: root } })).toBeUndefined();
    expect(getSessionScratchDir({ context: { gitRoot: root }, session: { id: '  ' } })).toBeUndefined();
  });

  it('builds a session-scoped scratch directory under the repo temp root', () => {
    const root = path.resolve(process.cwd(), 'tmp-repo');

    expect(getSessionScratchDir({ context: { gitRoot: root }, session: { id: 'session A' } })).toBe(
      path.resolve(root, '.agent', 'tmp', 'sessions', 'session_A'),
    );
  });
});