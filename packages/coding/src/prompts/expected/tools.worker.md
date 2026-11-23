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

## ask_user_question

Ask one flat question or 1–4 independent select questions via questions[] (overrides flat question/options; each item requires options). kind=input: flat free text only; select (default): options required. multi_select returns an array, bounded by min/max_selections. Option value defaults to label. Do not add Other: custom input defaults true; false only for closed safety/protocol choices. Batch custom settings inherit flat settings unless overridden. Defaults are suggestions, never submitted automatically. Wait indefinitely unless the Host sets a timeout. Skip/timeout returns unanswered; only Stop interrupts the Run. Continue or explain missing information.

```json
{
  "type": "object",
  "properties": {
    "question": {
      "type": "string"
    },
    "questions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "question": {
            "type": "string"
          },
          "header": {
            "type": "string",
            "description": "Progress label, ≤12 chars."
          },
          "options": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "label": {
                  "type": "string"
                },
                "description": {
                  "type": "string"
                },
                "value": {
                  "type": "string"
                }
              },
              "required": [
                "label"
              ]
            }
          },
          "multi_select": {
            "type": "boolean"
          },
          "min_selections": {
            "type": "integer"
          },
          "max_selections": {
            "type": "integer"
          },
          "default": {
            "type": "string"
          },
          "allow_custom_input": {
            "type": "boolean"
          },
          "custom_input_label": {
            "type": "string"
          },
          "custom_input_prompt": {
            "type": "string"
          },
          "custom_input_default": {
            "type": "string"
          }
        },
        "required": [
          "question",
          "options"
        ]
      },
      "minItems": 1,
      "maxItems": 4
    },
    "kind": {
      "type": "string",
      "enum": [
        "select",
        "input"
      ]
    },
    "options": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "label": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "required": [
          "label"
        ]
      }
    },
    "multi_select": {
      "type": "boolean"
    },
    "min_selections": {
      "type": "integer"
    },
    "max_selections": {
      "type": "integer"
    },
    "allow_custom_input": {
      "type": "boolean"
    },
    "custom_input_label": {
      "type": "string",
      "description": "Custom-choice label; default \"Other...\"."
    },
    "custom_input_prompt": {
      "type": "string",
      "description": "Custom-choice prompt."
    },
    "custom_input_default": {
      "type": "string",
      "description": "Custom-choice initial text."
    },
    "default": {
      "type": "string"
    }
  }
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

## changed_diff

Read paged diffs for one or more explicit changed paths. Prefer this over broad git diff output during reviews. Includes untracked files; use base_ref and optional target_ref for a comparison range. offset and limit_per_path apply independently to every path. Follow per-path continuation hints when truncated; at most 64 unique paths per call.

```json
{
  "type": "object",
  "properties": {
    "target_path": {
      "type": "string",
      "description": "Optional path inside the workspace to resolve the repository root from"
    },
    "base_ref": {
      "type": "string",
      "description": "Optional base git ref for compare-range review"
    },
    "target_ref": {
      "type": "string",
      "description": "Optional target git ref for compare-range review (defaults to HEAD when base_ref is provided)"
    },
    "paths": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "maxItems": 64,
      "description": "Changed paths inside the workspace; one path is valid"
    },
    "limit_per_path": {
      "type": "number",
      "description": "Maximum diff lines per path (default 200, maximum 800)"
    },
    "offset": {
      "type": "number",
      "description": "1-based diff line offset for pagination"
    },
    "context_lines": {
      "type": "number",
      "description": "Unified diff context lines to request"
    }
  },
  "required": [
    "paths"
  ]
}
```

## changed_diff_bundle

Read diff slices for multiple changed files in one call. Prefer this for large reviews before drilling down with changed_diff.

```json
{
  "type": "object",
  "properties": {
    "target_path": {
      "type": "string",
      "description": "Optional path inside the workspace to resolve the repository root from"
    },
    "base_ref": {
      "type": "string",
      "description": "Optional base git ref for compare-range review"
    },
    "target_ref": {
      "type": "string",
      "description": "Optional target git ref for compare-range review (defaults to HEAD when base_ref is provided)"
    },
    "paths": {
      "type": "array",
      "description": "Changed file paths to inspect in one bundle, relative to the workspace root or absolute inside it",
      "items": {
        "type": "string"
      },
      "maxItems": 64
    },
    "offset": {
      "type": "number",
      "description": "1-based diff line offset applied to each path in the bundle"
    },
    "limit_per_path": {
      "type": "number",
      "description": "Maximum diff lines to return per path in this bundle"
    },
    "context_lines": {
      "type": "number",
      "description": "Unified diff context lines to request"
    }
  },
  "required": [
    "paths"
  ]
}
```

## changed_scope

For change-set reviews, list worktree/range changes to set scope; keep explicit audit scope. After scope, fan out independent review lanes before reading every diff.

```json
{
  "type": "object",
  "properties": {
    "target_path": {
      "type": "string",
      "description": "Optional path inside the workspace to resolve the repository root from"
    },
    "scope": {
      "type": "string",
      "enum": [
        "unstaged",
        "staged",
        "all",
        "compare"
      ],
      "description": "Which git change set to inspect. Defaults to all."
    },
    "base_ref": {
      "type": "string",
      "description": "Base ref used when scope=compare. Defaults to HEAD~1."
    },
    "refresh_overview": {
      "type": "boolean",
      "description": "When true, rebuild the repo overview snapshot before analyzing changes"
    },
    "offset": {
      "type": "integer",
      "minimum": 0,
      "description": "Index of the first changed file to list. Use the offset named in the previous result to page through a long change set. Defaults to 0."
    }
  }
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

## create_goal

Create only on explicit user/system/developer request, never infer from ordinary tasks. token_budget only if explicitly requested. Fails if a goal exists; update_goal changes status only.

```json
{
  "type": "object",
  "properties": {
    "objective": {
      "type": "string",
      "description": "Concrete target end-state across turns."
    },
    "token_budget": {
      "type": "number",
      "description": "Positive integer total budget; otherwise omit."
    }
  },
  "required": [
    "objective"
  ]
}
```

## edit

Read first so each old_string matches the current text. Apply edits sequentially to one existing file; each old_string must be unique in the whole current file unless replace_all. Exact matching, then normalized anchors. Later anchors refer to earlier edits’ results. Commit once; any failure leaves file unchanged. On failure inspect edit index, reread or use a smaller unique anchor, never full-file rewrite to bypass failure. Split oversized replacements.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string"
    },
    "edits": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "properties": {
          "old_string": {
            "type": "string"
          },
          "new_string": {
            "type": "string"
          },
          "replace_all": {
            "type": "boolean",
            "description": "All occurrences; default false."
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

Parent-only interactive REPL approval of the finished plan. Approved → accept-edits; rejected → stay in plan and revise. Wait for Host approval before implementing.

```json
{
  "type": "object",
  "properties": {
    "plan": {
      "type": "string",
      "description": "Full plan, not summary: ≤40 lines, ≤3 bullet levels, one sentence/bullet. If larger, present the current phase for phase-by-phase approval."
    }
  },
  "required": [
    "plan"
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

## get_goal

Read current session goal: status, budget, used/remaining tokens and elapsed time.

```json
{
  "type": "object",
  "properties": {}
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

## insert_after_anchor

Insert content after a unique anchor without rewriting the file; preferred for new sections in existing docs/configs.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string"
    },
    "anchor": {
      "type": "string",
      "description": "Unique heading/marker."
    },
    "content": {
      "type": "string"
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

## list_dispatchable_agents

List host-allowed Native/Constructed/External executors; use returned canonical agent_id in spawn_agent.

```json
{
  "type": "object",
  "properties": {
    "required_skills": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Every returned agent must declare all listed skills."
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
      "description": "Required lifecycle capabilities."
    },
    "read_only": {
      "type": "boolean",
      "description": "true excludes external write/unknown remote effects."
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

## lsp_prepare_call_hierarchy

Inspect call hierarchy root metadata for a symbol at a file position. Incoming and outgoing call tools prepare roots internally; a separate prepare call is unnecessary for those queries.

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

## memory

Save, change or remove a durable memory note. operation write creates a note, edit changes one, delete removes one. id is a short lowercase slug naming the note. scope is project for facts about this repository, or user for preferences that apply everywhere. description is the one-line summary shown in the index, so make it specific enough to decide relevance without opening the note. body holds the details. why states the reason or incident behind the note. check says how to confirm the note is still true. userQuote is an exact quote from the current user message when the user asked for this change. Without userQuote, a write becomes a candidate that stays out of the index until confirmed. Without userQuote, edit and delete are refused.

```json
{
  "type": "object",
  "properties": {
    "operation": {
      "type": "string",
      "enum": [
        "write",
        "edit",
        "delete"
      ],
      "description": "Create, change or remove a note."
    },
    "id": {
      "type": "string",
      "description": "Short slug naming the note, e.g. test-command."
    },
    "scope": {
      "type": "string",
      "enum": [
        "project",
        "user"
      ],
      "description": "project (default) or user."
    },
    "type": {
      "type": "string",
      "enum": [
        "user",
        "feedback",
        "project",
        "reference",
        "procedure"
      ],
      "description": "Optional, and it only decides where the note sits in the index. Use user for who the user is, feedback for how the user wants you to work, project for a fact about this codebase, reference for where to find something outside it, and procedure for steps that worked."
    },
    "description": {
      "type": "string",
      "description": "One-line index summary."
    },
    "body": {
      "type": "string",
      "description": "The note details."
    },
    "why": {
      "type": "string",
      "description": "The reason or incident behind the note."
    },
    "check": {
      "type": "string",
      "description": "How to confirm the note is still true."
    },
    "userQuote": {
      "type": "string",
      "description": "Exact quote from the current user message authorizing this change."
    }
  },
  "required": [
    "operation",
    "id"
  ]
}
```

## memory_intent

Governed Memory: list accepted claims/refs; remember; correct/forget exact claim ref; decisions/show only when asked. Every mutation needs an exact affirmative current-user userQuote. remember/correct statement must be an exact claim span, never inferred/paraphrased, with claimKind; new claims require stable claimKey. approve/reject need exact decision ref plus authorization. Safe requests apply; ambiguity asks; conflicts become decisions; restricted content rejected.

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
      ]
    },
    "statement": {
      "type": "string"
    },
    "targetRefId": {
      "type": "string",
      "description": "Exact list/recall claim ref, or exact decision ref."
    },
    "claimKind": {
      "type": "string",
      "enum": [
        "fact",
        "policy",
        "preference",
        "procedure"
      ]
    },
    "claimKey": {
      "type": "string",
      "description": "Stable identity, e.g. project.package_manager."
    },
    "userQuote": {
      "type": "string"
    },
    "reason": {
      "type": "string",
      "description": "User-supplied rejection reason."
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

## multi_edit

Apply multiple exact-text replacements to a single file in ONE atomic tool call.

## When to Use This Tool

- Several independent edits to the same file — especially when filling in a skeleton you just created with `write`.
- Bulk renames within one file (use `replace_all: true` per edit).
- Refactors that touch multiple spots in one file and should land all-or-nothing.

## When NOT to Use This Tool

- For a single change — call `edit` directly; the extra wrapping is unnecessary overhead.
- Without first calling `read` on the file in this conversation — your first failing `old_string` aborts the ENTIRE batch, so you pay for all the edits in tokens but land none of them.
- When later edits need to reference text an earlier edit overlaps — edits compose sequentially (each sees the result of the previous), so once `edits[k]` rewrites a region, text inside that region is no longer a valid anchor for `edits[k+1..]`. Either shrink the earlier edit to preserve the anchor, or merge them into one edit.

## Atomicity

The whole batch is atomic: if any single `old_string` fails to match, NO edits are written to disk and you get back an index pointing at the failing edit. Each `edits[i]` has the same semantics as one `edit` call — exact-match first, then safe-normalized anchor fallback; `replace_all: true` per edit for bulk renames.

## Uniqueness

Each `old_string` must be unique in the WHOLE current file, not just in the window you last read. A short snippet from a narrow `read` (single line, 6-line window, common phrase) is the #1 cause of "matched N places" errors. Widen the anchor with a nearby unique landmark (heading, function signature, distinctive comment, or a multi-line block), or set `replace_all: true` if every occurrence should change.

## Typical Pattern

(1) `write(path, skeleton_with_<!-- SECTION_A -->_placeholders)`; (2) `multi_edit(path, [{SECTION_A, realA}, {SECTION_B, realB}, ...])` — one batched call.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "The absolute path to the file"
    },
    "edits": {
      "type": "array",
      "description": "Sequence of edit operations to apply in order",
      "items": {
        "type": "object",
        "properties": {
          "old_string": {
            "type": "string",
            "description": "The text to replace (matched exactly, then via normalized fallback)"
          },
          "new_string": {
            "type": "string",
            "description": "The replacement text"
          },
          "replace_all": {
            "type": "boolean",
            "description": "When true, replace every occurrence of old_string (defaults to false)"
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

## repo_overview

Workspace structure snapshot for repository work that needs structure. Reuse a supplied overview while applicable; a new session or task alone needs no call.

```json
{
  "type": "object",
  "properties": {
    "target_path": {
      "type": "string",
      "description": "Optional path inside the workspace to resolve the repository root from"
    },
    "refresh": {
      "type": "boolean",
      "description": "When true, rebuild the repo overview snapshot before returning it"
    }
  }
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

Start a named direct child; returns canonical path. Runtime atomically enforces shared session concurrency/work budgets. For broad multi-file reviews, launch distinct read-only lanes once scope is known. Implementation lanes require read_only:false and disjoint write ownership with exact exclusive paths/generated outputs. quality_strategy is optional telemetry, never admission control; invalid/conflicting data is ignored.

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

Add one semantic milestone without replacing existing items. Returns {ok:true,id}; reuse this generated id, never supply one. This records planned work, not execution. Plan work with several distinct deliverables. Skip trivial or informational tasks, because a one-step plan only adds noise. Resume existing milestones and inspect the plan only when uncertain to avoid duplicates. Milestones are deliverables, not child Agents; several Agents may support one. Use the requested language, otherwise the request primary language, for subject/description/activeForm; retain source identifiers, paths, commands and quotes. Inactive store, invalid input or extension veto returns {ok:false,reason}.

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

## todo_get

Read one existing todo by stable id, including its subject, description, status, activeForm, note, evaluator, owner, and metadata. Read before resuming work when the compact row or current state is insufficient; runner-side handlers may have changed its status. If the desired patch is already clear, call todo_update directly. Returns {ok:true,item} or {ok:false,reason} for an inactive store or unknown id; todo_list provides canonical ids.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "The todo id to retrieve (e.g. \"todo_3\"). Must match a current valid id."
    }
  },
  "required": [
    "id"
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

Patch one existing todo by stable id; omitted fields survive. Add work with todo_create. Mark in_progress with activeForm before work, completed only after finishing. Keep one in_progress item per owner. Use the requested language, otherwise the request primary language, for subject/description/activeForm/note; retain source identifiers, paths, commands and quotes. Completion may run its evaluator and be vetoed by a hook: after rejection/blocked-by-hook re-read and revise before retrying. Avoid unchanged updates; read details when state is uncertain, list for unknown ids. Inactive store: continue without more todo calls.

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

## tool_describe

Return the full description and input schema for active tools. Compatibility entry; tool_search query="select:NAME[,NAME...]" also returns full contracts without a second lookup.

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Name of the active tool to describe."
    },
    "names": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional list of active tool names to describe. Capped by the runtime."
    }
  }
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

## undo

Revert the last file modification.

```json
{
  "type": "object",
  "properties": {}
}
```

## update_goal

Complete only when objective and all requirements are evidenced; disclose unverified scope. Bookkeeping is not quality certification. blocked requires external unblock and same blocker_kind for 3 consecutive turns; Runtime rejects earlier. Pause/resume/budget-limited are user-controlled. Never call merely to stop work.

```json
{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "complete",
        "blocked"
      ]
    },
    "blocker_kind": {
      "type": "string",
      "description": "Required blocked: stable obstacle ID compared across turns, e.g. awaiting-user-permission."
    }
  },
  "required": [
    "status"
  ]
}
```

## wait_agent

Yield for Agent mailbox evidence, root user input, interruption or timeout. Continue useful non-overlapping work first; wait sparingly when required Agent evidence is on the critical path. Progress is UI/SDK-only and never wakes the model. Returns a wake acknowledgement, not the evidence: read the following mailbox. After any mailbox evidence, integrate it and reconcile the affected semantic milestone before waiting again.

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

## worktree_create

Create isolated Git worktree/branch for Agent work.

```json
{
  "type": "object",
  "properties": {
    "branch_name": {
      "type": "string",
      "description": "Explicit branch; optional."
    },
    "description": {
      "type": "string",
      "description": "Input used to generate a branch name."
    }
  }
}
```

## worktree_remove

Keep/remove a Git worktree directory and optionally its branch.

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "keep",
        "remove"
      ]
    },
    "worktree_path": {
      "type": "string",
      "description": "Absolute worktree path."
    },
    "discard_changes": {
      "type": "boolean",
      "description": "true bypasses uncommitted/local-commit safety checks."
    }
  },
  "required": [
    "action",
    "worktree_path"
  ]
}
```

## write

Direct UTF-8 write for explicitly requested new file/full rewrite; existing changes: edit. Large diffs may summarize. Oversized/stream-failed content: smaller skeleton/placeholders then edit sections. Shell wrappers bypass mutation/diff checks and shift streaming limits. Chinese/emoji need no encoding workaround.

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Absolute file path."
    },
    "content": {
      "type": "string"
    }
  },
  "required": [
    "path",
    "content"
  ]
}
```
