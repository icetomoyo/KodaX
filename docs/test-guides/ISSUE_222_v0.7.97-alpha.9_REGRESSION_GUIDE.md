# Shared Host metadata admission and client-exit regression

## Scope

The pending alpha.9 CRC/EIO fix `0f0c8293` replaced whole-transcript admission
reads with strict canonical metadata reads. GLM reported that the existing
two-client exit case passes at alpha.8 (`bbcf2510`) and fails at `0f0c8293`.
The failure was independently reproduced on Windows: the exiting client's
cleanup succeeded, but its Host receipt became `unknown` instead of `protected`.
No release or tag was made during this repair.

## Confirmed cause and repair

A targeted preflight probe surfaced `SessionReadError` with code `data_changed`
from `resolveSessionLocation`, through `readActorMetadata`, `admitsSession` and
`filterAdmittedRunStatuses`. This was a strict read boundary conflicting with
legitimate live Session persistence, rather than a missing metadata field.

An initial repair reused nonterminal owned Run admission. Although all source
tiers passed, its bundle gate failed 43/44: final daemon inspection raced
`managed-session` persistence after that Run had completed. Run completion does
not end the Session controller's lifetime.

Run listing and inspection now use the same authority distinction as Actor
preflight: only initialized controllers that have passed Session admission and
still hold their durable owner fence can supply live admission. A controller
remains authoritative across Run completion and trailing persistence. No new
authorization cache is introduced. Unclaimed Sessions and controllers whose
ownership has been released still require strict canonical metadata admission.

No read-boundary checks were weakened. No transcript fallback, ignored metadata
error, extra retry, timeout extension, or change to exit-receipt classification
was introduced. This does not repair physical storage or reconstruct damaged
transcript bytes.

## Automated acceptance

Run from the KodaX repository:

```powershell
npx vitest run src/sdk-client.exit.test.ts src/sdk-runtime.preflight-projection.test.ts
npm run test:full
npm run typecheck
npm run build
npm run test:bundle
```

The public two-client case must settle only the exiting client's work, retain
the other client's active Run and Actor, classify the Host as `protected`, keep
the foreign queued input executable, reject new work from the exited identity,
and preserve its receipt after reconnect. It also checks public preflight while
the other client remains active.

The deterministic live-controller case pauses a real canonical Actor write
before file replacement, with only a historical completed Run. Listing must
finish while that write remains paused. After archive releases controller
ownership, corrupt metadata must again make listing fail. The fixture performs
no model request.

The EIO cases must still admit a readable canonical header with an unreadable
historical body, retain active/unknown Run and Actor exit blockers, reject an
unreadable identity header, and report EIO when explicitly loading the affected
Session. The storage Actor-read suite must retain its concurrent writer,
file-identity, topology and migration guards. Shared daemon admission must still
reject Partner and unknown-surface Sessions.

### Local qualification (2026-10-19)

Windows, Node 22.23.1. The superseded nonterminal-Run repair passed 16,742 source
cases, with 90 skips and 19 TODOs, but failed the compaction bundle gate above.
That green source result is not final acceptance. Final qualification is
recorded after the owner-fence repair. These are local Windows results, not new Linux Node 20/22
or branch-CI evidence. Release preparation remains separate; its stash and the
preexisting features submodule checkout are retained.

Final source implementation: `315d6a2ea92c3a7308dc418c5eb20c1c836c46a7`.

| Final gate | Result |
| --- | --- |
| Fast | 2,323 passed, 44 skipped |
| Unit | 12,030 passed, 4 skipped |
| Contract | 950 passed, 19 TODO |
| System | 1,440 passed, 42 skipped |
| Source and test TypeScript checks | Passed |
| Complete workspace/native/bundle/declaration build | Passed |
| Bundle gate | 44 passed, no skips; includes the original failing compaction and Product exit cases |
| Public declaration comparison | All 14 top-level declaration files byte-for-byte unchanged |

All four final source tiers exited successfully: **16,743 passed**, 90 skips,
19 TODOs, zero failures. The System command used `--reporter=verbose` for
progress visibility; concurrency and timeouts were unchanged. Production and
test sources remained fixed throughout the final sequence. The 3 Product exit
cases and 6 preflight projection cases passed in these full tiers; the latter
includes the real paused-save/released-fence regression and both body-EIO cases.
The final TypeScript checks, build and complete bundle gate also passed.

This closes the local regression, not npm delivery or release-CI qualification.
Restore the maintainer's release layer and run the normal branch CI before
tagging or publishing. No tag, push, release or npm publication was performed
during this repair.

## Standards

Final Standards review of `0f0c8293..315d6a2`: zero actionable findings. The
ownership predicate stays within the registry, reuses the durable fence, and
adds no configuration or general-purpose abstraction. The write-barrier test
settles operations before restoring its spy and closing the Runtime. This was
static review, not an independent test run.

## Spec

Final Spec review of the same fixed diff: zero actionable findings. Only
initialized, admitted controllers with a retained owner fence supply live
identity; unclaimed, initialization-pending, released and closed controllers
fall back to strict metadata admission. The paused-save, released-fence,
two-client exit and EIO cases cover the accepted behavior. No retry, wait or
receipt reclassification was added. This was static review; execution evidence
is recorded separately above. The initial review's zero findings did not close
the later bundle failure and were not treated as final acceptance.
