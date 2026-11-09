/**
 * Eval: FEATURE_131-B Unicode-normalized fallback — realistic dataset regression (v0.7.36).
 *
 * ## Why this exists
 *
 * The unit tests in `packages/coding/src/tools/text-anchor.test.ts` and
 * `edit-unicode-normalize.test.ts` cover **individual character mappings**
 * (em-dash → `--`, smart-quote → ASCII, NFKC, nbsp → space, etc.). What
 * they DON'T cover is realistic **combined drift** — the way the LLM
 * actually emits needles in production: comments paste-mixed from web
 * docs (smart quotes + nbsp), docstrings with em-dash next to ASCII
 * hyphens, full-width punctuation around code blocks.
 *
 * This eval is a **dataset regression** that ships representative
 * needle/haystack pairs reconstructed from real LLM outputs we've
 * observed during v0.7.34-v0.7.35 silent-edit-fail incidents. Each
 * case asserts:
 *
 *   1. Byte-exact match `findUniqueNormalizedBlockMatch` MISSES (proves
 *      this isn't already covered by the legacy fallback path), AND
 *   2. Unicode-normalized fallback `findUniqueUnicodeNormalizedBlockMatch`
 *      finds a UNIQUE match.
 *
 * Cases that should NOT match (true negatives) are also pinned so the
 * normalization doesn't degenerate into "match anything close".
 *
 * Behavioral validation against true LLM rollouts (e.g. running
 * Anthropic/OpenAI/DeepSeek and counting silent-edit-fail rate before vs
 * after FEATURE_131-B) requires multi-provider keys + budget and is
 * tracked in `docs/features/v0.7.37.md` § "FEATURE_131-B follow-up".
 *
 * ## Run
 *
 *   npx vitest run -c tests/config/vitest.eval.config.ts tests/feature-131-unicode-dataset-regression.eval.ts
 */

import { describe, expect, it } from 'vitest';

import {
  findUniqueNormalizedBlockMatch,
  findUniqueUnicodeNormalizedBlockMatch,
} from '../packages/coding/src/tools/text-anchor.js';

interface DatasetCase {
  name: string;
  haystack: string;
  needle: string;
  // What we expect from the byte-exact normalized fallback (legacy):
  legacy: 'unique' | 'missing' | 'ambiguous';
  // What we expect from the Unicode-normalized fallback (FEATURE_131-B):
  unicode: 'unique' | 'missing' | 'ambiguous';
}

const POSITIVE_CASES: DatasetCase[] = [
  {
    name: 'smart double quotes around comment (LLM web-doc paste)',
    haystack: `function authenticate(user) {\n  // "user" must be non-empty\n  if (!user) throw new Error('empty');\n}\n`,
    needle: `  // “user” must be non-empty\n`,
    legacy: 'missing',
    unicode: 'unique',
  },
  {
    name: 'smart single quotes inside docstring',
    haystack: `// Don't pass null here\nconst x = 1;\n`,
    needle: `// Don’t pass null here\n`,
    legacy: 'missing',
    unicode: 'unique',
  },
  {
    name: 'em-dash where file has --',
    haystack: `const greet = (name) => \`hi -- \${name}\`;\n`,
    needle: `const greet = (name) => \`hi — \${name}\`;\n`,
    legacy: 'missing',
    unicode: 'unique',
  },
  {
    name: 'en-dash where file has -',
    haystack: `// range: 1-10\nfor (let i = 1; i <= 10; i++) {}\n`,
    needle: `// range: 1–10\n`,
    legacy: 'missing',
    unicode: 'unique',
  },
  {
    name: 'non-breaking space (U+00A0) inside comment text',
    haystack: `// TODO: refactor this branch\nreturn x + 1;\n`,
    needle: `// TODO: refactor this branch\n`,
    legacy: 'missing',
    unicode: 'unique',
  },
  {
    name: 'ideographic space (U+3000) where file has ASCII space',
    haystack: `function foo() {\n  return 1;\n}\n`,
    needle: `function　foo() {\n`,
    legacy: 'missing',
    unicode: 'unique',
  },
  {
    name: 'full-width Latin via NFKC (LLM CJK locale rendering)',
    haystack: `const PORT = 3000;\n`,
    needle: `const ＰＯＲＴ = 3000;\n`, // U+FF30… — full-width PORT
    legacy: 'missing',
    unicode: 'unique',
  },
  {
    name: 'combined smart quotes + em-dash + nbsp (the real-world cocktail)',
    haystack: `// "kodax" -- the lightweight coding agent. See docs.\nexport default 1;\n`,
    needle: `// “kodax” — the lightweight coding agent. See docs.\n`,
    legacy: 'missing',
    unicode: 'unique',
  },
  {
    name: 'multi-line block with mixed artifacts',
    haystack: `function compute(x) {\n  // returns x ** 2 -- never null\n  if (x == null) return 0;\n  return x * x;\n}\n`,
    needle: `function compute(x) {\n  // returns x ** 2 — never null\n  if (x == null) return 0;\n`,
    legacy: 'missing',
    unicode: 'unique',
  },
];

const NEGATIVE_CASES: DatasetCase[] = [
  {
    name: 'genuinely-not-present needle (must NOT match — guards against over-broad normalization)',
    haystack: `const a = 1;\nconst b = 2;\n`,
    needle: `const c = 3;\n`,
    legacy: 'missing',
    unicode: 'missing',
  },
  {
    name: 'different identifier case (NFKC does NOT lowercase — must NOT match)',
    haystack: `const PORT = 3000;\n`,
    needle: `const port = 3000;\n`,
    legacy: 'missing',
    unicode: 'missing',
  },
  {
    name: 'identical bytes — Unicode fallback path should still find it (defense-in-depth)',
    haystack: `const x = 1;\n`,
    needle: `const x = 1;\n`,
    legacy: 'unique',
    unicode: 'unique',
  },
];

const ALL_CASES: DatasetCase[] = [...POSITIVE_CASES, ...NEGATIVE_CASES];

describe('FEATURE_131-B — Unicode-normalized fallback (realistic dataset regression)', () => {
  it.each(ALL_CASES)('$name', ({ haystack, needle, legacy, unicode }) => {
    const legacyResult = findUniqueNormalizedBlockMatch(haystack, needle);
    expect(
      legacyResult.status,
      `legacy byte-exact normalized fallback should report status=${legacy}`,
    ).toBe(legacy);

    const unicodeResult = findUniqueUnicodeNormalizedBlockMatch(haystack, needle);
    expect(
      unicodeResult.status,
      `Unicode-normalized fallback should report status=${unicode}`,
    ).toBe(unicode);
  });

  it('coverage summary — every positive case must move legacy=missing → unicode=unique', () => {
    for (const c of POSITIVE_CASES) {
      expect(c.legacy, `${c.name}: positive case must be legacy=missing`).toBe('missing');
      expect(c.unicode, `${c.name}: positive case must be unicode=unique`).toBe('unique');
    }
  });

  it('coverage summary — at least one negative case ensures normalization is not over-broad', () => {
    const trueNegatives = NEGATIVE_CASES.filter((c) => c.unicode === 'missing');
    expect(
      trueNegatives.length,
      'must have ≥1 true-negative to guard against over-broad normalization',
    ).toBeGreaterThanOrEqual(2);
  });
});
