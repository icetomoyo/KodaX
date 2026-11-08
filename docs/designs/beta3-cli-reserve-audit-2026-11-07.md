# Beta 3 CLI reserve restoration — 2026-11-07

The fixed CLI ceiling returns to **5,071 KiB (5,192,704 bytes)**, preserving **49 KiB** beneath the unchanged 5 MiB outer limit. The merged Actor/work-mode/DOCX baseline is `ea71b54de`. This change packages two complete private Windows programs as data; it does not shorten their text, change their argv or remove runtime behavior.

## Byte identity and resource ownership

`packages/agent/src/runtime/windows-effect-job-programs.json` contains the complete PowerShell/C# programs previously composed inside `windows-effect-job.ts`. Their UTF-8 identities were captured from the original executable constants before extraction:

| Program | UTF-8 bytes | SHA-256 |
| --- | ---: | --- |
| Effect Job | 7,570 | `a2fd25dbd7c7dcf8438d3d048b4040db49ee380090dd83c77ca5ad9eb7842f76` |
| Sandbox SID probe | 5,859 | `02307259d2398a467692c41e5673fccd141f7ad08d4862601e99f6fae63f05ce` |

Agent owns the data and loader independently of Root. The loader reads only on first Windows-program use, verifies the selected program against its fixed hash, then caches its UTF-16LE/base64 command. Missing or modified data cannot launch a process. The normal package/SDK lookup and existing `KODAX_BUNDLED` executable-relative lookup follow the established resource pattern; non-Windows entry points do not read the resource.

Both standalone Agent build and Root's direct `tsc -b` build copy the resource. The npm bundle and Bun binary staging copy it alongside their existing program resources, and Root's npm file whitelist includes it. No dependencies, runtime configuration options or cross-layer imports are added.

## Controlled composition probe

Node v22.23.1, TypeScript 5.9.3, esbuild 0.27.7, Windows x64. Frozen production blobs:

- `src/sdk-runtime.ts`: `bb821f7fc9aceccc8e18f328022b0f9a5ad92f3f`
- `packages/agent/src/runtime/windows-effect-job.ts`: `f07a0ad09f96f044cb97c9d4f11cda8f4a100915`
- `packages/agent/src/runtime/windows-effect-job-programs.json`: `7191116eb2aea637ffca34e278ae75b3ed9506e5`

A private copy of the production CLI builder runs schema generation and CLI bundling with unchanged esbuild settings. It retains the eager startup-import and provider-credential uniqueness assertions and executes the restored 49 KiB reserve gate on each candidate composition. The paired baseline overlays only `windows-effect-job.ts` from `ea71b54de`, transpiled to ES2022 JavaScript for the package input, keeping the rest of the graph identical. This is a controlled source-overlay comparison, not a historical checkout build.

| Composition | CLI bytes |
| --- | ---: |
| Paired pre-extraction baseline, actual Windows manifest | 5,197,502 |
| Resource extraction, actual Windows manifest | 5,184,935 |
| Resource extraction, five manifests / Linux host selection | 5,186,436 |
| Resource extraction, five manifests / Windows host selection | 5,186,907 |

The local JavaScript decreases by **12,567 bytes**. The largest measured five-manifest composition fits the restored ceiling with **5,797 bytes** remaining. All **1,138 inputs** remain present; added/removed input sets and unique external `(kind,path)` import differences are empty. Actual Windows-manifest candidate SHA-256: `afb2a6276fe02a27824a8f8c1d858db8842ada778ed70dccf250c30b08c2f202`.

The five-manifest probes preserve the actual Windows manifest and synthesize Linux/Darwin x64/arm64 manifests using the current native builder's exact shape and fixed-length hashes. They measure release composition, not native execution on those targets. Raw scripts, metafiles and CLI artifacts remain in OS temporary directory `kodax-beta3-reserve-audit-p1Vq61`. The earlier combined-source proposal probe is separate evidence and is not the paired baseline above.

## Verification boundary

The existing emitted CLI first failed the restored production-size regression. The paired pre-extraction builder artifact also failed its actual production `assertBundleSize` gate (5,197,502 > 5,192,704 bytes; `baseline-gate-red.log`). A new public-API regression also failed before extraction because a modified resource did not prevent process launch. After extraction, the two-file Windows Job/resource suite passed **16/16**, covering existing real Windows Job behavior plus lazy loading, original command hashes, modified-data rejection and missing binary-resource rejection. Standalone Agent build, test TypeScript checking and its `npm pack --dry-run` resource-presence check passed.

The Root pack regression now checks the resource whitelist, standalone/bundled byte identity and both fixed original hashes. Final Root build, final published-artifact tests and full integration regressions remain the integration owner's separate gate; this private probe does not replace them. Bun staging is implemented but no Bun executable or cross-platform binary was built in this audit. No publication, tag, push or installation was performed.
