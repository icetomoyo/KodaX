/**
 * FEATURE_260 integration contract for governed system-prompt memory.
 *
 * The managed Worker's capability context receives bounded MemoryPack hooks.
 * Raw MEMORY.md bytes and topic bodies are never copied into the prompt.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveMemoryRoot, setAgentConfigHome, type MemoryPack } from '@kodax-ai/agent';
import { buildCapabilityContextSections, type KodaXOptions } from '@kodax-ai/coding';

async function renderCapabilityContext(options: KodaXOptions, isNewSession: boolean) {
  const sections = await buildCapabilityContextSections(options, isNewSession);
  return { sections, rendered: sections.map((section) => section.content).join('\n\n') };
}

describe('FEATURE_260 governed system-prompt memory', () => {
  let tempHome: string;
  let cwd: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-prompt-home-'));
    setAgentConfigHome(tempHome);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-mem-prompt-cwd-'));
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('emits an empty governed memory section without exposing a storage path', async () => {
    const snapshot = await renderCapabilityContext(options(), false);
    const memorySection = snapshot.sections.find((section) => section.id === 'project-memory');

    expect(memorySection?.content).toBe('Task-relevant memory hints: currently empty.');
    expect(snapshot.rendered).toContain('Memory evidence is managed by the KodaX Memory Control Plane.');
    expect(snapshot.rendered).not.toContain('Memory directory:');
    expect(snapshot.rendered).not.toContain('MEMORY.md is currently empty');
  });

  it('renders bounded hooks from a runtime-owned MemoryPack, not raw topic bodies', async () => {
    plantRawMemory('RAW-INDEX-MARKER', 'RAW-TOPIC-BODY-MARKER');
    const snapshot = await renderCapabilityContext(options(memoryPack('Project uses npm workspaces')), false);

    expect(snapshot.rendered).toContain('Task-relevant memory hints (bounded):');
    expect(snapshot.rendered).toContain('Project uses npm workspaces');
    expect(snapshot.rendered).toContain('memdir:project_stack.md');
    expect(snapshot.rendered).not.toContain('RAW-INDEX-MARKER');
    expect(snapshot.rendered).not.toContain('RAW-TOPIC-BODY-MARKER');
  });

  it('keeps each model-visible hint line bounded', async () => {
    const longHook = `Use the verified project procedure ${'X'.repeat(600)}`;
    const snapshot = await renderCapabilityContext(options(memoryPack(longHook)), false);
    const memorySection = snapshot.sections.find((section) => section.id === 'project-memory');
    const hint = memorySection?.content.split('\n').find((line) => line.startsWith('- '));

    expect(hint).toBeDefined();
    expect(hint!.length).toBeLessThan(360);
    expect(memorySection?.content).not.toContain('X'.repeat(181));
  });

  it('orders project rules, governed memory, and skills deterministically', async () => {
    fs.mkdirSync(path.join(cwd, '.kodax'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.kodax', 'AGENTS.md'),
      'PROJECT RULE: prefer project-scoped constraints.',
      'utf8',
    );
    const snapshot = await renderCapabilityContext({
      ...options(memoryPack('Memory-Entry-Marker-XYZ')),
      context: {
        ...options(memoryPack('Memory-Entry-Marker-XYZ')).context,
        skillsPrompt: '## Skills\nSkills-Marker-ABC',
      },
    }, false);
    const ids = snapshot.sections.map((section) => section.id);

    expect(ids.indexOf('project-agents')).toBeLessThan(ids.indexOf('memory-rules'));
    expect(ids.indexOf('memory-rules')).toBeLessThan(ids.indexOf('project-memory'));
    expect(ids.indexOf('project-memory')).toBeLessThan(ids.indexOf('skills-addendum'));
    expect(snapshot.rendered.indexOf('# Memory')).toBeLessThan(
      snapshot.rendered.indexOf('Memory-Entry-Marker-XYZ'),
    );
    expect(snapshot.rendered.indexOf('Memory-Entry-Marker-XYZ')).toBeLessThan(
      snapshot.rendered.indexOf('Skills-Marker-ABC'),
    );
  });

  it('uses only the pack bound to the current prompt build', async () => {
    const snapshotA = await renderCapabilityContext(options(memoryPack('PROJECT-A-HOOK')), false);
    const snapshotB = await renderCapabilityContext(options(memoryPack('PROJECT-B-HOOK')), false);

    expect(snapshotA.rendered).toContain('PROJECT-A-HOOK');
    expect(snapshotA.rendered).not.toContain('PROJECT-B-HOOK');
    expect(snapshotB.rendered).toContain('PROJECT-B-HOOK');
    expect(snapshotB.rendered).not.toContain('PROJECT-A-HOOK');
  });

  it('keeps the governed memory section under a small fixed prompt budget', async () => {
    const snapshot = await renderCapabilityContext(options(memoryPack('X'.repeat(20_000))), false);
    const memorySection = snapshot.sections.find((section) => section.id === 'project-memory');

    expect(Buffer.byteLength(memorySection?.content ?? '', 'utf8')).toBeLessThan(1_024);
  });

  function options(pack?: MemoryPack) {
    return {
      provider: 'openai',
      context: {
        executionCwd: cwd,
        gitRoot: cwd,
        ...(pack === undefined ? {} : { memoryPack: pack }),
      },
    } as const;
  }

  function plantRawMemory(indexMarker: string, topicMarker: string): void {
    const memoryDir = resolveMemoryRoot(cwd);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), `- ${indexMarker}\n`, 'utf8');
    fs.writeFileSync(path.join(memoryDir, 'project_stack.md'), topicMarker, 'utf8');
  }
});

function memoryPack(hook: string): MemoryPack {
  const ref = {
    kind: 'memdir',
    id: 'memdir:project_stack.md',
    scope: 'project',
    owner: 'project',
    lifecycle: 'active',
    authority: 'approved_write',
    visibility: 'prompt_safe',
    sourceRefs: [],
    relatedRefs: [],
  } as const;
  const promptHint = { ref, hook, reason: 'task-relevant governed claim' };
  return {
    generatedAt: '2026-07-12T00:00:00.000Z',
    taskFingerprint: 'task-fingerprint',
    memoryRevision: 'memory-revision',
    candidates: [promptHint],
    promptHints: [promptHint],
    hints: [promptHint],
    omitted: [],
    traceMetadata: {
      selectedRefIds: [ref.id],
      omittedRefIds: [],
      taskFingerprint: 'task-fingerprint',
      suppressed: false,
    },
  };
}
