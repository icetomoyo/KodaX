import fs from 'node:fs';
import path from 'node:path';
import type {
  KodaXContentBlock,
  KodaXImageMediaType,
  KodaXInputArtifact,
} from '@kodax-ai/coding';
import { buildPromptMessageContent } from '@kodax-ai/coding';

const IMAGE_MEDIA_TYPES: Record<string, KodaXImageMediaType> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const IMAGE_REF_PATTERN = /@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;

/** Match user references using the host platform's path case semantics. */
export function inputArtifactPathKey(filePath: string, cwd: string): string {
  const resolved = path.resolve(cwd, filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Restore image references for editable input recalled without a local draft. */
export function restorePromptInputArtifacts(
  text: string,
  artifacts: readonly KodaXInputArtifact[],
  cwd: string,
): string {
  const resolvePath = (value: string): string => inputArtifactPathKey(value, cwd);
  const referenced = new Set([...text.matchAll(IMAGE_REF_PATTERN)]
    .map(match => resolvePath(match[1] ?? match[2] ?? match[3]!)));
  const restored: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== 'image' || referenced.has(resolvePath(artifact.path))) continue;
    referenced.add(resolvePath(artifact.path));
    const quote = artifact.path.includes('"') ? "'" : '"';
    restored.push(`@${quote}${artifact.path}${quote}`);
  }
  return restored.length > 0 ? `${text}${text.endsWith(' ') || !text ? '' : ' '}${restored.join(' ')}` : text;
}

export interface PreparedPromptInputArtifacts {
  promptText: string;
  messageContent: string | KodaXContentBlock[];
  inputArtifacts: KodaXInputArtifact[];
  warnings: string[];
}

function resolveImageMediaType(filePath: string): KodaXImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES[path.extname(filePath).toLowerCase()];
}

const IMAGE_UNAVAILABLE_PLACEHOLDER = '[Image unavailable]';

// claudecode parity (2026-05-20): no anchor / no [Image #N] reference is
// emitted into the user-message text. Models see pure user text + image
// blocks appended in order. The `[Image #N]` anchor approach read as a
// footnote-style external reference and primed the model toward "I should
// fetch this via a tool" instead of "I see this inline" — see
// c:/Works/claudecode/src/utils/processUserInput/processTextPrompt.ts:67-86.
// For multi-image disambiguation the model uses block order in the message,
// not text labels, exactly like claudecode does.
//
// Missing files still get `[Image unavailable]` because that surfaces the
// real problem (user typed an `@path` that didn't resolve) — silent drop
// would be worse.
function buildImageAnchor(_index: number): string {
  return '';
}

export function preparePromptInputArtifacts(
  promptText: string,
  cwd: string,
  recalledArtifacts: readonly KodaXInputArtifact[] = [],
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

    const resolvedPath = path.resolve(cwd, rawPath);
    const recalled = recalledArtifacts.find(artifact => artifact.kind === 'image'
      && inputArtifactPathKey(artifact.path, cwd) === inputArtifactPathKey(resolvedPath, cwd));
    const mediaType = (recalled?.kind === 'image' ? recalled.mediaType : undefined) ?? resolveImageMediaType(rawPath);
    if (!mediaType) {
      rewrittenPromptParts.push(match[0]);
      cursor = matchIndex + match[0].length;
      continue;
    }

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
      inputArtifacts.push(recalled ?? {
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
