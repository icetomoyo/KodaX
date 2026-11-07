# beta.3 work-mode integration conflict — 2026-11-07

Status: **read-only diagnosis; implementation stopped by the user's explicit
instruction to stop if changes conflict with first-Run work-mode locking**.
This proposal has not been implemented. Do not treat the candidate as release
ready or modify the lock/fixtures to turn these failures green without the
user's decision.

## Full-suite evidence

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

Two independent read-only investigations agree. No production or test file
was changed to address these nine failures, and no rerun is presented as
superseding the failed full run.

## Reproducible compatibility path

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

## Proposed minimal boundary, pending decision

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
here. Capacity repairs and the remaining next-dev merge stay separate.
