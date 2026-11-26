# Skill learning capture eval (pre-registration)

Status: run 2026-11-26 (revision `skill-capture-r1`). Result: remove automatic skill learning; the notes-only prompt ships unchanged.

## Question

The skill value eval (`skill-learning-value-eval.md`) found that a learned skill adds nothing
over a confirmed note, on short sessions that ended with the procedure spelled out and the user
saying "every time". There, reflection only had to transcribe. The owner approved removing
automatic skill learning (folded into FEATURE_309), and this eval runs first.

When the reflection job has only notes, does it still capture what a later session needs from
realistic long sessions? This covers lessons spread over many turns, implicit confirmations,
noise, dead ends and transient failures. It also asks whether removing the skill paragraph makes
the job write more noise.

This is also the ADR-033 prompt eval for the removal. Arm N's request is exactly what production
sends once `skill_propose` and its paragraph are gone.

## Layer and arms

Layer 2: one reflection call per cell, no session 2. Whatever is lost at write time cannot be
recovered by any later format, and this is the cheapest place to look.

- **N (notes only)**: the production reflection system prompt minus the paragraph that starts
  "A session can also end with a multi-step procedure", with `memory_reflect` as the only tool.
- **S (production today)**: the production request, `memory_reflect` and `skill_propose`.

Both arms start with no existing notes. The user message (evidence) is byte-identical. The
returned calls are applied through the real host guards (`applyReflectionOperation`) into a
throwaway store. Nothing is promoted, so a note keeps the status the guards gave it.

## Cases

Six scripted long sessions (`benchmark/datasets/skill-learning-capture/cases.ts`), 10 to 18
user turns and 25 to 45 tool calls each, with noise, dead ends and no closing summary:

| id | lang | shape |
|---|---|---|
| k1 | EN | release procedure put together across a messy session, with an unrelated bugfix in between; implicit confirmation |
| k2 | ZH | a user rule stated in passing inside a longer request, plus a local-output lesson found later |
| k3 | EN | tool found under another name or path; a transient network timeout and a wrong hypothesis are traps |
| k4 | ZH | migration procedure with a branch for big tables, a verification gate and a step that works only after a fix |
| k5 | EN | long debugging session whose lesson is an environment gotcha; failing test name and ticket are traps |
| k6 | EN | control: an ordinary feature session with nothing durable |

Each case lists:
- `facts`, the lessons a later session needs;
- `order`, the steps whose order matters;
- `traps`, what must not be stored.

Fact and trap patterns are lenient token matches. A unit test checks that every session passes
the reflection gate, and that every fact is visible in the evidence the job receives.

## Measures

Per cell and arm, mechanically:

- **Facts in notes**: facts carried by stored notes. This is the primary measure. A skill
  under the shipped rule waits for the user's review, and after the removal there are no
  skills, so notes are what the next session can use.
- **Facts anywhere** (notes or skills): what S would carry if every skill were approved.
- **Order**: whether one stored text holds every order-critical step in order.
- **Traps**: traps found in stored text.
- **Cost**: notes per cell, note characters, active notes, output tokens, rejected
  operations.
- **Crowding**: cells where S wrote a skill but no note.

Paired per fact (same alias, case, repetition):
- N only;
- S only (in a note);
- both;
- neither;
- neither but S has it in a skill.

The main session reviews every cell blinded: the stored notes and skills of both arms, with arm
labels hidden (`review/<scope>-pack.json`). It checks three things:
- every fact miss and trap hit the patterns report;
- whether a note states the lesson usably (what to do and when, not only what broke);
- whether a stored item is worthless noise the traps did not list.

The verdicts are written to `review/<scope>-verdicts.json` before unblinding.

## Decision mapping

- **N captures at least as many facts in notes as S, and N's noise is not clearly higher**:
  remove automatic skill learning as planned. N's prompt ships unchanged.
- **N captures fewer facts in notes than S**: N drops lessons that S kept in notes. Find
  out which kind of lesson is dropped, change the notes-only prompt in a new revision, rerun the
  affected cells, and only then remove skill learning.
- **N misses facts that S kept only in a skill, in more than a few procedure cells**: notes
  lose procedures that skills caught. Before the removal, the notes-only prompt must say how a
  confirmed multi-step procedure is written as a note (new revision, rerun).
- **N stores clearly more noise than S** (traps or worthless notes): the paragraph was also
  keeping the job selective. Restore that selectivity in the notes-only prompt (new revision).

The direction must hold on at least two of three aliases. The owner makes the final call on the
reviewed evidence.

`eval-invalid` in any of these cases:
- a session fails the gate;
- the arms' user messages differ;
- more than a quarter of cells fail on provider errors;
- the control k6 makes both arms store several notes, so the cases cannot tell a selective job
  from an eager one.

## Sample and budget

Models: `kimi`, `zhipu/glm53flash`, `ds/flash` (the owner's paid-eval pool), one call in flight
per alias. Output cap 8192, timeout 180 s.

- Pilot: k1 and k3, `kimi` and `zhipu/glm53flash`, 1 repetition, both arms: 8 calls. It checks
  that the cases separate a good capture from a poor one and that the scoring works on real
  output. If the pilot shows that a case cannot discriminate (both arms store everything with
  perfect order, or nothing), fix the case in a new revision before the full run.
- Full: 6 cases x 3 aliases x 2 repetitions x 2 arms: 72 calls. Pilot results are reused when
  the revision is unchanged.

Caps (frozen from `prepare`, see "Caps" below) are enforced by the runner's ledger. A run needs the
exact confirmation string.

### Caps

From `prepare` (2026-11-26): requests are 6.5k to 10.3k input tokens each, and no case loses
evidence to the size limit. The caps leave room for one retry per cell.

| scope | calls | input tokens | with output reserve | cap: calls / tokens / USD |
|---|---|---|---|---|
| pilot | 8 | 71,278 | 136,814 | 10 / 400,000 / 0.3 |
| full | 72 | 623,022 | 1,212,846 | 80 / 3,000,000 / 1 |

## Pilot (2026-11-26)

8 calls, $0.006. The cases discriminate: one fact miss, and order results of ordered, misordered
and incomplete. No case is at ceiling or empty, so the cases are unchanged. Arm S proposed one
skill, and the host refused it because its quote was not exact words from the session.

The runner was fixed twice before the full run. The case files are unchanged, so the revision
stays r1:
- **Order measure**: it compared where each step was first mentioned. A note often names the
  steps in its description ("the doc omits preflight, migrate:prod and cdn:purge") before it
  spells out the order, so two notes that held the complete correct order scored
  "misordered". It now checks the steps as an in-order sequence in one text, which is what
  "Order" above says.
- **Blinding**: the pack carried the arm key, and `pack` printed per-arm tallies. Both now go to
  their own files (`review/<scope>-key.json`, `review/<scope>-summary.json`), and the pack
  leaves out trace lines that name the skill tool. The main session saw the key for the 4 pilot
  cells, so their verdicts in the full review are not blind. The results report whether the
  conclusion changes without them.

## Results (full, 2026-11-26)

72 calls, $0.049, no provider failures, no missing cells. The control k6 stored 0 or 1 notes
per side, so the eval is valid.

| | N (notes only) | S (production) |
|---|---|---|
| facts in notes | 81/90 | 80/90 |
| facts anywhere | 81/90 | 82/90 |
| paired facts: only this arm kept it | 9 | 8 |
| blinded cell wins (36 cells, 22 ties) | 7 | 7 |
| trap hits | 33 | 32 |
| notes per cell / chars per cell | 1.9 / 1537 | 2.1 / 1589 |
| output tokens per cell | 2014 | 2361 |
| rejected operations | 9 | 6 |
| cells with a skill | — | 6 (k1, k4, k5) |

By alias, facts in notes (N vs S): kimi 26 vs 24, zhipu/glm53flash 25 vs 26, ds/flash 30 vs 30.
N is at least as good on two of three aliases. Leaving out the 4 pilot cells, whose verdicts
were not blind, changes nothing: facts are 69 vs 69, cell wins 6 vs 6.

What the blinded review found:
- **Misses are run-level failures, not lessons of one kind.** Both arms lose whole cells (a
  side that stored nothing, or kept one note out of four). A note the host guards rejected
  (no `why`, quote not a full statement, malformed call) is lost, because the job does not
  retry. That happens in both arms, and affects 9 of N's operations and 6 of S's.
- **The skill takes procedure detail out of the notes.** In two k4 cells, S put the
  verify-before-swap step into its skill and left it out of the notes. After the removal that
  step would be in no note at all. N's notes kept it in those cells.
- **Noise is equal.** Trap hits are mostly supporting detail (ticket ids, failing test names)
  in a note's why or body, and both arms do it at the same rate. Clearly worthless notes are
  rare in both: N stored one (a validation it had just implemented), and S stored two
  borderline generalizations on k6.
- **The order measure cannot discriminate on k4.** Every side keeps the BI pause and the
  pt-osc procedure as separate notes, and the two together are usable.

Decision mapping, first branch: N captures as many facts in notes as S, and its noise is not
higher. Remove automatic skill learning as planned, and ship N's prompt unchanged.

Follow-up, not part of this decision: a rejected operation is lost for good. Letting the job
see the rejection and try once more would recover several of the misses in both arms.

## Files

- `benchmark/datasets/skill-learning-capture/`: cases, runner, cases test.
- Raw dumps: `os.tmpdir()/kodax-eval-dumps/skill-learning-capture/<revision>/`.
