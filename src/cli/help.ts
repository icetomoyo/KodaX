import chalk from 'chalk';
import { getAvailableProviderNames } from '@kodax-ai/coding';
import { HELP_EFFORT, HELP_REPO_INTELLIGENCE, HELP_SESSION, HELP_THINKING } from './root.js';

// ============== CLI Help Topics ==============

function printHelpLine(label: string, description = ''): void {
  console.log(chalk.dim(label) + description);
}

function printHelpHeading(text: string): void {
  console.log(chalk.bold(text));
}

const CLI_HELP_TOPICS: Record<string, () => void> = {
  acp: () => {
    console.log(chalk.cyan('\nACP Server\n'));
    printHelpHeading('Overview:');
    printHelpLine('  Run KodaX as a stdio ACP server so editors and IDEs can connect directly.');
    printHelpLine('  Session creation, prompt streaming, cancellation, and permission prompts reuse KodaX runtime semantics.\n');
    printHelpHeading('Command:');
    printHelpLine('  kodax acp serve [options]\n');
    printHelpHeading('Options:');
    printHelpLine('  --cwd <dir>                  ', 'Working directory exposed to ACP sessions');
    printHelpLine('  -m, --provider <name>        ', 'Provider to use');
    printHelpLine('  --model <name>               ', 'Model override');
    printHelpLine('  --effort <level>             ', HELP_EFFORT);
    printHelpLine('  --reasoning <mode>           ', 'Compatibility mode: off, auto, quick, balanced, deep');
    printHelpLine('  --repo-intelligence <mode>   ', HELP_REPO_INTELLIGENCE);
    printHelpLine('  --repo-intelligence-trace    ', 'Emit repo intelligence trace metadata/logging');
    printHelpLine('  -t, --thinking               ', HELP_THINKING);
    printHelpLine('  --permission-mode <mode>     ', 'Initial mode: plan, accept-edits, auto, full-access');
    printHelpLine('  KODAX_ACP_LOG=<level>        ', 'stderr log level: off, error, info, debug\n');
    printHelpHeading('Examples:');
    printHelpLine('  kodax acp serve');
    printHelpLine('  kodax acp serve --cwd C:\\repo --permission-mode accept-edits');
    printHelpLine('  kodax acp serve -m openai --model gpt-5.4 --effort medium\n');
  },
  skill: () => {
    console.log(chalk.cyan('\nSkill Utilities\n'));
    printHelpHeading('Overview:');
    printHelpLine('  Use built-in skill packaging commands without starting an agent session.');
    printHelpLine('  These commands are thin wrappers around the builtin skill-creator tools.\n');
    printHelpHeading('Commands:');
    printHelpLine('  kodax skill init <name> [options]   ', 'Create a new skill scaffold');
    printHelpLine('  kodax skill validate <dir>          ', 'Validate a skill directory');
    printHelpLine('  kodax skill eval --skill-path ...   ', 'Run end-to-end eval workspace generation');
    printHelpLine('  kodax skill grade <workspace>       ', 'Grade eval runs into grading.json files');
    printHelpLine('  kodax skill analyze <workspace>     ', 'Analyze benchmark variance and failures');
    printHelpLine('  kodax skill compare <workspace>     ', 'Blind-compare two configs across runs');
    printHelpLine('  kodax skill package <dir> [options] ', 'Package a skill as .skill');
    printHelpLine('  kodax skill install <input> [opts]  ', 'Install a skill from dir or .skill');
    printHelpHeading('Examples:');
    printHelpLine('  kodax skill init release-notes --dest ./.kodax/skills');
    printHelpLine('  kodax skill validate ./.kodax/skills/my-skill');
    printHelpLine('  kodax skill eval --skill-path ./.kodax/skills/my-skill --evals ./.kodax/skills/my-skill/evals/evals.json --workspace ./iteration-1');
    printHelpLine('  kodax skill grade ./iteration-1');
    printHelpLine('  kodax skill analyze ./iteration-1');
    printHelpLine('  kodax skill compare ./iteration-1 --config-a with_skill --config-b without_skill');
    printHelpLine('  kodax skill package ./.kodax/skills/my-skill --output ./my-skill.skill');
    printHelpLine('  kodax skill install ./my-skill.skill --dest ~/.kodax/skills --force\n');
  },
  sessions: () => {
    console.log(chalk.cyan('\nSession Management\n'));
    printHelpHeading('Overview:');
    printHelpLine('  KodaX automatically saves conversation sessions, allowing you to');
    printHelpLine('  resume work later or switch between different conversations.\n');
    printHelpHeading('Options:');
    printHelpLine('  -c, --continue       ', 'Continue most recent non-empty conversation');
    printHelpLine('  -r, --resume [value] ', 'Resume by ID or exact title (no value = searchable picker)');
    printHelpLine('  -s, --session <op>   ', HELP_SESSION);
    printHelpLine('  --no-session         ', 'Disable session persistence (print mode only)\n');
    printHelpHeading('Examples:');
    printHelpLine('  kodax                      ', '# Start new session (interactive)');
    printHelpLine('  kodax -c                   ', '# Continue recent conversation');
    printHelpLine('  kodax -r                   ', '# Search and select a saved session');
    printHelpLine('  kodax -r <session-id>      ', '# Resume specific session');
    printHelpLine('  kodax -r "Review runtime"  ', '# Resume a unique exact title; duplicates open the picker');
    printHelpLine('  kodax -s list              ', '# List all sessions');
    printHelpLine('  kodax -s delete <id>       ', '# Delete a session');
    printHelpLine('  kodax -p "task" --no-session', ' # Run without saving\n');
  },
  project: () => {
    console.log(chalk.cyan('\nProject Mode\n'));
    printHelpHeading('Overview:');
    printHelpLine('  Project mode spans two surfaces: non-REPL bootstrap commands and REPL /project commands.');
    printHelpLine('  Current workflow includes planning, quality review, brainstorm sessions, harness-verified execution, and runtime artifacts under .agent/project/.\n');
    printHelpHeading('REPL /project Commands:');
    printHelpLine('  /project status [prompt] [--features|--progress]', '  Status + guided analysis');
    printHelpLine('  /project plan [#index|topic]                 ', '  Generate project or feature planning truth');
    printHelpLine('  /project quality                             ', '  Deterministic workflow health + release review');
    printHelpLine('  /project brainstorm                          ', '  UI-driven discovery flow');
    printHelpLine('  /project next [prompt|#index] [--no-confirm] ', '  Harness-verified feature execution');
    printHelpLine('  /project auto [prompt] [--max=N|--confirm]   ', '  REPL-side auto-continue with pause support');
    printHelpLine('  /project pause                               ', '  Stop /project auto');
    printHelpLine('  /project verify [#index|--last]              ', '  Rerun deterministic harness verification');
    printHelpLine('  /project edit <prompt>                       ', '  Edit current-stage truth');
    printHelpLine('  /project analyze [prompt]                    ', '  AI project analysis');
    printHelpLine('  /project reset [--all]                       ', '  Clear progress or remove project truth files\n');
    printHelpHeading('Current Semantics:');
    printHelpLine('  - /project next and /project auto are verifier-gated, not self-declared completion');
    printHelpLine('  - /project plan writes the latest plan to .agent/project/session_plan.md');
    printHelpLine('  - /project quality combines deterministic checks with optional model-generated guidance');
    printHelpLine('  - /project brainstorm aligns requirements into .agent/project/alignment.md\n');
    printHelpHeading('Examples:');
    printHelpLine('  kodax -h project');
    printHelpLine('  kodax  # then: /project brainstorm -> /project plan -> /project next');
    printHelpLine('  kodax  # then: /project quality | /project verify --last | /project auto --max=3\n');
  },
  auto: () => {
    console.log(chalk.cyan('\nAuto Mode\n'));
    printHelpHeading('Auto Mode (-y, --auto):');
    printHelpLine('  Backward-compatibility alias kept for scripts.');
    printHelpLine('  Non-REPL CLI already runs in auto mode by default, so this flag currently has no additional effect.\n');
    printHelpHeading('Options:');
    printHelpLine('  -y, --auto             ', 'Backward-compat alias (no-op in non-REPL CLI)\n');
    printHelpHeading('Examples:');
    printHelpLine('  kodax -y "refactor code"          ', '# Legacy alias; same as plain non-REPL run\n');
  },
  provider: () => {
    const providerNames = getAvailableProviderNames();
    console.log(chalk.cyan('\nLLM Providers\n'));
    printHelpHeading('Overview:');
    printHelpLine('  KodaX supports multiple LLM providers. Configure via -m option');
    printHelpLine('  or set default in ~/.kodax/config.json. Use --model to override the default model.\n');
    printHelpHeading('Available Providers:');
    providerNames.forEach((name) => {
      const detail =
        name === 'gemini-cli' || name === 'codex-cli'
          ? 'CLI bridge provider (latest-user-message only, MCP unavailable)'
          : 'Native provider';
      console.log(chalk.dim(`  ${name.padEnd(15)} `) + detail);
    });
    console.log();
    printHelpHeading('Key Options:');
    printHelpLine('  -m, --provider <name> ', 'Provider to use');
    printHelpLine('  --model <name>        ', 'Model override for the selected provider\n');
    printHelpHeading('Examples:');
    printHelpLine('  kodax -m anthropic "task"     ', '# Use Claude');
    printHelpLine('  kodax -m openai --model gpt-5.4 "task"', '# Override model');
    printHelpLine('  /model                        ', '# Switch in REPL (saves to config)\n');
  },
  thinking: () => {
    console.log(chalk.cyan('\nReasoning Effort\n'));
    console.log(
      'Use --effort <level> or /effort <level>.\n'
      + 'Levels: none, minimal, auto, low, medium, high, xhigh, max, or model-supported values.\n'
      + 'Example: kodax --effort high "design the architecture"\n'
      + 'Legacy --reasoning <mode> and -t/--thinking remain accepted.\n',
    );
  },
  print: () => {
    console.log(chalk.cyan('\nPrint Mode\n'));
    printHelpHeading('Overview:');
    printHelpLine('  Run a single task and exit. Useful for scripting and CI/CD.\n');
    printHelpLine('  `--mode json` is a scripting surface, not the ACP server protocol.\n');
    printHelpHeading('Options:');
    printHelpLine('  -p, --print <text>  ', 'Run task and exit');
    printHelpLine('  --mode json         ', 'Emit newline-delimited JSON events to stdout for scripts/CI');
    printHelpLine('  --model <name>      ', 'Override the selected provider model');
    printHelpLine('  --no-session        ', 'Disable session saving\n');
    printHelpHeading('Examples:');
    printHelpLine('  kodax -p "fix the bug in auth.ts"   ', '# Quick fix');
    printHelpLine('  kodax -p "generate tests" --effort medium', ' # With reasoning');
    printHelpLine('  kodax -p "task" -m openai --model gpt-5.4', ' # Provider + model override');
    printHelpLine('  kodax -p "task" --no-session        ', '# Stateless run');
    printHelpLine('  kodax --mode json "inspect auth flow"', ' # Structured JSONL output');
    printHelpLine('  kodax -p "task" -m anthropic --effort high', ' # Explicit provider selection\n');
  },
};

export function showCliHelpTopic(topic: string): boolean {
  const helpFn = CLI_HELP_TOPICS[topic.toLowerCase()];
  if (helpFn) {
    helpFn();
    return true;
  }
  return false;
}

export function showCliHelpTopics(): void {
  console.log(chalk.cyan('\nDetailed Help Topics:\n'));
  console.log(
    chalk.dim('  kodax -h acp        ') +
      'ACP server mode for editors and IDEs',
  );
  console.log(
    chalk.dim('  kodax -h sessions   ') +
      'Session management (-c, -r, -s options)',
  );
  console.log(
    chalk.dim('  kodax -h skill      ') +
      'Skill packaging and installation helpers',
  );
  console.log(
    chalk.dim('  kodax -h project    ') +
      'Project mode workflow across CLI and /project',
  );
  console.log(
    chalk.dim('  kodax -h auto       ') + 'Auto mode backward-compat alias',
  );
  console.log(chalk.dim('  kodax -h provider   ') + 'LLM provider options');
  console.log(
    chalk.dim('  kodax -h thinking   ') + 'Reasoning modes and depth control',
  );
  console.log(
    chalk.dim('  kodax -h print      ') + 'Print mode for scripting\n',
  );
}

export function printAcpSubcommandHelp(name: string): boolean {
  if (name === 'serve') {
    console.log('Usage: kodax acp serve [options]');
    console.log();
    console.log('Run KodaX as a stdio ACP server for editors and IDEs.');
    console.log();
    console.log('Options:');
    console.log(
      '  --cwd <dir>                  Working directory exposed to ACP sessions',
    );
    console.log('  -m, --provider <name>        Provider to use');
    console.log('  --model <name>               Model override');
    console.log(
      '  --effort <level>             Reasoning effort: off, auto, low, medium, high, xhigh, max, or model-supported value',
    );
    console.log(
      '  -t, --thinking               Compatibility alias for --reasoning auto',
    );
    console.log(
      '  --reasoning <mode>           Reasoning mode: off, auto, quick, balanced, deep',
    );
    console.log(
      '  --repo-intelligence <mode>   Repo intelligence mode: auto, full, light, off',
    );
    console.log(
      '  --repo-intelligence-trace    Emit repo intelligence trace metadata/logging',
    );
    console.log('  --permission-mode <mode>     Initial permission mode');
    console.log(
      '  KODAX_ACP_LOG=<level>        stderr log level: off, error, info, debug',
    );
    return true;
  }

  return false;
}

export function printSkillSubcommandHelp(name: string): boolean {
  if (name === 'init') {
    console.log('Usage: kodax skill init [options] <name>');
    console.log();
    console.log('Initialize a new skill scaffold.');
    console.log();
    console.log('Options:');
    console.log('  -d, --dest <dir>         Base skills directory');
    console.log('  --description <text>     Initial skill description');
    console.log(
      '  -f, --force              Allow writing into an existing target directory',
    );
    console.log('  --no-evals               Skip creating evals/evals.json');
    return true;
  }

  if (name === 'validate') {
    console.log('Usage: kodax skill validate <skillDir>');
    console.log();
    console.log('Validate a skill directory using builtin skill-creator.');
    return true;
  }

  if (name === 'eval') {
    console.log('Usage: kodax skill eval [options]');
    console.log();
    console.log(
      'Run end-to-end skill evals and write a benchmark/review workspace.',
    );
    console.log();
    console.log('Required Options:');
    console.log('  --skill-path <dir>       Skill directory to evaluate');
    console.log('  --evals <file>           Evals JSON file');
    console.log('  --workspace <dir>        Workspace output directory');
    console.log();
    console.log('Options:');
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --runs <n>               Runs per config');
    console.log('  --max-iter <n>           Max iterations per run');
    console.log('  --reasoning <mode>       Reasoning mode');
    console.log('  --cwd <dir>              Working directory for the runs');
    console.log(
      '  --configs <list>         Comma-separated configs, e.g. with_skill,without_skill',
    );
    console.log('  -o, --output <file>      Optional JSON summary output');
    return true;
  }

  if (name === 'grade') {
    console.log('Usage: kodax skill grade [options] <workspace>');
    console.log();
    console.log('Grade eval runs into grading.json files.');
    console.log();
    console.log('Options:');
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --reasoning <mode>       Reasoning mode');
    console.log('  --max-iter <n>           Max iterations per grading run');
    console.log(
      '  --configs <list>         Comma-separated configs, e.g. with_skill,without_skill',
    );
    console.log(
      '  --overwrite              Re-grade runs that already have grading.json',
    );
    return true;
  }

  if (name === 'analyze') {
    console.log('Usage: kodax skill analyze [options] <workspace>');
    console.log();
    console.log(
      'Analyze benchmark variance and write analysis.json + analysis.md.',
    );
    console.log();
    console.log('Options:');
    console.log('  --benchmark <file>       Optional benchmark.json path');
    console.log('  --output <file>          JSON output path');
    console.log('  --markdown <file>        Markdown output path');
    console.log(
      '  --skill-name <name>      Skill name if benchmark.json must be regenerated',
    );
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --reasoning <mode>       Reasoning mode');
    return true;
  }

  if (name === 'compare') {
    console.log('Usage: kodax skill compare [options] <workspace>');
    console.log();
    console.log('Blind-compare two configs across eval run pairs.');
    console.log();
    console.log('Options:');
    console.log(
      '  --config-a <name>        Primary config (default: with_skill)',
    );
    console.log(
      '  --config-b <name>        Baseline config (default: without_skill)',
    );
    console.log('  --output <file>          JSON output path');
    console.log('  --markdown <file>        Markdown output path');
    console.log('  --max-pairs <n>          Limit pairs per eval');
    console.log('  --provider <name>        Provider to use');
    console.log('  --model <name>           Model override');
    console.log('  --reasoning <mode>       Reasoning mode');
    return true;
  }

  if (name === 'package') {
    console.log('Usage: kodax skill package [options] <skillDir>');
    console.log();
    console.log('Package a skill directory as a .skill archive.');
    console.log();
    console.log('Options:');
    console.log('  -o, --output <file>      Output .skill file path');
    return true;
  }

  if (name === 'install') {
    console.log('Usage: kodax skill install [options] <input>');
    console.log();
    console.log(
      'Install a skill directory or .skill archive into a skills directory.',
    );
    console.log();
    console.log('Options:');
    console.log('  -d, --dest <dir>         Destination skills directory');
    console.log(
      '  -f, --force              Overwrite an existing target skill',
    );
    return true;
  }

  return false;
}

export function showBasicHelp(): void {
  const providerNames = getAvailableProviderNames().join(', ');
  console.log('KodaX - Intelligent Coding Agent\n');
  console.log('Usage: kodax [options] [prompt]');
  console.log('       kodax "your task"');
  console.log('       kodax /command_name\n');
  console.log('Options:');
  console.log(
    '  -h, --help [TOPIC]      Show help, or detailed help for a topic',
  );
  console.log('  -p, --print TEXT        Print mode: run single task and exit');
  console.log(
    '  --mode json             Emit newline-delimited JSON events to stdout for scripts/CI',
  );
  console.log(
    '  -c, --continue          Continue most recent non-empty conversation',
  );
  console.log(
    '  -r, --resume [value]    Resume by ID or exact title (no value = searchable picker)',
  );
  console.log(
    '  -n, --new               Legacy no-op; current CLI already starts a fresh session by default',
  );
  console.log(`  -m, --provider NAME     LLM provider (${providerNames})`);
  process.stdout.write('  --work-mode MODE        Session work mode: agent, coding (default), script\n');
  console.log(
    '  --model NAME            Model override for the selected provider',
  );
  console.log(
    '  -t, --thinking          Compatibility alias for --reasoning auto',
  );
  console.log(
    '  --effort LEVEL          Reasoning effort: off, auto, low, medium, high, xhigh, max, or model-supported value',
  );
  console.log(
    '  --reasoning MODE        Compatibility mode: off, auto, quick, balanced, deep',
  );
  console.log(
    '  -y, --auto              Backward-compat alias; no effect in non-REPL CLI',
  );
  console.log(
    '  -s, --session OP        Legacy session operations: list, resume, delete <id>, delete-all, or raw session ID',
  );
  console.log(
    '  --no-session            Disable session persistence (print mode only)',
  );
  console.log(
    '  --max-iter N            Max iterations per session (default: 200)\n',
  );
  process.stdout.write(
    '  kodax setup             Configure provider/model metadata (never stores an API key)\n\n',
  );
  console.log('Help Topics (use -h <topic>):');
  console.log(
    '  acp, skill, sessions, project, auto, provider, thinking, print\n',
  );
  console.log('Interactive Commands (in REPL mode):');
  console.log('  /help, /h               Show all commands');
  console.log('  /exit, /quit            Exit interactive mode');
  console.log('  /clear                  Clear the conversation and continue in a new session');
  console.log('  /status                 Show session status');
  process.stdout.write('  /work-mode [agent|coding|script]  Select work mode while idle\n');
  console.log('  /mode [plan|accept-edits|auto|full-access]  Switch permission mode');
  console.log('  /project ...            Project workflow commands');
  console.log('  /sessions               List saved sessions\n');
  console.log('Examples:');
  console.log('  kodax                             # Enter interactive mode');
  process.stdout.write(
    '  kodax setup                       # Configure provider/model, then restart terminal\n',
  );
  console.log(
    '  kodax "create a component"        # Run single task (with session)',
  );
  console.log('  kodax acp serve                   # Start ACP stdio server');
  console.log('  kodax skill init my-skill         # Scaffold a new skill');
  console.log(
    '  kodax skill package ./my-skill    # Package a skill without starting the agent',
  );
  console.log(
    '  kodax -h project                 # Project mode workflow across CLI and REPL',
  );
  console.log(
    '  kodax -p "quick fix" --effort medium  # Quick task with reasoning',
  );
  console.log(
    '  kodax -c                          # Continue recent conversation',
  );
  console.log('  kodax -c "finish this"            # Continue with new task');
  console.log(
    '  kodax -r                          # Search and select a saved session',
  );
  console.log(
    '  kodax -r "Review runtime"         # Resume by unique exact title',
  );
  console.log(
    '  kodax -p "task" --model gpt-5.4   # Override model for a one-off run',
  );
  console.log(
    '  kodax -p "task" --no-session      # Run without saving session',
  );
  console.log(
    '  kodax -h sessions                 # Detailed help on sessions\n',
  );
}
