import { Command } from 'commander';
import { parseReasoningModeOption, mergeCommandOptionsWithGlobals } from '../cli_option_helpers.js';
import { runSkillCreatorTool } from '../skill_cli.js';

export function configureKodaXSkillCommand(program: Command): Command {
  const skillCommand = program
    .command('skill')
    .description('Built-in skill packaging and installation helpers')
    .helpOption('-h, --help', 'Show skill utility help');

  skillCommand
    .command('init <name>')
    .description('Initialize a new skill scaffold')
    .option('-d, --dest <dir>', 'Base skills directory')
    .option('--description <text>', 'Initial skill description')
    .option('-f, --force', 'Allow writing into an existing target directory')
    .option('--no-evals', 'Skip creating evals/evals.json')
    .action(
      async (
        name: string,
        subcommandOptions: {
          dest?: string;
          description?: string;
          force?: boolean;
          evals?: boolean;
        },
      ) => {
        const args = [name];
        if (subcommandOptions.dest) {
          args.push('--dest', subcommandOptions.dest);
        }
        if (subcommandOptions.description) {
          args.push('--description', subcommandOptions.description);
        }
        if (subcommandOptions.force) {
          args.push('--force');
        }
        if (subcommandOptions.evals === false) {
          args.push('--no-evals');
        }
        await runSkillCreatorTool('init', args);
      },
    );

  skillCommand
    .command('validate <skillDir>')
    .description('Validate a skill directory using builtin skill-creator')
    .action(async (skillDir: string) => {
      await runSkillCreatorTool('validate', [skillDir]);
    });

  skillCommand
    .command('eval')
    .description(
      'Run end-to-end skill evals and write a benchmark/review workspace',
    )
    .requiredOption('--skill-path <dir>', 'Skill directory to evaluate')
    .requiredOption('--evals <file>', 'Evals JSON file')
    .requiredOption('--workspace <dir>', 'Workspace output directory')
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--runs <n>', 'Runs per config')
    .option('--max-iter <n>', 'Max iterations per run')
    .option('--reasoning <mode>', 'Reasoning mode', parseReasoningModeOption)
    .option('--cwd <dir>', 'Working directory for the runs')
    .option(
      '--configs <list>',
      'Comma-separated configs, e.g. with_skill,without_skill',
    )
    .option('-o, --output <file>', 'Optional JSON summary output')
    .action(
      async (
        localOptions: {
          skillPath: string;
          evals: string;
          workspace: string;
          provider?: string;
          model?: string;
          runs?: string;
          maxIter?: string;
          reasoning?: string;
          cwd?: string;
          configs?: string;
          output?: string;
        },
        command: Command,
      ) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        const args = [
          '--skill-path',
          options.skillPath,
          '--evals',
          options.evals,
          '--workspace',
          options.workspace,
        ];
        if (options.provider) {
          args.push('--provider', options.provider);
        }
        if (options.model) {
          args.push('--model', options.model);
        }
        if (options.runs) {
          args.push('--runs', options.runs);
        }
        if (options.maxIter) {
          args.push('--max-iter', options.maxIter);
        }
        if (options.reasoning) {
          args.push('--reasoning', options.reasoning);
        }
        if (options.cwd) {
          args.push('--cwd', options.cwd);
        }
        if (options.configs) {
          args.push('--configs', options.configs);
        }
        if (options.output) {
          args.push('--output', options.output);
        }
        await runSkillCreatorTool('eval', args);
      },
    );

  skillCommand
    .command('grade <workspace>')
    .description('Grade eval runs into grading.json files')
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--reasoning <mode>', 'Reasoning mode', parseReasoningModeOption)
    .option('--max-iter <n>', 'Max iterations per grading run')
    .option(
      '--configs <list>',
      'Comma-separated configs, e.g. with_skill,without_skill',
    )
    .option('--overwrite', 'Re-grade runs that already have grading.json')
    .action(
      async (
        workspace: string,
        localOptions: {
          provider?: string;
          model?: string;
          reasoning?: string;
          maxIter?: string;
          configs?: string;
          overwrite?: boolean;
        },
        command: Command,
      ) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        const args = [workspace];
        if (options.provider) {
          args.push('--provider', options.provider);
        }
        if (options.model) {
          args.push('--model', options.model);
        }
        if (options.reasoning) {
          args.push('--reasoning', options.reasoning);
        }
        if (options.maxIter) {
          args.push('--max-iter', options.maxIter);
        }
        if (options.configs) {
          args.push('--configs', options.configs);
        }
        if (options.overwrite) {
          args.push('--overwrite');
        }
        await runSkillCreatorTool('grade', args);
      },
    );

  skillCommand
    .command('analyze <workspace>')
    .description('Analyze benchmark variance and write analysis artifacts')
    .option('--benchmark <file>', 'Optional benchmark.json path')
    .option('--output <file>', 'JSON output path')
    .option('--markdown <file>', 'Markdown output path')
    .option(
      '--skill-name <name>',
      'Skill name if benchmark.json must be regenerated',
    )
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--reasoning <mode>', 'Reasoning mode', parseReasoningModeOption)
    .action(
      async (
        workspace: string,
        localOptions: {
          benchmark?: string;
          output?: string;
          markdown?: string;
          skillName?: string;
          provider?: string;
          model?: string;
          reasoning?: string;
        },
        command: Command,
      ) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        const args = [workspace];
        if (options.benchmark) {
          args.push('--benchmark', options.benchmark);
        }
        if (options.output) {
          args.push('--output', options.output);
        }
        if (options.markdown) {
          args.push('--markdown', options.markdown);
        }
        if (options.skillName) {
          args.push('--skill-name', options.skillName);
        }
        if (options.provider) {
          args.push('--provider', options.provider);
        }
        if (options.model) {
          args.push('--model', options.model);
        }
        if (options.reasoning) {
          args.push('--reasoning', options.reasoning);
        }
        await runSkillCreatorTool('analyze', args);
      },
    );

  skillCommand
    .command('compare <workspace>')
    .description('Blind-compare two configs across eval run pairs')
    .option('--config-a <name>', 'Primary config', 'with_skill')
    .option('--config-b <name>', 'Baseline config', 'without_skill')
    .option('--output <file>', 'JSON output path')
    .option('--markdown <file>', 'Markdown output path')
    .option('--max-pairs <n>', 'Limit pairs per eval')
    .option('--provider <name>', 'Provider to use')
    .option('--model <name>', 'Model override')
    .option('--reasoning <mode>', 'Reasoning mode', parseReasoningModeOption)
    .action(
      async (
        workspace: string,
        localOptions: {
          configA: string;
          configB: string;
          output?: string;
          markdown?: string;
          maxPairs?: string;
          provider?: string;
          model?: string;
          reasoning?: string;
        },
        command: Command,
      ) => {
        const options = mergeCommandOptionsWithGlobals(localOptions, command);
        const args = [
          workspace,
          '--config-a',
          options.configA,
          '--config-b',
          options.configB,
        ];
        if (options.output) {
          args.push('--output', options.output);
        }
        if (options.markdown) {
          args.push('--markdown', options.markdown);
        }
        if (options.maxPairs) {
          args.push('--max-pairs', options.maxPairs);
        }
        if (options.provider) {
          args.push('--provider', options.provider);
        }
        if (options.model) {
          args.push('--model', options.model);
        }
        if (options.reasoning) {
          args.push('--reasoning', options.reasoning);
        }
        await runSkillCreatorTool('compare', args);
      },
    );

  skillCommand
    .command('package <skillDir>')
    .description('Package a skill directory as a .skill archive')
    .option('-o, --output <file>', 'Output .skill file path')
    .action(
      async (skillDir: string, subcommandOptions: { output?: string }) => {
        const args = [skillDir];
        if (subcommandOptions.output) {
          args.push('--output', subcommandOptions.output);
        }
        await runSkillCreatorTool('package', args);
      },
    );

  skillCommand
    .command('install <input>')
    .description(
      'Install a skill directory or .skill archive into a skills directory',
    )
    .option('-d, --dest <dir>', 'Destination skills directory')
    .option('-f, --force', 'Overwrite an existing target skill')
    .action(
      async (
        input: string,
        subcommandOptions: { dest?: string; force?: boolean },
      ) => {
        const args = [input];
        if (subcommandOptions.dest) {
          args.push('--dest', subcommandOptions.dest);
        }
        if (subcommandOptions.force) {
          args.push('--force');
        }
        await runSkillCreatorTool('install', args);
      },
    );

  return skillCommand;
}
