/**
 * FEATURE_308 Phase 3: session 1 of each two-session chain.
 *
 * Session 2 is an existing read case (c1..c8 in feature-308-baseline). Here the
 * note it should read is NOT hand-written: a scripted session 1 containing the
 * user's own words goes through the real reflection job, and whatever notes come
 * out are what session 2 sees. The user's words in each session 1 are the same
 * facts the read case's hand-written seed used to carry.
 *
 * Case data only. Editing anything here changes the case hash pinned in runner.ts.
 */
import type { KodaXMessage } from '@kodax-ai/llm';

import { assistantCall, assistantText, fixTurn, toolResult, user } from '../feature-308-baseline/cases.js';

const PAGINATE_EN =
  'export function paginate<T>(items: T[], page: number, size: number): T[] {\n  const start = page * size;\n  const end = start + size - 1;\n  return items.slice(start, end);\n}\n';
const PAGINATE_ZH = 'def paginate(items, page, size):\n    start = page * size\n    end = start + size - 1\n    return items[start:end]\n';

const TESTS_EN: readonly KodaXMessage[] = [
  ...fixTurn(
    'src/pagination.ts',
    'The `paginate()` helper in src/pagination.ts drops the last item on the final page. Please fix it.',
    PAGINATE_EN,
    { old: 'const end = start + size - 1;', new: 'const end = start + size;' },
    'I changed the slice end index to `start + size`. I have not run the tests yet.',
  ),
  user('Go ahead and run them.'),
  assistantCall('Running the test suite.', 'toolu_bash_1', 'bash', { command: 'npm test', description: 'Run tests' }),
  toolResult('toolu_bash_1', '> vitest run\n 40 tests passed (integration suite skipped: no setup)\n'),
  assistantText('All 40 tests passed.'),
  user('No, not like that. In this repo tests must be run with `make check-fast`; bare `npm test` skips the integration setup. Please re-run it that way.'),
  assistantText('Understood, I will use `make check-fast` from now on.'),
];

const TESTS_ZH: readonly KodaXMessage[] = [
  ...fixTurn(
    'src/pagination.py',
    '`paginate()` 在最后一页会少一条数据,帮我修一下,文件是 src/pagination.py。',
    PAGINATE_ZH,
    { old: 'end = start + size - 1', new: 'end = start + size' },
    '已把切片终点改为 `start + size`,还没有跑测试。',
  ),
  user('跑一下测试。'),
  assistantCall('运行测试。', 'toolu_bash_1', 'bash', { command: 'pytest', description: '运行测试' }),
  toolResult('toolu_bash_1', '===== 38 passed, 2 skipped (integration fixtures not loaded) =====\n'),
  assistantText('测试全部通过。'),
  user('不对,这个项目运行测试一律使用 `just test-fast`,直接跑 pytest 会漏掉集成夹具。请用它重新跑一遍。'),
  assistantText('好的,以后一律用 `just test-fast` 运行测试。'),
];

const GENERATED_SCHEMA: readonly KodaXMessage[] = [
  user('Add a `nickname: string | null` field to the `User` type.'),
  assistantCall('Reading the generated type.', 'toolu_read_1', 'read', { path: '/work/project/src/generated/schema.ts' }),
  toolResult('toolu_read_1', 'export interface User {\n  id: string;\n  name: string;\n}\n'),
  assistantCall('Adding the field.', 'toolu_edit_1', 'edit', {
    path: '/work/project/src/generated/schema.ts',
    edits: [{ old_string: '  name: string;', new_string: '  name: string;\n  nickname: string | null;' }],
  }),
  toolResult('toolu_edit_1', 'Edited src/generated/schema.ts'),
  assistantText('I added `nickname` to the `User` interface in src/generated/schema.ts.'),
  user('Do not hand-edit src/generated/schema.ts. It is generated from schema.graphql by `npm run gen:schema`; change the .graphql file and regenerate instead.'),
  assistantText('Understood. I will revert that edit, change schema.graphql and run `npm run gen:schema`.'),
];

const RELEASE_CONVENTIONS: readonly KodaXMessage[] = [
  user('Please add a 2.3.0 entry to CHANGELOG.md listing the pagination fix.'),
  assistantCall('Reading the changelog.', 'toolu_read_1', 'read', { path: '/work/project/CHANGELOG.md' }),
  toolResult('toolu_read_1', '# Changelog\n\n## 2.2.0\n- Add export command\n'),
  assistantCall('Adding the entry.', 'toolu_edit_1', 'edit', {
    path: '/work/project/CHANGELOG.md',
    edits: [{ old_string: '# Changelog\n', new_string: '# Changelog\n\n## 2.3.0\n- Fix the last-page item loss in paginate()\n' }],
  }),
  toolResult('toolu_edit_1', 'Edited CHANGELOG.md'),
  assistantText('Added the 2.3.0 entry.'),
  user('Thanks. For the future: commit messages in this repo use the imperative mood and no trailing period, and the docs site is deployed from the gh-pages branch by the release workflow, so never push to gh-pages by hand.'),
  assistantText('Noted, I will follow both.'),
];

const YARN_DECLARED: readonly KodaXMessage[] = [
  user('Add the `lodash` dependency.'),
  assistantCall('Adding it.', 'toolu_bash_1', 'bash', { command: 'yarn add lodash', description: 'Add lodash' }),
  toolResult('toolu_bash_1', 'success Saved lockfile.\nsuccess Saved 1 new dependency.\n'),
  assistantText('Added lodash.'),
  user('Good. For future reference: this project uses yarn, so dependencies are added with `yarn add`.'),
  assistantText('Understood.'),
];

/** Session 1 per session-2 read case. c6/c7 reuse c1/c3's session 1 (the same lesson, a 40-note store). */
export const SESSION_ONE: Readonly<Record<'c1' | 'c3' | 'c4' | 'c5' | 'c6' | 'c7' | 'c8', readonly KodaXMessage[]>> = {
  c1: TESTS_EN,
  c3: TESTS_ZH,
  c4: RELEASE_CONVENTIONS,
  c5: YARN_DECLARED,
  c6: TESTS_EN,
  c7: TESTS_ZH,
  c8: GENERATED_SCHEMA,
};

export type TwoSessionCaseId = keyof typeof SESSION_ONE;
export const TWO_SESSION_CASE_IDS = Object.keys(SESSION_ONE) as readonly TwoSessionCaseId[];
