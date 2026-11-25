import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpServersConfig as KodaXMcpServersConfig } from './config.js';
import { createMcpCapabilityId } from './catalog.js';

const TEST_SERVER_ID = 'demo';
const TEST_TOOL_NAME = 'echo_tool';
const TEST_RESOURCE_URI = 'memory://guide';
const TEST_PROMPT_NAME = 'draft_prompt';

const MCP_TEST_SERVER_SOURCE = String.raw`const TOOL_NAME = 'echo_tool';
const RESOURCE_URI = 'memory://guide';
const PROMPT_NAME = 'draft_prompt';
const READ_ONLY = process.argv.includes('--read-only');
let buffer = '';

function writeMessage(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function handleRequest(message) {
  const id = message.id;
  const method = message.method;
  const params = message.params || {};
  if (method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        serverInfo: {
          name: 'kodax-mcp-test-server',
          version: '1.0.0',
        },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [{
          name: TOOL_NAME,
          title: 'Echo Tool',
          description: 'Echo text back from the MCP test server.',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              mode: { type: 'string' },
            },
            required: ['text'],
          },
          annotations: READ_ONLY ? { readOnlyHint: true } : {
            destructive: false,
          },
        }],
      },
    });
    return;
  }
  if (method === 'resources/list') {
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: {
        resources: [{
          uri: RESOURCE_URI,
          title: 'Guide Resource',
          description: 'Provides guide text.',
          mimeType: 'text/plain',
        }],
      },
    });
    return;
  }
  if (method === 'prompts/list') {
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: {
        prompts: [{
          name: PROMPT_NAME,
          title: 'Draft Prompt',
          description: 'A simple prompt from the MCP test server.',
        }],
      },
    });
    return;
  }
  if (method === 'tools/call') {
    const args = params.arguments || params.args || {};
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{
          type: 'text',
          text: 'echo:' + String(args.text || ''),
        }],
        structuredContent: {
          echo: args.text || '',
          mode: args.mode || null,
        },
      },
    });
    return;
  }
  if (method === 'resources/read') {
    const uri = params.uri || params.name || RESOURCE_URI;
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: {
        contents: [{
          uri,
          mimeType: 'text/plain',
          text: 'resource:' + String(uri),
        }],
      },
    });
    return;
  }
  if (method === 'prompts/get') {
    const args = params.arguments || params.args || {};
    const topic = args.topic || 'none';
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: {
        description: 'Prompt result for ' + String(params.name || PROMPT_NAME),
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: 'prompt:' + String(params.name || PROMPT_NAME) + ':' + String(topic),
          },
        }],
      },
    });
    return;
  }

  writeMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: 'Method not found: ' + String(method),
    },
  });
}

function handleFrame(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    process.stderr.write('bad json: ' + String(error) + '\n');
    return;
  }
  if (message.id !== undefined) {
    handleRequest(message);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\n');
    if (lineEnd < 0) {
      return;
    }
    const line = buffer.slice(0, lineEnd).replace(/\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (line) {
      handleFrame(line);
    }
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;

export interface McpTestServerFixture {
  cacheDir: string;
  servers: KodaXMcpServersConfig;
  promptId: string;
  resourceId: string;
  scriptPath: string;
  serverId: string;
  toolId: string;
}

export async function createMcpTestServerFixture(
  tempDir: string,
): Promise<McpTestServerFixture> {
  const scriptPath = path.join(tempDir, 'mcp-test-server.cjs');
  const cacheDir = path.join(tempDir, 'mcp-cache');
  await fs.writeFile(scriptPath, MCP_TEST_SERVER_SOURCE, 'utf8');

  return {
    cacheDir,
    scriptPath,
    serverId: TEST_SERVER_ID,
    toolId: createMcpCapabilityId(TEST_SERVER_ID, 'tool', TEST_TOOL_NAME),
    resourceId: createMcpCapabilityId(TEST_SERVER_ID, 'resource', TEST_RESOURCE_URI),
    promptId: createMcpCapabilityId(TEST_SERVER_ID, 'prompt', TEST_PROMPT_NAME),
    servers: {
      [TEST_SERVER_ID]: {
        type: 'stdio',
        command: process.execPath,
        args: [scriptPath],
        connect: 'prewarm',
        startupTimeoutMs: 5_000,
        requestTimeoutMs: 5_000,
      },
    },
  };
}
