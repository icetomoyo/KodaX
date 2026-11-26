# FEATURE_308 v0.8.10 Human Test Guide

> Feature: Note memory and skill learning redesign
>
> Status: Implemented on `KodaX-next-dev`, on by default; not yet released
>
> Date: 2026-11-15
>
> Decision: [ADR-076](../ADR.md#adr-076-note-memory-replaces-the-governed-memory-plane).
> Design: [HLD §10](../HLD.md#10-note-memory), [DD §14](../DD.md#14-note-memory).

## 1. Test Goal

Verify that notes carry what a user stated across sessions, that inferred
notes wait as candidates, that reflection after a run writes and corrects
notes within its limits, that legacy memories convert once, and that
`KODAX_MEMORY_NOTES=0` restores the legacy memory.

Use a throwaway agent home so real notes are untouched:

```bash
export KODAX_HOME="$(mktemp -d)"
```

## 2. Automated Checks

Run from the repository root (package directories give false failures):

```bash
npm run build:packages && npm run build:native
npx vitest run packages/agent/src/memory-store packages/coding/src/memory/note-memory.test.ts packages/coding/src/memory/note-reflection.test.ts packages/coding/src/memory/note-reflection-job.test.ts packages/coding/src/agent-runtime/run-substrate.note-follow-up.test.ts packages/coding/src/agent-runtime/run-substrate.note-failure-reminder.test.ts packages/coding/src/task-engine/runner-driven.note-follow-up.test.ts packages/coding/src/tools/memory-notes-guard.test.ts packages/repl/src/commands/note-memory-command.test.ts packages/repl/src/commands/memory-command.test.ts benchmark/datasets/feature-308-*
```

Expected: all pass. `hygiene.test.ts` simulates 100 sessions and must keep
the index under budget with no duplicate live descriptions.

## 3. Manual Cases

Use a git repository with a remote and a provider that is not a CLI bridge.

### Case A: A stated preference carries to the next session

1. Say "Remember that tests here run with `make check-fast`." and end the session.
2. Check `~/.kodax/projects/<project>/notes/` (under `KODAX_HOME`): one note,
   `active`, listed in `MEMORY.md`.
3. In a new session, ask it to run the tests.

Expected: it runs `make check-fast`, or reads the note first and then runs it.

### Case B: `/memory`

Run `/memory`, `/memory candidates`, `/memory show <id>`,
`/memory approve <id>` on a candidate and `/memory forget <id>`.

Expected: the list shows each store's directory. An approved candidate appears
in `MEMORY.md`. A forgotten note's file is gone. An id present in both stores
needs a `project:` or `user:` prefix.

### Case C: An inferred note waits

1. In a session, let a command fail and recover without saying "remember".
2. After the session, run `/memory candidates`.

Expected: any note the agent saved on its own is a candidate and is absent from
`MEMORY.md`. A later session where the same way works confirms it.

### Case D: Reflection after a run

1. Finish a session in which you corrected the agent at least once.
2. Wait a few seconds after the run ends, or use `kodax -p`, which waits.

Expected: `.reflected.json` and `.reflection-budget.json` appear in the user
store (`~/.kodax/notes/`), and the correction is saved as a note. The eleventh
reflection on one UTC day makes no model call.

### Case D2: Nothing is lost between passes

1. In one session, get a correction reflected (Case D), then add one more user
   turn with a new correction and exit.
2. More than 30 minutes later, finish a run in another session of the same
   project.

Expected: during step 1 a file appears in `~/.kodax/notes/.pending-reflection/`.
After step 2 the second correction is saved as a note and the file is gone. A
session that compacts keeps learning: its next reflection does not wait for the
pre-compaction turn count.

### Case E: Notes are protected

Ask the agent to edit a note file with the edit tool or `echo >>`.

Expected: the write is denied, and a read of the same file works.

### Case F: Failure reminder

With a note such as "Node comes from fnm; put its bin directory on PATH before
`npx`", give a task whose first command fails because `npx` is missing.

Expected: the next request ends with the reminder to check the memory index,
and the agent reads the fitting note. The saved transcript has no reminder.

### Case G: Legacy conversion and rollback

1. In a fresh `KODAX_HOME`, save a memory with `KODAX_MEMORY_NOTES=0`.
2. Start a session without the variable.
3. Delete the converted note with `/memory forget`, then start another session.
4. Start a session with `KODAX_MEMORY_NOTES=0`.

Expected: step 2 copies the memory into notes and writes
`.legacy-converted.json`; the legacy files remain. Step 3 does not bring the
note back. Step 4 uses the legacy memory and its `/memory` again.

### Case H: Skill proposal

Finish a session in which a multi-step release procedure was hard to get right
and was confirmed by running it.

Expected: `/learn ready` lists a proposed skill, which is not used until
`/learn trust <name>`.

## 4. Evals

Each paid runner refuses to start without its frozen `--confirm-budget`
string, which the error message prints. Read
[EVAL_GUIDELINES](../../benchmark/EVAL_GUIDELINES.md) before a run.

| Dataset | Measures | Result recorded in ADR-076 |
|---|---|---|
| `feature-308-baseline`, `feature-308-notes` | Read and write side against the legacy memory | Retrieval 0/12 to 12/12 among 40 notes |
| `feature-308-reflect` | Reflection prompt and host checks, skill proposals | 77/78; hard procedure became a skill 5/6 |
| `feature-308-replay` | Reflection on real local sessions (private, kept in the temp dir) | About half the notes useful |
| `feature-308-twosession` | Write, reflect, then use in a second session | 19 mistakes to 0 |
| `feature-308-inferred` | Whether inferred lessons should wait | Harm matched lift; keep candidates |
| `feature-308-notelines` | Index lines written as rules | Better on index-line and failure cases |
| `feature-308-holistic` | A note's life: written, used, confirmed or corrected | Harm 1/30, 18/30 confirmed |
| `feature-308-guard` | Whether a guard label may skip confirmation | No; keep candidates |
| `feature-308-recall` | The failure reminder | Kept; weaker model reads the note body |

Any change to the note rules, the `memory` or `memory_reflect` tool texts or
the failure reminder needs an ADR-033 review and a rerun of the closest
dataset.
