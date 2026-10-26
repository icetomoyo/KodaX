import path from 'node:path';
import type { ToolGuardrail } from '@kodax-ai/agent';
import { resolveToolBridgeTarget } from '../packages/coding/src/tools/tool-bridge.js';
import { isNullDevice, parseBashCommand } from '../packages/coding/src/permissions/bash-ast.js';

const mutable = new Set(['write', 'edit', 'multi_edit', 'insert_after_anchor']);
const inspect = new Set(['rg', 'ls', 'pwd', 'cat', 'dir', 'type', 'get-content', 'get-childitem', 'get-location', 'findstr', 'select-string', 'select-object']);
const readGit = new Set(['diff', 'status', 'ls-files', 'grep', 'show', 'log', 'rev-parse']);
export const COMPLEX_DIRECTORY_DENIAL = 'Directory change must target the fixture root.';
const COMPLEX_TEST_COMMAND_DENIAL = 'Only local test execution is in scope.';
const COMPLEX_OUTPUT_FILTER_DENIAL = 'tail output filtering is outside this fixture scope. Run the local tests without this pipeline.';
// Explain this evaluator's known shell policy at its source. Do not classify
// arbitrary host errors or change which commands are admitted.
const SHELL_SCOPE_RECOVERY = ' No part of this command ran. Shell deletion and moving files are unavailable in this fixture; do not retry them with aliases, another shell or Git. Continue permitted tests/inspection and report any cleanup left undone. This does not prohibit correcting an invalid path, syntax or test within the permitted scope.';
const repoInspection = new Set(['module_context', 'symbol_context', 'process_context', 'impact_estimate',
  'relationship_scan', 'repo_overview', 'semantic_lookup', 'cyclic_dependencies', 'changed_scope', 'changed_diff', 'change_bundle']);
const isRepoInspection = (tool: string): boolean => repoInspection.has(tool) || tool.startsWith('lsp_');

/** A shell scope refusal is a blocked tool result, never permission to execute.
 * Budget/cancellation still terminate in the Runtime wrapper, outside this classifier.
 */
export function isRecoverableComplexDenial(tool: string, reason: string | null): boolean {
  return reason !== null && (tool === 'read' || tool === 'bash'
    || (isRepoInspection(tool) && reason === 'Path leaves the fixture workspace.'));
}

/** Return recoverable read/navigation and test-command denials with the original call intact. */
export function createComplexReadBoundary(workspace: string): ToolGuardrail {
  return {
    kind: 'tool', name: 'complex-fixture-read-boundary',
    beforeTool: async call => {
      const bridge = resolveToolBridgeTarget(call);
      const target = bridge?.ok ? bridge.call : call;
      const reason = target.name === 'read' || target.name === 'bash' || isRepoInspection(target.name)
        ? checkComplexTool(workspace, target.name, target.input, false) : null;
      return reason !== null && isRecoverableComplexDenial(target.name, reason)
        ? { action: 'block', reason } : { action: 'allow' };
    },
  };
}

// This is an evaluation scope check, not a general shell security sandbox.
// The original command is executed unchanged, including syntax errors the model must repair.
function shellForAnalysis(command: string): string {
  let quote: string | undefined;
  return [...command.replaceAll('\\', '/')].map((char, index, chars) => {
    if (char === '"' || char === "'") {
      if (quote === char) quote = undefined;
      else if (quote === undefined) quote = char;
    }
    return char === '&' && quote === undefined && chars[index - 1] !== '>' && chars[index - 1] !== '&' && chars[index + 1] !== '&' ? ';' : char;
  }).join('');
}

export function checkComplexTool(workspace: string, tool: string, input: Readonly<Record<string, unknown>>, readOnly: boolean): string | null {
  const paths = /^[A-Za-z]:[/\\]|^\\\\/.test(workspace) ? path.win32 : path;
  const relative = (value: string): string => paths.relative(workspace, paths.resolve(workspace, value)).replaceAll('\\', '/');
  const inside = (value: unknown): value is string => typeof value === 'string' && !/^\.\.(?:\/|$)/.test(relative(value)) && !paths.isAbsolute(relative(value));
  const scratch = (value: string): boolean => inside(value) && /^\.agent\/tmp(?:\/|$)/.test(relative(value));
  if (['web_search', 'web_fetch', 'session_history_search', 'session_history_read', 'memory_recall', 'kodax_manual'].includes(tool)) return 'External retrieval and session data are outside this bounded fixture.';
  if (tool === 'run_workflow') return 'Independent Workflow executor is outside this bounded evaluation.';
  if (tool === 'spawn_agent' && (readOnly || input.read_only === false || input.provider !== undefined || input.model !== undefined || input.agent_id !== undefined)) return 'Only one read-only inherited-model child is in scope.';
  if (['read', 'glob', 'grep', 'code_search', ...mutable].includes(tool) && input.path !== undefined && !inside(input.path)) return 'Path leaves the fixture workspace.';
  if (isRepoInspection(tool) && ['path', 'target_path'].some(field => input[field] !== undefined && !inside(input[field]))) return 'Path leaves the fixture workspace.';
  if (tool === 'changed_diff' || tool === 'change_bundle') {
    const targets = Array.isArray(input.paths) ? input.paths : typeof input.paths === 'string' ? input.paths.split(/[,\r\n]/).filter(value => value.trim()) : [];
    if (targets.some(value => !inside(typeof value === 'string' ? value.trim() : value))) return 'Path leaves the fixture workspace.';
  }
  if (mutable.has(tool)) {
    if (readOnly || !inside(input.path)) return 'Mutation is outside the root fixture scope.';
    if (!/^(?:(?:src|packages)\/.+\.(?:js|mjs)|tests\/(?!basic\.test\.js$).+\.(?:js|mjs)|\.agent\/tmp\/.+)$/.test(relative(input.path))) return 'Only implementations, new tests and fixture scratch may change.';
  }
  if (tool !== 'bash') return null;
  if (typeof input.command !== 'string' || !input.command.trim()) return 'Missing shell command.';
  if (input.cwd !== undefined && (!inside(input.cwd) || relative(input.cwd) !== '')) return 'Shell cwd must be the fixture root.';
  const tree = parseBashCommand(shellForAnalysis(input.command));
  if (tree.unparseable || !tree.statements.length) return 'Unsupported shell syntax in evaluation.';
  let deniedTestCommand = false;
  let deniedOutputFilter = false;
  let deniedDirectoryChange = false;
  for (const statement of tree.statements) for (const stage of statement.stages) {
    const args = stage.argv;
    const executable = args[0]?.toLowerCase();
    if (!executable) return 'Missing executable.';
    if (args.some(arg => (/^[A-Za-z]:[/\\]|^\\\\|^\/(?![A-Za-z](?::|$))|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(arg) && !inside(arg)))) return 'Shell argument leaves the fixture workspace.';
    for (const redirect of stage.redirections) {
      if (redirect.descriptorDuplication || isNullDevice(redirect.target)) continue;
      if (redirect.input ? !inside(redirect.target) : readOnly || !scratch(redirect.target)) return 'Redirection leaves the permitted fixture scope.';
    }
    if (executable === 'cd' || executable === 'set-location') {
      const target = args[1]?.toLowerCase() === '/d' ? args[2] : args[1];
      if ((!inside(target) || relative(target) !== '') && !deniedTestCommand) deniedDirectoryChange = true;
    } else if (executable === 'git') {
      if (!readGit.has(args[1] ?? '') && (readOnly || args[1] !== 'stash')) return 'Git operation is outside the fixture scope.' + SHELL_SCOPE_RECOVERY;
    } else if (executable === 'node' || executable === 'npm') {
      // Product read-only permissions still apply; the evaluator must not preempt them.
      // A recoverable refusal must not hide a later escape or unknown executable.
      if (executable === 'node' ? args[1] !== '--test' : args[1] !== 'test') deniedTestCommand = true;
    } else if (executable === 'tail' && args.length === 3 && args[1] === '-n' && /^\d{1,4}$/.test(args[2]!)) {
      // Still block the whole command; never execute or rewrite the pipeline.
      // Inspect remaining stages so this recoverable error cannot mask an escape.
      deniedOutputFilter = true;
    } else if (executable === 'mkdir') {
      if (readOnly || !args.slice(1).filter(arg => arg !== '-p').every(scratch)) return 'Directory creation must stay in fixture scratch.';
    } else if (executable === 'if') {
      if (readOnly || args.length !== 6 || args[1]?.toLowerCase() !== 'not' || args[2]?.toLowerCase() !== 'exist' || args[4]?.toLowerCase() !== 'mkdir' || !scratch(args[3]!) || !scratch(args[5]!)) return 'Only conditional fixture scratch creation is in scope.';
    } else if (executable === 'echo') {
      if (args.length !== 2 || !/^-+$/.test(args[1]!)) return 'Only literal review separators are in scope.';
    } else if (!inspect.has(executable)) return 'Executable is outside the fixture test and inspection scope.' + SHELL_SCOPE_RECOVERY;
  }
  return deniedDirectoryChange ? COMPLEX_DIRECTORY_DENIAL : deniedTestCommand ? COMPLEX_TEST_COMMAND_DENIAL
    : deniedOutputFilter ? COMPLEX_OUTPUT_FILTER_DENIAL : null;
}
