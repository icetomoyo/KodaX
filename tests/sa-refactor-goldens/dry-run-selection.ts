#!/usr/bin/env node
/**
 * SA Refactor Goldens — Selection Dry-Run
 *
 * Runs the selection algorithm against a sessions directory and prints the
 * SelectionReport to stdout. Pure read — does NOT touch any provider or
 * write any goldens. Use this to:
 *
 *   1. Validate that the on-disk session corpus has enough variety to satisfy
 *      mandatory-capability coverage (the report's `detectorCoverage` shows
 *      which CAPs are at risk of going unrecorded).
 *   2. Eyeball the chosen sample before committing to a real recording run
 *      (which requires API keys and costs money).
 *
 * Usage:
 *   tsx tests/sa-refactor-goldens/dry-run-selection.ts [sessionsDir]
 *
 * Default sessionsDir: ~/.kodax/sessions/
 */

import path from 'node:path';
import os from 'node:os';

import { listSessionFiles, parseSessionFile } from './session-parser.js';
import { selectSessions } from './selection.js';

async function main(): Promise<void> {
  const sessionsDir = process.argv[2] ?? path.join(os.homedir(), '.kodax', 'sessions');

  console.log(`scanning sessions in: ${sessionsDir}`);
  const files = await listSessionFiles(sessionsDir);
  console.log(`found ${files.length} jsonl file(s)`);

  const sessions = await Promise.all(files.map(parseSessionFile));

  const formatCounts = sessions.reduce<Record<string, number>>((acc, s) => {
    acc[s.metadata.format] = (acc[s.metadata.format] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`format distribution: ${JSON.stringify(formatCounts)}`);

  const report = selectSessions(sessions);

  console.log('\n=== Selection report ===');
  console.log(`total candidates: ${report.totalCandidates}`);
  console.log(`selected:         ${report.selected.length}`);
  console.log(`bucket coverage:  ${JSON.stringify(report.bucketCoverage)}`);
  console.log(`family coverage:  ${JSON.stringify(report.familyCoverage)}`);
  console.log('detector coverage:');
  for (const [name, c] of Object.entries(report.detectorCoverage)) {
    const flag = c.totalInCorpus === 0 ? '[CORPUS-MISS]' : c.selected === 0 ? '[NOT-PICKED]' : '';
    console.log(`  ${name.padEnd(20)} corpus=${String(c.totalInCorpus).padStart(4)}  selected=${String(c.selected).padStart(2)}  ${flag}`);
  }

  if (report.warnings.length > 0) {
    console.log('\nwarnings:');
    for (const w of report.warnings) console.log(`  - ${w}`);
  } else {
    console.log('\n(no warnings)');
  }

  console.log('\n=== Selected sessions ===');
  for (const s of report.selected) {
    const detectors = s.matchedDetectors.length > 0 ? ` [${s.matchedDetectors.join(',')}]` : '';
    console.log(`  ${s.sessionId.padEnd(24)} ${s.bucket.padEnd(7)} ${s.family.padEnd(15)}${detectors}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
