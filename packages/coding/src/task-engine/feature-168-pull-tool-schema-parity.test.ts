/**
 * FEATURE_168 (v0.7.40 hotfix) — Layer 1 schema parity check.
 *
 * Current scope: preserve the raw SDK invocation fields in FEATURE_161's
 * frozen schemas. The model projection is tested separately. changed_diff
 * now admits path OR paths, with branch validation in its handler; legacy
 * callers must not gain additional mandatory parameters.
 *
 * Per EVAL_GUIDELINES §Layer 1: "any 'X 机制是否生效' / 'X 函数是否被调用' /
 * 'X env hook 是否实装' 类问题" — schema-bytes parity is the textbook example.
 * Approving this kind of question to a Layer 2 probe would burn budget on
 * information code-reading already gives us.
 *
 * If this test passes:
 *   - All 8 pull tools' `name` and outer `description` are byte-identical
 *     between FEATURE_161 mocked schema and the FEATURE_168 wired schema.
 *   - All 8 pull tools' `input_schema.properties` keys are a superset of the
 *     mocked properties (production may expose strictly more properties).
 *   - Required fields do not add new obligations to legacy callers; enums
 *     and types retain their legacy values.
 *   - Wired schema may additionally carry per-property `description` strings
 *     that FEATURE_161 stripped (not present in mocked).
 *
 * SDK compatibility is a Layer 1 question. It does not establish model
 * adoption, intelligence or performance: FEATURE_161's observations remain
 * historical and are not a lower bound for the new model-facing contract.
 *
 * If this test FAILS:
 *   - The wired schema diverged from what FEATURE_161 measured. Treat the
 *     diverged tool as needing a fresh Layer 2 probe before relying on the
 *     FEATURE_161 number.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXToolDefinition } from '@kodax-ai/llm';

import { getToolDefinition } from '../tools/registry.js';

// ---------------------------------------------------------------------------
// FEATURE_161 mocked schema (copied byte-for-byte from
// tests/repointel-tool-adoption.eval.ts:85-180 — the eval driver's PULL_TOOLS
// constant at the time the +30-40pp adoption-lift data was collected).
//
// Inline rather than imported because the driver lives under tests/ which is
// outside packages/coding/src/ — vitest can include this file without pulling
// the full eval driver (which depends on benchmark/harness).
// ---------------------------------------------------------------------------

const FEATURE_161_MOCKED_SCHEMA: Readonly<Record<string, KodaXToolDefinition>> = {
  repo_overview: {
    name: 'repo_overview',
    description: 'Summarize the repository structure, key areas, entry hints, and stored repo-intelligence snapshot for the current workspace.',
    input_schema: {
      type: 'object',
      properties: {
        target_path: { type: 'string' },
        refresh: { type: 'boolean' },
      },
    },
  },
  changed_scope: {
    name: 'changed_scope',
    description: 'Analyze which files, areas, and categories are touched by the current git diff or a comparison range.',
    input_schema: {
      type: 'object',
      properties: {
        target_path: { type: 'string' },
        scope: { type: 'string', enum: ['unstaged', 'staged', 'all', 'compare'] },
        base_ref: { type: 'string' },
      },
    },
  },
  changed_diff: {
    name: 'changed_diff',
    description: 'Read a paged diff slice for a specific changed file. Prefer this over broad git diff output during large reviews.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['path'],
    },
  },
  changed_diff_bundle: {
    name: 'changed_diff_bundle',
    description: 'Read diff slices for multiple changed files in one call. Prefer this for large reviews before drilling down with changed_diff.',
    input_schema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        limit_per_path: { type: 'number' },
      },
      required: ['paths'],
    },
  },
  module_context: {
    name: 'module_context',
    description: 'Return a task-shaped module capsule with dependencies, entry files, symbols, tests, docs, and follow-up handles.',
    input_schema: {
      type: 'object',
      properties: {
        module: { type: 'string' },
        target_path: { type: 'string' },
      },
    },
  },
  symbol_context: {
    name: 'symbol_context',
    description: 'Return definition, probable callers/callees, imports, and alternatives for a repository symbol.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        module: { type: 'string' },
        target_path: { type: 'string' },
      },
    },
  },
  process_context: {
    name: 'process_context',
    description: 'Return an approximate static execution/process capsule for an entry symbol, module, or path.',
    input_schema: {
      type: 'object',
      properties: {
        entry: { type: 'string' },
        module: { type: 'string' },
        target_path: { type: 'string' },
      },
    },
  },
  impact_estimate: {
    name: 'impact_estimate',
    description: 'Estimate blast radius for a symbol, path, or module using local intelligence plus changed-scope overlap.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        module: { type: 'string' },
        path: { type: 'string' },
      },
    },
  },
};

const PULL_TOOL_NAMES = Object.keys(FEATURE_161_MOCKED_SCHEMA) as readonly string[];

// ---------------------------------------------------------------------------
// Parity check helpers
// ---------------------------------------------------------------------------

interface ObjectSchema {
  type?: string;
  properties?: Record<string, { type?: string; enum?: readonly unknown[]; items?: unknown }>;
  required?: readonly string[];
}

function getWiredSchema(name: string): KodaXToolDefinition {
  const def = getToolDefinition(name);
  if (!def) {
    throw new Error(`Tool "${name}" not registered — FEATURE_168 wiring fix should have made it visible`);
  }
  return def;
}

function propertiesOf(schema: KodaXToolDefinition['input_schema']): Record<string, { type?: string; enum?: readonly unknown[]; items?: unknown }> {
  return (schema as ObjectSchema).properties ?? {};
}

function requiredOf(schema: KodaXToolDefinition['input_schema']): readonly string[] {
  return (schema as ObjectSchema).required ?? [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FEATURE_168 — pull-tool schema parity with FEATURE_161 mocked schema', () => {
  it.each(PULL_TOOL_NAMES)('%s — name field is byte-identical', (toolName) => {
    const wired = getWiredSchema(toolName);
    const mocked = FEATURE_161_MOCKED_SCHEMA[toolName];
    expect(wired.name).toBe(mocked.name);
  });

  // RETIRED 2026-05-31 (v0.7.45) — "outer description is byte-identical" was
  // over-strict and went stale once production pull-tool descriptions were
  // deliberately enriched/reworded (ADR-033 prompt-design + FEATURE_189 tool
  // description cleanup) after FEATURE_161 snapshotted its frozen mock at
  // v0.7.40. The mock stays frozen. These assertions preserve legacy SDK
  // fields; they do not transfer historical adoption measurements to the
  // separately projected model contract.

  it.each(PULL_TOOL_NAMES)('%s — input_schema.properties is a superset (every mocked key exists in wired)', (toolName) => {
    const wired = getWiredSchema(toolName);
    const mocked = FEATURE_161_MOCKED_SCHEMA[toolName];
    const wiredProps = propertiesOf(wired.input_schema);
    const mockedProps = propertiesOf(mocked.input_schema);
    for (const key of Object.keys(mockedProps)) {
      expect(wiredProps, `wired schema missing property "${key}"`).toHaveProperty(key);
    }
  });

  it.each(PULL_TOOL_NAMES)('%s — every mocked property type matches wired property type', (toolName) => {
    const wired = getWiredSchema(toolName);
    const mocked = FEATURE_161_MOCKED_SCHEMA[toolName];
    const wiredProps = propertiesOf(wired.input_schema);
    const mockedProps = propertiesOf(mocked.input_schema);
    for (const [key, mockedProp] of Object.entries(mockedProps)) {
      const wiredProp = wiredProps[key];
      expect(wiredProp.type, `${toolName}.${key} type mismatch`).toBe(mockedProp.type);
    }
  });

  it.each(PULL_TOOL_NAMES)('%s — required fields add no obligations to a legacy invocation', (toolName) => {
    const wired = getWiredSchema(toolName);
    const mocked = FEATURE_161_MOCKED_SCHEMA[toolName];
    for (const field of requiredOf(wired.input_schema)) {
      expect(requiredOf(mocked.input_schema)).toContain(field);
    }
  });

  it('changed_scope — enum exposed in wired schema is a superset of mocked enum', () => {
    const wired = getWiredSchema('changed_scope');
    const mocked = FEATURE_161_MOCKED_SCHEMA.changed_scope;
    const wiredEnum = (propertiesOf(wired.input_schema).scope?.enum ?? []) as readonly string[];
    const mockedEnum = (propertiesOf(mocked.input_schema).scope?.enum ?? []) as readonly string[];
    for (const value of mockedEnum) {
      expect(wiredEnum, `scope enum missing value "${value}"`).toContain(value);
    }
  });
});

describe('FEATURE_168 — wired schema may add information (one-way superset)', () => {
  it('wired schema carries per-property inner descriptions that FEATURE_161 mocked schema stripped', () => {
    // Production registry definitions include `description` on each
    // `input_schema.properties.*` field. FEATURE_161's mocked schema removed
    // them. This test pins the asymmetry — if a future change strips inner
    // descriptions from the production schema, it would silently degrade the
    // FEATURE_161 result's transferability and should surface here.
    const wired = getWiredSchema('repo_overview');
    const wiredProps = propertiesOf(wired.input_schema) as Record<string, { description?: string }>;
    expect(wiredProps.target_path?.description?.length ?? 0).toBeGreaterThan(0);
    expect(wiredProps.refresh?.description?.length ?? 0).toBeGreaterThan(0);
  });
});
