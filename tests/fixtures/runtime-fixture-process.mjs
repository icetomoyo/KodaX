import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Own one fixture leaf process; retain bounded diagnostics on premature exit. */
export function startRuntimeFixtureProcess(url, args, signal) {
  signal.throwIfAborted();
  const child = fork(fileURLToPath(url), args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '', failure;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65_536); });
  child.on('error', error => { failure = error; });
  const abort = () => child.kill();
  signal.addEventListener('abort', abort, { once: true });
  const exited = new Promise(resolve => child.once('close', (code, exitSignal) => {
    signal.removeEventListener('abort', abort);
    resolve({ code, signal: exitSignal, stderr, failure });
  }));
  return {
    async message() {
      let listener;
      const received = new Promise(resolve => { listener = resolve; child.once('message', listener); });
      try {
        return await Promise.race([received, exited.then(outcome => {
          throw new Error(`Fixture exited before its message (${outcome.code ?? outcome.signal}): ${outcome.stderr}`, { cause: outcome.failure });
        })]);
      } finally { child.off('message', listener); }
    },
    waitForExit: () => exited,
    async stop() {
      if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
      return exited;
    },
  };
}
