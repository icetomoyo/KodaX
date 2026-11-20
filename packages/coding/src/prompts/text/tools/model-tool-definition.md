<!-- @key model-tool.edit.description -->
Read first so each old_string matches the current text. Apply edits sequentially to one existing file; each old_string must be unique in the whole current file unless replace_all. Exact matching, then normalized anchors. Later anchors refer to earlier edits’ results. Commit once; any failure leaves file unchanged. On failure inspect edit index, reread or use a smaller unique anchor, never full-file rewrite to bypass failure. Split oversized replacements.

<!-- @key model-tool.changed_diff.description -->
Read paged diffs for one or more explicit changed paths. Prefer this over broad git diff output during reviews. Includes untracked files; use base_ref and optional target_ref for a comparison range. offset and limit_per_path apply independently to every path. Follow per-path continuation hints when truncated; at most 64 unique paths per call.
