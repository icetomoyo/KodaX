# Repointel Host Integration

`clients/repointel/` is the complete third-party host integration unit for Phase 1.

It intentionally keeps these assets together:
- `skill/`
  - the installable shared skill directory
  - contains `SKILL.md` and supporting reference files
- `install.mjs`
  - installs the shared skill into a host-specific target path
- `doctor.mjs`
  - validates local premium setup, daemon reachability, and installed host skill
- `demo.mjs`
  - runs a local premium demo flow against a temporary endpoint

This structure is intentional:
- premium logic lives in local `repointel`, not in host-specific wrappers
- the skill and the helper scripts belong to the same integration surface
- keeping them together is cleaner than scattering host tooling across the repo root

## Normal usage

Install the shared skill into a host-specific target path:

```powershell
node .\clients\repointel\install.mjs --host codex
node .\clients\repointel\install.mjs --host claude --workspace-root C:\path\to\workspace
node .\clients\repointel\install.mjs --host opencode --workspace-root C:\path\to\workspace
```

Run diagnostics:

```powershell
node .\clients\repointel\doctor.mjs --host none
```

Run a local demo flow:

```powershell
node .\clients\repointel\demo.mjs --skip-build
```

## Phase 1 rules

- This folder is bootstrap-only and open.
- It is not the premium engine.
- It only teaches hosts when to call local `repointel` and how to handle `ok`, `limited`, `warming`, and `unavailable`.
- Premium task policy, context packing, routing, and impact logic remain closed inside [`KodaX-private`](/C:/Works/GitWorks/KodaX-author/KodaX-private).

## Why this shape

The installable skill itself now lives under `skill/`, which matches the Claude Skills model more closely:

- an installable skill is a directory with `SKILL.md` as the entrypoint
- optional supporting files live next to it
- repo-maintainer helper scripts stay in the surrounding integration folder instead of being copied into the installed host skill
