import { Argument, Command, Help, Option } from 'commander';
import { getAvailableProviderNames } from '@kodax-ai/coding';
import {
  ACP_PERMISSION_MODES,
  KODAX_REPO_INTELLIGENCE_PUBLIC_MODES,
  parseEffortOption,
  parseOutputModeOption,
  parsePermissionModeOption,
  parseReasoningModeOption,
  parseRepoIntelligenceModeOption,
  parseWorkModeOption,
} from '../cli_option_helpers.js';
import { KODAX_REASONING_MODE_SEQUENCE } from '@kodax-ai/coding';
import { EFFORT_LEVELS, loadLazyCommand } from './root.js';

/** Values to offer for options whose parser accepts a known set. */
const VALUES_BY_PARSER = new Map<unknown, readonly string[]>([
  [parseEffortOption, EFFORT_LEVELS],
  [parseReasoningModeOption, KODAX_REASONING_MODE_SEQUENCE],
  [parseRepoIntelligenceModeOption, KODAX_REPO_INTELLIGENCE_PUBLIC_MODES],
  [parseWorkModeOption, ['agent', 'coding', 'script']],
  [parseOutputModeOption, ['json']],
  [parsePermissionModeOption, ACP_PERMISSION_MODES],
]);

/** One reachable command: its words after `kodax`, and what can follow it. */
interface CompletionNode {
  readonly path: string;
  readonly subcommands: readonly { readonly name: string; readonly description: string }[];
  readonly options: readonly Option[];
  readonly argumentValues: readonly string[];
}

function optionValues(option: Option): readonly string[] | undefined {
  if (option.argChoices !== undefined) return option.argChoices;
  if (option.long === '--provider') return getAvailableProviderNames();
  return VALUES_BY_PARSER.get(option.parseArg);
}

function takesValue(option: Option): boolean {
  return option.required || option.optional;
}

function argumentValues(command: Command): readonly string[] {
  const first: Argument | undefined = command.registeredArguments[0];
  return first?.argChoices ?? [];
}

/** Walks the visible tree, loading lazy groups first so their subcommands are included. */
async function collectNodes(root: Command): Promise<CompletionNode[]> {
  const help = new Help();
  for (const command of root.commands) await loadLazyCommand(root, command);
  const nodes: CompletionNode[] = [];
  const visit = (command: Command, path: string): void => {
    const subcommands = help.visibleCommands(command);
    nodes.push({
      path,
      subcommands: subcommands.map((child) => ({ name: child.name(), description: child.description() })),
      options: help.visibleOptions(command),
      argumentValues: argumentValues(command),
    });
    for (const child of subcommands) visit(child, `${path} ${child.name()}`);
  };
  visit(root, '');
  return nodes;
}

function flagsOf(option: Option): string[] {
  return [option.short, option.long].filter((flag): flag is string => flag !== undefined);
}

function bashFunction(nodes: readonly CompletionNode[]): string {
  const paths = nodes.filter((node) => node.path !== '').map((node) => `"${node.path}"`);
  const valueCases = nodes.flatMap((node) => node.options.filter(takesValue).map((option) => {
    const keys = flagsOf(option).map((flag) => `"${node.path}:${flag}"`).join('|');
    const values = optionValues(option);
    // No known values: leave COMPREPLY empty so `-o default` completes file names.
    return values === undefined
      ? `    ${keys}) return 0 ;;`
      : `    ${keys}) words="${values.join(' ')}" ;;`;
  }));
  const wordCases = nodes.map((node) => {
    const words = [
      ...node.subcommands.map((child) => child.name),
      ...node.argumentValues,
      ...node.options.flatMap(flagsOf),
    ];
    return `      "${node.path}") words="${words.join(' ')}" ;;`;
  });
  return `_kodax_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}" path="" words="" i
  for ((i = 1; i < COMP_CWORD; i++)); do
    case "$path \${COMP_WORDS[i]}" in
      ${paths.join('|')}) path="$path \${COMP_WORDS[i]}" ;;
    esac
  done
  case "$path:$prev" in
${valueCases.join('\n')}
  esac
  if [[ -z "$words" ]]; then
    case "$path" in
${wordCases.join('\n')}
    esac
  fi
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}
complete -o default -F _kodax_complete kodax`;
}

function fishQuote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function fishScript(nodes: readonly CompletionNode[]): string {
  const paths = nodes.filter((node) => node.path !== '').map((node) => fishQuote(node.path));
  const lines = nodes.flatMap((node) => {
    // Command paths are plain words, so double quotes around one need no escaping.
    const at = `-n ${fishQuote(`__kodax_at "${node.path}"`)}`;
    const subcommands = node.subcommands.map((child) =>
      `complete -c kodax ${at} -f -a ${fishQuote(child.name)} -d ${fishQuote(child.description)}`);
    const values = node.argumentValues.length > 0
      ? [`complete -c kodax ${at} -f -a ${fishQuote(node.argumentValues.join(' '))}`]
      : [];
    const options = node.options.map((option) => {
      const flags = [
        option.short !== undefined ? `-s ${option.short.slice(1)}` : '',
        option.long !== undefined ? `-l ${option.long.slice(2)}` : '',
      ].filter(Boolean).join(' ');
      const known = optionValues(option);
      const value = !takesValue(option) ? '' : known !== undefined ? ` -x -a ${fishQuote(known.join(' '))}` : ' -r';
      return `complete -c kodax ${at} ${flags} -d ${fishQuote(option.description)}${value}`;
    });
    return [...subcommands, ...values, ...options];
  });
  return `function __kodax_at
    set -l path ''
    for word in (commandline -opc)[2..-1]
        switch "$path $word"
            case ${paths.join(' ')}
                set path "$path $word"
        end
    end
    test "$path" = "$argv[1]"
end
${lines.join('\n')}`;
}

/** The completion script for one shell, generated from the command tree. */
export async function renderCompletionScript(root: Command, shell: 'bash' | 'zsh' | 'fish'): Promise<string> {
  const nodes = await collectNodes(root);
  if (shell === 'bash') {
    return `# KodaX bash completion. Add to ~/.bashrc:\n#   eval "$(kodax completion bash)"\n${bashFunction(nodes)}`;
  }
  if (shell === 'zsh') {
    return `# KodaX zsh completion. Add to ~/.zshrc:
#   eval "$(kodax completion zsh)"
if ! (( $+functions[compdef] )); then autoload -U +X compinit && compinit; fi
autoload -U +X bashcompinit && bashcompinit
${bashFunction(nodes)}`;
  }
  return `# KodaX fish completion. Save it:\n#   kodax completion fish > ~/.config/fish/completions/kodax.fish\n${fishScript(nodes)}`;
}

export function configureKodaXCompletionCommand(program: Command): void {
  program
    .command('completion')
    .description('Generate shell completion script')
    .addArgument(new Argument('<shell>', 'Shell type').choices(['bash', 'zsh', 'fish']))
    .action(async (shell: 'bash' | 'zsh' | 'fish') => {
      process.stdout.write(`${await renderCompletionScript(program, shell)}\n`);
    });
}
