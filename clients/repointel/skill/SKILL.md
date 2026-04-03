---
name: repointel
description: Use the local repointel tool to narrow repository scope before large reviews, refactors, debugging, impact analysis, or other multi-file tasks.
---

# Repointel Bootstrap

Use this skill when a task needs repository understanding before acting and the local `repointel` tool is available.

This skill is bootstrap-only. It does not contain premium logic. It only teaches the host when to call the local `repointel` command, how to read the result, and when to fall back cleanly.

Assume the normal user-facing setup is native-first:
- prefer an installed `repointel` command or executable
- do not assume a source-linked private checkout or loose JS bundle is available

## Additional resources

- For exact command syntax, payload shapes, and response fields, see [reference.md](reference.md).

## When to use it

Use `repointel` when the task needs repository understanding before acting:
- large edits, refactors, reviews, and debugging across multiple files
- impact or blast-radius analysis before changing code
- process or call-chain discovery
- repository scoping under a tight token budget

Do not use it for tiny single-file edits where direct read/search is already enough.

## Recommended workflow

1. Health check first.
- Run `repointel status "{}"` once before relying on premium context.
- Read the JSON response and check:
  - top-level `status`
  - `result.transport`
  - optional `warnings`

2. If the tool is warming or unavailable.
- Try `repointel warm "{}"` once.
- If it still does not become usable, stop retrying and fall back to the host's normal local read/search/grep tools.

3. Normal first call.
- Start with `repointel preturn "{}"` for broad review, plan, explain, or edit tasks.
- This is the default first step because it is lighter than a full `context-pack` and usually enough to narrow scope.

4. Richer context only when needed.
- Use `repointel context-pack "{}"` when you need a richer repository capsule before a larger task.
- Use `repointel impact "{}"` for blast-radius questions.
- Use `repointel symbol ...` or `repointel process ...` only after scope is already narrowed.

## Behavior rules

- Prefer compact capsules over large raw file dumps.
- Treat recommended files, module hints, and risk hints as the first inspection set.
- Do not assume premium intelligence is always available.
- If `repointel` is unavailable, degrade cleanly to local host tools instead of looping on retries.
