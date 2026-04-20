/**
 * FEATURE_058 transcript native scrollback dump — pure serializer.
 *
 * Converts an array of `HistoryItem`s (the transcript view model) into a
 * plain-text blob suitable for writing to the terminal's native scrollback
 * buffer after exiting alternate-screen.
 *
 * Critical non-goals:
 *  - Do NOT replay ANSI control sequences (cursor moves, color sequences,
 *    clear-screen). They contain viewport-specific positioning that leaks
 *    into scrollback as visual garbage.
 *  - Do NOT include internal thinking items — they are not user-facing.
 *
 * Keep this file dependency-free (no React / Ink). It is a pure function
 * of its input, trivially unit-testable, and reusable by any surface that
 * needs a text representation of the transcript.
 */

import type {
  HistoryItem,
  HistoryItemToolGroup,
  ToolCall,
} from "../types.js";

/**
 * Strip ANSI escape sequences. Matches CSI sequences (ESC `[` … final byte
 * in `@-~` range), OSC sequences (ESC `]` … `ST`), and isolated
 * single-character ESC sequences. This is intentionally conservative and
 * does not try to interpret the sequences; the goal is to produce safe
 * plain text for scrollback, not to preserve any styling.
 */
function stripAnsi(text: string): string {
  // CSI: ESC [ ... final byte in 0x40-0x7E
  // OSC: ESC ] ... BEL or ST
  // Plus two-byte ESC sequences.
  // eslint-disable-next-line no-control-regex
  const csi = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
  // eslint-disable-next-line no-control-regex
  const osc = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
  // eslint-disable-next-line no-control-regex
  const esc = /\u001b[@-_]/g;
  return text.replace(csi, "").replace(osc, "").replace(esc, "");
}

function serializeToolGroup(item: HistoryItemToolGroup): string {
  const lines = item.tools.map((tool: ToolCall) => `tool: ${tool.name}`);
  return lines.join("\n");
}

function serializeOne(item: HistoryItem): string | null {
  switch (item.type) {
    case "thinking":
      // Internal reasoning; not user-facing.
      return null;
    case "user":
      return `user: ${stripAnsi(item.text)}`;
    case "assistant":
      return `assistant: ${stripAnsi(item.text)}`;
    case "system":
      return `system: ${stripAnsi(item.text)}`;
    case "info":
      return `info: ${stripAnsi(item.text)}`;
    case "error":
      return `error: ${stripAnsi(item.text)}`;
    case "event":
      return `event: ${stripAnsi(item.text)}`;
    case "hint":
      return `hint: ${stripAnsi(item.text)}`;
    case "tool_group":
      return serializeToolGroup(item);
    default: {
      // Exhaustiveness; if a new HistoryItem type is added without a case
      // here, TypeScript will flag it at compile time.
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

/**
 * Serialize transcript `items` into a plain-text blob ready for terminal
 * scrollback. Items are separated by a blank line so the output reads
 * naturally when scrolled back. Returns the empty string for empty input.
 */
export function serializeTranscriptForScrollback(
  items: readonly HistoryItem[],
): string {
  const blocks: string[] = [];
  for (const item of items) {
    const line = serializeOne(item);
    if (line !== null && line !== "") {
      blocks.push(line);
    }
  }
  return blocks.join("\n\n");
}

/**
 * Renderer-facing orchestration for the transcript dump:
 *  1. Exit the alternate-screen buffer (returning to the terminal's main
 *     screen with its native scrollback).
 *  2. Write the serialized transcript text.
 *  3. Re-enter the alternate-screen buffer so the fullscreen surface
 *     resumes unchanged.
 *
 * Separated from the pure serializer so it can be unit-tested with stub
 * callbacks without touching `process.stdout`.
 */
export interface DumpTranscriptToNativeScrollbackOptions {
  items: readonly HistoryItem[];
  writeToScrollback: (text: string) => void;
  exitAltScreen: () => void;
  enterAltScreen: () => void;
}

export function dumpTranscriptToNativeScrollback(
  options: DumpTranscriptToNativeScrollbackOptions,
): void {
  const { items, writeToScrollback, exitAltScreen, enterAltScreen } = options;
  const text = serializeTranscriptForScrollback(items);
  exitAltScreen();
  if (text.length > 0) {
    writeToScrollback(`${text}\n`);
  }
  enterAltScreen();
}
