import type { Command } from 'commander';
import { getAvailableProviderNames } from '@kodax-ai/coding';
import { EFFORT_LEVELS, findKodaXCommand, loadLazyCommand } from './root.js';

/** Printed after the generated `kodax -h`: what the option list cannot show. */
export const ROOT_HELP_FOOTER = `
Examples:
  kodax                                 Start the interactive REPL
  kodax "create a component"            Run one task, then exit
  kodax -p "quick fix" --effort medium  Run one task in print mode
  kodax -c "finish this"                Continue the most recent conversation here
  kodax -r                              Search saved sessions and resume one
  kodax setup                           Choose a provider and model
  kodax host status                     Check the background Host

More help:
  kodax -h <command>                    Help for one command, e.g. kodax -h host
  kodax -h provider|thinking|print      Providers, reasoning effort, print mode
  /help                                 Commands inside the REPL
`;

/** Topics that are not commands. A command name given to `-h` shows that command's help instead. */
const CLI_HELP_TOPICS: Readonly<Record<string, () => string>> = {
  provider: () => {
    const providers = getAvailableProviderNames().map((name) => {
      const kind = name === 'gemini-cli' || name === 'codex-cli'
        ? 'CLI bridge provider (latest-user-message only, MCP unavailable)'
        : 'Native provider';
      return `  ${name.padEnd(15)} ${kind}`;
    });
    return [
      'LLM providers',
      '',
      'Pick one with -m/--provider, or set "provider" in ~/.kodax/config.json.',
      'Override its default model with --model. In the REPL, /model switches and saves.',
      '',
      'Available providers:',
      ...providers,
      '',
      'Examples:',
      '  kodax -m anthropic "task"',
      '  kodax -m openai --model gpt-5.4 "task"',
    ].join('\n');
  },
  thinking: () => [
    'Reasoning effort',
    '',
    'Use --effort <level>, or /effort <level> in the REPL.',
    `Levels: ${EFFORT_LEVELS.join(', ')}, or a value the model supports.`,
    'Example: kodax --effort high "design the architecture"',
    '',
    'Still accepted: --reasoning <off|auto|quick|balanced|deep>, and -t/--thinking for --reasoning auto.',
  ].join('\n'),
  print: () => [
    'Print mode',
    '',
    'Run a single task and exit. Useful for scripting and CI/CD.',
    '`--mode json` is a scripting surface, not the ACP server protocol.',
    '',
    'Options:',
    '  -p, --print <text>  Run the task and exit',
    '  --mode json         Write newline-delimited JSON events to stdout',
    '  --model <name>      Override the selected provider model',
    '  --no-session        Do not save the session',
    '',
    'Examples:',
    '  kodax -p "fix the bug in auth.ts"',
    '  kodax -p "generate tests" --effort medium',
    '  kodax -p "task" -m openai --model gpt-5.4',
    '  kodax -p "task" --no-session',
    '  kodax --mode json "inspect auth flow"',
  ].join('\n'),
};

/**
 * `kodax -h [topic]`: the whole command tree, one command's help, or a topic.
 * An unknown topic is a usage error.
 */
export async function showKodaXHelp(program: Command, topic: string | true): Promise<void> {
  if (topic === true) {
    program.outputHelp();
    return;
  }
  const command = findKodaXCommand(program, topic);
  if (command !== undefined) {
    await loadLazyCommand(program, command);
    command.outputHelp();
    return;
  }
  const renderTopic = CLI_HELP_TOPICS[topic.toLowerCase()];
  if (renderTopic !== undefined) {
    process.stdout.write(`${renderTopic()}\n`);
    return;
  }
  process.stderr.write(`Unknown help topic: ${topic}. Run \`kodax -h\` for commands and topics.\n`);
  process.exitCode = 2;
}
