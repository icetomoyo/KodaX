// Offline source reconstruction, NOT Codex's Rust builder or a captured payload.
// Reconstructs a bounded subset of builtin schemas; strings extracted from pinned sources.
// Run: node docs/research/codex-tool-components-2026-10-14.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = 'C:/Works/PubProj/codex';
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (commit !== 'c22a06c18070c3e33bd2648c7210a00a2a9f6f80') throw new Error('Reference commit changed');
const read = p => fs.readFileSync(path.join(root, 'codex-rs', p), 'utf8').replaceAll('\r\n', '\n');
const strings = p => [...read(p).matchAll(/r#"([\s\S]*?)"#|"((?:\\.|[^"\\])*)"/g)].map(m => m[1] ?? JSON.parse('"' + m[2].replaceAll('\n', '\\n').replaceAll('\t', '\\t') + '"'));
const literal = (p, prefix) => { const s = strings(p).find(x => x.startsWith(prefix)); if (s === undefined) throw new Error(prefix); return s; };
const handler = p => `core/src/tools/handlers/${p}.rs`;
const shell = handler('shell_spec'), mcp = handler('mcp_resource_spec'), view = handler('view_image_spec');
const desc = (p, prefix) => literal(p, prefix);
const scalar = (type, description) => ({ type, ...(description ? { description } : {}) });
const str = (p, prefix) => scalar('string', desc(p, prefix));
const obj = (properties, required) => ({ type: 'object', properties: Object.fromEntries(Object.entries(properties).sort(([a], [b]) => a.localeCompare(b))), ...(required ? { required } : {}), additionalProperties: false });
const arr = (items, description) => ({ type: 'array', items, ...(description ? { description } : {}) });
const en = (values, description) => ({ type: 'string', enum: values, description });
const tools = [];
const add = (name, description, parameters, output, classification) => tools.push({ name, description, parameters, output, classification });
// Baseline: one local environment, login allowed, no extra permissions, Linux shell guidance.
const execProps = {
  cmd: str(shell, 'Shell command to execute.'), workdir: str(shell, 'Working directory for the command.'),
  tty: scalar('boolean', desc(shell, 'True allocates a PTY')), yield_time_ms: scalar('number', desc(shell, 'Wait before yielding output. Defaults')),
  max_output_tokens: scalar('number', desc(shell, 'Output token budget.')), shell: str(shell, 'Shell binary to launch.'),
  login: scalar('boolean', desc(shell, 'True runs the shell')),
  sandbox_permissions: en(['use_default', 'require_escalated'], desc(shell, 'Per-command sandbox override. Defaults to `use_default`; use `require_escalated`')),
  justification: str(shell, 'User-facing approval question'), prefix_rule: arr(scalar('string'), desc(shell, 'Reusable approval prefix')),
};
const outputBody = read(shell).match(/fn unified_exec_output_schema\(\) -> Value \{\s*json!\(([\s\S]*?)\)\s*\}/)[1];
const commandOutput = JSON.parse(outputBody);
add('exec_command', strings(shell).find(s => s === 'Runs a command in a PTY, returning output or a session ID for ongoing interaction.'), obj(execProps, ['cmd']), commandOutput, 'nested-default');
add('write_stdin', desc(shell, 'Writes characters to an existing'), obj({ session_id: scalar('number', desc(shell, 'Identifier of the running')), chars: str(shell, 'Bytes to write to stdin.'), yield_time_ms: scalar('number', desc(shell, 'Wait before yielding output. Non-empty')), max_output_tokens: execProps.max_output_tokens }, ['session_id']), commandOutput, 'nested-default');
for (const [name, prefix, cursorPrefix, serverPrefix] of [
  ['list_mcp_resources', 'Lists resources provided', 'Opaque cursor from a previous list_mcp_resources', 'MCP server name. Omit to list resources'],
  ['list_mcp_resource_templates', 'Lists resource templates provided', 'Opaque cursor from a previous list_mcp_resource_templates', 'MCP server name. Omit to list resource templates'],
]) add(name, desc(mcp, prefix), obj({ cursor: str(mcp, cursorPrefix), server: str(mcp, serverPrefix) }), undefined, 'nested-default');
add('read_mcp_resource', desc(mcp, 'Read a specific resource'), obj({ server: str(mcp, 'MCP server name exactly'), uri: str(mcp, 'Resource URI to read.') }, ['server', 'uri']), undefined, 'nested-default');
add('apply_patch', desc(handler('apply_patch_spec'), 'The `apply_patch` tool can be used'), undefined, undefined, 'nested-default-freeform');
add('view_image', desc(view, 'View a local image file'), obj({ path: str(view, 'Local filesystem path'), detail: en(['high', 'original'], desc(view, 'Image detail level.')) }, ['path']), obj({ image_url: str(view, 'Data URL for the loaded'), detail: en(['high', 'original'], desc(view, 'Image detail hint returned')) }, ['image_url', 'detail']), 'nested-default');
const clock = handler('current_time');
add('clock__curr_time', desc(clock, 'Return the current time'), obj({}), obj({ current_time: str(clock, 'Current UTC time formatted') }, ['current_time']), 'nested-default');
const plan = handler('plan_spec');
add('update_plan', desc(plan, 'Updates the task plan.'), obj({ explanation: str(plan, 'Optional explanation for'), plan: arr(obj({ step: str(plan, 'Task step text.'), status: en(['pending', 'in_progress', 'completed'], desc(plan, 'Step status.')) }, ['step', 'status']), desc(plan, 'The list of steps')) }, ['plan']), undefined, 'optional-off');
const ask = handler('request_user_input_spec');
add('request_user_input', desc(ask, 'Request user input for one').replace('{allowed_modes}', 'Plan mode'), obj({ questions: arr(obj({ id: str(ask, 'Stable identifier'), header: str(ask, 'Short header label'), question: str(ask, 'Single-sentence prompt'), options: arr(obj({ label: str(ask, 'User-facing label'), description: str(ask, 'One short sentence') }, ['label', 'description']), desc(ask, 'Provide 2-3 mutually')) }, ['id', 'header', 'question', 'options']), desc(ask, 'Questions to show')) }, ['questions']), undefined, 'direct-default');
const asyncAsk = handler('request_user_input_async');
const asyncOptions = arr(scalar('string'), desc(asyncAsk, 'Suggested answers,')); asyncOptions.minItems = 1;
const asyncQuestions = arr(obj({ title: str(asyncAsk, 'The complete question'), options: asyncOptions }, ['title']), desc(asyncAsk, 'One or more self-contained')); asyncQuestions.minItems = 1;
add('request_user_input_async', desc('prompts/src/model_messages.rs', 'Ask the user one or more questions during'), obj({ questions: asyncQuestions }, ['questions']), undefined, 'direct-root-default');
// Supported schema subset reproduces renderer branches used above; no $ref/union/budget cases.
function ts(s) {
  if (!s) return 'unknown';
  if (s.enum) return s.enum.map(x => JSON.stringify(x)).join(' | ');
  if (s.type === 'array') return `Array<${ts(s.items)}>`;
  if (s.type !== 'object') return s.type === 'integer' ? 'number' : s.type;
  const props = Object.entries(s.properties ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const multiline = props.some(([, v]) => Boolean(v.description));
  const lines = props.flatMap(([k, v]) => [
    ...(multiline && v.description ? v.description.split('\n').map(x => x.trim()).filter(Boolean).map(x => `  // ${x}`) : []),
    `${multiline ? '  ' : ''}${k}${s.required?.includes(k) ? '' : '?'}: ${ts(v)};`,
  ]);
  return multiline ? ['{', ...lines, '}'].join('\n') : lines.length ? `{ ${lines.join(' ')} }` : '{}';
}
const metric = s => ({ chars: s.length, bytes: Buffer.byteLength(s), estimatedTokens: Math.ceil(s.length / 4) });
const declarations = tools.map(t => ({ ...t, declaration: `### \`${t.name}\`\n${t.description}\n\nexec tool declaration:\n\`\`\`ts\ndeclare const tools: { ${t.name}(${t.parameters ? 'args: ' + ts(t.parameters) : 'input: string'}): Promise<${ts(t.output)}>; };\n\`\`\`` }));
const codeModeFile = 'code-mode-protocol/src/description.rs';
const base = desc(codeModeFile, 'Run JavaScript code to orchestrate').replace('{{ default_exec_yield_time_ms }}', '30000').replace('{{ image_helper }}', desc(codeModeFile, '`image(imageUrlOrItem: string | { image_url: string;'));
const guidance = desc(codeModeFile, 'Some deferred nested tools');
const preamble = 'Shared MCP Types:\n```ts\n' + desc(codeModeFile, 'type Role =') + '\n```';
const codeModeCore = [base, guidance, preamble, declarations.filter(t => t.classification.startsWith('nested-default')).map(t => t.declaration).join('\n\n')].join('\n\n');
const result = {
  commit,
  methodology: 'Offline source reconstruction, NOT executed Rust builder or captured provider payload. Exactly extracted source text with manually transcribed bounded schemas. LF normalized. Normalized JSON has only name,description,parameters (freeform lacks parameters); excludes native wrappers/grammar/output schema. CodeMode subset includes output schemas, boilerplate and headings; excludes namespace header for clock, native wait/request/collaboration schemas, web, deferred search/catalog and external/app tools. Linux/single-env/login allowed/legacy image-detail baseline. ASCII chars/4 heuristic only, not tokenizer/API usage.',
  modelMetadata: JSON.parse(read('models-manager/models.json')).models.filter(m => ['gpt-6-astra', 'gpt-6.1-sol'].includes(m.slug)).map(m => ({ slug: m.slug, tool_mode: m.tool_mode, multi_agent_version: m.multi_agent_version, supports_search_tool: m.supports_search_tool, use_responses_lite: m.use_responses_lite, experimental_supported_tools: m.experimental_supported_tools, toolMessagesOverride: m.model_messages.tools })),
  codeModeFixed: { execDescription: metric(base), deferredGuidance: metric(guidance), sharedMcpPreamble: metric(preamble), waitDescription: metric(desc(codeModeFile, '- Use `wait` only after')) },
  directApplyPatchGrammar: metric(read('core/assets/tools/apply_patch.lark')),
  eightNestedPlusBoilerplateLowerBound: metric(codeModeCore),
  tools: declarations.map(t => ({ name: t.name, classification: t.classification, description: metric(t.description), parametersJson: t.parameters ? metric(JSON.stringify(t.parameters)) : null, normalizedJson: metric(JSON.stringify({ name: t.name, description: t.description, ...(t.parameters ? { parameters: t.parameters } : {}) })), codeModeDeclaration: metric(t.declaration) })),
};
const out = new URL('./codex-tool-components-2026-10-14.json', import.meta.url);
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
fs.writeFileSync(new URL('./codex-tool-components-2026-10-14-reconstruction.txt', import.meta.url), JSON.stringify({ tools, codeModeCore }, null, 2) + '\n');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
