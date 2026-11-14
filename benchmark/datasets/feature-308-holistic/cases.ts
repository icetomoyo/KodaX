/**
 * FEATURE_308 holistic experiment: case data for the two stages after a note is written.
 *
 *   confirm  The second session. A candidate the reflection job wrote in session one
 *            sits in a 40-note store, hidden from the index. The agent meets the same
 *            situation again, and the real reflection job reads that session. A durable
 *            lesson should be confirmed, a one-off workaround left alone, and a wrong
 *            conclusion corrected. One case confirms a user-scope candidate from a
 *            different project.
 *   use      The session after confirmation. Each durable lesson is active in a store
 *            with 39 other notes, and the agent gets an ordinary request where the
 *            lesson matters. The note's index line is the old style, the rule style,
 *            or absent; the body is the same in both styles, so only the line differs.
 *
 * Every candidate and index line is a note the reflection model actually wrote in the
 * f308-notelines-r3 run, taken as the first real write in a fixed chain order
 * (k27 r1, glm52 r1, v4flash r1, k27 r2, ...). Arm B of that run is the shipped prompt,
 * arm A the old one. The sessions continue the inferred-lesson cases, which are
 * modelled on recoveries mined from the owner's agent session logs (paraphrased).
 *
 * Case data only. Editing anything here changes the case hash recorded by prepare.
 */
import type { NewNote, NoteScope } from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/llm';

import { assistantCall, assistantText, toolResult, user } from '../feature-308-baseline/cases.js';
import { INFERRED_CASES, type InferredCase } from '../feature-308-inferred/cases.js';

/** What the reflection job should do with the candidate after the second session. */
export type ConfirmExpectation =
  /** The lesson held again: confirm it. */
  | 'confirm'
  /** Nothing in the session bears on it: leave it a candidate. Confirming it is harm. */
  | 'leave'
  /** The session shows it is wrong: dispute or rewrite it. Confirming it is harm. */
  | 'correct'
  /** The same misreading happened again: measures what quarantine cannot catch. */
  | 'repeat';

export interface ConfirmCase {
  readonly id: string;
  readonly expect: ConfirmExpectation;
  /** For the reviewer only: what is actually true. */
  readonly truth: string;
  /** The candidate as session one stored it. */
  readonly candidate: NewNote;
  /** Store holding the candidate. */
  readonly scope: NoteScope;
  /** Project the second session runs in; the candidate came from `p1`. */
  readonly project: 'p1' | 'p2';
  readonly session: readonly KodaXMessage[];
}

export interface UseCase {
  readonly id: string;
  /** The inferred case whose session two, world and oracle this stage reuses. */
  readonly base: InferredCase;
  readonly noteId: string;
  /** Index line the old reflection prompt wrote. */
  readonly oldLine: string;
  /** Index line the shipped reflection prompt wrote. */
  readonly ruleLine: string;
  readonly body: string;
}

export const SESSION_ONE = 'session-one';
export const ORIGIN_PROJECT = 'p1';

function shell(command: string, exit: number, stdout: string, stderr = ''): string {
  return `Command: ${command}\nExit: ${exit}\n${stdout}${stderr.length > 0 ? `\n[stderr]\n${stderr}` : ''}`;
}

let callCounter = 0;
function bash(intro: string, command: string, exit: number, stdout: string, stderr = ''): KodaXMessage[] {
  callCounter += 1;
  const id = `toolu_hl_bash_${callCounter}`;
  return [assistantCall(intro, id, 'bash', { command, description: intro }), toolResult(id, shell(command, exit, stdout, stderr))];
}

function read(intro: string, file: string, content: string): KodaXMessage[] {
  callCounter += 1;
  const id = `toolu_hl_read_${callCounter}`;
  return [assistantCall(intro, id, 'read', { path: `/work/project/${file}` }), toolResult(id, content)];
}

const base = (id: string): InferredCase => INFERRED_CASES.find((item) => item.id === id)!;

/** The inferred case's second session up to the request, as the user sent it. */
const opening = (id: string): KodaXMessage[] => [...base(id).sessionTwo.history, user(base(id).sessionTwo.userMessage)];

const FNM_BIN = '$HOME/.local/share/fnm/node-versions/v22.11.0/installation/bin';
const NOT_FOUND = (tool: string): string => `bash: line 1: ${tool}: command not found`;

// ------------------------------------------------------------------ candidates (shipped prompt, r3 arm B)

const inferred = (note: Omit<NewNote, 'status' | 'source' | 'session'>): NewNote => ({ ...note, status: 'candidate', source: 'inferred', session: SESSION_ONE });

const NODE_PATH_NOTE = inferred({
  id: 'fnm-node-path',
  type: 'project',
  description: 'When npx or node are missing from PATH, prepend the fnm-installed Node bin directory before running Node commands.',
  why: 'Running `npx vitest run src/text/slug.test.ts` failed with `bash: line 1: npx: command not found`, but `ls ~/.local/share/fnm/node-versions` showed v22.11.0 was installed, and adding its bin directory let the test command succeed.',
  body: 'This project\'s shell does not automatically load fnm, so npx/node may not be in PATH. The installed version used in this session was Node v22.11.0 at ~/.local/share/fnm/node-versions/v22.11.0/installation/bin. Prepending that directory to PATH (e.g. `export PATH="$HOME/.local/share/fnm/node-versions/v22.11.0/installation/bin:$PATH"`) makes npx and node available.',
});

const VITEST_ROOT_NOTE = inferred({
  id: 'run-vitest-from-root',
  type: 'project',
  description: 'Run vitest from the repository root because only the root has a vitest.config.ts',
  why: 'Session evidence shows that `cd packages/cli && npx vitest run src/format.test.ts` failed with "Failed to load url ./bin.js" and "SyntaxError: Invalid or unexpected token" at the shebang in src/bin.ts, and `ls packages/cli/vitest.config.* vitest.config.*` found only `vitest.config.ts` at root. Running the same test from the root with `npx vitest run packages/cli/src/format.test.ts` passed all 9 tests.',
  body: 'The project has a single vitest.config.ts at the repository root and none under packages/cli. Running `cd packages/cli && npx vitest run src/format.test.ts` fails with a shebang load error, while `npx vitest run packages/cli/src/format.test.ts` from the root succeeds.',
});

const TSC_ROOT_NOTE = inferred({
  id: 'e2e-typecheck-command',
  type: 'project',
  description: 'Typecheck e2e tests with `npx tsc -p tsconfig.check.json --noEmit` from the project root',
  why: '`cd tests/e2e && npx tsc --noEmit` failed with `error TS5057: Cannot find a tsconfig.json file at the specified directory: \'.\'`. A grep showed `tests/e2e` is referenced in `tsconfig.check.json`, and `npx tsc -p tsconfig.check.json --noEmit` from the root exited 0.',
  body: 'Running `npx tsc --noEmit` inside `tests/e2e` fails because that directory has no `tsconfig.json`. The e2e folder is included by `tsconfig.check.json` at the project root, so typecheck e2e changes from the project root using that project file.',
});

const GH_JQ_NOTE = inferred({
  id: 'jq-missing-use-gh-jq',
  type: 'project',
  description: 'Use gh\'s built-in --jq flag instead of piping to jq; jq is not on this machine\'s PATH.',
  why: '`jq: command not found` (exit 127) for a piped gh command, then the identical filter succeeded with gh\'s --jq flag.',
  body: 'jq is not on PATH in this shell, but the GitHub CLI supports its own --jq flag for JSON filtering. Use e.g. `gh pr list --json number,title --jq \'.[] | ...\'` instead of piping to jq, which fails with "jq: command not found".',
});

const TLS_PROXY_NOTE = inferred({
  id: 'git-fetch-proxy-retry',
  type: 'procedure',
  description: 'When git fetch fails with OpenSSL SSL_read connection reset, retry with proxy env vars unset.',
  why: 'The session\'s git fetch to github.com/acme/reports failed with \'fatal: unable to access ... OpenSSL SSL_read: Connection reset by peer, errno 104\', and retrying as `env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy git fetch origin main` succeeded and fetched origin/main 9c1e2aa..41f07bd. The proxy environment variables were the cause.',
  body: 'When `git fetch` against the remote fails with an OpenSSL SSL_read connection-reset error, the proxy environment variables are likely interfering. Retry the same fetch with the proxy variables unset:\n\n    env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy git fetch <remote> <branch>\n\nThis unset the four proxy vars (both case variants) and the fetch succeeded, allowing the rebase to proceed.',
});

const UI_KIT_NOTE = inferred({
  id: 'acme-ui-kit-3-local',
  type: 'project',
  description: 'To test against @acme/ui-kit 3.0.0, install from the sibling ../ui-kit checkout because 3.0.0 is not published to the registry.',
  why: '`npm view @acme/ui-kit@3.0.0 version` returned E404, while `grep -m1 \'"version"\' ../ui-kit/package.json` showed `"version": "3.0.0"`. After installing from ../ui-kit, `npx tsc --noEmit` passed.',
  body: 'The published registry has no @acme/ui-kit@3.0.0, but the sibling checkout at ../ui-kit is at version 3.0.0. Install it with `npm install ../ui-kit`, then run `npx tsc --noEmit` to verify the app compiles, including the Button import.',
});

const DB_UNIT_NOTE = inferred({
  id: 'integration-tests-need-postgres',
  type: 'reference',
  description: 'When running tests without a reachable Postgres, run the unit project only: npx vitest run --project unit.',
  why: 'In this session npm test failed because the integration file test/integration/orders.int.test.ts could not reach Postgres (connect ECONNREFUSED 127.0.0.1:5432). The unit project passed all 12 tests.',
  check: 'Verify the integration test still expects a live Postgres by reading test/integration/orders.int.test.ts or checking the vitest project config.',
  body: 'The full test suite (npm test) includes test/integration/orders.int.test.ts, which needs a Postgres server at 127.0.0.1:5432. When Postgres is not running, npm test fails on that file. To verify unit tests without a database, run `npx vitest run --project unit` instead.',
});

const PYTHON_FALLBACK_NOTE = inferred({
  id: 'count-todos-python-fallback',
  type: 'project',
  description: 'When node is not found in this shell, count TODO comments per package with python3 instead of running scripts/count-todos.mjs.',
  why: 'This session ran `node scripts/count-todos.mjs` and got exit 127 with "node: command not found", then `command -v python3` succeeded (Python 3.12.3) and the python3 one-liner produced the count.',
  body: 'On this machine, `node` is not on PATH, but `python3` (3.12) is. When a task needs to run scripts/count-todos.mjs (or any Node work), use a python3 equivalent. For counting TODO comments per package, this worked: count files under packages/*/ by the first path part whose .ts content contains \'TODO\'.\n\nDo not assume node is globally installed just because a script exists in the repo; check `command -v node` first and fall back to python3.',
});

// ------------------------------------------------------------------ confirm stage

const BILLING_PASS = ' RUN  v4.1.11 /work/project\n\n ✓ src/billing/invoice.test.ts (1 test) 2ms\n ✓ src/billing/tax.test.ts (1 test) 1ms\n\n Test Files  2 passed (2)\n      Tests  2 passed (2)\n';

const FULL_SUITE_PASS = '> orders@1.0.0 test\n> vitest run\n\n ✓ src/db/orders.test.ts (5 tests)\n ✓ src/reports/daily.test.ts (7 tests)\n ✓ test/integration/orders.int.test.ts (3 tests)\n\n Test Files  3 passed (3)\n      Tests  15 passed (15)\n';

const CONFIRM_NODE_PATH: ConfirmCase = {
  id: 'c-node-path',
  expect: 'confirm',
  truth: base('d-node-path').truth,
  candidate: NODE_PATH_NOTE,
  scope: 'project',
  project: 'p1',
  session: [
    ...opening('d-node-path'),
    ...bash('Running the billing tests.', 'npx vitest run src/billing', 127, '', NOT_FOUND('npx')),
    ...bash('npx is not on PATH. Looking for a Node version manager.', 'ls ~/.local/share/fnm/node-versions 2>/dev/null; command -v fnm', 0, 'v22.11.0\n'),
    ...bash('fnm has Node 22. Putting its bin directory on PATH for this command.', `export PATH="${FNM_BIN}:$PATH" && npx vitest run src/billing`, 0, BILLING_PASS),
    assistantText('Nothing broke: both billing test files pass (2 tests).'),
  ],
};

/** The same machine lesson, filed under the user scope in p1, meets a second repository. */
const CONFIRM_NODE_PATH_OTHER_PROJECT: ConfirmCase = {
  id: 'c-node-path-other-project',
  expect: 'confirm',
  truth: `${base('d-node-path').truth} The candidate was proposed in another repository on this machine.`,
  candidate: { ...NODE_PATH_NOTE, project: ORIGIN_PROJECT },
  scope: 'user',
  project: 'p2',
  session: [
    user('Which Node version does this docs site expect?'),
    ...read('Reading the version pin.', '.nvmrc', '22\n'),
    assistantText('The site pins Node 22 in .nvmrc.'),
    user('OK. Run the lint script on src and tell me what it flags.'),
    ...bash('Running the linter.', 'npm run lint -- src', 127, '', NOT_FOUND('npm')),
    ...bash('npm is not on PATH. Checking for a Node version manager.', 'ls ~/.local/share/fnm/node-versions 2>/dev/null; command -v fnm', 0, 'v22.11.0\n'),
    ...bash('Node 22 is installed through fnm. Running the lint with its bin directory on PATH.', `export PATH="${FNM_BIN}:$PATH" && npm run lint -- src`, 0,
      '> docs-site@1.2.0 lint\n> eslint src\n\n/work/project/src/nav.ts\n  14:7  warning  \'unused\' is assigned a value but never used  no-unused-vars\n\n✖ 1 problem (0 errors, 1 warning)\n'),
    assistantText('Lint flags one warning: an unused variable in src/nav.ts at line 14. No errors.'),
  ],
};

const CONFIRM_VITEST_ROOT: ConfirmCase = {
  id: 'c-vitest-root',
  expect: 'confirm',
  truth: base('d-vitest-root').truth,
  candidate: VITEST_ROOT_NOTE,
  scope: 'project',
  project: 'p1',
  session: [
    ...opening('d-vitest-root'),
    ...bash('Running the server package tests.', 'cd packages/server && npx vitest run', 1,
      ' RUN  v4.1.11 /work/project/packages/server\n\n FAIL  src/routes/health.test.ts\nError: Failed to load url ./bin.js (resolved id: ./bin.js). Does the file exist?\nSyntaxError: Invalid or unexpected token\n ❯ src/bin.ts:1:1\n      1| #!/usr/bin/env node\n\n Test Files  1 failed (1)\n'),
    ...bash('The run failed while loading the shebang file. Checking where the vitest config lives.', 'ls packages/server/vitest.config.* vitest.config.* 2>/dev/null', 0, 'vitest.config.ts\n'),
    ...bash('Only the root has one. Running from the root with the package path.', 'npx vitest run packages/server', 0,
      ' RUN  v4.1.11 /work/project\n\n ✓ packages/server/src/routes/health.test.ts (1 test) 3ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n'),
    assistantText('The server package tests pass (1 test in health.test.ts).'),
  ],
};

const CONFIRM_TSC_ROOT: ConfirmCase = {
  id: 'c-tsc-root',
  expect: 'confirm',
  truth: base('d-tsc-root').truth,
  candidate: TSC_ROOT_NOTE,
  scope: 'project',
  project: 'p1',
  session: [
    ...opening('d-tsc-root'),
    ...bash('Typechecking the e2e folder.', 'npx tsc --noEmit -p tests/e2e', 1, '', "error TS5057: Cannot find a tsconfig.json file at the specified directory: 'tests/e2e'.\n"),
    ...bash('No tsconfig there. Looking for the config that includes the tests.', 'grep -ln "tests" tsconfig*.json', 0, 'tsconfig.check.json\n'),
    ...bash('Typechecking with that config from the root.', 'npx tsc -p tsconfig.check.json --noEmit', 0, ''),
    assistantText('auth.ts typechecks cleanly. The e2e folder is covered by tsconfig.check.json, so that is the config I used.'),
  ],
};

const CONFIRM_GH_JQ: ConfirmCase = {
  id: 'c-gh-jq',
  expect: 'confirm',
  truth: base('d-gh-jq').truth,
  candidate: GH_JQ_NOTE,
  scope: 'project',
  project: 'p1',
  session: [
    ...opening('d-gh-jq'),
    ...bash('Listing the last 20 runs on main and keeping the failed ones.',
      "gh run list --branch main -L 20 --json databaseId,conclusion | jq -r '.[] | select(.conclusion == \"failure\") | .databaseId' > failed-runs.txt", 127, '', NOT_FOUND('jq')),
    ...bash('jq is not installed. gh can apply the same filter itself.',
      "gh run list --branch main -L 20 --json databaseId,conclusion --jq '.[] | select(.conclusion == \"failure\") | .databaseId' > failed-runs.txt", 0, ''),
    ...bash('Checking the file.', 'cat failed-runs.txt', 0, '11874213\n11869902\n11861377\n'),
    assistantText('Three of the last 20 runs on main failed. Their ids are in failed-runs.txt, one per line.'),
  ],
};

const LEAVE_TLS_PROXY: ConfirmCase = {
  id: 'c-tls-proxy',
  expect: 'leave',
  truth: base('s-tls-proxy').truth,
  candidate: TLS_PROXY_NOTE,
  scope: 'project',
  project: 'p1',
  session: [
    ...opening('s-tls-proxy'),
    ...bash('Pulling main.', 'git pull --ff-only origin main', 0,
      'Updating 41f07bd..b7d3e90\nFast-forward\n src/export/csv.ts | 6 ++++--\n 1 file changed, 4 insertions(+), 2 deletions(-)\n',
      'From https://github.com/acme/reports\n * branch            main       -> FETCH_HEAD'),
    ...bash('Confirming where main is now.', 'git log --oneline -1', 0, 'b7d3e90 Quote CSV fields that contain commas\n'),
    assistantText('main is up to date at b7d3e90 ("Quote CSV fields that contain commas"), a fast-forward of one file.'),
  ],
};

const CORRECT_UI_KIT: ConfirmCase = {
  id: 'c-ui-kit-published',
  expect: 'correct',
  truth: base('s-unpublished-version').truth,
  candidate: UI_KIT_NOTE,
  scope: 'project',
  project: 'p1',
  session: [
    ...opening('s-unpublished-version'),
    ...bash('Checking which versions the registry has.', 'npm view @acme/ui-kit versions --json', 0, '[\n  "2.9.4",\n  "3.0.0",\n  "3.0.1"\n]\n'),
    ...bash('3.0.1 is published. Installing it from the registry instead of the sibling checkout.', 'npm install @acme/ui-kit@3.0.1', 0,
      'changed 1 package, and audited 214 packages in 4s\n\nfound 0 vulnerabilities\n'),
    ...bash('Checking the dependency now points at the registry.', 'grep -n "ui-kit" package.json', 0, '14:    "@acme/ui-kit": "^3.0.1",\n'),
    ...bash('Building.', 'npm run build', 0, '> storefront-app@0.4.0 build\n> tsc -b && vite build\n\n✓ 412 modules transformed.\n✓ built in 3.21s\n'),
    assistantText('@acme/ui-kit now comes from the registry at ^3.0.1 instead of ../ui-kit, and the app builds. The registry lists 3.0.0 and 3.0.1.'),
  ],
};

const LEAVE_DB_RUNNING: ConfirmCase = {
  id: 'c-db-running',
  expect: 'leave',
  truth: base('s-db-down').truth,
  candidate: DB_UNIT_NOTE,
  scope: 'project',
  project: 'p1',
  session: [
    ...opening('s-db-down'),
    ...bash('Running the whole suite.', 'npm test', 0, FULL_SUITE_PASS),
    assistantText('The whole suite passes: 15 tests in 3 files, the integration tests included.'),
  ],
};

const CORRECT_DB_STOPPED: ConfirmCase = {
  id: 'c-db-stopped-again',
  expect: 'correct',
  truth: `${base('s-db-down').truth} When the container is stopped, \`npm run db:up\` starts it.`,
  candidate: DB_UNIT_NOTE,
  scope: 'project',
  project: 'p1',
  session: [
    ...opening('s-db-down'),
    ...bash('Running the whole suite.', 'npm test', 1,
      '> orders@1.0.0 test\n> vitest run\n\n ✓ src/db/orders.test.ts (5 tests)\n ✓ src/reports/daily.test.ts (7 tests)\n ✗ test/integration/orders.int.test.ts (0 test)\nError: connect ECONNREFUSED 127.0.0.1:5432\n\n Test Files  1 failed | 2 passed (3)\n'),
    ...bash('Postgres is not reachable. Checking the database container.', 'docker compose ps postgres', 0, 'NAME      IMAGE     COMMAND   SERVICE   CREATED   STATUS    PORTS\n'),
    ...bash('The container is not running. Starting it with the repo script.', 'npm run db:up', 0,
      '> orders@1.0.0 db:up\n> docker compose up -d postgres\n\n', ' Container orders-postgres  Started'),
    ...bash('Running the whole suite again.', 'npm test', 0, FULL_SUITE_PASS),
    assistantText('The Postgres container was stopped. After `npm run db:up` the whole suite passes: 15 tests in 3 files, the integration tests included.'),
  ],
};

const CHECK_LINKS = (prefix: string): string => `${prefix}node scripts/check-links.mjs docs`;

const CORRECT_NODE_FOUND: ConfirmCase = {
  id: 'c-node-found',
  expect: 'correct',
  truth: base('m-node-not-installed').truth,
  candidate: PYTHON_FALLBACK_NOTE,
  scope: 'project',
  project: 'p1',
  session: [
    ...opening('m-node-not-installed'),
    ...bash('Running the link checker.', CHECK_LINKS(''), 127, '', NOT_FOUND('node')),
    ...bash('node is not on PATH. Checking for a Node version manager before anything else.', 'ls ~/.local/share/fnm/node-versions 2>/dev/null; command -v fnm', 0, 'v22.11.0\n'),
    ...bash('Node 22 is installed through fnm. Running the checker with its bin directory on PATH.', CHECK_LINKS(`export PATH="${FNM_BIN}:$PATH" && `), 1, 'index.md -> deploy.md\n'),
    assistantText('One broken link: docs/index.md points to deploy.md, which does not exist. Node is installed here through fnm; this shell just does not have it on PATH.'),
  ],
};

const REPEAT_PYTHON: ConfirmCase = {
  id: 'c-python-again',
  expect: 'repeat',
  truth: base('m-node-not-installed').truth,
  candidate: PYTHON_FALLBACK_NOTE,
  scope: 'project',
  project: 'p1',
  session: [
    ...opening('m-node-not-installed'),
    ...bash('Running the link checker.', CHECK_LINKS(''), 127, '', NOT_FOUND('node')),
    ...bash('Node is not available here. Checking the links with Python instead.',
      'python3 -c "import pathlib,re; d=pathlib.Path(\'docs\'); [print(f\'{p.relative_to(d)} -> {t}\') for p in d.rglob(\'*.md\') for t in re.findall(r\'\\]\\((?!https?:)([^)#]+)\', p.read_text()) if not (p.parent / t).exists()]"', 0,
      'index.md -> deploy.md\n'),
    assistantText('Node is not installed on this machine, so I checked the links with Python: one is broken, docs/index.md -> deploy.md.'),
  ],
};

export const CONFIRM_CASES: readonly ConfirmCase[] = Object.freeze([
  CONFIRM_NODE_PATH, CONFIRM_NODE_PATH_OTHER_PROJECT, CONFIRM_VITEST_ROOT, CONFIRM_TSC_ROOT, CONFIRM_GH_JQ,
  LEAVE_TLS_PROXY, LEAVE_DB_RUNNING, CORRECT_UI_KIT, CORRECT_DB_STOPPED, CORRECT_NODE_FOUND, REPEAT_PYTHON,
]);

// ------------------------------------------------------------------ use stage

/** Old lines are the r3 arm-A write chosen by the same chain order as the rule lines. */
export const USE_CASES: readonly UseCase[] = Object.freeze([
  {
    id: 'u-node-path',
    base: base('d-node-path'),
    noteId: NODE_PATH_NOTE.id,
    oldLine: 'Node is installed via fnm but not on PATH in new shells',
    ruleLine: NODE_PATH_NOTE.description,
    body: NODE_PATH_NOTE.body,
  },
  {
    id: 'u-vitest-root',
    base: base('d-vitest-root'),
    noteId: VITEST_ROOT_NOTE.id,
    oldLine: 'Run packages/cli tests from repository root, not from inside the package',
    ruleLine: VITEST_ROOT_NOTE.description,
    body: VITEST_ROOT_NOTE.body,
  },
  {
    id: 'u-tsc-root',
    base: base('d-tsc-root'),
    noteId: TSC_ROOT_NOTE.id,
    oldLine: 'Typecheck e2e specs from the repo root with tsconfig.check.json, not from tests/e2e',
    ruleLine: TSC_ROOT_NOTE.description,
    body: TSC_ROOT_NOTE.body,
  },
  {
    id: 'u-gh-jq',
    base: base('d-gh-jq'),
    noteId: GH_JQ_NOTE.id,
    oldLine: 'jq is not installed; use gh\'s built-in --jq flag instead of piping to jq',
    ruleLine: GH_JQ_NOTE.description,
    body: GH_JQ_NOTE.body,
  },
]);
