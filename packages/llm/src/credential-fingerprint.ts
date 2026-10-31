import { createHash } from 'node:crypto';
/** Non-secret replay/learning isolation only; never credential authority. */
export function credentialFingerprint(credential: unknown, identity?: string): string {
  return createHash('sha256').update(JSON.stringify([credential, identity])).digest('hex');
}
