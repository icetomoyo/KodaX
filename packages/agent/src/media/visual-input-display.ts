import type { KodaXMessage } from '@kodax-ai/llm';

export interface VisualInputAttachment {
  readonly kind: 'image';
  readonly path: string;
  readonly mediaType?: string;
  readonly observationId?: string;
  readonly sha256?: string;
  readonly width?: number;
  readonly height?: number;
}

/** Decode Host-owned model labels, including beta.5 history, without altering canonical input. */
export function projectVisualInputContent(content: KodaXMessage['content']): {
  text: string; attachments: VisualInputAttachment[];
} {
  if (typeof content === 'string') return { text: content, attachments: [] };
  const images = new Map<number, VisualInputAttachment>();
  const texts = new Map<number, string>();
  for (const [index, block] of content.entries()) {
    if (block.type === 'image') images.set(index, { kind: 'image', path: block.path,
      ...(block.mediaType ? { mediaType: block.mediaType } : {}) });
    if (block.type === 'text') texts.set(index, block.text);
  }
  for (const [index, text] of texts) {
    const following: number[] = [];
    for (let next = index + 1; images.has(next); next++) following.push(next);
    if (following.length === 0) continue;
    const direct = readLabel(text, images.get(following[0]!)!);
    if (direct) {
      images.set(following[0]!, direct);
      texts.delete(index);
      continue;
    }
    // Queued inputs append numbered labels to the original text before lowering images.
    let original = text;
    const labelled: VisualInputAttachment[] = [];
    for (let ordinal = following.length - 1; ordinal >= 0; ordinal--) {
      const boundary = original.lastIndexOf('\n');
      const prefix = `Image ${ordinal + 1}: `;
      const line = original.slice(boundary + 1);
      const attachment = boundary >= 0 && line.startsWith(prefix)
        ? readLabel(line.slice(prefix.length), images.get(following[ordinal]!)!) : undefined;
      if (!attachment) break;
      labelled.unshift(attachment);
      original = original.slice(0, boundary);
    }
    if (labelled.length === following.length) {
      texts.set(index, original);
      following.forEach((position, ordinal) => images.set(position, labelled[ordinal]!));
    }
  }
  return { text: [...texts.values()].join('\n'), attachments: [...images.values()] };
}

function readLabel(text: string, image: VisualInputAttachment): VisualInputAttachment | undefined {
  const match = /^(obs_[a-f0-9-]{36}); source=user; observedAt=[^;\n]+; historical; (unknown|\d+)x(unknown|\d+); sha256=([a-f0-9]{64})$/.exec(text);
  // Only a generated label bound to the corresponding immutable Host media path is metadata.
  if (!match || image.path.split(/[\\/]/).at(-1) !== match[4]) return undefined;
  return { ...image, observationId: match[1]!, sha256: match[4]!,
    ...(match[2] !== 'unknown' ? { width: Number(match[2]) } : {}),
    ...(match[3] !== 'unknown' ? { height: Number(match[3]) } : {}) };
}
