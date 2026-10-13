import type { EvidenceLocator, VisualEvidenceBatch, VisualRequirement } from './types.js';
import { validateRaster, validateSource } from './contract.js';
import { sameSource } from './identity.js';

function validLocator(locator: EvidenceLocator): boolean {
 switch (locator.kind) {
  case 'static': return !locator.region || (locator.region.length === 4 && locator.region.every(Number.isFinite) && locator.region[2] > 0 && locator.region[3] > 0);
  case 'paginated': return Number.isInteger(locator.page) && locator.page > 0;
  case 'interactive': return !!locator.target && !!locator.state && locator.viewport.length === 2 && locator.viewport.every(value => Number.isFinite(value) && value > 0) && Number.isInteger(locator.sequence) && locator.sequence >= 0;
  case 'temporal': return Number.isFinite(locator.time) && locator.time >= 0 && (locator.frame === undefined || (Number.isInteger(locator.frame) && locator.frame >= 0));
 }
}
function matches(actual: EvidenceLocator, required: EvidenceLocator): boolean {
 if (!validLocator(required) || actual.kind !== required.kind) return false;
 switch (required.kind) {
  case 'static': return actual.kind === 'static' && JSON.stringify(actual.region) === JSON.stringify(required.region);
  case 'paginated': return actual.kind === 'paginated' && actual.page === required.page && (required.sheet === undefined || actual.sheet === required.sheet) && (required.range === undefined || actual.range === required.range);
  case 'interactive': return actual.kind === 'interactive' && actual.target === required.target && actual.state === required.state && actual.sequence === required.sequence && actual.camera === required.camera && JSON.stringify(actual.viewport) === JSON.stringify(required.viewport);
  case 'temporal': return actual.kind === 'temporal' && actual.time === required.time && (required.frame === undefined || actual.frame === required.frame);
 }
}

/** Mechanical coverage/readiness only; it never returns a visual pass verdict. */
export function validateVisualEvidence(batch: VisualEvidenceBatch, required: VisualRequirement): { status: 'ready' | 'unverified'; missing: readonly string[] } {
 const missing: string[] = [];
 let sourceValid = true;
 try { validateSource(required.source); validateSource(batch.source); }
 catch { missing.push('invalid-source'); sourceValid = false; }
 if (sourceValid && !sameSource(batch.source, required.source)) missing.push('stale-source');
 if (batch.kind !== required.kind) missing.push('wrong-evidence-kind');
 if (required.background !== undefined && batch.background !== required.background) missing.push('wrong-background');
 if (batch.diagnostics.some(item => item.blocking)) missing.push('blocking-diagnostic');
 const valid = batch.evidence.filter(item => { try { validateRaster(item); } catch { return false; } return item.locator.kind === required.kind && validLocator(item.locator); });
 if (valid.length === 0) missing.push('no-raster');
 for (const [index, locator] of (required.locators ?? []).entries()) {
  if (locator.kind !== required.kind || !valid.some(item => matches(item.locator, locator))) missing.push('locator:' + index);
 }
 if (required.kind === 'paginated') for (const page of required.pages ?? []) {
   if (!Number.isInteger(page) || page < 1) missing.push('invalid-page');
   if (!valid.some(item => item.locator.kind === 'paginated' && item.locator.page === page)) missing.push('page:' + page);
 }
 if (required.kind === 'interactive') for (const state of required.states ?? []) {
   if (!valid.some(item => item.locator.kind === 'interactive' && item.locator.target === required.target && item.locator.state === state)) missing.push('state:' + state);
 }
 if (required.kind === 'interactive' && !required.locators?.length && (!required.target || !required.states?.length)) missing.push('interactive-scope-required');
 if (required.kind === 'temporal' && !required.locators?.length && !required.times?.length) missing.push('temporal-scope-required');
 if (required.temporal) {
  const requested = required.temporal, captured = batch.scope.temporal;
  // Raster samples cannot attest continuous playback, even if an adapter labels them so.
  if (required.kind !== 'temporal' || requested.coverage === 'continuous' || !captured || !Number.isFinite(captured.start) || !Number.isFinite(captured.end) || !Number.isFinite(requested.start) || !Number.isFinite(requested.end) || requested.start < 0 || requested.end < requested.start || captured.start > requested.start || captured.end < requested.end || captured.coverage !== 'sampled') missing.push('temporal-range');
 }
 if (required.kind === 'temporal') for (const time of required.times ?? []) {
   if (!Number.isFinite(time) || time < 0) missing.push('invalid-time');
   if (!valid.some(item => item.locator.kind === 'temporal' && item.locator.time === time)) missing.push('time:' + time);
 }
 return { status: missing.length ? 'unverified' : 'ready', missing };
}
