import fs from 'node:fs';
import path from 'node:path';
import type {
  KodaXContentBlock,
  KodaXInputArtifact,
} from '@kodax/coding';
import { buildPromptMessageContent } from '@kodax/coding';

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const IMAGE_REF_PATTERN = /@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;

export interface PreparedPromptInputArtifacts {
  promptText: string;
  messageContent: string | KodaXContentBlock[];
  inputArtifacts: KodaXInputArtifact[];
  warnings: string[];
}

function resolveImageMediaType(filePath: string): string | undefined {
  return IMAGE_MEDIA_TYPES[path.extname(filePath).toLowerCase()];
}

export function preparePromptInputArtifacts(
  promptText: string,
  cwd: string,
): PreparedPromptInputArtifacts {
  const inputArtifacts: KodaXInputArtifact[] = [];
  const warnings: string[] = [];
  const seenPaths = new Set<string>();

  for (const match of promptText.matchAll(IMAGE_REF_PATTERN)) {
    const rawPath = match[1] ?? match[2] ?? match[3];
    if (!rawPath) {
      continue;
    }

    const mediaType = resolveImageMediaType(rawPath);
    if (!mediaType) {
      continue;
    }

    const resolvedPath = path.resolve(cwd, rawPath);
    if (seenPaths.has(resolvedPath)) {
      continue;
    }

    try {
      const stats = fs.statSync(resolvedPath);
      if (!stats.isFile()) {
        warnings.push(`[Image input skipped] ${rawPath} is not a file.`);
        continue;
      }
    } catch {
      warnings.push(`[Image input missing] ${rawPath} was not found from ${cwd}.`);
      continue;
    }

    seenPaths.add(resolvedPath);
    inputArtifacts.push({
      kind: 'image',
      path: resolvedPath,
      mediaType,
      source: 'user-inline',
      description: `Attached image ${path.basename(resolvedPath)}`,
    });
  }

  return {
    promptText,
    messageContent: buildPromptMessageContent(promptText, inputArtifacts),
    inputArtifacts,
    warnings,
  };
}
