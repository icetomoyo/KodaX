import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let configHome = "";
let previousKodaXHome: string | undefined;
let configureIntegrationCommands: typeof import("./integration-cli.js").configureIntegrationCommands;

beforeAll(async () => {
  previousKodaXHome = process.env.KODAX_HOME;
  configHome = path.join(
    mkdtempSync(path.join(os.tmpdir(), "kodax-integration-cli-")),
    "custom-config-home",
  );
  process.env.KODAX_HOME = configHome;
  vi.resetModules();
  ({ configureIntegrationCommands } = await import("./integration-cli.js"));
});

afterAll(() => {
  if (previousKodaXHome === undefined) delete process.env.KODAX_HOME;
  else process.env.KODAX_HOME = previousKodaXHome;
  rmSync(path.dirname(configHome), { recursive: true, force: true });
});

async function runCommand(args: readonly string[]): Promise<string> {
  const program = new Command().exitOverride();
  program.name("kodax");
  configureIntegrationCommands(program, { version: "0.7.69" });
  let output = "";
  const writer = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      output +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
  try {
    await program.parseAsync(["node", "kodax", ...args]);
    return output;
  } finally {
    writer.mockRestore();
  }
}

function legacyTaskRecord(
  taskId: string,
  subject: string,
): Readonly<Record<string, unknown>> {
  const timestamp = "2026-07-16T00:00:00.000Z";
  const contextId = `context-${taskId}`;
  const message = {
    messageId: `message-${taskId}`,
    taskId,
    contextId,
    role: "ROLE_USER",
    parts: [{ text: taskId }],
  };
  return {
    taskId,
    contextId,
    principalKey: createHash("sha256").update(`${subject}\0`).digest("hex"),
    runtimeIdentity: "legacy-runtime",
    sessionId: `session-${taskId}`,
    messageDigests: { [message.messageId]: `digest-${taskId}` },
    runIds: [],
    task: {
      id: taskId,
      contextId,
      status: { state: "TASK_STATE_COMPLETED", timestamp },
      history: [message],
    },
    history: [message],
    createdAt: timestamp,
    updatedAt: timestamp,
    eventSeq: 1,
    runtimeEventCount: 0,
    runtimeEventBytes: 0,
  };
}

describe("integration CLI", () => {
  it("prints a canonical template without creating active or example files", async () => {
    const output = await runCommand(["config", "template", "a2a"]);

    expect(output).toContain('"agents": {');
    expect(output.match(/^\s*"agents": \{/gmu)).toHaveLength(1);
    expect(output).toContain('isolated Skill Script is POSIX-only');
    expect(output).toContain('required per-command denyRead is unsupported');
    expect(existsSync(configHome)).toBe(false);
  });

  it("adds, lists, and removes an MCP server through the split domain file", async () => {
    await runCommand([
      "mcp",
      "add",
      "local",
      "--command",
      "node",
      "--arg",
      "server.mjs",
    ]);
    const listed = JSON.parse(await runCommand(["mcp", "list"])) as Record<
      string,
      unknown
    >;
    expect(listed).toMatchObject({
      local: {
        type: "stdio",
        command: "node",
        args: ["server.mjs"],
        connect: "lazy",
      },
    });

    await runCommand(["mcp", "remove", "local"]);
    expect(JSON.parse(await runCommand(["mcp", "list"]))).toEqual({});
  });

  it("creates an inert authenticated A2A server declaration without persisting a token", async () => {
    await runCommand([
      "a2a",
      "expose",
      "--name",
      "Demo Agent",
      "--description",
      "General document work",
      "--token-env",
      "DEMO_A2A_TOKEN",
    ]);

    const raw = readFileSync(
      path.join(configHome, "integrations", "a2a.json"),
      "utf8",
    );
    expect(raw).toContain('"tokenEnv": "DEMO_A2A_TOKEN"');
    expect(raw).not.toContain("secret-token");
    expect(JSON.parse(raw)).toMatchObject({
      server: {
        execution: { kind: "runtime-default", workspace: { mode: "managed" } },
        published: { name: "Demo Agent" },
      },
    });
  });

  it("configures an external OAuth2 issuer for JWT access-token validation", async () => {
    await runCommand([
      "a2a",
      "expose",
      "--auth",
      "oauth2-jwt",
      "--oauth-scheme",
      "enterprise-oauth",
      "--oauth-issuer",
      "https://identity.example.com/",
      "--oauth-audience",
      "https://agent.example.com/",
      "--oauth-jwks-url",
      "https://identity.example.com/jwks",
      "--oauth-token-url",
      "https://identity.example.com/token",
      "--oauth-metadata-url",
      "https://identity.example.com/.well-known/oauth-authorization-server",
      "--required-scope",
      "a2a.invoke",
    ]);
    const document = JSON.parse(
      readFileSync(path.join(configHome, "integrations", "a2a.json"), "utf8"),
    ) as { readonly server: { readonly authentication: unknown } };
    expect(document.server.authentication).toEqual({
      type: "oauth2-jwt",
      scheme: "enterprise-oauth",
      issuer: "https://identity.example.com/",
      audience: "https://agent.example.com/",
      jwksUrl: "https://identity.example.com/jwks",
      tokenUrl: "https://identity.example.com/token",
      metadataUrl:
        "https://identity.example.com/.well-known/oauth-authorization-server",
      requiredScopes: ["a2a.invoke"],
    });
  });

  it("manages outbound Agent activation without deleting its configuration", async () => {
    await runCommand([
      "a2a",
      "add",
      "managed",
      "https://agents.example.com/card",
      "--disabled",
      "--no-test",
    ]);
    let listed = JSON.parse(await runCommand(["a2a", "list"])) as {
      readonly agents: Readonly<Record<string, { readonly enabled: boolean }>>;
    };
    expect(listed.agents.managed?.enabled).toBe(false);

    await runCommand(["a2a", "enable", "managed"]);
    listed = JSON.parse(await runCommand(["a2a", "list"])) as typeof listed;
    expect(listed.agents.managed?.enabled).toBe(true);

    await runCommand(["a2a", "disable", "managed"]);
    listed = JSON.parse(await runCommand(["a2a", "list"])) as typeof listed;
    expect(listed.agents.managed?.enabled).toBe(false);
  });

  it("persists explicit private-network and plaintext HTTP authorization when adding an Agent", async () => {
    await runCommand([
      "a2a",
      "add",
      "private-http",
      "http://10.0.0.1/.well-known/agent-card.json",
      "--allow-private",
      "--allow-insecure-http",
      "--no-test",
    ]);
    const listed = JSON.parse(await runCommand(["a2a", "list"])) as {
      readonly agents: Readonly<Record<string, { readonly network?: unknown }>>;
    };
    expect(listed.agents["private-http"]?.network).toEqual({
      allowPrivateAddresses: true,
      allowInsecureHttp: true,
    });
  });

  it("requires an explicit stopped-daemon confirmation to migrate a non-empty v1 file", async () => {
    const file = path.join(configHome, "integrations", "a2a.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const legacy = `${JSON.stringify(
      {
        version: 1,
        agents: {
          legacy: {
            cardUrl: "https://agents.example.com/.well-known/agent-card.json",
            credentialEnv: "LEGACY_A2A_TOKEN",
            effect: "read",
          },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(file, legacy, "utf8");
    try {
      await expect(runCommand(["a2a", "disable", "legacy"])).rejects.toThrow(
        /explicit migration|a2a migrate/i,
      );
      expect(readFileSync(file, "utf8")).toBe(legacy);
      await expect(runCommand(["a2a", "migrate"])).rejects.toThrow(
        /confirm-daemons-stopped/i,
      );
      expect(readFileSync(file, "utf8")).toBe(legacy);

      const output = JSON.parse(
        await runCommand(["a2a", "migrate", "--confirm-daemons-stopped"]),
      ) as { readonly migrated: boolean; readonly version: number };
      expect(output).toMatchObject({ migrated: true, version: 2 });
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
        version: 2,
        agents: { legacy: { enabled: true } },
      });
    } finally {
      if (previous === undefined) rmSync(file, { force: true });
      else writeFileSync(file, previous, "utf8");
    }
  });

  it("dry-runs and explicitly applies configured bearer task-owner migration offline", async () => {
    const configFile = path.join(configHome, "integrations", "a2a.json");
    const previous = existsSync(configFile)
      ? readFileSync(configFile, "utf8")
      : undefined;
    const dataDir = path.join(configHome, "legacy-a2a-tasks");
    const taskFile = path.join(dataDir, "tasks.json");
    mkdirSync(dataDir, { recursive: true });
    const original = `${JSON.stringify([legacyTaskRecord("legacy-cli-task", "configured-client")], null, 2)}\n`;
    writeFileSync(taskFile, original, "utf8");
    try {
      await runCommand([
        "a2a",
        "expose",
        "--token-env",
        "KODAX_A2A_TOKEN",
        "--principal",
        "configured-client",
        "--data-dir",
        dataDir,
      ]);
      const plan = JSON.parse(await runCommand(["a2a", "migrate-tasks"])) as {
        readonly applied: boolean;
        readonly matchedLegacyTaskCount: number;
      };
      expect(plan).toMatchObject({ applied: false, matchedLegacyTaskCount: 1 });
      expect(readFileSync(taskFile, "utf8")).toBe(original);
      await expect(
        runCommand(["a2a", "migrate-tasks", "--apply"]),
      ).rejects.toThrow(/confirm-server-stopped/i);

      const applied = JSON.parse(
        await runCommand([
          "a2a",
          "migrate-tasks",
          "--apply",
          "--confirm-server-stopped",
        ]),
      ) as typeof plan;
      expect(applied).toMatchObject({
        applied: true,
        matchedLegacyTaskCount: 1,
      });
      expect(JSON.parse(readFileSync(taskFile, "utf8"))).toEqual([
        expect.objectContaining({
          taskId: "legacy-cli-task",
          principalKeyScheme: "realm-subject-tenant-v1",
        }),
      ]);
    } finally {
      if (previous === undefined) rmSync(configFile, { force: true });
      else writeFileSync(configFile, previous, "utf8");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("requires the exact historical OAuth subject for task-owner migration", async () => {
    const configFile = path.join(configHome, "integrations", "a2a.json");
    const previous = existsSync(configFile)
      ? readFileSync(configFile, "utf8")
      : undefined;
    const dataDir = path.join(configHome, "legacy-oauth-a2a-tasks");
    const taskFile = path.join(dataDir, "tasks.json");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      taskFile,
      `${JSON.stringify(
        [legacyTaskRecord("legacy-oauth-task", "oauth-client")],
        null,
        2,
      )}\n`,
      "utf8",
    );
    try {
      await runCommand([
        "a2a",
        "expose",
        "--auth",
        "oauth2-jwt",
        "--oauth-scheme",
        "enterprise-oauth",
        "--oauth-issuer",
        "https://identity.example.com/",
        "--oauth-audience",
        "https://agent.example.com/",
        "--oauth-jwks-url",
        "https://identity.example.com/jwks",
        "--oauth-token-url",
        "https://identity.example.com/token",
        "--required-scope",
        "a2a.invoke",
        "--data-dir",
        dataDir,
      ]);
      await expect(runCommand(["a2a", "migrate-tasks"])).rejects.toThrow(
        /requires --subject/i,
      );
      const plan = JSON.parse(
        await runCommand(["a2a", "migrate-tasks", "--subject", "oauth-client"]),
      ) as {
        readonly applied: boolean;
        readonly matchedLegacyTaskCount: number;
      };
      expect(plan).toMatchObject({ applied: false, matchedLegacyTaskCount: 1 });
    } finally {
      if (previous === undefined) rmSync(configFile, { force: true });
      else writeFileSync(configFile, previous, "utf8");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fails closed for legacy or mismatched daemon ownership beside a non-.kodax config home", async () => {
    const [runtimeModule, hostModule, stateModule, transportModule] =
      await Promise.all([
        import("./sdk-runtime.js"),
        import("./runtime-daemon/host.js"),
        import("./runtime-daemon/state.js"),
        import("./runtime-daemon/transport.js"),
      ]);
    const profile = `a2a-owner-guard-${process.pid}-${Date.now()}`;
    const paths = stateModule.resolveRuntimeDaemonPathsFromConfigHome(
      configHome,
      profile,
    );
    const runtime = await runtimeModule.createKodaXRuntime({
      mode: "embedded",
      profile,
      homeDir: path.dirname(configHome),
      defaultProvider: "mock-provider",
      externalAgents: {
        factories: [],
        policy: () => ({ allowed: true }),
      },
    });
    const lock = stateModule.tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId,
      pid: process.pid,
      createdAt: runtime.identity.startedAt,
      kind: "daemon",
    });
    if (!lock) throw new Error("Expected daemon owner guard test lock.");
    const host = await hostModule.startRuntimeDaemonHost({
      runtime,
      paths,
      endpoint: transportModule.defaultRuntimeDaemonEndpoint(
        profile,
        path.dirname(configHome),
      ),
      lock,
    });
    const file = path.join(configHome, "integrations", "a2a.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const document = `${JSON.stringify(
      {
        version: 2,
        agents: {
          guarded: {
            cardUrl: "https://agents.example.com/.well-known/agent-card.json",
            enabled: true,
            effect: "read",
          },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(file, document, "utf8");
    try {
      await expect(runCommand(["a2a", "disable", "guarded"])).rejects.toThrow(
        /a2aConfigReconciler|safely apply A2A config/i,
      );
      expect(readFileSync(file, "utf8")).toBe(document);

      const idempotentMigration = JSON.parse(
        await runCommand(["a2a", "migrate"]),
      ) as {
        readonly migrated: boolean;
        readonly version: number;
      };
      expect(idempotentMigration).toMatchObject({
        migrated: false,
        version: 2,
      });
      expect(readFileSync(file, "utf8")).toBe(document);

      const currentState = JSON.parse(
        readFileSync(paths.stateFile, "utf8"),
      ) as Record<string, unknown>;
      const legacyState = { ...currentState };
      delete legacyState.configHome;
      writeFileSync(
        paths.stateFile,
        `${JSON.stringify(legacyState, null, 2)}\n`,
        "utf8",
      );
      await expect(runCommand(["a2a", "disable", "guarded"])).rejects.toThrow(
        /does not declare.*config home|restart.*current KodaX/i,
      );
      expect(readFileSync(file, "utf8")).toBe(document);

      writeFileSync(
        paths.stateFile,
        `${JSON.stringify(
          {
            ...currentState,
            configHome: path.join(configHome, "different-owner"),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await expect(runCommand(["a2a", "remove", "guarded"])).rejects.toThrow(
        /different.*config home|ambiguous ownership/i,
      );
      expect(readFileSync(file, "utf8")).toBe(document);
    } finally {
      await host.close();
      if (previous === undefined) rmSync(file, { force: true });
      else writeFileSync(file, previous, "utf8");
    }
  });

  it("validates a named user Markdown Agent before publishing its reference", async () => {
    await expect(
      runCommand(["a2a", "expose", "missing-agent"]),
    ).rejects.toThrow(/not found/i);
    const agents = path.join(configHome, "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      path.join(agents, "office-agent.md"),
      [
        "---",
        "name: office-agent",
        "description: Office work",
        "---",
        "Complete general office tasks.",
      ].join("\n"),
      "utf8",
    );

    await runCommand(["a2a", "expose", "office-agent"]);
    const document = JSON.parse(
      readFileSync(path.join(configHome, "integrations", "a2a.json"), "utf8"),
    ) as { readonly server: { readonly execution: unknown } };
    expect(document.server.execution).toMatchObject({
      kind: "local-agent",
      agentRef: { source: "markdown:user", name: "office-agent" },
    });
  });

  it("rejects non-loopback use of the built-in A2A listener", async () => {
    await expect(
      runCommand(["a2a", "serve", "--host", "0.0.0.0"]),
    ).rejects.toThrow(/loopback-only/i);
  });

  it("requires explicit apply before legacy cleanup", async () => {
    await expect(
      runCommand(["integrations", "migrate", "--cleanup-legacy"]),
    ).rejects.toThrow(/requires --apply/i);
  });

  it("reports split paths and validates every current domain snapshot", async () => {
    const paths = JSON.parse(await runCommand(["config", "paths"])) as {
      readonly home: string;
      readonly core: string;
      readonly integrations: Record<string, string>;
      readonly integrationExamples: Record<string, string>;
    };
    expect(paths.home).toBe(configHome);
    expect(paths.core).toBe(path.join(configHome, "config.json"));
    expect(Object.keys(paths.integrations).sort()).toEqual([
      "a2a",
      "extensions",
      "mcp",
    ]);
    expect(Object.keys(paths.integrationExamples).sort()).toEqual([
      "a2a",
      "extensions",
      "mcp",
    ]);

    const status = JSON.parse(
      await runCommand(["integrations", "status"]),
    ) as Array<{
      readonly domain: string;
    }>;
    expect(status.map((entry) => entry.domain)).toEqual([
      "mcp",
      "a2a",
      "extensions",
    ]);
    await expect(runCommand(["integrations", "validate"])).resolves.toContain(
      '"ok": true',
    );
    await expect(runCommand(["integrations", "reload"])).resolves.toContain(
      '"ok": true',
    );
    await expect(runCommand(["config", "template", "unknown"])).rejects.toThrow(
      /unknown/i,
    );
  });

  it("reports invalid integration domains independently without exposing file contents", async () => {
    const integrationDir = path.join(configHome, "integrations");
    mkdirSync(integrationDir, { recursive: true });
    const file = path.join(integrationDir, "mcp.json");
    const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    writeFileSync(file, "{ broken SECRET_VALUE", "utf8");
    try {
      const status = JSON.parse(
        await runCommand(["integrations", "status"]),
      ) as Array<{
        readonly domain: string;
        readonly state: "valid" | "invalid";
        readonly diagnostic?: string;
      }>;
      expect(status).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            domain: "mcp",
            state: "invalid",
            diagnostic: expect.stringMatching(/schema/i),
          }),
          expect.objectContaining({ domain: "a2a", state: "valid" }),
          expect.objectContaining({ domain: "extensions", state: "valid" }),
        ]),
      );
      expect(JSON.stringify(status)).not.toContain("SECRET_VALUE");

      const validation = JSON.parse(
        await runCommand(["integrations", "validate"]),
      ) as {
        readonly ok: boolean;
      };
      expect(validation.ok).toBe(false);
    } finally {
      if (previous === undefined) rmSync(file, { force: true });
      else writeFileSync(file, previous, "utf8");
    }
  });

  it("points an invalid legacy MCP diagnostic at config.json", async () => {
    const splitFile = path.join(configHome, "integrations", "mcp.json");
    const coreFile = path.join(configHome, "config.json");
    const previousSplit = existsSync(splitFile)
      ? readFileSync(splitFile, "utf8")
      : undefined;
    const previousCore = existsSync(coreFile)
      ? readFileSync(coreFile, "utf8")
      : undefined;
    rmSync(splitFile, { force: true });
    writeFileSync(
      coreFile,
      JSON.stringify({ mcpServers: { legacy: { command: 42 } } }),
      "utf8",
    );
    try {
      const status = JSON.parse(
        await runCommand(["integrations", "status"]),
      ) as Array<{
        readonly domain: string;
        readonly path: string;
        readonly state: "valid" | "invalid";
        readonly source?: string;
      }>;
      expect(status).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            domain: "mcp",
            path: coreFile,
            state: "invalid",
            source: "legacy-user",
          }),
        ]),
      );
    } finally {
      if (previousSplit === undefined) rmSync(splitFile, { force: true });
      else writeFileSync(splitFile, previousSplit, "utf8");
      if (previousCore === undefined) rmSync(coreFile, { force: true });
      else writeFileSync(coreFile, previousCore, "utf8");
    }
  });

  it("validates MCP command shape and supports an HTTP transport declaration", async () => {
    await expect(runCommand(["mcp", "add", "invalid"])).rejects.toThrow(
      /exactly one/i,
    );
    await expect(
      runCommand([
        "mcp",
        "add",
        "invalid",
        "--command",
        "node",
        "--url",
        "https://mcp.example.com",
      ]),
    ).rejects.toThrow(/exactly one/i);

    await runCommand([
      "mcp",
      "add",
      "remote",
      "--url",
      "https://mcp.example.com/api",
      "--transport",
      "streamable-http",
      "--connect",
      "prewarm",
    ]);
    expect(JSON.parse(await runCommand(["mcp", "list"]))).toMatchObject({
      remote: {
        type: "streamable-http",
        url: "https://mcp.example.com/api",
        connect: "prewarm",
      },
    });
    await runCommand(["mcp", "remove", "remote"]);
  });

  it("validates, stores, reloads, and removes an Extension entrypoint", async () => {
    const extensionDir = path.join(path.dirname(configHome), "demo-extension");
    mkdirSync(extensionDir, { recursive: true });
    const entrypoint = path.join(extensionDir, "extension.mjs");
    writeFileSync(
      entrypoint,
      "export default function activate() {}\n",
      "utf8",
    );

    await runCommand(["extensions", "add", extensionDir]);
    expect(JSON.parse(await runCommand(["extensions", "list"]))).toEqual([
      entrypoint,
    ]);
    await expect(runCommand(["extensions", "reload"])).resolves.toContain(
      '"validated": 1',
    );
    await expect(
      runCommand(["extensions", "remove", extensionDir]),
    ).resolves.toContain('"removed": true');
    expect(JSON.parse(await runCommand(["extensions", "list"]))).toEqual([]);
  });

  it("calls a configured loopback A2A Agent without application code", async () => {
    let baseUrl = "";
    let getTaskCalls = 0;
    const methods: string[] = [];
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/card") {
        response.end(
          JSON.stringify({
            name: "Loopback Agent",
            description: "Local deterministic Agent",
            version: "1.0.0",
            supportedInterfaces: [
              {
                url: `${baseUrl}/rpc`,
                protocolBinding: "JSONRPC",
                protocolVersion: "1.0",
              },
            ],
            capabilities: { streaming: false },
            defaultInputModes: ["text/plain"],
            defaultOutputModes: ["text/plain"],
            skills: [
              {
                id: "general",
                name: "General",
                description: "General tasks",
                tags: [],
              },
            ],
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly id: string;
        readonly method: string;
      };
      methods.push(payload.method);
      if (payload.method === "SendMessage") {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              task: {
                id: "task-1",
                contextId: "context-1",
                status: { state: "TASK_STATE_SUBMITTED" },
              },
            },
          }),
        );
        return;
      }
      getTaskCalls += 1;
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            id: "task-1",
            contextId: "context-1",
            status:
              getTaskCalls === 1
                ? { state: "TASK_STATE_WORKING" }
                : {
                    state: "TASK_STATE_COMPLETED",
                    message: {
                      messageId: "result-1",
                      role: "ROLE_AGENT",
                      parts: [{ text: "completed", mediaType: "text/plain" }],
                    },
                  },
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await runCommand([
        "a2a",
        "add",
        "loopback",
        `${baseUrl}/card`,
        "--no-test",
      ]);
      await expect(runCommand(["a2a", "test", "loopback"])).resolves.toContain(
        "Loopback Agent",
      );
      await expect(
        runCommand(["a2a", "call", "loopback", "Prepare report"]),
      ).resolves.toContain("completed");
      expect(methods).toEqual(
        expect.arrayContaining(["SendMessage", "GetTask"]),
      );
      await expect(
        runCommand(["a2a", "remove", "loopback"]),
      ).resolves.toContain('"removed": true');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    {
      label: "raw, data, and HTTP(S) artifact references",
      rawBytes: 32,
      includeReferences: true,
    },
    {
      label: "a task response above the 2 MiB metadata limit",
      rawBytes: 1_600_000,
      includeReferences: false,
    },
  ])(
    "allows $label through `a2a call` without fetching remote artifacts",
    async ({ label, rawBytes, includeReferences }) => {
      let baseUrl = "";
      const name = includeReferences
        ? "artifact-policy-loopback"
        : "large-artifact-loopback";
      const raw = Buffer.alloc(rawBytes, 0x5a).toString("base64");
      const data = { kind: "table", rows: 1 };
      const requestedPaths: string[] = [];
      const server = createServer(async (request, response) => {
        requestedPaths.push(request.url ?? "");
        response.setHeader("content-type", "application/json");
        if (request.url === "/card") {
          response.end(
            JSON.stringify({
              name: "Artifact Loopback Agent",
              description:
                "Returns artifact references without materializing remote URLs.",
              version: "1.0.0",
              supportedInterfaces: [
                {
                  url: `${baseUrl}/rpc`,
                  protocolBinding: "JSONRPC",
                  protocolVersion: "1.0",
                },
              ],
              capabilities: { streaming: false },
              defaultInputModes: ["text/plain"],
              defaultOutputModes: [
                "application/octet-stream",
                "application/json",
              ],
              skills: [],
            }),
          );
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          readonly id: string;
          readonly method: string;
        };
        if (payload.method === "SendMessage") {
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              result: {
                task: {
                  id: `task-${name}`,
                  contextId: `context-${name}`,
                  status: { state: "TASK_STATE_SUBMITTED" },
                },
              },
            }),
          );
          return;
        }
        const artifacts = [
          {
            artifactId: "raw-artifact",
            name: "report.bin",
            parts: [
              {
                raw,
                mediaType: "application/octet-stream",
                filename: "report.bin",
              },
            ],
          },
          ...(includeReferences
            ? [
                {
                  artifactId: "data-artifact",
                  name: "summary.json",
                  parts: [
                    {
                      data,
                      mediaType: "application/json",
                      filename: "summary.json",
                    },
                  ],
                },
                {
                  artifactId: "http-artifact",
                  name: "remote-http.pdf",
                  parts: [
                    {
                      url: `${baseUrl}/artifact-must-not-be-fetched`,
                      mediaType: "application/pdf",
                    },
                  ],
                },
                {
                  artifactId: "https-artifact",
                  name: "remote-https.pdf",
                  parts: [
                    {
                      url: "https://artifacts.example.com/report.pdf",
                      mediaType: "application/pdf",
                    },
                  ],
                },
              ]
            : []),
        ];
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              id: `task-${name}`,
              contextId: `context-${name}`,
              status: { state: "TASK_STATE_COMPLETED" },
              artifacts,
            },
          }),
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        await runCommand(["a2a", "add", name, `${baseUrl}/card`, "--no-test"]);
        const result = await runCommand(["a2a", "call", name, label]);
        expect(result).toContain('"state": "completed"');
        expect(result).toContain(
          `data:application/octet-stream;base64,${raw.slice(0, 16)}`,
        );
        if (includeReferences) {
          const encodedData = Buffer.from(
            JSON.stringify(data),
            "utf8",
          ).toString("base64");
          expect(result).toContain(
            `data:application/json;base64,${encodedData}`,
          );
          expect(result).toContain(`${baseUrl}/artifact-must-not-be-fetched`);
          expect(result).toContain("https://artifacts.example.com/report.pdf");
          expect(requestedPaths).not.toContain("/artifact-must-not-be-fetched");
        } else {
          expect(Buffer.byteLength(result)).toBeGreaterThan(2_097_152);
          expect(Buffer.byteLength(result)).toBeLessThan(32 * 1024 * 1024);
        }
      } finally {
        await runCommand(["a2a", "remove", name]);
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
    },
  );

  it("obtains an external OAuth2 client-credentials token for a no-code A2A call", async () => {
    let baseUrl = "";
    let tokenRequests = 0;
    let rpcAuthorization = "";
    const previousSecret = process.env.CLI_A2A_CLIENT_SECRET;
    process.env.CLI_A2A_CLIENT_SECRET = "local-client-secret";
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/card") {
        response.end(
          JSON.stringify({
            name: "OAuth Loopback Agent",
            description: "Local OAuth Agent",
            version: "1.0.0",
            supportedInterfaces: [
              {
                url: `${baseUrl}/rpc`,
                protocolBinding: "JSONRPC",
                protocolVersion: "1.0",
              },
            ],
            capabilities: { streaming: false },
            securitySchemes: {
              enterprise: {
                oauth2SecurityScheme: {
                  flows: {
                    clientCredentials: {
                      tokenUrl: `${baseUrl}/token`,
                      scopes: { "a2a.invoke": "Invoke the Agent" },
                    },
                  },
                },
              },
            },
            securityRequirements: [
              { schemes: { enterprise: { list: ["a2a.invoke"] } } },
            ],
            defaultInputModes: ["text/plain"],
            defaultOutputModes: ["text/plain"],
            skills: [
              {
                id: "general",
                name: "General",
                description: "General tasks",
                tags: [],
              },
            ],
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.url === "/token") {
        tokenRequests += 1;
        expect(request.headers.authorization).toMatch(/^Basic /u);
        expect(Buffer.concat(chunks).toString("utf8")).toContain(
          "grant_type=client_credentials",
        );
        response.end(
          JSON.stringify({
            access_token: "issued-access-token",
            token_type: "Bearer",
            expires_in: 120,
          }),
        );
        return;
      }
      rpcAuthorization = request.headers.authorization ?? "";
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly id: string;
      };
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            message: {
              messageId: "oauth-result",
              role: "ROLE_AGENT",
              parts: [{ text: "oauth completed", mediaType: "text/plain" }],
            },
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await runCommand([
        "a2a",
        "add",
        "oauth-loopback",
        `${baseUrl}/card`,
        "--no-test",
        "--oauth-scheme",
        "enterprise",
        "--oauth-issuer",
        `${baseUrl}/`,
        "--oauth-token-url",
        `${baseUrl}/token`,
        "--oauth-client-id",
        "kodax-cli",
        "--oauth-client-secret-env",
        "CLI_A2A_CLIENT_SECRET",
        "--oauth-scope",
        "a2a.invoke",
      ]);
      await expect(
        runCommand(["a2a", "call", "oauth-loopback", "Prepare report"]),
      ).resolves.toContain("oauth completed");
      expect(tokenRequests).toBe(1);
      expect(rpcAuthorization).toBe("Bearer issued-access-token");
      expect(
        readFileSync(path.join(configHome, "integrations", "a2a.json"), "utf8"),
      ).not.toContain("local-client-secret");
      await runCommand(["a2a", "remove", "oauth-loopback"]);
    } finally {
      if (previousSecret === undefined)
        delete process.env.CLI_A2A_CLIENT_SECRET;
      else process.env.CLI_A2A_CLIENT_SECRET = previousSecret;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects invalid A2A policy arguments before changing server config", async () => {
    await expect(
      runCommand([
        "a2a",
        "add",
        "bad",
        "https://agents.example.com",
        "--effect",
        "delete",
      ]),
    ).rejects.toThrow(/effect/i);
    await expect(
      runCommand(["a2a", "expose", "--workspace-mode", "fixed"]),
    ).rejects.toThrow(/workspace-root/i);
    await expect(
      runCommand(["a2a", "expose", "--workspace-mode", "shared"]),
    ).rejects.toThrow(/workspace-mode/i);
    await expect(
      runCommand(["a2a", "expose", "--workspace-access", "execute"]),
    ).rejects.toThrow(/workspace-access/i);
    await expect(
      runCommand(["a2a", "expose", "--mcp", "missing-separator"]),
    ).rejects.toThrow(/name:value/i);
  });
});
