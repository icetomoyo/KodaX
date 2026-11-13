/**
 * FEATURE_308 Phase 0 r2, Layer 1 ($0, no provider calls): does the CURRENT
 * memory pack surface the one relevant note when the store also holds
 * distractors? Phase 0 r1 seeded 1-2 notes, so ranking was never exercised.
 *
 *   vite-node -c vitest.config.ts benchmark/datasets/feature-308-baseline/retrieval-probe.ts
 *
 * Observation is what the model sees: `promptHints` (max 5, title-only hooks).
 */
import { seedStore } from './inputs.js';
import { scaleDistractorSeeds, type MemorySeed } from './cases.js';

interface Probe {
  readonly id: string;
  readonly kind: 'lexical' | 'paraphrase';
  readonly target: MemorySeed;
  readonly query: string;
  readonly decisive: string;
}

const PROBES: readonly Probe[] = [
  {
    id: 'zh-lexical',
    kind: 'lexical',
    target: { statement: '运行测试一律使用 `just test-fast`,不要直接跑 pytest(会漏掉集成夹具)。', claimKind: 'preference', claimKey: 'test-command-zh' },
    query: '好的,现在跑一下测试确认修复。',
    decisive: 'just test-fast',
  },
  {
    id: 'en-lexical',
    kind: 'lexical',
    target: { statement: 'Tests: run `make check-fast`, never bare `npm test` (it skips the integration setup).', claimKind: 'preference', claimKey: 'test-command' },
    query: 'Good. Now run the tests to confirm the fix.',
    decisive: 'make check-fast',
  },
  {
    id: 'en-generated',
    kind: 'lexical',
    target: { statement: 'src/generated/schema.ts is generated from schema.graphql by `npm run gen:schema`; never hand-edit it, change the .graphql and regenerate.', claimKind: 'policy', claimKey: 'generated-schema' },
    query: 'Add a `nickname: string | null` field to the `User` type.',
    decisive: 'npm run gen:schema',
  },
  {
    id: 'en-paraphrase',
    kind: 'paraphrase',
    target: { statement: 'Deploys: run `./scripts/ship.sh`; never push to the release branch by hand.', claimKind: 'policy', claimKey: 'deploy-procedure' },
    query: "Let's get this change out to production today.",
    decisive: './scripts/ship.sh',
  },
  {
    id: 'zh-paraphrase',
    kind: 'paraphrase',
    target: { statement: '数据库迁移必须通过 `bun run migrate` 执行,不要手写 SQL 直接改表。', claimKind: 'policy', claimKey: 'db-migration-zh' },
    query: '给用户表再加一列 phone,帮我处理一下。',
    decisive: 'bun run migrate',
  },
];

const SCALES = [1, 10, 40] as const;

interface Row {
  readonly probe: string;
  readonly kind: string;
  readonly storeSize: number;
  readonly surfaced: boolean;
  readonly decisiveInHook: boolean;
  readonly rankInHints: number | null;
  readonly inCandidates: boolean;
  readonly hintCount: number;
}

async function probeOnce(probe: Probe, scale: number): Promise<Row> {
  const distractors = scaleDistractorSeeds(scale - 1);
  const store = await seedStore(`probe-${probe.id}-${scale}`, [...distractors, probe.target]);
  const pack = await store.controller.buildMemoryPack({
    task: probe.query,
    identity: store.identity,
    maxCandidates: 12,
    maxHints: 5,
    includeSnippets: false,
  });
  const rank = pack.promptHints.findIndex((hint) => hint.hook.includes(probe.decisive));
  const inTitle = pack.promptHints.some((hint) => hint.hook.includes(probe.decisive));
  const first = probe.target.statement.slice(0, 12);
  const surfaced = rank >= 0 || pack.promptHints.some((hint) => hint.hook.includes(first));
  const candidateHit = pack.candidates.some((hint) => hint.hook.includes(first) || hint.hook.includes(probe.decisive));
  return {
    probe: probe.id,
    kind: probe.kind,
    storeSize: scale,
    surfaced,
    decisiveInHook: inTitle,
    rankInHints: rank >= 0 ? rank + 1 : null,
    inCandidates: candidateHit,
    hintCount: pack.promptHints.length,
  };
}

async function main(): Promise<void> {
  const rows: Row[] = [];
  for (const probe of PROBES) {
    for (const scale of SCALES) rows.push(await probeOnce(probe, scale));
  }
  process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`);
}

if (process.env.VITEST === undefined) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
