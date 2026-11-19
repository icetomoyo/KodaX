## agent_output

Read bounded output/activity and legacy/structured artifact references for a known controlled Actor/Turn. Tree: list_agents; waiting: wait_agent. Never poll completion here.

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "Canonical controlled path or direct-child name."
    },
    "turn_id": {
      "type": "string",
      "description": "Exact turn; default latest."
    }
  },
  "required": [
    "target"
  ]
}
```

## bash

Shell: tests/build/lint, packages, Git/processes, queries without dedicated tools, computed/template multi-file generation. Searches: grep/glob; known file content: write/edit, not shell redirection/wrappers. Long commands: run_in_background. Full output captured; only next-request capacity overflow yields recoverable artifact preview.

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string"
    },
    "description": {
      "type": "string",
      "description": "Concise command purpose."
    },
    "timeout": {
      "type": "number",
      "description": "Seconds."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Return immediately with output path; read it later."
    }
  },
  "required": [
    "command"
  ]
}
```

## code_search

Literal path/content search, or extension provider search via provider_id. Prefer grep/glob for ordinary local lookup.

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "String query to search for"
    },
    "path": {
      "type": "string",
      "description": "Optional file or directory scope for the search"
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of matches to return"
    },
    "scan_offset": {
      "type": "number",
      "description": "Skip candidate files already scanned by a prior SOURCE_INCOMPLETE continuation."
    },
    "case_sensitive": {
      "type": "boolean",
      "description": "Whether the query should be matched case-sensitively"
    },
    "provider_id": {
      "type": "string",
      "description": "Optional extension capability provider id for provider-backed code search"
    }
  },
  "required": [
    "query"
  ]
}
```

## followup_task

Task/evidence for a direct child: idle starts a turn atomically; running receives it in-place without another slot.

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "Canonical child path or direct-child name."
    },
    "objective": {
      "type": "string",
      "description": "Additional objective/evidence."
    },
    "quality_strategy": {
      "type": "object",
      "description": "Optional PatternTrace provenance; never admission control. Invalid/conflicting data ignored."
    }
  },
  "required": [
    "target",
    "objective"
  ]
}
```

## glob

Find file paths by glob.

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string"
    },
    "path": {
      "type": "string",
      "description": "Search directory."
    }
  },
  "required": [
    "pattern"
  ]
}
```

## grep

Search file contents: regex by default, literal:true for verbatim/long text; glob tool for paths. Supports context, multiline, type and paging.

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string"
    },
    "literal": {
      "type": "boolean",
      "description": "Default false."
    },
    "path": {
      "type": "string",
      "description": "File/directory; default cwd."
    },
    "glob": {
      "type": "string",
      "description": "File glob, e.g. *.{ts,tsx}."
    },
    "type": {
      "type": "string",
      "description": "ts includes ts/tsx/mts/cts; glob for exact extension."
    },
    "output_mode": {
      "type": "string",
      "enum": [
        "content",
        "files_with_matches",
        "count"
      ],
      "description": "Default content (lines); files_with_matches (paths); count (per-file counts)."
    },
    "ignore_case": {
      "type": "boolean",
      "description": "Default false."
    },
    "-A": {
      "type": "number",
      "description": "Following lines; content mode."
    },
    "-B": {
      "type": "number",
      "description": "Preceding lines; content mode."
    },
    "context": {
      "type": "number",
      "description": "Both sides; content mode."
    },
    "multiline": {
      "type": "boolean",
      "description": "Cross-line matches and dot; default false."
    },
    "head_limit": {
      "type": "number",
      "description": "Entry cap, default 250; 0 uncaps count, not source bytes."
    },
    "offset": {
      "type": "number",
      "description": "Entries skipped; default 0."
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

## interrupt_agent

Interrupt a controlled child turn, preserving identity/history. Native/constructed supported; incapable external backends explicitly reject.

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "Canonical controlled path or direct-child name."
    },
    "reason": {
      "type": "string",
      "description": "Attributable reason."
    },
    "scope": {
      "type": "string",
      "enum": [
        "turn",
        "subtree"
      ],
      "description": "Default turn; subtree interrupts all controlled active turns. Actors remain reusable."
    }
  },
  "required": [
    "target"
  ]
}
```

## kodax_manual

First source for using, installing, configuring, troubleshooting or extending KodaX itself, including its SDK. Other software is outside the manual. Answer from results, not other-product pretraining. KodaX uses ~/.kodax/config.json/KODAX_*, not .claude/settings.json/config.toml. Use an exact topic or free-text query. Omit both for the topic index. Explains where to check values, never reads secrets.

```json
{
  "type": "object",
  "properties": {
    "topic": {
      "type": "string",
      "description": "Exact topic ID; unknown returns index."
    },
    "query": {
      "type": "string",
      "description": "Free-text question (English/Chinese)."
    }
  },
  "required": []
}
```

## list_agents

Bounded caller-visible tree: capabilities, state, parent/active turn, result summary, recent activity and shared capacity.

```json
{
  "type": "object",
  "properties": {
    "path_prefix": {
      "type": "string",
      "description": "Canonical/caller-relative path prefix."
    },
    "state": {
      "type": "string",
      "enum": [
        "running",
        "idle",
        "closed"
      ]
    },
    "after_path": {
      "type": "string",
      "description": "Exclusive nextAfterPath cursor."
    },
    "limit": {
      "type": "number",
      "description": "1–50; default 20."
    }
  }
}
```

## lsp_definition

Find the compiler-resolved definition at a file position, through imports, re-exports and overloads. Give 1-based line/character from a recent read. Prefer symbol_context for a named symbol's repo-wide callers/callees. Requires the language's server; returns install guidance if unavailable.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File containing the symbol"
    },
    "line": {
      "type": "number",
      "description": "1-based line of the symbol"
    },
    "character": {
      "type": "number",
      "description": "Optional 1-based column of the symbol (defaults to the line start)"
    }
  },
  "required": [
    "path",
    "line"
  ]
}
```

## lsp_document_symbols

Outline a file's classes, functions, methods and fields with line numbers through its language server. Use to locate a member before navigation/editing without reading the file. For a module overview use module_context. Requires the matching language server.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File to outline"
    }
  },
  "required": [
    "path"
  ]
}
```

## lsp_hover

Show the compiler-resolved type, signature and documentation at a 1-based file position, including resolved generics. Use before editing when you need types without reading the definition. Requires the matching language server.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File containing the symbol"
    },
    "line": {
      "type": "number",
      "description": "1-based line of the symbol"
    },
    "character": {
      "type": "number",
      "description": "Optional 1-based column of the symbol"
    }
  },
  "required": [
    "path",
    "line"
  ]
}
```

## lsp_implementation

Jump from an interface, abstract method, or declaration site to implementation locations using the language server. Use this when definition only lands on a contract and you need the concrete implementers before changing behavior.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File containing the symbol"
    },
    "line": {
      "type": "number",
      "description": "1-based line of the symbol"
    },
    "character": {
      "type": "number",
      "description": "Optional 1-based column of the symbol"
    }
  },
  "required": [
    "path",
    "line"
  ]
}
```

## lsp_incoming_calls

List language-server incoming callers for the callable at a file position. Use this for upstream/caller questions when you have the exact symbol location.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File containing the callable symbol"
    },
    "line": {
      "type": "number",
      "description": "1-based line of the symbol"
    },
    "character": {
      "type": "number",
      "description": "Optional 1-based column of the symbol"
    }
  },
  "required": [
    "path",
    "line"
  ]
}
```

## lsp_outgoing_calls

List language-server outgoing callees from the callable at a file position. Use this for downstream/callee questions when you have the exact symbol location.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File containing the callable symbol"
    },
    "line": {
      "type": "number",
      "description": "1-based line of the symbol"
    },
    "character": {
      "type": "number",
      "description": "Optional 1-based column of the symbol"
    }
  },
  "required": [
    "path",
    "line"
  ]
}
```

## lsp_references

List compiler-resolved references, including the declaration, at a 1-based file position before renaming or signature changes. Follows re-exports and aliases; excludes string/comment matches. Use impact_estimate for a quick name-only repo blast radius. Requires the matching language server.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File containing the symbol"
    },
    "line": {
      "type": "number",
      "description": "1-based line of the symbol"
    },
    "character": {
      "type": "number",
      "description": "Optional 1-based column of the symbol"
    }
  },
  "required": [
    "path",
    "line"
  ]
}
```

## lsp_workspace_symbols

Search project-wide symbols by name through available language servers. Use this when you know a class/function/type name but not its file, and want compiler-indexed candidates before reading files or running broader text search. An empty query asks the server for its broad symbol list when supported.

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Symbol query text; may be empty for a broad server-supported listing"
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

Read-only, current MemorySession-scoped prior experience for a concrete decision gap absent from current context; may return none. If prior experience is the known missing source, use before unrelated repo exploration. Current repo/environment facts require normal tools.

```json
{
  "type": "object",
  "properties": {
    "need": {
      "type": "string",
      "description": "Concrete prior-experience gap."
    }
  },
  "required": [
    "need"
  ]
}
```

## read

Read line-numbered bounded text. Continue offset/limit; partial lines require exact line_offset cursor. Context recovery’s kodax-transient://text/ is a local run-scoped capability: read directly, not network or user re-paste. PNG/JPG/JPEG/GIF/WEBP return inline vision, so inspect them rather than rejecting as binary. Attached or inlined images are already visible; rereading only repeats them.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Absolute path or supplied kodax-transient://text/ reference."
    },
    "offset": {
      "type": "number",
      "description": "Starting text line number."
    },
    "limit": {
      "type": "number",
      "description": "Text lines."
    },
    "line_offset": {
      "type": "number",
      "description": "0-based Unicode character offset within first line; use exact continuation cursor."
    }
  },
  "required": [
    "path"
  ]
}
```

## run_skill_script

Run one exact script from an admitted Skill inside the remote OS sandbox.
The script sees only its pinned Skill snapshot and a fresh staging directory.
Use inputs to copy approved workspace files into staging; use outputs to promote generated files after success.
Relative script names must exactly match toolPolicy.skillScripts; arbitrary commands are not accepted.

```json
{
  "type": "object",
  "properties": {
    "skill": {
      "type": "string",
      "description": "Exact admitted Skill name."
    },
    "script": {
      "type": "string",
      "description": "Exact Skill-relative script path."
    },
    "args": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Arguments passed as data to the script."
    },
    "inputs": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Workspace-relative source file."
          },
          "as": {
            "type": "string",
            "description": "Optional staging-relative destination."
          }
        },
        "required": [
          "path"
        ]
      }
    },
    "outputs": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Staging-relative generated file."
          },
          "target": {
            "type": "string",
            "description": "Workspace-relative destination."
          }
        },
        "required": [
          "path",
          "target"
        ]
      }
    }
  },
  "required": [
    "skill",
    "script"
  ]
}
```

## run_workflow

Explicitly requested Workflow execution: runs manifest + source with structured output/resume and returns a canonical Workflow actor path. `tool_search("run_workflow")` for contract.

```json
{
  "type": "object",
  "properties": {
    "manifest": {
      "type": "object",
      "description": "Workflow metadata. Set readOnly false only if child agents must write files. patterns names the shapes the script uses (one or more of: classify-and-act, fan-out-and-synthesize, adversarial-verification, generate-and-filter, tournament, loop-until-done).",
      "properties": {
        "name": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "phases": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Ordered phase names for progress display."
        },
        "readOnly": {
          "type": "boolean"
        },
        "maxAgents": {
          "type": "number",
          "description": "Lifetime cap on total child agents across the run."
        },
        "maxConcurrency": {
          "type": "number",
          "description": "Max simultaneously in-flight child agents."
        },
        "patterns": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "plannedAgents": {
          "type": "number"
        }
      },
      "required": [
        "name",
        "description",
        "phases",
        "readOnly",
        "maxAgents",
        "maxConcurrency",
        "patterns"
      ]
    },
    "source": {
      "type": "string",
      "description": "JavaScript module body defining `async function run(wf, args) { ... }`. Coordinate child agents only through `wf`; the script gets no fs/network/shell and may not use import/require. Return displayable final text (for example `{ synthesis }`)."
    },
    "args": {
      "type": "object",
      "description": "Optional initial arguments passed to run(wf, args)."
    },
    "resumeFromRunId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]*$",
      "description": "Optional run id of a prior run of THIS workflow to resume from. Re-submit the same script (edited or not) with the prior run id: unchanged agent calls return their cached results instantly and only the changed/new calls re-run. Scripts must be deterministic for this — Date.now()/Math.random() are disabled."
    }
  },
  "required": [
    "manifest",
    "source"
  ]
}
```

## send_message

Message, no new turn: running receives at next safe boundary; idle retains until next turn. Direct parent/child, admitted peer or broadcast capped at 20; Runtime validates forwarding lineage against cycles.

```json
{
  "type": "object",
  "properties": {
    "to": {
      "type": "string",
      "description": "Visible canonical path, child/peer name, parent, or * broadcast. Self rejected."
    },
    "content": {
      "type": "string",
      "description": "Body; Runtime authenticates agent-message frame."
    },
    "forwarded_message_id": {
      "type": "string",
      "description": "Received agent-message ID only when forwarding; Runtime derives chain. Fresh message: omit."
    },
    "classification": {
      "type": "string",
      "enum": [
        "public",
        "internal",
        "sensitive"
      ],
      "description": "Default internal; cannot downgrade source classification."
    }
  },
  "required": [
    "to",
    "content"
  ]
}
```

## session_history_read

Read cited persisted entry in bounded character chunks. Use selected hit.entryRevision as revision; reuse returned entryRevision for nextOffset or stale recovery. It checks this entry across normal message appends. Top-level search revision remains a strict whole-history snapshot.

```json
{
  "type": "object",
  "properties": {
    "entry_id": {
      "type": "string",
      "description": "Exact hit.entryId."
    },
    "revision": {
      "type": "string",
      "description": "Selected hit.entryRevision or read.entryRevision; legacy whole-history revision remains strict."
    },
    "offset": {
      "type": "number",
      "description": "0-based characters; default 0."
    }
  },
  "required": [
    "entry_id"
  ]
}
```

## session_history_search

Find omitted persisted history only when missing detail is needed; do not guess from checkpoint. Bounded snippets/stable citations; read needed hit with hit.entryRevision as read.revision.

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Specific phrase/ID/command/historical fact."
    },
    "limit": {
      "type": "number",
      "description": "1–20; default 8."
    },
    "role": {
      "type": "string",
      "enum": [
        "user",
        "assistant"
      ]
    },
    "scope": {
      "type": "string",
      "enum": [
        "compacted",
        "all"
      ],
      "description": "Default compacted; all only if active-tail search needed."
    }
  },
  "required": [
    "query"
  ]
}
```

## skill

Required before other work when the user names a listed Skill or its description clearly covers the request; otherwise do not call it. Returns expanded/resolved instructions for next turn. Load via skill, never read SKILL.md, which bypasses the resolver. Optional free-form args forwarded for template substitution (most ignore it).

```json
{
  "type": "object",
  "properties": {
    "skill": {
      "type": "string",
      "description": "Skill name; leading slash accepted."
    },
    "args": {
      "type": "string"
    }
  },
  "required": [
    "skill"
  ]
}
```

## spawn_agent

Start a named direct child; returns canonical path. Runtime atomically enforces shared session concurrency/work budgets. quality_strategy is optional telemetry, never admission control; invalid/conflicting data is ignored.

```json
{
  "type": "object",
  "properties": {
    "task_name": {
      "type": "string",
      "description": "Stable direct-child name."
    },
    "objective": {
      "type": "string",
      "description": "Bounded goal, constraints, evidence and output shape."
    },
    "read_only": {
      "type": "boolean",
      "description": "Default true; false retains parent permission ceiling."
    },
    "scope": {
      "type": "string",
      "description": "Bounded scope hint."
    },
    "evidence_refs": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "file:/diff:/finding:/agent-turn:<canonical-path>#turn=<id>; legacy agent:<path> means latest. Actor output must be terminal/visible."
    },
    "constraints": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "model_hint": {
      "type": "string",
      "enum": [
        "fast",
        "balanced",
        "deep"
      ],
      "description": "balanced: ordinary work (default); fast: read-only mechanical lookup; deep: architecture/adversarial checks/severity/final synthesis. Unconfigured tiers inherit; write-capable fast stays on parent tier. Omit if unsure."
    },
    "agent_id": {
      "type": "string",
      "description": "Matching specialist canonical ID."
    },
    "provider": {
      "type": "string",
      "description": "Deliberate cross-family override; unconfigured/omitted inherits."
    },
    "model": {
      "type": "string",
      "description": "Paired provider model ID; omitted inherits."
    },
    "effort": {
      "type": "string",
      "description": "off/low/medium/high/xhigh/max; omitted/auto inherits. agent_id locks specialist effort; conflicts/unsupported values rejected."
    },
    "isolation": {
      "type": "string",
      "enum": [
        "shared",
        "worktree"
      ],
      "description": "Default shared: edits are visible in the root workspace; do not reapply them. Worktree needs an explicit merge-back strategy."
    },
    "fork_turns": {
      "description": "History: all (default), none, or positive recent-turn count."
    },
    "quality_strategy": {
      "type": "object",
      "description": "{schemaVersion:1,stageId,pattern,role,laneRelation?,targetEvidenceRefs?}; Actor refs require exact agent-turn."
    }
  },
  "required": [
    "task_name",
    "objective"
  ]
}
```

## todo_create

Add one semantic milestone without replacing existing items. Returns {ok:true,id}; reuse this generated id, never supply one. This records planned work, not execution. Plan work with several distinct deliverables. Skip trivial or informational tasks, because a one-step plan only adds noise. Inactive store, invalid input or extension veto returns {ok:false,reason}.

```json
{
  "type": "object",
  "properties": {
    "subject": {
      "type": "string",
      "description": "Nonempty imperative plan-row title."
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
      "description": "Full-detail multiline context, absent from compact row; omit if title suffices."
    },
    "activeForm": {
      "type": "string",
      "description": "Supply for each milestone: present-continuous in_progress spinner label."
    },
    "evaluator": {
      "type": "string",
      "enum": [
        "build",
        "test",
        "lint"
      ],
      "description": "When wired, completion runs build/test/lint = npm run build/npm test/npm run lint; failure returns stderr. Sparingly for real checks."
    },
    "metadata": {
      "type": "object",
      "description": "Opaque hook/eval data, not UI; omit if unused."
    }
  },
  "required": [
    "subject"
  ]
}
```

## todo_list

Read plan and canonical ids: without id returns {ok:true,count,items}; with id returns {ok:true,item} including description/status/activeForm/note/evaluator/owner/metadata. Refresh only if state may have changed externally or is unknown; clear patches need no read. Inactive store returns {ok:false,reason}; continue without more todo calls.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Stable item ID; omitted lists plan."
    }
  }
}
```

## todo_update

Patch one existing todo by stable id; omitted fields survive. Add work with todo_create. Mark in_progress with activeForm before work, completed only after finishing. Completion may run its evaluator and be vetoed by a hook: after rejection/blocked-by-hook re-read and revise before retrying. Avoid unchanged updates; read details when state is uncertain, list for unknown ids. Inactive store: continue without more todo calls.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Canonical current-plan ID."
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
      "description": "failed: retry needed; skipped: unnecessary; cancelled: breadcrumb; deleted: remove. Only Runtime restores pending after revise."
    },
    "note": {
      "type": "string",
      "description": "Reason/detail; omitted preserves."
    },
    "activeForm": {
      "type": "string",
      "description": "Required present-continuous label for in_progress; omit terminal transition to preserve."
    },
    "subject": {
      "type": "string",
      "description": "Nonempty replacement imperative title."
    },
    "description": {
      "type": "string",
      "description": "Replacement multiline context; empty clears."
    },
    "evaluator": {
      "type": "string",
      "enum": [
        "build",
        "test",
        "lint"
      ],
      "description": "When wired: build/test/lint → npm run build/npm test/npm run lint on completion; failure returns stderr."
    },
    "metadata": {
      "type": "object",
      "description": "Opaque, not UI. Shallow merge, not deep merge; null values delete keys; whole-field null clears (handler accepts despite object schema)."
    }
  },
  "required": [
    "id"
  ]
}
```

## tool_call

Call one active tool by name once its input contract is known from tool_search, tool_describe or a contract listed in this request. Target policy, permissions and result guardrails reapply.

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Active tool name."
    },
    "input": {
      "type": "object",
      "description": "Target JSON arguments."
    }
  },
  "required": [
    "name",
    "input"
  ]
}
```

## tool_search

Full active-tool contracts, for when no listed tool fits the need or a listed description is too short to call correctly. Listed tools are called directly; call other discovered tools through tool_call. Exact select:NAME[,NAME...] or keyword search over names/descriptions/parameters (+required and loose ranked terms). Keep using returned schema even if later menus compact.

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "select:NAME[,NAME...] or +required loose keywords."
    },
    "max_results": {
      "type": "number",
      "description": "Default 5, max 15; ignored for select:."
    }
  },
  "required": [
    "query"
  ]
}
```

## wait_agent

Yield for Agent mailbox evidence, root user input, interruption or timeout. Progress is UI/SDK-only and never wakes the model. Returns a wake acknowledgement, not the evidence: read the following mailbox. After any mailbox evidence, integrate it and reconcile the affected semantic milestone before waiting again.

```json
{
  "type": "object",
  "properties": {
    "timeout_ms": {
      "type": "number",
      "minimum": 10000,
      "maximum": 3600000,
      "description": "Milliseconds; default 120000. Longer waits cost no model call; user input wakes promptly."
    }
  }
}
```

## web_fetch

Read a URL as bounded plain text, or an extension resource via provider_id + capability_id.

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Remote URL to fetch"
    },
    "provider_id": {
      "type": "string",
      "description": "Optional extension capability provider id for provider-backed fetch"
    },
    "capability_id": {
      "type": "string",
      "description": "Optional provider capability id for provider-backed fetch"
    }
  }
}
```

## web_search

Search the public web by query; cite sources. Use web_fetch when a URL is known.

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query to run"
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of search results to return"
    }
  },
  "required": [
    "query"
  ]
}
```
