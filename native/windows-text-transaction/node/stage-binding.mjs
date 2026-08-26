import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const profile = process.argv[2] === 'release' ? 'release' : 'debug';
await copyFile(
  join(
    here,
    '..',
    'target',
    profile,
    process.platform === 'win32'
      ? 'kodax_windows_text_transaction.dll'
      : process.platform === 'darwin'
        ? 'libkodax_windows_text_transaction.dylib'
        : 'libkodax_windows_text_transaction.so',
  ),
  join(
    here,
    process.platform === 'win32'
      ? 'kodax-windows-text-transaction.node'
      : 'kodax-text-transaction.node',
  ),
);
