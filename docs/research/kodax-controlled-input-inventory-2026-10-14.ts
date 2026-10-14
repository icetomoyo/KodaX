// Offline component inventory. No provider calls or coding-tool execution.
// Run from repo root: node node_modules/vite-node/vite-node.mjs --config vitest.config.ts docs/research/kodax-controlled-input-inventory-2026-10-14.ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { countTokens } from '../../packages/agent/src/tokenizer.ts';
import { setAgentConfigHome } from '../../packages/agent/src/runtime/agent-home.ts';
import { buildSystemPromptSnapshot } from '../../packages/coding/src/prompts/builder.ts';
import { buildWorkerStableInstructions } from '../../packages/coding/src/agents/worker-role-prompt.ts';
import { getActiveToolDefinitions } from '../../packages/coding/src/agent-runtime/tool-resolution.ts';
import { listToolDefinitions } from '../../packages/coding/src/tools/registry.ts';
import { buildRunnerAgentChain } from '../../packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts';
import { createRolePrompt } from '../../packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts';
import { buildFallbackRoutingDecision } from '../../packages/coding/src/reasoning.ts';
import type { KodaXToolDefinition } from '../../packages/llm/src/types.ts';

const sourceRoot = process.cwd();
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-controlled-input-'));
const fixtureHome = path.join(fixtureRoot, 'home');
const fixtureWorkspace = path.join(fixtureRoot, 'workspace');
const size = (text: string) => ({ chars: text.length, bytes: Buffer.byteLength(text), estimatedTokens: countTokens(text) });
const toolRow = (tool: KodaXToolDefinition) => ({
  name: tool.name,
  ...size(JSON.stringify({name:tool.name, description:tool.description, parameters:tool.input_schema})),
  description: size(tool.description),
  parameters: size(JSON.stringify(tool.input_schema)),
});
const toolsSummary = (tools: readonly KodaXToolDefinition[]) => {
  const rows = tools.map(toolRow);
  return {count: rows.length, estimatedTokens:rows.reduce((sum,row)=>sum+row.estimatedTokens,0),rows};
};
await fs.mkdir(fixtureHome);
await fs.mkdir(fixtureWorkspace);
setAgentConfigHome(fixtureHome);
try {
  const snapshot = await buildSystemPromptSnapshot({context:{executionCwd:fixtureWorkspace,gitRoot:fixtureWorkspace}},true);
  const definitions = listToolDefinitions();
  const excluded = new Set(['memory_recall','memory_intent','session_history_search','session_history_read','run_skill_script']);
  const candidateNames = definitions.map(tool=>tool.name).filter(name=>!excluded.has(name));
  const saTools = getActiveToolDefinitions(candidateNames,'full',false,false,false).filter(tool=>tool.name !== 'run_workflow');
  const worker = buildRunnerAgentChain({backups:new Map(),executionCwd:fixtureWorkspace,gitRoot:fixtureWorkspace}).worker;
  const task = 'Explain where configuration is loaded.';
  const decision = buildFallbackRoutingDecision(task);
  const managedOwned = new Set(['base-system','base-system-suffix','environment-context','runtime-fact','working-directory','session-scratch-directory','repo-intelligence-context','execution-guidance','active-skill-invocation']);
  const stableIds = new Set(['project-agents','self-knowledge-routing','memory-rules','tool-construction']);
  const shared = snapshot.sections.filter(section=>!managedOwned.has(section.id));
  const context = {
    originalTask: task,
    workspace:{executionCwd:fixtureWorkspace,gitRoot:fixtureWorkspace,platform:process.platform},
    stableCapabilityContextBlock:shared.filter(section=>stableIds.has(section.id)).map(section=>section.content).join('\n\n'),
    capabilityContextBlock:shared.filter(section=>!stableIds.has(section.id)).map(section=>section.content).join('\n\n'),
  };
  const role = (mode:'stable'|'context') => createRolePrompt('worker',task,decision,undefined,undefined,'kodax/role/worker',undefined,context,undefined,false,mode);
  const sa = {system:size(snapshot.rendered),sections:snapshot.sections.map(section=>({id:section.id,...size(section.content)})),tools:toolsSummary(saTools)};
  const managed = {stableInstructions:size(buildWorkerStableInstructions()),system:size(role('stable')),dynamicContext:size(role('context')),tools:toolsSummary(worker.tools??[])};
  const report = {
    commit:execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8',windowsHide:true}).trim(),
    methodology:'Actual TypeScript component builders. Empty isolated home and empty non-Git workspace; no project rules, user history, skills, MCP, optional hosts, permission suffix or automatic repo-intelligence bundle. SA full repo-intel tool mode with workflow-host gate; managed Worker builder without optional hosts. Not a complete runtime/provider payload. countTokens heuristic, not BPE/API usage; exact chars/bytes for the stated normalized representation. Temporary fixture directory names have fixed length; path text is not stored.',
    sa, managed,
    componentTotals:{sa:sa.system.estimatedTokens+sa.tools.estimatedTokens,managed:managed.system.estimatedTokens+managed.dynamicContext.estimatedTokens+managed.tools.estimatedTokens},
  };
  const output = path.join(sourceRoot,'docs/research/kodax-controlled-input-inventory-2026-10-14.json');
  await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify({output,sa:{system:sa.system,tools:sa.tools.estimatedTokens,count:sa.tools.count},managed:{system:managed.system,dynamicContext:managed.dynamicContext,tools:managed.tools.estimatedTokens,count:managed.tools.count},componentTotals:report.componentTotals},null,2)+'\n');
} finally {
  setAgentConfigHome(undefined);
  // Nonrecursive cleanup: fail visibly if a builder unexpectedly wrote fixture files.
  await fs.rmdir(fixtureWorkspace);
  await fs.rmdir(fixtureHome);
  await fs.rmdir(fixtureRoot);
}
