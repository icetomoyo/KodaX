# beta.3 integration readiness — 2026-11-07

Status: **local pre-publication verification complete; final full suite passed**. The user clarified that the earlier conflict instruction concerned other chats editing concurrently, and confirmed no other chat was working. Investigation and implementation continued while preserving first-Run locking. This is a local candidate, not a release. No tag, remote push, npm/GitHub publication, installed Space/CLI replacement or next-dev feature merge occurred.

## Local KodaX mainline after integrating upstream daemon maintenance

Merge `5057f7828` contains both the previously tested candidate `311a52f0b`
and upstream `eba20154b`. The package built in the main checkout includes
the release notes from `6568541ca`. The 9 failures from the earlier checkout
were 6 legacy recovery failures and 3 outdated authorization expectations.
The three original files ran under the fast configuration on main and passed
all 13 current cases, including same-Run recovery and refusal to switch mode
after admission.

The production build and source/test typechecks passed in the main checkout.
The complete `npm run test:fast` run passed 3,586 tests and skipped 55. The
remaining default tests passed 16,171 and skipped 34. Vitest's default file
inventory and the two JSON result sets agreed on all 1,443 files, with zero
overlap. The combined result is **19,757 passed, 89 skipped, 0 failed**.

| Mainline artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| npm beta.3 tarball | 12,050,777 | `ca00f27202ba67df4fb513acdd7b5f4339eaabbafeb9de4ca7a05a681cafd7f1` |
| Windows x64 standalone ZIP | 63,612,425 | `7d7528d7d540652c896eadb6ad286bea6ac0dd2f7ca4b3c844128a69923e196b` |

All 297 packaged dist files matched the production build. The CLI with five
native manifests was 5,186,891 bytes, leaving 5,813 bytes below the existing
49 KiB reserve gate. The 104 bundled regressions passed. The npm Host and
the extracted Windows executable each removed an abandoned publication and
preserved the live owner's file byte for byte. The ZIP also passed the 11
existing archive scenarios with no Node or Bun on the child PATH.

The published beta.2 upgrade fixture passed against a physical copy of the
new tarball's dist. Earlier local attempts rejected a different beta.2
archive at the integrity check and a Windows junction at the file-copy step.
The passing test used the registry-pinned archive and ordinary dist files.
Space's install-to-tarball comparison passed and both
source Electron and the Windows executable passed 8/8 history scenarios.
In both runs the legacy session copy resolved all 7 visible user turns and
rereading the fork and rewound source returned turn 13. The additional
packaged Host gate passed its 6 lifecycle scenarios (2 overlap with the 8).

## Saved-history and Windows boot update before the mainline merge

The candidate based on `a03b9f53c` includes the history changes and the
one-property Windows boot query. The package measurements and acceptance
results below supersede the older package hashes later in this document.

| Local artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| npm beta.3 tarball | 12,047,608 | `8a05e09ab44909033be73f7fca45c9a1395669d578c7ba809810ba53e9865ff3` |
| CLI with five native manifests | 5,186,242 | `e2f26452e55ab01473863cb834f51df2b4f7e1e7add56fdf3728518eadba0bd9` |
| Windows x64 standalone ZIP | 63,610,927 | `5910127f634db0d12635b3875e6780dc91da640b0accc5b93af4d105cdb8c944` |

The npm tarball contains 1,137 files. All 296 packaged `dist` files match
the build byte-for-byte, including the two lazy history modules. The CLI is
6,462 bytes below the existing 49 KiB reserve gate. Windows npm installation
exposed a CRLF shebang rewrite in an earlier archive. The final LF checkout
rule passes Space's original archive-to-install byte check. The Windows native
resources were built locally. The other four native resource sets come from
the integrity-pinned beta.2 tarball with unchanged native source and build
script; their manifests and content hashes were verified. Their platforms
still require native CI.

The production build and both source/test typechecks passed. The default
Vitest suite finished in 27m51s with **19,731 passed, 89 skipped, 0 failed**
across 1,441 files. All 103 bundled regressions passed, using two concurrent
files for the first 27 and the prescribed serial execution for the final two.
The installed npm package loaded native protocol 5, the three Host cutover
checks passed, and the Artifact SDK packed consumer gate passed against an
independently repacked, SHA-256-identical tarball. A focused 48-test V8 run
over the two new production modules measured 94.69% lines, 80.79% statements,
80.26% branches and 94.73% functions. This is module-scoped coverage.

Space installed this tarball in an isolated checkout. Source Electron and
the packaged Windows executable each passed eight history scenarios. The
session copy had seven visible user items; all resolved, and rereading both
the fork and the rewound source returned the exact selected turn. The
post-fork loopback request contained both prompts and all three paired tool
calls/results. The same Space source with the registry beta.2 Host returned
111 live items, 201 saved items and an explicit unsupported resolution.
Packaged Runtime/Worker startup, native loading and the six Host lifecycle
scenarios passed (two overlap the eight history scenarios). A running
beta.2 Host deferred the upgrade until its Run completed; the tool ran once
and the number of main Provider requests stayed at two. These checks measure
what the client sends to the model. They use no external model.

The Windows ZIP passed eight build smokes and eleven archive scenarios with
Node and Bun absent from the launched program's PATH. A cold legacy Actor
claim can change the revision after a read: the first rewind then safely
refuses the stale confirmation and the newly confirmed exact turn succeeds.
An already claimed session rewinds on the first confirmation. A damaged
stored body through the real RPC emitted one diagnostic at the appropriate
owner and omitted the malformed content.

The six paired, same-source Windows cold-connection trials from the
investigation saved 565–704 ms per pair (median 640 ms) by requesting only
`LastBootUpTime`. Windows PowerShell 5.1 and PowerShell 7.6.5 returned the
same UTC ticks for broad and narrow queries. Recovery tests exercised a
different stored boot identity and query failure. A physical OS reboot was
outside the local test.

## Fixed inputs and preservation

The original checkout was at `58671f8dea75a0df2498ad553536b17ee2b04896` when a hash-checked snapshot of 13 work-mode files and 19 DOCX-related files was taken into OS temporary storage. That checkout was not modified. The existing managed worktree is reused on `codex/beta3-integration`.

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

1. Exercise first-root admission, independent Actor success/failure, queued roots, checkpoint close/restart and exact-Turn recovery through the public Runtime seam. Verify the lock persists even after all Runs become idle. Coordinate concurrent edits; investigate semantic incompatibility and preserve the permanent lock when repairing it.
2. Re-measure the real combined artifact and preserve a 49 KiB CLI reserve beneath the unchanged 5 MiB outer limit. A prior temporary source-overlay probe measured the largest five-manifest composition at 5,199,570 bytes, requiring at least 6,866 bytes of reduction to meet that target. That probe did not establish successful joint typechecking or execution. Prefer complete static program resources with byte verification and existing package/binary resource paths; do not remove behavior or lower the reserve to obtain green checks.
3. Validate DOCX/PPTX conversion with the installed LibreOffice console entry and Chromium, structured fallback, actual PNG evidence and original source hashes. Test cached fields before asserting that conversion preserves their values. Host converter availability is a runtime prerequisite, not guaranteed by an SDK version update.
4. Freeze a combined candidate before real-model calls. The user selected `deepseek/deepseek-flash`, `zhipu-coding/glm-5.3-flash`, with `kimi-code/kimi-for-coding` also allowed. Start with the first two routes, enforce a 64K application context budget, and distinguish that artificial budget from the models' larger native windows. Respect the pre-existing 40-request, 600,000-token, US$5 global limits; no automatic retries or unbudgeted judge calls. Pilot method and source/input hashes must be fixed in a new revision before execution.
5. Complete source/test typechecks, appropriate coverage, default full suite, final build, complete bundled regression list, package exports and local package consumption. Prepare beta.3 version/changelog/release notes without invoking publication. Preserve the last actually published Host-upgrade baseline until publication is confirmed.

## Delivery boundary

Space SDK upgrade and installed-application acceptance occur after the SDK publication step unless separately prepared against an explicitly local candidate. PDF pagination also requires the Extensions binary/remote sidecar update. The pre-release report must distinguish completed local candidate checks from those later installation/release checks and from unexecuted native platforms. The remainder of next-dev is postponed until after this repair release and needs a fresh integration candidate, conflict list and budget audit.

## Initial integration checkpoint — historical

Production candidate: `58f234dbad97137d0d258f8392f52b496545c3c0`.
Forced package re-emission followed by the complete `npm run build` passed;
source and regular test typechecking passed. The 29 bundled Node regression files passed
**103/103** (first 27 with a four-file cap, final two serial). The full default
Vitest run finished **19,676 passed, nine failed, 89 skipped** across 1,434
files (1,424 passed, three failed, seven skipped), approximately 24m15s. It is
not green. Six failures expose real legacy recovery compatibility and three
use obsolete after-first-Run mode-switch expectations. Both independent
read-only investigations identified the boundary; the refined effective-mode
diagnosis and subsequent repair are recorded below.
The concrete path and proposed boundary are recorded in
[the conflict report](beta3-work-mode-integration-conflict-2026-11-07.md).

Actual npm archive: 10,733,661 bytes, 1,121 entries, SHA-256
`dd939d845f1c16845169f7f6b71154bbed4c472f5b521911c173edb0c9fd9ccd`.
All 37 export targets and seven required resource groups are present. An
isolated extraction resolves its own Root/Agent SDK; its real Windows Job and
current-SID APIs and npm bin wrapper succeed, reporting `0.7.97-beta.3`.
Existing external dependencies are borrowed through a temporary parent junction;
this is local package consumption, not a clean-machine installation claim.

Initial checkpoint CLI: 5,185,031 bytes, SHA-256
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

That initial checkpoint stopped for a coordination clarification. The user
subsequently clarified that no other chat was editing; the compatibility repair
and independent DOCX phase proceeded as recorded below. The failed full run
and stopped SC model sample remain intact. Raw evidence stays in OS temporary
storage. Capacity work and the remaining next-dev feature merge retain their
separate histories.

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

## Corrected candidate and final verification

Production repair: `e0b508ade`. The [root-cause report](beta3-work-mode-integration-conflict-2026-11-07.md)
distinguishes a legacy same-Run continuation from selecting a new Session mode,
and a requested Agent string from the original effective Coding mode. No
Session migration state or configuration was added. Original checkpoints,
fresh authority and modern lock refusal remain enforced; legacy continuation
does not rewrite Session mode or its marker. Ten public Runtime cases and
the original authority/recovery suites passed. A fresh-authorization context
mode-drift counterexample is separately committed as `4b2911db6`.

Complete build and source/test typechecks passed. Targeted recovery-module
coverage passed 24 tests: statements 95.31%, branches 95.45%, functions 87.5%,
lines 96%; these are module measurements, not whole-repository coverage.
Independent Standards/Spec reviews have zero remaining findings. The next
default full-suite run finished in 24m25s: **19,712 passed, one failed, 89
skipped** across 1,436 files (1,428 passed, one failed, seven skipped). All
original nine failures passed, including the three original failing files;
the ten new public recovery cases passed. The remaining failure was
`shell-execution/resolver.test.ts`, waiting two seconds for the first probe's
ready file, before cancellation or retry occurred. This run is not green;
that startup failure was investigated separately below. It does not establish
that last-waiter cancellation or fresh-probe retry failed.

A controlled first-probe startup delay of 2.2 seconds reproduces the exact
ready-file RED, while remaining below the existing ten-second production
probe deadline. The test-only repair waits for a readiness handshake within
the outer test budget, observes premature completion/errors and holds the
first probe until cancellation. Immediate retry still precedes awaiting
cancellation, and successful fresh execution plus exactly two probe markers
remain required. Cleanup aborts the first caller; bounded failure diagnostics
record observed results. Production Shell code is unchanged. This establishes
a test-timing failure mechanism, not the unrecorded duration or sole cause of
that natural full-suite failure.
The test-only repair is committed as `cc727a0d1`; its complete file passed
23/23, test typechecking passed, and independent Standards/Spec reviews have
zero remaining findings. The following full-suite run uses that frozen test.

The final default full suite completed on 2026-11-07 in **24m10s**, using
`cc727a0d1`: **19,713 passed, zero failed, 89 skipped**, across **1,436 files
(1,429 passed, seven skipped)**. All ten legacy recovery cases, the original
three work-mode files, the complete 23-case Shell resolver file, and the Actor
recovery/race/terminal suites passed. The log and JSON report remain in OS
temporary storage under `kodax-beta3-work-mode-final-rerun-20261107`. This is a
new green run, not a relabelling of either historical failure.

The corrected 29-file bundled regression set passed 103/103. The resource
archive regression was rerun after `c1b84cf84` added the Windows program JSON
to both tar and zip inventories: two archive RED failures became 3/3 GREEN;
release-workflow regressions passed 22/22. This fixes a real publication-list
omission, independently of the work-mode implementation.

Final npm artifact: 10,734,211 bytes / 1,121 entries, SHA-256
`81bd81a682685c589a27fbbc75cce79307cc4aabc06e6cc0eb2ebebf8b735cc4`.
All 37 export targets, seven resource groups and both audited program hashes
are present; isolated Root/Agent SDK and real Windows API consumption passed.
Only CHANGELOG differs from the preceding mode-fixed package; all dist/scripts
match byte-for-byte. The real integrity-pinned published beta.2 Host upgrade
passed again (1/1, approximately 24 seconds).

The actual CLI is 5,185,678 bytes, SHA-256
`f05a58735a8794d228f59e01e9b6844de37f2cdc4e374ac49dfad1e48980cbc8`.
Five-manifest Linux composition is 5,187,179 bytes; the Windows maximum is
5,187,650 bytes, leaving **5,054 bytes** beneath the preserved 49 KiB gate.
Startup and credential uniqueness checks passed; all 1,138 inputs remain.

Windows native compilation is now verified: Bun 1.4.4 was retrieved into OS
temporary storage with its official npm SHA-512 verified, without global
installation. The build's eight standalone checks passed. The actual zip,
SHA-256 `8f6b13267ad7fcd554b4189bdc8ce1bd0c1b56dfc5c13a5e14b05f350c72a9bd`,
passed the real archive gate on a PATH containing neither Node nor Bun:
nine scenarios, 11 primary/7 auxiliary loopback requests, zero external model
calls. It covers partial effects, daemon restart, model changes, cancellation
with identical-code positive control, permanent lock refusal, first selection
and original resource hashes. The gate's old mode-switch assumptions were
updated in `d3b63167d`. Linux/Darwin native execution remains unverified.

The independently preregistered [DOCX R4 phase](beta3-docx-pilot-r4-2026-11-07.md)
completed its eight unchanged next-response probes. Cumulative model accounting
is now 24 physical calls / 145,003 tokens / US$0.0321729 DeepSeek peak liability;
GLM used subscription quota. No unknown usage or reservations remain, and the
ledger is explicitly closed against extra requests. The original SC cap stop
was not retried or relabelled. Main-session blind judgments and limitations
are in [the model report](beta3-document-pilot-results-2026-11-07.md).

## Stop before publication

The authorized local integration, repair, review, build, packaging and Windows
archive acceptance are complete. No release command was executed. The final
documentation and test-only changes do not change the production CLI hash or
the accepted package resources. The candidate remains unpublished beta.3;
installed Space still needs its SDK update and installed-package acceptance
after publication. Linux/Darwin native execution still needs its platform CI.
The pilot does not establish native sub-100K-model behavior or autonomous
whole-book reading quality; its censored SC sample remains incomplete. Those
limits and the remaining next-dev merge are not silently marked complete.
