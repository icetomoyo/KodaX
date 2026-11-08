# beta.3 DOCX pilot R4 — independent phase preregistration

Status: method prepared and inputs audited; no R4 request has been dispatched.
Production candidate: `e0b508ade5cddd8560f6245315944a1bbbe57e67`.
R4 authorizes only the previously planned eight DOCX responses. It does not
resume, retry or relabel the stopped SC experiment.

## Frozen inputs and question

Layer 1 already verifies DOCX/PPTX conversion, structured fallback and evidence
provenance. It cannot establish how a model interprets the tool description or
a fidelity warning. R4 remains a Layer 2 next-response pilot: two models × two
cases × two arms × one replicate. The cases are the known document with recorded
Host capabilities and the next response after actual lightweight result/image
evidence. No proposed model tool call is executed.

Reuse the eight R3 logical inputs, prepared native wires, image/source assets,
call IDs, case facts, blind mapping and existing runner without modification:

- `docx-manifest.r3.json`: `5aff8a795485509d943854cadada7dd8e0bbe25422c8b0287baed8e17d6d27b2`.
- Existing `frozen-candidate.r3.json` data envelope: `69bed993f8b0a64050aa0b88a04341f472c89747c1cfdf7d0d00e1f7e26abf96`.
- R4 audit, `docx-r4-input-audit.json`: `ba0d6ed8001fefba91982f0879ceaf64fd26b7f0144836b402db0e712548a29a`.

JSON digests use the runner's `pilotHash(parsed JSON)` convention. These files
reside in the existing OS-temporary `kodax-beta3-document-pilot-r2-20261107`
directory. The audit matched all 127 captured source files, two assets, eight
logical inputs and eight wire payloads against current bytes. Maximum measured
input estimate is 6,108 tokens; maximum wire size is 41,816 bytes and its
wire-byte-plus-output/protocol reserve is 47,960, below 65,536. The byte bound
is not an exact tokenizer measurement. No source, input, wire or image was
regenerated; no provider request or reveal read occurred during this audit.

R3 filenames describe the unchanged runner/data format, not renewed experiment
authorization or proof that its older production commit is the R4 candidate.
Before execution, Main must write a new immutable R4 phase freeze binding the
production commit above, this preregistration, these data/audit digests, the
eight-call allowlist and the audited ledger transition. Keep every R2/R3 file.

## Ledger transition and limits

The shared ledger already contains **16 settled SC physical requests, 101,098
tokens and US$0.0251385 DeepSeek peak per-token liability**, with zero reserved
tokens/USD, zero unknown-usage calls and no reservation entries. GLM subscription
quota remains accounted separately from incremental token billing.

After verifying that state and that no request is in flight, Main may explicitly
record the independent DOCX phase transition and clear only the prior
`sc-deepseek-deepseek-flash-PROTOCOL_B-s1` output-cap stop for this phase. Retain
the original SC failure, stop receipt and raw evidence. Neither this document
nor the runner silently clears the fence; any different ledger state requires
another audit. No SC continuation is authorized by that transition.

Eight new DOCX requests yield **24 cumulative physical requests**. The original
shared maxima remain **40 requests, 600,000 tokens and US$5**; no allowance is
reset. Retain the 65,536 application budget, separate 12,000 estimated-input
ceiling, inclusive 2,048 output cap and 90-second request timeout. Use only
`deepseek/deepseek-flash` and `zhipu-coding/glm-5.3-flash`, one request per
provider in flight, with the two providers allowed concurrently. No model
substitution, cap increase, retries, sample expansion or judge calls. Failures
stop further dispatch while already-dispatched lanes settle and retain raw/usage.

## Observation and decision

Keep immutable native request bodies without credentials, raw responses,
result/errors and usage in the shared OS-temporary evidence directory. Associate
the existing runner's R3-format outputs with the new R4 phase freeze. Main reads
the blinded paired responses before any mapping/reveal and records task
validity, preference, harms, uncertainty and reasons.

Opening or inspecting is a legitimate precursor; Word/PDF escalation may be
appropriate after a blocking fidelity warning. Judge actual arguments against
the exposed schema, provenance and honest scope. Rendering, tool-name prefixes,
captions and regex phrases do not establish visual approval or native TOC
fidelity. Report each case/model separately and attribute limitations to
`eval-design`, `provider-noise`, `prompt-regression` or `inconclusive`; finish
with a scoped recommendation, not a per-alias Boolean shipping gate. This small
pilot does not validate native sub-100K models, whole-document reading or the
previously stopped summary chain. The user/owner retains the release decision.
