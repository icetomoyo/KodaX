/**
 * One UAC consent for the whole Windows sandbox setup.
 *
 * The native helper's `__elevated-setup` asks for consent once and starts an
 * elevated session that connects back to a named pipe served here. Setup then
 * sends its elevated steps (`srt-win install`/`uninstall`, account
 * capabilities) over that pipe. Waiting for consent is timed separately from
 * the steps, so a prompt that only flashes in the taskbar can still be
 * approved minutes later. A prompt approved after the wait gave up finds no
 * pipe and the session exits without doing anything.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

/** Stable failure codes for sandbox setup; embedders branch on these. */
export type SandboxSetupErrorCode =
  | 'setup_lock_busy'
  | 'idle_probe_failed'
  | 'sandbox_account_busy'
  | 'elevation_timeout'
  | 'elevation_cancelled'
  | 'elevated_step_failed'
  | 'native_artifact_unavailable'
  | 'setup_failed';

export class SandboxSetupError extends Error {
  constructor(
    readonly code: SandboxSetupErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'SandboxSetupError';
  }
}

/** Setup progress that a host can show while setup blocks. */
export type SandboxSetupPhase = 'waiting-for-other-setup' | 'awaiting-elevation' | 'elevated';

export type WindowsElevatedRequest =
  | { readonly op: 'srt-win'; readonly args: readonly string[] }
  | { readonly op: 'account-capabilities'; readonly envelope: string };

export interface WindowsElevatedReply {
  readonly exitCode: number;
  readonly output: string;
}

export interface WindowsElevatedSession {
  request(request: WindowsElevatedRequest, timeoutMs: number): Promise<WindowsElevatedReply>;
  close(): Promise<void>;
}

export interface WindowsElevatedSessionOptions {
  /** The KodaX native helper (`kodax-windows-sandbox.exe`) and any leading arguments. */
  readonly helper: { readonly command: string; readonly args?: readonly string[] };
  /** The hash-pinned srt-win runner the elevated session may run. */
  readonly srtWin: {
    readonly exe: string;
    readonly prependArgs: readonly string[];
    readonly sha256: string;
  };
  readonly elevationTimeoutMs: number;
  readonly onPhase?: (phase: SandboxSetupPhase) => void;
}

/** Matches the helper's exit code when the user dismisses the UAC prompt. */
const EXIT_ELEVATION_CANCELLED = 10;
const CLOSE_GRACE_MS = 10_000;
const MAX_REPLY_BYTES = 64 * 1024;

export async function openWindowsElevatedSession(
  options: WindowsElevatedSessionOptions,
): Promise<WindowsElevatedSession> {
  const pipe = `\\\\.\\pipe\\kodax-elevated-setup-${randomUUID()}`;
  const server = createServer();
  server.maxConnections = 1;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { srtWin } = options;
  const launcher = spawn(options.helper.command, [
    ...(options.helper.args ?? []),
    '__elevated-setup', pipe, String(process.pid), srtWin.exe, srtWin.sha256,
    ...(srtWin.prependArgs.length > 0 ? ['--', ...srtWin.prependArgs] : []),
  ], { shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  launcher.stderr?.setEncoding('utf8');
  launcher.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4_096);
  });
  options.onPhase?.('awaiting-elevation');
  let socket: Socket;
  try {
    socket = await awaitElevatedConnection(server, launcher, options.elevationTimeoutMs, () => stderr);
  } catch (error: unknown) {
    if (launcher.exitCode === null) launcher.kill();
    throw error;
  } finally {
    // Stop accepting connections; the accepted session stays open.
    server.close();
  }
  options.onPhase?.('elevated');
  return createSession(socket, launcher);
}

function awaitElevatedConnection(
  server: Server,
  launcher: ChildProcess,
  timeoutMs: number,
  stderr: () => string,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const settle = (action: () => void): void => {
      clearTimeout(timer);
      server.off('connection', onConnection);
      launcher.off('error', onError);
      launcher.off('exit', onExit);
      action();
    };
    const onConnection = (socket: Socket): void => settle(() => resolve(socket));
    const onError = (error: Error): void => settle(() => reject(new SandboxSetupError(
      'native_artifact_unavailable',
      `The KodaX native helper could not start the elevated setup: ${error.message}`,
      { cause: error },
    )));
    const onExit = (code: number | null): void => settle(() => reject(
      code === EXIT_ELEVATION_CANCELLED
        ? new SandboxSetupError('elevation_cancelled', 'Sandbox setup was cancelled at the UAC prompt.')
        : new SandboxSetupError(
          'elevated_step_failed',
          `The elevated setup session ended before connecting (exit ${String(code)}): ${stderr().trim()}`,
        ),
    ));
    const timer = setTimeout(() => settle(() => reject(new SandboxSetupError(
      'elevation_timeout',
      `The UAC prompt was not approved within ${Math.round(timeoutMs / 60_000)} minutes. `
      + 'If it only flashed in the taskbar, run setup again and approve it there.',
    ))), timeoutMs);
    server.on('connection', onConnection);
    launcher.once('error', onError);
    launcher.once('exit', onExit);
  });
}

function createSession(socket: Socket, launcher: ChildProcess): WindowsElevatedSession {
  let buffered = '';
  let pending: {
    readonly resolve: (reply: WindowsElevatedReply) => void;
    readonly reject: (error: Error) => void;
  } | undefined;
  let ended: Error | undefined;
  const fail = (error: Error): void => {
    ended ??= error;
    const waiting = pending;
    pending = undefined;
    waiting?.reject(ended);
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    const newline = buffered.indexOf('\n');
    if (newline < 0) {
      if (buffered.length > MAX_REPLY_BYTES) {
        fail(stepError('The elevated setup session sent an oversized reply.'));
        socket.destroy();
      }
      return;
    }
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    const waiting = pending;
    pending = undefined;
    try {
      waiting?.resolve(parseReply(line));
    } catch (error: unknown) {
      waiting?.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.on('error', (error) => fail(stepError(`The elevated setup session failed: ${error.message}`)));
  socket.on('close', () => fail(stepError('The elevated setup session ended unexpectedly.')));

  const request = (
    payload: WindowsElevatedRequest,
    timeoutMs: number,
  ): Promise<WindowsElevatedReply> => {
    if (ended !== undefined) return Promise.reject(ended);
    if (pending !== undefined) return Promise.reject(stepError('An elevated setup step is already running.'));
    return new Promise<WindowsElevatedReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(stepError(`The elevated setup step "${describe(payload)}" did not finish within ${Math.round(timeoutMs / 1_000)} s.`));
        socket.destroy();
      }, timeoutMs);
      pending = {
        resolve: (reply) => { clearTimeout(timer); resolve(reply); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      socket.write(`${JSON.stringify(payload)}\n`);
    });
  };

  const close = async (): Promise<void> => {
    if (ended === undefined) {
      ended = stepError('The elevated setup session is closed.');
      socket.end(`${JSON.stringify({ op: 'exit' })}\n`);
    }
    if (launcher.exitCode !== null || launcher.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => launcher.once('exit', () => resolve()));
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), CLOSE_GRACE_MS);
    });
    const outcome = await Promise.race([exited, grace]);
    clearTimeout(timer);
    if (outcome === 'timeout') launcher.kill();
  };

  return { request, close };
}

function parseReply(line: string): WindowsElevatedReply {
  const value: unknown = JSON.parse(line);
  if (
    typeof value !== 'object' || value === null
    || !('exitCode' in value) || typeof value.exitCode !== 'number'
    || !('output' in value) || typeof value.output !== 'string'
  ) {
    throw stepError('The elevated setup session sent a malformed reply.');
  }
  return { exitCode: value.exitCode, output: value.output };
}

function describe(request: WindowsElevatedRequest): string {
  return request.op === 'srt-win' ? `srt-win ${request.args[0] ?? ''}` : request.op;
}

function stepError(message: string): SandboxSetupError {
  return new SandboxSetupError('elevated_step_failed', message);
}
