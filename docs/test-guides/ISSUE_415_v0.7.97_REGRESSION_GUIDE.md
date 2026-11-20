# Issue 415 — Skill over-trigger and Actor over-spawn

Covers Issue 415: ordinary requests started with a Skill search, and weak models
loaded unrelated Skills. It also covers the Actor capacity change made in the
same pass: the Worker started more child Agents than were free.

## Automated coverage

| Check | Where it runs |
| --- | --- |
| The assembled first-turn request keeps each Skill condition: catalog "must" only on a clear match, no-match path, slash/args handling, guessed names fail | `tests/skill-trigger-surface.test.ts` |
| Compact and canonical Worker system text match their audited hashes | `packages/coding/src/prompts/managed-system-contract.test.ts`, `tests/restructured-worker-contract.test.ts` |
| ACTOR CAPACITY states the child limit and the free count, a single-slot session gets one line, and no capacity block appears without `spawn_agent` | `packages/coding/src/agents/worker-role-prompt.test.ts` |
| A full tree shows "No child slot is free right now" on the first request and in the runtime refresh | `packages/coding/src/task-engine/runner-driven.test.ts`, `tests/contract-activation-capacity.test.ts` |
| A rejected `spawn_agent` returns `agent_limit_reached` with the next-step hint and creates no Actor | `packages/coding/src/tools/agent-collaboration.test.ts` |

## Manual verification

Use a non-thinking model that showed the problem, such as `glm-5.3-flash` or
`deepseek-flash`, in a Git workspace with a few uncommitted changes.

1. Ask an ordinary operations question, e.g. "请帮我用 Docker 安装 RPM 的离线包".

   Expected: no `skill` call. The answer does not mention Skills.

2. Ask a knowledge question, e.g. "git rebase 和 merge 有什么区别".

   Expected: a direct answer. Usually there is no `bash` or `read` call.

3. Ask "请 review 下当前未提交的改动".

   Expected: the first tool call is `skill` with `code-review`.

4. Ask "把当前的改动提交并推送".

   Expected: the first tool call is `skill` with `git-workflow`.

5. Ask for a broad review of a large change set. Wait until three reviewers run,
   then ask "Also cover security, performance and documentation."

   Expected: no new `spawn_agent` while all child slots are busy. The Worker
   covers the new areas itself or says it will start them when a slot frees.

6. Repeat steps 1, 3 and 4 in Agent and Script work modes.

   Expected: the same Skill behavior. In Script mode, the reply does not call
   `read` or `grep` as native tools.

## Eval record

The paid evals ran on `glm-5.3-flash`, `deepseek-flash` and `kimi-for-coding`,
using production request bytes, with preregistered metrics and blind review.
Results are in the fix commits: 4788f47a9, 36fac9eeb, 068b89d15 and d02236f84.
