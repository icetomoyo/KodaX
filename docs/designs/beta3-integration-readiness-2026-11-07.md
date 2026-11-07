# beta.3 integration readiness — 2026-11-07

Status: **stopped at the user-required work-mode conflict boundary; not release ready**. The user authorized continuous preparation, stopping before publishing beta.3, and separately required stopping if integration conflicts with first-Run work-mode locking. Full integration found that conflict. This document records a local candidate, not a release. No tag, remote push, npm/GitHub publication, installed Space/CLI replacement or next-dev feature merge occurred.

## Fixed inputs and preservation

The original checkout remains at `58671f8dea75a0df2498ad553536b17ee2b04896` with other threads' uncommitted work. A hash-checked snapshot of 13 work-mode files and 19 DOCX-related files was taken into OS temporary storage; that checkout was not modified. The existing managed worktree is reused on `codex/beta3-integration`.

| Stage | Commit | Scope |
| --- | --- | --- |
| Work-mode baseline | `f522f90c5` | First accepted Run permanently locks Session work mode; same-value writes remain allowed; existing focused tests 154 passed; package compilation and source/test typechecks passed; independent Standards/Spec reviews clear |
| DOCX baseline | `432b96467` | 18 production/documentation/fixture files; 52 focused tests passed; package compilation and source/test typechecks passed; changelog states marker behavior without guaranteeing model behavior |
| Snapshot LF rule | `545284638` | Independent cherry-pick of next-dev `2b1ecf8d8`; no other next-dev feature imported |
| Actor integration | `ea71b54de` | Merge of the previously verified Actor branch through `9bcaadb95`; SDK merged without a code conflict |
| CLI reserve restoration | `66c7ae229` | Two complete Windows programs move to verified Agent-owned resources; 49 KiB reserve restored; independent Standards/Spec clear |
| DOCX field caveat | `43c18e7c2` | Public diagnostics and documentation disclose recalculated page fields and potentially stale/empty TOC; 28 browser-enabled tests and real SDK consumption passed |
| Joint mode/Actor regression | `27cbda5a9` | Three public Runtime cases passed, including independent success/failure and exact-Turn checkpoint restart; no production work-mode changes required |
| Local version preparation | `58f234dba` | Root, five workspaces and lockfile agree on beta.3; Unreleased notes and local preparation added; initially preserved the documented beta.1 baseline; subsequent registry verification below corrects it |

The DOCX eval draft was preserved separately and is not accepted release evidence: its rubric, budgets and raw preservation require revision before any further generation. Existing raw samples are reviewed before requesting replacement generations. Historical test and model results keep their original route, revision and limitations.

## Required validation slices

1. Exercise first-root admission, independent Actor success/failure, queued roots, checkpoint close/restart and exact-Turn recovery through the public Runtime seam. Verify the lock persists even after all Runs become idle. Stop work affecting mode logic if an actual conflict is discovered.
2. Re-measure the real combined artifact and preserve a 49 KiB CLI reserve beneath the unchanged 5 MiB outer limit. A prior temporary source-overlay probe measured the largest five-manifest composition at 5,199,570 bytes, requiring at least 6,866 bytes of reduction to meet that target. That probe did not establish successful joint typechecking or execution. Prefer complete static program resources with byte verification and existing package/binary resource paths; do not remove behavior or lower the reserve to obtain green checks.
3. Validate DOCX/PPTX conversion with the installed LibreOffice console entry and Chromium, structured fallback, actual PNG evidence and original source hashes. Test cached fields before asserting that conversion preserves their values. Host converter availability is a runtime prerequisite, not guaranteed by an SDK version update.
4. Freeze a combined candidate before real-model calls. The user selected `deepseek/deepseek-flash`, `zhipu-coding/glm-5.3-flash`, with `kimi-code/kimi-for-coding` also allowed. Start with the first two routes, enforce a 64K application context budget, and distinguish that artificial budget from the models' larger native windows. Respect the pre-existing 40-request, 600,000-token, US$5 global limits; no automatic retries or unbudgeted judge calls. Pilot method and source/input hashes must be fixed in a new revision before execution.
5. Complete source/test typechecks, appropriate coverage, default full suite, final build, complete bundled regression list, package exports and local package consumption. Prepare beta.3 version/changelog/release notes without invoking publication. Preserve the last actually published Host-upgrade baseline until publication is confirmed.

## Delivery boundary

Space SDK upgrade and installed-application acceptance occur after the SDK publication step unless separately prepared against an explicitly local candidate. PDF pagination also requires the Extensions binary/remote sidecar update. The pre-release report must distinguish completed local candidate checks from those later installation/release checks and from unexecuted native platforms. The remainder of next-dev is postponed until after this repair release and needs a fresh integration candidate, conflict list and budget audit.

## Evidence record

Production candidate: `58f234dbad97137d0d258f8392f52b496545c3c0`.
Forced package re-emission followed by the complete `npm run build` passed;
source and regular test typechecking passed. The 29 bundled Node regression files passed
**103/103** (first 27 with a four-file cap, final two serial). The full default
Vitest run finished **19,676 passed, nine failed, 89 skipped** across 1,434
files (1,424 passed, three failed, seven skipped), approximately 24m15s. It is
not green. Six failures expose real legacy recovery compatibility and three
use obsolete after-first-Run mode-switch expectations. Both independent
read-only investigations agree; the lock and affected tests remain untouched.
The concrete path and proposed boundary are recorded in
[the conflict report](beta3-work-mode-integration-conflict-2026-11-07.md).

Actual npm archive: 10,733,661 bytes, 1,121 entries, SHA-256
`dd939d845f1c16845169f7f6b71154bbed4c472f5b521911c173edb0c9fd9ccd`.
All 37 export targets and seven required resource groups are present. An
isolated extraction resolves its own Root/Agent SDK; its real Windows Job and
current-SID APIs and npm bin wrapper succeed, reporting `0.7.97-beta.3`.
Existing external dependencies are borrowed through a temporary parent junction;
this is local package consumption, not a clean-machine installation claim.

Final local CLI: 5,185,031 bytes, SHA-256
`74c29f62ecc7eaedc6f42d37d4ae09010b0d64461e321e29593604811498f82b`.
The unchanged startup, credential-uniqueness and 49 KiB gates pass in three
compositions: local, five-manifest Linux selection (5,186,532 bytes), and
five-manifest Windows selection (5,187,003 bytes). The largest is **5,701 bytes**
below the restored 5,192,704-byte gate. These composition probes are not native
execution on Linux/Darwin. No existing Bun executable was found on PATH or in
the checked local locations; Bun compilation and other-platform native runs
remain unverified.

Actual-archive Artifact SDK acceptance also passed through ordinary Node
imports from the isolated extracted package and Space's existing LibreOffice
resolver: DOCX, field-bearing DOCX and PPTX produced three valid PNG evidence
items (816×1056, 794×1123 and 1281×720). Source hashes, evidence readback and
geometry were checked; render directories contain only PNG/provenance files.
The stored TOC sentinel survived while PAGE 777 recalculated to 1. This is
package conversion/evidence acceptance, not a model's final visual approval
or an installed Space upgrade.

Targeted Windows Job/resource coverage: 16 tests passed, statements 81.04%,
lines 83.24%, functions 82.5%, branches 53.96%. These are one source module's
measurements; they are not whole-repository or all-branch coverage claims.

The two pre-existing snapshot changes normalize to exactly their committed
contents under the cherry-picked LF rule; index refresh leaves no snapshot
content change. Pilot protocols [r2](beta3-document-pilot-r2-2026-11-07.md) and
[r3](beta3-document-pilot-r3-2026-11-07.md) are committed as `8dd630765` and
`5d45e2e62`. The new pilot test was not in the initial full-suite collection;
its separate offline run passed 16/16 with explicit typechecking. These passes
do not replace the failed integration run.

The real-model pilot stopped after 16 physical requests / 101,098 reported
tokens with no unknown usage or outstanding reservations. Both routes retained
all target facts through two real compactions on the first fixture. The second
fixture's DeepSeek summary hit the registered 2,048-output cap and was rejected;
the common fence prevented later requests. The eight DOCX model inputs remain
prepared but unexecuted. Main-session paired review and scoped recommendation
are recorded in [the pilot report](beta3-document-pilot-results-2026-11-07.md).
R2's stricter eval-only closing-tag failure and the six zero-HTTP replays in
r3 remain explicit; cumulative accounting was preserved.

Stop-before-release checkpoint: production artifact bytes remain the validated
candidate above, but the integration is **blocked by the work-mode compatibility
decision**. The user has been asked whether to authorize the minimal legacy
same-Run continuation proposal; no answer is inferred and no affected code or
tests have been changed. The model ledger also remains stopped; no increased
cap, replacement model or additional requests were used to obtain green output.
Raw logs, archives and model output remain in OS temporary storage, never
committed here. Capacity work and the remaining next-dev feature merge keep
their separate histories.

## Published-baseline correction

Public npm registry metadata checked on 2026-11-07 confirms beta.2 was published
on 2026-11-04T23:47:39.827Z and beta.3 is absent. The existing beta.1 upgrade
fixture was stale. CI/Release and the integrity-pinned real Host upgrade test
now target the actually published beta.2; older release-preparation paragraphs
remain historical. This correction follows verified publication, not the local
version bump. The public registry evidence is preserved in OS temporary storage.
The change is committed as `01173f5ef`. Release-workflow regressions passed
22/22, and the real integrity-pinned beta.2 Host upgraded to the candidate in
an isolated installation while preserving busy work, Session and completed
results without replay (1/1, approximately 32 seconds).
