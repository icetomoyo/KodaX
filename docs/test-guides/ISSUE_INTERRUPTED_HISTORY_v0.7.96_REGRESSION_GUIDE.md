# Interrupted managed-run history regression

Runtime-owned (`persistedByHost: false`) managed runs must save each generated
message before executing tools or requesting another generation. A failed save
must surface as a run failure; it must not acknowledge queued input as durable.
Host-owned persistence remains unchanged. Use Runner's current transcript after
compaction, and skip the initial input replay rather than re-saving all history.

Regression: a mocked provider produces assistant text plus a read tool, then
fails on its next request. At that request, storage must already contain the
assistant and tool result. Existing queued-input snapshot failure, compaction,
idle continuation and delivery receipt tests remain passing.

Validation: 244 tests passed, 2 todo across 10 managed/primitive Runner and
compaction test files; `npm run build:packages` passed.

Partial provider streams which have not reached a message commit remain journal
output. Space recovers these for display with interruption/retry notices; this
change does not promote an unfinished stream to a model-context message.
