/**
 * FEATURE_132 — minimal stdio LSP server fixture for integration tests.
 *
 * Hand-rolled Content-Length framing (depends on nothing) so it validates
 * the REAL wire protocol our client speaks: it answers `initialize` /
 * `shutdown`, exits on `exit`, and publishes one ERROR diagnostic whenever a
 * document is opened or changed. Spawned via `node <this>` from the tests.
 */

let buffer = Buffer.alloc(0);
const exitDuringNextRequest = process.argv.includes('--exit-during-next-request');
let exitOnNextData = false;

process.stdin.on('data', (chunk) => {
  if (exitOnNextData) process.exit(0);
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = buffer.slice(0, headerEnd).toString('ascii');
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const start = headerEnd + 4;
    if (buffer.length < start + length) break;
    const body = buffer.slice(start, start + length).toString('utf8');
    buffer = buffer.slice(start + length);
    try {
      handle(JSON.parse(body));
    } catch {
      // ignore malformed frames
    }
  }
});

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function publish(uri) {
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri,
      diagnostics: [
        {
          severity: 1,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          message: 'fake type error',
        },
      ],
    },
  });
}

function handle(message) {
  switch (message.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { textDocumentSync: 1 } } });
      return;
    case 'shutdown':
      send({ jsonrpc: '2.0', id: message.id, result: null });
      return;
    case 'exit':
      process.exit(0);
      return;
    case 'textDocument/didOpen':
    case 'textDocument/didChange':
      publish(message.params.textDocument.uri);
      return;
    case 'textDocument/definition':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: [
          {
            uri: message.params.textDocument.uri,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          },
        ],
      });
      return;
    case 'textDocument/hover':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { contents: { kind: 'plaintext', value: 'const x: number' } },
      });
      return;
    case 'textDocument/references':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: [
          {
            uri: message.params.textDocument.uri,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          },
          {
            uri: message.params.textDocument.uri,
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
          },
        ],
      });
      return;
    case 'textDocument/documentSymbol':
      if (exitDuringNextRequest) exitOnNextData = true;
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: [
          {
            name: 'x',
            kind: 13,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
            selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
          },
        ],
      });
      return;
    default:
      // Answer any other server-bound request with null so nothing stalls.
      if (typeof message.id !== 'undefined' && message.method) {
        send({ jsonrpc: '2.0', id: message.id, result: null });
      }
  }
}
