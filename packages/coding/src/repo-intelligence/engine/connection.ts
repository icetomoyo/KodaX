/**
 * One running RepoIntel engine process and the JSON-RPC connection to it,
 * framed with Content-Length headers the way LSP frames it, over stdio.
 */

import { spawn } from 'node:child_process';
import { killChildProcessTree, registerManagedChildProcess } from '@kodax-ai/agent';

export interface RepoIntelEngineLaunch {
  readonly command: string;
  readonly args?: readonly string[];
}

export interface RepoIntelEngineConnection {
  readonly pid: number | undefined;
  /** Settles once the process has gone, saying how it ended. */
  readonly exited: Promise<string>;
  /** Without params the request carries none; vscode-jsonrpc would send `null` as `[null]`. */
  request<T>(method: string, params: object | undefined, timeoutMs: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  /** Asks the engine to shut down, and kills it if it has not gone within `graceMs`. */
  stop(graceMs: number): Promise<void>;
  kill(): Promise<void>;
}

function watchExit(proc: ReturnType<typeof spawn>, onExit: () => void): Promise<string> {
  return new Promise(resolve => {
    proc.once('error', error => {
      onExit();
      resolve(`cannot start: ${error.message}`);
    });
    proc.once('close', (code, signal) => {
      onExit();
      resolve(signal ? `was stopped by ${signal}` : `exited with code ${code}`);
    });
  });
}

function withTimeout<T>(work: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer to ${label} within ${timeoutMs} ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A request that also fails as soon as the engine has gone. */
function answer<T>(send: () => Promise<T>, exited: Promise<string>, label: string, timeoutMs: number): Promise<T> {
  const gone = exited.then(reason => { throw new Error(`the engine ${reason}`); });
  return withTimeout(Promise.race([Promise.resolve().then(send), gone]), label, timeoutMs);
}

/** Starts the engine. Failing to start shows up in `exited` and in the first request. */
export async function connectRepoIntelEngine(
  launch: RepoIntelEngineLaunch,
  onStderr?: (line: string) => void,
): Promise<RepoIntelEngineConnection> {
  const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = await import('vscode-languageserver-protocol/node');
  const args = [...(launch.args ?? [])];
  const proc = spawn(launch.command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const unregister = registerManagedChildProcess(proc, { kind: 'repo-intel', command: launch.command, args }, { manualUnregister: true });
  const exited = watchExit(proc, unregister);
  proc.stderr.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) onStderr?.(line.trim());
  });
  // A write to a dead process rejects inside vscode-jsonrpc where nothing
  // awaits it; the exit is reported through `exited` instead.
  const rawWriter = new StreamMessageWriter(proc.stdin);
  const writer = {
    onError: rawWriter.onError,
    onClose: rawWriter.onClose,
    dispose: (): void => rawWriter.dispose(),
    end: (): void => rawWriter.end(),
    write: (message: Parameters<typeof rawWriter.write>[0]): Promise<void> =>
      rawWriter.write(message).catch((error: unknown) => onStderr?.(`cannot write to the engine: ${String(error)}`)),
  };
  const connection = createMessageConnection(new StreamMessageReader(proc.stdout), writer);
  connection.listen();
  void exited.then(() => connection.dispose());
  const kill = async (): Promise<void> => { await killChildProcessTree(proc); };
  const report = (error: unknown): void => onStderr?.(`cannot notify the engine: ${error instanceof Error ? error.message : String(error)}`);
  return {
    pid: proc.pid,
    exited,
    request: <T>(method: string, params: unknown, timeoutMs: number) =>
      answer(() => (params === undefined ? connection.sendRequest<T>(method) : connection.sendRequest<T>(method, params)),
        exited, method, timeoutMs),
    notify(method, params) {
      // A closed connection throws at once; a failed write rejects later.
      Promise.resolve()
        .then(() => (params === undefined ? connection.sendNotification(method) : connection.sendNotification(method, params)))
        .catch(report);
    },
    async stop(graceMs) {
      try {
        await answer(() => connection.sendRequest<unknown>('shutdown'), exited, 'shutdown', graceMs);
        await connection.sendNotification('exit');
        await withTimeout(exited, 'exit', graceMs);
      } catch (error: unknown) {
        onStderr?.(`the engine did not stop cleanly (${error instanceof Error ? error.message : String(error)}); killing it`);
        await kill();
      }
    },
    kill,
  };
}
