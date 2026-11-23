import { Command } from 'commander';
import { loadStorageRepair, loadDoctor } from '../cli-lazy-components.js';

export function configureKodaXDoctorCommand(program: Command, version: string): void {
  // ============== doctor subcommand (FEATURE_204) ==============
  program
    .command('doctor')
    .description(
      'Print environment diagnostics (runtime, providers, session/trace disk usage)',
    )
    .option('--json', 'Output machine-readable JSON')
    .option('--inspect-storage <target.json>', 'Inspect one explicit storage target without modifying it')
    .option('--repair-storage <plan.json>', 'Apply an inspected offline storage repair plan, retaining original bytes')
    .option('--repair-candidate <file>', 'Complete recovery snapshot for offline storage repair')
    .option('--verify-storage <receipt.json>', 'Confirm an externally verified restored state before resuming access')
    .option('--writers-stopped', 'Acknowledge every shared CLI, Host and SDK writer has stopped')
    .option('--verified-current-state', 'Confirm the restored state and external effects have been independently verified')
    .option(
      '--ping',
      'Live-probe each configured provider (network + small token cost)',
    )
    .option(
      '--native-text',
      'Load and hash-check the trusted text native binding',
    )
    .action(async (opts: { json?: boolean; ping?: boolean; nativeText?: boolean; inspectStorage?: string; repairStorage?: string;
      repairCandidate?: string; verifyStorage?: string; writersStopped?: boolean; verifiedCurrentState?: boolean }) => {
      if (opts.inspectStorage || opts.repairStorage || opts.verifyStorage || opts.repairCandidate || opts.writersStopped || opts.verifiedCurrentState) {
        const { runStorageRepairCli } = await loadStorageRepair();
        await runStorageRepairCli(opts); return;
      }
      const { runDoctor } = await loadDoctor();
      process.exitCode = await runDoctor(version, Boolean(opts?.json), {
        ping: Boolean(opts?.ping),
        nativeText: Boolean(opts?.nativeText),
      });
    });
}
