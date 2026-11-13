# Memory

KodaX remembers what you tell it across sessions: your preferences, corrections you gave, and facts about a project that are not visible in the code. Memory is on by default.

## How it works

Memory is a set of notes. Each note is one markdown file, and each store has a `MEMORY.md` index with one line per note.

| Store | Holds | Location |
|---|---|---|
| Project notes | Facts about this repository. Shared by every clone and worktree of the same git remote. | `~/.kodax/projects/<project>/notes/` |
| User notes | Preferences that apply in every project. | `~/.kodax/notes/` |

At the start of each session the agent sees both indexes. It opens a note only when its index line looks relevant to the task. A note never overrides your current message, the project's rules, or what the agent can verify in the repository now.

## Asking it to remember or forget

Just say it in the conversation:

- "Remember that tests here run with `make check-fast`."
- "Forget the note about pnpm."

The agent saves the note with an exact quote of your words, which is what proves you asked. Changing or deleting a note also needs your words.

The agent may also save something it noticed without being asked. Such a note is a **candidate**: the agent does not read it until a later session confirms it or you approve it. This keeps a wrong guess from steering future work.

Secrets and credentials are never stored.

## Learning in the background

After a session ends, KodaX reviews it in the background. It can save a correction you gave, confirm or dispute an existing note, and propose a skill for a procedure that verifiably worked. A proposed skill is not used until you trust it with `/learn trust <name>`.

The review makes at most ten model calls a day. It does not run for CLI bridge providers (such as Gemini CLI or Codex CLI). An embedding application that supplies its own learning reviewer turns it off.

Housekeeping needs no model call: inferred notes that nobody confirmed or used for 90 days are archived (the file stays), and notes with the same description are merged.

## The `/memory` command

| Command | Effect |
|---|---|
| `/memory` | List the notes the agent reads, with each store's directory |
| `/memory candidates` | List the notes it inferred and has not confirmed |
| `/memory show <id>` | Show one note in full |
| `/memory approve <id>` | Confirm a candidate or disputed note so the agent reads it |
| `/memory forget <id>` | Delete one note |

When both stores have a note with the same id, prefix it: `project:<id>` or `user:<id>`.

Notes are plain files, so you can also edit them in any editor. The agent itself is not allowed to write them with file or shell tools.

## Upgrading from the earlier memory

The first session converts memories saved by earlier versions into notes, once. The old files are left in place.

To go back to the earlier memory system, set `KODAX_MEMORY_NOTES=0`. That system is kept only until it is removed.
