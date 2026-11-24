# KodaX Documentation

Documentation for KodaX users, product-client integrators and trusted Host developers.

This development tree implements the unified Product Client contract under
FEATURE_298/299/301/303/304/305/306. The package version is `0.7.97-rc.2`;
`v0.7.96` remains the last stable release. `v0.7.97-rc.2` lands RepoIntel
phase 0 (the default tool surface keeps to what git can answer: `repo_overview`,
`changed_scope` and `changed_diff` under `auto`; the semantic tools and the
background index need `repoIntelligenceMode` `full`/`light`; the index moves
under `<config home>/repo-intelligence/`), repairs the reasoning-replay
defects (Issues 441-442: reasoning from another model never becomes reply
text and Gemini/pi-messages replay foreign tool calls as real calls instead
of `<prior_tool_call>` text), and lists `glm-5.4` on `zhipu-coding`;
`v0.7.97-rc.1` refreshes the
model catalogs (Claude Fable 5.2, the GPT-6.x lineup with per-model effort
declarations, defaults on `claude-sonnet-5-5` and `gpt-6.2-sol`) and
repairs the late provider, Host and REPL issues (Issues 431-440): native
Claude models accept forced-tool requests, OpenAI strict tool schemas fall
back to non-strict, retry classification retries the real transient shapes,
extension internal tool calls stay out of the Session view, Windows
process trees read through the native sandbox helper so bash no longer
blocks the Host event loop, the memory review scan locks only a
stale-claimed session and its receipt is announced only after the job
completes, the Host and CLI stop blocking on repeated Git and PowerShell
probes, and the REPL neither jumps while a reply streams nor loses a
submitted input before the Host view shows it; `v0.7.97-beta.13` repairs the
Space integration and Session-read costs (Issues 424-430): a client exit
whose cleanup failed no longer blocks later starts once the old Host has
exited, a managed Run saves the user's exact words even with a prepared
prompt, `runs.start` warns about retired inputs, the daemon maps Runtime
failure codes onto protocol codes, integration health reads without the
preflight, the preflight reuses cached Session metadata, and display-history
checkpoints append a bounded delta during a Run;
`v0.7.97-beta.12` gives every root
Run the managed Worker and the same tool text as Space and the REPL
(FEATURE_311, SA mode retired), settles every Stop under
`actorSettlementConvergence:3`, reports a failure's real cause in
`failure.detail`, sends `X-Session-Id` with UUIDv7 session ids, and isolates
A2A Tasks from the Host owner's memory; `v0.7.97-beta.11` keeps Session
history readable during a busy Run (older cache pages, entry chunks and cursors
stay valid while a Run writes; a blocked read reports `writer_active`) and makes
Skills tool-neutral (`allowed-tools` no longer restricts tools, hooks or dynamic
context), retains a failed Run's error item in session views and names skipped
`ask_user_question` texts as `unanswered`; `v0.7.97-beta.10` adds merged-input
acknowledgement (`ClientViewItem.inputIds` names every input the Host merged
into one canonical user message, head first, so a client retires each merged
input's pending bubble) and stops a Host restart from restoring merged
non-head inputs as `queued`; `v0.7.97-beta.9` adds data root relocation (FEATURE_306: `resolveKodaXHome` and `copyKodaXDataRoot`), lets `inputs.withdraw` take back an undelivered `steer` input, refuses a client exit stop at once while a peer is attached (Issue 410) and ignores a relative `KODAX_HOME` with a warning; `v0.7.97-beta.8` repairs Windows daemon startup reliability (Issue 409): the fail-closed startup path verifies and supervises the kill-on-close Job with the bundled native helper instead of compiling C# in PowerShell, failed starts retain cleanup handles with serialized admissions, and `child_exit` is retryable; `v0.7.97-beta.7` repairs the
Space SDK image projection, attachment reads and extension approval
attribution from the Space integration report (Issue 408): user image
observation labels leave the view, history and search, Host attachment reads
cover PNG, JPEG, WebP and GIF with the actual mediaType, the read-only visual
tools resolve to the `read` capability, and extension approvals carry
structured per-extension attribution; `v0.7.97-beta.6` moves to one
Host per `KODAX_HOME`: the Host-location `profile` is removed from the SDK
entry points and the `kodax host` (then named `daemon`) and `a2a serve` commands (breaking), Space
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
approval-attribution corrections shipped in `v0.7.97-beta.7`; the Windows daemon native Job startup repairs shipped in `v0.7.97-beta.8`; data root relocation and steer withdrawal shipped in `v0.7.97-beta.9`; merged-input acknowledgement shipped in `v0.7.97-beta.10`; readable history during a busy Run and tool-neutral Skills shipped in `v0.7.97-beta.11`; one prompt chain for every root Run and final Stop outcomes shipped in `v0.7.97-beta.12`; the Space integration repairs and Session-read cost fixes shipped in `v0.7.97-beta.13`; the model catalog refresh and late provider/Host repairs shipped in `v0.7.97-rc.1`; the RepoIntel phase 0 default surface, reasoning-replay repairs and the `glm-5.4` listing shipped in `v0.7.97-rc.2`. Read the
[SDK overview](sdk/overview.md), the [SDK migration guide](../docs/SDK_MIGRATION.md)
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
- [Memory](./configuration/memory.md) — Notes across sessions, background learning, `/memory`

## SDK

- [SDK overview](./sdk/overview.md) — install, package entries, v2 Host client versus in-process use, where data lives.
- [Host client](./sdk/host-client.md) — connect to a Host, follow Sessions, submit input, answer interactions.
- [Host platform](./sdk/host-platform.md) — roles, Session policy, leases, child Agents, A2A and ACP.
- [In-process](./sdk/in-process.md) — run KodaX inside your own Node process.
- [Optional modules](./sdk/optional-modules.md) — Artifact SDK, sandbox, media input, Skill learning.
- [Host protocol v2 reference](./sdk/host-protocol-reference.md) — every method, generated from the code.
- [SDK migration](../docs/SDK_MIGRATION.md) — old-to-new calls, lifecycle and migration acceptance (Chinese).
- [Client contract](../docs/CLIENT_CONTRACT.md) — complete Product method inventory, observation, history and error semantics.
- [Artifact SDK](../docs/ARTIFACT_SDK.md) — optional independent package, shared-Host/Node setup, nine operations, format support, evidence and visual-review limits.

## Deployment

- [Run a KodaX Host](./deployment/host.md) — host.json, tokens, lifecycle, health, containers and services, web UI safety (unreleased).
- [Remote access](./deployment/remote-access.md) — reach your own Host from a phone through a tunnel and device pairing (unreleased).

## Guides

*(More standalone guides coming soon: CLI reference, REPL commands, sessions, multi-agent, skills, extensions, MCP, A2A, repo intelligence, memory, workflows, compaction, doctor, tools reference. Current Skill SDK semantics are documented in the Embedder Guide.)*

## Reference

*(Coming soon: troubleshooting, FAQ, comparison, license.)*
