import type { ArtifactExecutionPort, CaptureInput, EditInput, FileInput, PresentationInput, RenderInput } from './types.js';

export function createArtifactSdk(port: ArtifactExecutionPort) {
 return {
  create: (input: PresentationInput, signal?: AbortSignal) => port.execute({ operation: 'create', input }, signal),
  open: (input: FileInput, signal?: AbortSignal) => port.execute({ operation: 'open', input }, signal),
  edit: (input: EditInput, signal?: AbortSignal) => port.execute({ operation: 'edit', input }, signal),
  export: (input: FileInput & { output: string }, signal?: AbortSignal) => port.execute({ operation: 'export', input }, signal),
  render: (input: RenderInput, signal?: AbortSignal) => port.execute({ operation: 'render', input }, signal),
  capture: (input: CaptureInput, signal?: AbortSignal) => port.execute({ operation: 'capture', input }, signal),
  capabilities: (signal?: AbortSignal) => port.execute({ operation: 'capabilities', input: {} }, signal),
 };
}
