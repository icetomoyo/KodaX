## agent_output

Retrieve the current or terminal bounded output preview, recent activity, legacy artifact references, and structured artifact metadata for a known controlled actor turn. Use list_agents for tree state and wait_agent for mailbox waiting; do not poll completion with agent_output.

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "Canonical controlled actor path or direct-child task name."
    },
    "turn_id": {
      "type": "string",
      "description": "Optional exact turn id. Defaults to the actor's latest turn."
    }
  },
  "required": [
    "target"
  ]
}
```

## bash

Execute shell commands for tests/builds/lint, packages, Git, process management, filesystem queries without dedicated tools, or computed/template-driven multi-file generation. Use grep/glob for their dedicated searches. Use run_in_background for long commands. Output is fully captured; only next-request capacity overflow yields a recoverable artifact preview. For a known-content file, use write/edit: shell redirection, heredocs, Set-Content/Out-File or Python/Node wrappers bypass mutation tracking and diff verification, and move the streaming limit to the generator.

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The command to execute"
    },
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this command does"
    },
    "timeout": {
      "type": "number",
      "description": "Timeout in seconds"
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Run command in background. Returns immediately with output file path. Use read tool to check output later."
    }
  },
  "required": [
    "command"
  ]
}
```

## create_goal

Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if a goal exists; use update_goal only for status changes.

```json
{
  "type": "object",
  "properties": {
    "objective": {
      "type": "string",
      "description": "The long-running objective the agent should pursue across turns. A clear, concrete sentence describing the target end-state."
    },
    "token_budget": {
      "type": "number",
      "description": "Optional positive integer token budget for the entire goal. Omit when the user did not request a budget."
    }
  },
  "required": [
    "objective"
  ]
}
```

## edit

Edit one existing file with one or more replacements in edits. Read first. Each old_string must be unique in the whole current file unless replace_all is true. Matching tries exact text then normalized anchors. Edits apply sequentially; later anchors must refer to the result of earlier edits. Any failed edit leaves the file unchanged; successful batches commit once. On failure, inspect the reported edit index and re-read or use a smaller unique anchor; do not rewrite the whole file to bypass an edit failure. Split oversized replacements into smaller edits.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "The file to edit"
    },
    "edits": {
      "type": "array",
      "minItems": 1,
      "description": "Replacements applied sequentially to this file; any failure leaves the file unchanged.",
      "items": {
        "type": "object",
        "properties": {
          "old_string": {
            "type": "string",
            "description": "Unique text to replace; exact match then normalized fallback"
          },
          "new_string": {
            "type": "string",
            "description": "Replacement text"
          },
          "replace_all": {
            "type": "boolean",
            "description": "Replace every occurrence; defaults to false"
          }
        },
        "required": [
          "old_string",
          "new_string"
        ]
      }
    }
  },
  "required": [
    "path",
    "edits"
  ]
}
```

## exit_plan_mode

Exit plan mode by presenting the finalized plan to the user for approval. On approval, the session flips to accept-edits and implementation can proceed. On rejection, the session remains in plan mode so the plan can be revised. Wait for Host approval before implementing, because plan mode remains read-only until that transition. Parent-only: requires an interactive approval UI (wired only in REPL sessions).

```json
{
  "type": "object",
  "properties": {
    "plan": {
      "type": "string",
      "description": "The finalized plan to present to the user. Include the full plan content, not a summary, so the user can make an informed approval decision. Keep the plan tight: at most 40 lines total, 3 bullet-depth levels, one sentence per bullet. If the plan exceeds this budget, split it into phases and present only the current phase — the user can approve phase-by-phase."
    }
  },
  "required": [
    "plan"
  ]
}
```

## followup_task

Deliver an additional task to a direct child. An idle actor atomically starts a new turn; a running actor receives it in the current turn without consuming another slot.

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "Canonical child path or direct-child task name."
    },
    "objective": {
      "type": "string",
      "description": "Additional objective or changed evidence."
    },
    "quality_strategy": {
      "type": "object",
      "description": "Optional telemetry/provenance for PatternTrace reconstruction. It never controls otherwise legal follow-up admission; invalid or conflicting metadata is ignored."
    }
  },
  "required": [
    "target",
    "objective"
  ]
}
```

## get_goal

Read the current goal for this session, including status, budget, token and elapsed-time usage, and remaining token budget.

```json
{
  "type": "object",
  "properties": {}
}
```

## glob

Find files matching a pattern.

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "The glob pattern"
    },
    "path": {
      "type": "string",
      "description": "Directory to search"
    }
  },
  "required": [
    "pattern"
  ]
}
```

## grep

Search file contents with a regex or literal text. Supports context lines, multiline matching, file type filtering, and pagination.

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Regex, or literal text when literal is true, to match in file contents."
    },
    "literal": {
      "type": "boolean",
      "description": "Match text verbatim, including long strings. Default false (regex). Use glob for paths."
    },
    "path": {
      "type": "string",
      "description": "File or directory; defaults to cwd."
    },
    "glob": {
      "type": "string",
      "description": "File glob, e.g. *.{ts,tsx}."
    },
    "type": {
      "type": "string",
      "description": "File type such as ts (includes .ts/.tsx/.mts/.cts). Use glob for an exact extension, e.g. *.ts."
    },
    "output_mode": {
      "type": "string",
      "enum": [
        "content",
        "files_with_matches",
        "count"
      ],
      "description": "content (default): matching lines; files_with_matches: paths; count: per-file match counts."
    },
    "ignore_case": {
      "type": "boolean",
      "description": "Case-insensitive matching; default false."
    },
    "-A": {
      "type": "number",
      "description": "Following context lines; content mode only."
    },
    "-B": {
      "type": "number",
      "description": "Preceding context lines; content mode only."
    },
    "context": {
      "type": "number",
      "description": "Context lines on both sides; content mode only."
    },
    "multiline": {
      "type": "boolean",
      "description": "Allow . and matches across newlines; default false."
    },
    "head_limit": {
      "type": "number",
      "description": "Limit output to first N entries. Defaults to 250. Pass 0 to remove the entry-count cap; the source byte budget still applies."
    },
    "offset": {
      "type": "number",
      "description": "Entries to skip; default 0."
    },
    "scan_offset": {
      "type": "number",
      "description": "Candidate files skipped for SOURCE_INCOMPLETE continuation."
    }
  },
  "required": [
    "pattern"
  ]
}
```

## insert_after_anchor

Insert content after a unique anchor without rewriting the whole file. Prefer this for appending new sections to existing docs or configs.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "The file to update"
    },
    "anchor": {
      "type": "string",
      "description": "A unique heading or nearby marker to insert after"
    },
    "content": {
      "type": "string",
      "description": "The content to insert after the anchor"
    }
  },
  "required": [
    "path",
    "anchor",
    "content"
  ]
}
```

## interrupt_agent

Interrupt a controlled child actor's active turn without deleting its identity or history. Native/constructed actors support this operation; an incapable external backend rejects it explicitly.

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "Canonical controlled actor path or direct-child task name."
    },
    "reason": {
      "type": "string",
      "description": "Optional attributable interruption reason."
    },
    "scope": {
      "type": "string",
      "enum": [
        "turn",
        "subtree"
      ],
      "description": "Interrupt only the target Turn (default) or every active Turn in its controlled subtree. Actors remain reusable."
    }
  },
  "required": [
    "target"
  ]
}
```

## kodax_manual

Look up how to use, install, configure, troubleshoot, or extend KodaX itself.
Covers providers, custom providers, config, permissions, sandboxing, slash commands, tools, custom agents, skills, extensions, MCP, A2A, repo intelligence, sessions, context compaction, memory, the doctor command, and the SDK.
Call this first for any "how do I … in KodaX" question and answer from its result.
Do not answer KodaX product questions from pretraining, because pretraining mixes in Claude Code and Codex CLI details that do not match KodaX — KodaX uses ~/.kodax/config.json and KODAX_* env vars, not .claude/settings.json or config.toml.
Pass an exact topic id, or a free-text query, or neither to get the topic index. It explains where to check a value rather than reading your secrets.

```json
{
  "type": "object",
  "properties": {
    "topic": {
      "type": "string",
      "description": "A manual topic id (e.g. \"providers\", \"config\", \"agents\", \"extensions\", \"doctor\"). Unknown topics return the index."
    },
    "query": {
      "type": "string",
      "description": "A free-text question when you do not know the topic id (English or Chinese)."
    }
  },
  "required": []
}
```

## list_agents

List a bounded page of the caller-visible actor tree, including capabilities, state, parent, active turn, bounded result summary, recent activity, and shared session capacity.

```json
{
  "type": "object",
  "properties": {
    "path_prefix": {
      "type": "string",
      "description": "Optional canonical or caller-relative Actor path prefix."
    },
    "state": {
      "type": "string",
      "enum": [
        "running",
        "idle",
        "closed"
      ],
      "description": "Optional Actor state filter."
    },
    "after_path": {
      "type": "string",
      "description": "Exclusive canonical path cursor returned as nextAfterPath."
    },
    "limit": {
      "type": "number",
      "description": "Page size, 1-50. Defaults to 20."
    }
  }
}
```

## list_dispatchable_agents

List the Native, Constructed, and External executors currently allowed by host policy. Pass a returned canonical agent_id to spawn_agent.

```json
{
  "type": "object",
  "properties": {
    "required_skills": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional skills every returned agent must declare."
    },
    "required_capabilities": {
      "type": "object",
      "properties": {
        "streaming": {
          "type": "boolean"
        },
        "durableTasks": {
          "type": "boolean"
        },
        "inputRequired": {
          "type": "boolean"
        },
        "cancellation": {
          "type": "boolean"
        },
        "artifacts": {
          "type": "boolean"
        }
      },
      "description": "Optional lifecycle capabilities required for this dispatch."
    },
    "read_only": {
      "type": "boolean",
      "description": "When true, exclude external agents whose declared remote effect is write or unknown."
    }
  }
}
```

## memory_intent

Manage durable Memory in response to a natural-language user request. Use list when the user asks what is remembered; return concise accepted Memory with stable ref ids. Use remember for a new fact, preference, policy, or procedure, correct with one exact targetRefId, and forget with one exact targetRefId. Use decisions/show only when the user asks what needs attention; approve/reject require one exact decision ref and an exact authorizing quote. For mutations, userQuote must be the exact affirmative instruction clause from the current user message. For remember/correct, statement must itself be an exact claim span from that message; never paraphrase or infer durable content. Classify remember as fact, policy, preference, or procedure; every new claim needs a stable semantic claimKey so later updates address the same claim. The host applies safe explicit requests immediately; broad or ambiguous requests ask for clarification, conflicts become readable decisions, and restricted content is rejected.

```json
{
  "type": "object",
  "properties": {
    "operation": {
      "type": "string",
      "enum": [
        "list",
        "remember",
        "correct",
        "forget",
        "decisions",
        "show",
        "approve",
        "reject"
      ],
      "description": "The Memory operation requested by the user."
    },
    "statement": {
      "type": "string",
      "description": "A concise durable claim for remember or correct."
    },
    "targetRefId": {
      "type": "string",
      "description": "One exact ref returned by list/recall; required for correct and forget."
    },
    "claimKind": {
      "type": "string",
      "enum": [
        "fact",
        "policy",
        "preference",
        "procedure"
      ],
      "description": "The durable claim category for remember or correct."
    },
    "claimKey": {
      "type": "string",
      "description": "Stable semantic identity such as project.package_manager or user.preference.editor; required for every new claim."
    },
    "userQuote": {
      "type": "string",
      "description": "An exact quote from the current user message authorizing a mutation."
    },
    "reason": {
      "type": "string",
      "description": "Optional user-supplied rejection reason."
    }
  },
  "required": [
    "operation"
  ]
}
```

## memory_recall

Recall governed prior experience for one specific decision-relevant gap. Use only when current context does not answer a concrete historical need. When prior execution experience is the known missing source, use this before unrelated repository exploration. Do not use for current repository or environment facts; verify those with normal tools. The query is read-only, exactly scoped to the current MemorySession, and may return no claim.

```json
{
  "type": "object",
  "properties": {
    "need": {
      "type": "string",
      "description": "One concrete prior-experience gap relevant to the current decision."
    }
  },
  "required": [
    "need"
  ]
}
```

## read

Read a local file with bounded output. Text is line-numbered; continue using offset/limit and the exact line_offset cursor from the partial-line continuation marker. Paged input: path also accepts kodax-transient://text/ references supplied by context recovery. These are valid local, run-scoped text capabilities, not network URLs. Read them directly with offset/limit to recover the original requirements; do not ask the user to re-paste them. PNG/JPG/JPEG/GIF/WEBP return inline vision content, so inspect them instead of rejecting them as binary. An image already attached or inlined in the conversation is visible to you, so reading it again only repeats it.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "The absolute file path or a kodax-transient://text/ reference supplied by context recovery"
    },
    "offset": {
      "type": "number",
      "description": "Line number to start from (text files only)"
    },
    "limit": {
      "type": "number",
      "description": "Number of lines to read (text files only)"
    },
    "line_offset": {
      "type": "number",
      "description": "Zero-based Unicode character offset within the first selected line. Use the exact value from a partial-line continuation marker."
    }
  },
  "required": [
    "path"
  ]
}
```

## send_message

Deliver a bounded message without starting a turn. A running actor receives it at the next safe boundary; an idle actor retains it for its next turn. Runtime-derived forwarding lineage prevents cycles; direct parent, direct child, admitted peer, and bounded broadcast targets are supported.

```json
{
  "type": "object",
  "properties": {
    "to": {
      "type": "string",
      "description": "A visible canonical actor path, direct-child/peer task name, the literal \"parent\", or \"*\" for a bounded broadcast. Self-targeted sends are rejected."
    },
    "content": {
      "type": "string",
      "description": "Message body. Runtime wraps it in an authenticated <agent-message> frame before delivery."
    },
    "forwarded_message_id": {
      "type": "string",
      "description": "Message id from a received <agent-message> frame. Supply only when forwarding that message; Runtime derives and validates the forwarding chain. Omit for a fresh message."
    },
    "classification": {
      "type": "string",
      "enum": [
        "public",
        "internal",
        "sensitive"
      ],
      "description": "Data classification. Defaults to internal; forwarding cannot downgrade the source classification."
    }
  },
  "required": [
    "to",
    "content"
  ]
}
```

## session_history_read

Read one exact persisted session-history entry cited by session_history_search. Content is returned in bounded character chunks. Use selected hit.entryRevision as revision; reuse returned entryRevision for nextOffset or stale recovery. It checks this entry across normal message appends. Top-level search revision remains a strict whole-history snapshot.

```json
{
  "type": "object",
  "properties": {
    "entry_id": {
      "type": "string",
      "description": "Exact selected hit.entryId returned by session_history_search."
    },
    "revision": {
      "type": "string",
      "description": "Selected hit.entryRevision or read.entryRevision; legacy whole-history revision remains strict."
    },
    "offset": {
      "type": "number",
      "description": "Zero-based character offset (default 0)."
    }
  },
  "required": [
    "entry_id"
  ]
}
```

## session_history_search

Search exact persisted entries that are no longer present in the compacted model context. Use this only when a user request depends on an omitted historical detail; do not guess from the checkpoint. Results are bounded snippets with stable entry citations. Read the needed hit using its entryRevision as read.revision.

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Specific phrase, identifier, command, or historical fact to find."
    },
    "limit": {
      "type": "number",
      "description": "Maximum snippets to return (1-20, default 8)."
    },
    "role": {
      "type": "string",
      "enum": [
        "user",
        "assistant"
      ],
      "description": "Optional message-role filter."
    },
    "scope": {
      "type": "string",
      "enum": [
        "compacted",
        "all"
      ],
      "description": "Defaults to compacted history; use all only when active-tail search is required."
    }
  },
  "required": [
    "query"
  ]
}
```

## skill

Invoke a discovered skill by name. Returns the skill's expanded content (variables resolved) as the tool_result so you can follow its instructions in your next turn.
- Call this before other work when the user names a Skill listed in your "Available Skills" or a listed Skill's description clearly covers the request. When no description covers it, do not call this.
- DO NOT call `read` on a `SKILL.md` path to load a skill — skill loading is `skill`'s job; `read` is for plain files.
- `args` is an optional free-form string the skill resolver can substitute into its template (e.g. `args: "123"` for `/review-pr 123`). Most skills ignore it.

```json
{
  "type": "object",
  "properties": {
    "skill": {
      "type": "string",
      "description": "The skill name (e.g. \"commit\", \"review-pr\"). Leading slash is tolerated."
    },
    "args": {
      "type": "string",
      "description": "Optional arguments forwarded to the skill resolver."
    }
  },
  "required": [
    "skill"
  ]
}
```

## spawn_agent

Start a named direct-child Agent. Runtime assigns its canonical path and atomically enforces session concurrency/work budgets. For broad multi-file reviews, launch distinct read-only lanes once scope is known. Implementation lanes require disjoint write ownership: read_only:false, shared isolation (default), and exact exclusive paths/generated outputs. Shared edits already appear in the root workspace; do not reapply them. Use worktree only with an explicit merge-back strategy. Continue useful work; wait_agent only for critical mailbox evidence.

```json
{
  "type": "object",
  "properties": {
    "task_name": {
      "type": "string",
      "description": "Stable direct-child name used in the Runtime-minted canonical actor path."
    },
    "objective": {
      "type": "string",
      "description": "Detailed multi-step goal for this child agent"
    },
    "read_only": {
      "type": "boolean",
      "description": "true (default) narrows filesystem access to read-only; false retains the parent ceiling."
    },
    "scope": {
      "type": "string",
      "description": "Optional bounded scope hint (e.g. \"packages/llm/src/\")"
    },
    "evidence_refs": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional known evidence. Prefix with file:, diff:, finding:, or exact agent-turn:<canonical-path>#turn=<id>. Legacy agent:<path> resolves latest. Actor output must already be terminal and visible."
    },
    "constraints": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional constraints"
    },
    "model_hint": {
      "type": "string",
      "enum": [
        "fast",
        "balanced",
        "deep"
      ],
      "description": "Routing tier: fast for focused lookups (few files/simple grep), deep for heavy multi-file analysis/synthesis, balanced (default/omitted) for normal inherited selection. Unconfigured tiers fall back to the inherited provider/model. Omit when unsure."
    },
    "agent_id": {
      "type": "string",
      "description": "Select a registered specialist matching the task instead of a generic child."
    },
    "provider": {
      "type": "string",
      "description": "Override provider for a deliberate cross-family check. Omit to inherit; an unconfigured provider falls back to yours."
    },
    "model": {
      "type": "string",
      "description": "Model id paired with provider. Omit to inherit."
    },
    "effort": {
      "type": "string",
      "description": "Reasoning effort (off, low, medium, high, xhigh, max). Omit/auto inherits parent/default. A specialist selected by agent_id locks its declared effort; conflicting dispatch or provider/model-unsupported values are rejected."
    },
    "isolation": {
      "type": "string",
      "enum": [
        "shared",
        "worktree"
      ],
      "description": "Optional execution isolation."
    },
    "fork_turns": {
      "description": "History fork: all (default), none, or a positive recent-turn count."
    },
    "quality_strategy": {
      "type": "object",
      "description": "Telemetry only: {schemaVersion:1,stageId,pattern,role,laneRelation?,targetEvidenceRefs?}. Does not control legal spawn admission; invalid metadata is ignored. Actor targets require exact agent-turn refs."
    }
  },
  "required": [
    "task_name",
    "objective"
  ]
}
```

## todo_create

Add one semantic milestone; preserve existing items. Returns {ok:true,id}; reuse the stable generated id, never supply one. Plan non-trivial work; skip trivial/informational tasks. Resume the existing plan; use todo_list if uncertain to avoid duplicates. Milestones are deliverables, not child Agents; several Agents may support one. This records planned work, not execution. Use the requested language, otherwise the request primary language, for subject/description/activeForm; keep source identifiers, paths, commands and quotes. Inactive store, invalid input or extension veto returns {ok:false,reason}.

```json
{
  "type": "object",
  "properties": {
    "subject": {
      "type": "string",
      "description": "Non-empty imperative milestone title shown in the plan row."
    },
    "status": {
      "type": "string",
      "enum": [
        "pending",
        "in_progress"
      ],
      "description": "Default pending; use in_progress for work starting now, avoiding a separate activation call. Creation never completes work."
    },
    "description": {
      "type": "string",
      "description": "Optional multi-line work context available in full item detail; absent from compact row. Omit when subject suffices."
    },
    "activeForm": {
      "type": "string",
      "description": "Optional present-continuous label shown by the in_progress spinner."
    },
    "evaluator": {
      "type": "string",
      "enum": [
        "build",
        "test",
        "lint"
      ],
      "description": "Optional milestone check on completion when runner evaluator wiring is active: build/test/lint runs npm run build/npm test/npm run lint; failure returns stderr. Use sparingly for real checks."
    },
    "metadata": {
      "type": "object",
      "description": "Optional opaque hook/eval data; not shown in UI. Omit when unused."
    }
  },
  "required": [
    "subject"
  ]
}
```

## todo_list

Read the visible plan without changing it. Without id returns {ok:true,count,items} and canonical ids; with id returns {ok:true,item} including description, status, activeForm, note, evaluator, owner and metadata. Use to resume work, avoid duplicates or recover unknown ids. Refresh only when state may have changed externally; if the patch is clear, update directly. An inactive store returns {ok:false,reason}; continue without further todo calls.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Optional stable todo id for full item detail; omit to list the plan."
    }
  }
}
```

## todo_update

Patch one existing todo by stable id: status, fields or both. Omitted fields are preserved; add work with todo_create. Mark in_progress with activeForm before work, completed only after finishing; one in_progress item per owner. Avoid unchanged updates; read current item details when state is uncertain, list the plan for unknown ids. Use the requested language, otherwise the request primary language, for subject/description/activeForm/note; retain source identifiers, paths, commands and quotes. Completion may trigger evaluator when runner evaluator wiring is active, and may be vetoed by a hook; after rejection/blocked-by-hook, re-read and revise before retrying. Inactive store: continue without more todo calls.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Existing canonical todo id; must match the current plan."
    },
    "status": {
      "type": "string",
      "enum": [
        "in_progress",
        "completed",
        "failed",
        "skipped",
        "cancelled",
        "deleted"
      ],
      "description": "Optional transition: failed needs retry; skipped is unnecessary; cancelled retains a struck-through breadcrumb; deleted removes the row. Only Runtime may restore pending after revise."
    },
    "note": {
      "type": "string",
      "description": "Optional reason/detail; omit to preserve."
    },
    "activeForm": {
      "type": "string",
      "description": "Present-continuous spinner label; required for in_progress. Omit on terminal transitions to preserve the previous value."
    },
    "subject": {
      "type": "string",
      "description": "Optional replacement imperative title; must be non-empty."
    },
    "description": {
      "type": "string",
      "description": "Optional replacement multi-line work context; empty string clears it."
    },
    "evaluator": {
      "type": "string",
      "enum": [
        "build",
        "test",
        "lint"
      ],
      "description": "Optional replacement completion check when runner evaluator wiring is active: build/test/lint runs npm run build/npm test/npm run lint. Failure returns stderr."
    },
    "metadata": {
      "type": "object",
      "description": "Opaque hook/eval data, not UI. Shallow-merge: keys overwrite, nested objects are not deep-merged; null values delete keys, allowing merge+delete together. Whole-field null clears all (handler accepts it despite object schema)."
    }
  },
  "required": [
    "id"
  ]
}
```

## tool_call

Call one active tool by name once its input contract is known from tool_search, tool_describe or a contract listed in this request. The runtime re-applies the target tool policy, permission checks, and result guardrails.

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Name of the active target tool to call."
    },
    "input": {
      "type": "object",
      "description": "JSON object passed as the target tool input."
    }
  },
  "required": [
    "name",
    "input"
  ]
}
```

## tool_search

Look up full contracts for active tools when no tool listed in this request fits the need, or when a listed description is too short to call correctly. Tools listed in this request are called directly; call a discovered tool that is not listed through tool_call. Use query="select:NAME[,NAME...]" for exact lookup across discoverable tools. Keyword queries search their names, descriptions and parameters, with +required terms and loose ranked terms. Results include full descriptions and schemas. Use the returned contract even if later tool lists remain compact.

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Either `select:ToolName[,ToolName...]` for exact lookup, or keyword search (`+keyword required loose terms`)."
    },
    "max_results": {
      "type": "number",
      "description": "Maximum number of results to return (default 5, capped at 15). Ignored in `select:` mode."
    }
  },
  "required": [
    "query"
  ]
}
```

## update_goal

Mark the current goal complete or blocked.

Set status to complete only when the objective is achieved and no required work remains. Verify each requirement with actual evidence before calling complete; report unverified scope explicitly. Completion is goal bookkeeping, not a quality certificate.

Set status to blocked only when the goal cannot proceed without external unblock, and the same blocking condition has persisted across recent goal turns. The runtime counter rejects blocked status until the same blocker_kind has repeated for 3 consecutive turns.

Pause, resume, and budget-limited transitions are controlled by the user, not this tool. Do not call to stop work — only call when the objective is truly achieved or truly blocked.

```json
{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "complete",
        "blocked"
      ],
      "description": "Target goal status."
    },
    "blocker_kind": {
      "type": "string",
      "description": "Required when status=blocked. A short identifier for the persistent obstacle (e.g. \"awaiting-user-permission\", \"missing-dependency\"). The runtime counter compares this string across turns."
    }
  },
  "required": [
    "status"
  ]
}
```

## wait_agent

Yield until the caller mailbox receives an Agent message or completion, root user input arrives, the wait is interrupted, or the timeout expires. Actor progress remains visible to UI and SDK event consumers but never wakes the parent model. Use this sparingly when required Agent evidence is on the critical path; continue useful non-overlapping work first. After mailbox evidence arrives, integrate it and reconcile the affected semantic plan milestone before waiting again.

```json
{
  "type": "object",
  "properties": {
    "timeout_ms": {
      "type": "number",
      "minimum": 10000,
      "maximum": 3600000,
      "description": "Wait window in milliseconds. Defaults to 120000. Longer waits do not invoke the model and root user input still wakes promptly."
    }
  }
}
```

## worktree_create

Create a new git worktree with an isolated branch for safe agent work.

```json
{
  "type": "object",
  "properties": {
    "branch_name": {
      "type": "string",
      "description": "Optional explicit branch name"
    },
    "description": {
      "type": "string",
      "description": "Optional description to auto-generate branch name from"
    }
  }
}
```

## worktree_remove

Remove a git worktree and optionally its branch.

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "keep",
        "remove"
      ],
      "description": "Whether to keep or remove the worktree directory and branch"
    },
    "worktree_path": {
      "type": "string",
      "description": "Absolute path to the worktree directory"
    },
    "discard_changes": {
      "type": "boolean",
      "description": "If true, bypass safety checks for uncommitted changes or local commits"
    }
  },
  "required": [
    "action",
    "worktree_path"
  ]
}
```

## write

Write a new file explicitly requested by the user, or an explicitly requested complete rewrite. For existing-file changes, use edit; large diffs may be summarized. For oversized content or a mid-stream failure, write a smaller skeleton with placeholders, then fill sections using edit. Use write/edit for known content: shell redirection bypasses mutation tracking and diff verification, and moves the streaming limit to the generator. Shell scripts are for computed output. write sends UTF-8 directly to fs.writeFile without a shell; Chinese/emoji need no encoding workaround.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "The absolute path to the file"
    },
    "content": {
      "type": "string",
      "description": "The content to write"
    }
  },
  "required": [
    "path",
    "content"
  ]
}
```
