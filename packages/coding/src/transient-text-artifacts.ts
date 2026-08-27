import { randomBytes } from 'node:crypto';

const TRANSIENT_TEXT_ARTIFACT_PREFIX = 'kodax-transient://text/';
const artifacts = new Map<string, string>();

/**
 * Stores request-only text in trusted process memory. The opaque capability
 * URI is not enumerable from shell sandboxes and disappears on process death.
 */
export function createTransientTextArtifact(content: string): string {
  const artifactPath = `${TRANSIENT_TEXT_ARTIFACT_PREFIX}${randomBytes(32).toString('hex')}`;
  artifacts.set(artifactPath, content);
  return artifactPath;
}

export function readTransientTextArtifact(artifactPath: string): string | undefined {
  return artifactPath.startsWith(TRANSIENT_TEXT_ARTIFACT_PREFIX)
    ? artifacts.get(artifactPath)
    : undefined;
}

/** Exact capability membership check; never exposes or enumerates capability IDs. */
export function hasTransientTextArtifact(artifactPath: string): boolean {
  return artifactPath.startsWith(TRANSIENT_TEXT_ARTIFACT_PREFIX)
    && artifacts.has(artifactPath);
}

export function deleteTransientTextArtifact(artifactPath: string): void {
  if (artifactPath.startsWith(TRANSIENT_TEXT_ARTIFACT_PREFIX)) {
    artifacts.delete(artifactPath);
  }
}
