import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let binding;
try {
  binding = require(process.platform === 'win32'
    ? './kodax-windows-text-transaction.node'
    : './kodax-text-transaction.node');
} catch (cause) {
  throw new Error(
    'The KodaX trusted text transaction native binding is unavailable; no sandbox fallback is permitted.',
    { cause },
  );
}

const protocol = binding.textTransactionProtocol();
if (protocol !== 4) {
  throw new Error(`Unsupported KodaX trusted text transaction protocol: ${protocol}`);
}

export const { TrustedTextTransactionRoot } = binding;
export const textTransactionProtocol = protocol;
