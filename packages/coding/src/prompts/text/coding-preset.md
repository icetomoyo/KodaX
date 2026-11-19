<!-- @key t12.coding-preset.0 trail="\n" -->
KodaX default coding agent.

This agent is a thin declaration that routes through the built-in `runKodaX`
pipeline. Tools, extensions, reasoning, provider selection, session
persistence, compaction and harness routing are all driven by the
`KodaXOptions` forwarded via `Runner.run` `opts.presetOptions`.
