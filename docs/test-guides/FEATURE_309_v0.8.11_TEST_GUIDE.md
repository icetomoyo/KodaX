# FEATURE_309 v0.8.11 Human Test Guide

> Feature: Legacy memory code deletion, part 1: automatic Skill learning removed
>
> Status: Part 1 implemented on `KodaX-next-dev`; not yet released. Part 2
> (the legacy memory plane) is still blocked by Issue 411.
>
> Date: 2026-11-27
>
> Decision: [ADR-085](../ADR.md#adr-085-kodax-no-longer-learns-skills-on-its-own-notes-carry-learned-procedures).
> Design: [v0.8.11 §0](../features/v0.8.11.md#feature_309-legacy-memory-code-deletion).

## 1. Test Goal

Verify that KodaX no longer creates or loads learned Skills, that a learned
Skill the user approved survives as a user Skill, that the learning surfaces
are gone without breaking old sessions, and that reflection still keeps a
confirmed procedure as a note.

Use a throwaway agent home so real notes and Skills are untouched:

```bash
export KODAX_HOME="$(mktemp -d)"
```

## 2. Automated Checks

Run from the repository root (package directories give false failures):

```bash
npm run build
npx vitest run packages/agent/src/learning packages/agent/src/memory-control/unified-review.test.ts packages/coding/src/memory-runtime.test.ts packages/coding/src/memory/note-reflection.test.ts packages/coding/src/memory/note-reflection-job.test.ts src/runtime-daemon/host-rpc.test.ts src/runtime-daemon/host-document.test.ts src/runtime-agent-binding.test.ts benchmark/datasets/feature-309-reviewer
```

Expected: all pass. Run a full `npm run build` after switching to this
branch: `tsc` keeps stale files for deleted sources in `dist/`, and the Host
end-to-end tests then fail in bulk.

## 3. Manual Cases

### Case A: Approved learned Skills become user Skills

1. Copy a `learned/` directory from an older KodaX home that has one approved
   (`active_learned`) Skill and one `ready` Skill into `$KODAX_HOME`.
2. Start `kodax` and run `/skill`.
3. Quit and start again.

Expected: step 2 lists the approved Skill as a user Skill, and
`$KODAX_HOME/skills/<slug>/SKILL.md` exists. The `ready` Skill is not listed
and not copied. `$KODAX_HOME/skills/.learned-skills-imported.json` names what
was copied. `learned/` is unchanged. Step 3 copies nothing again; deleting the
copied Skill does not bring it back.

### Case B: An existing user Skill is not overwritten

Before Case A step 2, create `$KODAX_HOME/skills/<slug>/SKILL.md` with
different content for the approved Skill's slug.

Expected: the file keeps its content. Start succeeds, and the diagnostics say
the learned Skill was not copied.

### Case C: Learning surfaces are gone

1. In the REPL, type `/learn`, `/workflow pending` and `/skill pending`.
2. Check the status bar.
3. Over protocol v2, call `learning.list`, and read the handshake result and
   the Host document from `view.subscribe` with target `{kind: 'host'}`.

Expected: the commands are unknown, and the status bar shows no learning
summary. `learning.list` fails as an unknown method. The handshake lists no
`learning.*` method, no `learningCenter` or `skillLearningLoop` capability and
no `learning:*` scope. The Host document has no `learning` key.

### Case D: A confirmed procedure is kept as a note

Finish a session in which a multi-step release procedure was hard to get
right, was confirmed by running it, and the user said to do it this way every
time. Wait for reflection, then run `/memory`.

Expected: the procedure is a note (active when the user stated it, otherwise
a candidate). No Skill is created, and `$KODAX_HOME/skills/` and `learned/`
do not change.

### Case E: Old sessions still load

Resume a session recorded before this change that ran the episode reviewer
(legacy memory, `KODAX_MEMORY_NOTES=0`).

Expected: the session loads and continues. A stored Skill decision has no
effect.

## 4. Evals

Each paid runner refuses to start without its frozen `--confirm-budget`
string, which the error message prints. Read
[EVAL_GUIDELINES](../../benchmark/EVAL_GUIDELINES.md) before a run.

| Dataset | Measures | Result recorded in ADR-085 |
|---|---|---|
| `skill-learning-value` (deleted; in git at `cb62b61f0`) | A procedure as a learned Skill against confirmed notes, on a later session | 0 Skill wins, 1 note win, 53 ties |
| `skill-learning-capture` (deleted; in git at `cb62b61f0`) | Reflection with notes only against production with `skill_propose`, on long sessions | Facts in notes 81/90 against 80/90; notes-only prompt ships |
| `feature-309-reviewer` | The Memory-only episode reviewer against the old Memory-plus-Skill prompt | Recommend-ship; method kept 8/8 against 5/8 |

`npx tsx benchmark/datasets/feature-309-reviewer/runner.ts tally --stage full`
replays the recorded responses through the governed apply without new calls.
Every review applies, and each method case lands a Memory write (Issues 446
and 447).
