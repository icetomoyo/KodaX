/**
 * FEATURE_298 T18 — console display for plane-bound classic rounds.
 *
 * Classic has no React tree; its display authority in plane mode is the
 * live Host session view. This differ prints, per view push: new items
 * once, assistant suffixes as the trailing item streams, and tool
 * lifecycle lines per stage. The first (baseline) view only primes the
 * tracking so restored history does not reprint.
 */
import type {
  ClientSessionView,
  ClientViewItem,
} from '@kodax-ai/coding/client-contract';
import {
  answerClientPlaneInteraction,
  type ClientPlaneDialogSurface,
  type InkClientPlane,
} from '../ui/client-plane.js';

type WriteLine = (line: string) => void;

const THINKING_PREVIEW_LENGTH = 100;

function thinkingPreview(text: string): string {
  const singleLine = text.replace(/\n/g, ' ');
  return singleLine.length > THINKING_PREVIEW_LENGTH
    ? `${singleLine.slice(0, THINKING_PREVIEW_LENGTH)}...`
    : singleLine;
}

/**
 * Pure differ; the tests drive it directly. `write` receives one formatted
 * line per change (`kind:text`), the caller owns chalk styling.
 */
export function createClassicPlaneDisplayDiffer(write: WriteLine) {
  let baselined = false;
  const printedText = new Map<string, number>();
  const printedToolStages = new Set<string>();

  const printOnce = (item: ClientViewItem, line: string): void => {
    write(line);
    printedText.set(item.id, item.text.length);
  };

  return (items: readonly ClientViewItem[]): void => {
    if (!baselined) {
      baselined = true;
      for (const item of items) {
        printedText.set(item.id, item.text.length);
        if (item.type === 'tool') printedToolStages.add(`${item.id}:start`);
      }
      return;
    }
    for (const item of items) {
      if (item.type === 'assistant') {
        const previous = printedText.get(item.id) ?? 0;
        if (item.text.length > previous) {
          write(`assistant:${item.text.slice(previous)}`);
          printedText.set(item.id, item.text.length);
        }
        continue;
      }
      if (item.type === 'tool' && item.tool) {
        if (item.tool.status === 'running') {
          if (!printedToolStages.has(`${item.id}:start`)) {
            printedToolStages.add(`${item.id}:start`);
            printOnce(item, `tool:▶ ${item.tool.name} ${item.tool.inputText ?? ''}`.trimEnd());
          }
          continue;
        }
        printedToolStages.add(`${item.id}:start`);
        if (!printedToolStages.has(`${item.id}:done`)) {
          printedToolStages.add(`${item.id}:done`);
          const mark = item.tool.status === 'error' ? '✗' : '✓';
          printOnce(item, `tool:${mark} ${item.tool.name} ${item.text}`.trimEnd());
        }
        continue;
      }
      if (printedText.has(item.id)) continue;
      if (item.type === 'thinking') {
        printOnce(item, `thinking:[Thinking] ${thinkingPreview(item.text)}`);
        continue;
      }
      if (item.type === 'user') {
        // The readline echo already showed the user's input.
        printedText.set(item.id, item.text.length);
        continue;
      }
      printOnce(item, `${item.type}:${item.text}`);
    }
  };
}

/**
 * Subscribe the console differ (and, when dialogs are provided, the
 * interaction answerer) to the live session view; resolves with the stop
 * function. Dialog answering is serialized - one readline dialog at a
 * time - and a late answer to a remotely-resolved interaction simply
 * resolves as not accepted.
 */
export async function attachClassicPlaneDisplay(
  plane: InkClientPlane,
  sessionId: string,
  options: {
    write?: WriteLine;
    dialogs?: ClientPlaneDialogSurface;
    onNotice?: (text: string) => void;
  } = {},
): Promise<() => void> {
  const differ = createClassicPlaneDisplayDiffer(
    options.write ?? ((line) => process.stdout.write(`${line}\n`)),
  );
  const handledInteractions = new Set<string>();
  let dialogChain: Promise<void> = Promise.resolve();
  const observation = await plane.observe(sessionId, (view: ClientSessionView) => {
    differ(view.items);
    const dialogs = options.dialogs;
    if (dialogs === undefined) return;
    for (const interaction of view.interactions) {
      if (handledInteractions.has(interaction.requestId)) continue;
      handledInteractions.add(interaction.requestId);
      dialogChain = dialogChain
        .then(() => answerClientPlaneInteraction(plane, interaction, dialogs))
        .then((accepted) => {
          if (accepted) return;
          handledInteractions.delete(interaction.requestId);
        })
        .catch((error: unknown) => {
          handledInteractions.delete(interaction.requestId);
          options.onNotice?.(
            `Answer delivery failed (${error instanceof Error ? error.message : String(error)}); the question re-opens or resolves Host-side.`,
          );
        });
    }
  });
  return observation;
}
