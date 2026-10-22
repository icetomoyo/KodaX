import path from 'node:path';
import type { ToolGuardrail } from '@kodax-ai/agent';
import { resolveToolBridgeTarget } from '../packages/coding/src/tools/tool-bridge.js';
import { isNullDevice, parseBashCommand } from '../packages/coding/src/permissions/bash-ast.js';

const mutable = new Set(['write', 'edit', 'multi_edit', 'insert_after_anchor']);
const inspect = new Set(['rg', 'ls', 'pwd', 'cat', 'dir', 'type', 'get-content', 'get-childitem', 'get-location', 'findstr', 'select-string', 'select-object']);
const readGit = new Set(['diff', 'status', 'ls-files', 'grep', 'show', 'log', 'rev-parse']);

/** Deny actual reads before execution; leave the original call intact for recovery. */
export function createComplexReadBoundary(workspace: string): ToolGuardrail {
  return {
    kind: 'tool', name: 'complex-fixture-read-boundary',
    beforeTool: async call => {
      const bridge = resolveToolBridgeTarget(call);
      const target = bridge?.ok ? bridge.call : call;
      const reason = target.name === 'read' ? checkComplexTool(workspace, target.name, target.input, false) : null;
      return reason === null ? { action: 'allow' } : { action: 'block', reason };
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
  if (tool === 'run_workflow') return 'Independent Workflow executor is outside this bounded evaluation.';
  if (tool === 'spawn_agent' && (readOnly || input.read_only === false || input.provider !== undefined || input.model !== undefined || input.agent_id !== undefined)) return 'Only one read-only inherited-model child is in scope.';
  if (['read', 'glob', 'grep', 'code_search', ...mutable].includes(tool) && input.path !== undefined && !inside(input.path)) return 'Path leaves the fixture workspace.';
  if (mutable.has(tool)) {
    if (readOnly || !inside(input.path)) return 'Mutation is outside the root fixture scope.';
    if (!/^(?:(?:src|packages)\/.+\.(?:js|mjs)|tests\/(?!basic\.test\.js$).+\.(?:js|mjs)|\.agent\/tmp\/.+)$/.test(relative(input.path))) return 'Only implementations, new tests and fixture scratch may change.';
  }
  if (tool !== 'bash') return null;
  if (typeof input.command !== 'string' || !input.command.trim()) return 'Missing shell command.';
  if (input.cwd !== undefined && (!inside(input.cwd) || relative(input.cwd) !== '')) return 'Shell cwd must be the fixture root.';
  const tree = parseBashCommand(shellForAnalysis(input.command));
  if (tree.unparseable || !tree.statements.length) return 'Unsupported shell syntax in evaluation.';
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
      if (!inside(target) || relative(target) !== '') return 'Directory change must target the fixture root.';
    } else if (executable === 'git') {
      if (!readGit.has(args[1] ?? '') && (readOnly || args[1] !== 'stash')) return 'Git operation is outside the fixture scope.';
    } else if (executable === 'node' || executable === 'npm') {
      // Product read-only permissions still apply; the evaluator must not preempt them.
      if (executable === 'node' ? args[1] !== '--test' : args[1] !== 'test') return 'Only local test execution is in scope.';
    } else if (executable === 'mkdir') {
      if (readOnly || !args.slice(1).filter(arg => arg !== '-p').every(scratch)) return 'Directory creation must stay in fixture scratch.';
    } else if (executable === 'if') {
      if (readOnly || args.length !== 6 || args[1]?.toLowerCase() !== 'not' || args[2]?.toLowerCase() !== 'exist' || args[4]?.toLowerCase() !== 'mkdir' || !scratch(args[3]!) || !scratch(args[5]!)) return 'Only conditional fixture scratch creation is in scope.';
    } else if (executable === 'echo') {
      if (args.length !== 2 || !/^-+$/.test(args[1]!)) return 'Only literal review separators are in scope.';
    } else if (!inspect.has(executable)) return 'Executable is outside the fixture test and inspection scope.';
  }
  return null;
}
