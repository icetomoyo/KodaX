import type { ClientStartupProgress } from '@kodax-ai/coding/client-contract';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export function cliStartupProgressMessage(progress: ClientStartupProgress): string {
  switch (progress.stage) {
    case 'checking': return 'Checking KodaX';
    case 'starting': return 'Starting KodaX';
    case 'upgrading': return 'Updating KodaX';
    case 'connecting': return 'Connecting to KodaX';
    case 'ready': return 'Connected to KodaX';
    case 'waiting':
      switch (progress.reason) {
        case 'connected_clients': return 'Waiting for other clients to disconnect';
        case 'host_starting': return 'Waiting for KodaX to start';
        case 'host_stopping': return 'Waiting for previous KodaX to exit';
      }
  }
}

export interface CliStartupProgress {
  update(message: string): void;
  stop(): void;
}

export function createCliStartupProgress(message: string): CliStartupProgress {
  const startedAt = Date.now();
  let frame = 0;
  let stopped = false;
  const paint = (): void => {
    const seconds = Math.floor((Date.now() - startedAt) / 1_000);
    process.stderr.write(`\r\u001B[2K${FRAMES[frame % FRAMES.length]} ${message} (${seconds}s)...`);
    frame += 1;
  };
  paint();
  const timer = setInterval(paint, 120);
  timer.unref();
  return {
    update(nextMessage) {
      if (stopped) return;
      message = nextMessage;
      paint();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.stderr.write('\r\u001B[2K');
    },
  };
}

export function isInteractiveCliStartup(args: readonly string[]): boolean {
  return process.stdin.isTTY === true
    && process.stdout.isTTY === true
    && process.stderr.isTTY === true
    && (args.length === 0
      || (args.length === 1 && (args[0] === '-c' || args[0] === '--continue'))
      || (args.length === 2 && (args[0] === '-r' || args[0] === '--resume')));
}
