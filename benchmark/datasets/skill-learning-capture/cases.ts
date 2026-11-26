/**
 * Skill learning capture eval: does note-only reflection still keep what a later session needs?
 *
 * Each case is one long, realistic session that the reflection job reads as evidence after it
 * ends: noise, side requests, abandoned dead ends, retries with a real cause, and lessons spread
 * across the session instead of summarised at the end. `facts` are the lessons a later session
 * needs, `order` the order-critical steps of a procedure, `traps` what must not be stored.
 * See docs/designs/skill-learning-capture-eval.md.
 *
 * Case data only. Editing anything here changes the case hash the runner records.
 */
import type { KodaXMessage } from '@kodax-ai/llm';

import { assistantCall, assistantText, toolResult, user } from '../feature-308-baseline/cases.js';

export interface Fact {
  /** Short name for reviewers. */
  readonly label: string;
  /** Matches stored note or skill text that carries this lesson. Case-insensitive, tolerant of paraphrase: match the distinctive token (command, flag, env var, path), not a sentence. */
  readonly pattern: RegExp;
}

export interface CaptureCase {
  readonly id: 'k1' | 'k2' | 'k3' | 'k4' | 'k5' | 'k6';
  readonly lang: 'EN' | 'ZH';
  /** One line for reviewers: what kind of session this is and where its lessons hide. */
  readonly shape: string;
  readonly session: readonly KodaXMessage[];
  /** Lessons a later session in this project needs and could not easily recover from the repo. */
  readonly facts: readonly Fact[];
  /** Procedure steps whose order matters, in the right order; empty when the case has no procedure. */
  readonly order: readonly RegExp[];
  /** Things that must NOT be stored: a transient failure's workaround, one-off task specifics, wrong conclusions. */
  readonly traps: readonly Fact[];
}

// ---------------------------------------------------------------- helpers

function failed(id: string, content: string): KodaXMessage {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: true }] };
}

/** A bash call and its result, in the shape the KodaX bash tool returns (`Exit: N` marks a failure). */
function bash(text: string, id: string, command: string, exit: number, stdout: string, stderr = ''): KodaXMessage[] {
  const body = `Command: ${command}\nExit: ${exit}\n${stdout}${stderr.length > 0 ? `\n[stderr]\n${stderr}` : ''}`;
  return [assistantCall(text, id, 'bash', { command }), toolResult(id, body)];
}

/** Any other tool call with its result. */
function call(text: string, id: string, name: string, input: Record<string, unknown>, result: string): KodaXMessage[] {
  return [assistantCall(text, id, name, input), toolResult(id, result)];
}

const rows = (...items: readonly string[]): string => items.join('\n');
/** Deterministic filler: `count` lines made by `line(index)`. */
const lines = (count: number, line: (index: number) => string): string => Array.from({ length: count }, (_, index) => line(index)).join('\n');
const pick = <T>(items: readonly T[], index: number): T => items[index % items.length]!;
const hex = (seed: number): string => ((seed * 2654435761) >>> 0).toString(16).padStart(8, '0').slice(0, 6);
const ms = (seed: number, max: number): number => 3 + ((seed * 7919) % max);

// ---------------------------------------------------------------- k1

const K1 = '/work/ledgerline';

const K1_RELEASING = rows(
  '# Releasing ledgerline',
  '',
  '_Last updated: 2025-10-02 (dana)_',
  '',
  '1. Make sure `main` is green in CI.',
  '2. `npm version minor` (or `patch` for hotfixes).',
  '3. `npm run build`',
  '4. `npm run deploy:prod` - runs pending migrations, then rolls api-1..api-3 one at a time.',
  '5. `git push --follow-tags`',
  '',
  'If the deploy fails it rolls back on its own. Ping #ops if it does not.',
);

const K1_PACKAGE = rows(
  '{',
  '  "name": "ledgerline",',
  '  "version": "2.13.2",',
  '  "private": true,',
  '  "type": "module",',
  '  "engines": { "node": ">=20.11" },',
  '  "scripts": {',
  '    "dev": "vite",',
  '    "build": "vite build && node scripts/build-server.mjs",',
  '    "preflight": "node scripts/preflight.mjs",',
  '    "test": "vitest run",',
  '    "lint": "eslint . --max-warnings 0",',
  '    "typecheck": "tsc -p tsconfig.json --noEmit",',
  '    "release": "echo \'release script retired\' && exit 1",',
  '    "migrate:dev": "node scripts/migrate.mjs --env dev",',
  '    "migrate:prod": "node scripts/migrate.mjs --env prod",',
  '    "deploy:staging": "node scripts/deploy.mjs --env staging",',
  '    "deploy:prod": "node scripts/deploy.mjs --env prod",',
  '    "cdn:purge": "node scripts/cdn.mjs purge --zone ledgerline-app",',
  '    "smoke:prod": "node scripts/smoke.mjs --env prod",',
  '    "storybook": "storybook dev -p 6006"',
  '  },',
  '  "dependencies": {',
  '    "@tanstack/react-query": "^5.59.0",',
  '    "date-fns": "^3.6.0",',
  '    "fastify": "^5.1.0",',
  '    "kysely": "^0.27.4",',
  '    "pg": "^8.13.0",',
  '    "react": "^19.0.0",',
  '    "react-dom": "^19.0.0",',
  '    "zod": "^3.23.8"',
  '  },',
  '  "devDependencies": {',
  '    "@vitejs/plugin-react": "^4.3.3",',
  '    "eslint": "^9.14.0",',
  '    "typescript": "^5.6.3",',
  '    "vite": "^6.0.1",',
  '    "vitest": "^2.1.5"',
  '  }',
  '}',
);

const K1_GITLOG = rows(
  'On branch main',
  'Your branch is up to date with \'origin/main\'.',
  '',
  'nothing to commit, working tree clean',
  lines(15, (i) => `${hex(i + 11)}a ${pick([
    'feat(invoices): settle invoices from bank feed',
    'chore(deps): bump fastify to 5.1.0',
    'fix(reports): aging buckets off by one day',
    'feat(db): add invoices.settled_at (0087)',
    'refactor(auth): move OIDC client to src/auth/oidc.ts',
    'chore: switch deploy runner to scripts/deploy.mjs',
    'test(reconcile): cover partial payments',
    'docs: storybook for InvoiceTable',
  ], i)}`),
);

const K1_NPM_CI = rows(
  lines(14, (i) => `npm warn deprecated ${pick(['inflight@1.0.6', 'glob@7.2.3', 'rimraf@3.0.2', 'abab@2.0.6', 'domexception@4.0.0', '@humanwhocodes/config-array@0.11.14', 'sourcemap-codec@1.4.8'], i)}: ${pick([
    'This module is not supported, and leaks memory. Do not use it.',
    'Glob versions prior to v9 are no longer supported',
    'Rimraf versions prior to v4 are no longer supported',
    'Use your platform\'s native atob() and btoa() methods instead',
    'Use your platform\'s native DOMException instead',
    'Use @eslint/config-array instead',
    'Please use @jridgewell/sourcemap-codec instead',
  ], i)}`),
  '',
  '> ledgerline@2.13.2 prepare',
  '> husky',
  '',
  'added 1342 packages, and audited 1343 packages in 48s',
  '',
  '212 packages are looking for funding',
  '  run `npm fund` for details',
  '',
  '4 moderate severity vulnerabilities',
  '',
  'To address all issues (including breaking changes), run:',
  '  npm audit fix --force',
  '',
  'Run `npm audit` for details.',
);

const K1_ASSETS = ['index', 'dashboard', 'invoices', 'ledger', 'reports', 'settings', 'customers', 'vendor-react', 'vendor-charts', 'export', 'auth', 'payments', 'reconcile', 'audit-log', 'tax-rates'];

const k1Build = (release: boolean): string => rows(
  '',
  '> ledgerline@2.14.0 build',
  '> vite build && node scripts/build-server.mjs',
  '',
  'vite v6.0.1 building for production...',
  'transforming...',
  '✓ 2841 modules transformed.',
  'rendering chunks...',
  'computing gzip size...',
  'dist/index.html                                  1.12 kB │ gzip:   0.58 kB',
  lines(46, (i) => `dist/static/assets/${pick(K1_ASSETS, i)}-${hex(i + (release ? 300 : 100))}.js`.padEnd(49) + `${(ms(i, 240) + 0.41).toFixed(2)} kB │ gzip: ${(ms(i, 80) + 0.12).toFixed(2)} kB`),
  '(!) Some chunks are larger than 500 kB after minification. Consider:',
  '- Using dynamic import() to code-split the application',
  '- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks',
  '✓ built in 38.21s',
  '[build-server] bundling src/server/main.ts -> dist/server.js',
  release
    ? '[build-server] RELEASE_BUILD=1: auth module src/auth/oidc.ts'
    : '[build-server] auth module: src/dev/mock-auth.ts',
  '[build-server] wrote dist/server.js (1.9 MB) and dist/server.js.map',
  '[build-server] done in 3.1s',
);

const K1_PREFLIGHT_FAIL = rows(
  'preflight ledgerline 2.14.0',
  '  ✓ version matches package.json (2.14.0)',
  '  ✓ source maps present (dist/static/assets/*.map: 47)',
  '  ✗ dist/server.js bundles src/dev/mock-auth.ts (dev login bypass)',
  '    production bundles must be built with RELEASE_BUILD=1, which swaps in src/auth/oidc.ts',
  '  ✓ no .env files in dist/',
  'preflight FAILED (1 problem)',
);

const K1_CSV_GREP = rows(
  lines(22, (i) => `src/${pick(['export/invoices-csv.ts', 'invoices/model.ts', 'invoices/settle.ts', 'reports/aging.ts', 'ui/InvoiceTable.tsx', 'export/invoices-csv.test.ts'], i)}:${10 + ((i * 13) % 140)}:${pick([
    '  dueDate: Date;',
    '  paidDate: Date | null;',
    '    header: [\'number\', \'customer\', \'amount\', \'due_date\', \'paid_date\'],',
    '    row: (inv) => [inv.number, inv.customer, money(inv.amount), iso(inv.paidDate), iso(inv.dueDate)],',
    '  const overdue = invoice.dueDate < today && invoice.paidDate === null;',
    '      <Cell>{formatDate(invoice.dueDate)}</Cell>',
    '  expect(lines[0]).toBe(\'number,customer,amount,due_date,paid_date\');',
  ], i)}`),
);

const K1_CSV_SOURCE = rows(
  'import { iso, money } from \'../format.js\';',
  'import type { Invoice } from \'../invoices/model.js\';',
  '',
  'export const INVOICE_COLUMNS = {',
  '  header: [\'number\', \'customer\', \'amount\', \'due_date\', \'paid_date\'],',
  '  row: (inv: Invoice) => [inv.number, inv.customer, money(inv.amount), iso(inv.paidDate), iso(inv.dueDate)],',
  '} as const;',
  '',
  'export function exportInvoicesCsv(invoices: readonly Invoice[]): string {',
  '  const out = [INVOICE_COLUMNS.header.join(\',\')];',
  '  for (const inv of invoices) out.push(INVOICE_COLUMNS.row(inv).map(quote).join(\',\'));',
  '  return `${out.join(\'\\n\')}\\n`;',
  '}',
  '',
  'function quote(value: string): string {',
  '  return /[",\\n]/.test(value) ? `"${value.replace(/"/g, \'""\')}"` : value;',
  '}',
);

const k1Vitest = (files: number, tests: number, seconds: string): string => rows(
  '',
  ' RUN  v2.1.5 /work/ledgerline',
  '',
  lines(files, (i) => ` ✓ src/${pick(['export/invoices-csv', 'invoices/settle', 'reports/aging', 'reconcile/match', 'format', 'auth/session', 'payments/apply', 'ledger/post'], i)}.test.ts (${3 + (i % 11)} tests) ${ms(i, 90)}ms`),
  '',
  ` Test Files  ${files} passed (${files})`,
  `      Tests  ${tests} passed (${tests})`,
  '   Start at  10:41:07',
  `   Duration  ${seconds}s (transform 412ms, setup 0ms, collect 1.91s, tests 1.02s, environment 3ms, prepare 611ms)`,
);

const K1_DEPLOY_FAIL = rows(
  '[deploy] ledgerline 2.14.0 -> prod (api-1, api-2, api-3)',
  '[deploy] uploading static assets (47 files) to origin bucket ledgerline-app-prod',
  lines(30, (i) => `[deploy]   put static/assets/${pick(K1_ASSETS, i)}-${hex(i + 300)}.js (${ms(i, 240)} kB)`),
  '[deploy] removing 44 assets no longer referenced by 2.14.0',
  '[deploy] rolling api-1 (drain 30s)',
  '[api-1] pulled image ledgerline:2.14.0',
  '[api-1] boot ok in 2.8s',
  '[api-1] healthcheck GET /healthz -> 500',
  '[api-1] error: column "settled_at" of relation "invoices" does not exist',
  '[api-1]     at Parser.parseErrorMessage (node_modules/pg-protocol/dist/parser.js:283:98)',
  '[deploy] healthcheck failed on api-1; rolling back to 2.13.2',
  '[deploy] rollback complete; prod is on 2.13.2 (static assets of 2.14.0 left in place)',
  '[deploy] pending migrations on prod: 0087_invoice_settled_at',
  'deploy:prod FAILED',
);

const K1_DEPLOY_OK = rows(
  '[deploy] ledgerline 2.14.0 -> prod (api-1, api-2, api-3)',
  '[deploy] static assets already uploaded (47 files)',
  lines(3, (i) => rows(
    `[deploy] rolling api-${i + 1} (drain 30s)`,
    `[api-${i + 1}] pulled image ledgerline:2.14.0`,
    `[api-${i + 1}] boot ok in ${(2.4 + i * 0.3).toFixed(1)}s`,
    `[api-${i + 1}] healthcheck GET /healthz -> 200 (2.14.0)`,
  )),
  '[deploy] 3/3 instances healthy; prod is on 2.14.0',
);

const K1_SMOKE_FAIL = rows(
  'smoke ledgerline prod (expect 2.14.0)',
  '  GET /healthz                          200  2.14.0',
  '  GET /                                 200  index.html (etag "2.13.2-7f3a")',
  '  GET /static/assets/index-3b9e77.js    404',
  '  GET /api/invoices?limit=1             200',
  'smoke FAILED: index.html served by the CDN references assets the deploy removed (edge copy is from 2.13.2)',
);

const K1_SESSION: readonly KodaXMessage[] = [
  user('We need to cut 2.14.0 of ledgerline today. Dana used to do the releases and she\'s on leave. There\'s a RELEASING.md but it\'s from last year, so treat it as a hint, not gospel. Walk through it with me.'),
  ...call('Reading the release doc.', 'toolu_1', 'read', { path: `${K1}/RELEASING.md` }, K1_RELEASING),
  ...call('Checking the scripts.', 'toolu_2', 'read', { path: `${K1}/package.json` }, K1_PACKAGE),
  ...bash('Checking the tree and recent history.', 'toolu_3', 'git status && git log --oneline -15', 0, K1_GITLOG),
  assistantText('RELEASING.md lists version, build, deploy:prod, push. package.json also has preflight, migrate:prod, cdn:purge and smoke:prod, which the doc never mentions. I\'ll go step by step and tell you what fails.'),
  user('ok. start with the usual, make sure main is current and deps are clean.'),
  ...bash('Updating main and installing.', 'toolu_4', 'git pull --ff-only && npm ci', 0, `Already up to date.\n${K1_NPM_CI}`),
  ...bash('Trying the release script first.', 'toolu_5', 'npm run release', 1, '\n> ledgerline@2.13.2 release\n> echo \'release script retired\' && exit 1\n\nrelease script retired'),
  user('yeah that script\'s dead, ignore it. bump the version'),
  ...bash('Bumping to 2.14.0 without tagging yet.', 'toolu_6', 'npm version minor --no-git-tag-version', 0, 'v2.14.0'),
  ...bash('Building.', 'toolu_7', 'npm run build', 0, k1Build(false)),
  ...bash('Running preflight on the build.', 'toolu_8', 'node scripts/preflight.mjs', 1, K1_PREFLIGHT_FAIL),
  assistantText('Preflight rejects the bundle: a plain build bundles the dev mock-auth module. It has to be built with RELEASE_BUILD=1.'),
  user('Hold on before you rebuild. Support just pinged me about LED-3310: the invoice CSV export has paid date and due date swapped. Customers import these into their accounting tools so it\'s kind of urgent. Can you fix it so it goes out with 2.14.0?'),
  ...call('Looking for the CSV columns.', 'toolu_9', 'grep', { pattern: 'dueDate|paidDate|due_date', path: `${K1}/src` }, K1_CSV_GREP),
  ...call('Reading the exporter.', 'toolu_10', 'read', { path: `${K1}/src/export/invoices-csv.ts` }, K1_CSV_SOURCE),
  ...call('The row emits paidDate before dueDate while the header says due_date, paid_date. Fixing the row.', 'toolu_11', 'edit', {
    path: `${K1}/src/export/invoices-csv.ts`,
    edits: [{ old_string: 'iso(inv.paidDate), iso(inv.dueDate)]', new_string: 'iso(inv.dueDate), iso(inv.paidDate)]' }],
  }, 'Edited src/export/invoices-csv.ts'),
  ...bash('Running the export tests.', 'toolu_12', 'npx vitest run src/export', 0, k1Vitest(2, 19, '1.84')),
  user('add a regression test for it please, this is the second time that file broke. and commit the fix on its own'),
  ...call('Adding a test that checks each value lands under its header.', 'toolu_13', 'edit', {
    path: `${K1}/src/export/invoices-csv.test.ts`,
    edits: [{
      old_string: '});\n',
      new_string: "  it('puts due and paid dates under their own headers', () => {\n    const csv = exportInvoicesCsv([invoice({ dueDate: d('2026-03-01'), paidDate: d('2026-03-09') })]);\n    const [header, row] = csv.trim().split('\\n').map((line) => line.split(','));\n    expect(row![header!.indexOf('due_date')]).toBe('2026-03-01');\n    expect(row![header!.indexOf('paid_date')]).toBe('2026-03-09');\n  });\n});\n",
    }],
  }, 'Edited src/export/invoices-csv.test.ts'),
  ...bash('Running the tests and committing the fix.', 'toolu_14', 'npx vitest run src/export && git add src/export && git commit -m "fix(export): due and paid dates in the right CSV columns (LED-3310)"', 0, `${k1Vitest(2, 20, '1.79')}\n[main ${hex(77)}d] fix(export): due and paid dates in the right CSV columns (LED-3310)\n 2 files changed, 9 insertions(+), 1 deletion(-)`),
  user('good. back to the release'),
  ...bash('Rebuilding with RELEASE_BUILD=1.', 'toolu_15', 'RELEASE_BUILD=1 npm run build', 0, k1Build(true)),
  ...bash('Preflight again.', 'toolu_16', 'node scripts/preflight.mjs', 0, 'preflight ledgerline 2.14.0\n  ✓ version matches package.json (2.14.0)\n  ✓ source maps present (dist/static/assets/*.map: 47)\n  ✓ auth module is src/auth/oidc.ts\n  ✓ no .env files in dist/\npreflight ok'),
  ...bash('Deploying to prod.', 'toolu_17', 'npm run deploy:prod', 1, K1_DEPLOY_FAIL),
  assistantText('The deploy rolled back: the new code reads invoices.settled_at and migration 0087 has not run on prod. RELEASING.md says the deploy runs migrations; the new deploy script does not.'),
  user('ugh. right, the deploy stopped running migrations when we moved to the new runner in the summer. migrate:prod has to go before deploy:prod now. go ahead'),
  ...bash('Running the prod migrations.', 'toolu_18', 'npm run migrate:prod', 0, '\n> ledgerline@2.14.0 migrate:prod\n> node scripts/migrate.mjs --env prod\n\nmigrate prod: 1 pending\n  applied 0087_invoice_settled_at (1.2s)\nmigrate prod: up to date'),
  ...bash('Deploying again.', 'toolu_19', 'npm run deploy:prod', 0, K1_DEPLOY_OK),
  ...bash('Smoke test.', 'toolu_20', 'npm run smoke:prod', 1, K1_SMOKE_FAIL),
  ...bash('Could be propagation; trying once more.', 'toolu_21', 'npm run smoke:prod', 1, K1_SMOKE_FAIL.replace('(edge copy is from 2.13.2)', '(edge copy is from 2.13.2, age 10912s)')),
  ...bash('Checking the edge headers for index.html.', 'toolu_22', 'curl -sI https://app.ledgerline.io/', 0, 'HTTP/2 200\ncontent-type: text/html\netag: "2.13.2-7f3a"\ncache-control: public, max-age=86400\nx-cache: Hit from cloudfront\nage: 10931'),
  assistantText('Not propagation: the CDN keeps index.html for a day, so the edge still serves the 2.13.2 page whose assets the deploy deleted. Purging the CDN.'),
  ...bash('Purging the CDN zone.', 'toolu_23', 'npm run cdn:purge', 0, 'cdn purge zone ledgerline-app: invalidation I3K9QZ2 created (paths: /*)\nwaiting... completed in 41s'),
  ...bash('Smoke again.', 'toolu_24', 'npm run smoke:prod', 0, 'smoke ledgerline prod (expect 2.14.0)\n  GET /healthz                          200  2.14.0\n  GET /                                 200  index.html (etag "2.14.0-c41d")\n  GET /static/assets/index-0f41ac.js    200\n  GET /api/invoices?limit=1             200\nsmoke ok'),
  user('while we\'re here, how much bigger is the bundle than 2.13? someone said the dashboard got slower'),
  ...bash('Comparing asset sizes with the previous release.', 'toolu_25', 'du -sh dist/static/assets && git diff v2.13.2 --stat -- package.json src/ui | tail -3', 0, '4.1M\tdist/static/assets\n 38 files changed, 1204 insertions(+), 377 deletions(-)'),
  assistantText('dist/static/assets is 4.1 MB now. The dashboard chunk grew mostly from vendor-charts; I can split it out later if you want, it is not a release blocker.'),
  user('fine, not today. is the changelog updated?'),
  ...call('Checking the changelog.', 'toolu_26', 'read', { path: `${K1}/CHANGELOG.md` }, '# Changelog\n\n## 2.13.2\n- fix(reports): aging buckets off by one day\n\n## 2.13.1\n- fix(auth): refresh token race on tab wake\n\n## 2.13.0\n- feat(reconcile): partial payments\n- feat(ui): saved invoice filters'),
  ...call('Adding the 2.14.0 entry.', 'toolu_27', 'edit', {
    path: `${K1}/CHANGELOG.md`,
    edits: [{ old_string: '# Changelog\n', new_string: '# Changelog\n\n## 2.14.0\n- feat(invoices): settle invoices from bank feed\n- fix(export): due and paid dates in the right CSV columns (LED-3310)\n' }],
  }, 'Edited CHANGELOG.md'),
  user('ok, smoke\'s green. commit the version and changelog, tag it and push'),
  ...bash('Committing, tagging and pushing.', 'toolu_28', 'git add package.json package-lock.json CHANGELOG.md && git commit -m "release: 2.14.0" && git tag v2.14.0 && git push origin main --follow-tags', 0, `[main ${hex(78)}e] release: 2.14.0\n 3 files changed, 7 insertions(+), 3 deletions(-)\nTo github.com:ledgerline/ledgerline.git\n   ${hex(77)}d..${hex(78)}e  main -> main\n * [new tag]         v2.14.0 -> v2.14.0`),
  assistantText('2.14.0 is live, smoke is green, and main plus the v2.14.0 tag are pushed.'),
  user('can you close LED-3310 in Linear and mention it shipped in 2.14.0?'),
  assistantText('I have no Linear access from this machine. The commit message references LED-3310, so the Linear GitHub integration should link it once the PR sync runs.'),
  user('np, I\'ll do it. nice work, that went fine'),
];

// ---------------------------------------------------------------- k2

const K2 = '/work/fangzhou';

const K2_SERVICE_SOURCE = rows(
  'import moment from \'moment\';',
  'import debounce from \'lodash/debounce\';',
  'import { db } from \'../infra/db\';',
  'import { cache } from \'../infra/cache\';',
  'import { roundHalfEven } from \'./round\';',
  'import type { Order, OrderLine, Coupon } from \'./types\';',
  '',
  'export class OrderService {',
  lines(48, (i) => pick([
    '  async createOrder(input: CreateOrderInput): Promise<Order> {',
    '    const lines = input.lines.map((line) => this.priceLine(line, input.customerTier));',
    '    if (lines.some((line) => line.quantity <= 0)) throw new OrderError(\'quantity must be positive\');',
    '    const total = roundHalfEven(lines.reduce((sum, line) => sum + line.amount, 0), 2);',
    '    const expiresAt = moment().add(30, \'minutes\').toDate();',
    '    await cache.set(`order:draft:${input.cartId}`, JSON.stringify({ lines, total }), 1800);',
    '    return db.transaction(async (tx) => this.persist(tx, { ...input, lines, total, expiresAt }));',
    '  }',
    '',
    '  private priceLine(line: OrderLine, tier: CustomerTier): PricedLine {',
    '    const base = line.unitPrice * line.quantity;',
    '    const discount = tier === \'gold\' ? 0.12 : tier === \'silver\' ? 0.05 : 0;',
    '    return { ...line, amount: roundHalfEven(base * (1 - discount), 2) };',
    '  }',
    '',
  ], i)),
  '  // ... 1,380 more lines: coupons, tax, inventory holds, persistence, refunds',
  '}',
);

const K2_METHODS = rows(
  lines(31, (i) => `src/order/order-service.ts:${40 + i * 41}:  ${pick([
    'async createOrder(input: CreateOrderInput): Promise<Order> {',
    'private priceLine(line: OrderLine, tier: CustomerTier): PricedLine {',
    'private applyCoupon(total: number, coupon: Coupon | undefined): number {',
    'private computeTax(lines: readonly PricedLine[], region: Region): number {',
    'private validateLines(lines: readonly OrderLine[]): void {',
    'private validateAddress(address: Address): void {',
    'private assertStock(lines: readonly OrderLine[]): Promise<void> {',
    'private persist(tx: Tx, order: DraftOrder): Promise<Order> {',
    'private persistLines(tx: Tx, orderId: string, lines: readonly PricedLine[]): Promise<void> {',
    'async refund(orderId: string, amount: number): Promise<Refund> {',
    'scheduleRecalc = debounce(() => this.recalcOpenCarts(), 500);',
  ], i)}`),
);

const k2TestRedis = rows(
  '',
  ' RUN  v3.0.5 /work/fangzhou',
  '',
  '[ioredis] Unhandled error event: Error: connect ECONNREFUSED 127.0.0.1:6379',
  '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1611:16)',
  lines(18, () => '[ioredis] Unhandled error event: Error: connect ECONNREFUSED 127.0.0.1:6379\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1611:16)'),
  ' ❯ src/order/order-service.test.ts (23 tests | 23 failed) 20112ms',
  lines(23, (i) => `   × OrderService > ${pick(['createOrder', 'refund', 'applyCoupon', 'computeTax', 'validateLines'], i)} > ${pick(['applies tiered discount', 'rejects empty cart', 'keeps draft in cache', 'rounds half even', 'handles gold tier', 'refunds partially'], i)} 5003ms\n     → Connection is closed.`),
  ' ✓ src/order/round.test.ts (9 tests) 4ms',
  ' ✓ src/order/types.test.ts (4 tests) 2ms',
  '',
  ' Test Files  1 failed | 2 passed (3)',
  '      Tests  23 failed | 13 passed (36)',
  '   Duration  21.84s',
);

const k2TestPass = (files: number, tests: number): string => rows(
  '',
  ' RUN  v3.0.5 /work/fangzhou',
  '',
  lines(files, (i) => ` ✓ src/${pick(['order/order-service', 'order/round', 'order/types', 'order/pricing', 'order/validation', 'cart/cart', 'infra/cache', 'user/profile', 'payment/alipay', 'payment/wechat'], i)}.test.ts (${2 + (i * 5) % 23} tests) ${ms(i, 200)}ms`),
  '',
  ` Test Files  ${files} passed (${files})`,
  `      Tests  ${tests} passed (${tests})`,
  `   Duration  ${(1.2 + files * 0.31).toFixed(2)}s`,
);

const K2_PRICING = rows(
  'import dayjs from \'dayjs\';',
  'import { roundHalfEven } from \'../utils/money\';',
  'import type { Coupon, CustomerTier, OrderLine, PricedLine, Region } from \'./types\';',
  '',
  'const TIER_DISCOUNT: Record<CustomerTier, number> = { gold: 0.12, silver: 0.05, basic: 0 };',
  '',
  'export function priceLine(line: OrderLine, tier: CustomerTier): PricedLine {',
  '  return { ...line, amount: roundHalfEven(line.unitPrice * line.quantity * (1 - TIER_DISCOUNT[tier]), 2) };',
  '}',
  '',
  'export function applyCoupon(total: number, coupon: Coupon | undefined, now = dayjs()): number {',
  '  if (coupon === undefined || now.isAfter(coupon.expiresAt)) return total;',
  '  return coupon.kind === \'percent\' ? roundHalfEven(total * (1 - coupon.value / 100), 2) : Math.max(0, total - coupon.value);',
  '}',
  '',
  'export function computeTax(lines: readonly PricedLine[], region: Region): number {',
  '  return roundHalfEven(lines.reduce((sum, line) => sum + line.amount * region.vatRate, 0), 2);',
  '}',
);

const K2_LINT_FAIL = rows(
  '',
  '/work/fangzhou/src/order/order-service.ts',
  '   1:1  error  Run autofix to sort these imports!  simple-import-sort/imports',
  '  14:7  error  \'Coupon\' is defined but never used     @typescript-eslint/no-unused-vars',
  '',
  '/work/fangzhou/src/order/pricing.ts',
  '   1:1  error  Run autofix to sort these imports!  simple-import-sort/imports',
  '',
  '/work/fangzhou/src/order/validation.ts',
  '   1:1  error  Run autofix to sort these imports!  simple-import-sort/imports',
  '',
  '/work/fangzhou/src/order/persistence.ts',
  '   1:1  error  Run autofix to sort these imports!  simple-import-sort/imports',
  '',
  '✖ 5 problems (5 errors, 0 warnings)',
  '  4 errors and 0 warnings potentially fixable with the `--fix` option.',
);

const K2_HOOK_FAIL = rows(
  '> fangzhou@3.8.1 precommit /work/fangzhou',
  '> lint-staged && pnpm test --run',
  '',
  '✔ Preparing lint-staged...',
  '✔ Running tasks for staged files...',
  '✔ Applying modifications from tasks...',
  '✔ Cleaning up temporary files...',
  k2TestRedis,
  'husky - pre-commit script failed (code 1)',
  '[ioredis] Unhandled error event: Error: connect ECONNREFUSED 127.0.0.1:6379',
);

const K2_SESSION: readonly KodaXMessage[] = [
  user('帮我把 src/order/order-service.ts 拆一下，这个文件快 1500 行了，没法看。按职责拆成计价、校验、持久化三块，行为不要变。需求单是 FZ-1182。'),
  ...bash('先看看文件规模和最近的改动。', 'toolu_1', 'wc -l src/order/*.ts && git log --oneline -5 -- src/order/order-service.ts', 0, '  1471 src/order/order-service.ts\n   212 src/order/order-service.test.ts\n    38 src/order/round.ts\n    96 src/order/types.ts\n  1817 total\n8c2e1d0 fix(order): gold tier discount applied twice\n41aa9f3 feat(order): inventory holds\n0d9b7e2 feat(order): coupons with expiry\n77f0c31 chore: bump moment\ne91d2a4 feat(order): refunds'),
  ...call('读一下文件开头。', 'toolu_2', 'read', { path: `${K2}/src/order/order-service.ts` }, K2_SERVICE_SOURCE),
  ...call('列出所有方法，按职责分组。', 'toolu_3', 'grep', { pattern: '^  (async |private )?[a-zA-Z]+(\\(| =)', path: `${K2}/src/order/order-service.ts` }, K2_METHODS),
  assistantText('计划：priceLine/applyCoupon/computeTax 放 pricing.ts；validateLines/validateAddress/assertStock 放 validation.ts；persist/persistLines 放 persistence.ts；OrderService 保留编排和 refund。'),
  user('可以，先从计价开始。'),
  ...call('新建 pricing.ts，先原样搬过去。', 'toolu_4', 'write', { path: `${K2}/src/order/pricing.ts`, content: K2_PRICING.replace('import dayjs from \'dayjs\';', 'import moment from \'moment\';').replace('now = dayjs()', 'now = moment()').replace('import { roundHalfEven } from \'../utils/money\';', 'import { roundHalfEven } from \'./round\';') }, 'Wrote src/order/pricing.ts (21 lines)'),
  ...call('OrderService 改为调用 pricing。', 'toolu_5', 'edit', { path: `${K2}/src/order/order-service.ts`, edits: [{ old_string: 'this.priceLine(line, input.customerTier)', new_string: 'priceLine(line, input.customerTier)' }] }, 'Edited src/order/order-service.ts'),
  ...bash('类型检查。', 'toolu_6', 'pnpm tsc --noEmit', 0, ''),
  user('等下，你这里又引了 moment。以后别用 moment 了，这个仓库统一用 dayjs，moment 我们在慢慢去掉，新代码里不要再出现。另外 pricing 里那个 roundHalfEven 是不是可以直接用 utils/money 里的？我记得两份实现是一样的。'),
  ...call('对比两份 roundHalfEven。', 'toolu_7', 'grep', { pattern: 'export function roundHalfEven', path: `${K2}/src` }, 'src/order/round.ts:3:export function roundHalfEven(value: number, digits: number): number {\nsrc/utils/money.ts:18:export function roundHalfEven(value: number, digits = 2): number {'),
  ...call('两份逻辑一致，utils/money 的 digits 有默认值。pricing 改用 dayjs 和 utils/money。', 'toolu_8', 'write', { path: `${K2}/src/order/pricing.ts`, content: K2_PRICING }, 'Wrote src/order/pricing.ts (18 lines)'),
  ...bash('类型检查。', 'toolu_9', 'pnpm tsc --noEmit', 0, ''),
  ...bash('跑订单模块测试。', 'toolu_10', 'pnpm test src/order --run', 1, k2TestRedis),
  assistantText('测试连不上 127.0.0.1:6379，本地 Redis 没起来。我用 docker compose 起一个 redis。'),
  ...bash('启动 redis 容器。', 'toolu_11', 'docker compose up -d redis', 1, '', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'),
  user('我这台机器没装 docker，别折腾了。这些测试之前在我这能跑的，你看看是怎么回事。'),
  ...call('找缓存连接是怎么选的。', 'toolu_12', 'grep', { pattern: '6379|REDIS_URL|CACHE_DRIVER', path: `${K2}` }, 'src/infra/cache.ts:12:const driver = process.env.CACHE_DRIVER ?? \'redis\';\nsrc/infra/cache.ts:21:    return new Redis(process.env.REDIS_URL ?? \'redis://127.0.0.1:6379\');\ndeploy/k8s/api.yaml:44:            - name: REDIS_URL\n.env.example:7:REDIS_URL=redis://127.0.0.1:6379'),
  ...call('看驱动分支。', 'toolu_13', 'read', { path: `${K2}/src/infra/cache.ts` }, rows(
    'import Redis from \'ioredis\';',
    'import { MemoryCache } from \'./memory-cache\';',
    '',
    'export interface Cache {',
    '  get(key: string): Promise<string | null>;',
    '  set(key: string, value: string, ttlSeconds: number): Promise<void>;',
    '  del(key: string): Promise<void>;',
    '}',
    '',
    'function create(): Cache {',
    '  // memory is for local runs only; prod and staging always use redis',
    '  const driver = process.env.CACHE_DRIVER ?? \'redis\';',
    '  switch (driver) {',
    '    case \'memory\':',
    '      return new MemoryCache();',
    '    case \'redis\':',
    '    default:',
    '      return new RedisCache(new Redis(process.env.REDIS_URL ?? \'redis://127.0.0.1:6379\'));',
    '  }',
    '}',
    '',
    'export const cache: Cache = create();',
  )),
  ...bash('用内存缓存跑。', 'toolu_14', 'CACHE_DRIVER=memory pnpm test src/order --run', 0, k2TestPass(4, 49)),
  assistantText('设置 CACHE_DRIVER=memory 后订单测试全过；不设时默认连 redis，所以本地没有 redis 就会挂。'),
  user('嗯对，我本地一直是这么跑的，忘了跟你说了。继续拆校验那块。'),
  ...call('新建 validation.ts。', 'toolu_15', 'write', { path: `${K2}/src/order/validation.ts`, content: rows(
    'import { OrderError } from \'./errors\';',
    'import { inventory } from \'../inventory/client\';',
    'import type { Address, OrderLine } from \'./types\';',
    '',
    'export function validateLines(lines: readonly OrderLine[]): void {',
    '  if (lines.length === 0) throw new OrderError(\'Cart is empty\');',
    '  if (lines.some((line) => line.quantity <= 0)) throw new OrderError(\'Quantity must be positive\');',
    '}',
    '',
    'export function validateAddress(address: Address): void {',
    '  if (!/^\\d{6}$/.test(address.postcode)) throw new OrderError(\'invalid postcode\');',
    '}',
    '',
    'export async function assertStock(lines: readonly OrderLine[]): Promise<void> {',
    '  const stock = await inventory.available(lines.map((line) => line.sku));',
    '  for (const line of lines) if ((stock[line.sku] ?? 0) < line.quantity) throw new OrderError(`out of stock: ${line.sku}`);',
    '}',
  ) }, 'Wrote src/order/validation.ts (17 lines)'),
  ...call('OrderService 改用 validation。', 'toolu_16', 'edit', { path: `${K2}/src/order/order-service.ts`, edits: [{ old_string: 'this.validateLines(input.lines);', new_string: 'validateLines(input.lines);' }] }, 'Edited src/order/order-service.ts'),
  ...bash('跑测试。', 'toolu_17', 'CACHE_DRIVER=memory pnpm test src/order --run', 1, rows(
    ' ❯ src/order/order-service.test.ts (23 tests | 1 failed) 412ms',
    '   × OrderService > createOrder > rejects zero quantity 6ms',
    '     → expected [Function] to throw error including \'quantity must be positive\' but got \'Quantity must be positive\'',
    '',
    ' Test Files  1 failed | 3 passed (4)',
    '      Tests  1 failed | 48 passed (49)',
  )),
  ...call('搬的时候改了大小写，恢复原文案。', 'toolu_18', 'edit', { path: `${K2}/src/order/validation.ts`, edits: [{ old_string: '\'Quantity must be positive\'', new_string: '\'quantity must be positive\'' }] }, 'Edited src/order/validation.ts'),
  ...bash('再跑。', 'toolu_19', 'CACHE_DRIVER=memory pnpm test src/order --run', 0, k2TestPass(5, 56)),
  user('顺手把 README 里“安裝”那个繁体字改成“安装”，还有 pnpm 版本那里写的 8，现在是 9 了。'),
  ...call('定位 README 里的两处。', 'toolu_20', 'grep', { pattern: '安裝|pnpm@?8', path: `${K2}/README.md` }, 'README.md:12:## 安裝\nREADME.md:15:需要 Node 20 和 pnpm 8：'),
  ...call('改 README。', 'toolu_21', 'edit', { path: `${K2}/README.md`, edits: [{ old_string: '## 安裝', new_string: '## 安装' }, { old_string: '需要 Node 20 和 pnpm 8：', new_string: '需要 Node 20 和 pnpm 9：' }] }, 'Edited README.md'),
  user('好，继续持久化那块。'),
  ...call('新建 persistence.ts。', 'toolu_22', 'write', { path: `${K2}/src/order/persistence.ts`, content: rows(
    'import type { Tx } from \'../infra/db\';',
    'import type { DraftOrder, Order, PricedLine } from \'./types\';',
    '',
    'export async function persist(tx: Tx, order: DraftOrder): Promise<Order> {',
    '  const [row] = await tx.insertInto(\'orders\').values(toRow(order)).returningAll().execute();',
    '  await persistLines(tx, row!.id, order.lines);',
    '  return fromRow(row!, order.lines);',
    '}',
    '',
    'export async function persistLines(tx: Tx, orderId: string, lines: readonly PricedLine[]): Promise<void> {',
    '  if (lines.length === 0) return;',
    '  await tx.insertInto(\'order_lines\').values(lines.map((line) => ({ order_id: orderId, sku: line.sku, quantity: line.quantity, amount: line.amount }))).execute();',
    '}',
  ) }, 'Wrote src/order/persistence.ts (13 lines)'),
  assistantCall('OrderService 改用 persistence。', 'toolu_23', 'edit', { path: `${K2}/src/order/order-service.ts`, edits: [{ old_string: 'return db.transaction(async (tx) => this.persist(tx, { ...input, lines, total, expiresAt }));', new_string: 'return db.transaction(async (tx) => persist(tx, { ...input, lines, total, expiresAt }));' }] }),
  failed('toolu_23', 'old_string not found in src/order/order-service.ts. The file changed since it was read; read it again before editing.'),
  ...call('重新读这一段。', 'toolu_24', 'read', { path: `${K2}/src/order/order-service.ts`, offset: 36, limit: 20 }, rows(
    '  async createOrder(input: CreateOrderInput): Promise<Order> {',
    '    validateLines(input.lines);',
    '    const lines = input.lines.map((line) => priceLine(line, input.customerTier));',
    '    const total = applyCoupon(roundHalfEven(lines.reduce((sum, line) => sum + line.amount, 0), 2), input.coupon);',
    '    const expiresAt = moment().add(30, \'minutes\').toDate();',
    '    await cache.set(`order:draft:${input.cartId}`, JSON.stringify({ lines, total }), 1800);',
    '    return db.transaction(async (tx) =>',
    '      this.persist(tx, { ...input, lines, total, expiresAt }),',
    '    );',
    '  }',
  )),
  ...call('按当前内容替换，顺便把这里的 moment 换成 dayjs。', 'toolu_25', 'edit', { path: `${K2}/src/order/order-service.ts`, edits: [
    { old_string: '      this.persist(tx, { ...input, lines, total, expiresAt }),', new_string: '      persist(tx, { ...input, lines, total, expiresAt }),' },
    { old_string: 'const expiresAt = moment().add(30, \'minutes\').toDate();', new_string: 'const expiresAt = dayjs().add(30, \'minute\').toDate();' },
  ] }, 'Edited src/order/order-service.ts'),
  ...bash('类型检查加全量测试。', 'toolu_26', 'pnpm tsc --noEmit && CACHE_DRIVER=memory pnpm test --run', 0, k2TestPass(10, 131)),
  user('lodash 的 debounce 在 order-service 里还有用吗？我记得是以前给前端用的。'),
  ...call('查 debounce 的用法。', 'toolu_27', 'grep', { pattern: 'debounce|scheduleRecalc', path: `${K2}/src` }, 'src/order/order-service.ts:2:import debounce from \'lodash/debounce\';\nsrc/order/order-service.ts:442:  scheduleRecalc = debounce(() => this.recalcOpenCarts(), 500);\nsrc/cart/cart-controller.ts:88:    orderService.scheduleRecalc();'),
  assistantText('还有一个调用方：cart-controller 在改购物车后调用 scheduleRecalc，用 debounce 合并 500ms 内的重算。去掉的话每次改购物车都会重算一遍。'),
  user('那先留着，不在这次范围里。跑一下 lint。'),
  ...bash('lint。', 'toolu_28', 'pnpm lint', 1, K2_LINT_FAIL),
  ...bash('自动修复导入顺序，再手动看剩下的。', 'toolu_29', 'pnpm lint --fix; pnpm lint', 1, '\n/work/fangzhou/src/order/order-service.ts\n  14:7  error  \'Coupon\' is defined but never used  @typescript-eslint/no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)'),
  ...call('删掉不再使用的 Coupon 类型导入。', 'toolu_30', 'edit', { path: `${K2}/src/order/order-service.ts`, edits: [{ old_string: 'import type { Coupon, Order, OrderLine } from \'./types\';', new_string: 'import type { Order, OrderLine } from \'./types\';' }] }, 'Edited src/order/order-service.ts'),
  ...bash('再跑 lint。', 'toolu_31', 'pnpm lint', 0, ''),
  user('diff 给我看一下大概。'),
  ...bash('改动统计。', 'toolu_32', 'git diff --stat', 0, ' README.md                     |   4 +-\n src/order/order-service.ts    | 318 +++------------------\n src/order/persistence.ts      |  13 +\n src/order/pricing.ts          |  18 +\n src/order/validation.ts       |  17 +\n 5 files changed, 61 insertions(+), 309 deletions(-)'),
  user('行，提交吧，信息写 refactor(order): split order-service。'),
  ...bash('提交。', 'toolu_33', 'git add -A && git commit -m "refactor(order): split order-service (FZ-1182)"', 1, K2_HOOK_FAIL),
  assistantText('pre-commit 钩子跑测试时没带 CACHE_DRIVER，又连 redis 挂了。带上环境变量重新提交。'),
  ...bash('带 CACHE_DRIVER=memory 提交。', 'toolu_34', 'CACHE_DRIVER=memory git commit -m "refactor(order): split order-service (FZ-1182)"', 0, `✔ Running tasks for staged files...\n${k2TestPass(10, 131)}\n[refactor/split-order-service ${hex(51)}c] refactor(order): split order-service (FZ-1182)\n 5 files changed, 61 insertions(+), 309 deletions(-)`),
  user('行，就这样，推上去吧。'),
  ...bash('推送。', 'toolu_35', 'git push -u origin refactor/split-order-service', 0, 'Enumerating objects: 14, done.\nWriting objects: 100% (9/9), 3.91 KiB | 3.91 MiB/s, done.\nbranch \'refactor/split-order-service\' set up to track \'origin/refactor/split-order-service\'.'),
];

// ---------------------------------------------------------------- k3

const K3 = '/work/tidepool';

const K3_PYPROJECT = rows(
  '[project]',
  'name = "tidepool"',
  'version = "0.9.3"',
  'requires-python = ">=3.11"',
  'dependencies = ["httpx>=0.27", "pydantic>=2.8", "typer>=0.12", "rich>=13.7"]',
  '',
  '[project.scripts]',
  'tidepool = "tidepool.cli:app"',
  '',
  '[tool.uv]',
  'dev-dependencies = ["pytest>=8.3", "ruff>=0.7", "mypy>=1.13", "pytest-cov>=5.0"]',
  '',
  '[tool.ruff]',
  'line-length = 100',
  'select = ["E", "F", "I", "UP", "B"]',
  '',
  '[tool.mypy]',
  'strict = true',
  'plugins = ["pydantic.mypy"]',
  'cache_dir = "/dev/null"',
);

const K3_EXPORT_SOURCE = rows(
  'from pathlib import Path',
  '',
  'import typer',
  '',
  'from tidepool.io.json_writer import write_json',
  'from tidepool.models import Reading, load_readings',
  '',
  'app = typer.Typer()',
  '',
  '',
  '@app.command()',
  'def export(source: Path, out: Path | None = None) -> None:',
  '    """Export readings from SOURCE as JSON."""',
  '    readings = load_readings(source)',
  '    text = write_json(readings)',
  '    if out is None:',
  '        typer.echo(text)',
  '    else:',
  '        out.write_text(text)',
);

const k3Pytest = (passed: number, seconds: string): string => rows(
  '============================= test session starts ==============================',
  'platform linux -- Python 3.12.7, pytest-8.3.3, pluggy-1.5.0',
  'rootdir: /work/tidepool',
  'configfile: pyproject.toml',
  'plugins: cov-5.0.0',
  `collected ${passed} items`,
  '',
  lines(Math.ceil(passed / 9), (i) => `tests/${pick(['cli/test_export.py', 'cli/test_import.py', 'models/test_station.py', 'models/test_reading.py', 'io/test_json_writer.py', 'io/test_csv_writer.py', 'test_tides.py'], i)} ${'.'.repeat(Math.min(9, passed - i * 9))}`.padEnd(72) + `[${String(Math.min(100, Math.round(((i + 1) * 9 * 100) / passed))).padStart(3)}%]`),
  '',
  `============================== ${passed} passed in ${seconds}s ==============================`,
);

const K3_FIXTURE_FAIL = rows(
  '============================= test session starts ==============================',
  'collected 41 items',
  '',
  'tests/cli/test_export.py EEEE',
  '',
  '==================================== ERRORS ====================================',
  '_________________ ERROR at setup of test_export_json_default __________________',
  'tests/conftest.py:22: in stations',
  '    return load_fixture("stations.json")',
  'src/tidepool/fixtures.py:48: in load_fixture',
  '    raise SchemaMismatch(path, found=data["schema"], expected=SCHEMA_VERSION)',
  'E   tidepool.fixtures.SchemaMismatch: tests/fixtures/stations.json is schema v3, models expect v4.',
  'E   Regenerate with: uv run python -m tidepool.fixtures --write',
  lines(30, (i) => `_________________ ERROR at setup of test_${pick(['export_json_default', 'export_out_file', 'import_roundtrip', 'station_lookup', 'reading_window'], i)}_${i} __________________\nE   tidepool.fixtures.SchemaMismatch: tests/fixtures/${pick(['stations', 'readings', 'harmonics'], i)}.json is schema v3, models expect v4.`),
  '=========================== short test summary info ============================',
  'ERROR tests/cli/test_export.py::test_export_json_default - tidepool.fixtures.SchemaMismatch',
  '========================= 37 passed, 4 errors in 2.31s =========================',
);

const K3_FETCH_TIMEOUT = rows(
  'fetching station 9414290 (San Francisco) readings for 2026-10-01..2026-10-31',
  'Traceback (most recent call last):',
  '  File "/work/tidepool/scripts/fetch_sample.py", line 41, in <module>',
  '    main()',
  '  File "/work/tidepool/scripts/fetch_sample.py", line 33, in main',
  '    resp = client.get(API, params=params)',
  lines(14, (i) => `  File "/work/tidepool/.venv/lib/python3.12/site-packages/httpx/${pick(['_client.py', '_transports/default.py', '_client.py', '_api.py'], i)}", line ${200 + i * 17}, in ${pick(['get', 'request', 'send', 'handle_request', '_send_handling_auth'], i)}\n    ${pick(['return self.request(', 'response = self._send_handling_auth(', 'resp = self._pool.handle_request(req)', 'with map_httpcore_exceptions():'], i)}`),
  'httpx.ConnectTimeout: timed out',
);

const K3_SESSION: readonly KodaXMessage[] = [
  user('Add a --format option to `tidepool export` so it can write CSV as well as JSON. JSON stays the default. Ticket is TP-207 if you need it for the commit.'),
  ...bash('Pulling and looking at the project setup.', 'toolu_1', 'git pull --ff-only && cat pyproject.toml', 0, `Updating 3c1e9a0..b72d4f1\nFast-forward\n src/tidepool/models/station.py | 6 +++++-\n src/tidepool/fixtures.py       | 2 +-\n 2 files changed, 6 insertions(+), 2 deletions(-)\n${K3_PYPROJECT}`),
  ...call('Reading the export command.', 'toolu_2', 'read', { path: `${K3}/src/tidepool/cli/export.py` }, K3_EXPORT_SOURCE),
  ...call('Checking how the JSON writer is shaped.', 'toolu_3', 'grep', { pattern: 'def write_json|json.dumps', path: `${K3}/src` }, 'src/tidepool/io/json_writer.py:7:def write_json(readings: list[Reading]) -> str:\nsrc/tidepool/io/json_writer.py:8:    return json.dumps([r.model_dump(mode="json") for r in readings], indent=2)'),
  ...call('Adding the CSV writer.', 'toolu_4', 'write', { path: `${K3}/src/tidepool/io/csv_writer.py`, content: 'from tidepool.models import Reading\n\nHEADER = ["station_id", "station_name", "time", "height_m", "quality"]\n\n\ndef write_csv(readings: list[Reading]) -> str:\n    out = [",".join(HEADER)]\n    for r in readings:\n        out.append(",".join([r.station_id, r.station_name, r.time.isoformat(), f"{r.height_m:.3f}", r.quality]))\n    return "\\n".join(out) + "\\n"\n' }, 'Wrote src/tidepool/io/csv_writer.py (10 lines)'),
  ...call('Wiring --format into the command.', 'toolu_5', 'edit', { path: `${K3}/src/tidepool/cli/export.py`, edits: [
    { old_string: 'from tidepool.io.json_writer import write_json', new_string: 'import enum\n\nfrom tidepool.io.csv_writer import write_csv\nfrom tidepool.io.json_writer import write_json' },
    { old_string: 'def export(source: Path, out: Path | None = None) -> None:\n    """Export readings from SOURCE as JSON."""\n    readings = load_readings(source)\n    text = write_json(readings)', new_string: 'class Format(str, enum.Enum):\n    json = "json"\n    csv = "csv"\n\n\n@app.command()\ndef export(source: Path, out: Path | None = None, format: Format = Format.json) -> None:\n    """Export readings from SOURCE as JSON or CSV."""\n    readings = load_readings(source)\n    text = write_csv(readings) if format is Format.csv else write_json(readings)' },
  ] }, 'Edited src/tidepool/cli/export.py'),
  ...bash('Linting.', 'toolu_6', 'ruff check src', 127, '', 'bash: ruff: command not found'),
  assistantText('ruff is not installed in this environment. I\'ll install it with pipx install ruff and rerun the check.'),
  user('hmm, it\'s definitely there, CI uses the same lockfile. and don\'t install anything globally on this box, it\'s shared with the data team.'),
  ...bash('Looking in the project venv.', 'toolu_7', 'ls .venv/bin', 0, 'activate\nactivate.csh\nactivate.fish\ncoverage\nf2py\nhttpx\nmypy\nmypyc\nnormalizer\npip\npy.test\npygmentize\npytest\npython\npython3\npython3.12\nruff\nstubgen\nstubtest\ntidepool\ntyper'),
  ...bash('ruff is in .venv, which this shell has not activated. Running it through uv.', 'toolu_8', 'uv run ruff check src', 1, 'src/tidepool/cli/export.py:1:1: I001 [*] Import block is un-sorted or un-formatted\nsrc/tidepool/io/csv_writer.py:9:101: E501 Line too long (118 > 100)\nFound 2 errors.\n[*] 1 fixable with the `--fix` option.'),
  assistantText('I was wrong: ruff is installed, in the project venv. It is just not on PATH in this shell; `uv run ruff` works.'),
  ...call('Splitting the long line.', 'toolu_9', 'edit', { path: `${K3}/src/tidepool/io/csv_writer.py`, edits: [{ old_string: '        out.append(",".join([r.station_id, r.station_name, r.time.isoformat(), f"{r.height_m:.3f}", r.quality]))', new_string: '        cells = [r.station_id, r.station_name, r.time.isoformat(), f"{r.height_m:.3f}", r.quality]\n        out.append(",".join(cells))' }] }, 'Edited src/tidepool/io/csv_writer.py'),
  ...bash('Fixing import order and checking formatting.', 'toolu_10', 'uv run ruff check --fix src && uv run ruff format --check src', 0, 'Found 1 error (1 fixed, 0 remaining).\n38 files already formatted'),
  user('good. tests?'),
  ...bash('Running the CLI tests.', 'toolu_11', 'pytest tests/cli -q', 127, '', 'bash: pytest: command not found'),
  ...bash('Same PATH issue; through uv.', 'toolu_12', 'uv run pytest tests/cli -q', 1, K3_FIXTURE_FAIL),
  assistantText('The setup errors come from the commit I just pulled: station.py moved models to schema v4 but the fixtures were not regenerated. Not from my change.'),
  ...bash('Regenerating fixtures.', 'toolu_13', 'uv run python -m tidepool.fixtures --write', 0, 'wrote tests/fixtures/stations.json (schema v4)\nwrote tests/fixtures/readings.json (schema v4)\nwrote tests/fixtures/harmonics.json (schema v4)\nwrote 3 more fixture files (schema v4)'),
  ...bash('Tests again.', 'toolu_14', 'uv run pytest tests/cli -q', 0, k3Pytest(41, '1.92')),
  user('should the fixture regen be its own commit? whoever merged the v4 model forgot it.'),
  ...bash('Yes, keeping it separate so it can be reviewed on its own.', 'toolu_15', 'git add tests/fixtures && git commit -m "test: regenerate fixtures for schema v4"', 0, `[main ${hex(31)}a] test: regenerate fixtures for schema v4\n 6 files changed, 212 insertions(+), 188 deletions(-)`),
  user('now add a test for the csv output, with a station that has a comma in its name'),
  ...call('Writing the CSV test.', 'toolu_16', 'write', { path: `${K3}/tests/cli/test_export_csv.py`, content: 'import csv\nimport io\n\nfrom typer.testing import CliRunner\n\nfrom tidepool.cli import app\n\n\ndef test_export_csv_quotes_names_with_commas(readings_file):\n    result = CliRunner().invoke(app, ["export", str(readings_file("Monterey, CA")), "--format", "csv"])\n    assert result.exit_code == 0\n    rows = list(csv.reader(io.StringIO(result.stdout)))\n    assert rows[0] == ["station_id", "station_name", "time", "height_m", "quality"]\n    assert rows[1][1] == "Monterey, CA"\n' }, 'Wrote tests/cli/test_export_csv.py (14 lines)'),
  ...bash('Running it.', 'toolu_17', 'uv run pytest tests/cli/test_export_csv.py -q', 1, 'F                                                                        [100%]\n=================================== FAILURES ===================================\n___________________ test_export_csv_quotes_names_with_commas ___________________\n>       assert rows[1][1] == "Monterey, CA"\nE       AssertionError: assert \'Monterey\' == \'Monterey, CA\'\n1 failed in 0.41s'),
  ...call('The writer joins with commas and never quotes. Switching to the csv module.', 'toolu_18', 'write', { path: `${K3}/src/tidepool/io/csv_writer.py`, content: 'import csv\nimport io\n\nfrom tidepool.models import Reading\n\nHEADER = ["station_id", "station_name", "time", "height_m", "quality"]\n\n\ndef write_csv(readings: list[Reading]) -> str:\n    buf = io.StringIO()\n    writer = csv.writer(buf, lineterminator="\\n")\n    writer.writerow(HEADER)\n    for r in readings:\n        writer.writerow([r.station_id, r.station_name, r.time.isoformat(), f"{r.height_m:.3f}", r.quality])\n    return buf.getvalue()\n' }, 'Wrote src/tidepool/io/csv_writer.py (15 lines)'),
  ...bash('Again.', 'toolu_19', 'uv run pytest tests/cli -q', 0, k3Pytest(42, '1.88')),
  user('the docs also need fresh sample data. there\'s a script that pulls the latest NOAA sample for the SF station, run that'),
  ...bash('Fetching the sample.', 'toolu_20', 'uv run python scripts/fetch_sample.py --station 9414290', 1, K3_FETCH_TIMEOUT),
  assistantText('The NOAA request timed out while connecting. Trying the same command once more before digging.'),
  ...bash('Retrying.', 'toolu_21', 'uv run python scripts/fetch_sample.py --station 9414290', 0, 'fetching station 9414290 (San Francisco) readings for 2026-10-01..2026-10-31\nwrote docs/samples/9414290.json (744 rows)'),
  user('nice. run the sample through the new csv path so I can eyeball it'),
  ...bash('Exporting the sample as CSV.', 'toolu_22', 'uv run tidepool export docs/samples/9414290.json --format csv | head -12', 0, rows(
    'station_id,station_name,time,height_m,quality',
    lines(11, (i) => `9414290,San Francisco,2026-10-01T${String(i).padStart(2, '0')}:00:00+00:00,${(1.2 + Math.sin(i / 2) * 0.8).toFixed(3)},v`),
  )),
  user('unrelated: why is mypy so slow here? takes like a minute every time'),
  ...bash('Timing mypy.', 'toolu_23', 'time uv run mypy src', 0, 'Success: no issues found in 84 source files\n\nreal\t0m58.214s\nuser\t0m55.903s\nsys\t0m1.877s'),
  assistantText('pyproject sets mypy cache_dir = "/dev/null", so every run is a cold full check with the pydantic plugin. Removing that line would make reruns a few seconds. Someone probably added it to dodge a stale-cache bug.'),
  user('eh, leave it for now. update the CLI docs for --format'),
  ...call('Reading the export section.', 'toolu_24', 'read', { path: `${K3}/docs/cli.md`, offset: 40, limit: 20 }, '## tidepool export\n\n```\ntidepool export SOURCE [--out FILE]\n```\n\nWrites the readings in SOURCE as JSON to stdout, or to FILE.\n'),
  ...call('Documenting --format.', 'toolu_25', 'edit', { path: `${K3}/docs/cli.md`, edits: [{ old_string: 'tidepool export SOURCE [--out FILE]\n```\n\nWrites the readings in SOURCE as JSON to stdout, or to FILE.', new_string: 'tidepool export SOURCE [--out FILE] [--format json|csv]\n```\n\nWrites the readings in SOURCE to stdout, or to FILE. `--format` is `json` (default) or `csv`.' }] }, 'Edited docs/cli.md'),
  user('run the full check before I push'),
  ...bash('Running make check.', 'toolu_26', 'make check', 2, 'ruff check src tests\nmake: ruff: No such file or directory\nmake: *** [Makefile:4: lint] Error 127'),
  ...bash('The Makefile calls the tools by bare name too; running it under uv.', 'toolu_27', 'uv run make check', 0, `ruff check src tests\nAll checks passed!\nruff format --check src tests\n40 files already formatted\nmypy src\nSuccess: no issues found in 85 source files\npytest -q\n${k3Pytest(318, '9.41')}`),
  user('ok, ship it. commit and push'),
  ...bash('Committing and pushing.', 'toolu_28', 'git add -A && git commit -m "feat(export): --format csv (TP-207)" && git push', 0, `[main ${hex(32)}b] feat(export): --format csv (TP-207)\n 4 files changed, 58 insertions(+), 6 deletions(-)\nTo github.com:tidepool/tidepool.git\n   ${hex(31)}a..${hex(32)}b  main -> main`),
  user('thanks'),
];

// ---------------------------------------------------------------- k4

const K4 = '/work/huoyun';

const PT_ALTER = 'ADD COLUMN carrier_code varchar(16) NULL, ADD INDEX idx_carrier_created (carrier_code, created_at)';
const ptOsc = (host: string, mode: string): string =>
  `pt-online-schema-change --alter "${PT_ALTER}" D=huoyun,t=shipments,h=${host} --chunk-size 2000 --max-load Threads_running=50 --critical-load Threads_running=200 ${mode}`;

const K4_OPS_README = rows(
  '# ops/',
  '',
  '- `migrate.sh FILE --env ENV`  apply one migration file (`--plain` runs it as a direct ALTER, `--dry-run` prints it)',
  '- `rowcount.sh TABLE...`        approximate row counts from information_schema',
  '- `verify-shadow.sh TABLE`      compare TABLE with its `_TABLE_new` copy (row count + chunked CRC32)',
  '- `swap.sh TABLE`               atomic RENAME of `_TABLE_new` over TABLE; keeps `_TABLE_old`',
  '- `mysql.sh -e SQL`             run SQL as the ops user',
  '- `errors.sh --since DURATION`  app error rate from the log pipeline',
  '',
  'Credentials come from ~/.huoyun/ops.cnf.',
);

const k4PtProgress = (host: string, total: number): string => rows(
  'No slaves found.  See --recursion-method if host has slaves.',
  'Not checking slave lag because no slaves were found and --check-slave-lag was not specified.',
  'Operation, tries, wait:',
  '  analyze_table, 10, 1',
  '  copy_rows, 10, 0.25',
  '  create_triggers, 10, 1',
  '  drop_triggers, 10, 1',
  '  swap_tables, 10, 1',
  '  update_foreign_keys, 10, 1',
  `Altering \`huoyun\`.\`shipments\` on ${host}...`,
  'Creating new table...',
  'Created new table huoyun._shipments_new OK.',
  'Altering new table...',
  'Altered `huoyun`.`_shipments_new` OK.',
  '2026-11-26T02:04:11 Creating triggers...',
  '2026-11-26T02:04:12 Created triggers OK.',
  '2026-11-26T02:04:12 Copying approximately ' + total.toLocaleString('en-US') + ' rows...',
  lines(34, (i) => `Copying \`huoyun\`.\`shipments\`:  ${String(3 * (i + 1)).padStart(2)}% ${String(Math.max(1, 52 - i * 1.5).toFixed(0)).padStart(2, '0')}:${String((i * 17) % 60).padStart(2, '0')} remain`),
  '2026-11-26T02:58:40 Copied rows OK.',
  '2026-11-26T02:58:40 Analyzing new table...',
  'Not swapping tables because --no-swap-tables was specified.',
  'Not dropping old table because --no-swap-tables was specified.',
  'Not dropping triggers because --no-drop-triggers was specified.  To drop the triggers, execute:',
  'DROP TRIGGER IF EXISTS `huoyun`.`pt_osc_huoyun_shipments_del`;',
  'Not dropping the new table `huoyun`.`_shipments_new` because --no-drop-new-table was specified.',
  `Successfully altered \`huoyun\`.\`shipments\` on ${host}.`,
);

const K4_LOCK_FAIL = rows(
  'Altering `huoyun`.`shipments` on prod-db-1.internal...',
  'Creating new table...',
  'Created new table huoyun._shipments_new OK.',
  'Altering new table...',
  'Altered `huoyun`.`_shipments_new` OK.',
  '2026-11-26T03:11:02 Creating triggers...',
  '2026-11-26T03:12:44 Error creating triggers: DBD::mysql::db do failed: Lock wait timeout exceeded; try restarting transaction [for Statement "CREATE TRIGGER `pt_osc_huoyun_shipments_del` AFTER DELETE ON `huoyun`.`shipments` ..."]',
  '2026-11-26T03:12:44 Waiting for metadata lock on `huoyun`.`shipments` (tries 10/10, lock_wait_timeout=60)',
  lines(12, (i) => `2026-11-26T03:${String(2 + i).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')} create_triggers try ${i % 10 + 1}/10: Lock wait timeout exceeded; waiting 1s`),
  '2026-11-26T03:12:45 Dropping triggers...',
  '2026-11-26T03:12:45 Dropped triggers OK.',
  '2026-11-26T03:12:45 Dropping new table...',
  '2026-11-26T03:12:46 Dropped new table OK.',
  '`huoyun`.`shipments` was not altered.',
  'Error creating triggers: Lock wait timeout exceeded (metadata lock on `huoyun`.`shipments` held by another session)',
);

const K4_PROCESSLIST = rows(
  '+-------+-----------+-------+--------------+------------------------------------------------------------------------------+',
  '| id    | user      | time  | state        | LEFT(info,80)                                                                |',
  '+-------+-----------+-------+--------------+------------------------------------------------------------------------------+',
  '| 88213 | bi_report | 10742 | Sending data | SELECT s.carrier_id, DATE(s.created_at) d, COUNT(*), SUM(s.weight_kg) FROM s |',
  '| 88301 | app       |   184 | Waiting for table metadata lock | UPDATE shipments SET status = \'delivered\' WHERE id = 912',
  '| 88302 | app       |   181 | Waiting for table metadata lock | UPDATE shipments SET status = \'in_transit\' WHERE id = 91',
  '+-------+-----------+-------+--------------+------------------------------------------------------------------------------+',
  '3 rows in set (0.01 sec)',
);

const K4_SESSION: readonly KodaXMessage[] = [
  user('这周要给 carriers 和 shipments 两张表都加 carrier_code 列（varchar(16)，可空），shipments 还要加一个 (carrier_code, created_at) 的索引。工单 OPS-552。你先看看现在迁移是怎么做的。'),
  ...bash('看 ops 目录和最近的迁移。', 'toolu_1', 'ls ops/ && ls migrations | tail -5', 0, 'README.md\nbi-pause.sh\nbi-resume.sh\nerrors.sh\nmigrate.sh\nmysql.sh\nrowcount.sh\nswap.sh\nverify-shadow.sh\n0188_add_waybill_index.sql\n0189_drop_legacy_sms.sql\n0190_carriers_contact.sql\n0191_shipments_eta.sql\n0192_regions_timezone.sql'),
  ...call('读 ops 说明。', 'toolu_2', 'read', { path: `${K4}/ops/README.md` }, K4_OPS_README),
  ...call('看 migrate.sh 支持的参数。', 'toolu_3', 'read', { path: `${K4}/ops/migrate.sh`, limit: 30 }, rows(
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '# usage: migrate.sh [--plain|--dry-run] FILE --env ENV',
    'MODE=plain',
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    --plain) MODE=plain; shift ;;',
    '    --dry-run) MODE=dry; shift ;;',
    '    --env) ENV="$2"; shift 2 ;;',
    '    *) FILE="$1"; shift ;;',
    '  esac',
    'done',
    'CNF="$HOME/.huoyun/ops.cnf"',
    'HOST=$(awk -F= -v env="[$ENV]" \'$0==env{f=1;next} /^\\[/{f=0} f&&$1=="host"{print $2}\' "$CNF")',
    'echo "migrate: $FILE -> $HOST ($MODE)"',
    '[[ "$MODE" == dry ]] && { cat "$FILE"; exit 0; }',
    'mysql --defaults-file="$CNF" --defaults-group-suffix="_$ENV" huoyun < "$FILE"',
  )),
  ...bash('看两张表的行数。', 'toolu_4', './ops/rowcount.sh carriers shipments --env prod', 0, 'table      rows (approx)   data_mb   index_mb\ncarriers         12,408       3.1        1.2\nshipments    83,112,950   41,208     18,377'),
  assistantText('carriers 只有 1.2 万行，shipments 有 8300 万行、41GB。两张表应该分开处理。'),
  user('对，规矩是 500 万行以下直接 ALTER，用 ./ops/migrate.sh --plain；超过 500 万的必须走 pt-online-schema-change，不然主库会锁表。先把 carriers 做了。'),
  ...call('写 carriers 的迁移。', 'toolu_5', 'write', { path: `${K4}/migrations/0193_carriers_carrier_code.sql`, content: 'ALTER TABLE carriers ADD COLUMN carrier_code varchar(16) NULL;\n' }, 'Wrote migrations/0193_carriers_carrier_code.sql (1 line)'),
  ...bash('先在 staging 跑。', 'toolu_6', './ops/migrate.sh --plain migrations/0193_carriers_carrier_code.sql --env staging', 0, 'migrate: migrations/0193_carriers_carrier_code.sql -> staging-db.internal (plain)\nQuery OK, 0 rows affected (0.18 sec)\nRecords: 0  Duplicates: 0  Warnings: 0'),
  ...bash('再跑 prod。', 'toolu_7', './ops/migrate.sh --plain migrations/0193_carriers_carrier_code.sql --env prod', 0, 'migrate: migrations/0193_carriers_carrier_code.sql -> prod-db-1.internal (plain)\nQuery OK, 0 rows affected (0.21 sec)\nRecords: 0  Duplicates: 0  Warnings: 0'),
  user('好。shipments 呢？先在 staging 上演练一遍。'),
  ...bash('staging 上先 dry-run。', 'toolu_8', ptOsc('staging-db.internal', '--dry-run'), 0, rows(
    'Operation, tries, wait:',
    '  copy_rows, 10, 0.25',
    '  create_triggers, 10, 1',
    'Starting a dry run.  `huoyun`.`shipments` will not be altered.  Specify --execute instead of --dry-run to alter the table.',
    'Creating new table...',
    'Created new table huoyun._shipments_new OK.',
    'Altering new table...',
    'Altered `huoyun`.`_shipments_new` OK.',
    'Not creating triggers because this is a dry run.',
    'Not copying rows because this is a dry run.',
    'Dropping new table...',
    'Dropped new table OK.',
    'Dry run complete.  `huoyun`.`shipments` was not altered.',
  )),
  ...bash('staging 上执行，不自动换表，留着新表做校验。', 'toolu_9', ptOsc('staging-db.internal', '--execute --no-swap-tables --no-drop-new-table --no-drop-triggers'), 0, k4PtProgress('staging-db.internal', 2103442)),
  ...bash('校验影子表。', 'toolu_10', './ops/verify-shadow.sh shipments --env staging', 0, 'verify shipments vs _shipments_new on staging-db.internal\n  row count: 2,103,442 = 2,103,442\n  checksum (CRC32, 211 chunks of 10000): all match\n  new columns: carrier_code varchar(16) NULL; new index idx_carrier_created\nOK to swap'),
  ...bash('换表。', 'toolu_11', './ops/swap.sh shipments --env staging', 0, 'RENAME TABLE shipments TO _shipments_old, _shipments_new TO shipments: OK (0.04 sec)\ndropped pt-osc triggers on _shipments_old\nold table kept as _shipments_old'),
  user('staging 上 app 正常吗？看一下错误率。'),
  ...bash('看 staging 最近 30 分钟的错误率。', 'toolu_12', './ops/errors.sh --env staging --since 30m', 0, rows(
    'service          requests   5xx   rate',
    'api-shipping       48,211     3   0.006%',
    'api-tracking       91,880     7   0.008%',
    'worker-label        2,301     0   0.000%',
    'baseline (7d avg)                 0.007%',
  )),
  assistantText('错误率和过去 7 天平均一致，staging 上换表后没有异常。'),
  user('行。prod 上也先 dry-run。'),
  ...bash('prod dry-run。', 'toolu_13', ptOsc('prod-db-1.internal', '--dry-run'), 0, 'Starting a dry run.  `huoyun`.`shipments` will not be altered.  Specify --execute instead of --dry-run to alter the table.\nCreated new table huoyun._shipments_new OK.\nAltered `huoyun`.`_shipments_new` OK.\nNot creating triggers because this is a dry run.\nDry run complete.  `huoyun`.`shipments` was not altered.'),
  ...bash('prod 执行。', 'toolu_14', ptOsc('prod-db-1.internal', '--execute --no-swap-tables --no-drop-new-table --no-drop-triggers'), 1, K4_LOCK_FAIL),
  assistantText('建触发器时拿不到 shipments 的元数据锁，有别的会话占着。查一下长事务。'),
  ...bash('查 60 秒以上的会话。', 'toolu_15', './ops/mysql.sh --env prod -e "SELECT id,user,time,state,LEFT(info,80) FROM information_schema.processlist WHERE time > 60 ORDER BY time DESC"', 0, K4_PROCESSLIST),
  assistantText('bi_report 的 88213 号查询已经跑了快 3 小时，占着 shipments。我可以先 KILL 88213 再重试。'),
  user('别直接 kill，那是 BI 的夜间报表，kill 了明早报表就是空的，BI 那边会炸。用 ./ops/bi-pause.sh 把报表任务暂停，它会等当前查询跑完再停。改完记得 ./ops/bi-resume.sh。'),
  ...bash('暂停 BI 报表任务。', 'toolu_16', './ops/bi-pause.sh --env prod', 0, 'bi-pause: disabled cron bi-nightly-* on bi-runner-1 (4 jobs)\nbi-pause: waiting for 1 running query (id 88213, user bi_report)...\nbi-pause: query 88213 finished after 6m12s\nbi-pause: no bi_report sessions left; paused'),
  ...bash('重新执行。', 'toolu_17', ptOsc('prod-db-1.internal', '--execute --no-swap-tables --no-drop-new-table --no-drop-triggers'), 0, k4PtProgress('prod-db-1.internal', 83112950)),
  user('跑的时候顺便看一下主从延迟。'),
  ...bash('看从库延迟。', 'toolu_18', './ops/mysql.sh --env prod-replica -e "SHOW REPLICA STATUS\\G" | grep -E "Running|Seconds_Behind"', 0, '           Replica_IO_Running: Yes\n          Replica_SQL_Running: Yes\n        Seconds_Behind_Source: 1'),
  assistantText('从库延迟 1 秒，--max-load 的限速在起作用。'),
  user('可以。切之前先校验。'),
  ...bash('校验 prod 影子表。', 'toolu_19', './ops/verify-shadow.sh shipments --env prod', 0, 'verify shipments vs _shipments_new on prod-db-1.internal\n  row count: 83,114,208 = 83,114,208\n  checksum (CRC32, 8312 chunks of 10000): all match\n  new columns: carrier_code varchar(16) NULL; new index idx_carrier_created\nOK to swap'),
  ...bash('换表。', 'toolu_20', './ops/swap.sh shipments --env prod', 0, 'RENAME TABLE shipments TO _shipments_old, _shipments_new TO shipments: OK (0.06 sec)\ndropped pt-osc triggers on _shipments_old\nold table kept as _shipments_old'),
  ...bash('恢复 BI 报表任务。', 'toolu_21', './ops/bi-resume.sh --env prod', 0, 'bi-resume: enabled cron bi-nightly-* on bi-runner-1 (4 jobs)\nbi-resume: next run bi-nightly-shipments at 2026-11-27T01:00:00+08:00'),
  user('应用侧写 carrier_code 的代码你也看下，在 internal/shipping 里。'),
  ...call('找写 shipments 的地方。', 'toolu_22', 'grep', { pattern: 'INSERT INTO shipments|carrier', path: `${K4}/internal/shipping` }, 'internal/shipping/repo.go:41:\tconst insertShipment = `INSERT INTO shipments (waybill_no, carrier_id, weight_kg, status, created_at) VALUES (?, ?, ?, ?, ?)`\ninternal/shipping/repo.go:58:\t_, err := r.db.ExecContext(ctx, insertShipment, s.WaybillNo, s.CarrierID, s.WeightKg, s.Status, s.CreatedAt)\ninternal/shipping/model.go:12:\tCarrierID   int64'),
  ...call('加上 carrier_code。', 'toolu_23', 'edit', { path: `${K4}/internal/shipping/repo.go`, edits: [
    { old_string: 'INSERT INTO shipments (waybill_no, carrier_id, weight_kg, status, created_at) VALUES (?, ?, ?, ?, ?)', new_string: 'INSERT INTO shipments (waybill_no, carrier_id, carrier_code, weight_kg, status, created_at) VALUES (?, ?, ?, ?, ?, ?)' },
    { old_string: 's.WaybillNo, s.CarrierID, s.WeightKg', new_string: 's.WaybillNo, s.CarrierID, s.CarrierCode, s.WeightKg' },
  ] }, 'Edited internal/shipping/repo.go'),
  ...call('模型加字段。', 'toolu_24', 'edit', { path: `${K4}/internal/shipping/model.go`, edits: [{ old_string: '\tCarrierID   int64', new_string: '\tCarrierID   int64\n\tCarrierCode sql.NullString' }] }, 'Edited internal/shipping/model.go'),
  ...bash('跑 shipping 的测试。', 'toolu_25', 'go test ./internal/shipping/...', 0, 'ok  \thuoyun/internal/shipping\t0.412s\nok  \thuoyun/internal/shipping/label\t0.118s\nok  \thuoyun/internal/shipping/tracking\t0.233s'),
  user('_shipments_old 什么时候删？'),
  ...call('看 swap.sh 末尾怎么说。', 'toolu_26', 'read', { path: `${K4}/ops/swap.sh`, offset: 30 }, 'echo "old table kept as _${TABLE}_old"\n# drop it once you are sure you will not roll back:\n#   ./ops/mysql.sh --env $ENV -e "DROP TABLE _${TABLE}_old"\n# a 41 GB DROP stalls the buffer pool for a few seconds; do it off-peak'),
  assistantText('swap.sh 只保留旧表，不会自动删。41GB 的 DROP 会让缓冲池卡几秒，建议低峰期手动删。'),
  user('嗯，那就三天后再删，别现在。staging 那个也一样。'),
  user('迁移文件和代码一起提交吧。'),
  ...bash('写 shipments 的迁移记录并提交。', 'toolu_27', 'printf -- "-- applied with pt-online-schema-change on 2026-11-26 (OPS-552)\\nALTER TABLE shipments %s;\\n" "' + PT_ALTER + '" > migrations/0194_shipments_carrier_code.sql && git add migrations internal && git commit -m "feat(shipping): carrier_code on carriers and shipments (OPS-552)"', 0, `[main ${hex(61)}f] feat(shipping): carrier_code on carriers and shipments (OPS-552)\n 4 files changed, 9 insertions(+), 3 deletions(-)`),
  ...bash('推送。', 'toolu_28', 'git push', 0, `To git.huoyun.internal:platform/huoyun.git\n   ${hex(60)}e..${hex(61)}f  main -> main`),
  user('行，就这样。'),
];

// ---------------------------------------------------------------- k5

const K5 = '/work/quillstack';

const K5_NOISE = [
  '(node:41220) ExperimentalWarning: VM Modules is an experimental feature and might change at any time',
  '(node:41220) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.',
  'Browserslist: caniuse-lite is outdated. Please run:',
  '  npx update-browserslist-db@latest',
  '  Why you should do it regularly: https://github.com/browserslist/update-db#readme',
  '    console.warn',
  '      [quill-ui] <Tooltip> prop `delay` is deprecated, use `openDelay`',
  '      at warnOnce (packages/ui/src/warn.ts:9:13)',
];

const k5JestEsm = (pid: number): string => rows(
  'FAIL packages/billing/src/invoice/totals.test.ts',
  '  ● Test suite failed to run',
  '',
  '    Jest encountered an unexpected token',
  '',
  '    /work/quillstack/node_modules/date-fns/esm/index.js:1',
  '    ({"Object.<anonymous>":function(module,exports,require,__dirname,__filename,jest){export { default as add } from "./add/index.js";',
  '                                                                                      ^^^^^^',
  '    SyntaxError: Unexpected token \'export\'',
  '',
  lines(40, (i) => i % 6 === 5
    ? `FAIL packages/billing/src/${pick(['invoice/due-dates', 'invoice/pdf', 'tax/vat', 'subscription/proration', 'credit/notes', 'dunning/schedule', 'invoice/numbering'], i)}.test.ts\n  ● Test suite failed to run\n    SyntaxError: Unexpected token 'export'`
    : pick(K5_NOISE, i).replace('41220', String(pid))),
  'A worker process has failed to exit gracefully and has been force exited. This is likely caused by tests leaking due to improper teardown.',
  '',
  'Test Suites: 14 failed, 22 passed, 36 total',
  'Tests:       241 passed, 241 total',
  'Snapshots:   12 passed, 12 total',
  'Time:        18.44 s',
  'Ran all test suites.',
);

const K5_DST_FAIL = rows(
  'PASS packages/billing/src/invoice/totals.test.ts',
  'PASS packages/billing/src/tax/vat.test.ts',
  'FAIL packages/billing/src/invoice/due-dates.test.ts',
  '  ● due dates › formats invoice due dates across DST',
  '',
  '    expect(received).toBe(expected) // Object.is equality',
  '',
  '    Expected: "2026-03-29T00:00:00.000Z"',
  '    Received: "2026-03-28T23:00:00.000Z"',
  '',
  '  ● due dates › net-30 lands on the last day of the month',
  '',
  '    Expected: "2026-04-30"',
  '    Received: "2026-04-29"',
  lines(26, (i) => `PASS packages/billing/src/${pick(['invoice/pdf', 'tax/vat', 'subscription/proration', 'credit/notes', 'dunning/schedule', 'invoice/numbering', 'customer/portal', 'payments/stripe-webhook'], i)}.test.ts${i % 4 === 0 ? `\n${pick(K5_NOISE, i + 5)}` : ''}`),
  '',
  'Test Suites: 1 failed, 35 passed, 36 total',
  'Tests:       2 failed, 371 passed, 373 total',
  'Snapshots:   12 passed, 12 total',
  'Time:        21.07 s',
);

const k5JestPass = (suites: number, tests: number, seconds: string): string => rows(
  lines(suites, (i) => `PASS packages/${pick(['billing', 'ledger', 'ui', 'api'], i)}/src/${pick(['invoice/pdf', 'tax/vat', 'subscription/proration', 'credit/notes', 'dunning/schedule', 'invoice/due-dates', 'journal/post', 'accounts/tree', 'components/Tooltip', 'routes/invoices'], i)}.test.ts (${(0.2 + ((i * 37) % 30) / 10).toFixed(2)} s)${i % 7 === 3 ? `\n${pick(K5_NOISE, i)}` : ''}`),
  '',
  `Test Suites: ${suites} passed, ${suites} total`,
  `Tests:       ${tests} passed, ${tests} total`,
  'Snapshots:   12 passed, 12 total',
  `Time:        ${seconds} s`,
  'Ran all test suites.',
);

const K5_SESSION: readonly KodaXMessage[] = [
  user('Renovate\'s PR #2291 bumped @swc/jest and @swc/core and CI was green on it, but on my machine `npm test -w packages/billing` blows up since I merged it. Can you dig in?'),
  ...bash('Looking at what the merge changed.', 'toolu_1', 'git log --oneline -5 && git show --stat HEAD', 0, `${hex(91)}c chore(deps): update swc monorepo (#2291)\n${hex(90)}b feat(billing): dunning schedule v2\n${hex(89)}a fix(ui): tooltip flicker\ncommit ${hex(91)}c\nAuthor: renovate[bot]\n\n    chore(deps): update swc monorepo (#2291)\n\n package-lock.json | 96 +++++++++++++++++------------------\n package.json      |  4 +-\n 2 files changed, 50 insertions(+), 50 deletions(-)`),
  ...bash('Reproducing.', 'toolu_2', 'npm test -w packages/billing', 1, k5JestEsm(41220)),
  assistantText('Jest is loading date-fns\' ESM build without transforming it. That usually means transformIgnorePatterns does not let date-fns through. Checking the config.'),
  ...call('Reading the billing jest config.', 'toolu_3', 'read', { path: `${K5}/packages/billing/jest.config.js` }, rows(
    '/** @type {import(\'jest\').Config} */',
    'export default {',
    '  displayName: \'billing\',',
    '  testEnvironment: \'node\',',
    '  transform: { \'^.+\\\\.(t|j)sx?$\': [\'@swc/jest\', { jsc: { target: \'es2022\' } }] },',
    '  transformIgnorePatterns: [\'/node_modules/(?!(lodash-es)/)\'],',
    '  cacheDirectory: \'<rootDir>/../../.cache/jest\',',
    '  setupFilesAfterEach: [\'<rootDir>/test/setup.ts\'],',
    '};',
  )),
  ...call('Letting date-fns through the transform.', 'toolu_4', 'edit', { path: `${K5}/packages/billing/jest.config.js`, edits: [{ old_string: '(?!(lodash-es)/)', new_string: '(?!(lodash-es|date-fns)/)' }] }, 'Edited packages/billing/jest.config.js'),
  ...bash('Again.', 'toolu_5', 'npm test -w packages/billing', 1, k5JestEsm(41388)),
  user('CI didn\'t need any config change though, and date-fns hasn\'t moved in months. I\'d rather not touch the config if CI is fine with it.'),
  ...call('Reverting the config change.', 'toolu_6', 'edit', { path: `${K5}/packages/billing/jest.config.js`, edits: [{ old_string: '(?!(lodash-es|date-fns)/)', new_string: '(?!(lodash-es)/)' }] }, 'Edited packages/billing/jest.config.js'),
  ...bash('Checking for duplicate swc versions after the bump.', 'toolu_7', 'npm ls @swc/core @swc/jest', 0, 'quillstack@0.0.0 /work/quillstack\n├─┬ @swc/cli@0.4.0\n│ └── @swc/core@1.9.3 deduped\n├── @swc/core@1.9.3\n└─┬ @swc/jest@0.2.39\n  └── @swc/core@1.9.3 deduped'),
  assistantText('One @swc/core everywhere, so no duplicate. Reinstalling node_modules from scratch in case the merge left it half-updated.'),
  ...bash('Clean install.', 'toolu_8', 'rm -rf node_modules && npm ci', 0, `${lines(9, (i) => `npm warn deprecated ${pick(['inflight@1.0.6', 'glob@7.2.3', 'abab@2.0.6', 'domexception@4.0.0'], i)}: ${pick(['This module is not supported, and leaks memory.', 'Glob versions prior to v9 are no longer supported', 'Use your platform\'s native atob() and btoa() methods instead', 'Use your platform\'s native DOMException instead'], i)}`)}\n\nadded 1877 packages, and audited 1878 packages in 1m\n\n301 packages are looking for funding\n  run \`npm fund\` for details\n\nfound 0 vulnerabilities`),
  ...bash('Tests after the clean install.', 'toolu_9', 'npm test -w packages/billing', 1, k5JestEsm(42013)),
  user('is the "caniuse-lite is outdated" warning anything? it\'s in every run'),
  assistantText('No. Browserslist prints it whenever its data is a few months old; it only affects CSS/JS targets in the ui build, not these tests. Ignoring it.'),
  ...bash('Checking the node and swc versions the tests run with.', 'toolu_10', 'node -v && npx swc --version', 0, 'v22.11.0\n@swc/cli: 0.4.0\n@swc/core: 1.9.3'),
  ...bash('Running one failing suite alone.', 'toolu_11', 'npx jest -c packages/billing/jest.config.js packages/billing/src/invoice/totals.test.ts', 1, 'FAIL packages/billing/src/invoice/totals.test.ts\n  ● Test suite failed to run\n    /work/quillstack/node_modules/date-fns/esm/index.js:1\n    SyntaxError: Unexpected token \'export\'\nTest Suites: 1 failed, 1 total'),
  ...bash('Same suite with the cache bypassed.', 'toolu_12', 'npx jest -c packages/billing/jest.config.js --no-cache packages/billing/src/invoice/totals.test.ts', 0, 'PASS packages/billing/src/invoice/totals.test.ts (3.41 s)\n  totals\n    ✓ sums lines (4 ms)\n    ✓ applies credit notes (2 ms)\n    ✓ rounds per line then total (1 ms)\n\nTest Suites: 1 passed, 1 total\nTests:       3 passed, 3 total'),
  assistantText('It passes with --no-cache, so a stale transform cache is serving output from before the bump. npm ci did not touch it, so the cache is not in node_modules.'),
  ...bash('Where the cache lives.', 'toolu_13', 'npx jest -c packages/billing/jest.config.js --showConfig | grep -E "cacheDirectory|\\"transform\\"" -A1', 0, '      "cacheDirectory": "/work/quillstack/.cache/jest",\n      "cache": true,\n      "transform": [\n        [\n          "^.+\\\\.(t|j)sx?$",\n          "/work/quillstack/node_modules/@swc/jest/index.js",'),
  ...bash('How old the cache is.', 'toolu_14', 'ls -la .cache/jest && du -sh .cache/jest', 0, 'total 24\ndrwxr-xr-x  5 dev dev 4096 Sep 12 09:14 .\ndrwxr-xr-x  3 dev dev 4096 Sep 12 09:14 ..\ndrwxr-xr-x  2 dev dev 4096 Nov 24 17:02 haste-map-billing-8f1e\ndrwxr-xr-x 66 dev dev 4096 Nov 24 17:02 jest-transform-cache-billing-8f1e\ndrwxr-xr-x  2 dev dev 4096 Nov 24 17:02 perf-cache-billing-8f1e\n1.4G\t.cache/jest'),
  assistantText('The transform cache is in .cache/jest at the repo root, last written before the merge. CI starts with an empty cache, which is why it was green there.'),
  user('wait, how does a cache survive a version bump? I thought jest keys the cache on the transformer'),
  assistantText('It keys on the transformer\'s getCacheKey. @swc/jest builds that key from the file, the jest config and its own options, not from the @swc/core version, so the new swc output never replaced the old entries.'),
  ...bash('Clearing the jest cache.', 'toolu_15', 'npx jest -c packages/billing/jest.config.js --clearCache', 0, 'Cleared /work/quillstack/.cache/jest'),
  ...bash('Full billing run.', 'toolu_16', 'npm test -w packages/billing', 1, K5_DST_FAIL),
  user('progress! those two look like timezone stuff. I\'m in Europe/Berlin.'),
  ...bash('Checking how CI sets the timezone.', 'toolu_17', 'grep -rn "TZ" .github/workflows/ci.yml package.json packages/billing/package.json', 0, '.github/workflows/ci.yml:14:      TZ: UTC'),
  ...bash('Confirming the local zone.', 'toolu_18', 'date +%Z && node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"', 0, 'CET\nEurope/Berlin'),
  ...bash('Running with TZ=UTC like CI.', 'toolu_19', 'TZ=UTC npm test -w packages/billing', 0, k5JestPass(36, 373, '19.82')),
  assistantText('With TZ=UTC every billing suite passes. CI sets TZ: UTC in its env, so these date tests only ever ran in UTC.'),
  user('should we make the tests timezone independent instead?'),
  assistantText('That would be the cleaner fix: pin the zone in the date helpers or in test/setup.ts. It touches about a dozen tests, so I would keep it separate from this.'),
  user('nah, not now. there\'s QS-1907 for that already. run the whole repo so we know the other packages are fine too'),
  ...bash('All workspaces.', 'toolu_20', 'TZ=UTC npm test --workspaces', 0, k5JestPass(88, 1204, '64.31')),
  user('since you\'re in there, the billing README still says `npm run test:billing` which doesn\'t exist anymore, fix that'),
  ...call('Finding the stale command.', 'toolu_21', 'grep', { pattern: 'test:billing', path: `${K5}` }, 'packages/billing/README.md:19:Run the tests with `npm run test:billing`.\ndocs/onboarding.md:44:- billing: `npm run test:billing`'),
  ...call('Fixing the README.', 'toolu_22', 'edit', { path: `${K5}/packages/billing/README.md`, edits: [{ old_string: 'Run the tests with `npm run test:billing`.', new_string: 'Run the tests with `npm test -w packages/billing`.' }] }, 'Edited packages/billing/README.md'),
  ...call('And the onboarding doc.', 'toolu_23', 'edit', { path: `${K5}/docs/onboarding.md`, edits: [{ old_string: '- billing: `npm run test:billing`', new_string: '- billing: `npm test -w packages/billing`' }] }, 'Edited docs/onboarding.md'),
  user('does CI cache the jest dir at all?'),
  ...call('Reading the CI workflow.', 'toolu_24', 'read', { path: `${K5}/.github/workflows/ci.yml` }, 'name: ci\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with: { node-version: 22, cache: npm }\n      - run: npm ci\n      - run: npm test --workspaces\n    env:\n      CI: true\n      TZ: UTC\n'),
  assistantText('No. CI caches only the npm download cache through setup-node; .cache/jest starts empty on every run.'),
  user('great, that\'s it. push the doc fix'),
  ...bash('Committing and pushing.', 'toolu_25', 'git add packages/billing/README.md docs/onboarding.md && git commit -m "docs(billing): current test command" && git push', 0, `[main ${hex(92)}d] docs(billing): current test command\n 2 files changed, 2 insertions(+), 2 deletions(-)\nTo github.com:quillstack/quillstack.git\n   ${hex(91)}c..${hex(92)}d  main -> main`),
];

// ---------------------------------------------------------------- k6

const K6 = '/work/brightdesk';

const K6_SPEC = rows(
  '# Ticket snooze',
  '',
  'An agent can snooze an open ticket until a date and time. A snoozed ticket:',
  '',
  '- is hidden from the inbox and from "My tickets" until `snoozedUntil`;',
  '- comes back on its own when the time passes (no job needed, the query filters it);',
  '- comes back early when the customer replies (the reply clears `snoozedUntil`);',
  '- shows a "Snoozed until ..." badge in the ticket view.',
  '',
  'API: `POST /api/tickets/:id/snooze` with `{ "until": ISO-8601 }`; `DELETE` to unsnooze.',
  'Only agents assigned to the ticket, or admins, can snooze it.',
);

const k6Vitest = (files: number, tests: number): string => rows(
  '',
  ' RUN  v2.1.5 /work/brightdesk',
  '',
  lines(files, (i) => ` ✓ src/${pick(['tickets/inbox-query', 'tickets/snooze', 'api/routes/tickets/assign', 'api/routes/tickets/snooze', 'tickets/model', 'customers/replies', 'auth/roles', 'ui/TicketView', 'search/index', 'sla/timers', 'notifications/email', 'macros/apply'], i)}.test.ts (${2 + (i * 7) % 19} tests) ${ms(i, 150)}ms`),
  '',
  ` Test Files  ${files} passed (${files})`,
  `      Tests  ${tests} passed (${tests})`,
  `   Duration  ${(1.4 + files * 0.22).toFixed(2)}s (transform 801ms, setup 212ms, collect 3.12s, tests 2.40s)`,
);

const K6_INBOX = rows(
  'import { sql } from \'kysely\';',
  'import type { Db } from \'../db\';',
  '',
  'export interface InboxFilter {',
  '  readonly agentId: string;',
  '  readonly status?: \'open\' | \'pending\';',
  '  readonly mine?: boolean;',
  '}',
  '',
  'export function inboxQuery(db: Db, filter: InboxFilter) {',
  '  let query = db',
  '    .selectFrom(\'tickets\')',
  '    .selectAll()',
  '    .where(\'status\', \'in\', filter.status ? [filter.status] : [\'open\', \'pending\'])',
  '    .orderBy(\'priority\', \'desc\')',
  '    .orderBy(\'updated_at\', \'desc\');',
  '  if (filter.mine) query = query.where(\'assignee_id\', \'=\', filter.agentId);',
  '  return query;',
  '}',
);

const K6_ASSIGN = rows(
  'import { z } from \'zod\';',
  'import { requireTicketAccess } from \'../../guards.js\';',
  'import type { Route } from \'../types.js\';',
  '',
  'const Body = z.object({ assigneeId: z.string().uuid() });',
  '',
  'export const assignRoute: Route = {',
  '  method: \'POST\',',
  '  path: \'/api/tickets/:id/assign\',',
  '  async handler(req, reply) {',
  '    const ticket = await requireTicketAccess(req, req.params.id);',
  '    const body = Body.parse(req.body);',
  '    const updated = await req.services.tickets.assign(ticket.id, body.assigneeId, req.agent.id);',
  '    return reply.send(updated);',
  '  },',
  '};',
);

const K6_SERVICE = rows(
  'import type { Db } from \'../db\';',
  'import type { EventBus } from \'../events\';',
  'import type { Ticket } from \'./model\';',
  'import { toTicket } from \'./model\';',
  '',
  'export class TicketService {',
  '  constructor(private readonly db: Db, private readonly events: EventBus) {}',
  '',
  lines(9, (i) => rows(
    `  async ${pick(['get', 'assign', 'close', 'reopen', 'setPriority', 'addTag', 'removeTag', 'merge', 'customerReplied'], i)}(${pick(['ticketId: string', 'ticketId: string, assigneeId: string, actorId: string', 'ticketId: string, actorId: string', 'ticketId: string, actorId: string', 'ticketId: string, priority: number', 'ticketId: string, tag: string', 'ticketId: string, tag: string', 'sourceId: string, targetId: string', 'ticketId: string, messageId: string'], i)}): Promise<${i === 0 ? 'Ticket' : 'void'}> {`,
    i === 8
      ? '    await this.db.updateTable(\'tickets\').set({ status: \'open\', updated_at: new Date() }).where(\'id\', \'=\', ticketId).execute();\n    await this.events.emit(\'customer.replied\', { ticketId });'
      : `    const row = await this.db.selectFrom('tickets').selectAll().where('id', '=', ${i === 7 ? 'sourceId' : 'ticketId'}).executeTakeFirstOrThrow();\n    ${i === 0 ? 'return toTicket(row);' : `await this.events.emit('ticket.${pick(['get', 'assigned', 'closed', 'reopened', 'prioritized', 'tagged', 'untagged', 'merged'], i)}', { ticketId: row.id });`}`,
    '  }',
    '',
  )),
  '}',
);

const K6_SESSION: readonly KodaXMessage[] = [
  user('Let\'s add snoozing to tickets: an agent can snooze a ticket until a date and it disappears from the inbox until then. Spec is in docs/specs/snooze.md. I already created the branch feat/ticket-snooze.'),
  ...call('Reading the spec.', 'toolu_1', 'read', { path: `${K6}/docs/specs/snooze.md` }, K6_SPEC),
  ...bash('Checking the branch.', 'toolu_2', 'git status -sb', 0, '## feat/ticket-snooze'),
  ...call('Listing the ticket module.', 'toolu_3', 'glob', { pattern: 'src/tickets/**' }, 'src/tickets/model.ts\nsrc/tickets/model.test.ts\nsrc/tickets/inbox-query.ts\nsrc/tickets/inbox-query.test.ts\nsrc/tickets/service.ts\nsrc/tickets/service.test.ts\nsrc/tickets/events.ts'),
  ...call('Reading the model.', 'toolu_4', 'read', { path: `${K6}/src/tickets/model.ts` }, 'export interface Ticket {\n  readonly id: string;\n  readonly subject: string;\n  readonly status: \'open\' | \'pending\' | \'solved\' | \'closed\';\n  readonly priority: number;\n  readonly assigneeId: string | null;\n  readonly customerId: string;\n  readonly createdAt: Date;\n  readonly updatedAt: Date;\n}\n'),
  ...call('Reading the inbox query.', 'toolu_5', 'read', { path: `${K6}/src/tickets/inbox-query.ts` }, K6_INBOX),
  ...call('Adding snoozedUntil to the model.', 'toolu_6', 'edit', { path: `${K6}/src/tickets/model.ts`, edits: [{ old_string: '  readonly assigneeId: string | null;', new_string: '  readonly assigneeId: string | null;\n  readonly snoozedUntil: Date | null;' }] }, 'Edited src/tickets/model.ts'),
  ...call('Migration for the column.', 'toolu_7', 'write', { path: `${K6}/migrations/0042_ticket_snooze.sql`, content: 'ALTER TABLE tickets ADD COLUMN snoozed_until timestamptz NULL;\nCREATE INDEX tickets_snoozed_until_idx ON tickets (snoozed_until) WHERE snoozed_until IS NOT NULL;\n' }, 'Wrote migrations/0042_ticket_snooze.sql (2 lines)'),
  ...call('Filtering snoozed tickets out of the inbox.', 'toolu_8', 'edit', { path: `${K6}/src/tickets/inbox-query.ts`, edits: [{ old_string: '    .orderBy(\'priority\', \'desc\')', new_string: '    .where((eb) => eb.or([eb(\'snoozed_until\', \'is\', null), eb(\'snoozed_until\', \'<=\', sql<Date>`now()`)]))\n    .orderBy(\'priority\', \'desc\')' }] }, 'Edited src/tickets/inbox-query.ts'),
  ...call('Snooze service functions.', 'toolu_9', 'write', { path: `${K6}/src/tickets/snooze.ts`, content: 'import type { Db } from \'../db\';\n\nexport async function snooze(db: Db, ticketId: string, until: Date): Promise<void> {\n  await db.updateTable(\'tickets\').set({ snoozed_until: until, updated_at: new Date() }).where(\'id\', \'=\', ticketId).execute();\n}\n\nexport async function unsnooze(db: Db, ticketId: string): Promise<void> {\n  await db.updateTable(\'tickets\').set({ snoozed_until: null, updated_at: new Date() }).where(\'id\', \'=\', ticketId).execute();\n}\n' }, 'Wrote src/tickets/snooze.ts (9 lines)'),
  ...call('Finding where customer replies land.', 'toolu_10', 'read', { path: `${K6}/src/tickets/service.ts` }, K6_SERVICE),
  ...call('Clearing the snooze when the customer replies.', 'toolu_11', 'edit', { path: `${K6}/src/tickets/service.ts`, edits: [{ old_string: '    await this.events.emit(\'customer.replied\', { ticketId });', new_string: '    await unsnooze(this.db, ticketId);\n    await this.events.emit(\'customer.replied\', { ticketId });' }] }, 'Edited src/tickets/service.ts'),
  ...bash('Typecheck.', 'toolu_12', 'npm run typecheck', 0, '\n> brightdesk@1.31.0 typecheck\n> tsc -p tsconfig.json --noEmit\n'),
  user('add an API route for it, same style as the assign route'),
  ...call('Reading the assign route.', 'toolu_13', 'read', { path: `${K6}/src/api/routes/tickets/assign.ts` }, K6_ASSIGN),
  ...call('Writing the snooze route.', 'toolu_14', 'write', { path: `${K6}/src/api/routes/tickets/snooze.ts`, content: 'import { z } from \'zod\';\nimport { requireTicketAccess } from \'../../guards.js\';\nimport { snooze, unsnooze } from \'../../../tickets/snooze.js\';\nimport type { Route } from \'../types.js\';\n\nconst Body = z.object({ until: z.coerce.date() });\n\nexport const snoozeRoute: Route = {\n  method: \'POST\',\n  path: \'/api/tickets/:id/snooze\',\n  async handler(req, reply) {\n    const ticket = await requireTicketAccess(req, req.params.id);\n    const body = Body.parse(req.body);\n    await snooze(req.db, ticket.id, body.until);\n    return reply.code(204).send();\n  },\n};\n\nexport const unsnoozeRoute: Route = {\n  method: \'DELETE\',\n  path: \'/api/tickets/:id/snooze\',\n  async handler(req, reply) {\n    const ticket = await requireTicketAccess(req, req.params.id);\n    await unsnooze(req.db, ticket.id);\n    return reply.code(204).send();\n  },\n};\n' }, 'Wrote src/api/routes/tickets/snooze.ts (27 lines)'),
  ...call('Registering the routes.', 'toolu_15', 'edit', { path: `${K6}/src/api/routes/tickets/index.ts`, edits: [{ old_string: 'export const ticketRoutes = [listRoute, getRoute, assignRoute, closeRoute];', new_string: 'export const ticketRoutes = [listRoute, getRoute, assignRoute, closeRoute, snoozeRoute, unsnoozeRoute];' }] }, 'Edited src/api/routes/tickets/index.ts'),
  ...bash('Ticket tests.', 'toolu_16', 'npx vitest run src/tickets src/api/routes/tickets', 0, k6Vitest(7, 64)),
  user('the mock says "Snoze" on the button, make sure our copy doesn\'t copy that typo. and the tooltip in the mock says "untill"'),
  ...call('Checking the i18n strings.', 'toolu_17', 'grep', { pattern: 'snoo?ze|untill', path: `${K6}/src/ui/i18n` }, 'src/ui/i18n/en.json:212:  "ticket.snooze.button": "Snoze",\nsrc/ui/i18n/en.json:213:  "ticket.snooze.tooltip": "Hide this ticket untill the date you pick",\nsrc/ui/i18n/de.json:212:  "ticket.snooze.button": "Zurückstellen",'),
  ...call('Fixing both strings.', 'toolu_18', 'edit', { path: `${K6}/src/ui/i18n/en.json`, edits: [{ old_string: '"ticket.snooze.button": "Snoze"', new_string: '"ticket.snooze.button": "Snooze"' }, { old_string: 'untill the date you pick', new_string: 'until the date you pick' }] }, 'Edited src/ui/i18n/en.json'),
  user('tests for the route?'),
  ...call('Route tests in the same style as assign.', 'toolu_19', 'write', { path: `${K6}/src/api/routes/tickets/snooze.test.ts`, content: 'import { describe, expect, it } from \'vitest\';\nimport { testApp } from \'../../../../test/app.js\';\n\ndescribe(\'snooze route\', () => {\n  it(\'hides the ticket from the inbox until the date\', async () => {\n    const app = await testApp();\n    const ticket = await app.seed.ticket({ assignee: app.agent });\n    await app.post(`/api/tickets/${ticket.id}/snooze`, { until: \'2030-01-01T00:00:00Z\' }).expect(204);\n    expect((await app.get(\'/api/inbox\')).body.map((t: { id: string }) => t.id)).not.toContain(ticket.id);\n  });\n\n  it(\'unsnoozes\', async () => {\n    const app = await testApp();\n    const ticket = await app.seed.ticket({ assignee: app.agent, snoozedUntil: new Date(\'2030-01-01\') });\n    await app.delete(`/api/tickets/${ticket.id}/snooze`).expect(204);\n    expect((await app.get(\'/api/inbox\')).body.map((t: { id: string }) => t.id)).toContain(ticket.id);\n  });\n\n  it(\'refuses agents without access\', async () => {\n    const app = await testApp();\n    const ticket = await app.seed.ticket({ assignee: app.otherAgent });\n    await app.post(`/api/tickets/${ticket.id}/snooze`, { until: \'2030-01-01T00:00:00Z\' }).expect(403);\n  });\n});\n' }, 'Wrote src/api/routes/tickets/snooze.test.ts (23 lines)'),
  ...bash('Running them.', 'toolu_20', 'npx vitest run src/api/routes/tickets', 0, k6Vitest(4, 31)),
  user('what happens if someone sends an until in the past?'),
  ...call('Checking the route body schema.', 'toolu_21', 'read', { path: `${K6}/src/api/routes/tickets/snooze.ts`, limit: 8 }, 'import { z } from \'zod\';\nimport { requireTicketAccess } from \'../../guards.js\';\nimport { snooze, unsnooze } from \'../../../tickets/snooze.js\';\nimport type { Route } from \'../types.js\';\n\nconst Body = z.object({ until: z.coerce.date() });\n'),
  assistantText('It is accepted: the ticket gets a past snoozedUntil and stays in the inbox, so the call silently does nothing. I would reject it with 422.'),
  user('yes, reject it with 422'),
  ...call('Rejecting past dates.', 'toolu_22', 'edit', { path: `${K6}/src/api/routes/tickets/snooze.ts`, edits: [{ old_string: 'const Body = z.object({ until: z.coerce.date() });', new_string: 'const Body = z.object({ until: z.coerce.date().refine((date) => date.getTime() > Date.now(), \'until must be in the future\') });' }] }, 'Edited src/api/routes/tickets/snooze.ts'),
  ...call('Test for it.', 'toolu_23', 'edit', { path: `${K6}/src/api/routes/tickets/snooze.test.ts`, edits: [{ old_string: '  it(\'refuses agents without access\'', new_string: '  it(\'rejects a date in the past\', async () => {\n    const app = await testApp();\n    const ticket = await app.seed.ticket({ assignee: app.agent });\n    await app.post(`/api/tickets/${ticket.id}/snooze`, { until: \'2001-01-01T00:00:00Z\' }).expect(422);\n  });\n\n  it(\'refuses agents without access\'' }] }, 'Edited src/api/routes/tickets/snooze.test.ts'),
  ...bash('Route tests.', 'toolu_24', 'npx vitest run src/api/routes/tickets', 0, k6Vitest(4, 32)),
  user('run lint and the full suite'),
  ...bash('Lint.', 'toolu_25', 'npm run lint', 0, '\n> brightdesk@1.31.0 lint\n> eslint . --max-warnings 0\n'),
  ...bash('Full suite.', 'toolu_26', 'npm test', 0, k6Vitest(48, 412)),
  user('push and open the PR'),
  ...bash('Committing and pushing.', 'toolu_27', 'git add -A && git commit -m "feat(tickets): snooze until a date" && git push -u origin feat/ticket-snooze', 0, `[feat/ticket-snooze ${hex(41)}e] feat(tickets): snooze until a date\n 10 files changed, 171 insertions(+), 4 deletions(-)\nbranch 'feat/ticket-snooze' set up to track 'origin/feat/ticket-snooze'.`),
  ...bash('Opening the PR.', 'toolu_28', 'gh pr create --fill --base main', 0, 'Creating pull request for feat/ticket-snooze into main in brightdesk/brightdesk\n\nhttps://github.com/brightdesk/brightdesk/pull/1187'),
  user('CI?'),
  ...bash('Watching the checks.', 'toolu_29', 'gh pr checks 1187 --watch', 0, 'All checks were successful\n0 cancelled, 0 failing, 4 successful, 0 skipped, and 0 pending checks\n\n✓  ci / lint        41s\n✓  ci / typecheck   1m02s\n✓  ci / test        2m48s\n✓  ci / migrations  37s'),
  user('good, merge it'),
  ...bash('Squash-merging.', 'toolu_30', 'gh pr merge 1187 --squash --delete-branch', 0, '✓ Squashed and merged pull request brightdesk/brightdesk#1187 (feat(tickets): snooze until a date)\n✓ Deleted local branch feat/ticket-snooze and switched to branch main\n✓ Deleted remote branch feat/ticket-snooze'),
  user('thanks!'),
];

// ---------------------------------------------------------------- cases

export const CAPTURE_CASES: readonly CaptureCase[] = [
  {
    id: 'k1',
    lang: 'EN',
    shape: 'release with a stale RELEASING.md; the env flag, migrate-before-deploy and CDN purge surface one failure at a time, interleaved with an urgent CSV bugfix',
    session: K1_SESSION,
    facts: [
      { label: 'build the release with RELEASE_BUILD=1', pattern: /RELEASE_BUILD=1/i },
      { label: 'run scripts/preflight.mjs on the build', pattern: /preflight/i },
      { label: 'run migrate:prod before deploy:prod (the deploy no longer migrates)', pattern: /migrate:prod/i },
      { label: 'purge the CDN after the deploy, before smoke', pattern: /cdn:purge/i },
    ],
    order: [/RELEASE_BUILD=1/i, /preflight/i, /migrate:prod/i, /deploy:prod/i, /cdn:purge/i, /smoke:prod/i],
    traps: [
      { label: 'the support ticket id', pattern: /LED-3310/ },
      { label: 'this release\'s migration and column', pattern: /settled_at|0087/ },
      { label: 'the CSV bugfix specifics', pattern: /invoices-csv|paidDate/ },
    ],
  },
  {
    id: 'k2',
    lang: 'ZH',
    shape: '中文重构会话；用户在问别的事时顺带说一次“以后别用 moment，统一用 dayjs”，本地测试需 CACHE_DRIVER=memory 是从失败输出里查出来的',
    session: K2_SESSION,
    facts: [
      { label: 'use dayjs, not moment, in new code (user rule)', pattern: /dayjs/i },
      { label: 'run tests (and the pre-commit hook) with CACHE_DRIVER=memory', pattern: /CACHE_DRIVER/i },
    ],
    order: [],
    traps: [
      { label: 'the requirement ticket id', pattern: /FZ-1182/ },
      { label: 'the new file layout of the refactor', pattern: /pricing\.ts|validation\.ts|persistence\.ts/ },
      { label: 'the debounce side question', pattern: /debounce|scheduleRecalc/i },
    ],
  },
  {
    id: 'k3',
    lang: 'EN',
    shape: 'feature session where ruff/pytest are "not found" but work under uv run; a NOAA fetch times out once and works on plain retry; the assistant wrongly says ruff is not installed',
    session: K3_SESSION,
    facts: [
      { label: 'run ruff, pytest and make check through uv run (tools are only in .venv)', pattern: /uv run/i },
      { label: 'do not install tools globally on this shared box (user rule)', pattern: /global/i },
    ],
    order: [],
    traps: [
      { label: 'the transient NOAA timeout and its retry', pattern: /ConnectTimeout|NOAA[^\n]{0,80}(?:time ?out|timed out|retr)/i },
      { label: 'the disproved "ruff is not installed" hypothesis', pattern: /ruff (?:is )?(?:not|isn't) installed|pipx install/i },
      { label: 'the ticket id and station id', pattern: /TP-207|9414290/ },
    ],
  },
  {
    id: 'k4',
    lang: 'ZH',
    shape: '中文 MySQL 变更：小表直接 ALTER、大表走 pt-online-schema-change 的分支，换表前校验，被 BI 长查询占锁、暂停 BI 后重试才成功',
    session: K4_SESSION,
    facts: [
      { label: 'tables under 5 million rows: ./ops/migrate.sh --plain', pattern: /--plain/i },
      { label: 'tables over 5 million rows: pt-online-schema-change', pattern: /pt-online-schema-change|pt-osc/i },
      { label: 'the 5 million row threshold', pattern: /500\s*万|5,000,000|5\s*million|five million|5M\s*rows/i },
      { label: 'pause BI report jobs with bi-pause.sh before a big-table change, do not kill', pattern: /bi-pause/i },
      { label: 'run pt-osc with --no-swap-tables and verify the shadow table before swapping', pattern: /verify-shadow/i },
    ],
    order: [/bi-pause/i, /--no-swap-tables/i, /verify-shadow/i, /swap\.sh/i, /bi-resume/i],
    traps: [
      { label: 'the ops ticket id', pattern: /OPS-552/ },
      { label: 'the BI query id of this session', pattern: /88213/ },
      { label: 'this change\'s column and index', pattern: /carrier_code|idx_carrier_created/ },
    ],
  },
  {
    id: 'k5',
    lang: 'EN',
    shape: 'long debugging after a Renovate bump; misleading ESM errors, a config edit and a clean npm ci lead nowhere; the gotchas are the jest cache in .cache/jest and TZ=UTC',
    session: K5_SESSION,
    facts: [
      { label: 'after a dependency bump clear the jest cache (.cache/jest, not in node_modules)', pattern: /clearCache|\.cache\/jest/i },
      { label: 'run the tests with TZ=UTC like CI', pattern: /TZ=UTC/i },
    ],
    order: [],
    traps: [
      { label: 'the follow-up ticket id', pattern: /QS-1907/ },
      { label: 'the exact failing test', pattern: /due-dates\.test|across DST/i },
      { label: 'the abandoned transformIgnorePatterns hypothesis', pattern: /transformIgnorePatterns/ },
      { label: 'the Renovate PR number', pattern: /#2291/ },
    ],
  },
  {
    id: 'k6',
    lang: 'EN',
    shape: 'control: an ordinary snooze feature, everything passes first time; nothing durable to learn',
    session: K6_SESSION,
    facts: [],
    order: [],
    traps: [
      { label: 'the branch name', pattern: /feat\/ticket-snooze/ },
      { label: 'what was changed', pattern: /snoozedUntil|snoozed_until|snooze\.ts/ },
      { label: 'the test count', pattern: /\b412\b/ },
      { label: 'the feature\'s file layout', pattern: /src\/tickets\/|src\/api\/routes/ },
    ],
  },
];

export const caseOf = (id: CaptureCase['id']): CaptureCase => {
  const found = CAPTURE_CASES.find((item) => item.id === id);
  if (found === undefined) throw new Error(`unknown capture case ${id}`);
  return found;
};
