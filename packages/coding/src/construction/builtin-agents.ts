import { staticText } from '../prompts/static-text.js';
/**
 * Built-in specialist agents registered into the same resolver as
 * user/project markdown agents. They are intentionally tiny manifests:
 * KodaX already has the specialist routing runtime, so built-ins should
 * reuse that path instead of adding another agent system.
 */

import { Runner } from '@kodax-ai/agent';

import { buildAdmissionManifest } from './admission-bridge.js';
import {
  listConstructedAgents,
  registerConstructedAgent,
  resolveConstructedAgent,
} from './agent-resolver.js';
import type { AgentArtifact, AgentContent, ToolRef } from './types.js';

export const REPO_EXPLORER_AGENT_NAME = 'repo-explorer';
export const REPO_EXPLORER_MAX_BUDGET = 80;

export const REPO_EXPLORER_TOOL_NAMES: readonly string[] = [
  'read',
  'glob',
  'grep',
  'code_search',
  'semantic_lookup',
  'repo_overview',
  'changed_scope',
  'changed_diff',
  'changed_diff_bundle',
  'module_context',
  'symbol_context',
  'process_context',
  'impact_estimate',
  'relationship_scan',
  'cyclic_dependencies',
  'lsp_definition',
  'lsp_hover',
  'lsp_references',
  'lsp_document_symbols',
  'lsp_workspace_symbols',
  'lsp_implementation',
  'lsp_prepare_call_hierarchy',
  'lsp_incoming_calls',
  'lsp_outgoing_calls',
];

function builtinToolRefs(names: readonly string[]): readonly ToolRef[] {
  return names.map((name) => ({ ref: `builtin:${name}` }));
}

export function buildRepoExplorerAgentContent(): AgentContent {
  return {
    description: 'Read-only repository exploration specialist for architecture, dependencies, call graphs, and change impact.',
    instructions: [
      staticText("t12i.construction/builtin-agents.block.0"),
    ].join('\n'),
    tools: builtinToolRefs(REPO_EXPLORER_TOOL_NAMES),
    maxBudget: REPO_EXPLORER_MAX_BUDGET,
  };
}

export function buildRepoExplorerAgentArtifact(now = Date.now()): AgentArtifact {
  return {
    kind: 'agent',
    name: REPO_EXPLORER_AGENT_NAME,
    version: '0.7.57-builtin',
    content: buildRepoExplorerAgentContent(),
    status: 'active',
    createdAt: now,
    testedAt: now,
    activatedAt: now,
  };
}

export async function ensureBuiltinRepoExplorerAgent(): Promise<boolean> {
  if (resolveConstructedAgent(REPO_EXPLORER_AGENT_NAME)) return false;

  const artifact = buildRepoExplorerAgentArtifact();
  const manifest = buildAdmissionManifest({ name: artifact.name, content: artifact.content });
  const activatedAgents = new Map(listConstructedAgents().map((agent) => [agent.name, agent]));
  const verdict = await Runner.admit(manifest, { activatedAgents });
  if (!verdict.ok) {
    throw new Error(`built-in ${REPO_EXPLORER_AGENT_NAME} admission rejected: ${verdict.reason}`);
  }

  registerConstructedAgent(
    artifact,
    {
      bindings: verdict.handle.invariantBindings,
      manifest: verdict.handle.manifest,
      source: 'built-in',
    },
  );
  return true;
}
