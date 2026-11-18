/**
 * FEATURE_124 (v0.7.43) Phase B — `project-memory` SP section builder.
 *
 * Reads MEMORY.md from the resolved per-project memory directory,
 * applies KodaX's bounded line/byte preview, and emits the SP
 * section content. Designed for SYNC fs reads (mirrors
 * `loadAgentsFiles` / `formatAgentsForPrompt` pattern in
 * `context/agents-loader.ts` — SP build is synchronous).
 *
 * Section position in `capability-sections.ts`:
 *   project-agents (AGENTS.md, user-managed)
 *     ↓
 *   memory-rules (Phase C — LLM teaching text)
 *     ↓
 *   project-memory (this section — MEMORY.md index)
 *     ↓
 *   skills-addendum
 *
 * Why index only, no topic-file pre-injection:
 *   - This prompt preview is capped at 8KB / 60 lines. MEMORY.md remains
 *     the navigational index, not a bulk context carrier.
 *   - Topic files (`feedback_*.md`, `user_*.md`, etc.) are unbounded —
 *     pre-injecting all of them would make context occupancy unpredictable.
 *   - The LLM reads topic files on demand via the existing `read` tool
 *     when an index entry looks relevant.
 *
 * Fallback when MEMORY.md is missing:
 *   - Returns a "your MEMORY.md is currently empty" stub so the LLM
 *     still sees the memory subsystem is active and knows where to
 *     write its first entry. Matches claudecode `buildMemoryPrompt`
 *     L307-313 fallback text.
 *
 * The directory is NOT created here — that happens lazily on the first
 * LLM Write tool call. Section building must remain side-effect-free so
 * tests can run hermetically and `setAgentConfigHome()` overrides apply
 * uniformly across read/write paths.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  parseMemoryFile,
  resolveMemoryEntrypoint,
  resolveMemoryRoot,
} from '@kodax-ai/agent';

export interface MemorySectionResult {
  /** SP section content. Always non-empty (fallback when MEMORY.md missing). */
  readonly content: string;
  /** Resolved memory directory absolute path. */
  readonly memoryDir: string;
  /** True when the MEMORY.md file exists and was read. */
  readonly entrypointExists: boolean;
}

interface MemoryHintEntry {
  readonly filename: string;
  readonly title: string;
  readonly hook: string;
  readonly mtimeMs: number;
}

interface PromptMemoryIndexPreview {
  readonly content: string;
  readonly warning?: string;
}

const MAX_PROMPT_INDEX_LINES = 60;
const MAX_PROMPT_INDEX_BYTES = 8_000;

/**
 * mtime-keyed read cache for MEMORY.md — mirrors the FEATURE_149 pattern in
 * `context/agents-loader.ts` (`readFileWithMtimeCache`). `buildMemorySection`
 * runs on EVERY SP rebuild (once per direct-engine or AMA turn); MEMORY.md is up to 25KB, so
 * re-reading it every turn is wasted sync IO. Keyed by absolute entrypoint path;
 * a `todo_save` write bumps the file mtime and invalidates the entry automatically.
 */
const entrypointCache = new Map<string, { mtimeMs: number; content: string }>();

/** Test-only — reset the MEMORY.md read cache between unit tests. */
export function clearMemorySectionCacheForTesting(): void {
  entrypointCache.clear();
}

/**
 * Read MEMORY.md via the mtime cache. Returns the raw content when the file
 * exists and is readable, or `undefined` for any stat/read failure (missing
 * file, EISDIR, permission denied) — the caller degrades to the empty fallback.
 * Never throws.
 */
function readEntrypointWithCache(entrypoint: string): string | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(entrypoint).mtimeMs;
  } catch {
    entrypointCache.delete(entrypoint);
    return undefined;
  }
  const cached = entrypointCache.get(entrypoint);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.content;
  }
  try {
    const content = fs.readFileSync(entrypoint, 'utf-8');
    entrypointCache.set(entrypoint, { mtimeMs, content });
    return content;
  } catch {
    entrypointCache.delete(entrypoint);
    return undefined;
  }
}

/**
 * Build the `project-memory` SP section content for the given cwd.
 *
 * Synchronous + side-effect-free + NEVER throws — any fs read failure
 * (permission denied, transient EBUSY) silently degrades to the empty-
 * memory fallback. A missing memory subsystem must not break session
 * startup.
 */
export function buildMemorySection(cwd: string): MemorySectionResult {
  const memoryDir = resolveMemoryRoot(cwd);
  const entrypoint = resolveMemoryEntrypoint(cwd);

  const raw = readEntrypointWithCache(entrypoint);
  const entrypointExists = raw !== undefined;

  const content = entrypointExists
    ? buildBodyWithEntrypoint(memoryDir, raw)
    : buildEmptyFallback(memoryDir);

  return { content, memoryDir, entrypointExists };
}

/**
 * Compose the section body when MEMORY.md exists. Trims, truncates,
 * then wraps with the section header + footer hint about topic files.
 */
function buildBodyWithEntrypoint(memoryDir: string, raw: string): string {
  const preview = truncatePromptMemoryIndex(raw);
  const hintLines = buildMemoryHintLines(memoryDir);
  return [
    '=== Persistent memory (cross-session) ===',
    `Memory directory: ${memoryDir}`,
    '',
    preview.content,
    ...(preview.warning === undefined ? [] : ['', preview.warning]),
    ...hintLines,
    '',
    '[Bounded index only - read individual files via the read tool when you need details. See memory rules section above.]',
  ].join('\n');
}

function truncatePromptMemoryIndex(raw: string): PromptMemoryIndexPreview {
  const normalized = raw.trimEnd();
  const lines = normalized.length === 0 ? [] : normalized.split(/\r?\n/);
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(normalized, 'utf8');

  let content = normalized;
  let truncated = false;
  if (totalLines > MAX_PROMPT_INDEX_LINES) {
    content = lines.slice(0, MAX_PROMPT_INDEX_LINES).join('\n');
    truncated = true;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_PROMPT_INDEX_BYTES) {
    content = sliceUtf8ToByteCap(content, MAX_PROMPT_INDEX_BYTES);
    truncated = true;
  }
  if (!truncated) return { content };
  return {
    content,
    warning: [
      `> NOTE: MEMORY.md has ${totalLines} lines / ${formatBytes(totalBytes)}.`,
      `Only a bounded ${MAX_PROMPT_INDEX_LINES}-line / ${formatBytes(MAX_PROMPT_INDEX_BYTES)} index preview is loaded here.`,
      'Read relevant topic files on demand instead of relying on the prompt to carry every memory.',
    ].join(' '),
  };
}

function sliceUtf8ToByteCap(value: string, byteCap: number): string {
  let bytes = 0;
  const chars: string[] = [];
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > byteCap) break;
    chars.push(char);
    bytes += charBytes;
  }
  const sliced = chars.join('');
  const lastNewline = sliced.lastIndexOf('\n');
  return (lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced).trimEnd();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

/**
 * Fallback section body when MEMORY.md is missing. Tells the LLM the
 * subsystem is active and gives the directory path it should write to.
 */
function buildEmptyFallback(memoryDir: string): string {
  return [
    '=== Persistent memory (cross-session) ===',
    `Memory directory: ${memoryDir}`,
    '',
    'Your MEMORY.md is currently empty. When you save new memories, they will appear here.',
  ].join('\n');
}

function buildMemoryHintLines(memoryDir: string): readonly string[] {
  const entries = [...readMemoryHintEntries(memoryDir)]
    .sort((left: MemoryHintEntry, right: MemoryHintEntry) => right.mtimeMs - left.mtimeMs)
    .slice(0, 8);
  if (entries.length === 0) return [];
  return [
    '',
    'Governed memory hints (deterministic):',
    ...entries.map((entry) => `- ${entry.title}: ${entry.hook} (${entry.filename})`),
  ];
}

function readMemoryHintEntries(memoryDir: string): readonly MemoryHintEntry[] {
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(memoryDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: MemoryHintEntry[] = [];
  for (const file of files) {
    if (!file.isFile() || file.name === 'MEMORY.md' || !file.name.endsWith('.md')) continue;
    const entry = readMemoryHintEntry(path.join(memoryDir, file.name), file.name);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

function readMemoryHintEntry(absolutePath: string, filename: string): MemoryHintEntry | undefined {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = fs.readFileSync(absolutePath, 'utf-8');
    mtimeMs = fs.statSync(absolutePath).mtimeMs;
  } catch {
    return undefined;
  }
  const parsed = parseMemoryFile(raw);
  const title = parsed.frontmatter.name ?? path.basename(filename, '.md');
  const hook = parsed.frontmatter.description ?? firstBodyLine(parsed.body) ?? title;
  return { filename, title, hook, mtimeMs };
}

function firstBodyLine(body: string): string | undefined {
  const line = body.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.length > 0);
  return line === undefined ? undefined : line.slice(0, 160);
}
