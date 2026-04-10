# Repointel Command Reference

The local frontdoor is:

```text
repointel <command> "<json-payload>"
```

Available commands:
- `status`
- `warm`
- `preturn`
- `context-pack`
- `impact`
- `symbol`
- `process`

For non-status commands, the CLI already uses the current working directory as execution context. That means the smallest useful payload is often `"{}"`.

If the task is scoped to the current directory or a known subpath, prefer an explicit target:

```text
repointel preturn "{\"targetPath\":\".\"}"
repointel impact "{\"targetPath\":\"packages/repl\"}"
```

What to read from JSON responses:

- `status`
  - top-level `status`
  - `result.transport`
  - optional `warnings`
- `preturn`
  - compact repo capsule
  - recommended files
  - likely module / intent / risk hints
- `context-pack`
  - richer repo capsule for larger review / edit / explain tasks
- `impact`
  - blast-radius and affected module hints

If `status` or `warm` still indicate `warming`, `limited`, or `unavailable`, stop retrying and fall back to normal local tools.
