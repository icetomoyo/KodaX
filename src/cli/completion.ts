import { Command } from 'commander';
import { getAvailableProviderNames } from '@kodax-ai/coding';
import { KODAX_COMPLETION_ROOT_SUBCOMMANDS, KODAX_EXEC_POLICY_SUBCOMMANDS } from './root.js';

export function configureKodaXCompletionCommand(program: Command): void {
  // ============== completion subcommand ==============
  program
    .command('completion')
    .description('Generate shell completion script')
    .argument('<shell>', 'Shell type: bash, zsh, or fish')
    .action((shell: string) => {
      const providerNames = getAvailableProviderNames().join(' ');
      const reasoningModes = 'off auto quick balanced deep';
      const effortModes = 'off auto low medium high xhigh max';
      const repoModes = 'auto full light off';
      const rootSubcommands = KODAX_COMPLETION_ROOT_SUBCOMMANDS.join(' ');
      const allOptions = [
        '-p',
        '-c',
        '-r',
        '-n',
        '-m',
        '-t',
        '-s',
        '-y',
        '-h',
        '--help',
        '--print',
        '--mode',
        '--continue',
        '--resume',
        '--new',
        '--provider',
        '--model',
        '--thinking',
        '--effort',
        '--reasoning',
        '--repo-intelligence',
        '--repo-intelligence-trace',
        '--auto',
        '--session',
        '--extension',
        '--no-session',
        '--max-iter',
        '--version',
        '--json',
        '--ping',
        '--cwd',
        '--permission-mode',
        '--dest',
        '--description',
        '--force',
        '--no-evals',
        '--skill-path',
        '--evals',
        '--workspace',
        '--config-a',
        '--config-b',
        '--output',
        '--apply',
        '--all',
        '--custom',
        '--pretty',
        '--trust-project-policy',
      ].join(' ');
      const skillSubcommands =
        'init validate eval grade analyze compare package install';
      const toolsSubcommands = 'list inspect revoke';
      const sessionsSubcommands = 'dedupe';
      const constructedSubcommands =
        'reset-self-modify-budget audit disable-self-modify rollback';
      const execPolicySubcommands = KODAX_EXEC_POLICY_SUBCOMMANDS.join(' ');

      if (shell === 'bash') {
        console.log(`# KodaX bash completion — add to ~/.bashrc:
#   eval "$(kodax completion bash)"
_kodax_complete() {
  local cur prev opts subcmds
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  subcmds="${rootSubcommands}"
  opts="${allOptions}"

  case "\${prev}" in
    --provider|-m) COMPREPLY=( $(compgen -W "${providerNames}" -- "\${cur}") ); return 0 ;;
    --mode) COMPREPLY=( $(compgen -W "json" -- "\${cur}") ); return 0 ;;
    --effort) COMPREPLY=( $(compgen -W "${effortModes}" -- "\${cur}") ); return 0 ;;
    --reasoning) COMPREPLY=( $(compgen -W "${reasoningModes}" -- "\${cur}") ); return 0 ;;
    --repo-intelligence) COMPREPLY=( $(compgen -W "${repoModes}" -- "\${cur}") ); return 0 ;;
    --session|-s) COMPREPLY=( $(compgen -W "list resume delete delete-all" -- "\${cur}") ); return 0 ;;
    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") ); return 0 ;;
    acp) COMPREPLY=( $(compgen -W "serve" -- "\${cur}") ); return 0 ;;
    host) COMPREPLY=( $(compgen -W "start stop restart status logs serve pair devices" -- "\${cur}") ); return 0 ;;
    skill) COMPREPLY=( $(compgen -W "${skillSubcommands}" -- "\${cur}") ); return 0 ;;
    tools) COMPREPLY=( $(compgen -W "${toolsSubcommands}" -- "\${cur}") ); return 0 ;;
    sessions) COMPREPLY=( $(compgen -W "${sessionsSubcommands}" -- "\${cur}") ); return 0 ;;
    constructed) COMPREPLY=( $(compgen -W "${constructedSubcommands}" -- "\${cur}") ); return 0 ;;
    config) COMPREPLY=( $(compgen -W "template paths" -- "\${cur}") ); return 0 ;;
    integrations) COMPREPLY=( $(compgen -W "status validate reload migrate" -- "\${cur}") ); return 0 ;;
    mcp) COMPREPLY=( $(compgen -W "list add remove" -- "\${cur}") ); return 0 ;;
    extensions) COMPREPLY=( $(compgen -W "list add remove reload" -- "\${cur}") ); return 0 ;;
    a2a) COMPREPLY=( $(compgen -W "list add remove test call expose serve" -- "\${cur}") ); return 0 ;;
    sandbox) COMPREPLY=( $(compgen -W "doctor setup" -- "\${cur}") ); return 0 ;;
    execpolicy) COMPREPLY=( $(compgen -W "${execPolicySubcommands}" -- "\${cur}") ); return 0 ;;
  esac

  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "\${opts}" -- "\${cur}") )
  elif [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${subcmds}" -- "\${cur}") )
  fi
}
complete -F _kodax_complete kodax`);
      } else if (shell === 'zsh') {
        console.log(`# KodaX zsh completion — add to ~/.zshrc:
#   eval "$(kodax completion zsh)"
_kodax() {
  local -a subcmds opts providers reasoning_modes agent_modes repo_modes
  subcmds=(${rootSubcommands})
  providers=(${providerNames.replace(/ /g, ' ')})
  reasoning_modes=(off auto quick balanced deep)
  effort_modes=(off auto low medium high xhigh max)
  repo_modes=(${repoModes})

  _arguments -C \\
    '-p[Print mode]+:text:' \\
    '--print+[Print mode]:text:' \\
    '--mode+[Output mode]:mode:(json)' \\
    '-c[Continue most recent non-empty conversation]' \\
    '--continue[Continue most recent non-empty conversation]' \\
    '-n[Start fresh session]' \\
    '--new[Start fresh session]' \\
    '-r[Resume session by ID or exact title]::id-or-title:' \\
    '--resume[Resume session by ID or exact title]::id-or-title:' \\
    '-m[LLM provider]+:provider:($providers)' \\
    '--provider+[LLM provider]:provider:($providers)' \\
    '--model+[Model override]:model:' \\
    '-t[Enable thinking]' \\
    '--thinking[Enable thinking]' \\
    '--effort+[Reasoning effort]:level:($effort_modes)' \\
    '--reasoning+[Compatibility reasoning mode]:mode:($reasoning_modes)' \\
    '--repo-intelligence+[Repo intelligence mode]:mode:($repo_modes)' \\
    '--repo-intelligence-trace[Enable repo intelligence trace]' \\
    '-s[Legacy session operation]+:operation:(list resume delete delete-all)' \\
    '--session+[Legacy session operation]:operation:(list resume delete delete-all)' \\
    '--extension+[Load local extension]:path:_files' \\
    '--no-session[Disable session persistence in print mode]' \\
    '--max-iter+[Max iterations]:n:' \\
    '--version[Show version]' \\
    '-h[Show help]::topic:' \\
    '--help[Show help]::topic:' \\
    '1:subcommand:($subcmds)' \\
    '*::arg:->args'
}
compdef _kodax kodax`);
      } else if (shell === 'fish') {
        console.log(`# KodaX fish completion — add to ~/.config/fish/completions/kodax.fish:
#   kodax completion fish > ~/.config/fish/completions/kodax.fish
complete -c kodax -n '__fish_use_subcommand' -a '${rootSubcommands}' -d 'Subcommands'
complete -c kodax -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish' -d 'Shell'
complete -c kodax -n '__fish_seen_subcommand_from acp' -a 'serve' -d 'ACP subcommand'
complete -c kodax -n '__fish_seen_subcommand_from host' -a 'start stop restart status logs serve pair devices' -d 'Host subcommand'
complete -c kodax -n '__fish_seen_subcommand_from skill' -a '${skillSubcommands}' -d 'Skill subcommand'
complete -c kodax -n '__fish_seen_subcommand_from tools' -a '${toolsSubcommands}' -d 'Tools subcommand'
complete -c kodax -n '__fish_seen_subcommand_from sessions' -a '${sessionsSubcommands}' -d 'Sessions subcommand'
complete -c kodax -n '__fish_seen_subcommand_from constructed' -a '${constructedSubcommands}' -d 'Constructed subcommand'
complete -c kodax -n '__fish_seen_subcommand_from config' -a 'template paths' -d 'Config subcommand'
complete -c kodax -n '__fish_seen_subcommand_from integrations' -a 'status validate reload migrate' -d 'Integration subcommand'
complete -c kodax -n '__fish_seen_subcommand_from mcp' -a 'list add remove' -d 'MCP subcommand'
complete -c kodax -n '__fish_seen_subcommand_from extensions' -a 'list add remove reload' -d 'Extension subcommand'
complete -c kodax -n '__fish_seen_subcommand_from a2a' -a 'list add remove test call expose serve' -d 'A2A subcommand'
complete -c kodax -n '__fish_seen_subcommand_from sandbox' -a 'doctor setup' -d 'Sandbox subcommand'
complete -c kodax -n '__fish_seen_subcommand_from execpolicy' -a '${execPolicySubcommands}' -d 'Exec Policy subcommand'
complete -c kodax -s h -l help -d 'Show help'
complete -c kodax -s p -l print -d 'Print mode' -r
complete -c kodax -l mode -d 'Output mode' -xa 'json'
complete -c kodax -s c -l continue -d 'Continue most recent conversation'
complete -c kodax -s n -l new -d 'Start fresh session'
complete -c kodax -s r -l resume -d 'Resume session by ID or exact title' -r
complete -c kodax -s m -l provider -d 'LLM provider' -xa '${providerNames}'
complete -c kodax -l model -d 'Model override' -r
complete -c kodax -s t -l thinking -d 'Enable thinking'
complete -c kodax -l effort -d 'Reasoning effort' -xa 'off auto low medium high xhigh max'
complete -c kodax -l reasoning -d 'Reasoning mode' -xa '${reasoningModes}'
complete -c kodax -l repo-intelligence -d 'Repo intelligence mode' -xa '${repoModes}'
complete -c kodax -l repo-intelligence-trace -d 'Enable repo intelligence trace'
complete -c kodax -s y -l auto -d 'Backward-compatible no-op'
complete -c kodax -s s -l session -d 'Legacy session operation' -xa 'list resume delete delete-all'
complete -c kodax -l extension -d 'Load local extension' -r
complete -c kodax -l no-session -d 'Disable session persistence in print mode'
complete -c kodax -l max-iter -d 'Max iterations' -r
complete -c kodax -l version -d 'Show version'`);
      } else {
        console.error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
        process.exit(1);
      }
    });
}
