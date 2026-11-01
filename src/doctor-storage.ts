import fs from 'node:fs';
import path from 'node:path';

function code(error: unknown): string {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'unavailable';
}

/** Read-only syntax probe. Never include parser excerpts: they can contain credentials. */
export function inspectDoctorCoreConfig(home: string) {
  const file = path.join(home, 'config.json');
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { return { path: file, state: code(error) === 'ENOENT' ? 'missing' : 'unreadable', code: code(error) }; }
  try {
    const value: unknown = JSON.parse(raw);
    return { path: file, state: value && typeof value === 'object' && !Array.isArray(value) ? 'valid-json-object' : 'invalid' };
  } catch (error) {
    const position = error instanceof SyntaxError ? / at position (\d+)(?: \(line \d+ column \d+\))?$/u.exec(error.message) : null;
    return { path: file, state: 'invalid', ...(position ? { offset: Number(position[1]) } : {}),
      reason: 'Invalid JSON; retain the original file and repair its syntax before execution or writes.' };
  }
}

/** Syntax only: a parseable record never proves owner liveness or permission to reclaim. */
function inspectLockRecord(file: string): { record: string; code?: string } {
  let handle: number | undefined;
  try {
    const entry = fs.lstatSync(file);
    if (entry.isSymbolicLink()) return { record: 'alias' };
    if (!entry.isFile()) return { record: 'not-file' };
    handle = fs.openSync(file, 'r');
    const opened = fs.fstatSync(handle);
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || !opened.isFile()) return { record: 'changed' };
    const maximum = 64 * 1024;
    if (opened.size > maximum) return { record: 'too-large' };
    const buffer = Buffer.alloc(maximum + 1);
    const count = fs.readSync(handle, buffer, 0, buffer.length, 0);
    if (count > maximum) return { record: 'too-large' };
    if (count === 0) return { record: 'empty' };
    try {
      const value: unknown = JSON.parse(buffer.toString('utf8', 0, count));
      return { record: value !== null && typeof value === 'object' && !Array.isArray(value) ? 'json-object' : 'invalid-shape' };
    } catch { return { record: 'invalid-json' }; }
  } catch (error) { return { record: code(error) === 'ENOENT' ? 'missing' : 'unreadable', code: code(error) }; }
  finally { if (handle !== undefined) fs.closeSync(handle); }
}

/** Inventory only known lock locations, without opening credentials or following directory aliases. */
export function inspectDoctorLocks(home: string) {
  const items: { path: string; state: 'present' | 'alias' | 'unreadable'; code?: string;
    kind?: 'lock' | 'reclamation-claim'; ownership?: 'unverified'; record?: string; recordPath?: string }[] = [];
  const issues: { path: string; code: string }[] = [];
  const inspect = (file: string): void => {
    try {
      const entry = fs.lstatSync(file);
      if (entry.isSymbolicLink()) { items.push({ path: file, state: 'alias' }); return; }
      const recordPath = entry.isDirectory() ? path.join(file, 'owner.json') : file;
      items.push({ path: file, state: 'present', kind: path.basename(file).includes('.reclaim.') ? 'reclamation-claim' : 'lock',
        ownership: 'unverified', recordPath, ...inspectLockRecord(recordPath) });
    }
    catch (error) { if (code(error) !== 'ENOENT') items.push({ path: file, state: 'unreadable', code: code(error) }); }
  };
  const entries = (directory: string): fs.Dirent[] => {
    try {
      let current = home;
      for (const part of ['', ...path.relative(home, directory).split(path.sep).filter(Boolean)]) {
        if (part) current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) {
          if (!items.some(item => item.path === current)) inspect(current);
          return [];
        }
      }
      return fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) { if (code(error) !== 'ENOENT') issues.push({ path: directory, code: code(error) }); return []; }
  };
  const scan = (directory: string): void => {
    for (const entry of entries(directory)) {
      if (entry.name.endsWith('.lock') || entry.name === '.migration-lock' || entry.name.includes('.reclaim.')) inspect(path.join(directory, entry.name));
    }
  };
  scan(home);
  scan(path.join(home, 'integrations'));
  scan(path.join(home, 'provider-oauth'));
  const sessions = path.join(home, 'sessions');
  scan(sessions);
  scan(path.join(sessions, '.write-locks'));
  scan(path.join(sessions, '.product-host'));
  const daemon = path.join(home, 'runtime', 'daemon');
  for (const entry of entries(daemon)) {
    if (entry.isDirectory()) scan(path.join(daemon, entry.name));
    else if (entry.isSymbolicLink()) inspect(path.join(daemon, entry.name));
  }
  return { items, issues,
    recovery: 'Presence does not prove abandonment. Stop every CLI, Host and SDK writer sharing this storage before offline repair. Back up storage and quarantine only the exact diagnosed lock and its reclamation claims; preserve config, auth, sessions and journals. Unknown or live ownership must never be reclaimed by age alone.',
    scope: 'Default config-home locations only; SDK sessionsDir and credential-store overrides require the same separate offline inspection.' };
}
