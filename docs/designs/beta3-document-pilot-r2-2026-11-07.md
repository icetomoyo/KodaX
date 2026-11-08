# beta.3 document pilot r2 — preregistration

Status: frozen design before model execution; no result is implied. Production
candidate: `58f234dba`. Exact runner, prompt, fixture, tool and request hashes
must be recorded in OS-temporary manifests before the main session enables
transport. A combined manifest binds both component manifests to one ledger.

## Questions and limits

Offline tests establish bounds, restart durability and no replay. They cannot
establish whether a model retains useful document facts through two summaries
or chooses an honest next action after a DOCX fidelity warning. Those are the
only model-facing questions here. This is a controlled pilot, not an autonomous
whole-book benchmark or evidence of native sub-100K-window support.

The user allowed DeepSeek Flash, GLM-5.3-Flash and Kimi for Coding. Start with
`deepseek/deepseek-flash` and `zhipu-coding/glm-5.3-flash`, one replicate per
cell. Both native windows exceed 100K. Enforce a 65,536-token application
budget, a separately labelled 12,000 estimated-input-token ceiling, 2,048 output
tokens and a conservative wire-byte-plus-output/protocol upper bound before
each physical HTTP request. The byte bound is not a measured tokenizer count.

All components share hard maxima: **40 physical provider requests, 600,000
tokens, US$5 external per-token spend, 90 seconds per request**, no automatic
retries or follow-ups. Plan 32 requests, leaving eight unused unless a new
explicit experiment revision justifies them. Do not fill the allowance merely
because it remains. One request per provider may be in flight; different
providers may run concurrently. Subscription quota/usage is recorded; a
subscription is not described as free or given a fabricated per-token price.
DeepSeek peak input/output liability uses US$0.30/1.20 per million tokens,
verified against [official pricing](https://api-docs.deepseek.com/quick_start/pricing/)
on 2026-11-07. Missing usage retains the worst reservation and stops further
requests until the accounting uncertainty is resolved.

## Controlled document chain

Two fixtures exercise cross-chapter exceptions and a later correction, exact
source identifiers, an already-completed edit that must not be repeated, and
an explicitly unread region. Pages come from the production bounded `read`
tool against files larger than the permitted single read; unread material is
never injected. Both arms receive the same allowed facts and the same real
read-tool description through the tools channel. System and summary prompts
use production builders and constants in a hermetic project.

Per model/fixture, the reference arm has one final generation over the three
read pages. The candidate arm has five fixed requests: G1, production
`compact(force=true)` S1, G2 after the next page/correction, production compact
S2, then G3. The returned production checkpoint messages feed the next stage.
Each compaction is prevalidated offline to make exactly one summary request;
additional requests are blocked before transport. The tiny forced trigger and
stage-boundary protected tail are choreography, not a natural threshold test.
Total: 2 models × 2 fixtures × (1 reference + 5 candidate) = **24 requests**.
The reference is an uncompressed control, not an earlier-code quality baseline.
`maxCallsPerCell` and `maxRoundsPerCell` are one for the reference and five
for the candidate, counting summary calls as rounds. Exceeding the usual
three-round default is necessary to observe two actual compactions and the
generation after each; the graph cannot add a sixth candidate round.

Observe transport/summary completion, bounded inputs, source/fact retention,
correction precedence, task-state retention and honest unread scope. Tool calls
proposed by generations are captured, never executed. Invalid or truncated
summaries are not injected or repaired by additional model calls.

## DOCX next-response probes

Two cases use real registered artifact tool definitions and Worker prompt
bytes: a known document with recorded Host capabilities, and the next response
after an actual lightweight result/image evidence item. Baseline/candidate
descriptions and diagnostics are frozen separately; the candidate contains the
current field-recalculation caveat. Total: 2 models × 2 cases × 2 arms × 1
replicate = **8 requests**, sharing the document ledger above.

Opening/inspecting a file is a legitimate precursor. Word/PDF escalation may
be justified by a blocking fidelity limitation. `artifact_open` is not render,
and neither rendering more lightweight pages nor captions establish native
TOC/pagination fidelity. Observe the actual proposed arguments, provenance,
scope and claims; execute none of the proposed tools.

Historical 36 outputs were first reviewed by the main session in 18 blinded
pairs. They lack exact input hashes, usage and actual image pixels, and current
diagnostic bytes have changed. They remain diagnostic historical evidence,
not substitute acceptance for this candidate; scorer changes alone did not
trigger new generations.

## Analysis and stopping

Persist immutable per-request wire inputs (without headers/credentials), raw
responses, result/errors, usage, source revisions and hashes in OS temporary
storage. Reserve worst liability atomically before transport and reconcile
reported usage afterward. Stop on any hard bound, unknown accounting, protocol
failure or invalid task design; retain every failure without retrying it away.

The main session reads blinded paired outputs against fixture ground truth
and records judgments before revealing arm mapping. Mechanical observations
diagnose what happened; they do not impose a per-alias Boolean ship gate.
Report task validity, useful retention, harms and attribution separately
(`eval-design`, `provider-noise`, `prompt-regression`, `inconclusive`). Finish
with recommend-ship, recommend-iterate, recommend-revert or eval-invalid for
the observed scope, preserving the user's final release decision. No judge
panel, sample expansion or Kimi fallback is preauthorized by this protocol.
