/**
 * KodaX Undo Tool
 *
 * 撤销工具 - 恢复最后一次文件修改
 */

import type { KodaXToolExecutionContext } from '../types.js';
import {
  canonicalizeAgentHomePolicyPath,
} from '../permissions/agent-home-policy.js';
import { normalizePathForKey } from './_internal/file-mutation-primitives.js';
import {
  deleteTrustedTextMutationBackupReceipt,
  getTrustedTextMutationBackupReceipt,
  withTextFileMutation,
  writeTextFileForMutation,
} from './_internal/text-file-mutation.js';

export async function toolUndo(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const backups = ctx.backups;
  if (backups.size > 0) {
    const entries = [...backups.entries()];
    const [filePath] = entries[entries.length - 1]!;
    let restored = false;
    await withTextFileMutation(filePath, 'undo', input, ctx, async (snapshot) => {
      const content = backups.get(filePath);
      if (content === undefined) return;
      const currentIdentity = canonicalizeAgentHomePolicyPath(filePath);
      if (currentIdentity === undefined
        || normalizePathForKey(currentIdentity) !== normalizePathForKey(filePath)) {
        throw new Error(`Backup path identity changed: ${filePath}`);
      }
      const receipt = getTrustedTextMutationBackupReceipt(backups, filePath);
      await writeTextFileForMutation(
        snapshot,
        receipt?.preimage ?? content,
        false,
        ctx,
        undefined,
        receipt,
      );
      backups.delete(filePath);
      deleteTrustedTextMutationBackupReceipt(backups, filePath);
      restored = true;
    });
    return restored ? `Restored: ${filePath}` : 'No backups available. Nothing to undo.';
  }
  return 'No backups available. Nothing to undo.';
}
