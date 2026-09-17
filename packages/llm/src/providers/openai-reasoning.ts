import type { KodaXThinkingBlock } from '../types.js';

function reasoningText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';
  return raw.map(part => typeof part === 'string' ? part
    : part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '').join('');
}

/** Shared by streaming and complete; structured replay is independent of visible text. */
export class OpenAIReasoningAccumulator {
  text = '';
  private reasoning: string | undefined;
  private readonly details: Record<string, unknown>[] = [];

  append(message: unknown, streaming = false): string {
    if (!message || typeof message !== 'object') return '';
    const raw = message as Record<string, unknown>;
    const details = Array.isArray(raw.reasoning_details)
      ? raw.reasoning_details.filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object' && !Array.isArray(item)) : [];
    for (const [index, detail] of details.entries()) this.appendDetail(detail, streaming && index === 0);
    if (typeof raw.reasoning === 'string') this.reasoning = (this.reasoning ?? '') + raw.reasoning;
    const detailedText = details.map(detail => detail.type === 'reasoning.text' ? reasoningText(detail.text)
      : detail.type === 'reasoning.summary' ? reasoningText(detail.summary) : '').join('');
    // Gateways often emit both aliases and details for the same tokens.
    const delta = detailedText || reasoningText(raw.reasoning_content) || reasoningText(raw.reasoning);
    this.text += delta;
    return delta;
  }

  private appendDetail(detail: Record<string, unknown>, continuation: boolean): void {
    const previous = continuation ? this.details.at(-1) : undefined;
    const field = detail.type === 'reasoning.text' ? 'text'
      : detail.type === 'reasoning.summary' ? 'summary' : undefined;
    const sameIndex = typeof detail.index === 'number' && previous?.index === detail.index;
    const sameId = typeof detail.id === 'string' && previous?.id === detail.id;
    const conflictingMetadata = ['id', 'index', 'signature', 'format'].some(key =>
      detail[key] != null && previous?.[key] != null && detail[key] !== previous[key]);
    if (field && previous && previous.type === detail.type
      && !conflictingMetadata && (sameIndex || sameId)) {
      const text = reasoningText(previous[field]) + reasoningText(detail[field]);
      const merged = { ...previous, ...structuredClone(detail), [field]: text };
      for (const key of ['id', 'signature', 'format']) {
        if (detail[key] == null && previous[key] !== undefined) merged[key] = previous[key];
      }
      this.details[this.details.length - 1] = merged;
    } else {
      // Complete responses and unidentified/signed independent blocks retain their boundaries.
      // Encrypted items are opaque discrete blocks; never concatenate their data.
      this.details.push(structuredClone(detail));
    }
  }

  blocks(source: { provider: string; model: string; baseUrl?: string }): KodaXThinkingBlock[] {
    const hasReplay = this.reasoning !== undefined || this.details.length > 0;
    if (!this.text && !hasReplay) return [];
    return [{ type: 'thinking', thinking: this.text,
      ...(hasReplay ? { openaiReasoning: { ...source,
        ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
        ...(this.details.length > 0 ? { details: this.details } : {}),
      } } : {}),
    }];
  }
}
