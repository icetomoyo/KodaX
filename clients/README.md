# Client Integrations

`clients/` is reserved for external third-party host integration surfaces.

Applications sharing KodaX Sessions use `KodaXProductClient` through
`@kodax-ai/kodax/client`. Start with the [product integration guide](../public_docs/sdk/embedder-guide.md#product-client-integration),
[migration guide](../docs/SDK_MIGRATION.md), and [Client contract](../docs/CLIENT_CONTRACT.md).
Executable Runtime objects, Session storage and MCP connection owners belong to
the Host; this directory does not supply a browser transport.

It is currently empty: repo intelligence is built into KodaX, so no external
host skill or standalone frontdoor is required for normal usage. See
[docs/REPOINTEL.md](../docs/REPOINTEL.md) for the history of the former
standalone `repointel` integration and the built-in replacement.
