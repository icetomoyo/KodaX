/**
 * Cells for the history-recall description eval (benchmark/history-recall.eval.ts). One synthetic session,
 * compacted by the production compactor; each cell asks one question after the compaction.
 * Recall cells need an exact detail that only the compacted history holds. Control cells can be answered
 * from what is still in context, so a history search there is wasted work.
 */
import type { KodaXMessage } from '@kodax-ai/llm';

const call = (id: string, name: string, input: Record<string, unknown>): KodaXMessage => ({
  role: 'assistant', content: [{ type: 'tool_use', id, name, input }],
});
const result = (id: string, content: string): KodaXMessage => ({
  role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }],
});
const say = (role: 'user' | 'assistant', content: string): KodaXMessage => ({ role, content });

/** A long, realistic tool output, so the compacted part outweighs the kept tail. */
const settlementSource = Array.from({ length: 160 }, (_, i) => (
  `  ${String(i + 1).padStart(3)}  export function settleBatch${i}(batch: Batch): Settlement { return applyFees(batch, FEE_TABLE[${i % 7}]); }`
)).join('\n');

/** The migration error sits mid-output, so the bash tail the artifact ledger keeps does not contain it. */
const migrationOutput = [
  '> ledgerd@4.2.0 migrate',
  '> node scripts/migrate.js --env staging',
  'Applying 0041_add_payout_currency ... ok (412 ms)',
  'Applying 0042_add_settlement_index ...',
  'ERROR: migration 0042_add_settlement_index failed: duplicate key value violates unique constraint "settlements_ref_uniq" (SQLSTATE 23505) at row 18231',
  'Rolling back 0042_add_settlement_index ... ok',
  ...Array.from({ length: 12 }, (_, i) => `  cleanup: released advisory lock ${9100 + i} on shard ${i % 4}`),
  'Migration run finished with 1 failure. See above.',
].join('\n');

const deployOutput = (code: string, detail: string) => [
  'Building image ledgerd:staging ... done',
  'Pushing to registry.internal/pay/ledgerd ... done',
  `DEPLOY FAILED: ${code} ${detail}`,
  ...Array.from({ length: 10 }, (_, i) => `  rollout: pod ledgerd-${i} terminated, restoring previous ReplicaSet`),
  'Previous ReplicaSet restored. Exit status 1.',
].join('\n');

/** The part the compactor summarizes away. */
export const COMPACTED_HISTORY: KodaXMessage[] = [
  say('user', 'We are moving ledgerd to the new cluster this week. Start with staging: run the migrations, then deploy.'),
  call('b1', 'bash', { command: 'npm run migrate -- --env staging' }),
  result('b1', migrationOutput),
  say('assistant', 'Migration 0042 failed on a duplicate settlement reference. I will dedupe the rows and retry.'),
  call('b2', 'bash', { command: 'node scripts/dedupe-settlements.js --env staging && npm run migrate -- --env staging' }),
  result('b2', 'Removed 3 duplicate settlement rows.\nApplying 0042_add_settlement_index ... ok (8.1 s)\nMigration run finished with 0 failures.'),
  call('d1', 'bash', { command: './deploy.sh staging' }),
  result('d1', deployOutput('E-HEALTH-503', 'readiness probe on /healthz timed out after 90s')),
  say('assistant', 'The first deploy failed its readiness probe. Raising the probe timeout and retrying.'),
  call('d2', 'bash', { command: './deploy.sh staging' }),
  result('d2', deployOutput('E-IMG-401', 'registry auth token expired for registry.internal')),
  say('assistant', 'The registry token expired. Refreshing credentials and retrying.'),
  call('d3', 'bash', { command: 'kodax-cred refresh registry.internal && ./deploy.sh staging' }),
  result('d3', deployOutput('E-HEALTH-503', 'readiness probe on /healthz timed out after 90s')),
  say('assistant', 'The probe failed again: the new pods wait on a cold cache. Adding a warm-up step and retrying.'),
  call('d4', 'bash', { command: './deploy.sh staging' }),
  result('d4', 'Building image ledgerd:staging ... done\nRollout complete: 6/6 pods ready.\nDEPLOY OK'),
  say('assistant', 'Staging is deployed after three failed attempts. Checking the settlement module for environment-specific settings before production.'),
  call('r1', 'read', { path: 'src/settlement/batch.ts' }),
  result('r1', settlementSource),
  say('assistant', 'The settlement module has no environment-specific settings.'),
];

/** The verbatim tail the compactor keeps. */
export const KEPT_TAIL: KodaXMessage[] = [
  say('user', 'Good. Now get production ready, but do not deploy yet.'),
  call('r2', 'read', { path: 'deploy/values-prod.yaml' }),
  result('r2', 'replicas: 9\nimage: registry.internal/pay/ledgerd:2026.11.20-rc3\nreadiness:\n  timeoutSeconds: 150\nwarmup:\n  enabled: true'),
  say('assistant', 'The production values already have the longer probe timeout and the warm-up step. Production is ready for a deploy when you say so.'),
];

/** The summary a model writes for the compacted part: a faithful paraphrase that drops exact details. */
export const SUMMARY = [
  '## Goal',
  'Move ledgerd to the new cluster: staging first, then production.',
  '',
  '## Progress',
  '### Completed',
  '- [x] Read the settlement module (src/settlement/batch.ts).',
  '- [x] Staging migrations: one migration failed on duplicate settlement references; deduped the rows and it passed.',
  '- [x] Staging deploy succeeded after several failed attempts (readiness probe timeouts and an expired registry token).',
  '',
  '## Key Decisions',
  '- Raised the readiness probe timeout and added a cache warm-up step.',
  '',
  '## Next Steps',
  '1. Prepare production; do not deploy until the user says so.',
].join('\n');

export interface RecallCell {
  readonly name: string;
  readonly kind: 'recall' | 'control';
  readonly question: string;
  /** Strings the answer needs. Recall cells: none may be in context. Control cells: all must be. */
  readonly facts: readonly string[];
}

export const CELLS: readonly RecallCell[] = [
  {
    name: 'recall_error_text',
    kind: 'recall',
    question: 'Paste the exact error line the failed staging migration printed. I need it verbatim for the incident ticket.',
    facts: ['settlements_ref_uniq', '23505', 'row 18231'],
  },
  {
    name: 'recall_count',
    kind: 'recall',
    question: 'For the postmortem: list each failed staging deploy attempt in order, with the exact error code it showed.',
    facts: ['E-HEALTH-503', 'E-IMG-401'],
  },
  {
    name: 'control_tail',
    kind: 'control',
    question: 'How many replicas will production run with, per the values file?',
    facts: ['replicas: 9'],
  },
  {
    name: 'control_summary',
    kind: 'control',
    question: 'Quick check before I go: what is left to do?',
    facts: ['do not deploy'],
  },
];
