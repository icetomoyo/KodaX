import {
  runInkInteractiveMode as runRawInkInteractiveMode,
  runInteractiveMode as runRawInteractiveMode,
  type InkREPLOptions,
  type RepLOptions,
} from '@kodax-ai/repl';
import { withTrustedTextMutationHost } from './trusted-coding-entry.js';

/** KodaX-owned classic REPL entry with the native trusted-text authority bound. */
export function runInteractiveMode(options: RepLOptions): Promise<void> {
  return runRawInteractiveMode(withTrustedTextMutationHost(options));
}

/** KodaX-owned Ink REPL entry with the native trusted-text authority bound. */
export function runInkInteractiveMode(options: InkREPLOptions): Promise<void> {
  return runRawInkInteractiveMode(withTrustedTextMutationHost(options));
}
