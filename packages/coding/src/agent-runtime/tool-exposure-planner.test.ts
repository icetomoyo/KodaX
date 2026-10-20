import { describe, expect, it } from 'vitest';

import type { KodaXToolDefinition } from '@kodax-ai/llm';
import { createRuntimeContextBudgetSnapshot } from './context-budget.js';
import {
  applyToolExposurePlan,
  hasPortableToolBridge,
  planToolExposure,
  selectRuntimeContextOptimizationProfile,
} from './tool-exposure-planner.js';
import { getToolDefinition } from '../tools/index.js';

const readTool: KodaXToolDefinition = {
  name: 'read',
  description: 'Read a file from disk.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

const moduleContextTool: KodaXToolDefinition = {
  name: 'module_context',
  description: 'Long module context description. '.repeat(200),
  input_schema: {
    type: 'object',
    properties: {
      modulePath: {
        type: 'string',
        description: 'Module path.',
      },
    },
    required: ['modulePath'],
  },
};

const webFetchTool: KodaXToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch a URL with safety guidance. '.repeat(200),
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Remote URL.',
      },
    },
    required: ['url'],
  },
};

function bridgeTool(name: string): KodaXToolDefinition {
  return {
    name,
    description: `${name} bridge helper.`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  };
}

function pressureBudget() {
  return createRuntimeContextBudgetSnapshot({
    contextWindow: 16_000,
    systemPrompt: 'large prompt '.repeat(10_000),
    toolDefinitions: [readTool, moduleContextTool, webFetchTool],
    profile: 'report_only',
  });
}

describe('tool exposure planner', () => {
  it('recognizes the search and call bridge without requiring a second schema lookup entry', () => {
    expect(hasPortableToolBridge([bridgeTool('tool_search'), bridgeTool('tool_call')])).toBe(true);
    expect(hasPortableToolBridge([bridgeTool('tool_search')])).toBe(false);
    expect(hasPortableToolBridge([bridgeTool('tool_describe'), bridgeTool('tool_call')])).toBe(false);
  });

  it('keeps report-only mode behavior-preserving while showing bridge savings opportunity', () => {
    const plan = planToolExposure({
      tools: [readTool, moduleContextTool, webFetchTool],
      budget: pressureBudget(),
      bridgeAvailable: true,
      profile: 'report_only',
    });

    expect(plan.reportOnly).toBe(true);
    expect(plan.modelVisibleToolNames).toEqual(['read', 'module_context', 'web_fetch']);
    expect(plan.decisions.find((d) => d.toolName === 'module_context')?.mode).toBe('hint');
    expect(plan.decisions.find((d) => d.toolName === 'module_context')?.recommendedMode).toBe('bridge');
    expect(plan.estimatedTokensSaved).toBeGreaterThan(0);
    expect(plan.estimatedTokensSavedIfApplied).toBeGreaterThan(plan.estimatedTokensSaved);
  });

  it('never removes protected core tools, even under aggressive pressure', () => {
    const plan = planToolExposure({
      tools: [readTool, moduleContextTool],
      budget: pressureBudget(),
      bridgeAvailable: true,
      profile: 'aggressive',
    });

    const readDecision = plan.decisions.find((d) => d.toolName === 'read');
    expect(readDecision?.mode).toBe('resident');
    expect(readDecision?.recommendedMode).toBe('resident');
    expect(readDecision?.reason).toBe('protected_core');
    expect(plan.modelVisibleToolNames).toContain('read');
  });

  it('keeps portable bridge meta-tools resident under bridge pressure', () => {
    const plan = planToolExposure({
      tools: [
        bridgeTool('tool_search'),
        bridgeTool('tool_describe'),
        bridgeTool('tool_call'),
        moduleContextTool,
      ],
      budget: pressureBudget(),
      bridgeAvailable: true,
      profile: 'aggressive',
    });

    for (const name of ['tool_search', 'tool_describe', 'tool_call']) {
      const decision = plan.decisions.find((entry) => entry.toolName === name);
      expect(decision?.mode).toBe('resident');
      expect(decision?.recommendedMode).toBe('resident');
      expect(decision?.reason).toBe('protected_core');
      expect(plan.modelVisibleToolNames).toContain(name);
    }
    expect(plan.decisions.find((entry) => entry.toolName === 'module_context')?.mode).toBe('bridge');
  });

  it('keeps goal lifecycle tools resident under aggressive pressure', () => {
    const goalTools = ['get_goal', 'create_goal', 'update_goal']
      .map((name) => getToolDefinition(name))
      .filter((tool): tool is KodaXToolDefinition => tool !== undefined);
    const plan = planToolExposure({
      tools: goalTools,
      budget: pressureBudget(),
      bridgeAvailable: true,
      profile: 'aggressive',
    });

    expect(goalTools).toHaveLength(3);
    expect(plan.modelVisibleToolNames).toEqual(['get_goal', 'create_goal', 'update_goal']);
    for (const decision of plan.decisions) {
      expect(decision.mode).toBe('resident');
      expect(decision.recommendedMode).toBe('resident');
    }
  });

  it('falls back to native deferred or hints when the portable bridge is unavailable', () => {
    const nativePlan = planToolExposure({
      tools: [moduleContextTool],
      budget: pressureBudget(),
      nativeDeferredAvailable: true,
      profile: 'small_window',
    });
    expect(nativePlan.decisions[0]?.mode).toBe('native_deferred');

    const hintPlan = planToolExposure({
      tools: [moduleContextTool],
      budget: pressureBudget(),
      profile: 'small_window',
    });
    expect(hintPlan.decisions[0]?.mode).toBe('hint');
  });

  it('turns completely off when the profile is off', () => {
    const plan = planToolExposure({
      tools: [moduleContextTool],
      budget: pressureBudget(),
      bridgeAvailable: true,
      profile: 'off',
    });

    expect(plan.decisions[0]?.mode).toBe('resident');
    expect(plan.decisions[0]?.recommendedMode).toBe('resident');
    expect(plan.estimatedTokensSavedIfApplied).toBe(0);
  });

  it('selects behavior-changing profiles only when pressure or small-window schema cost justify it', () => {
    const lowBudget = createRuntimeContextBudgetSnapshot({
      contextWindow: 128_000,
      systemPrompt: 'short prompt',
      toolDefinitions: [readTool],
    });
    expect(selectRuntimeContextOptimizationProfile(lowBudget)).toBe('report_only');

    const highPressureBudget = createRuntimeContextBudgetSnapshot({
      contextWindow: 128_000,
      systemPrompt: 'history '.repeat(100_000),
      toolDefinitions: [readTool, moduleContextTool],
    });
    expect(selectRuntimeContextOptimizationProfile(highPressureBudget)).toBe('balanced');

    const smallWindowToolHeavyBudget = createRuntimeContextBudgetSnapshot({
      contextWindow: 16_000,
      systemPrompt: 'short prompt',
      toolDefinitions: [readTool, moduleContextTool, webFetchTool],
    });
    expect(smallWindowToolHeavyBudget.pressure).toBe('low');
    expect(selectRuntimeContextOptimizationProfile(smallWindowToolHeavyBudget)).toBe('small_window');
  });

  it('applies bridge plans by hiding only bridged tools from the provider-visible schema', () => {
    const tools = [
      readTool,
      bridgeTool('tool_search'),
      bridgeTool('tool_describe'),
      bridgeTool('tool_call'),
      moduleContextTool,
      webFetchTool,
    ];
    const budget = createRuntimeContextBudgetSnapshot({
      contextWindow: 16_000,
      systemPrompt: 'short prompt',
      toolDefinitions: tools,
    });
    const plan = planToolExposure({
      tools,
      budget: { ...budget, profile: 'small_window' },
      bridgeAvailable: hasPortableToolBridge(tools),
      profile: 'small_window',
    });

    const visible = applyToolExposurePlan(tools, plan).map((tool) => tool.name);

    expect(plan.reportOnly).toBe(false);
    expect(visible).toContain('read');
    expect(visible).toContain('tool_search');
    expect(visible).toContain('tool_describe');
    expect(visible).toContain('tool_call');
    expect(visible).not.toContain('module_context');
    expect(visible).not.toContain('web_fetch');
    expect(plan.estimatedTokensSaved).toBeGreaterThan(0);
  });
});
