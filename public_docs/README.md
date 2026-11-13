# KodaX Documentation

Documentation for KodaX users, product-client integrators and trusted Host developers.

This development tree implements the unified Product Client contract under
FEATURE_298/299/301/303/304/305/306. The package version is `0.7.97-beta.9`;
`v0.7.96` remains the last stable release. `v0.7.97-beta.9` adds data root relocation (FEATURE_306: `resolveKodaXHome` and `copyKodaXDataRoot`), lets `inputs.withdraw` take back an undelivered `steer` input, refuses a client exit stop at once while a peer is attached (Issue 410) and ignores a relative `KODAX_HOME` with a warning; `v0.7.97-beta.8` repairs Windows daemon startup reliability (Issue 409): the fail-closed startup path verifies and supervises the kill-on-close Job with the bundled native helper instead of compiling C# in PowerShell, failed starts retain cleanup handles with serialized admissions, and `child_exit` is retryable; `v0.7.97-beta.7` repairs the
Space SDK image projection, attachment reads and extension approval
attribution from the Space integration report (Issue 408): user image
observation labels leave the view, history and search, Host attachment reads
cover PNG, JPEG, WebP and GIF with the actual mediaType, the read-only visual
tools resolve to the `read` capability, and extension approvals carry
structured per-extension attribution; `v0.7.97-beta.6` moves to one
Host per `KODAX_HOME`: the Host-location `profile` is removed from the SDK
entry points and the `kodax daemon`/`a2a serve` commands (breaking), Space
and the CLI share one compatible Host across installations, the standalone
binary's Linux floor drops to glibc 2.17, and Session settings no longer
drift with shared user defaults; `v0.7.97-beta.5` integrates the
SDK foundation hardening (extension `tool:before` on every dispatch path and
failing closed, agent-home extension/integration write protection,
`web_fetch` metadata and private-redirect refusal), proxy and private CA
support, extension asks for one-call human approval, durable visual
observations and Managed Run Context reuse, with Windows sandbox, cold-start
and agent-home retention repairs; `v0.7.97-beta.4` repairs the
Space SDK instruction and history client contracts (AGENTS-only editor
loading beside a tagged instruction loader, history contract v2 with
revision-fenced Fork/Rewind/Retry turn targets, bidirectional paging and
cancellable reads, typed capability checks and optional launcher
requirements); `v0.7.97-beta.3` repairs
long-context recovery (bounded reads, adaptive compaction budgets and strict
complete-summary parsing), durable independent Actor settlement, the
first-Run work-mode lock and saved Session history (`productHistoryLocation`
and `productHistoryTurnResolution`), with verified interrupted-exit recovery
and DOCX/LibreOffice evidence; `v0.7.97-beta.2` hardens Script
execution reliability (collision-safe VM call paths with typed program data,
native tool-name wire fidelity, optional sourceContent and on-demand
outputSchema, missing-Node-global contextual guidance) with shared Host
recovery and Workflow finalization fixes; `v0.7.97-beta.1` completes the
Space-facing Host execution and Session seams (Main default Skills with
consumption-time execution bindings, Quick Ask Session promotion,
redirect-boundary recovery and atomic core-config publication);
`v0.7.97-alpha.12` converges public
product execution on the independent shared Host and lands the FEATURE_302
provider/OAuth credential parity stack with Claude 5.5 history support;
`v0.7.97-alpha.11` adds explicit Agent/Coding/Script work modes and refreshes Ark, MiMo and MiniMax catalogs; `v0.7.97-alpha.10` resumes checkpointed Runs after Host restart with fresh authority, extends live context-capacity recovery, adds Kimi K3.1 provider routes and answer-aware AskUser skip policies; `v0.7.97-alpha.9` isolated unreadable Session transcript bodies from Run listing/daemon inspection via canonical-metadata admission checks; `v0.7.97-alpha.8` shipped the
Artifact SDK inside the single main package (`/artifacts*` subpaths, Node
floor 20.16, no separate artifacts npm package); `v0.7.97-alpha.7` resolved
shared-Session Host ownership across daemon profiles with retryable
startup/connection timeouts, idle Host retirement and bounded Windows
attachment; npm publication is a separate maintainer
action. Historical release
notes do not override the current Client contract or establish that a package
has been published.

For TUI, desktop/IDE clients and shared-Session automation, start with
`@kodax-ai/kodax/client`. The Host owns execution, settings and persistence.
Independent library and trusted Host APIs remain separate integration layers.
SDK and CLI startup share `onStartupProgress`, including actual Host
`initializing/phase` observations; these do not establish readiness or add probes.
## Getting Started

Session work modes (Agent, default Coding and experimental Script), consistent
question outcomes, saved original tool reads, structured task reports and
estimated-token streaming progress shipped in `v0.7.97-alpha.11`; the unified
Host cutover and provider/OAuth credential parity shipped in
`v0.7.97-alpha.12`; the Space execution and session seams completed in
`v0.7.97-beta.1`; Script execution reliability hardening and shared Host
recovery fixes shipped in `v0.7.97-beta.2`; long-context recovery, durable
Actor settlement and saved-history location/turn resolution shipped in
`v0.7.97-beta.3`; the instruction and history contract v2 repairs shipped in
`v0.7.97-beta.4`; extension policy hardening and asks, proxy/private CA
support and durable visual observations shipped in `v0.7.97-beta.5`; one
Host per `KODAX_HOME` with the Host-location `profile` removed shipped in
`v0.7.97-beta.6`; the Space SDK image projection, attachment and
approval-attribution corrections shipped in `v0.7.97-beta.7`; the Windows daemon native Job startup repairs shipped in `v0.7.97-beta.8`; data root relocation and steer withdrawal shipped in `v0.7.97-beta.9`. Read the
[current SDK alignment](sdk/embedder-guide.md#post-alpha10-sdk-alignment),
[unified Host cutover](sdk/embedder-guide.md#unified-host-sdk-cutover-shipped-in-v0797-alpha12)
and [one Host per KODAX_HOME](../docs/SDK_MIGRATION.md#one-host-per-kodax_home-profile-removed)
for compatibility and standalone-library boundaries. Historical first-read
latency remains tracked in Issue 371.

- [Overview](./getting-started/overview.md) — What KodaX is and how it compares
- [Installation](./getting-started/installation.md) — npm, single binary, build from source
- [Quickstart](./getting-started/quickstart.md) — Your first session

## Configuration

- [Providers & API Keys](./configuration/providers.md) — 16 built-in provider aliases
- [Custom Providers](./configuration/custom-providers.md) — OpenAI/Anthropic-compatible endpoints
- [Configuration Files](./configuration/config-files.md) — config.json, split files, env vars
- [Permission Modes](./configuration/permissions.md) — Plan / Edits / Auto[LLM] / Full Access + Exec Policy
- [Sandbox](./configuration/sandbox.md) — Optional OS-level containment (ASRT)

## SDK

- [Product Client integration](./sdk/embedder-guide.md#product-client-integration) — default entry for shared-Session applications; also links to scoped low-level Host/library reference.
- [SDK migration](../docs/SDK_MIGRATION.md) — old-to-new calls, lifecycle and migration acceptance (Chinese).
- [Client contract](../docs/CLIENT_CONTRACT.md) — complete Product method inventory, observation, history and error semantics.
- [Artifact SDK](../docs/ARTIFACT_SDK.md) — optional independent package, shared-Host/Node setup, nine operations, format support, evidence and visual-review limits.

## Guides

*(More standalone guides coming soon: CLI reference, REPL commands, sessions, multi-agent, skills, extensions, MCP, A2A, repo intelligence, memory, workflows, compaction, doctor, tools reference. Current Skill SDK semantics are documented in the Embedder Guide.)*

## Reference

*(Coming soon: troubleshooting, FAQ, comparison, license.)*
