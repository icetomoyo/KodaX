import * as fs from "node:fs";
import path from "node:path";

import {
  createMemoryControlPlane,
  listPendingEpisodeReviewSummaries,
  parseMemoryFile,
  resolveScopedMemoryRoot,
  type MemoryManagementController,
  type MemoryContextIdentity,
  type PendingEpisodeReviewSummary,
} from "@kodax-ai/agent";
import { deriveCodingMemoryIdentityFromRoot } from "@kodax-ai/coding";
import { resolveProvider } from "@kodax-ai/llm";

/**
 * FEATURE_298 T36 — the Host-owned Memory management surface. Callers name a
 * project root; the Host derives the Memory identity itself (the same
 * derivation the run path uses) and owns the storage root, the control
 * plane, index rebuilds, and open-target resolution. The UI keeps only
 * presentation and the editor launch.
 */
export interface RuntimeMemoryRebuildResult {
  readonly status: "missing-dir" | "no-topics" | "rebuilt";
  readonly memoryRoot: string;
  readonly entrypointPath: string;
  readonly entryCount: number;
  readonly malformedFiles: readonly string[];
  readonly warnings: readonly string[];
}

export interface RuntimeMemoryPlane {
  readonly controller: MemoryManagementController;
  readonly memoryRoot: string;
  readonly entrypointPath: string;
  /** Pending episode reviews for the identities this project actually reads. */
  listReviews(): Promise<readonly PendingEpisodeReviewSummary[]>;
  /** Whether the Host's Memory reviewer Provider is usable. */
  reviewerProviderConfigured(): boolean;
  /** Rebuild the derived MEMORY.md index; topic files are never modified. */
  rebuild(): Promise<RuntimeMemoryRebuildResult>;
  /**
   * Validate a `/memory open` target against the project memory root
   * (mkdir of the untouched root is Host-owned; realpath containment blocks
   * escapes). The editor launch itself stays in the UI.
   */
  ensureOpenTarget(targetPath: string): Promise<string>;
}

export interface RuntimeMemoryService {
  forProject(projectRoot: string): RuntimeMemoryPlane;
}

interface TopicFile {
  readonly filename: string;
  readonly absPath: string;
  readonly mtimeMs: number;
  readonly title: string;
  readonly description: string;
  readonly parseOk: boolean;
}

function readTopicFiles(
  memoryDir: string,
  warnings: string[],
): TopicFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(memoryDir, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`failed to read memory directory ${memoryDir}: ${String(error)}`);
    }
    return [];
  }
  const result: TopicFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md") {
      continue;
    }
    const absPath = path.join(memoryDir, entry.name);
    try {
      const raw = fs.readFileSync(absPath, "utf-8");
      const mtimeMs = fs.statSync(absPath).mtimeMs;
      const fm = parseMemoryFile(raw).frontmatter;
      const parseOk =
        fm.name !== undefined
        || fm.description !== undefined
        || fm.type !== undefined;
      const baseTitle = path.basename(entry.name, ".md");
      result.push({
        filename: entry.name,
        absPath,
        mtimeMs,
        title: fm.name?.trim() || baseTitle,
        description: fm.description?.trim() || baseTitle,
        parseOk,
      });
    } catch (error: unknown) {
      warnings.push(`failed to read ${absPath}: ${String(error)}`);
    }
  }
  return result;
}

export function createRuntimeMemoryService(input: {
  readonly configHome: string;
  readonly defaultProvider?: string;
}): RuntimeMemoryService {
  const planes = new Map<string, RuntimeMemoryPlane>();
  return {
    forProject(projectRoot) {
      const key = path.resolve(projectRoot).toLowerCase();
      const cached = planes.get(key);
      if (cached !== undefined) return cached;

      const identity: MemoryContextIdentity =
        deriveCodingMemoryIdentityFromRoot(input.configHome, projectRoot);
      // deriveCodingMemoryIdentityFromRoot always sets projectId.
      const memoryRoot = resolveScopedMemoryRoot(identity, "project");
      const controller = createMemoryControlPlane({
        cwd: projectRoot,
        identity,
      });
      const plane: RuntimeMemoryPlane = {
        controller,
        memoryRoot,
        entrypointPath: path.join(memoryRoot, "MEMORY.md"),
        reviewerProviderConfigured() {
          try {
            return resolveProvider(input.defaultProvider ?? "anthropic").isConfigured();
          } catch {
            // An unresolvable provider name is deterministically
            // unconfigured; the status surface reports it below.
            return false;
          }
        },
        async listReviews() {
          const localProjectId = `local:${key}`;
          const ownerIdentities = identity.projectId === localProjectId
            ? [identity]
            : [identity, { ...identity, projectId: localProjectId }];
          const pages = await Promise.all(ownerIdentities.map((owner) => (
            listPendingEpisodeReviewSummaries({
              configHome: owner.configHome,
              tenantId: owner.tenantId,
              agentId: owner.agentId,
              projectId: owner.projectId ?? null,
            })
          )));
          const unique = new Map<string, PendingEpisodeReviewSummary>();
          for (const review of pages.flat()) {
            const dedupeKey = review.jobId
              ?? `${review.ownerSessionRef}:${review.reviewKey}`;
            if (!unique.has(dedupeKey)) unique.set(dedupeKey, review);
          }
          return [...unique.values()].sort((left, right) => (
            left.createdAt.localeCompare(right.createdAt)
            || left.reviewKey.localeCompare(right.reviewKey)
          ));
        },
        async rebuild() {
          const warnings: string[] = [];
          let dirExists = false;
          try {
            dirExists = fs.statSync(memoryRoot).isDirectory();
          } catch {
            dirExists = false;
          }
          if (!dirExists) {
            return {
              status: "missing-dir",
              memoryRoot,
              entrypointPath: plane.entrypointPath,
              entryCount: 0,
              malformedFiles: [],
              warnings,
            };
          }
          const files = readTopicFiles(memoryRoot, warnings);
          if (files.length === 0) {
            return {
              status: "no-topics",
              memoryRoot,
              entrypointPath: plane.entrypointPath,
              entryCount: 0,
              malformedFiles: [],
              warnings,
            };
          }
          // mtime descending = newest on top, matching the PREPEND-to-top
          // ordering documented in the memory rules.
          const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
          const body = sorted
            .map((file) => `- [${file.title}](${file.filename}) — ${file.description}`)
            .join("\n") + "\n";
          fs.writeFileSync(plane.entrypointPath, body, "utf-8");
          return {
            status: "rebuilt",
            memoryRoot,
            entrypointPath: plane.entrypointPath,
            entryCount: sorted.length,
            malformedFiles: sorted.filter((file) => !file.parseOk)
              .map((file) => file.filename),
            warnings,
          };
        },
        async ensureOpenTarget(targetPath) {
          if (
            path.resolve(targetPath) === path.resolve(memoryRoot)
            && !fs.existsSync(memoryRoot)
          ) {
            fs.mkdirSync(memoryRoot, { recursive: true });
          }
          const probe = fs.existsSync(targetPath)
            ? targetPath
            : path.dirname(targetPath);
          const resolvedTarget = fs.realpathSync(probe);
          const resolvedRoot = fs.existsSync(memoryRoot)
            ? fs.realpathSync(memoryRoot)
            : memoryRoot;
          if (
            resolvedTarget !== resolvedRoot
            && !resolvedTarget.startsWith(resolvedRoot + path.sep)
          ) {
            throw new Error(
              `Memory open target escapes the project memory root: ${targetPath}`,
            );
          }
          return targetPath;
        },
      };
      planes.set(key, plane);
      return plane;
    },
  };
}
