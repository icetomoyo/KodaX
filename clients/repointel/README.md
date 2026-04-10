# Repointel Host Integration

`clients/repointel/` is the complete third-party host integration unit for Phase 1, organized as a standard Claude Code skill directory.

```
clients/repointel/
├── SKILL.md           # Skill entrypoint (required)
├── reference.md       # Command reference for Claude
├── scripts/
│   ├── install.mjs    # Installs the skill into a host-specific target path
│   ├── doctor.mjs     # Validates local premium setup, daemon reachability, and installed host skill
│   └── demo.mjs       # Runs a local premium demo flow against a temporary endpoint
└── README.md
```

This structure follows the [Claude Code Skills specification](https://code.claude.com/docs/en/skills):

- `SKILL.md` is the entrypoint that Claude reads when the skill is invoked
- `reference.md` is a supporting file with detailed command reference
- `scripts/` contains helper scripts Claude can execute or reference
- Premium logic lives in local `repointel`, not in host-specific wrappers

## Normal usage

Install the shared skill into a host-specific target path:

```powershell
node .\clients\repointel\scripts\install.mjs --host codex
node .\clients\repointel\scripts\install.mjs --host claude --workspace-root C:\path\to\workspace
node .\clients\repointel\scripts\install.mjs --host opencode --workspace-root C:\path\to\workspace
```

Run diagnostics:

```powershell
node .\clients\repointel\scripts\doctor.mjs --host none
```

Run a local demo flow:

```powershell
node .\clients\repointel\scripts\demo.mjs --skip-build
```

## Phase 1 rules

- This folder is bootstrap-only and open.
- It is not the premium engine.
- It only teaches hosts when to call local `repointel` and how to handle `ok`, `limited`, `warming`, and `unavailable`.
- Premium task policy, context packing, routing, and impact logic remain closed inside [`KodaX-private`](/C:/Works/GitWorks/KodaX-author/KodaX-private).
