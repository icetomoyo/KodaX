#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPTIONAL_FOLLOWUP_RULE =
  'If the current request is already satisfied and the final text merely offers optional follow-up or additional work, choose `accept` even when that offer is phrased as a question.';
const REQUIRED_CLARIFICATION_RULE =
  'A clarifying question is `blocked` only when the user must answer it before the current request can be satisfied.';
const VERIFIER_PROMPT_ANCHOR =
  'You are a verification sidecar for an autonomous coding agent.';
const BUDGET_SUMMARY_ANCHOR =
  'Sidecar verifier requested another pass';
const BUDGET_NOTIFY_CALL = 'notifyBudgetApprovalRequest()';
const MAX_TAR_OUTPUT_BYTES = 128 * 1024 * 1024;

function runTar(args) {
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    maxBuffer: MAX_TAR_OUTPUT_BYTES,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `tar ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
    );
  }
  return result.stdout;
}

function occurrenceIndexes(source, needle) {
  const indexes = [];
  let cursor = 0;
  while (cursor < source.length) {
    const found = source.indexOf(needle, cursor);
    if (found < 0) break;
    indexes.push(found);
    cursor = found + needle.length;
  }
  return indexes;
}

function assertBudgetGuard(entry, source) {
  for (const summaryIndex of occurrenceIndexes(source, BUDGET_SUMMARY_ANCHOR)) {
    const before = source.slice(Math.max(0, summaryIndex - 2_000), summaryIndex);
    const notifyIndex = before.lastIndexOf(BUDGET_NOTIFY_CALL);
    if (notifyIndex < 0) {
      throw new Error(`${entry}: budget summary is not preceded by ${BUDGET_NOTIFY_CALL}`);
    }
    const guardStart = before.lastIndexOf('if(', notifyIndex);
    const guard = before.slice(Math.max(0, guardStart), notifyIndex);
    if (!/\.verdict\s*===\s*["']revise["']/.test(guard)) {
      throw new Error(`${entry}: budget approval notification is not guarded by verdict === revise`);
    }
    if (!/\.events\s*,/.test(guard)) {
      throw new Error(`${entry}: budget approval notification is not guarded by budget eligibility`);
    }
  }
}

export function auditSidecarTarball(tarballPath, options = {}) {
  const absoluteTarball = resolve(tarballPath);
  if (!existsSync(absoluteTarball)) {
    throw new Error(`Tarball does not exist: ${absoluteTarball}`);
  }

  // Windows bsdtar parses any `X:` prefix as a remote `host:path` spec, so an
  // absolute drive path (`C:\...` or `C:/...`) fails with "Cannot connect".
  // A cwd-relative path carries no colon and works on every tar flavor; the
  // cross-drive absolute fallback only applies when the tarball lives on a
  // different drive than the process cwd.
  const cwdRelative = relative(process.cwd(), absoluteTarball);
  const tarPath = cwdRelative.includes(':')
    ? absoluteTarball.replaceAll('\\', '/')
    : cwdRelative;
  const archiveEntries = runTar(['-tf', tarPath]).split(/\r?\n/);
  for (const required of options.requiredEntries ?? []) {
    if (!archiveEntries.includes(required)) {
      throw new Error(`Tarball is missing required entry: ${required}`);
    }
  }
  const entries = archiveEntries.filter(
    (entry) => entry.startsWith('package/dist/') && entry.endsWith('.js'),
  );
  if (entries.length === 0) {
    throw new Error('Tarball contains no package/dist/*.js bundle entries');
  }

  const verifierPromptEntries = [];
  const budgetBridgeEntries = [];
  for (const entry of entries) {
    const source = runTar(['-xOf', tarPath, entry]);
    if (source.includes(VERIFIER_PROMPT_ANCHOR)) {
      verifierPromptEntries.push(entry);
      if (!source.includes(OPTIONAL_FOLLOWUP_RULE)) {
        throw new Error(`${entry}: optional follow-up accept rule is missing`);
      }
      if (!source.includes(REQUIRED_CLARIFICATION_RULE)) {
        throw new Error(`${entry}: required-clarification blocked rule is missing`);
      }
    }
    if (source.includes(BUDGET_SUMMARY_ANCHOR)) {
      budgetBridgeEntries.push(entry);
      assertBudgetGuard(entry, source);
    }
  }

  if (verifierPromptEntries.length === 0) {
    throw new Error('No bundled Sidecar verifier prompt was found');
  }
  if (budgetBridgeEntries.length === 0) {
    throw new Error('No bundled Sidecar budget bridge was found');
  }

  return {
    tarball: absoluteTarball,
    verifierPromptEntries,
    budgetBridgeEntries,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const tarballPath = process.argv[2];
    if (!tarballPath) {
      throw new Error('Usage: node scripts/audit-sidecar-tarball.mjs <package.tgz>');
    }
    const result = auditSidecarTarball(tarballPath);
    process.stdout.write(
      `Sidecar tarball audit passed: ${result.verifierPromptEntries.length} prompt bundle(s), `
      + `${result.budgetBridgeEntries.length} budget bridge bundle(s).\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[sidecar-tarball-audit] ${message}\n`);
    process.exitCode = 1;
  }
}
