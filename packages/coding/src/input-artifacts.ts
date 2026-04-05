import type {
  KodaXContentBlock,
  KodaXInputArtifact,
  KodaXMessage,
} from './types.js';

export function buildPromptMessageContent(
  prompt: string,
  inputArtifacts?: readonly KodaXInputArtifact[],
): string | KodaXContentBlock[] {
  if (!inputArtifacts || inputArtifacts.length === 0) {
    return prompt;
  }

  return [
    { type: 'text', text: prompt },
    ...inputArtifacts.flatMap<KodaXContentBlock>((artifact) => (
      artifact.kind === 'image'
        ? [{
          type: 'image',
          path: artifact.path,
          mediaType: artifact.mediaType,
        }]
        : []
    )),
  ];
}

export function extractPromptComparableText(
  content: string | readonly KodaXContentBlock[],
): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((block): block is Extract<KodaXContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export function extractComparableUserMessageText(
  message: KodaXMessage | undefined,
): string | undefined {
  if (!message || message.role !== 'user') {
    return undefined;
  }

  return extractPromptComparableText(message.content);
}
