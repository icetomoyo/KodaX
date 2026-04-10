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

const IMAGE_UNAVAILABLE_PLACEHOLDER = '[Image unavailable]';

function buildImageAnchor(index: number): string {
  return `[Image #${index}]`;
}

export function preparePromptInputArtifacts(
  promptText: string,
  cwd: string,
): PreparedPromptInputArtifacts {
  const inputArtifacts: KodaXInputArtifact[] = [];
  const warnings: string[] = [];
  const seenPaths = new Set<string>();
  const imageAnchors = new Map<string, string>();
  const warnedPaths = new Set<string>();
  const rewrittenPromptParts: string[] = [];
  let cursor = 0;

  for (const match of promptText.matchAll(IMAGE_REF_PATTERN)) {
    const matchIndex = match.index ?? cursor;
    rewrittenPromptParts.push(promptText.slice(cursor, matchIndex));

    const rawPath = match[1] ?? match[2] ?? match[3];
    if (!rawPath) {
      rewrittenPromptParts.push(match[0]);
      cursor = matchIndex + match[0].length;
      continue;
    }

    const mediaType = resolveImageMediaType(rawPath);
    if (!mediaType) {
      rewrittenPromptParts.push(match[0]);
      cursor = matchIndex + match[0].length;
      continue;
    }

    const resolvedPath = path.resolve(cwd, rawPath);
    try {
      const stats = fs.statSync(resolvedPath);
      if (!stats.isFile()) {
        if (!warnedPaths.has(resolvedPath)) {
          warnings.push(`[Image input skipped] ${rawPath} is not a file.`);
          warnedPaths.add(resolvedPath);
        }
        rewrittenPromptParts.push(IMAGE_UNAVAILABLE_PLACEHOLDER);
        cursor = matchIndex + match[0].length;
        continue;
      }
    } catch {
      if (!warnedPaths.has(resolvedPath)) {
        warnings.push(`[Image input missing] ${rawPath} was not found from ${cwd}.`);
        warnedPaths.add(resolvedPath);
      }
      rewrittenPromptParts.push(IMAGE_UNAVAILABLE_PLACEHOLDER);
      cursor = matchIndex + match[0].length;
      continue;
    }

    if (!seenPaths.has(resolvedPath)) {
      seenPaths.add(resolvedPath);
      const anchor = buildImageAnchor(inputArtifacts.length + 1);
      imageAnchors.set(resolvedPath, anchor);
      inputArtifacts.push({
        kind: 'image',
        path: resolvedPath,
        mediaType,
        source: 'user-inline',
        description: `Attached image ${path.basename(resolvedPath)}`,
      });
    }

    rewrittenPromptParts.push(imageAnchors.get(resolvedPath) ?? IMAGE_UNAVAILABLE_PLACEHOLDER);
    cursor = matchIndex + match[0].length;
  }

  rewrittenPromptParts.push(promptText.slice(cursor));
  const cleanedPromptText = rewrittenPromptParts.join('');

  return {
    promptText: cleanedPromptText,
    messageContent: buildPromptMessageContent(cleanedPromptText, inputArtifacts),
    inputArtifacts,
    warnings,
  };
}
