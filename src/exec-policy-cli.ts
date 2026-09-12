import path from 'node:path';
import { Option, type Command } from 'commander';
import {
  createExecPolicyOperation,
  evaluateExecPolicy,
  evaluateShellExecPolicy,
  loadExecPolicy,
  type ExecPolicyDecision,
  type ExecPolicyRule,
  type KodaXShellPermissionMode,
} from '@kodax-ai/coding';
import { getGitRoot, KODAX_DIR } from '@kodax-ai/repl';

export interface ExecPolicyCheckReport {
  readonly command: readonly string[];
  readonly permissionMode?: KodaXShellPermissionMode;
  readonly decision: ExecPolicyDecision | 'unmatched';
  readonly criticalFallback: boolean;
  readonly matchedRules: readonly ExecPolicyRule[];
}

export interface ExecPolicyCliDependencies {
  readonly configHome?: string;
  readonly findProjectRoot?: (cwd: string) => Promise<string | null>;
  readonly writeOutput?: (text: string) => void;
}

export function configureKodaXExecPolicyCommand(
  program: Command,
  dependencies: ExecPolicyCliDependencies = {},
): Command {
  const execPolicy = program
    .command('execpolicy')
    .description('Inspect deterministic host execution policy');
  execPolicy
    .command('check')
    .description('Check a command without executing it')
    .addOption(new Option('--mode <mode>', 'Permission profile (omitted: conservative built-in fallbacks)')
      .choices(['plan', 'accept-edits', 'auto', 'full-access']))
    .option('--cwd <dir>', 'Repository directory used to locate project policy')
    .option(
      '--trust-project-policy',
      'Include <repository>/.kodax/exec-policy.jsonc for this check',
    )
    .option(
      '--host-executable <path>',
      'Exact host launcher executable used for qualified policy matching',
    )
    .option('--pretty', 'Pretty-print JSON output')
    .argument('<command...>', 'Command tokens to inspect')
    .allowUnknownOption()
    .action(async (
      command: string[],
      options: {
        readonly cwd?: string;
        readonly mode?: KodaXShellPermissionMode;
        readonly hostExecutable?: string;
        readonly trustProjectPolicy?: boolean;
        readonly pretty?: boolean;
      },
    ) => {
      const cwd = path.resolve(options.cwd ?? process.cwd());
      const projectRoot = await (dependencies.findProjectRoot ?? getGitRoot)(cwd);
      const loaded = await loadExecPolicy({
        userConfigDir: dependencies.configHome ?? KODAX_DIR,
        ...(projectRoot === null ? {} : { projectRoot }),
        ...(options.trustProjectPolicy === true ? { trustProjectPolicy: true } : {}),
      });
      if (loaded.errors.length > 0) {
        throw new Error(loaded.errors
          .map((error) => `${error.path}: ${error.message}`)
          .join('\n'));
      }
      const hostFacts = {
        ...(options.hostExecutable === undefined ? {} : { hostExecutable: options.hostExecutable }),
        ...(options.mode === undefined ? {} : { permissionMode: options.mode }),
      };
      const evaluated = command.length === 1
        ? evaluateShellExecPolicy(command[0]!, loaded.rules, hostFacts)
        : evaluateExecPolicy(
            createExecPolicyOperation(command, { ...hostFacts, compound: false }),
            loaded.rules,
          );
      const report: ExecPolicyCheckReport = {
        command,
        ...(options.mode === undefined ? {} : { permissionMode: options.mode }),
        decision: evaluated.decision,
        criticalFallback: evaluated.criticalFallback,
        matchedRules: evaluated.matched,
      };
      const serialized = options.pretty === true
        ? JSON.stringify(report, null, 2)
        : JSON.stringify(report);
      (dependencies.writeOutput ?? ((text: string) => process.stdout.write(text)))(
        `${serialized}\n`,
      );
    });
  return execPolicy;
}
