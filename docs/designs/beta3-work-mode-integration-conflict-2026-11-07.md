# beta.3 work-mode integration conflict — 2026-11-07

Status: **implemented in `e0b508ade`; final full integration verification
passed (19,713 passed, zero failed, 89 skipped)**. The user clarified that the earlier stop instruction concerned
concurrent edits by other chats, and confirmed no other chat was working.
Investigation and repair continued. Permanent Session locking is preserved.
The initial failed full run and original proposal below remain historical
evidence; the refined diagnosis and implementation follow them.

## Initial full-suite evidence

The combined default run finished with 1,434 files: 1,424 passed, three failed,
seven skipped. Tests: **19,676 passed, nine failed, 89 skipped**, 24m15s. The
experimental pilot test was not in this initial collection and passed its
own separate 16-test offline run. Historical Actor-only full-suite results
remain separate and do not establish this integration as green.

| File | Failures | First failing operation | Meaning |
| --- | ---: | --- | --- |
| `src/sdk-client.binding-recovery.test.ts:98` | 5 | Fresh-authority `runs.recover` | Real legacy recovery compatibility conflict |
| `tests/sdk-work-mode-recovery.e2e.test.ts:81` | 1 | Agent `runs.recover` | Same compatibility conflict; the later switch at line 87 is also obsolete |
| `tests/sdk-work-mode-authorization.e2e.test.ts:108` / `:134` | 3 | Agent→Coding / Coding→Agent after first Run | Obsolete mode-switch expectations; the new lock correctly refuses |

At that checkpoint, no production or test file had been changed to address
these nine failures. Later phase-labelled public assertions confirmed the
recovery call as the failing operation, and the effective-mode investigation
below refined the initial raw-Agent description.

## Initial compatibility diagnosis

Before `f522f90c5`, an explicit Run `options.workMode` could override Session
settings without persisting the override into Session settings. A real old
installation could therefore save an Agent generation-recovery record alongside
a Session with history but no mode/lock fact. This is not merely an invented
fixture inconsistency.

In the integrated code, missing Session settings resolve to Coding;
`sessionHasWorkModeHistory` conservatively treats legacy history as locked.
Recovery preserves `recovery.start.options.workMode` at
`src/sdk-runtime.ts:13371`, but admission's new comparison at line 12317
rejects the original Agent continuation against the default Coding Session.
It happens during recovery, before the later test settings mutation.

## Original proposed boundary

Keep first-Run locking for all ordinary and versioned settings mutations,
all new Runs and all explicit new-format locked Sessions. Do not infer a new
mode from fresh caller overrides, weaken static Agent requirements or alter
the existing ownership, principal, binding, credential and checkpoint checks.

For an unambiguously legacy Session with no new-format lock fact, consider
allowing only the **same persisted Run/Turn** to resume in its original
validated persisted mode. An existing status mode must agree with that
recovery record; old records without one need an explicit supported fallback
rule. This is a continuation exception, not permission to select a different
mode for a new Run.

The exception must also preserve Session mode and its existing conservative
lock. Bypassing only admission's comparison is insufficient: the later
first-admission settings/marker writes around lines 12642–12650 must not
silently convert or unlock the legacy Session. Repeated crash/recovery of the
same legacy Run must remain possible; writing a new marker during the first
legacy continuation could otherwise block the second recovery. Prefer keeping
legacy facts unchanged over introducing another persistent migration state.

After that compatibility decision, update the three obsolete authorization
scenarios to assert refusal and retained inspectable/withdrawable input; a
positive mode selection belongs in a new Session. The six recovery tests also
contain subsequent old mode-switch assumptions (binding line 100 and recovery
line 87), which must be adapted after preserving the original RED recovery
evidence. Do not simply seed Agent settings to hide the legacy recovery case.

Proposed validation: same original-mode legacy recovery; repeat crash/recovery;
explicit new-format mismatch refusal; tampered persisted-mode disagreement;
weaker fresh authority and caller override refusal; queue inspect/withdraw;
new-Session positive selection; existing Actor/work-mode joint regressions,
then a new complete integration run. No such fix or verification is claimed
here by that initial proposal. Capacity repairs and the remaining next-dev merge stay separate.

## Refined root cause and implemented resolution

Two failures meet at the new admission comparison. A real legacy Agent Run
can lack Session mode/lock facts and be rejected against default Coding as if
it were selecting a new Run mode. In the five binding fixtures, however, the
stored requested Agent plus profile without `intersect` originally resolves
to **Coding**. Fresh Host binding adds `intersect` and could turn that same
requested string into effective Agent. Recovery must freeze the original
effective mode. The production resolver is byte-identical before and after
the lock commit; the difference is how admission/rebinding uses its inputs.

The implementation resolves the original snapshot and serialized callback
declarations through the existing resolver, and verifies an existing persisted
Run mode. If old status lacks a mode, the original composition supplies it;
current Session defaults and fresh caller choices do not. Callback presence
is reconstructed only for mode resolution, never executed or used as authority.
The recovered effective mode is pinned and checked again after fresh binding.
Contradictory facts remain rejected.

Only a verified same-Run continuation with no explicit Session lock fact skips
Session mode selection and marker writes. Session settings and conservative
locking remain unchanged. This keeps repeat checkpoint/restart possible without
new migration state. New Runs and ordinary/versioned mutations retain their
lock checks. Non-legacy recovery itself counts as already admitted, including
the explicit-false/empty-history counterexample that otherwise looked like an
unused Session. A v3 checkpoint still denotes Agent authority, not lock format.

The three obsolete authorization scenarios now verify refusal, retained input
and withdrawal, with positive mode choice in a new Session. The binding tests
keep their missing original Session settings, verify recovered effective Coding
and reject later Agent selection. No Agent settings were seeded to hide RED.

Validation includes public embedded Runtime regressions, original Client/Host
cold recovery and authority scenarios, Actor/work-mode joint tests, typechecks,
build and independent Standards/Spec reviews. The focused legacy case and the
modern-false/empty-history case each went RED before their corresponding fixes.
Two real capacity checkpoints followed by close/restart recover the same Run
before a third successful generation. The current disk sentinel differs from
the historical write payload, making incorrect replay observably destructive
to the sentinel and therefore detectable. No model HTTP is used in these tests.
The replacement full-suite results are recorded separately in the integration
readiness record; the initial failed run is not relabelled as green.
