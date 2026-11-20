/**
 * Eval: image vision perception — permanent regression sweep + structural
 * floor probe for the "Worker denies seeing PNG / reaches for
 * agent-browser" failure mode.
 *
 * ## Background
 *
 * Bug report (2026-05-19): user pasted a PNG into KodaX REPL (Worker on
 * `kimi-code`). Worker thinking emitted "用户发了一张中国地图的PNG图片给我，但
 * 我无法直接读取/查看PNG图片内容（read工具不支持二进制文件）" and reached for
 * `agent-browser` to open the file via shell, instead of describing what it
 * saw in the attached image content block.
 *
 * Wire-level probe (4 transport variants against `api.kimi.com/coding/`)
 * confirmed Kimi K2-for-coding sees images natively. So the bug is upstream
 * of the wire — something in KodaX's agentic prompt / tool catalog /
 * skills primer can push the model into tool-mode for binary inputs.
 *
 * ## What we tried + why Fix B got REVERTED (2026-05-20)
 *
 * A first defensive-parity attempt added an "Image perception:" block to
 * `sharedWorkerDiscipline` (commit bc04581c) telling all roles "you can
 * see image blocks natively; don't reach for tools; on compaction-stale
 * markers, ask user to re-attach". Original Layer 2 regression eval
 * (V_baseline + V_fix only, lenient regex matching SVG markup OR
 * image-content keywords) showed V_fix ≥ V_baseline everywhere, so it
 * shipped.
 *
 * Rigorous re-eval (this file's current form, after tightening regex to
 * require image-content keywords AND adding Layer 3 priming +
 * compaction-state variants) revealed:
 *
 *   - Fresh state: V_fix == V_baseline (kimi+zhipu both 100%, mmx noisy).
 *     No measurable benefit, no harm.
 *   - Priming state (kimi V_*_primed): both 100%. kimi recovers from
 *     canned "I can't read PNG + read tool failed" priming on its own.
 *   - Compaction state (zhipu V_*_compacted): BOTH variants fail at the
 *     image-content level. V_baseline_compacted tends to honest
 *     `NO_IMAGE_PERCEIVED` refusals (safe). V_fix_compacted tends to
 *     CONFIDENT HALLUCINATIONS — under bc04581c it described page04_v2
 *     (a split-screen 屏幕内外 diagram) as a 3-4-5 right triangle / scout
 *     badge / heart shape and wrote SVG accordingly.
 *
 *   The original "100% V_fix" claim on bc04581c was a lenient-regex false
 *   positive — the model output only matched `<path>` markup, no image-
 *   content keyword. Same for the original mmx 0→33% lift.
 *
 * Decision (2026-05-20, user-approved): REVERT Fix B. It had no
 * measurable in-vitro lift, and in zhipu compaction state it converted
 * honest refusal into confident lie — a real regression by the user's
 * "不会引入别的问题或者功能退化" criterion.
 *
 * This file stays as a permanent regression sweep so the next attempt
 * (whoever picks this up) starts from a rigorous baseline.
 *
 * ## What the eval measures now
 *
 *   R1 (no measurable harm from any future prompt change): for fresh and
 *       primed states on kimi+zhipu, V_baseline pass rate matches
 *       V_<future-variant> pass rate. Already saturated on canon.
 *
 *   R2 (no hallucination introduction): on the text-only negative case
 *       (NO image attached), no variant introduces "I see your image"
 *       phrasing. Already 100% on kimi+zhipu.
 *
 *   R3 (structural floor markers): zhipu compaction state cells should
 *       reproduce the documented structural floor (NO_IMAGE_PERCEIVED
 *       refusal OR hallucinated SVG of an unrelated shape) on
 *       case_diagram. If a future change makes this work at the image-
 *       content level, that's real lift to celebrate (and to ship).
 *
 *   R4 (regex catches hallucination): the tightened
 *       `imageContentKeywords` policy requires at least one case-specific
 *       phrase to PASS. SVG markup alone is no longer a pass. This is
 *       the policy that exposed bc04581c's false positive.
 *
 * ## Variants
 *
 *   V_baseline: agentic system (buildWorkerInstructions + SKILLS_SECTION)
 *               + KODAX_TOOLS, NO image-perception block.
 *
 *   V_fix:      V_baseline + the exact `Image perception:` text shipped in
 *               `sharedWorkerDiscipline`.
 *
 * ## Cases
 *
 *   case_diagram (image): `C:/tmp/page04_v2.png` — bilingual split-screen
 *       diagram. Positive: SVG markup OR image-specific terms.
 *
 *   case_counter (image): `C:/tmp/counter-demo-initial.png` — UI screenshot
 *       with "Counter Demo — L0 联动" + Slot A/B iframes. Positive: SVG
 *       markup OR image-specific terms.
 *
 *   case_text_only (no image): plain text task explaining a counter
 *       component. Negative regression check: model must not claim to see
 *       an image that wasn't attached.
 *
 * ## Mechanical assertion (CURRENT, post-2026-05-20 tightening)
 *
 *   Image cases (case_diagram / case_counter):
 *     PASS: ≥1 image-content keyword match (case-specific phrases like
 *           "屏幕内外" / "human-vs-AI 视角" / "counter-demo" / "L0 联动")
 *           AND no negative keyword. SVG markup alone is NO LONGER a
 *           PASS — it doesn't prove the model actually saw THIS image.
 *
 *   Text-only case (case_text_only):
 *     PASS: no hallucination marker ("the image shows / 我看到你发的图 /
 *           based on the screenshot you attached").
 *
 *   Per EVAL_GUIDELINES.md anti-pattern 7: regex result is paired with
 *   self-judge audit (orchestrating Claude reads raw dump). Disagreement
 *   >10% → data void.
 *
 * ## Variants
 *
 *   V_baseline             : fresh state, no Fix B priming.
 *   V_fix                  : fresh state + Image perception block (post-
 *                            revert kept for the case where someone
 *                            re-attempts a similar fix — wire SHIPPED_
 *                            IMAGE_PERCEPTION_BLOCK to whatever they ship).
 *   V_baseline_primed      : canned turn 1 = assistant denied + read tool
 *                            errored, then current turn re-attaches image.
 *                            Catches multi-turn priming. kimi recovers.
 *   V_fix_primed           : same priming + Fix B block.
 *   V_baseline_compacted   : canned turn 1 image was replaced with a text
 *                            marker (microcompaction.ts:106-110 simulates
 *                            this after maxAge=20 turns) and read failed,
 *                            then current turn re-attaches real image.
 *                            zhipu's documented structural-floor cell:
 *                            tends to NO_IMAGE_PERCEIVED on case_diagram.
 *   V_fix_compacted        : same compaction + Fix B block. Documented
 *                            failure mode (2026-05-20): zhipu converts
 *                            refusal into confident hallucination here.
 *
 * ## Sample size + budget
 *
 *   priming-pilot   : kimi × case_diagram × {V_*_primed} × 1 = 2 calls
 *   compaction-pilot: {kimi, zhipu} × {case_diagram, case_counter} ×
 *                     {V_*_compacted} × 3 = 24 calls
 *   pilot           : kimi × 3 cases × 4 variants × 1 = 10 calls
 *                     (primed/compacted skipped on text-only)
 *   panel           : 3 vision-capable alias × 3 cases × 6 variants ×
 *                     3 runs ≈ 144 calls (subscription, ~$0 marginal).
 *                     ds/v4flash + ds/v4pro OMITTED — deepseek API 400s
 *                     on `image_url` content (separate provider bug).
 *
 * ## Run
 *
 *   Priming pilot:    npm run test:eval -- image-vision-perception -t priming-pilot
 *   Compaction pilot: npm run test:eval -- image-vision-perception -t compaction-pilot
 *   Full pilot:       npm run test:eval -- image-vision-perception -t "^pilot"
 *   Full panel:       npm run test:eval -- image-vision-perception -t panel
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  getProvider,
  type KodaXContentBlock,
  type KodaXMessage,
  type KodaXTaskRoutingDecision,
  type KodaXToolDefinition,
} from '@kodax-ai/llm';
import { KODAX_TOOLS } from '@kodax-ai/coding';

import {
  availableAliases,
  resolveAlias,
  type ModelAlias,
} from '../benchmark/harness/aliases.js';
import { buildWorkerInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';

// ---------------------------------------------------------------------------
// Dump dir (EVAL_GUIDELINES.md §Raw output preservation — must be OS tmpdir).
// ---------------------------------------------------------------------------

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'image-vision-perception');
mkdirSync(DUMP_ROOT, { recursive: true });

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

const IMAGE_USER_QUESTION =
  '请根据这张图的内容，输出对应的 SVG path 代码（只需要 <path d="..."/> 元素，能勾勒出图中所示主要图形即可）。如果你确实看不见图片，直接说 "NO_IMAGE_PERCEIVED"。';

const TEXT_ONLY_USER_QUESTION =
  '用 100 字以内解释一下：如果要在 React 里实现一个会计数的 Counter 组件，最少需要哪几个状态/事件？不要假设我发过任何截图或图片，纯文字回答即可。';

interface VisionCase {
  readonly id: string;
  readonly imagePath?: string;
  readonly mediaType?: 'image/png' | 'image/jpeg';
  readonly userQuestion: string;
  // Image-grounded content keywords. PASS requires ≥1 match (proves model
  // actually saw THIS image, not a generic SVG fallback). For text-only
  // cases this is empty.
  readonly imageContentKeywords: readonly RegExp[];
  // Keywords used for the text-only case (hallucination markers) or for
  // recording-only signal on image cases. Negative match always FAILs.
  readonly negativeKeywords: readonly RegExp[];
  // Whether this case requires at least one imageContentKeyword match to
  // pass. text-only sets this false (the assertion is purely "no negative
  // match"). Image cases set this true to catch hallucination.
  readonly requiresImageContent: boolean;
}

// Shared denial / tool-reach phrases. Used on image cases (these would be
// the literal failure mode the bug report described).
const IMAGE_DENIAL_NEGATIVES: readonly RegExp[] = [
  /NO_IMAGE_PERCEIVED/,
  /无法.{0,6}(直接)?(读取|查看|看见|看到)/,
  /我.{0,4}看不(?:到|见)/,
  /cannot\s+(see|read|view|access).{0,20}image/i,
  /unable\s+to\s+(see|read|view).{0,20}image/i,
  /\bread\b.{0,4}工具/,
  /agent[-_]browser/i,
  /不支持二进制/,
  /binary.{0,10}not\s+supported/i,
];

// Hallucination markers — claims of having seen an image when none was
// attached. These trigger on the text-only case (regression check for
// Fix B over-trigger).
const HALLUCINATION_NEGATIVES: readonly RegExp[] = [
  /你(发|给|附|上传|提供|贴)了?.{0,8}(图|截图|图片|image|screenshot)/i,
  /我看到(?:你?发?的?).{0,6}(图|截图|图片)/,
  /the\s+(image|screenshot|diagram|picture)\s+you\s+(sent|attached|provided|shared)/i,
  /based\s+on\s+the\s+(image|screenshot|attached|picture)/i,
  /(in|from)\s+the\s+(image|screenshot|attached|diagram)/i,
  /图(里|中|上).{0,8}(显示|可以看到|展示)/,
];

const CASES: readonly VisionCase[] = [
  {
    id: 'case_diagram',
    imagePath: 'C:/tmp/page04_v2.png',
    mediaType: 'image/png',
    userQuestion: IMAGE_USER_QUESTION,
    // ALL image-content-specific — proves model saw THIS image. SVG markup
    // alone is no longer sufficient because a hallucinating model can emit
    // valid SVG for a completely unrelated shape (see compaction-pilot
    // 2026-05-19: zhipu under V_fix_compacted output a 3-4-5 triangle SVG
    // when the image is the 屏幕内外 split-screen diagram).
    imageContentKeywords: [
      /屏幕内外/,
      /split[-\s]?screen/i,
      /(human|人类).{0,12}(AI|视角)/i,
      /数字矩阵|玻璃屏幕/,
      /(perspective|视角)/i,
      /活跃用户模拟器|主动型助手/,
      /玻璃屏|手指(点击|tap)/,
    ],
    negativeKeywords: IMAGE_DENIAL_NEGATIVES,
    requiresImageContent: true,
  },
  {
    id: 'case_counter',
    imagePath: 'C:/tmp/counter-demo-initial.png',
    mediaType: 'image/png',
    userQuestion: IMAGE_USER_QUESTION,
    imageContentKeywords: [
      /counter[\s—–\-]{0,3}demo/i,
      /L0[\s—–\-]{0,3}联动/,
      /\biframe/i,
      /slot[\s—–\-]{0,3}[ab]\b/i,
      /sandbox/i,
    ],
    negativeKeywords: IMAGE_DENIAL_NEGATIVES,
    requiresImageContent: true,
  },
  {
    id: 'case_text_only',
    userQuestion: TEXT_ONLY_USER_QUESTION,
    imageContentKeywords: [],
    negativeKeywords: HALLUCINATION_NEGATIVES,
    requiresImageContent: false,
  },
];

// ---------------------------------------------------------------------------
// Variants — V_baseline vs V_fix.
// ---------------------------------------------------------------------------

// EXACT text shipped in `sharedWorkerDiscipline` (role-prompt.ts:231).
// Kept in sync manually — small enough that drift is obvious in PR diff.
const SHIPPED_IMAGE_PERCEPTION_BLOCK = [
  'Image perception:',
  '- When a user message contains an image content block (pasted screenshot, diagram, photo, sketch, UI mockup), you can see the image directly through native vision. Describe what you see and answer the question — do NOT claim you cannot read PNG/JPEG/binary files, and do NOT say the `read` tool is needed.',
  '- Do NOT invoke `agent-browser`, `read`, `view`, or any other tool to "open" or "decode" an attached image. `agent-browser` is for live web URLs only; no tool call can decode an image that is already inlined into the conversation.',
  '- If the user attached an image to clarify intent (e.g. "describe this", "convert to SVG", "what is wrong here"), execute the task against the image directly. If a prior turn replaced an image with a text marker like `[Image: filename.png]` (history compaction), say so and ask the user to re-attach — do not invent content.',
].join('\n');

// Representative skills snippet mirroring what the user's session loaded.
// Captures the BLOCKING REQUIREMENT phrasing the production
// `getSystemPromptSnippet` (packages/skills/src/skill-registry.ts:171) emits,
// plus the `agent-browser` skill's actual description.
const SKILLS_SECTION = [
  '## Available Skills',
  '',
  'When users ask you to perform tasks, check if any of the available skills below match the request. Skills provide specialized capabilities and step-by-step instructions for specific workflows.',
  '',
  'When users reference a "slash command" or "/<something>" (e.g. "/feature-list-tracker", "/skill:foo"), they are referring to a skill. Use the read tool to load the skill\'s `SKILL.md` and follow its instructions.',
  '',
  "**BLOCKING REQUIREMENT**: When a skill matches the user's request, you MUST read the relevant skill's `SKILL.md` BEFORE generating any other response about the task. Loading the skill is not optional and not something to defer — it is the FIRST action you take.",
  '',
  'NEVER mention a skill without actually reading its `SKILL.md`. Do not guess at skill names — only use skills listed below.',
  '',
  '- agent-browser: Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task.',
  '  (Location: ~/.claude/skills/agent-browser/SKILL.md)',
  '',
].join('\n');

const PROBE_DECISION: KodaXTaskRoutingDecision = {
  primaryTask: 'review',
  workIntent: 'review',
  complexity: 'multi-step',
  riskLevel: 'low',
  harnessProfile: 'H0_DIRECT',
  recommendedMode: 'agentic',
  recommendedThinkingDepth: 'balanced',
  requiresBrainstorm: false,
  confidence: 0.9,
  reason: 'image vision regression guard (Layer 2 eval)',
};

function workerLikeSystemPrompt(includeFixB: boolean): string {
  const workerInstructions = buildWorkerInstructions(PROBE_DECISION, undefined, false);
  const parts = [workerInstructions, SKILLS_SECTION];
  if (includeFixB) parts.push(SHIPPED_IMAGE_PERCEPTION_BLOCK);
  return parts.join('\n\n');
}

interface VariantSpec {
  readonly id:
    | 'V_baseline' | 'V_fix'
    | 'V_baseline_primed' | 'V_fix_primed'
    | 'V_baseline_compacted' | 'V_fix_compacted';
  readonly system: string;
  readonly tools: readonly KodaXToolDefinition[];
  readonly primed: boolean;
  readonly compacted: boolean;
}

// Layer 3 priming history — synthesises the conversation state we suspect
// is the actual production trigger: an earlier assistant turn already
// denied seeing the image and reached for a file-reading tool. The current
// turn is the user re-attaching the same image and asking the question.
//
// `V_*_primed` variants attach this history before the current user turn.
// If V_baseline_primed regex-FAILs (denial / tool-reach) and V_fix_primed
// regex-PASSes on the same alias × case, we have direct evidence Fix B
// breaks priming. If V_baseline_primed also passes, the bug isn't
// multi-turn priming and Fix B is pure defensive parity (still safe to
// ship, but eval can't claim it "fixes" anything observable).
function buildPrimingHistory(c: VisionCase): readonly KodaXMessage[] {
  if (!c.imagePath || !c.mediaType) return [];
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: `[Image #1] ${c.userQuestion}` },
        { type: 'image', path: c.imagePath, mediaType: c.mediaType },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '用户发了一张 PNG 图片给我，但我无法直接读取/查看 PNG 图片内容（read 工具不支持二进制文件）。让我尝试通过 read 工具读取这个文件路径看看。',
        },
        {
          type: 'tool_use',
          id: 'toolu_priming_read_001',
          name: 'read',
          input: { path: c.imagePath },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_priming_read_001',
          content: 'Error: file appears to be binary (PNG). The read tool only supports UTF-8 text files.',
          is_error: true,
        },
      ],
    },
  ];
}

// Compacted-state priming: image was replaced with a text marker in the
// prior turn (microcompaction.ts:106-110 does this after maxAge=20 turns)
// AND the file-tracker ledger leaked the full path. This is the EXACT
// scenario Fix B's third bullet was written to address. If this doesn't
// trigger baseline failure, the bug needs a state we cannot synthesize.
function buildCompactionHistory(c: VisionCase): readonly KodaXMessage[] {
  if (!c.imagePath || !c.mediaType) return [];
  return [
    {
      role: 'user',
      content: [
        // No actual image block — only the compaction text marker, as
        // microcompaction.ts would have left it.
        { type: 'text', text: `[Image: ${c.imagePath.split('/').pop() ?? 'paste.png'}]\n[Image #1] 请帮我看看这张图。` },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '看到用户附了一张图，但当前消息里只有文本占位符。我尝试用 read 工具读取该文件路径。',
        },
        {
          type: 'tool_use',
          id: 'toolu_compaction_read_001',
          name: 'read',
          input: { path: c.imagePath },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_compaction_read_001',
          content: 'Error: file appears to be binary (PNG). Cannot read as text.',
          is_error: true,
        },
      ],
    },
  ];
}

function buildVariants(): readonly VariantSpec[] {
  return [
    { id: 'V_baseline', system: workerLikeSystemPrompt(false), tools: KODAX_TOOLS, primed: false, compacted: false },
    { id: 'V_fix', system: workerLikeSystemPrompt(true), tools: KODAX_TOOLS, primed: false, compacted: false },
    { id: 'V_baseline_primed', system: workerLikeSystemPrompt(false), tools: KODAX_TOOLS, primed: true, compacted: false },
    { id: 'V_fix_primed', system: workerLikeSystemPrompt(true), tools: KODAX_TOOLS, primed: true, compacted: false },
    { id: 'V_baseline_compacted', system: workerLikeSystemPrompt(false), tools: KODAX_TOOLS, primed: false, compacted: true },
    { id: 'V_fix_compacted', system: workerLikeSystemPrompt(true), tools: KODAX_TOOLS, primed: false, compacted: true },
  ];
}

// ---------------------------------------------------------------------------
// One-shot call.
// ---------------------------------------------------------------------------

interface CellRun {
  readonly runIndex: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly durationMs: number;
  readonly regexPassed: boolean;
  readonly regexReason: string;
  readonly errorMessage?: string;
}

interface CellResult {
  readonly alias: ModelAlias;
  readonly variantId: VariantSpec['id'];
  readonly caseId: string;
  readonly runs: readonly CellRun[];
  readonly passRate: number;
}

function judgeResponse(
  c: VisionCase,
  text: string,
  toolCalls: readonly { name: string; input: unknown }[],
): { passed: boolean; reason: string } {
  const haystack = [
    text,
    ...toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.input)})`),
  ].join('\n');

  const negativeMatches = c.negativeKeywords.filter((re) => re.test(haystack));
  if (negativeMatches.length > 0) {
    return {
      passed: false,
      reason: `negative match: ${negativeMatches.map((re) => re.source).join(' | ')}`,
    };
  }
  if (!c.requiresImageContent) {
    return {
      passed: true,
      reason: 'no-image case: no hallucination marker matched',
    };
  }
  const contentMatches = c.imageContentKeywords.filter((re) => re.test(haystack));
  if (contentMatches.length < 1) {
    return {
      passed: false,
      reason: `no image-content-specific keyword matched (likely hallucination or empty response). text head: "${text.slice(0, 120).replace(/\n/g, ' ')}"`,
    };
  }
  return {
    passed: true,
    reason: `matched ${contentMatches.length} image-content keywords: ${contentMatches.map((re) => re.source).join(', ')}`,
  };
}

async function runCell(
  alias: ModelAlias,
  variant: VariantSpec,
  c: VisionCase,
  runs: number,
): Promise<CellResult> {
  const target = resolveAlias(alias);
  const provider = getProvider(target.provider);

  const userContent: KodaXContentBlock[] = c.imagePath && c.mediaType
    ? [
      { type: 'text', text: `[Image #1] ${c.userQuestion}` },
      { type: 'image', path: c.imagePath, mediaType: c.mediaType },
    ]
    : [{ type: 'text', text: c.userQuestion }];

  const history = variant.primed
    ? buildPrimingHistory(c)
    : variant.compacted
      ? buildCompactionHistory(c)
      : [];
  const messages: KodaXMessage[] = [
    ...history,
    { role: 'user', content: userContent },
  ];

  const runResults: CellRun[] = [];
  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    const startedAt = Date.now();
    try {
      const result = await provider.stream(
        messages as KodaXMessage[],
        variant.tools as KodaXToolDefinition[],
        variant.system,
        undefined,
        { modelOverride: target.model },
      );
      const durationMs = Date.now() - startedAt;
      const text = result.textBlocks.map((b) => b.text).join('').trim();
      const toolCalls = result.toolBlocks.map((b) => ({
        name: b.name,
        input: b.input,
      }));
      const judged = judgeResponse(c, text, toolCalls);
      runResults.push({
        runIndex,
        text,
        toolCalls,
        durationMs,
        regexPassed: judged.passed,
        regexReason: judged.reason,
      });
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      runResults.push({
        runIndex,
        text: '',
        toolCalls: [],
        durationMs,
        regexPassed: false,
        regexReason: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const passCount = runResults.filter((r) => r.regexPassed).length;
  return {
    alias,
    variantId: variant.id,
    caseId: c.id,
    runs: runResults,
    passRate: runResults.length > 0 ? passCount / runResults.length : 0,
  };
}

// ---------------------------------------------------------------------------
// Suite runner.
// ---------------------------------------------------------------------------

interface SuiteFilter {
  readonly variantIds?: ReadonlyArray<VariantSpec['id']>;
  readonly caseIds?: readonly string[];
}

async function runSuite(
  label: string,
  aliases: readonly ModelAlias[],
  runsPerCell: number,
  filter: SuiteFilter = {},
): Promise<{
  cells: readonly CellResult[];
  dumpPath: string;
}> {
  const variants = buildVariants().filter(
    (v) => !filter.variantIds || filter.variantIds.includes(v.id),
  );
  const selectedCases = CASES.filter(
    (c) => !filter.caseIds || filter.caseIds.includes(c.id),
  );
  const cells: CellResult[] = [];

  for (const c of selectedCases) {
    for (const variant of variants) {
      // Skip primed/compacted variants on text-only case — no image to prime against.
      if ((variant.primed || variant.compacted) && !c.imagePath) continue;
      for (const alias of aliases) {
        // eslint-disable-next-line no-console
        console.log(`[${label}] ${alias} × ${variant.id} × ${c.id} × ${runsPerCell}-run starting...`);
        const cell = await runCell(alias, variant, c, runsPerCell);
        cells.push(cell);
        // eslint-disable-next-line no-console
        console.log(
          `[${label}] ${alias} × ${variant.id} × ${c.id} → passRate=${(cell.passRate * 100).toFixed(0)}%`,
        );
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpPath = join(DUMP_ROOT, `${label}-${stamp}.json`);
  writeFileSync(
    dumpPath,
    JSON.stringify(
      {
        label,
        timestamp: new Date().toISOString(),
        cases: CASES.map((c) => ({
          id: c.id,
          imagePath: c.imagePath ?? null,
          mediaType: c.mediaType ?? null,
          userQuestion: c.userQuestion,
          imageContentKeywords: c.imageContentKeywords.map((re) => re.source),
          negativeKeywords: c.negativeKeywords.map((re) => re.source),
          requiresImageContent: c.requiresImageContent,
        })),
        variants: variants.map((v) => ({
          id: v.id,
          systemPromptLength: v.system.length,
          toolsCount: v.tools.length,
        })),
        cells,
      },
      null,
      2,
    ),
    'utf8',
  );
  // eslint-disable-next-line no-console
  console.log(`[${label}] raw dump: ${dumpPath}`);
  return { cells, dumpPath };
}

function summarize(label: string, cells: readonly CellResult[]): string {
  const variantIds = Array.from(new Set(cells.map((c) => c.variantId)));
  const caseIds = Array.from(new Set(cells.map((c) => c.caseId)));
  const aliases = Array.from(new Set(cells.map((c) => c.alias)));

  const lines: string[] = [];
  lines.push(`\n=== ${label} summary ===`);
  for (const caseId of caseIds) {
    lines.push(`\n[case: ${caseId}]`);
    lines.push(
      `${'variant'.padEnd(14)} ${aliases.map((a) => a.padStart(14)).join(' ')}`,
    );
    for (const vid of variantIds) {
      const row = aliases.map((alias) => {
        const cell = cells.find(
          (c) => c.variantId === vid && c.caseId === caseId && c.alias === alias,
        );
        return cell
          ? `${(cell.passRate * 100).toFixed(0).padStart(3)}% (${
              cell.runs.filter((r) => r.regexPassed).length
            }/${cell.runs.length})`.padStart(14)
          : '—'.padStart(14);
      });
      lines.push(`${vid.padEnd(14)} ${row.join(' ')}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

const PILOT_ALIAS: ModelAlias = 'kimi';
const PANEL_ALIASES: readonly ModelAlias[] = ['zhipu/glm52', 'kimi', 'mmx/m3'];

describe('Eval: image vision perception (Fix B regression guard)', () => {
  // Layer 3 pilot — smallest possible call to verify multi-turn priming
  // actually drives the failure mode we are trying to fix. If
  // V_baseline_primed FAILs (denial / tool-reach) and V_fix_primed
  // PASSes, the primed variants are valid eval inputs and we can spend
  // budget on the panel. If both pass, priming isn't the trigger — Fix B
  // is still safe defensive parity but eval cannot demonstrate lift.
  describe('priming-pilot', () => {
    const aliases = availableAliases(PILOT_ALIAS);
    if (aliases.length === 0) {
      it('skips: pilot alias api key missing', () => {});
      return;
    }
    it(
      'kimi × case_diagram × {V_baseline_primed, V_fix_primed} × 1 run = 2 calls',
      { timeout: 10 * 60_000 },
      async () => {
        const { cells } = await runSuite('priming-pilot', aliases, 1, {
          variantIds: ['V_baseline_primed', 'V_fix_primed'],
          caseIds: ['case_diagram'],
        });
        // eslint-disable-next-line no-console
        console.log(summarize('priming-pilot', cells));
        expect(cells.length).toBe(2);
      },
    );
  });

  // Compaction-state trigger: image was replaced with a text marker
  // (per microcompaction.ts:106-110 after maxAge=20 turns) AND assistant
  // tried a read tool that errored. The current turn re-attaches the
  // real image. This is the EXACT scenario Fix B's third bullet addresses.
  // 2026-05-19 finding: zhipu under V_baseline_compacted emits
  // NO_IMAGE_PERCEIVED (honest refusal); under V_fix_compacted it
  // hallucinated SVG content for an unrelated image. Tightened regex
  // (requires imageContentKeyword match) catches the hallucination.
  describe('compaction-pilot', () => {
    const aliases = availableAliases('kimi', 'zhipu/glm52');
    if (aliases.length === 0) {
      it('skips: no compaction-pilot alias api keys present', () => {});
      return;
    }
    it(
      `${aliases.length} alias × {case_diagram, case_counter} × {V_baseline_compacted, V_fix_compacted} × 3 runs`,
      { timeout: 30 * 60_000 },
      async () => {
        const { cells } = await runSuite('compaction-pilot', aliases, 3, {
          variantIds: ['V_baseline_compacted', 'V_fix_compacted'],
          caseIds: ['case_diagram', 'case_counter'],
        });
        // eslint-disable-next-line no-console
        console.log(summarize('compaction-pilot', cells));
        expect(cells.length).toBe(aliases.length * 2 * 2);
      },
    );
  });

  describe('pilot', () => {
    const aliases = availableAliases(PILOT_ALIAS);
    if (aliases.length === 0) {
      it('skips: pilot alias api key missing', () => {});
      return;
    }
    it(
      'kimi × 3 cases × 4 variants × 1 run',
      { timeout: 30 * 60_000 },
      async () => {
        const { cells } = await runSuite('pilot', aliases, 1);
        // eslint-disable-next-line no-console
        console.log(summarize('pilot', cells));
        expect(cells.length).toBeGreaterThan(0);
      },
    );
  });

  describe('panel', () => {
    const aliases = availableAliases(...PANEL_ALIASES);
    if (aliases.length === 0) {
      it('skips: no panel alias api keys present', () => {});
      return;
    }
    it(
      `4 variants × 3 cases (primed skip text_only) × ${aliases.length}-alias × 3 runs/cell`,
      { timeout: 120 * 60_000 },
      async () => {
        const { cells, dumpPath } = await runSuite('panel', aliases, 3);
        // eslint-disable-next-line no-console
        console.log(summarize('panel', cells));
        // eslint-disable-next-line no-console
        console.log(`\nFull raw dump at: ${dumpPath}`);
        // eslint-disable-next-line no-console
        console.log(
          'Run self-judge audit (orchestrating Claude) on the dump per EVAL_GUIDELINES §Judge before treating regex pass-rate as decision input.',
        );
        expect(cells.length).toBeGreaterThan(0);
      },
    );
  });
});
