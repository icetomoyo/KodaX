import fs from 'node:fs';
import path from 'node:path';
import { inspectStorageRepair, inspectStorageRepairCandidate, applyStorageRepair, confirmStorageRepair,
  type StorageRepairTarget, type StorageRepairPlan, type StorageRepairReceipt } from './storage-repair.js';

function request<T>(file: string): T {
  let raw: string;
  try {
    const target = path.resolve(file);
    if (fs.statSync(target).size > 256 * 1024) throw new Error('Oversized maintenance request.');
    raw = fs.readFileSync(target, 'utf8');
    if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('Oversized maintenance request.');
  }
  catch { throw new Error('Unable to read the storage maintenance request file.'); }
  try { return JSON.parse(raw) as T; }
  catch { throw new Error('Invalid storage maintenance request JSON; original files retained.'); }
}

/** Explicit local administrator actions; never registered as model tools. */
export async function runStorageRepairCli(options: {
  inspectStorage?: string; repairStorage?: string; verifyStorage?: string; repairCandidate?: string;
  writersStopped?: boolean; verifiedCurrentState?: boolean; ping?: boolean; nativeText?: boolean;
}): Promise<void> {
  if ([options.inspectStorage, options.repairStorage, options.verifyStorage].filter(Boolean).length !== 1 || options.ping || options.nativeText) {
    throw new Error('Choose exactly one storage inspection, repair or verification action.');
  }
  let result: StorageRepairPlan | StorageRepairReceipt;
  if (options.inspectStorage) result = inspectStorageRepair(request<StorageRepairTarget>(options.inspectStorage));
  else if (options.repairStorage) result = await applyStorageRepair(request<StorageRepairPlan>(options.repairStorage), {
    allWritersStopped: options.writersStopped === true,
    ...(options.repairCandidate ? { candidate: inspectStorageRepairCandidate(path.resolve(options.repairCandidate)) } : {}),
  });
  else result = await confirmStorageRepair(request<StorageRepairReceipt>(options.verifyStorage!), {
    allWritersStopped: options.writersStopped === true, verifiedCurrentState: options.verifiedCurrentState === true,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
