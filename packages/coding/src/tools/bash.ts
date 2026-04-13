import { spawn } from 'child_process';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import iconv from 'iconv-lite';
import { KODAX_DEFAULT_TIMEOUT, KODAX_HARD_TIMEOUT } from '../constants.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionCwd } from '../runtime-paths.js';
import {
  BASH_CAPTURE_LIMIT_BYTES,
  formatSize,
  trimBufferStartToUtf8Boundary,
  truncateTail,
} from './truncate.js';

type TailCollector = {
  chunks: Buffer[];
  keptBytes: number;
  totalBytes: number;
  droppedBytes: number;
};

function createCollector(): TailCollector {
  return {
    chunks: [],
    keptBytes: 0,
    totalBytes: 0,
    droppedBytes: 0,
  };
}

function appendTailChunk(collector: TailCollector, chunk: Buffer, maxBytes: number): void {
  collector.totalBytes += chunk.length;
  collector.keptBytes += chunk.length;
  collector.chunks.push(chunk);

  while (collector.keptBytes > maxBytes && collector.chunks.length > 0) {
    const overflow = collector.keptBytes - maxBytes;
    const first = collector.chunks[0]!;
    if (overflow >= first.length) {
      collector.chunks.shift();
      collector.keptBytes -= first.length;
      collector.droppedBytes += first.length;
      continue;
    }

    const trimmed = trimBufferStartToUtf8Boundary(first, overflow);
    const removedBytes = first.length - trimmed.length;
    if (trimmed.length === 0) {
      collector.chunks.shift();
    } else {
      collector.chunks[0] = trimmed;
    }
    collector.keptBytes -= removedBytes;
    collector.droppedBytes += removedBytes;
    break;
  }
}

function decodeCollector(collector: TailCollector): string {
  const buffer = Buffer.concat(collector.chunks);
  if (buffer.length === 0) {
    return '';
  }

  if (process.platform === 'win32') {
    try {
      const text = buffer.toString('utf-8');
      if (!/[\uFFFD]/.test(text)) {
        return text;
      }
    } catch {
      // Fall through to GBK decoding on Windows.
    }
    return iconv.decode(buffer, 'gbk');
  }

  return buffer.toString('utf-8');
}

function buildBashTruncationHint(command: string): string {
  const normalized = command.trim().toLowerCase();
  if (/^git\s+(diff|show)\b/.test(normalized)) {
    return '[Bash output truncated to the tail. For large reviews, prefer changed_scope first and then changed_diff slices per file instead of broad git diff/show output.]';
  }
  return '[Bash output truncated to the tail. Narrow the command or redirect output to a file if you need more context.]';
}

export async function toolBash(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const command = input.command as string;
  const userTimeout = input.timeout as number | undefined;
  const timeout = userTimeout ? Math.min(KODAX_HARD_TIMEOUT, userTimeout) : KODAX_DEFAULT_TIMEOUT;
  const capped = userTimeout && userTimeout > KODAX_HARD_TIMEOUT;
  const runInBackground = (input.run_in_background as boolean) ?? false;
  const cwd = resolveExecutionCwd(ctx);

  if (runInBackground) {
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outputFile = pathJoin(tmpdir(), `kodax-bg-${jobId}.log`);
    const logStream = createWriteStream(outputFile);
    logStream.on('error', () => {
      // Silently handle write stream errors (disk full, permissions, etc.)
      // The background job output is best-effort; the user can re-run if needed.
    });

    const proc = spawn(command, [], { shell: true, windowsHide: true, cwd });

    proc.stdout?.pipe(logStream, { end: false });
    proc.stderr?.pipe(logStream, { end: false });
    proc.on('close', (code) => {
      if (!logStream.destroyed) {
        logStream.write(`\n[Exit: ${code}]\n`);
        logStream.end();
      }
    });
    proc.on('error', (err) => {
      if (!logStream.destroyed) {
        logStream.write(`\n[Error: ${err.message}]\n`);
        logStream.end();
      }
    });

    return `Command started in background.\nPID: ${proc.pid}\nOutput: ${outputFile}\n\nUse the read tool to check output when done.`;
  }

  return new Promise(resolve => {
    const proc = spawn(command, [], { shell: true, windowsHide: true, cwd });
    const stdout = createCollector();
    const stderr = createCollector();
    let settled = false;

    const settle = (result: string) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      proc.kill();
      const partialStdout = decodeCollector(stdout);
      const partialStderr = decodeCollector(stderr);
      let partial = partialStdout;
      if (partialStderr) {
        partial += `${partial ? '\n' : ''}[stderr]\n${partialStderr}`;
      }
      const timeoutPreview = partial
        ? truncateTail(partial, { maxLines: 400, maxBytes: 24 * 1024 }).content
        : '';
      const captureNotes = [];
      if (stdout.droppedBytes > 0) {
        captureNotes.push(`stdout omitted ${formatSize(stdout.droppedBytes)}`);
      }
      if (stderr.droppedBytes > 0) {
        captureNotes.push(`stderr omitted ${formatSize(stderr.droppedBytes)}`);
      }
      const captureNote = captureNotes.length > 0
        ? `\n[Output capture capped; ${captureNotes.join('; ')}.]`
        : '';
      settle(`Command: ${command}\n[Timeout] Command interrupted after ${timeout}s${captureNote}\n\nPartial output (tail):\n${timeoutPreview}\n\n[Suggestion] The command took too long. Consider:\n- Is this a watch/dev server? Run in a separate terminal.\n- Can the task be broken into smaller steps?\n- Is there an error causing it to hang?`);
    }, timeout * 1000);

    // Issue 113: Kill child process when abort signal fires (Ctrl+C).
    const abortSignal = ctx.abortSignal;
    if (abortSignal) {
      if (abortSignal.aborted) {
        proc.kill();
        clearTimeout(timer);
        settle(`[Cancelled] Operation cancelled by user`);
      } else {
        const onAbort = () => {
          proc.kill();
          clearTimeout(timer);
          settle(`[Cancelled] Operation cancelled by user`);
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
        // Clean up listener when process exits naturally to avoid leak.
        const cleanupAbortListener = () => abortSignal.removeEventListener('abort', onAbort);
        proc.once('close', cleanupAbortListener);
        proc.once('error', cleanupAbortListener);
      }
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      appendTailChunk(stdout, chunk, BASH_CAPTURE_LIMIT_BYTES);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      appendTailChunk(stderr, chunk, BASH_CAPTURE_LIMIT_BYTES);
    });
    proc.on('close', code => {
      clearTimeout(timer);
      const stdoutText = decodeCollector(stdout);
      const stderrText = decodeCollector(stderr);

      let out = `Command: ${command}\nExit: ${code}\n${stdoutText}`;
      if (stdout.droppedBytes > 0) {
        out += `\n[stdout capture capped: earlier ${formatSize(stdout.droppedBytes)} omitted]`;
      }
      if (stderrText) {
        out += `\n[stderr]\n${stderrText}`;
      }
      if (stderr.droppedBytes > 0) {
        out += `\n[stderr capture capped: earlier ${formatSize(stderr.droppedBytes)} omitted]`;
      }
      if (capped) {
        out += `\n[Note] Timeout capped at ${KODAX_HARD_TIMEOUT}s`;
      }

      const preview = truncateTail(out, { maxLines: 600, maxBytes: 32 * 1024 });
      if (!preview.truncated) {
        settle(out);
        return;
      }

      const captureNotes = [];
      if (stdout.totalBytes > stdout.keptBytes) {
        captureNotes.push(`stdout kept last ${formatSize(stdout.keptBytes)} of ${formatSize(stdout.totalBytes)}`);
      }
      if (stderr.totalBytes > stderr.keptBytes) {
        captureNotes.push(`stderr kept last ${formatSize(stderr.keptBytes)} of ${formatSize(stderr.totalBytes)}`);
      }
      const hint = buildBashTruncationHint(command);
      const note = captureNotes.length > 0
        ? `\n\n${hint.replace(/\]$/, ` ${captureNotes.join('; ')}.]`)}`
        : `\n\n${hint}`;
      settle(`${preview.content}${note}`);
    });
    proc.on('error', error => {
      clearTimeout(timer);
      settle(`Command: ${command}\n[Error] ${error.message}`);
    });
  });
}
