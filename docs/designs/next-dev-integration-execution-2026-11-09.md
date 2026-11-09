# next-dev integration execution — 2026-11-09

Status: **completed local integration**. Mainline `KodaX` fast-forwarded from
`5ea48c641` to the verified code candidate `f6a60fba7`; the final acceptance
record is a documentation-only descendant. Destination build and CLI smoke
passed. No npm publication, GitHub release or installed Space update occurred.

## Frozen inputs and preservation

- Mainline `KodaX`: `5ea48c64123eb5be5fa64f55625f95cd45eb0162`.
- Synced `KodaX-next-dev`: `e37aef47a5ca491014a9442ab18fa68a3ecde3a7`.
- Mainline is an ancestor; next-dev has 66 additional commits and 316 changed
  files (39,745 insertions / 683 deletions). Counts include historical merges
  and records; they are not a production code-size measurement.
- The current chat's clean worktree was reused on `codex/next-dev-integration`.
  The other chat's next-dev worktree remains at `e37aef47a`, untouched. Mainline
  was left untouched until acceptance. Original `codex/beta3-integration`
  remains available.
- The two prior main-to-next merges retain the checked final-call/permission,
  Script serial/visual receipts, permanent work-mode locking, verified legacy
  same-Run recovery and durable Actor settlement contracts. Static review of
  their key resolutions found no concrete runtime regression; this does not
  substitute for the tests below.

The [2026-11-06 assessment](next-dev-integration-assessment-2026-11-06.md)
remains historical. Its W0–W5/A1–A10 dependencies guide this new candidate;
its original SHAs, failure records and model conclusions are not rewritten.
The current CLI fence is 5 MiB minus 49 KiB (5,192,704 bytes), independently
of the historical limits discussed there.

## Initial evidence, not acceptance

The other chat's `e37aef47a` typecheck and 175 selected tests passed. Its fast
suite finished with 386 passed files, one failed, seven skipped; 3,721 passed
tests, one failed and 57 skipped, in 571.86 seconds. The failed oversized-output
recovery case reported `AssertionError: Provider request failed.` through
`record.error`, masking the original scripted callback assertion. A separate
run passed in 5.134 seconds. That pass does not establish the historical
failure's cause or turn the fast suite green.

Both parents reference feature-submodule commit `8111124`; FEATURE_303/304
history is present locally. Authenticated GitHub API inspection on 2026-11-09
returned `No commit found for SHA` for that target, while the older `5d729c2`
was reachable. This is an existing mainline prerequisite, not a new next-dev
gitlink regression. Bootstrap from the local submodule is not proof of remote
checkout availability; remote availability must be closed separately.

That prerequisite is now closed: the existing `8111124` commit was pushed to
the feature repository's isolated
`codex/kodax-next-dev-integration-20261109` branch using the existing token.
Its three documentation changes only repair links. A fresh depth-one remote
clone of that branch checked out the exact gitlink cleanly. The feature
repository's `main`, both parent gitlinks, and the parent repository's remote
branches were not changed.

The existing next-dev `dist/kodax_cli.js` was built on 2026-10-31 and is not
this candidate's artifact. The fresh build measured 5,267,526 bytes, failing
the preserved 5,192,704-byte CLI fence by 74,822 bytes. Package compilation
and native compilation passed before that fence. The gate is not relaxed;
legitimate optional-component loading and state ownership need separate
regressions before any reduction can count as acceptance.
P7's current feature index has been corrected to its recorded mixed outcome;
the original experiment records and limits remain unchanged.

The new candidate build passes without reducing the fence: `kodax_cli.js` is
5,164,670 bytes, leaving 28,034 bytes. Only selected integration commands,
ACP and hosted A2A move behind the existing component loader. Root/topic help
and natural-language `help mcp` parsing retain their existing behavior;
hosted A2A receives the owning Host's diagnostic and storage-lock functions.
Public synchronous integration-command setup remains available. Node bundle
help and ACP initialize regressions pass. Native and complete package gates
remain outstanding.

The historical oversized-output failure did not reproduce: the unchanged
targeted case and all 41 cases in its file passed. The final assertion now
includes retained scripted-callback failures and tool receipts. This adds
diagnostics, not a claimed root-cause fix. No recovery or timeout requirement
was relaxed.

Focused coverage verification passed 187 tests in six files. The new lazy
command helper has 100% statement/branch/function/line coverage. The two A2A
modules together have 82.37% statement coverage; all three modules together
have 82.54%. These are scoped measurements, not repository-wide coverage.

## Window scope clarification

The first combined fixture observed a genuine pre-request refusal at 16,384
tokens: the full AMA/image contract required 20,250. No provider call or tool
execution occurred. The fixture initially awaited a terminal result from a
recovering Run and timed out; that is retained as failed experiment evidence,
not successful 16K reading. The user explicitly excluded 16K on 2026-11-09
and selected **32K and 64K** as this integration's minimum-window acceptance.
The historical assessment's 16K row remains historical; it is not silently
marked complete. No production contract is reduced merely to fit 16K.

## Acceptance sequence

| Gate | Required evidence | Status |
| --- | --- | --- |
| W0 | Fresh graph, committed inputs, submodule identity and remote availability | Graph frozen; exact remote checkout verified |
| Failure closure | Reproduce/diagnose the masked oversized-output failure at the existing public Runtime seam; preserve refusal, actual output recovery and non-replay assertions | Not reproduced; diagnostics retained, 41/41 file and full fast run passed; historical cause remains unknown |
| W1 | Final args, once-only hooks, native/MCP fallback, serial calls, home protection and lifecycle; actual local proxy/CA fixtures | Full tiers and new public-seam regressions passed; real proxy/CA controls passed |
| W2 | Owned visual evidence, shared batch budgets, 32K/64K long-text capacity, repeated compaction/restart, exact accounting and history revisions | New 32K/64K joint regressions and existing full tiers passed |
| W3 | Canonical/custom contract fallback, scoped rules, cross-Run retention and current production request bytes | Existing full tiers passed; scoped-rule and cross-Run retention checks remain separate fixtures |
| W4 | Block before ask, once-only inline/daemon approval, cancellation and no-handler refusal without permanent privilege changes | Full contract/system checks passed; no claim of Space consumer UI acceptance |
| W5 | Complete deterministic suite, typechecks, build, real bundle/package gates and isolated consumption/Host upgrade; 49 KiB reserve unchanged | Baseline four tiers, corrective Artifact/package/native checks and final fast rerun passed; scope below |
| Mainline | Final review; recheck worktrees and ancestry, preserve unrelated files, then use only fast-forward to the verified candidate | Passed; code fast-forward, destination build and CLI smoke verified |

Use existing tests first. Add only missing cross-feature regressions at the
already agreed public Runtime/tool/request seams. No paid model calls are
needed for these engineering gates. Historical semantic model evidence stays
mixed/incomplete where recorded; native sub-100K-model and whole-book quality
are not claimed. Raw probes and run logs stay in OS temporary storage.

## Actual-package defect and correction

The first isolated npm consumer failed after its local image/PPTX/PDF/DOCX
rendering had succeeded: remote `readEvidence` rejected a legitimate PNG with
`Artifact PNG is not attached to its Host invocation.` This was a real
integration defect, separate from the unreproduced oversized-output failure.

VISTA's native `read` pins pixels into Session-owned storage. Artifact's raster
reference deliberately retains its source path, and the wire decoder requires
that reference to equal the admitted request. The client incorrectly assumed
the Host attachment still used the source path. Two independent investigations
confirmed the same chain.

The correction in `10d996d75` locates the unique image in the already verified
tool result, then matches that path on the exact invocation's view item. It
preserves the original raster, Run/call/input checks, expected SHA256, geometry,
chunk bounds and final PNG/hash verification. It never searches other calls or
reads a filesystem path locally. The regression demonstrates RED for a source
path different from its owner archive, then GREEN; foreign calls/Runs, detached,
missing/ambiguous images and corrupt bytes remain rejected.

- Artifact directory: **63/63**, including Chromium-backed cases. Client
  coverage: statements 87.8%, branches 83.54%, functions 100%, lines 97.91%.
- Source/test typechecks and the complete build passed after this correction.
- Fresh npm pack/install consumer then passed with real rendering, Host-backed
  PNG byte equality and browser-free public types. The initial RED is retained.

## Engineering acceptance evidence

The first complete four-tier run at the initial integration patch passed:

| Tier | Passed tests | Skipped tests | Duration |
| --- | ---: | ---: | ---: |
| fast | 3,726 | 57 | 577.61 s |
| unit | 13,926 | 7 | 238.69 s |
| contract | 1,072 | 0 | 51.82 s |
| system | 1,704 | 29 | 436.14 s |

This **20,428 passed / 93 skipped** result precedes the Artifact correction;
it is not retroactively described as a complete rerun of corrected source.
The Artifact-specific and actual-package checks above cover that correction.
The final fast rerun at `f6a60fba7` also passed: **388 passed files / 7 skipped;
3,733 passed tests / 57 skipped**, 585.01 seconds. Unit/contract/system were not
rerun after this isolated client correction; their source and the Actor/work-mode
implementation were unchanged. This does not turn the initial failed package
run into a fully green run: its other four passing checks and the Artifact
consumer's separate corrected pass remain distinct evidence.

- All **32 bundle-gate files** ran: 30 files at concurrency four (**105 tests**),
  then the script's two serial recovery files (**3 tests**). No failures/skips.
  Root/topic help, ACP initialization and hosted A2A card/authentication all
  passed through the real Node wrapper. Windows file/SDK-entrypoint guards:
  **4/4**.
- An actual npm tarball passed isolated SDK types, historical owner migration,
  concurrent first-start convergence and profile-alias checks. The genuine,
  integrity-pinned public beta.3 Host passed busy retention, completion and
  in-place upgrade with its Session preserved. These passed in the initial
  package run; its separate Artifact failure is recorded above.
- Three composition builds preserved the 5,192,704-byte fence: local Windows
  **5,163,658** bytes; five-manifest Windows and Linux compositions both
  **5,164,670** bytes. Minimum remaining margin: **28,034** bytes. The manifest
  audit measures composition; it does not execute Linux native code.
- A fresh local CONNECT proxy and temporary private CA exercised the built
  public Responses provider's SSE and WebSocket paths on Node **22.23.1** and
  Bun **1.4.4**. Unresolvable target names, observed CONNECTs, NO_PROXY bypass
  and untrusted-CA rejection were controls. Node **20.20.2**'s unsupported
  WebSocket path failed directly with no CONNECT. No OS trust store changed.
- Windows Bun compilation and built-in standalone smokes passed. The exact CI
  ZIP inventory (15 entries) was packed and extracted. Archive SHA256:
  `5f91b842a57057d68b088097d98749f10778836a4c98e45761b41c14db4f5369`.
  Its runtime source is `10d996d75`; later fixture/documentation changes do not
  change executable code. The offline archive gate passed **11 scenarios**,
  including locked CLI override refusal, partial effects, cancellation,
  restart, and admitted/cold history locate/resolve/fork/rewind. It captured
  **18 loopback requests, zero external model calls**, with no failures.
- The extracted executable additionally passed all **3 optional-CLI/ACP/A2A
  tests** with Node/Bun absent from its child PATH. Linux/macOS native execution
  remains CI/platform acceptance, not a local success claim.

Both bundle and native ZIP integrity checks exposed stale expected fingerprints
for the Windows effect Job program. Current program SHA256 is
`c9696ac7595a83d47d40f8e714f76ae6d1991836c39b163251a97a1b4097fe61`.
Compared with mainline, its only additions are Stopwatch initialization,
`COMPILED` diagnostic output and Flush; removing those three lines recovers the
old program exactly. The SID probe is unchanged. Only fixed expected hashes
were updated; exact integrity assertions remain, and both RED records remain.

## Standards

Independent fresh-context review of the new integration patch and subsequent
test/client corrections found **0 hard violations and 0 actionable smells**.
This covers our changes after `e37aef47a`; it is not a claim of a new exhaustive
static review of all 316 historical merge files.

## Spec

The independent requirement review found **0 actionable deviations** in these
patches. The Artifact defect found by actual-package execution was corrected
and reviewed separately. Runtime ownership, permanent work-mode locking,
precise image provenance and the 49 KiB reserve remain required contracts.

## Destination and publication boundary

The final recheck confirmed the original mainline SHA, no tracked edits,
fast-forward ancestry and no candidate overlap with the two existing untracked
files. Code was integrated with `git merge --ff-only` to `f6a60fba7`, followed
by a full build in `C:/Works/GitProj/KodaX-AI/KodaX` and an actual Node wrapper
`mcp --help` smoke. That destination has only the local Windows native manifest;
its CLI is **5,163,658 bytes**, matching the local composition case. The five-
manifest maximum remains the separate 5,164,670-byte audited composition.

The original untracked files remain byte-identical and outside these commits:

- `packages/coding/src/task-engine/_internal/managed-task/llm-adapter.run-boundary-cache.test.ts`
- `tests/run-boundary-cache.eval.ts`

The main worktree therefore has preserved untracked work; it is not described
as entirely clean. The validation worktree has no outstanding code edits.
The acceptance-record update is fast-forwarded separately after the code/build
verification and changes no runtime behavior. Package version remains
`0.7.97-beta.4`. No parent-repository push, version bump, publication, installed
Space update, or synchronization of the other next-dev worktree was performed.
The only remote write was the isolated feature-repository availability ref
described in W0.
