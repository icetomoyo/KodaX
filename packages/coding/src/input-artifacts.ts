// CAP-009 (`buildPromptMessageContent`) extracted to
// `agent-runtime/prompt-content.ts` in FEATURE_100 P2; re-export below to
// preserve the public API path.
export { buildPromptMessageContent } from './agent-runtime/prompt-content.js';

// CAP-046 (`extractPromptComparableText`, `extractComparableUserMessageText`)
// extracted to `agent-runtime/middleware/auto-resume.ts` in FEATURE_100 P2;
// re-export below so external consumers (round-boundary.ts, index.ts barrel)
// keep working unchanged.
export {
  extractPromptComparableText,
  extractComparableUserMessageText,
} from './agent-runtime/middleware/auto-resume.js';
