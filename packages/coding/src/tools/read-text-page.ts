import fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { READ_MAX_LINE_CHARS } from './truncate.js';

export interface ReadLineContinuation {
  readonly lineNumber: number;
  readonly start: number;
  readonly end: number;
  /** Unknown when scanning stops at the page boundary. */
  readonly total?: number;
  readonly nextOffset: number;
}

interface TextPage {
  readonly lines: string[];
  readonly totalLines: number;
  readonly hasMoreLines: boolean;
  readonly lineContinuation?: ReadLineContinuation;
  readonly error?: string;
}

/** Keep memory proportional to the displayed page, including when skipping giant lines. */
export async function readTextFilePage(input: {
  readonly filePath: string;
  readonly offset: number;
  readonly lineOffset: number;
  readonly limit: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}): Promise<TextPage> {
  input.signal?.throwIfAborted();
  const handle = await fs.open(input.filePath, 'r');
  try {
    const initial = await handle.stat();
    // Fix the read end on the opened handle: an appended log cannot extend this call.
    async function* chunks(): AsyncGenerator<string> {
      const buffer = Buffer.alloc(64 * 1024);
      const decoder = new StringDecoder('utf8');
      for (let position = 0; position < initial.size;) {
        input.signal?.throwIfAborted();
        const { bytesRead } = await handle.read({ buffer, offset: 0,
          length: Math.min(buffer.length, initial.size - position), position });
        input.signal?.throwIfAborted();
        if (bytesRead === 0) break;
        position += bytesRead;
        yield decoder.write(buffer.subarray(0, bytesRead));
      }
      yield decoder.end();
    }

    const lines: string[] = [];
    let lineNumber = 1;
    let characters = 0;
    let visible = '';
    let visibleCharacters = 0;
    let outputBytes = 0;
    let skipLf = false;
    let totalLines = 0;
    const result = (hasMoreLines: boolean, lineContinuation?: ReadLineContinuation, error?: string): TextPage => ({
      lines, totalLines, hasMoreLines,
      ...(lineContinuation ? { lineContinuation } : {}), ...(error ? { error } : {}),
    });
    const finishLine = (): TextPage | undefined => {
      totalLines = lineNumber;
      if (lineNumber >= input.offset) {
        const start = lineNumber === input.offset ? input.lineOffset : 0;
        if (start > characters) return result(false, undefined,
          `[Tool Error] line_offset ${start} is beyond end of line ${lineNumber} (${characters} Unicode characters total)`);
        const bytes = Buffer.byteLength(`${lineNumber.toString().padStart(6)}\t${visible}`, 'utf8')
          + (lines.length > 0 ? 1 : 0);
        if (outputBytes + bytes > input.maxBytes) return result(true);
        lines.push(visible);
        outputBytes += bytes;
      }
      lineNumber++;
      characters = 0;
      visible = '';
      visibleCharacters = 0;
      return undefined;
    };
    const scan = async (): Promise<TextPage> => {
      for await (const chunk of chunks()) {
        input.signal?.throwIfAborted();
        for (const character of chunk) {
          if (skipLf) {
            skipLf = false;
            if (character === '\n') continue;
          }
          // Only one character of lookahead, never the complete next line.
          if (lines.length >= input.limit) return result(true);
          if (character === '\r' || character === '\n') {
            const finished = finishLine();
            if (finished) return finished;
            skipLf = character === '\r';
            continue;
          }
          const start = lineNumber === input.offset ? input.lineOffset : 0;
          if (lineNumber >= input.offset && characters >= start) {
            if (visibleCharacters === READ_MAX_LINE_CHARS) {
              const finished = finishLine();
              if (finished) return finished;
              return result(true, {
                lineNumber: lineNumber - 1, start, end: start + READ_MAX_LINE_CHARS - 1,
                nextOffset: start + READ_MAX_LINE_CHARS,
              });
            }
            visible += character;
            visibleCharacters++;
          }
          characters++;
        }
      }
      if (characters > 0) {
        const finished = finishLine();
        if (finished) return finished;
      }
      return result(false);
    };
    const page = await scan();
    input.signal?.throwIfAborted();
    const current = await handle.stat();
    const atPath = await fs.stat(input.filePath);
    input.signal?.throwIfAborted();
    if (current.size !== initial.size || current.mtimeMs !== initial.mtimeMs
      || atPath.dev !== initial.dev || atPath.ino !== initial.ino) {
      return { lines: [], totalLines: 0, hasMoreLines: false,
        error: '[Tool Error] File changed while reading. Retry the requested range from the current file.' };
    }
    return page;
  } finally {
    await handle.close();
  }
}
