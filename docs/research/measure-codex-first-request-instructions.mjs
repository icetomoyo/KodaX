// Offline source reconstruction, not a Codex builder capture or provider tokenizer.
// Run with Node >=22: node --experimental-strip-types docs/research/measure-codex-first-request-instructions.mjs [codex-root]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { countTokens } from '../../packages/agent/src/tokenizer.ts';

const repo = process.argv[2] ?? 'C:/Works/PubProj/codex';
const here = dirname(fileURLToPath(import.meta.url));
const source = (name) => readFileSync(resolve(repo, name), 'utf8');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const metrics = (text) => ({ utf16Units: text.length, unicodeCodepoints: [...text].length,
  utf8Bytes: Buffer.byteLength(text), kodaxCountTokens: countTokens(text), sha256: hash(text) });

// Port of prompts/src/update_plan_instructions.rs; retains exact nonremoved bytes.
function omitUpdatePlan(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let rendered = '';
  for (let index = 0; index < lines.length;) {
    const line = lines[index].trimEnd();
    if (['## Planning', '## `update_plan`', '## Plan tool', '## Plan Mode vs update_plan tool'].includes(line)) {
      let end = index + 1;
      while (end < lines.length && !/^#{1,2} /.test(lines[end])) end++;
      if (line !== '## Planning' || lines.slice(index, end).some((value) =>
        value.startsWith('You have access to an `update_plan` tool') || value.startsWith('When `update_plan` is available, follow this section'))) {
        index = end; continue;
      }
    }
    if (line === 'Progress visibility:' && lines[index + 1]?.startsWith('If update_plan is available')) {
      index += 2;
      if (lines[index]?.trim() === '') index++;
      continue;
    }
    if (line.startsWith('- Use the plan tool ') || line.startsWith('- If you create a checklist or task list,')) {
      index++;
      while (index < lines.length && /^[ \t]/.test(lines[index])) index++;
      continue;
    }
    rendered += lines[index++];
  }
  return rendered;
}

const catalogPath = 'codex-rs/models-manager/models.json';
const catalogText = source(catalogPath);
const catalog = JSON.parse(catalogText);
const multiSource = source('codex-rs/prompts/src/multi_agent_instructions.rs').replaceAll('\r\n', '\n');
const modeSource = source('codex-rs/prompts/src/model_messages/multi_agent.rs').replaceAll('\r\n', '\n');
function rustLiteral(name, code) {
  const literal = code.match(new RegExp(`const ${name}: &str =\\s*("(?:[^"\\\\]|\\\\.)*");`))?.[1];
  if (!literal) throw new Error(`Cannot extract Rust literal ${name}`);
  return JSON.parse(literal);
}
const shared = multiSource.match(/DEFAULT_MULTI_AGENT_V2_SHARED_USAGE_HINT_TEXT: &str = r#"([\s\S]*?)"#;/)?.[1];
if (!shared) throw new Error('Cannot extract shared guidance');
const wait = rustLiteral('DEFAULT_MULTI_AGENT_V2_WAIT_AGENT_USAGE_HINT_TEXT', multiSource);
const overrides = rustLiteral('DEFAULT_MULTI_AGENT_V2_MODEL_OVERRIDE_USAGE_HINT_TEXT', multiSource);
const explicit = rustLiteral('EXPLICIT_REQUEST_ONLY_MULTI_AGENT_MODE_TEXT', modeSource);
const sandbox = source('codex-rs/prompts/templates/permissions/sandbox_mode/danger_full_access.md').trimEnd().replace('{{ network_access }}', 'enabled');
const approval = source('codex-rs/prompts/templates/permissions/approval_policy/never.md');
let permissionBody = '\n' + sandbox + '\n' + approval;
if (!permissionBody.endsWith('\n')) permissionBody += '\n';
const permissions = '<permissions instructions>' + permissionBody + '</permissions instructions>';
const cwd = 'C:\\workspace';
const environment = '<environment_context>\n' +
  `  <cwd>${cwd}</cwd>\n  <shell>powershell</shell>\n  <current_date>2026-10-14</current_date>\n  <timezone>Asia/Shanghai</timezone>\n` +
  `  <filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n` +
  '</environment_context>';
const report = {
  kind: 'offline-source-text-reconstruction-not-builder-or-api-usage',
  codexCommit: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  catalogSha256: hash(catalogText),
  estimator: 'direct import of packages/agent/src/tokenizer.ts countTokens; text only; no per-message or provider protocol overhead',
  scenario: { modelSource: 'bundled catalog', source: 'CLI root', reasoning: 'catalog default low',
    collaborationMode: 'Default', updatePlanEnabled: false, sandbox: 'danger-full-access', approvals: 'never',
    cwd, shell: 'powershell', date: '2026-10-14', timezone: 'Asia/Shanghai',
    multiAgentV2: { maxConcurrency: 4, waitAgentEnabled: true, exposeModelOverrides: true },
    empty: ['history', 'skills', 'MCP', 'AGENTS', 'user/developer custom instructions', 'plugins/apps', 'subagents'],
    omitted: ['ALL tool channel definitions and generated tool guidance', 'user task', 'optional feature contexts', 'wire protocol overhead'] },
  models: {},
};
for (const slug of ['gpt-6.1-sol', 'gpt-6-astra']) {
  const model = catalog.models.find((value) => value.slug === slug);
  if (!model) throw new Error(`Missing ${slug}`);
  const messages = model.model_messages;
  if (messages.permissions || messages.approvals?.never || messages.multi_agent?.mode) throw new Error('Scenario fallback assumptions changed');
  const base = omitUpdatePlan(messages.instructions_template);
  const collaboration = '<collaboration_mode>' + omitUpdatePlan(messages.collaboration_modes.default) + '</collaboration_mode>';
  const role = '<multi_agent_role>' + omitUpdatePlan(messages.multi_agent.role.root) + '\n' + shared + '\n' +
    wait + '\n\nThere are 4 available concurrency slots, meaning that up to 4 agents can be active at once, including you.\n\n' + overrides + '</multi_agent_role>';
  const mode = '<multi_agent_mode>' + explicit + '</multi_agent_mode>';
  const components = { base, collaboration, permissions, environment, multiAgentRootRole: role, multiAgentMode: mode };
  report.models[slug] = {
    modelSettings: { toolMode: model.tool_mode, multiAgentVersion: model.multi_agent_version, useResponsesLite: model.use_responses_lite,
      defaultReasoning: model.default_reasoning_level, contextWindow: model.context_window },
    catalogBaseBeforeUpdatePlanFilter: metrics(messages.instructions_template),
    components: Object.fromEntries(Object.entries(components).map(([name, text]) => [name, metrics(text)])),
    subtotalTextOnly: Object.values(components).reduce((sum, text) => sum + countTokens(text), 0),
  };
}
const output = resolve(here, 'codex-first-request-instructions-2026-10-14.json');
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
