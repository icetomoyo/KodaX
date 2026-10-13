import type { ArtifactExecutionPort, ArtifactInputs, ArtifactOperation, ArtifactResults } from './types.js';
import { decodeArtifactRequest, decodeArtifactResult } from './contract.js';
import { verifyImageData } from './image-data.js';

export function createArtifactSdk(port: ArtifactExecutionPort) {
 const execute = async <O extends ArtifactOperation>(operation: O, input: ArtifactInputs[O], signal?: AbortSignal): Promise<ArtifactResults[O]> => {
  signal?.throwIfAborted();
  const request = decodeArtifactRequest({ operation, input });
  const result = await port.execute(request, signal);
  signal?.throwIfAborted();
  const checked = decodeArtifactResult(operation, result);
  if ('image' in checked && checked.image) await verifyImageData(checked.image);
  return checked;
 };
 return {
  create: (input: ArtifactInputs['create'], signal?: AbortSignal) => execute('create', input, signal),
  open: (input: ArtifactInputs['open'], signal?: AbortSignal) => execute('open', input, signal),
  edit: (input: ArtifactInputs['edit'], signal?: AbortSignal) => execute('edit', input, signal),
  export: (input: ArtifactInputs['export'], signal?: AbortSignal) => execute('export', input, signal),
  render: (input: ArtifactInputs['render'], signal?: AbortSignal) => execute('render', input, signal),
  capture: (input: ArtifactInputs['capture'], signal?: AbortSignal) => execute('capture', input, signal),
  capabilities: (signal?: AbortSignal) => execute('capabilities', {}, signal),
  prepare: (signal?: AbortSignal) => execute('prepare', {}, signal),
  readEvidence: (input: ArtifactInputs['readEvidence'], signal?: AbortSignal) => execute('readEvidence', input, signal),
 };
}
