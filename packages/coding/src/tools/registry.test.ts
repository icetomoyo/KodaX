import { describe, expect, it } from 'vitest';
import {
  executeTool,
  getTool,
  getRequiredToolParams,
  getToolDefinition,
  registerTool,
} from './index.js';
import type { KodaXToolExecutionContext } from '../types.js';

const TEST_CONTEXT: KodaXToolExecutionContext = {
  backups: new Map(),
  executionCwd: process.cwd(),
};

describe('tool registry', () => {
  it('FEATURE_075: exit_plan_mode plan description enforces structural length budget', () => {
    // LLM-first defense against oversized plans that blow past terminal
    // height. Scroll in the approval dialog is the mechanical fallback.
    const def = getToolDefinition('exit_plan_mode');
    const planSchema = (def?.input_schema as {
      properties?: { plan?: { description?: string } };
    } | undefined)?.properties?.plan;
    const desc = planSchema?.description ?? '';

    expect(desc).toMatch(/40 lines/);
    expect(desc).toMatch(/3 bullet-depth|3 levels|3 depth/i);
    expect(desc).toMatch(/one sentence|1 sentence|single sentence/i);
    expect(desc).toMatch(/phases|split/i);
  });

  it('derives required params from the active tool schema', () => {
    expect(getRequiredToolParams('read')).toEqual(['path']);
    expect(getRequiredToolParams('ask_user_question')).toEqual(['question']);
    expect(getRequiredToolParams('web_search')).toEqual(['query']);
    expect(getRequiredToolParams('code_search')).toEqual(['query']);
    expect(getRequiredToolParams('semantic_lookup')).toEqual(['query']);
    expect(getRequiredToolParams('mcp_search')).toEqual(['query']);
    expect(getRequiredToolParams('mcp_describe')).toEqual(['id']);
    expect(getRequiredToolParams('mcp_call')).toEqual(['id']);
    expect(getRequiredToolParams('mcp_read_resource')).toEqual(['id']);
    expect(getRequiredToolParams('changed_diff')).toEqual(['path']);
    expect(getRequiredToolParams('changed_diff_bundle')).toEqual(['paths']);
    expect(getRequiredToolParams('insert_after_anchor')).toEqual(['path', 'anchor', 'content']);
  });

  it('supports same-name override and restore via disposer', async () => {
    const originalHandler = getTool('read');
    const dispose = registerTool({
      name: 'read',
      description: 'Test override',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
      handler: async (input) => `override:${String(input.path)}`,
    });

    await expect(
      executeTool('read', { path: '/tmp/demo.txt' }, TEST_CONTEXT),
    ).resolves.toBe('override:/tmp/demo.txt');

    dispose();

    expect(getTool('read')).toBe(originalHandler);
  });
});
