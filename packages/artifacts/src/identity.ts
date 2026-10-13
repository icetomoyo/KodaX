import type { VisualSource } from './types.js';

/** Compare validated JSON DTOs by values; transport key order is not identity. */
export function sameJson(left: unknown, right: unknown): boolean {
 if (left === right) return true;
 if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, i) => sameJson(item, right[i]));
 if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null || Array.isArray(right)) return false;
 const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
 const keys = Object.keys(a).filter(key => a[key] !== undefined), other = Object.keys(b).filter(key => b[key] !== undefined);
 return keys.length === other.length && keys.every(key => other.includes(key) && sameJson(a[key], b[key]));
}
export function sameSource(left: VisualSource, right: VisualSource): boolean {
 const normalized = (source: VisualSource) => source.kind === 'file' ? { ...source,
  dependencies: [...source.dependencies ?? []].sort((a, b) => a.path.localeCompare(b.path)) } : source;
 return sameJson(normalized(left), normalized(right));
}
