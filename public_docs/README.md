# KodaX Documentation

Documentation for KodaX users, product-client integrators and trusted Host developers.

This development tree implements the unified Product Client contract under
FEATURE_298/299. The package baseline is the stable `0.7.96`; the design target is
`v0.7.97`, and npm publication is a separate maintainer action. Historical release
notes do not override the current Client contract or establish that a package
has been published.

For TUI, desktop/IDE clients and shared-Session automation, start with
`@kodax-ai/kodax/client`. The Host owns execution, settings and persistence.
Independent library and trusted Host APIs remain separate integration layers.
## Getting Started

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

## Guides

*(More standalone guides coming soon: CLI reference, REPL commands, sessions, multi-agent, skills, extensions, MCP, A2A, repo intelligence, memory, workflows, compaction, doctor, tools reference. Current Skill SDK semantics are documented in the Embedder Guide.)*

## Reference

*(Coming soon: troubleshooting, FAQ, comparison, license.)*
