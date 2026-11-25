/**
 * A stand-in for the native RepoIntel engine in supervisor tests. It speaks
 * the same Content-Length framed JSON-RPC over stdio, and appends every
 * message it receives to the journal file named by `--journal`, so a test can
 * see what the Host sent. Flags make it misbehave the way a real engine might:
 *   --rss <bytes>      report this resident size from engine.status
 *   --hang-status      never answer engine.status
 *   --exit-after-open  exit with code 3 after answering the first workspace.open
 *   --fail-initialize  answer initialize with an error
 */
import { appendFileSync } from 'node:fs';

const flag = name => process.argv.includes(name);
const value = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const journal = value('--journal');
const rss = Number(value('--rss') ?? 50 * 1024 * 1024);

let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
    buffer = buffer.subarray(start + length);
    handle(message);
  }
});
process.stdin.on('end', () => process.exit(1));

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(message) {
  if (journal) appendFileSync(journal, `${JSON.stringify({ pid: process.pid, method: message.method, params: message.params })}\n`);
  const { id, method, params } = message;
  if (method === 'exit') process.exit(0);
  if (id === undefined) return;
  if (method === 'initialize' && flag('--fail-initialize')) {
    send({ id, error: { code: -32602, message: 'storageRoot is not a folder' } });
    return;
  }
  if (method === 'engine.status' && flag('--hang-status')) return;
  const results = {
    initialize: { name: 'fake-engine', version: '0.0.0', languages: ['typescript'] },
    'workspace.open': { state: 'indexing', root: params?.root },
    'engine.status': { residentBytes: rss, memoryBudgetMb: params?.memoryBudgetMb ?? 300, workspaces: 0 },
    shutdown: null,
  };
  if (Object.hasOwn(results, method)) send({ id, result: results[method] });
  else send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  if (method === 'workspace.open' && flag('--exit-after-open')) setTimeout(() => process.exit(3), 20);
}
