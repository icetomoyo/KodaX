import type { RuntimeBusinessBinding, RuntimeDefaultSkill, RuntimeExecutionBindingSnapshot } from './client-host-authorization.js';

/** Bounded declarative intent, independent of all process-local leases. */
export function parseExecutionBindingSnapshot(value: unknown): RuntimeExecutionBindingSnapshot | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const snapshot = value as { businessBinding?: RuntimeBusinessBinding; defaultSkill?: RuntimeDefaultSkill };
  const binding = snapshot.businessBinding;
  if (!binding || typeof binding.id !== 'string' || !binding.id.trim() || binding.id.length > 256
    || typeof binding.revision !== 'string' || !binding.revision.trim() || binding.revision.length > 256
    || (binding.data !== undefined && (binding.data === null || typeof binding.data !== 'object' || Array.isArray(binding.data)))) return undefined;
  if (snapshot.defaultSkill !== undefined && (snapshot.defaultSkill === null || typeof snapshot.defaultSkill !== 'object'
    || typeof snapshot.defaultSkill.name !== 'string'
    || !snapshot.defaultSkill.name.trim() || snapshot.defaultSkill.name.length > 128)) return undefined;
  try {
    const encoded = JSON.stringify(snapshot, (_key: string, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Non-finite binding value.');
      return item;
    });
    if (Buffer.byteLength(encoded, 'utf8') > 16_384) return undefined;
    return JSON.parse(encoded) as RuntimeExecutionBindingSnapshot;
  } catch { return undefined; }
}
