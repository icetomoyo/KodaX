import { AsyncLocalStorage } from 'node:async_hooks';
import type { ImageValidation, KodaXToolResultContentItem } from '@kodax-ai/llm';
import type { VisualOutputReservation } from './visual-tools.js';

/** Host-owned call scope. Typed producers retain bytes until this callback has admitted them. */
export interface VisualImageAdmission {
  reserve(count: number, sourceKey: string): VisualOutputReservation;
  admit(bytes: Buffer, mediaType: string, validation: ImageValidation, sourceKey: string, imageOrdinal: number): Promise<readonly KodaXToolResultContentItem[]>;
}
const admission = new AsyncLocalStorage<VisualImageAdmission | undefined>();
export function withVisualImageAdmission<T>(binding: VisualImageAdmission | undefined, operation: () => T): T {
  return admission.run(binding, operation);
}
export function getVisualImageAdmission(): VisualImageAdmission | undefined { return admission.getStore(); }
