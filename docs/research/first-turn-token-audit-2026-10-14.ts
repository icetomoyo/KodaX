// Offline inventory only. Run from the repository root with:
// node node_modules/vite-node/vite-node.mjs --config vitest.config.ts docs/research/first-turn-token-audit-2026-10-14.ts
// Requires the workspace dependencies; no Provider requests or tool execution.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
import { createRuntimeContextBudgetSnapshot } from '../../packages/coding/src/agent-runtime/context-budget.ts';
import { planToolExposure, selectRuntimeContextOptimizationProfile, hasPortableToolBridge } from '../../packages/coding/src/agent-runtime/tool-exposure-planner.ts';
import { DEFERRED_TOOL_HINTS } from '../../packages/coding/src/tools/deferred-tools.ts';
import type { KodaXToolDefinition } from '../../packages/llm/src/types.ts';
const root = process.cwd();
const fixtureHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-token-audit-home-'));
setAgentConfigHome(fixtureHome);
const size = (text: string) => ({chars: text.length, bytes: Buffer.byteLength(text), estimatedTokens: countTokens(text)});
const measureTool = (t: KodaXToolDefinition) => ({name: t.name, ...size(JSON.stringify({name:t.name,description:t.description,parameters:t.input_schema})), descriptionTokens:countTokens(t.description), parameterTokens:countTokens(JSON.stringify(t.input_schema)), deferred: t.name in DEFERRED_TOOL_HINTS});
const snapshot = await buildSystemPromptSnapshot({context:{executionCwd:root,gitRoot:root}}, true);
const full = listToolDefinitions();
const excluded = new Set(['memory_recall','memory_intent','session_history_search','session_history_read','run_skill_script']);
// Match run-substrate's final host gate: this fixture has no workflowHost.
const sa = getActiveToolDefinitions(full.map(t=>t.name).filter(n=>!excluded.has(n)), 'full', false, false, false)
  .filter(t=>t.name !== 'run_workflow');
const worker = buildRunnerAgentChain({backups:new Map(),executionCwd:root,gitRoot:root}).worker;
const workerTools = worker.tools ?? [];
const task = 'Explain where configuration is loaded.';
const decision = buildFallbackRoutingDecision(task);
const amaOwned = new Set(['base-system','base-system-suffix','environment-context','runtime-fact','working-directory','session-scratch-directory','repo-intelligence-context','execution-guidance','active-skill-invocation']);
const amaStable = new Set(['project-agents','self-knowledge-routing','memory-rules','tool-construction']);
const filtered = snapshot.sections.filter(s=>!amaOwned.has(s.id));
const ctx = {originalTask:task, workspace:{executionCwd:root,gitRoot:root,platform:process.platform},stableCapabilityContextBlock:filtered.filter(s=>amaStable.has(s.id)).map(s=>s.content).join('\n\n'),capabilityContextBlock:filtered.filter(s=>!amaStable.has(s.id)).map(s=>s.content).join('\n\n')};
const role = (mode: 'stable'|'context') => createRolePrompt('worker',task,decision,undefined,undefined,'kodax/role/worker',undefined,ctx,undefined,false,mode);
const total = (ts: readonly KodaXToolDefinition[]) => ts.map(measureTool).reduce((s,t)=>s+t.estimatedTokens,0);
const rows = workerTools.map(measureTool).sort((a,b)=>b.estimatedTokens-a.estimatedTokens);
const report = {
  methodology:'Offline source builders, no Provider calls. countTokens heuristic (ASCII about chars/4), not BPE/usage. Isolated empty global home; real worktree AGENTS only; no skills, MCP, host tools, history, memory pack, selected skill, permission context or repo-intelligence preturn bundle. SA full repo-intel mode; no memory intent and no session-history, skill-script or workflow host. Worker uses buildRunnerAgentChain with no optional hosts. Prompt layers measured separately; scenario is not an end-to-end provider payload.',
  commit:execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root, encoding:'utf8', windowsHide:true}).trim(),
  registryToolCount:full.length,
  sa:{system:size(snapshot.rendered),sections:snapshot.sections.map(s=>({id:s.id,...size(s.content)})),toolCount:sa.length,toolsEstimatedTokens:total(sa),exposure:[32768,131072,262144].map(contextWindow=>{const budget=createRuntimeContextBudgetSnapshot({contextWindow,systemPrompt:snapshot.rendered,toolDefinitions:sa});const profile=selectRuntimeContextOptimizationProfile(budget);const plan=planToolExposure({tools:sa,budget,profile,bridgeAvailable:hasPortableToolBridge(sa)});return {contextWindow,profile,pressure:budget.pressure,visibleTools:plan.modelVisibleToolNames.length,saved:plan.estimatedTokensSaved}})},
  worker:{stableInstructions:size(buildWorkerStableInstructions()),system:size(role('stable')),dynamicRoleContext:size(role('context')),toolCount:workerTools.length,toolsEstimatedTokens:total(workerTools),deferredOnly:rows.filter(r=>r.deferred),toolRows:rows},
  fullDescriptionsForWorkerToolsEstimatedTokens:total(full.filter(t=>workerTools.some(w=>w.name===t.name))),
};
const out=path.join(root,'docs/research/first-turn-token-audit-2026-10-14.json');
await fs.writeFile(out,JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify({out,...report,worker:{...report.worker,toolRows:rows.slice(0,16)}} ,null,2)+'\n');
setAgentConfigHome(undefined);
await fs.rmdir(fixtureHome);
