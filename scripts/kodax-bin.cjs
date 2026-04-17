#!/usr/bin/env node
/**
 * KodaX bin entry — CJS shim.
 *
 * Purpose: set NODE_ENV=production BEFORE any ESM module is evaluated.
 * Background: when users invoke `kodax` via `npm link` / global install,
 * node runs this bin directly without the --require preload used by
 * `npm run dev` / `npm run start`. ESM static imports are hoisted and
 * evaluated before module-body code runs, so setting NODE_ENV inside
 * `src/kodax_cli.ts` is too late — React would already have loaded its
 * development reconciler, leaking ~100 MB/turn of profiling objects.
 *
 * This CJS file runs synchronously first, requires the env preload,
 * then dynamic-imports the compiled ESM entry.
 *
 * Opt back into development by setting KODAX_DEV=1.
 */
'use strict';

require('./production-env.cjs');

import('../dist/kodax_cli.js').catch((err) => {
  // Surface unexpected errors with a full stack — this path should be rare.
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
