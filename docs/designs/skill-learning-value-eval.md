# Skill learning value eval (pre-registration)

Status: pre-registered 2026-11-26, run 2026-11-26 (full scope, 252 calls, 1.77M tokens,
$0.083). Revision `skill-value-r1`. Verdict: **S about equal** in the tested range. The
mapping says retire automatic skill learning, but the eval had a ceiling and cannot speak to
harder procedures. The decision waits on deeper research. Results are under "Results" at
the end.

## Question

Note memory (FEATURE_308) already carries what a session learned. Reflection can also
turn a hard, confirmed procedure into a learned skill. Does a later session do the
procedure better when it was stored as a skill than when it was stored as notes, and does
the answer depend on how complex the procedure is?

The owner expects skills to matter for complex procedures. Peers give no evidence either
way: Hermes and Codex v1 auto-wrote skills without measuring later-task benefit, Codex v2
removed it, pi never had it.

## Arms

Both arms start from the same scripted session 1 and run the real reflection job on it.

- **N (notes only)**: the reflection request with only `memory_reflect`. The system prompt
  is the production one minus the paragraph about `skill_propose`. This is the
  "retire skill learning" path.
- **S (notes + skills)**: the production reflection request, both tools. A proposed skill
  passes the real host guards and is installed as if a later session had confirmed it
  (the redesigned rule), so session 2 sees it in the Skill catalog.

Notes written in session 1 are set active in both arms, the steady state after a later
session confirms them. Without that, S would compare a confirmed skill with unconfirmed
notes.

No-memory arm: not rerun. FEATURE_308 already showed notes beat no memory.

## Session 2

Production Worker assembly (`assembleReadCell`), note memory on, the real builtin Skill
catalog and the `skill` tool in both arms (EVAL_GUIDELINES lesson 12). In S the learned
skill is a `SKILL.md` rendered by `renderDeclarativeSkill` in the fixture home's skills
directory, so the catalog line and the `skill` tool result are production bytes, except
the skill's location path, which production keeps in the learned area. The real
`~/.agents/skills` is kept out of the catalog.

Two probes, single calls each (Layer 2):

- **D, discovery**: fresh session, the task only. Classified from the first response:
  `load` (a `skill` call with the stored name, or a `read` of a note session 1 wrote),
  `step` (the correct first step of the procedure), `pitfall` (a call matching a known
  pitfall), or `other`.
- **P, fidelity at a checkpoint**: the task, then the arm loading what it stored (S: the
  `skill` call and its real result; otherwise a real `read` of each note session 1 wrote),
  then the ground-truth steps before the checkpoint with canned results. The next action
  must be the checkpoint step. Classified `pass` (matches the step), `fail` (matches the
  pitfall) or `review`. If an arm stored nothing, there is no load step.

## Cases

Session 1 of every case works the procedure out through real failures and ends with the
user confirming it ("every time").

| id | tier | lang | procedure | checkpoints |
|---|---|---|---|---|
| s1 | simple | EN | regenerate the API client with `npm run gen:client`, never hand-edit generated code | first step |
| s2 | simple | ZH | `make db-reset`, then `APP_ENV=test make db-seed` | the seed step |
| c1 | complex | EN | native addon prebuild release: both versions, `cargo zigbuild` for glibc 2.17, smoke-load, sign before checksums, `native-v` tag | zigbuild, sign before checksums, `native-v` tag |
| c2 | complex | ZH | column rename migration: shadow first, `pnpm db:types`, fixtures, `DB_TZ=UTC pnpm test:db`, down migration plus `docs/MIGRATIONS.md` | shadow, `DB_TZ=UTC`, down migration before commit |
| c3 | complex | EN | vendored SQLite upgrade: fetch script, patches in numeric order, VERSION, bindings, `--threads=1`, notices before commit | patch order, `--threads=1`, notices before commit |

## Sample and budget

Models: `kimi`, `zhipu/glm53flash`, `ds/flash` (owner's paid-eval pool), 2 repetitions,
one call in flight per alias.

Calls per chain: 2 reflections + 2 D + 2 per checkpoint. Simple 6, complex 10.

- Pilot: c1 and s1, `kimi` and `zhipu/glm53flash`, 1 repetition: 32 calls.
- Full: 5 cases x 3 aliases x 2 repetitions: 252 calls. Pilot results are reused when the
  revision is unchanged.

Output cap 8192 per call, timeout 180 s. Caps frozen from `prepare` (case hash
`362e3767…`): planned input 0.32M tokens (pilot) and 2.55M (full); with every call using
its full output reserve, 0.58M and 4.62M. Caps add about 30% for stored artifacts larger
than the dry run's. Only glm-5.3-flash and deepseek-flash are priced; worst-case spend is
about $0.09 (pilot) and $1.06 (full).

| scope | calls cap | tokens cap | USD cap | confirmation |
|---|---|---|---|---|
| pilot | 40 | 800,000 | 0.5 | `skill-value-r1:pilot:calls=40:tokens=800000:usd=0.5` |
| full | 300 (pilot included) | 6,000,000 | 2 | `skill-value-r1:full:calls=300:tokens=6000000:usd=2` |

The learned skill is listed last in the catalog, as the composite registry orders it, and
is expanded as source `learned`.

## Decision mapping

The primary evidence is the complex tier, read per paired cell (same alias, case,
repetition and checkpoint, N against S), after a blinded review of every `review` cell and
of every pair whose mechanical verdicts differ.

- **S materially better on complex procedures**: S wins clearly more paired checkpoints
  than it loses, the direction holds on at least two of three aliases and two of three
  cases, and S does not load the stored procedure less often in D. Then keep learned
  skills for complex procedures and implement the redesign (confirmation rule, reflection
  sees existing skills and patches before creating, activation at next session start,
  archive unused skills, no canary).
- **S about equal, mixed, or worse**: notes carry procedures. Retire automatic skill
  learning: drop `skill_propose` from reflection and fold the Learning Center slimming into
  FEATURE_309.

Recorded but not decisive:

- Simple tier: whether S reflection proposes a skill at all (it should not), and whether a
  skill there changes anything.
- Content fidelity of what session 1 stored: whether each checkpoint's fact made it into
  the stored notes or skill. A procedure lost at write time explains a P failure that
  loading cannot fix.
- D load rate by arm: a skill that is followed well but rarely loaded does not help.

`eval-invalid` if a session 1 fails the reflection gate, an arm's input bytes differ in
anything other than the memory pieces, or more than a quarter of cells fail on provider
errors.

## Files

- `benchmark/datasets/skill-learning-value/`: cases, inputs, oracles, runner.
- Raw dumps: `os.tmpdir()/kodax-eval-dumps/skill-learning-value/<revision>/`.

## Results (2026-11-26)

No provider errors. Every session 1 passed the gate. Arm bytes differ only in the memory
pieces. Pilot cells were reused.

Complex tier, 3 aliases x 3 cases x 2 repetitions, 54 paired checkpoints after the blinded
review (verdicts in `review/full-verdicts.json` next to the dumps):

| | S wins | N wins | tie |
|---|---|---|---|
| all | 0 | 1 | 53 |

- The one difference is kimi c1 rep 1, `native-v` tag. S ran `git tag v0.9.0` with the
  skill loaded, and that skill contained the right tag.
- The other 8 non-pass cells were reasonable actions, none a pitfall: verify before tagging,
  push main first, look around first. One more cell was an annotated `native-v` tag that the
  oracle missed. One automatic pass is too generous: ds/flash c3 S r1 p1 only listed the
  patches with `sort -V` and did not apply them.
- c1's ground-truth steps leave out `verify-release`, which session 1 ran and every stored
  procedure lists. Two S non-pass cells were the model running it. They are scored as ties.
- D load rate: N 18/18, S 18/18. Both arms stored every checkpoint fact (54/54, counting
  notes and skill together).
- When S stored a skill (15 of 18 chains), it wrote the procedure as a note too in only 8.
  glm53flash wrote only a skill in all 6 of its complex chains. Under the shipped rule a
  learned skill waits for the user's approval, so those chains would have carried no usable
  procedure into session 2. This eval installed every skill as already approved.
- S reflection output on complex chains: about 1,462 tokens, against 718 in N.

Simple tier: no pitfall in either arm. Review cells are the model inspecting the project
before acting. S reflection proposed a skill in 1 of 12 simple chains (s1).

Reading, limited to the tested range: for procedures of about 8 steps, which session 1
spelled out and the user confirmed, a skill adds no fidelity over an active note. Notes made
no pitfall in 27 complex checkpoints, so the design could not show S doing better. It can
not show that notes are enough for harder cases: long or branching procedures, many stored
items competing, reworded tasks, procedures that change across sessions, or lessons that
were never summarised in session 1. An independent critique
(`docs/research/2026-11-26-skill-eval-critique.md`, local) lists follow-up evals for these.
