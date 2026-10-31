# Independent LLM operations

The standalone `@kodax-ai/llm` package and root SDK `/llm` subpath expose
`generateImages`, `classify`, `submitDeferred`, `fetchDeferred` and
`cancelDeferred`. These return typed operation results separately from chat.
Existing provider configuration, aliases and environment key names remain valid.

Use `createProviderOperationConnection(providerId, input)` for declared provider
routes. It creates connection metadata and does not register or replace a chat
provider. Account/model endpoints remain explicit where discovery is unavailable.
The factory requires explicit image/Cloudflare dialect selection. Subscription
tokens are not interchangeable with API keys; the factory does not expose
Decisions/background API-key operations under the Codex subscription identity.

```ts
import { createProviderOperationConnection, classify } from '@kodax-ai/llm';

const connection = createProviderOperationConnection('typesafe', {
  name: 'support-routing', api: 'typesafe-system-one', model: selectedModel,
});
const result = await classify(connection, {
  state: ticket,
  questions: { billing: { type: 'bool', instructions: 'Does this concern billing?' } },
}, signal);
```

Outside a scoped Host, API-key connections read their configured environment
variable. `credentialSource:'broker'` requires an explicit credential scope.
Inside an active scope, every operation uses the existing broker allowlist and
purpose (`classifier` or `utility`); revoked or missing authority cannot fall
back to an ambient key. Connection/request data is snapshotted before awaiting
credentials. Physical observations contain identity/usage, never payloads or keys.

Classification supports bool/choice/score. Choices and score results retain the
native distributions; Decisions can return a refusal for an individual question.
Invalid, missing or foreign labels fail the operation. Auto permission uses its
existing independent classifier. llama.cpp requires a server exposing native
tokenization, template application and pre-sampling token log-probabilities;
models whose labels do not tokenize distinctly fail explicitly. These values
are model estimates; application-specific calibration is still required.

Image inputs use canonical base64 bytes plus optional MIME and pass the existing
decoder. TypeSafe assets accept PNG/JPEG; explicit OpenRouter System One input
uses state image parts; Clef applies its own documented media limits. No input
operation silently downloads a URL or reads a new local path.

Image generation requires `api:'openrouter-images'` and explicit
`dialect:'images'|'chat-completions'`. Native parameters carry model-supported
size/quality/provider options; they cannot replace core identity or request
fields. Dedicated SSE supports temporary `onPreview` notifications. Only final
complete images appear in the returned result. SVG bytes may be returned as
explicitly unverified data, never admitted as decoded image artifacts.

Trusted Main/Host may call `publishGeneratedImages` from the root SDK `/media`
subpath with complete images, its existing artifact service and a preselected
absolute output directory. It verifies bytes again, chooses exclusive filenames
and registers the resulting files. Generated filenames/URLs cannot select disk
paths. Batch failure rolls back new files/registrations; cleanup failures remain
visible. The helper does not authorize a directory or create a tool grant.

Background Responses requires `api:'openai-background-responses'`, an explicit
output budget and a trusted stable `accountScope` supplied by the Host. The
scope identifies the authorized registration/account; it is not an unverified
token claim. `store` defaults to false; current service documentation describes
temporary polling retention. Retain longer only with explicit `store:true`.

Persist only `result.reference` for restore, then call `fetchDeferred` with a
fresh authorized connection of the same scope. Each call performs one status
check. `cancelDeferred` cancels remote computation; aborting local observation
does not. Pending and unsuccessful states expose no executable tools. Completed
results share chat's strict final-output parser. `usageKind:'cumulative'` and
`usageId` let a consumer deduplicate job accounting; polling/cancelling is not
another inference charge. References grant no credential or execution authority.
Failed, cancelled and incomplete terminal snapshots preserve reported cumulative
`partialUsage` with the same deduplication ID; absent usage remains unknown.
`KodaXDeferredOutputError` preserves that reference and cumulative partial usage
when final-output validation rejects a completed response.

Classification uses bounded transient HTTP retry unless `singleAttempt:true`.
Quota errors fail immediately. Image generation and background submission do
not automatically replay ambiguous delivery. Use caller/Host abort signals for
deadlines. All listed service contracts are tested offline; real account access,
model calibration, retention timing and charges are not verified by fixtures.

Protocol sources, revisions and regression evidence are recorded in the
[FEATURE_302 guide](test-guides/FEATURE_302_v0.7.99_TEST_GUIDE.md#t10-native-operations--scoped-acceptance).
